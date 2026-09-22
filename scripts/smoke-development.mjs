const base = 'https://navlog.benvon.dev';
const version = process.env.RELEASE_VERSION;
const sha = process.env.GITHUB_SHA;
if (!/^v\d+\.\d+\.\d+-rc\.\d+$/.test(version ?? '') || !/^[0-9a-f]{40}$/.test(sha ?? '')) {
  throw new Error('Smoke test requires an RC version and full commit SHA.');
}

async function get(path) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10000), headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response;
}

let lastError;
for (let attempt = 0; attempt < 6; attempt += 1) {
  try {
    const [index, manifest, health] = await Promise.all([get('/'), get('/version.json'), get('/api/health')]);
    const [html, build, api] = await Promise.all([index.text(), manifest.json(), health.json()]);
    if (!html.includes('<div id="app"></div>')) throw new Error('App root missing from static entrypoint.');
    if (!index.headers.get('Content-Security-Policy')?.includes("default-src 'self'")) throw new Error('Static CSP missing.');
    if (build.version !== version || build.commitSha !== sha || api.version !== version || api.commitSha !== sha) {
      throw new Error('Deployed static and API build identity do not match the release.');
    }
    if (api.status !== 'ok' || !api.requestId) throw new Error('API health payload invalid.');
    console.log(`Development smoke passed: ${version} ${sha}`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
throw lastError;
