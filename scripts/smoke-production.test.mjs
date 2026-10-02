import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProductionSmoke } from './smoke-production.mjs';

const hosts = ['https://navlog.benvon.net', 'https://navlog.pplstudyguide.com'];
const env = { BUILD_VERSION: 'dev-42', RELEASE_VERSION: 'v0.1.0', GITHUB_SHA: 'a'.repeat(40) };

function fixtureResponse(host, path, identity = {}) {
  const sha = identity.sha ?? env.GITHUB_SHA;
  const apiSha = identity.apiSha ?? sha;
  const buildVersion = identity.buildVersion ?? env.BUILD_VERSION;
  const apiVersion = identity.apiVersion ?? env.RELEASE_VERSION;
  if (path === '/') return response('<div id="app"></div>', "default-src 'self'");
  if (path === '/version.json') return response({ version: buildVersion, commitSha: sha });
  if (path === '/api/health') return response({ status: 'ok', version: apiVersion, commitSha: apiSha, requestId: 'fixture' });
  if (path === '/api/airports/1C8') return response({ airport: { requestedIcao: '1C8', icao: '1C8', name: 'Fixture airport', coordinates: { latitudeDeg: 41.5, longitudeDeg: -88.5 }, elevationFt: 600 }, provenance: { adapter: 'runway-picker' } });
  throw new Error(`Unexpected request ${host}${path}`);
}

