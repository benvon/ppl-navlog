import { spawnSync } from 'node:child_process';

const result = spawnSync('npm', ['audit', '--audit-level=high'], { encoding: 'utf8', shell: false });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');

if (result.status === 0) {
  process.exit(0);
}

const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
const networkFailure = /EAI_AGAIN|ENOTFOUND|network|audit endpoint returned an error/i.test(output);
if (process.env.CI !== 'true' && networkFailure) {
  console.warn('npm audit could not reach the registry; skipping local network failure.');
  process.exit(0);
}

process.exit(result.status ?? 1);
