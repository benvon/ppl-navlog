import { appendFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

export function rcVersion(packageVersion, runNumber) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(packageVersion)) throw new Error('package.json version must be a stable SemVer triplet.');
  if (!/^[1-9]\d*$/.test(String(runNumber))) throw new Error('GITHUB_RUN_NUMBER must be a positive integer.');
  return `v${packageVersion}-rc.${runNumber}`;
}

if (process.argv[1]?.endsWith('/rc-version.mjs')) {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const release = rcVersion(version, process.env.GITHUB_RUN_NUMBER);
  const stableTag = `v${version}`;
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  if (git('tag', '--list', stableTag) === stableTag) throw new Error(`${stableTag} already exists. Bump package.json before the next development release.`);
  const existingRc = git('tag', '--list', release);
  if (existingRc === release && git('rev-list', '-n', '1', release) !== process.env.GITHUB_SHA) {
    throw new Error(`${release} already points to a different commit.`);
  }
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${release}\n`);
  console.log(release);
}
