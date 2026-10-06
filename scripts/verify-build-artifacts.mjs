import { access, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const distDirectory = resolve('dist');
const requiredFiles = ['index.html', 'version.json', 'robots.txt', '_headers'];
for (const file of requiredFiles) await access(resolve(distDirectory, file));

const versionManifest = JSON.parse(await readFile(resolve(distDirectory, 'version.json'), 'utf8'));
if (typeof versionManifest.version !== 'string' || typeof versionManifest.commitSha !== 'string') {
  throw new Error('dist/version.json must contain string version and commitSha values.');
}

const indexHtml = await readFile(resolve(distDirectory, 'index.html'), 'utf8');
if (!indexHtml.includes('<div id="app"></div>')) throw new Error('dist/index.html must contain the application root.');

const assetDirectory = resolve(distDirectory, 'assets');
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

const assets = await listFiles(assetDirectory);
const relativeAssets = assets.map((file) => file.slice(assetDirectory.length + 1)).sort();
const validPath = /^[A-Za-z0-9._/-]+$/;
const fingerprintedName = /[-_.][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
for (const file of relativeAssets) {
  if (!validPath.test(file) || file.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error(`Unsafe build asset path: ${file}`);
  }
  if (!fingerprintedName.test(file)) throw new Error(`Build asset filename is not fingerprinted: ${file}`);
}

for (const [, , reference] of indexHtml.matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) {
  if (!reference.startsWith('/') || reference.startsWith('//') || reference.includes('\\')
    || [...reference].some((character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)) {
    throw new Error(`HTML asset reference is not safe: ${reference}`);
  }
  if (reference.split(/[?#]/, 1)[0].split('/').some((part) => part === '.' || part === '..')) {
    throw new Error(`HTML asset reference is not safe: ${reference}`);
  }
  const path = new URL(reference, 'https://build.invalid').pathname;
  if (path.split('/').some((part) => part === '.' || part === '..')) throw new Error(`HTML asset reference is not safe: ${reference}`);
  try {
    await access(resolve(distDirectory, `.${path}`));
  } catch {
    throw new Error(`HTML reference does not resolve to a built asset: ${reference}`);
  }
  if (path.startsWith('/assets/') && !relativeAssets.includes(path.slice('/assets/'.length))) {
    throw new Error(`HTML asset reference does not resolve to a fingerprinted built asset: ${reference}`);
  }
}

const headerText = await readFile(resolve(distDirectory, '_headers'), 'utf8');
const rules = new Map();
let currentRule;
for (const line of headerText.split(/\r?\n/)) {
  if (!line.trim() || line.trimStart().startsWith('#')) continue;
  if (!/^\s/.test(line)) {
    currentRule = line.trim();
    if (rules.has(currentRule)) throw new Error(`dist/_headers contains duplicate rule ${currentRule}.`);
    rules.set(currentRule, new Map());
    continue;
  }
  const match = /^\s+([^:]+):\s*(.*)$/.exec(line);
  if (!currentRule || !match) throw new Error('dist/_headers contains an invalid header declaration.');
  const name = match[1].toLowerCase();
  if (rules.get(currentRule).has(name)) throw new Error(`dist/_headers contains duplicate ${match[1]} declarations.`);
  rules.get(currentRule).set(name, match[2]);
}

const requiredSecurityHeaders = {
  'content-security-policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'; form-action 'none'; object-src 'none'",
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY'
};
const globalHeaders = rules.get('/*');
if (!globalHeaders || Object.entries(requiredSecurityHeaders).some(([name, value]) => globalHeaders.get(name) !== value)
  || [...globalHeaders.keys()].some((name) => !(name in requiredSecurityHeaders))) {
  throw new Error('dist/_headers must apply only the required security headers to /*.');
}
if (rules.get('/version.json')?.size !== 1 || rules.get('/version.json')?.get('cache-control') !== 'no-store') {
  throw new Error('dist/_headers must set Cache-Control: no-store for /version.json.');
}
if ([...rules.keys()].some((rule) => rule === '/assets/*' || rule === '/assets/**')) {
  throw new Error('dist/_headers must use exact fingerprinted asset rules; broad immutable asset rules can cache SPA fallbacks.');
}
for (const file of relativeAssets) {
  const rule = rules.get(`/assets/${file}`);
  if (rule?.size !== 1 || rule?.get('cache-control') !== 'public, max-age=31536000, immutable') {
    throw new Error(`dist/_headers must give each fingerprinted built asset an immutable cache rule: ${file}`);
  }
}
const exactAssetRules = [...rules.keys()].filter((rule) => rule.startsWith('/assets/'));
if (exactAssetRules.length !== relativeAssets.length || rules.size !== relativeAssets.length + 2 || rules.size > 100) {
  throw new Error('dist/_headers must contain exactly one rule per built asset and no more than 100 rules.');
}

console.log('Build artifact verification passed.');
