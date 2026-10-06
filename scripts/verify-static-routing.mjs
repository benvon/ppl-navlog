import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { unstable_dev } from 'wrangler';

// A counting wrapper exercises Wrangler's actual router while retaining the real API.
// The temporary wrapper supplies an admitting limiter for API routing probes.
// Production admission controls remain untouched; dedicated API tests cover denial.
// Fixtures and local requests never call aviation providers or deployed services.
const root = resolve('.');
const source = JSON.parse(await readFile(resolve('wrangler.jsonc'), 'utf8'));
const html = await readFile(resolve('dist/index.html'), 'utf8');
const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[A-Za-z0-9._/-]+)"/g)].map((match) => match[1]))];
assert(assets.some((path) => path.endsWith('.js')) && assets.some((path) => path.endsWith('.css')), 'Built HTML must reference JS and CSS.');
const security = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'; form-action 'none'; object-src 'none'",
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
};

function checkSecurity(response, path) {
  for (const [name, value] of Object.entries(security)) assert.equal(response.headers.get(name), value, `${path}: ${name}`);
  assert.equal(response.headers.get('X-Request-Id'), null, `${path}: static request ID`);
}

async function withRouter(assetsConfig, check) {
  const directory = await mkdtemp(join(tmpdir(), 'ppl-navlog-static-routing-'));
  let server;
  try {
    const workerPath = join(directory, 'probe.ts');
    await writeFile(workerPath, `import worker from ${JSON.stringify(join(root, 'worker/index.ts'))};
let invocations = 0;
export default { async fetch(request, env) {
  if (new URL(request.url).pathname === '/api/__routing_probe__/count') return Response.json({ invocations });
  invocations++;
  return worker.fetch(request, { ...env, API_RATE_LIMITER: { async limit() { return { success: true }; } } });
} };`);
    const config = join(directory, 'wrangler.json');
    await writeFile(config, JSON.stringify({ name: 'ppl-navlog-static-routing-probe', main: workerPath,
      compatibility_date: source.compatibility_date, assets: { ...assetsConfig, directory: join(root, 'dist') } }));
    server = await unstable_dev(workerPath, { config, local: true, port: 0, logLevel: 'error',
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false } });
    async function request(path, init = {}) {
      const response = await server.fetch(path, { ...init, signal: AbortSignal.timeout(10_000) });
      const body = await response.text();
      return { response, body };
    }
    const count = async () => JSON.parse((await request('/api/__routing_probe__/count')).body).invocations;
    await check(request, count);
  } finally {
    await server?.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

const coldPaths = ['/', ...assets, '/api/health'];
let baseline;
await withRouter({ ...source.assets, run_worker_first: true }, async (request, count) => {
  for (const path of coldPaths) assert.equal((await request(path)).response.status, 200);
  baseline = await count();
  assert.equal(baseline, coldPaths.length);
});

for (const [name, config] of [['base', source.assets], ['development', source.env.development.assets], ['production', source.env.production.assets]]) {
  assert.deepEqual(config.run_worker_first, ['/api/*'], `${name}: API-only Worker-first routes`);
  await withRouter(config, async (request, count) => {
    for (const path of coldPaths) assert.equal((await request(path)).response.status, 200);
    assert.equal(await count(), 1, `${name}: cold load invokes only API health`);
    for (const path of ['/', ...assets, '/version.json', '/robots.txt', '/__static_smoke__/deep-link', '/assets/missing-AbCdEf12.js', '/_headers']) {
      const { response, body } = await request(path);
      assert.equal(response.status, 200, path);
      checkSecurity(response, path);
      const expectedCache = assets.includes(path) ? 'public, max-age=31536000, immutable'
        : path === '/version.json' ? 'no-store' : 'public, max-age=0, must-revalidate';
      assert.equal(response.headers.get('Cache-Control'), expectedCache, path);
      if (path === '/__static_smoke__/deep-link' || path === '/assets/missing-AbCdEf12.js' || path === '/_headers') assert.equal(body, html, `${path}: SPA fallback`);
    }
    for (const [method, status] of [['HEAD', 200], ['POST', 405], ['OPTIONS', 405]]) {
      const { response } = await request('/', { method });
      assert.equal(response.status, status, method);
      checkSecurity(response, method);
      assert.equal(response.headers.get('Cache-Control'), status === 405 ? null : 'public, max-age=0, must-revalidate', method);
    }
    const first = await request('/');
    const etag = first.response.headers.get('ETag');
    assert(etag, 'Static root must return ETag.');
    const conditional = await request('/', { headers: { 'If-None-Match': etag } });
    assert.equal(conditional.response.status, 304);
    checkSecurity(conditional.response, '304');
    assert.equal(conditional.response.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate', '304');
    assert.equal(await count(), 1, `${name}: static probes must bypass Worker`);
    for (const path of ['/api/health', '/api/__routing_probe__/unknown']) {
      const { response } = await request(path, { headers: { 'Sec-Fetch-Mode': 'navigate' } });
      assert.equal(response.status, path.endsWith('/health') ? 200 : 404);
      assert(response.headers.get('X-Request-Id'), `${path}: API request ID`);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    assert.equal(await count(), 3, `${name}: API navigation reaches Worker`);
    console.log(`${name}: routing, static headers, cache policies, 304/405 and API navigation passed; cold load ${baseline} -> 1 Worker invocations (${baseline - 1} saved).`);
  });
}
