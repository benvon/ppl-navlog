import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createCoordinatorManifest } from './weather-coordinator-artifact.mjs';

const commitSha = (process.env.APP_COMMIT_SHA ?? process.env.VITE_APP_COMMIT_SHA ?? '').trim().toLowerCase();
const version = (process.env.APP_VERSION ?? process.env.VITE_APP_VERSION ?? '').trim();
if (!/^[a-f0-9]{40}$/.test(commitSha) || !version) throw new Error('APP_COMMIT_SHA and APP_VERSION are required to build the coordinator release artifact.');
const outputDirectory = resolve('release-artifact/weather-coordinator');
await mkdir(outputDirectory, { recursive: true });
execFileSync(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'deploy', '--dry-run', '--config', 'wrangler.weather-coordinator.jsonc', '--env', 'development', '--outfile', resolve(outputDirectory, 'worker.js')], { stdio: 'inherit' });
const manifest = await createCoordinatorManifest({ commitSha, version, bundlePath: resolve(outputDirectory, 'worker.js') });
await writeFile(resolve(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
console.log('Built immutable weather coordinator release artifact.');
