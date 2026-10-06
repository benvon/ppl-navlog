import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = resolve('scripts/verify-build-artifacts.mjs');

const requiredHeaders = '/*\n  Content-Security-Policy: default-src \'self\'; base-uri \'none\'; frame-ancestors \'none\'; connect-src \'self\'; form-action \'none\'; object-src \'none\'\n  Permissions-Policy: geolocation=(), microphone=(), camera=()\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n/version.json\n  Cache-Control: no-store\n';

async function runVerifier({ assets = [], html = '<div id="app"></div>', headers = requiredHeaders } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ppl-navlog-artifacts-'));
  try {
    const dist = join(root, 'dist');
    await mkdir(join(dist, 'assets'), { recursive: true });
    await writeFile(join(dist, 'index.html'), html);
    await writeFile(join(dist, 'version.json'), JSON.stringify({ version: 'v1', commitSha: 'abc' }));
    await writeFile(join(dist, 'robots.txt'), 'User-agent: *');
    await writeFile(join(dist, '_headers'), headers.replaceAll('\\n', '\n'));
    for (const asset of assets) {
      await writeFile(join(dist, asset.path), asset.content ?? 'asset');
    }
    return spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('build artifact verification', () => {
  it('accepts fingerprinted assets referenced by built HTML and required cache policies', async () => {
    const result = await runVerifier({
      assets: [{ path: 'assets/app-a1b2c3d4.js' }, { path: 'assets/app-0123456789abcdef.css' }],
      html: '<div id="app"></div><script type="module" src="/assets/app-a1b2c3d4.js"></script><link href="/assets/app-0123456789abcdef.css" rel="stylesheet">',
      headers: `${requiredHeaders}/assets/app-a1b2c3d4.js\n  Cache-Control: public, max-age=31536000, immutable\n/assets/app-0123456789abcdef.css\n  Cache-Control: public, max-age=31536000, immutable\n`
    });
    expect(result.status).toBe(0);
  });

  it('rejects any non-fingerprinted asset in dist/assets', async () => {
    const result = await runVerifier({ assets: [{ path: 'assets/app.js' }] });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('fingerprint');
  });

  it('rejects HTML references that do not resolve to a built asset', async () => {
    const result = await runVerifier({ html: '<div id="app"></div><script src="/assets/missing-a1b2c3d4.js"></script>' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('built asset');
  });

  it('rejects unsafe HTML asset references', async () => {
    const result = await runVerifier({ html: '<div id="app"></div><script src="https://evil.test/app.js"></script>' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('safe');
  });

  it('requires dist/_headers cache rules for static content, version manifest, and fingerprinted assets', async () => {
    const result = await runVerifier({ headers: '/*\n  X-Content-Type-Options: nosniff\n' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('_headers');
  });

  it('rejects duplicate header declarations', async () => {
    const headers = requiredHeaders.replace('  Referrer-Policy: no-referrer', '  Referrer-Policy: no-referrer\n  Referrer-Policy: unsafe-url');
    const result = await runVerifier({ headers });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('duplicate');
  });

  it('rejects unexpected rules that can override policy', async () => {
    const result = await runVerifier({ headers: `${requiredHeaders}/\n  Referrer-Policy: unsafe-url\n` });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('_headers');
  });
});
