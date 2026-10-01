const hosts = ['https://navlog.benvon.net', 'https://navlog.pplstudyguide.com'];
const buildVersion = process.env.BUILD_VERSION;
const releaseVersion = process.env.RELEASE_VERSION;
const sha = process.env.GITHUB_SHA;
if (!/^dev-[1-9]\d*$/.test(buildVersion ?? '') || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(releaseVersion ?? '') || !/^[0-9a-f]{40}$/.test(sha ?? '')) {
  throw new Error('Production smoke requires the development build identifier, stable release version, and full commit SHA.');
}

async function get(host, path) {
  const response = await fetch(`${host}${path}`, { signal: AbortSignal.timeout(10000), headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw new Error(`${host}${path} returned HTTP ${response.status}`);
  return response;
}

async function checkHost(host) {
  const [index, manifest, health] = await Promise.all([get(host, '/'), get(host, '/version.json'), get(host, '/api/health')]);
  const [html, build, api] = await Promise.all([index.text(), manifest.json(), health.json()]);
  if (!html.includes('<div id="app"></div>')) throw new Error(`${host}: app root missing.`);
  if (!index.headers.get('Content-Security-Policy')?.includes("default-src 'self'")) throw new Error(`${host}: static CSP missing.`);
  if (build.version !== buildVersion || build.commitSha !== sha || api.version !== releaseVersion || api.commitSha !== sha) {
    throw new Error(`${host}: static development build and stable API release identity differ from the promoted artifact.`);
  }
  if (api.status !== 'ok' || !api.requestId) throw new Error(`${host}: API health payload invalid.`);
  const airportResponse = await get(host, '/api/airports/1C8');
  const payload = await airportResponse.json();
  const airport = payload?.airport;
  if (airport?.requestedIcao !== '1C8' || airport.icao !== '1C8' || typeof airport.name !== 'string' || airport.name.trim() === '') {
    throw new Error(`${host}: FAA LID airport identity is invalid.`);
  }
  const latitude = airport.coordinates?.latitudeDeg;
  const longitude = airport.coordinates?.longitudeDeg;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(airport.elevationFt)) {
    throw new Error(`${host}: FAA LID airport coordinates or elevation are unavailable.`);
  }
  if (payload?.provenance?.adapter !== 'runway-picker') throw new Error(`${host}: FAA LID airport provenance is not runway-picker.`);
}

for (const host of hosts) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await checkHost(host);
      lastError = undefined;
      console.log(`Production smoke passed for ${host}: ${buildVersion} artifact, ${releaseVersion} release, ${sha}`);
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  if (lastError) throw lastError;
}
