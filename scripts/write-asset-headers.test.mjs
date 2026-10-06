import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = resolve('scripts/write-asset-headers.mjs');
const baseHeaders = '/*\n  X-Content-Type-Options: nosniff\n/version.json\n  Cache-Control: no-store\n';

async function runGenerator(assetNames) {
  const root = await mkdtemp(join(tmpdir(), 'ppl-navlog-header-generation-'));
  try {
    const assetDirectory = join(root, 'dist', 'assets');
    await mkdir(assetDirectory, { recursive: true });
    await writeFile(join(root, 'dist', '_headers'), baseHeaders);
    for (const name of assetNames) {
      const path = join(assetDirectory, name);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'asset');
    }
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    return { result, headers: await readFile(join(root, 'dist', '_headers'), 'utf8') };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('asset header generation', () => {
  it('writes exact immutable rules for fingerprinted build assets', async () => {
    const { result, headers } = await runGenerator(['index-a1b2c3d4.js', 'nested/style-0123456789.css']);
    expect(result.status).toBe(0);
    expect(headers).toContain('/assets/index-a1b2c3d4.js\n  Cache-Control: public, max-age=31536000, immutable');
    expect(headers).toContain('/assets/nested/style-0123456789.css\n  Cache-Control: public, max-age=31536000, immutable');
  });

  it('rejects unsafe or non-fingerprinted names', async () => {
    const { result } = await runGenerator(['app.js']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('fingerprinted');
  });

  it('rejects a header file that would exceed Cloudflare Pages rule limit', async () => {
    const names = Array.from({ length: 99 }, (_, index) => `asset-${String(index).padStart(8, '0')}.js`);
    const { result } = await runGenerator(names);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('100-rule limit');
  });
});
