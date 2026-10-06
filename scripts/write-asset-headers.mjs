import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const distDirectory = resolve('dist');
const assetDirectory = resolve(distDirectory, 'assets');
const headerFile = resolve(distDirectory, '_headers');
const baseHeaders = await readFile(headerFile, 'utf8');

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Unsupported build asset entry: ${entry.name}`);
  }
  return files;
}

const files = await listFiles(assetDirectory);
const relativeFiles = files.map((file) => file.slice(assetDirectory.length + 1)).sort();
const validPath = /^[A-Za-z0-9._/-]+$/;
const fingerprintedName = /[-_.][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
for (const file of relativeFiles) {
  if (!validPath.test(file) || file.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error(`Unsafe build asset path: ${file}`);
  }
  if (!fingerprintedName.test(file)) throw new Error(`Build asset filename is not fingerprinted: ${file}`);
}

const baseRuleCount = (baseHeaders.match(/^\/(?:\*|version\.json)$/gm) ?? []).length;
if (baseRuleCount + relativeFiles.length > 100) {
  throw new Error('dist/_headers would exceed Cloudflare Pages\' 100-rule limit.');
}

const exactRules = relativeFiles.map((file) => `\n/assets/${file}\n  Cache-Control: public, max-age=31536000, immutable`).join('');
await writeFile(headerFile, `${baseHeaders.trimEnd()}${exactRules}\n`, 'utf8');
