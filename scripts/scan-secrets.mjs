import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const rules = [
  { name: 'AWS access key', expression: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key', expression: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: 'Cloudflare API token assignment', expression: /CLOUDFLARE_API_TOKEN\s*[:=]\s*['"][^'"]+['"]/i }
];
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const findings = [];

for (const file of files) {
  const source = await readFile(file, 'utf8').catch(() => null);
  if (!source) {
    continue;
  }
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (line.includes('secret-scan:allow')) {
      continue;
    }
    for (const rule of rules) {
      if (rule.expression.test(line)) {
        findings.push(`${file}:${index + 1} (${rule.name})`);
      }
    }
  }
}

if (findings.length > 0) {
  throw new Error(`Secret scan failed:\n${findings.map((finding) => `- ${finding}`).join('\n')}`);
}

console.log('Secret scan passed with no findings.');
