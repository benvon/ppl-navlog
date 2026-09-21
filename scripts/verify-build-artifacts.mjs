import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const distDirectory = resolve('dist');
const requiredFiles = ['index.html', 'version.json', 'robots.txt'];

for (const file of requiredFiles) {
  await access(resolve(distDirectory, file));
}

const versionManifest = JSON.parse(await readFile(resolve(distDirectory, 'version.json'), 'utf8'));
if (typeof versionManifest.version !== 'string' || typeof versionManifest.commitSha !== 'string') {
  throw new Error('dist/version.json must contain string version and commitSha values.');
}

const indexHtml = await readFile(resolve(distDirectory, 'index.html'), 'utf8');
if (!indexHtml.includes('<div id="app"></div>')) {
  throw new Error('dist/index.html must contain the application root.');
}

console.log('Build artifact verification passed.');
