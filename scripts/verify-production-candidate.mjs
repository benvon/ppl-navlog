import { appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const stableSemver = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)';
const stablePattern = new RegExp(`^v${stableSemver}$`);

export function validateProductionCandidate({ stableTag, rcTag, repository, run, release, artifact, tagSha, packageVersion, productionConfig }) {
  if (!stablePattern.test(stableTag ?? '')) throw new Error('Production tag must be stable vX.Y.Z.');
  const runNumber = run?.run_number;
  if (!Number.isSafeInteger(runNumber) || runNumber < 1 || rcTag !== `${stableTag}-rc.${runNumber}`) {
    throw new Error('RC tag must match the successful CI run number.');
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Repository is invalid.');
  if (packageVersion !== stableTag.slice(1)) throw new Error('Stable tag differs from the tagged package version.');
  if (release?.tag_name !== rcTag || release?.draft !== false || release?.prerelease !== true) throw new Error('RC must have a published GitHub prerelease.');
  if (!Number.isSafeInteger(run?.id) || run.id < 1 || run?.event !== 'push' || run?.head_branch !== 'main' || run?.status !== 'completed' || run?.conclusion !== 'success' || run?.head_repository?.full_name !== repository || run?.path !== '.github/workflows/ci.yml') {
    throw new Error('CI run is not a successful main-branch release-candidate run.');
  }
  if (!/^[a-f0-9]{40}$/.test(tagSha ?? '') || run.head_sha !== tagSha) throw new Error('Stable tag and CI run do not identify the same commit.');
  const routes = productionConfig?.env?.production?.routes;
  if (productionConfig?.name !== 'ppl-navlog' || productionConfig?.env?.production?.workers_dev !== false || !Array.isArray(routes) || routes.length !== 2 || !['navlog.benvon.net', 'navlog.pplstudyguide.com'].every((pattern) => routes.some((route) => route.pattern === pattern && route.custom_domain === true)) || !productionConfig.env.production.services?.some((service) => service.binding === 'RUNWAY_PICKER_API' && service.service === 'runway-picker-metar-api') || !productionConfig.env.production.ratelimits?.some((limit) => limit.name === 'API_RATE_LIMITER')) {
    throw new Error('Tagged commit lacks the required two-domain production Worker configuration.');
  }
  const artifactName = `static-assets-${run.id}-${run.run_attempt}`;
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 || artifact?.name !== artifactName || artifact?.expired !== false || artifact?.workflow_run?.head_sha !== tagSha) {
    throw new Error('Validated artifact from the successful CI attempt is unavailable.');
  }
  return { stableTag, rcTag, commitSha: tagSha, ciRunId: run.id, artifactName };
}

if (process.argv[1]?.endsWith('/verify-production-candidate.mjs')) {
  const stableTag = process.env.STABLE_TAG;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!stablePattern.test(stableTag ?? '') || process.env.GITHUB_REF !== `refs/tags/${stableTag}` || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) {
    throw new Error('Invalid production tag or repository.');
  }
  const gh = (endpoint) => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8' }));
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const tagSha = git('rev-parse', `refs/tags/${stableTag}^{commit}`);
  execFileSync('git', ['merge-base', '--is-ancestor', tagSha, 'origin/main']);
  const packageVersion = JSON.parse(git('show', `${tagSha}:package.json`)).version;
  const productionConfig = JSON.parse(git('show', `${tagSha}:wrangler.jsonc`));
  const runs = gh(`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${tagSha}&event=push&branch=main&per_page=100`);
  if (runs.total_count > 100) throw new Error('Too many CI runs for this commit to select safely.');
  const candidates = runs.workflow_runs.filter((run) => Number.isSafeInteger(run.run_number) && run.run_number > 0 && run.conclusion === 'success').sort((a, b) => b.run_number - a.run_number);
  let result;
  for (const run of candidates) {
    const rcTag = `${stableTag}-rc.${run.run_number}`;
    if (git('tag', '--list', rcTag) !== rcTag || git('rev-parse', `refs/tags/${rcTag}^{commit}`) !== tagSha) continue;
    const release = gh(`repos/${repository}/releases/tags/${rcTag}`);
    const artifactName = `static-assets-${run.id}-${run.run_attempt}`;
    const artifacts = gh(`repos/${repository}/actions/runs/${run.id}/artifacts?name=${artifactName}&per_page=100`).artifacts;
    const artifact = artifacts?.find((item) => item.name === artifactName);
    result = validateProductionCandidate({ stableTag, rcTag, repository, run, release, artifact, tagSha, packageVersion, productionConfig });
    break;
  }
  if (!result) throw new Error('Stable tag must point to a successful published RC on main.');
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required in the promotion workflow.');
  await appendFile(process.env.GITHUB_OUTPUT, `stable_tag=${result.stableTag}\nrc_tag=${result.rcTag}\ncommit_sha=${result.commitSha}\nci_run_id=${result.ciRunId}\nartifact_name=${result.artifactName}\n`);
  console.log(`Verified ${result.stableTag} from ${result.rcTag} and successful CI run ${result.ciRunId}.`);
}
