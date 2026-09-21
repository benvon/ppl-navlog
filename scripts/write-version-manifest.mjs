import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const version = process.env.VITE_APP_VERSION?.trim() || 'v0.0.0-dev';
const commitSha = process.env.VITE_APP_COMMIT_SHA?.trim().toLowerCase() || 'local';

if (!/^v?[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
  throw new Error('VITE_APP_VERSION must be a non-sensitive version identifier.');
}

if (!(commitSha === 'local' || /^[a-f0-9]{7,40}$/.test(commitSha))) {
  throw new Error('VITE_APP_COMMIT_SHA must be a Git SHA or local.');
}

const distDirectory = resolve('dist');
await mkdir(distDirectory, { recursive: true });
await writeFile(resolve(distDirectory, 'version.json'), `${JSON.stringify({ version, commitSha })}\n`, 'utf8');
