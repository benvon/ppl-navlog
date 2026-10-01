import { appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

export function developmentBuildId(runNumber) {
  if (!/^[1-9]\d*$/.test(String(runNumber))) throw new Error('GITHUB_RUN_NUMBER must be a positive integer.');
  return `dev-${runNumber}`;
}

if (process.argv[1]?.endsWith('/rc-version.mjs')) {
  const release = developmentBuildId(process.env.GITHUB_RUN_NUMBER);
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const existingTag = git('tag', '--list', release);
  if (existingTag === release && git('rev-list', '-n', '1', release) !== process.env.GITHUB_SHA) {
    throw new Error(`${release} already points to a different commit.`);
  }
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${release}\n`);
  console.log(release);
}
