import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProductionSmoke } from './smoke-production.mjs';

const hosts = ['https://navlog.benvon.net', 'https://navlog.pplstudyguide.com'];
const env = { BUILD_VERSION: 'dev-42', RELEASE_VERSION: 'v0.1.0', GITHUB_SHA: 'a'.repeat(40) };

function fixtureResponse(host, path, identity = {}, requestOptions = {}) {
  const sha = identity.sha ?? env.GITHUB_SHA;
  const apiSha = identity.apiSha ?? sha;
  const buildVersion = identity.buildVersion ?? env.BUILD_VERSION;
  const apiVersion = identity.apiVersion ?? env.RELEASE_VERSION;
  if (path === '/') {
    if (requestOptions.method === 'POST') return staticResponse('', 405, null);
    if (requestOptions.method === 'HEAD') return staticResponse('', 200, 'no-cache');
    if (requestOptions.headers?.['If-None-Match'] === '"fixture-root"') return staticResponse('', 304, 'no-cache');
    return staticResponse('<div id="app"></div><link rel="stylesheet" href="/assets/app-Ab12.css"><script type="module" src="/assets/app-Xy34.js"></script>', 200, 'no-cache', { ETag: '"fixture-root"' });
  }
  if (path === '/version.json') return staticResponse({ version: buildVersion, commitSha: sha }, 200, 'no-store');
  if (path === '/robots.txt') return staticResponse('User-agent: *\nDisallow:\n', 200, 'no-cache');
  if (path === '/__static_smoke__/deep-link' || path === '/assets/__static_smoke__-AbCdEf12.js') return staticResponse('<div id="app"></div>', 200, 'no-cache');
  if (path === '/assets/app-Xy34.js') return staticResponse('export default 1;', 200, 'public, max-age=31536000, immutable', { 'Content-Type': 'text/javascript; charset=utf-8' });
  if (path === '/assets/app-Ab12.css') return staticResponse('body { color: black; }', 200, 'public, max-age=31536000, immutable', { 'Content-Type': 'text/css; charset=utf-8' });
  if (path === '/api/health') return response({ status: 'ok', version: apiVersion, commitSha: apiSha, requestId: 'fixture' });
  if (path === '/api/airports/1C8') return response({ airport: { requestedIcao: '1C8', icao: '1C8', name: 'Fixture airport', coordinates: { latitudeDeg: 41.5, longitudeDeg: -88.5 }, elevationFt: 600 }, provenance: { adapter: 'runway-picker' } });
  throw new Error(`Unexpected request ${host}${path}`);
}

function response(value, csp = null, status = 200) {
  return staticResponse(value, status, 'no-cache', csp ? { 'Content-Security-Policy': csp } : {});
}

function staticResponse(value, status = 200, cacheControl = 'no-cache', overrides = {}) {
  const entries = {
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'; form-action 'none'; object-src 'none'",
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': cacheControl,
    'Content-Type': 'text/html; charset=utf-8',
    ...overrides,
  };
  if (cacheControl === null) delete entries['Cache-Control'];
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => entries[name] ?? null }, text: async () => value, json: async () => value };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
afterEach(() => vi.useRealTimers());

function fakeClock() {
  return { now: () => performance.now(), setTimeout, clearTimeout };
}

async function drive(promise) {
  // Attach a rejection handler before advancing timers so failures stay observed.
  const result = promise.then(() => ({ }), (error) => ({ error }));
  await vi.runAllTimersAsync();
  const { error } = await result;
  if (error) throw error;
}

function run(fetchImpl, clock, logger = { log() {} }) {
  return runProductionSmoke({ env, fetchImpl, now: clock.now, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, logger });
}

