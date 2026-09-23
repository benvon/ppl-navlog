import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const smokeUrl = pathToFileURL(resolve('scripts/smoke-development.mjs')).href;
const bootstrap = `
globalThis.setTimeout = (callback) => { queueMicrotask(callback); return 1; };
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname;
  if (path === '/') return new Response('<div id="app"></div>', { headers: { 'Content-Security-Policy': "default-src 'self'" } });
  if (path === '/version.json') return Response.json({ version: process.env.RELEASE_VERSION, commitSha: process.env.GITHUB_SHA });
  if (path === '/api/health') return Response.json({ status: 'ok', version: process.env.RELEASE_VERSION, commitSha: process.env.GITHUB_SHA, requestId: 'smoke-test-request' });
  if (path === '/api/airports/1C8') {
    if (process.env.AIRPORT_SCENARIO === 'unavailable') return Response.json({ error: 'Upstream unavailable' }, { status: 503 });
    return Response.json({
      airport: {
        requestedIcao: '1C8',
        icao: process.env.AIRPORT_SCENARIO === 'wrong-airport' ? 'KORD' : '1C8',
        name: 'Fixture airport 1C8',
        municipality: 'Fixture town',
        countryCode: 'US',
        countryName: 'United States',
        coordinates: { latitudeDeg: 41.5, longitudeDeg: -88.5 },
        elevationFt: process.env.AIRPORT_SCENARIO === 'no-elevation' ? null : 600,
        runwayEnds: [{ id: '18', headingDegTrue: 180, isClosed: false, lengthFt: 3000 }],
        frequencies: [],
        source: 'airportdb',
        fetchedAt: '2026-09-23T12:00:00.000Z',
      },
      provenance: {
        adapter: process.env.AIRPORT_SCENARIO === 'wrong-provenance' ? 'other-service' : 'runway-picker',
        fetchedAt: '2026-09-23T12:00:00.000Z',
        cache: { status: 'upstream_refresh', source: 'upstream', ageSeconds: 0, fetchedAt: '2026-09-23T12:00:00.000Z', expiresAt: '2026-09-24T12:00:00.000Z', freshnessRemainingSeconds: 86400, servedAt: '2026-09-23T12:00:00.000Z', ttlSeconds: 86400, maxPayloadAgeSeconds: 172800, key: 'airport:1C8', resource: 'airport' },
      },
      requestId: 'airport-smoke-test-request',
    });
  }
  return new Response('Unexpected smoke request', { status: 404 });
};
await import(${JSON.stringify(smokeUrl)});
`;

function runSmoke(airportScenario) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', bootstrap], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      RELEASE_VERSION: 'v0.1.0-rc.100',
      GITHUB_SHA: 'a'.repeat(40),
      AIRPORT_SCENARIO: airportScenario,
    },
  });
}

describe('development deployment smoke', () => {
  it('fails the release gate when the bound airport service is unavailable for an FAA LID', () => {
    const result = runSmoke('unavailable');
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('/api/airports/1C8 returned HTTP 503');
  });

  it('fails the release gate when an FAA LID resolves to a different airport', () => {
    const result = runSmoke('wrong-airport');
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FAA LID airport identity');
  });

  it('fails the release gate when the airport lacks a field elevation', () => {
    const result = runSmoke('no-elevation');
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FAA LID airport coordinates or field elevation');
  });

  it('fails the release gate when the airport did not come through runway-picker', () => {
    const result = runSmoke('wrong-provenance');
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FAA LID airport provenance');
  });

  it('accepts a usable FAA LID response after static and API identity checks', () => {
    const result = runSmoke('valid');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Development smoke passed');
  });
});
