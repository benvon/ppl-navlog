const securityHeaders = new Map([
  ['Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'; form-action 'none'; object-src 'none'"],
  ['Permissions-Policy', 'geolocation=(), microphone=(), camera=()'],
  ['Referrer-Policy', 'no-referrer'],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
]);

const immutablePolicy = 'public, max-age=31536000, immutable';
const assetPathPattern = /^\/assets\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:js|css)$/;

export function assertStaticResponse(path, response, { revalidate = false, noStore = false, immutable = false, contentType, status = 200 } = {}) {
  if (response.status !== status) throw new Error(`static ${path} returned HTTP ${response.status}, expected ${status}`);
  for (const [name, value] of securityHeaders) {
    if (response.headers.get(name) !== value) throw new Error(`static security header ${name} missing or invalid`);
  }
  if (response.headers.get('X-Request-Id') !== null) throw new Error('static response unexpectedly includes X-Request-Id');

  const cacheControl = response.headers.get('Cache-Control') ?? '';
  if (immutable && cacheControl.trim().toLowerCase() !== immutablePolicy) throw new Error('static asset cache policy invalid');
  if (noStore && cacheControl.trim().toLowerCase() !== 'no-store') throw new Error('version manifest cache policy invalid');
  const revalidates = /(?:^|,)\s*(?:no-cache|no-store)\s*(?:,|$)/i.test(cacheControl)
    || /(?:^|,)\s*max-age=0\s*(?:,|$)/i.test(cacheControl) && /(?:^|,)\s*must-revalidate\s*(?:,|$)/i.test(cacheControl);
  if (revalidate && (/\bimmutable\b/i.test(cacheControl) || !revalidates)) {
    throw new Error('static response must revalidate');
  }
  if (contentType) {
    const value = response.headers.get('Content-Type') ?? '';
    const valid = contentType === 'javascript'
      ? /^(?:text|application)\/(?:javascript|ecmascript)(?:\s*;|$)/i.test(value)
      : /^text\/css(?:\s*;|$)/i.test(value);
    if (!valid) throw new Error('static asset content type invalid');
  }
}

function attribute(tag, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+))`, 'i');
  const match = tag.match(pattern);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function collectReferences(html) {
  const references = [];
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attribute(match[0], 'src');
    if (src !== undefined) references.push({ src, kind: 'javascript' });
  }
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attribute(match[0], 'rel') ?? '';
    if (rel.toLowerCase().split(/\s+/).includes('stylesheet')) {
      const href = attribute(match[0], 'href');
      if (href !== undefined) references.push({ src: href, kind: 'css' });
    }
  }
  return references;
}

export function discoverStaticAssets(html) {
  const assets = { javascript: [], css: [] };
  const seen = new Set();
  for (const { src, kind } of collectReferences(html)) {
    const expectedExtension = kind === 'javascript' ? /\.js$/ : /\.css$/;
    if (!assetPathPattern.test(src) || !expectedExtension.test(src)
      || src.split('/').some((segment) => segment === '.' || segment === '..')) throw new Error('unsafe static asset reference');
    if (!seen.has(src)) assets[kind].push(src);
    seen.add(src);
    if (seen.size > 32) throw new Error('too many built assets in static entrypoint');
  }
  if (assets.javascript.length === 0 || assets.css.length === 0) throw new Error('built JavaScript and CSS assets missing from static entrypoint');
  return assets;
}

export async function checkStaticSurface({ request, host, deadline, attempt }) {
  const index = await request(host, '/', async (response) => ({ response, body: await response.text() }), deadline, attempt);
  assertStaticResponse('/', index.response, { revalidate: true });
  if (!index.body.includes('<div id="app"></div>')) throw new Error('static app root missing');
  const etag = index.response.headers.get('ETag');
  if (!etag) throw new Error('static entrypoint ETag missing');

  const assets = discoverStaticAssets(index.body);
  for (const kind of ['javascript', 'css']) {
    const assetPaths = assets[kind];
    for (const path of assetPaths) {
      const asset = await request(host, path, async (response) => ({ response, body: await response.text() }), deadline, attempt);
      assertStaticResponse(path, asset.response, { immutable: true, contentType: kind });
      if (asset.body.length === 0) throw new Error(`static asset ${kind} body empty`);
    }
  }

  const manifest = await request(host, '/version.json', async (response) => ({ response, body: await response.json() }), deadline, attempt);
  assertStaticResponse('/version.json', manifest.response, { noStore: true });
  const robots = await request(host, '/robots.txt', async (response) => ({ response, body: await response.text() }), deadline, attempt);
  assertStaticResponse('/robots.txt', robots.response, { revalidate: true });

  const fallbackPath = '/__static_smoke__/deep-link';
  const fallback = await request(host, fallbackPath, async (response) => ({ response, body: await response.text() }), deadline, attempt);
  assertStaticResponse(fallbackPath, fallback.response, { revalidate: true });
  if (!fallback.body.includes('<div id="app"></div>')) throw new Error('static fallback app root missing');

  const head = await request(host, '/', async (response) => ({ response, body: await response.text() }), deadline, attempt, { method: 'HEAD' });
  assertStaticResponse('/', head.response, { revalidate: true });
  if (head.body !== '') throw new Error('static HEAD response unexpectedly included a body');
  const notModified = await request(host, '/', async (response) => ({ response, body: await response.text() }), deadline, attempt, { headers: { 'If-None-Match': etag }, status: 304 });
  assertStaticResponse('/', notModified.response, { revalidate: true, status: 304 });

  const rejectedPost = await request(host, '/', async (response) => ({ response, body: await response.text() }), deadline, attempt, { method: 'POST', status: 405 });
  assertStaticResponse('/', rejectedPost.response, { status: 405 });
  const missingAssetPath = '/assets/__static_smoke__-AbCdEf12.js';
  const missingAsset = await request(host, missingAssetPath, async (response) => ({ response, body: await response.text() }), deadline, attempt);
  assertStaticResponse(missingAssetPath, missingAsset.response, { revalidate: true });
  if (!missingAsset.body.includes('<div id="app"></div>')) throw new Error('missing static asset did not use the app fallback');

  return manifest.body;
}