describe('production deployment smoke', () => {
  it('requires app, CSP, health, identity, and airport checks on both hosts', async () => {
    const requested = [];
    const clock = fakeClock();
    const task = run(async (url, options) => {
      requested.push({ url: new URL(url).hostname + new URL(url).pathname, method: options.method ?? 'GET', headers: options.headers });
      return fixtureResponse(new URL(url).hostname, new URL(url).pathname, {}, options);
    }, clock);
    await drive(task);
    for (const host of hosts) {
      const hostname = new URL(host).hostname;
      expect(requested.map(({ url }) => url)).toEqual(expect.arrayContaining([`${hostname}/`, `${hostname}/version.json`, `${hostname}/robots.txt`, `${hostname}/__static_smoke__/deep-link`, `${hostname}/assets/app-Xy34.js`, `${hostname}/assets/app-Ab12.css`, `${hostname}/api/health`, `${hostname}/api/airports/1C8`]));
      expect(requested).toEqual(expect.arrayContaining([
        { url: `${hostname}/`, method: 'HEAD', headers: expect.any(Object) },
        { url: `${hostname}/`, method: 'POST', headers: expect.any(Object) },
        expect.objectContaining({ url: `${hostname}/`, method: 'GET', headers: expect.objectContaining({ 'If-None-Match': '"fixture-root"' }) }),
      ]));
    }
  });

  it.each([
    ['HEAD', { method: 'HEAD' }, 405],
    ['conditional GET', { headers: { 'If-None-Match': '"fixture-root"' } }, 200],
    ['unsupported POST', { method: 'POST' }, 200],
  ])('fails the release gate when %s returns an unexpected status', async (_label, requestMatch, wrongStatus) => {
    const clock = fakeClock();
    const pending = run(async (url, options = {}) => {
      const parsed = new URL(url);
      const response = fixtureResponse(parsed.hostname, parsed.pathname, {}, options);
      const isTarget = parsed.hostname === 'navlog.benvon.net' && parsed.pathname === '/'
        && (requestMatch.method ? options.method === requestMatch.method : options.headers?.['If-None-Match'] === requestMatch.headers['If-None-Match']);
      return isTarget ? { ...response, status: wrongStatus, ok: wrongStatus >= 200 && wrongStatus < 300 } : response;
    }, clock);
    await expect(drive(pending)).rejects.toThrow(/navlog\.benvon\.net.*HTTP (?:200|405)/);
    expect(clock.now()).toBe(180_000);
  });

  it.each([
    ['app root', '/', () => response('<main></main>', "default-src 'self'")],
    ['static CSP', '/', () => response('<div id="app"></div>', "default-src https:")],
    ['health status', '/api/health', () => response({ status: 'unavailable', version: env.RELEASE_VERSION, commitSha: env.GITHUB_SHA, requestId: 'fixture' })],
    ['airport identity', '/api/airports/1C8', () => response({ airport: { requestedIcao: '1C8', icao: 'KJVL', name: 'Wrong airport', coordinates: { latitudeDeg: 41.5, longitudeDeg: -88.5 }, elevationFt: 600 }, provenance: { adapter: 'runway-picker' } })],
  ])('continues to block a host when its %s check fails', async (_label, failingPath, failingResponse) => {
    const clock = fakeClock();
    const warnings = [];
    const pending = run(async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'navlog.benvon.net' && parsed.pathname === failingPath) return failingResponse();
      return fixtureResponse(parsed.hostname, parsed.pathname, {}, options);
    }, clock, { log() {}, warn: (message) => warnings.push(message) });
    const error = await drive(pending).then(() => undefined, (failure) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/navlog\.benvon\.net.*attempt (?:[2-9]|\d{2,})/);
    expect(error.message).not.toContain('navlog.pplstudyguide.com');
    expect(clock.now()).toBe(180_000);
    expect(warnings.length).toBeGreaterThan(1);
  });

  it('waits beyond 15 seconds for each host to converge from transient mixed releases', async () => {
    const attempts = new Map();
    const clock = fakeClock();
    const task = run(async (url, options = {}) => {
      const parsed = new URL(url);
      const key = `${parsed.hostname}${parsed.pathname}`;
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      const stale = parsed.pathname === '/api/health' && count < 5;
      return fixtureResponse(parsed.hostname, parsed.pathname, stale ? { apiVersion: 'v9.9.9', sha: 'b'.repeat(40) } : {}, options);
    }, clock);
    await drive(task);
    expect(clock.now()).toBeGreaterThanOrEqual(40_000);
    expect(attempts.get('navlog.benvon.net/api/health')).toBe(5);
    expect(attempts.get('navlog.pplstudyguide.com/api/health')).toBe(5);
  });

  it('reports bounded expected and actual static/API versions and commit SHAs with host and attempt', async () => {
    const clock = fakeClock();
    const pending = run(async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'navlog.benvon.net') return fixtureResponse(parsed.hostname, parsed.pathname, {}, options);
      return fixtureResponse(parsed.hostname, parsed.pathname, { buildVersion: 'dev-41', apiVersion: 'v9.9.9', sha: 'b'.repeat(40), apiSha: 'c'.repeat(40) }, options);
    }, clock);
    await expect(drive(pending)).rejects.toThrow(/navlog\.pplstudyguide\.com.*attempt \d+.*expected.*dev-42.*v0\.1\.0.*static commit SHA=a{40}.*API commit SHA=a{40}.*actual.*dev-41.*v9\.9\.9.*static commit SHA=b{40}.*API commit SHA=c{40}/i);
  });

  it('bounds fetch and body reads to 10 seconds and reports safe endpoint context', async () => {
    const clock = fakeClock();
    const warnings = [];
    let hungBodySignal;
    let bodyReads = 0;
    const pending = run(async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/version.json' && bodyReads++ === 0) {
        hungBodySignal = options.signal;
        return { ok: true, status: 200, headers: { get: () => null }, json: () => new Promise(() => {}) };
      }
      return fixtureResponse(parsed.hostname, parsed.pathname, {}, options);
    }, clock, { log() {}, warn: (message) => warnings.push(message) });
    await drive(pending);
    expect(hungBodySignal.aborted).toBe(true);
    expect(warnings[0]).toMatch(/navlog\.benvon\.net.*attempt 1.*\/version\.json request timeout after 10000ms/);
  });

  it('applies the overall deadline to body consumption and clips request timeout to remaining time', async () => {
    const clock = fakeClock();
    const pending = run(async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/') return fixtureResponse(parsed.hostname, parsed.pathname, {}, options);
      if (parsed.hostname === 'navlog.benvon.net' && parsed.pathname === '/version.json') return { ok: true, status: 200, headers: { get: () => null }, json: () => new Promise(() => {}) };
      return fixtureResponse(parsed.hostname, parsed.pathname, {}, options);
    }, clock);
    await expect(drive(pending)).rejects.toThrow(/deadline/i);
    expect(clock.now()).toBe(180_000);
  });

  it('includes HTTP status without leaking response bodies or arbitrary causes', async () => {
    const clock = fakeClock();
    const pending = run(async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'navlog.benvon.net') return fixtureResponse(parsed.hostname, parsed.pathname, {}, options);
      if (parsed.pathname === '/') return response('sensitive provider details', null, 503);
      return fixtureResponse(parsed.hostname, parsed.pathname, {}, options);
    }, clock);
    const error = await drive(pending).then(() => undefined, (failure) => failure);
    expect(error.message).toMatch(/navlog\.pplstudyguide\.com.*attempt 36.*HTTP 503/i);
    expect(error.message).not.toContain('sensitive provider details');
  });

  it('keeps arbitrary fetch causes internal and excludes them from retry diagnostics', async () => {
    const clock = fakeClock();
    const warnings = [];
    const pending = run(async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'navlog.pplstudyguide.com' && parsed.pathname === '/') throw new Error('sensitive provider details');
      return fixtureResponse(parsed.hostname, parsed.pathname, {}, options);
    }, clock, { log() {}, warn: (message) => warnings.push(message) });
    const error = await drive(pending).then(() => undefined, (failure) => failure);
    expect(error.message).not.toContain('sensitive provider details');
    expect(warnings.every((message) => !message.includes('sensitive provider details'))).toBe(true);
    expect(error.cause.cause.message).toBe('sensitive provider details');
  });

  it('starts a fresh three-minute deadline for the second host after the first converges', async () => {
    const clock = fakeClock();
    const attempts = new Map();
    const pending = run(async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'navlog.pplstudyguide.com' && parsed.pathname === '/') return response('unavailable', null, 503);
      const key = `${parsed.hostname}${parsed.pathname}`;
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      if (parsed.hostname === 'navlog.benvon.net' && parsed.pathname === '/api/health' && count < 5) {
        return fixtureResponse(parsed.hostname, parsed.pathname, { apiVersion: 'v9.9.9' }, options);
      }
      return fixtureResponse(parsed.hostname, parsed.pathname, {}, options);
    }, clock);
    const error = await drive(pending).then(() => undefined, (failure) => failure);
    expect(clock.now()).toBe(200_000);
    expect(attempts.get('navlog.benvon.net/api/health')).toBe(5);
    expect(error.message).toMatch(/navlog\.pplstudyguide\.com.*deadline exhausted/);
  });

  it('retries a stalled fetch after its timeout and aborts the request', async () => {
    const clock = fakeClock();
    const warnings = [];
    let stalledSignal;
    const task = run(async (url, options = {}) => {
      if (!stalledSignal) {
        stalledSignal = options.signal;
        return new Promise(() => {});
      }
      const parsed = new URL(url);
      return fixtureResponse(parsed.hostname, parsed.pathname, {}, options);
    }, clock, { log() {}, warn: (message) => warnings.push(message) });
    await drive(task);
    expect(stalledSignal.aborted).toBe(true);
    expect(clock.now()).toBe(15_000);
    expect(warnings[0]).toContain('/ request timeout after 10000ms');
  });

  it('filters malformed release fields from both retry and final diagnostics', async () => {
    const clock = fakeClock();
    const warnings = [];
    const task = run(async (url, options = {}) => {
      const parsed = new URL(url);
      return fixtureResponse(parsed.hostname, parsed.pathname, {
        buildVersion: 'sensitive-provider-data\\n' + 'x'.repeat(1000),
        apiVersion: 'sensitive-provider-data',
        sha: 'sensitive-provider-data',
      }, options);
    }, clock, { log() {}, warn: (message) => warnings.push(message) });
    const error = await drive(task).catch((failure) => failure);
    expect(error.message).toContain('actual static version=<invalid>');
    expect(error.message).toContain('API commit SHA=<invalid>');
    for (const message of [...warnings, error.message]) {
      expect(message).not.toContain('sensitive-provider-data');
      expect(message.length).toBeLessThan(700);
    }
  });

  it('passes the CLI entry point after checking both production domains', () => {
    const smokePath = resolve('scripts/smoke-production.mjs');
    const bootstrap = `
      const env = process.env;
      ${staticResponse.toString()}
      ${response.toString()}
      ${fixtureResponse.toString()}
      globalThis.fetch = async (url, options = {}) => {
        const parsed = new URL(url);
        return fixtureResponse(parsed.hostname, parsed.pathname, {}, options);
      };
      process.argv[1] = ${JSON.stringify(smokePath)};
      await import(${JSON.stringify('file://' + smokePath)});
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', bootstrap], {
      encoding: 'utf8', timeout: 10_000, env,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    for (const host of hosts) expect(result.stdout).toContain(`Production smoke passed for ${host}`);
  });

  it('rejects malformed expected release identity before issuing requests', async () => {
    const clock = fakeClock();
    let calls = 0;
    await expect(runProductionSmoke({ env: { ...env, BUILD_VERSION: 'invalid' }, fetchImpl: async () => { calls += 1; }, now: clock.now, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, logger: { log() {} } })).rejects.toThrow(/Production smoke requires/);
    expect(calls).toBe(0);
  });

  it('runs through the CLI entry point and reports invalid release inputs without a stack trace', () => {
    const result = spawnSync(process.execPath, [resolve('scripts/smoke-production.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, BUILD_VERSION: 'invalid', RELEASE_VERSION: 'v0.1.0', GITHUB_SHA: env.GITHUB_SHA },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Production smoke requires/);
    expect(result.stderr).not.toMatch(/at runProductionSmoke/);
  });
});
