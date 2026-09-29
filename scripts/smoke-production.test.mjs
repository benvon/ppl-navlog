import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const smokeUrl = pathToFileURL(resolve('scripts/smoke-production.mjs')).href;
const bootstrap = `
globalThis.setTimeout = (callback) => { queueMicrotask(callback); return 1; };
globalThis.fetch = async (url) => {
  const { hostname, pathname } = new URL(url);
  if (hostname === 'navlog.pplstudyguide.com' && process.env.SECOND_HOST_BAD === 'yes' && pathname === '/api/health') {
    return Response.json({ status: 'ok', version: 'wrong', commitSha: process.env.GITHUB_SHA, requestId: 'fixture' });
  }
  if (pathname === '/') return new Response('<div id="app"></div>', { headers: { 'Content-Security-Policy': "default-src 'self'" } });
  if (pathname === '/version.json') return Response.json({ version: process.env.RELEASE_VERSION, commitSha: process.env.GITHUB_SHA });
  if (pathname === '/api/health') return Response.json({ status: 'ok', version: process.env.RELEASE_VERSION, commitSha: process.env.GITHUB_SHA, requestId: 'fixture' });
  if (pathname === '/api/airports/1C8') return Response.json({ airport: { requestedIcao: '1C8', icao: '1C8', name: 'Fixture airport', coordinates: { latitudeDeg: 41.5, longitudeDeg: -88.5 }, elevationFt: 600 }, provenance: { adapter: 'runway-picker' } });
  return new Response('Unexpected request', { status: 404 });
};
await import(${JSON.stringify(smokeUrl)});
`;

function runSmoke(secondHostBad) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', bootstrap], {
    encoding: 'utf8', timeout: 10_000,
    env: { RELEASE_VERSION: 'v0.1.0-rc.42', GITHUB_SHA: 'a'.repeat(40), SECOND_HOST_BAD: secondHostBad ? 'yes' : 'no' },
  });
}

describe('production deployment smoke', () => {
  it('requires both production hostnames to serve the selected release', () => {
    const result = runSmoke(false);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('navlog.benvon.net');
    expect(result.stdout).toContain('navlog.pplstudyguide.com');
  });

  it('blocks promotion when the second hostname serves another build', () => {
    const result = runSmoke(true);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('navlog.pplstudyguide.com: static and API build identity differ');
  });
});
