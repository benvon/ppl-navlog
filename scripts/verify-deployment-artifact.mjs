import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('dist/version.json', 'utf8'));
if (manifest.version !== process.env.RELEASE_VERSION || manifest.commitSha !== process.env.GITHUB_SHA) {
  throw new Error('Validated artifact identity does not match this release commit and version.');
}
console.log('Deployment artifact identity verified.');
