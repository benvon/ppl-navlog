import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const workflowDirectory = '.github/workflows';
const errors = [];
const files = (await readdir(workflowDirectory)).filter((file) => file.endsWith('.yml') || file.endsWith('.yaml')).sort();

for (const file of files) {
  const path = join(workflowDirectory, file);
  const content = await readFile(path, 'utf8');
  if (!/^name:\s+.+/m.test(content) || !/^on:/m.test(content) || !/^jobs:/m.test(content)) {
    errors.push(`${path}: must include name, on, and jobs.`);
  }
  if (/\tpull_request_target:/.test(content) || /^\s*pull_request_target:/m.test(content)) {
    errors.push(`${path}: pull_request_target is not permitted.`);
  }
  if (/^\s+queue:\s*/m.test(content)) {
    errors.push(`${path}: GitHub Actions concurrency does not support queue.`);
  }
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*uses:\s*([^\s]+)/);
    if (match && !match[1].startsWith('./') && !/@[0-9a-f]{40}$/i.test(match[1])) {
      errors.push(`${path}: action references must be pinned to a full commit SHA.`);
    }
  }
}

if (errors.length > 0) {
  throw new Error(`Workflow lint failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
}

console.log(`Workflow lint passed for ${files.length} workflow file(s).`);