function response(value, csp = null, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => csp }, text: async () => value, json: async () => value };
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
    const task = run(async (url) => {
      requested.push(new URL(url).hostname + new URL(url).pathname);
      return fixtureResponse(new URL(url).hostname, new URL(url).pathname);
    }, clock);
    await drive(task);
    for (const host of hosts) {
      const hostname = new URL(host).hostname;
      expect(requested).toEqual(expect.arrayContaining([`${hostname}/`, `${hostname}/version.json`, `${hostname}/api/health`, `${hostname}/api/airports/1C8`]));
    }
  });

  it.each([
    ['app root', '/', () => response('<main></main>', "default-src 'self'")],
    ['static CSP', '/', () => response('<div id="app"></div>', "default-src https:")],
    ['health status', '/api/health', () => response({ status: 'unavailable', version: env.RELEASE_VERSION, commitSha: env.GITHUB_SHA, requestId: 'fixture' })],
    ['airport identity', '/api/airports/1C8', () => response({ airport: { requestedIcao: '1C8', icao: 'KJVL', name: 'Wrong airport', coordinates: { latitudeDeg: 41.5, longitudeDeg: -88.5 }, elevationFt: 600 }, provenance: { adapter: 'runway-picker' } })],
  ])('continues to block a host when its %s check fails', async (_label, failingPath, failingResponse) => {
    const clock = fakeClock();
    const warnings = [];
    const pending = run(async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'navlog.benvon.net' && parsed.pathname === failingPath) return failingResponse();
      return fixtureResponse(parsed.hostname, parsed.pathname);
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
    const task = run(async (url) => {
      const parsed = new URL(url);
      const key = `${parsed.hostname}${parsed.pathname}`;
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      const stale = parsed.pathname === '/api/health' && count < 5;
      return fixtureResponse(parsed.hostname, parsed.pathname, stale ? { apiVersion: 'v9.9.9', sha: 'b'.repeat(40) } : {});
    }, clock);
    await drive(task);
    expect(clock.now()).toBeGreaterThanOrEqual(40_000);
    expect(attempts.get('navlog.benvon.net/api/health')).toBe(5);
    expect(attempts.get('navlog.pplstudyguide.com/api/health')).toBe(5);
  });

  it('reports bounded expected and actual static/API versions and commit SHAs with host and attempt', async () => {
    const clock = fakeClock();
    const pending = run(async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'navlog.benvon.net') return fixtureResponse(parsed.hostname, parsed.pathname);
      return fixtureResponse(parsed.hostname, parsed.pathname, { buildVersion: 'dev-41', apiVersion: 'v9.9.9', sha: 'b'.repeat(40), apiSha: 'c'.repeat(40) });
    }, clock);
    await expect(drive(pending)).rejects.toThrow(/navlog\.pplstudyguide\.com.*attempt \d+.*expected.*dev-42.*v0\.1\.0.*static commit SHA=a{40}.*API commit SHA=a{40}.*actual.*dev-41.*v9\.9\.9.*static commit SHA=b{40}.*API commit SHA=c{40}/i);
  });

  it('bounds fetch and body reads to 10 seconds and reports safe endpoint context', async () => {
    const clock = fakeClock();
    const warnings = [];
    let hungBodySignal;
    let bodyReads = 0;
    const pending = run(async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/version.json' && bodyReads++ === 0) {
        hungBodySignal = options.signal;
        return { ok: true, status: 200, headers: { get: () => null }, json: () => new Promise(() => {}) };
      }
      return fixtureResponse(parsed.hostname, parsed.pathname);
    }, clock, { log() {}, warn: (message) => warnings.push(message) });
    await drive(pending);
    expect(hungBodySignal.aborted).toBe(true);
    expect(warnings[0]).toMatch(/navlog\.benvon\.net.*attempt 1.*\/version\.json request timeout after 10000ms/);
  });

  it('applies the overall deadline to body consumption and clips request timeout to remaining time', async () => {
    const clock = fakeClock();
    const pending = run(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/') return fixtureResponse(parsed.hostname, parsed.pathname);
      if (parsed.hostname === 'navlog.benvon.net' && parsed.pathname === '/version.json') return { ok: true, status: 200, headers: { get: () => null }, json: () => new Promise(() => {}) };
      return fixtureResponse(parsed.hostname, parsed.pathname);
    }, clock);
    await expect(drive(pending)).rejects.toThrow(/deadline/i);
    expect(clock.now()).toBe(180_000);
  });

  it('includes HTTP status without leaking response bodies or arbitrary causes', async () => {
    const clock = fakeClock();
    const pending = run(async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'navlog.benvon.net') return fixtureResponse(parsed.hostname, parsed.pathname);
      if (parsed.pathname === '/') return response('sensitive provider details', null, 503);
      return fixtureResponse(parsed.hostname, parsed.pathname);
    }, clock);
    const error = await drive(pending).then(() => undefined, (failure) => failure);
    expect(error.message).toMatch(/navlog\.pplstudyguide\.com.*attempt 36.*HTTP 503/i);
    expect(error.message).not.toContain('sensitive provider details');
  });

  it('keeps arbitrary fetch causes internal and excludes them from retry diagnostics', async () => {
    const clock = fakeClock();
    const warnings = [];
    const pending = run(async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'navlog.pplstudyguide.com' && parsed.pathname === '/') throw new Error('sensitive provider details');
      return fixtureResponse(parsed.hostname, parsed.pathname);
    }, clock, { log() {}, warn: (message) => warnings.push(message) });
    const error = await drive(pending).then(() => undefined, (failure) => failure);
    expect(error.message).not.toContain('sensitive provider details');
    expect(warnings.every((message) => !message.includes('sensitive provider details'))).toBe(true);
    expect(error.cause.cause.message).toBe('sensitive provider details');
  });

  it('starts a fresh three-minute deadline for the second host after the first converges', async () => {
    const clock = fakeClock();
    const attempts = new Map();
    const pending = run(async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'navlog.pplstudyguide.com' && parsed.pathname === '/') return response('unavailable', null, 503);
      const key = `${parsed.hostname}${parsed.pathname}`;
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      if (parsed.hostname === 'navlog.benvon.net' && parsed.pathname === '/api/health' && count < 5) {
        return fixtureResponse(parsed.hostname, parsed.pathname, { apiVersion: 'v9.9.9' });
      }
      return fixtureResponse(parsed.hostname, parsed.pathname);
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
    const task = run(async (url, options) => {
      if (!stalledSignal) {
        stalledSignal = options.signal;
        return new Promise(() => {});
      }
      const parsed = new URL(url);
      return fixtureResponse(parsed.hostname, parsed.pathname);
    }, clock, { log() {}, warn: (message) => warnings.push(message) });
    await drive(task);
    expect(stalledSignal.aborted).toBe(true);
    expect(clock.now()).toBe(15_000);
    expect(warnings[0]).toContain('/ request timeout after 10000ms');
  });

  it('filters malformed release fields from both retry and final diagnostics', async () => {
    const clock = fakeClock();
    const warnings = [];
    const task = run(async (url) => {
      const parsed = new URL(url);
      return fixtureResponse(parsed.hostname, parsed.pathname, {
        buildVersion: 'sensitive-provider-data\\n' + 'x'.repeat(1000),
        apiVersion: 'sensitive-provider-data',
        sha: 'sensitive-provider-data',
      });
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
      ${response.toString()}
      ${fixtureResponse.toString()}
      globalThis.fetch = async (url) => {
        const parsed = new URL(url);
        return fixtureResponse(parsed.hostname, parsed.pathname);
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
