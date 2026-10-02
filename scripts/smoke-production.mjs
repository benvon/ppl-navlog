import { pathToFileURL } from 'node:url';

const hosts = ['https://navlog.benvon.net', 'https://navlog.pplstudyguide.com'];
const DOMAIN_DEADLINE_MS = 180_000;
const RETRY_DELAY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;

function safeReleaseField(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : '<invalid>';
}

function safeFailure(message, cause) {
  return Object.assign(new Error(message, { cause }), { safeSmokeFailure: true });
}

function identityMismatch(host, attempt, expected, actual) {
  return safeFailure(`${host}: attempt ${attempt}: release identity mismatch; expected static version=${expected.buildVersion}, API version=${expected.releaseVersion}, static commit SHA=${expected.sha}, API commit SHA=${expected.sha}; actual static version=${actual.buildVersion}, API version=${actual.releaseVersion}, static commit SHA=${actual.staticSha}, API commit SHA=${actual.apiSha}`);
}

export async function runProductionSmoke({
  env = process.env,
  fetchImpl = fetch,
  now = () => performance.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console,
} = {}) {
  const buildVersion = env.BUILD_VERSION;
  const releaseVersion = env.RELEASE_VERSION;
  const sha = env.GITHUB_SHA;
  if (!/^dev-[1-9]\d*$/.test(buildVersion ?? '') || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(releaseVersion ?? '') || !/^[0-9a-f]{40}$/.test(sha ?? '')) {
    throw new Error('Production smoke requires the development build identifier, stable release version, and full commit SHA.');
  }
  const expected = { buildVersion, releaseVersion, sha };

  async function request(host, path, parse, deadline, attempt) {
    const endpoint = `${host}${path}`;
    const remaining = deadline - now();
    if (remaining <= 0) throw safeFailure(`${host}: attempt ${attempt}: overall deadline exceeded before ${path}`);
    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remaining);
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    const deadlineLimited = remaining <= REQUEST_TIMEOUT_MS;
    const timeout = new Promise((_, reject) => {
      timer = setTimeoutFn(() => {
        timedOut = true;
        controller.abort();
        reject(safeFailure(deadlineLimited
          ? `${host}: attempt ${attempt}: overall deadline exceeded during ${path}`
          : `${host}: attempt ${attempt}: ${path} request timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const operation = (async () => {
      const response = await fetchImpl(endpoint, { signal: controller.signal, headers: { 'Cache-Control': 'no-cache' } });
      if (!response.ok) throw safeFailure(`${host}: attempt ${attempt}: ${path} returned HTTP ${response.status}`);
      return await parse(response);
    })();
    try {
      const result = await Promise.race([operation, timeout]);
      if (now() >= deadline) throw safeFailure(`${host}: attempt ${attempt}: overall deadline exceeded while reading ${path}`);
      return result;
    } catch (cause) {
      if (cause?.safeSmokeFailure) throw cause;
      const context = timedOut ? `request timeout after ${timeoutMs}ms` : `request failed (${cause?.name === 'AbortError' ? 'aborted' : 'fetch or response failure'})`;
      throw safeFailure(`${host}: attempt ${attempt}: ${path} ${context}`, cause);
    } finally {
      clearTimeoutFn(timer);
      controller.abort();
    }
  }

  async function checkHost(host, deadline, attempt) {
    const index = await request(host, '/', async (response) => ({
      html: await response.text(),
      csp: response.headers.get('Content-Security-Policy'),
    }), deadline, attempt);
    if (!index.html.includes('<div id="app"></div>')) throw safeFailure(`${host}: attempt ${attempt}: app root missing`);
    if (!index.csp?.includes("default-src 'self'")) throw safeFailure(`${host}: attempt ${attempt}: static CSP missing`);

    const manifest = await request(host, '/version.json', (response) => response.json(), deadline, attempt);
    const health = await request(host, '/api/health', (response) => response.json(), deadline, attempt);
    const staticSha = manifest?.commitSha;
    const apiSha = health?.commitSha;
    if (manifest?.version !== buildVersion || health?.version !== releaseVersion || staticSha !== sha || apiSha !== sha) {
      const actual = {
        buildVersion: safeReleaseField(manifest?.version, /^dev-[1-9]\d{0,9}$/),
        releaseVersion: safeReleaseField(health?.version, /^v(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/),
        staticSha: safeReleaseField(staticSha, /^[0-9a-f]{40}$/),
        apiSha: safeReleaseField(apiSha, /^[0-9a-f]{40}$/),
      };
      throw identityMismatch(host, attempt, expected, actual);
    }
    if (health?.status !== 'ok' || !health.requestId) {
      throw safeFailure(`${host}: attempt ${attempt}: API health payload invalid`);
    }

    const payload = await request(host, '/api/airports/1C8', (response) => response.json(), deadline, attempt);
    const airport = payload?.airport;
    if (airport?.requestedIcao !== '1C8' || airport.icao !== '1C8' || typeof airport.name !== 'string' || airport.name.trim() === '') {
      throw safeFailure(`${host}: attempt ${attempt}: FAA LID airport identity is invalid`);
    }
    const latitude = airport.coordinates?.latitudeDeg;
    const longitude = airport.coordinates?.longitudeDeg;
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(airport.elevationFt)) {
      throw safeFailure(`${host}: attempt ${attempt}: FAA LID airport coordinates or elevation are unavailable`);
    }
    if (payload?.provenance?.adapter !== 'runway-picker') throw safeFailure(`${host}: attempt ${attempt}: FAA LID airport provenance is not runway-picker`);
    if (now() >= deadline) throw safeFailure(`${host}: attempt ${attempt}: overall deadline exceeded after checks`);
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeoutFn(resolve, ms));
  }

  for (const host of hosts) {
    const deadline = now() + DOMAIN_DEADLINE_MS;
    let attempt = 0;
    let lastError;
    while (now() < deadline) {
      attempt += 1;
      try {
        await checkHost(host, deadline, attempt);
        if (now() >= deadline) throw safeFailure(`${host}: attempt ${attempt}: overall deadline exceeded after checks`);
        logger.log(`Production smoke passed for ${host}: ${buildVersion} artifact, ${releaseVersion} release, ${sha}`);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        const remaining = deadline - now();
        if (remaining <= 0) break;
        const warning = error?.safeSmokeFailure ? error.message : `${host}: attempt ${attempt}: request failed`;
        logger.warn?.(warning);
        await delay(Math.min(RETRY_DELAY_MS, remaining));
      }
    }
    if (lastError) {
      const safeMessage = lastError.safeSmokeFailure ? lastError.message : `${host}: final smoke attempt failed`;
      throw safeFailure(`${safeMessage}; ${host} deadline exhausted after ${DOMAIN_DEADLINE_MS}ms`, lastError);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProductionSmoke().catch((error) => {
    const message = error?.safeSmokeFailure ? error.message : error?.message === 'Production smoke requires the development build identifier, stable release version, and full commit SHA.' ? error.message : 'Production smoke failed with an internal request error.';
    console.error(message);
    process.exitCode = 1;
  });
}
