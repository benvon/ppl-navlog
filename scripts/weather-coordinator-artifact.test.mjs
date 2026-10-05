import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCoordinatorManifest, verifyCoordinatorArtifact } from './weather-coordinator-artifact.mjs';

let dir;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

describe('coordinator release artifact', () => {
  it('binds immutable coordinator bytes and manifest to static release identity', async () => {
    dir = await mkdtemp(join(tmpdir(), 'weather-artifact-'));
    await mkdir(join(dir, 'release-artifact/weather-coordinator'), { recursive: true });
    await mkdir(join(dir, 'dist'));
    await writeFile(join(dir, 'dist/version.json'), JSON.stringify({ version: 'dev-123', commitSha: 'a'.repeat(40) }));
    await writeFile(join(dir, 'release-artifact/weather-coordinator/worker.js'), 'verified coordinator bytes');
    await writeFile(join(dir, 'release-artifact/weather-coordinator/manifest.json'), JSON.stringify(await createCoordinatorManifest({ commitSha: 'a'.repeat(40), version: 'dev-123', bundlePath: join(dir, 'release-artifact/weather-coordinator/worker.js') })));
    await expect(verifyCoordinatorArtifact(dir, { commitSha: 'a'.repeat(40), version: 'dev-123' })).resolves.toBeDefined();
    await expect(verifyCoordinatorArtifact(dir, { commitSha: 'b'.repeat(40), version: 'dev-123' })).rejects.toThrow(/identity/i);
  });
});
