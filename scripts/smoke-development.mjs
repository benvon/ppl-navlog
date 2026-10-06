import { checkStaticSurface } from './static-smoke.mjs';

const base = 'https://navlog.benvon.dev';
const version = process.env.RELEASE_VERSION;
const sha = process.env.GITHUB_SHA;
if (!/^dev-[1-9]\d*$/.test(version ?? '') || !/^[0-9a-f]{40}$/.test(sha ?? '')) {
  throw new Error('Smoke test requires a development build identifier and full commit SHA.');
}

async function request(host, path, parse, _deadline, _attempt, { method = 'GET', headers = {}, status = 200 } = {}) {
  const response = await fetch(`${host}${path}`, { method, signal: AbortSignal.timeout(10000), headers: { 'Cache-Control': 'no-cache', ...headers } });
  if (response.status !== status) throw new Error(`${path} returned HTTP ${response.status}`);
  return parse(response);
}

let lastError;
for (let attempt = 0; attempt < 6; attempt += 1) {
  try {
    const build = await checkStaticSurface({ request, host: base, deadline: Infinity, attempt: attempt + 1 });
    const api = await request(base, '/api/health', (response) => response.json(), Infinity, attempt + 1);
    if (build.version !== version || build.commitSha !== sha || api.version !== version || api.commitSha !== sha) {
      throw new Error('Deployed static and API build identity do not match the release.');
    }
    if (api.status !== 'ok' || !api.requestId) throw new Error('API health payload invalid.');
    const airportPayload = await request(base, '/api/airports/1C8', (response) => response.json(), Infinity, attempt + 1);
    const airport = airportPayload?.airport;
    if (airport?.requestedIcao !== '1C8' || airport.icao !== '1C8' || typeof airport.name !== 'string' || airport.name.trim() === '') {
      throw new Error('FAA LID airport identity is invalid.');
    }
    const latitude = airport.coordinates?.latitudeDeg;
    const longitude = airport.coordinates?.longitudeDeg;
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(airport.elevationFt)) {
      throw new Error('FAA LID airport coordinates or field elevation are unavailable.');
    }
    if (airportPayload?.provenance?.adapter !== 'runway-picker') throw new Error('FAA LID airport provenance is not runway-picker.');
    console.log(`Development smoke passed: ${version} ${sha}`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
throw lastError;
