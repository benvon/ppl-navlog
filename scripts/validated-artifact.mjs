import { appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

/** Select the newest artifact actually uploaded by validation, even after a failed-jobs-only rerun. */
export function selectValidatedArtifact({ runId, runAttempt, sha, artifacts }) {
  if (!Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(runAttempt) || runAttempt < 1 ||
      !/^[a-f0-9]{40}$/.test(sha ?? '') || !Array.isArray(artifacts)) {
    throw new Error('Validated artifact selection received invalid CI identity.');
  }
  const prefix = `static-assets-${runId}-`;
  const matches = artifacts.flatMap((artifact) => {
    if (typeof artifact?.name !== 'string' || !artifact.name.startsWith(prefix) || artifact.expired !== false ||
        artifact.workflow_run?.head_sha !== sha) return [];
    const suffix = artifact.name.slice(prefix.length);
    if (!/^[1-9]\d*$/.test(suffix)) return [];
    const attempt = Number(suffix);
    return Number.isSafeInteger(attempt) && attempt <= runAttempt ? [{ artifact, attempt }] : [];
  }).sort((a, b) => b.attempt - a.attempt);
  if (!matches[0]) throw new Error('Validated artifact from this CI run is unavailable.');
  return matches[0].artifact;
}

if (process.argv[1]?.endsWith('/validated-artifact.mjs')) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Repository is invalid.');
  const runId = Number(process.env.GITHUB_RUN_ID);
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const sha = process.env.GITHUB_SHA;
  if (!Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(runAttempt) || runAttempt < 1 ||
      !/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('CI run identity is invalid.');
  const response = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`], { encoding: 'utf8' }));
  if (!Number.isSafeInteger(response.total_count) || response.total_count > 100) throw new Error('CI artifact listing is incomplete.');
  const artifact = selectValidatedArtifact({ runId, runAttempt, sha, artifacts: response.artifacts });
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required in the deployment workflow.');
  await appendFile(process.env.GITHUB_OUTPUT, `name=${artifact.name}\n`);
  console.log(`Selected validated artifact ${artifact.name}.`);
}
