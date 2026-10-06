import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const SHA = /^[a-f0-9]{40}$/;

export async function createCoordinatorManifest({ commitSha, version, bundlePath }) {
  if (!SHA.test(commitSha ?? '') || typeof version !== 'string' || !version) throw new Error('Coordinator release identity is invalid.');
  const bytes = await readFile(bundlePath);
  return { commitSha, version, bundleSha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function verifyCoordinatorArtifact(artifactDirectory, expected) {
  const root = resolve(artifactDirectory);
  const staticManifest = JSON.parse(await readFile(resolve(root, 'dist/version.json'), 'utf8'));
  const coordinatorDir = resolve(root, 'release-artifact/weather-coordinator');
  const bundlePath = resolve(coordinatorDir, 'worker.js');
  const manifestPath = resolve(coordinatorDir, 'manifest.json');
  if (!bundlePath.startsWith(`${coordinatorDir}${sep}`)) throw new Error('Coordinator bundle path is invalid.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!SHA.test(expected?.commitSha ?? '') || staticManifest.commitSha !== expected.commitSha ||
      manifest.commitSha !== expected.commitSha || manifest.version !== expected.version || staticManifest.version !== expected.version) {
    throw new Error('Coordinator artifact identity does not match the static release identity.');
  }
  const actualSha = createHash('sha256').update(await readFile(bundlePath)).digest('hex');
  if (manifest.bundleSha256 !== actualSha) throw new Error('Coordinator artifact bytes do not match their manifest.');
  return { bundlePath, manifest };
}
