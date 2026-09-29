import { appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const stableSemver = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)';
const rcPattern = new RegExp(`^(v${stableSemver})-rc\\.([1-9]\\d*)$`);

export function validateProductionCandidate({ rcTag, ciRunId, repository, run, release, artifact, tagSha, packageVersion, productionConfig, stableTagSha }) {
  const match = rcPattern.exec(rcTag ?? '');
  if (!match) throw new Error('RC tag must be vX.Y.Z-rc.N.');
  if (!/^[1-9]\d*$/.test(ciRunId ?? '')) throw new Error('CI run ID must be a positive integer.');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Repository is invalid.');
  const [ , stableTag, runNumber ] = match;
  if (packageVersion !== stableTag.slice(1)) throw new Error('RC version differs from the tagged package version.');
  if (release?.tag_name !== rcTag || release?.draft !== false || release?.prerelease !== true) throw new Error('RC must have a published GitHub prerelease.');
  if (run?.id !== Number(ciRunId) || run?.run_number !== Number(runNumber) || run?.event !== 'push' || run?.head_branch !== 'main' || run?.status !== 'completed' || run?.conclusion !== 'success' || run?.head_repository?.full_name !== repository || run?.path !== '.github/workflows/ci.yml') {
    throw new Error('CI run is not the successful main-branch release-candidate run.');
  }
  if (!/^[a-f0-9]{40}$/.test(tagSha ?? '') || run.head_sha !== tagSha) throw new Error('RC tag and CI run do not identify the same commit.');
  if (stableTagSha && stableTagSha !== tagSha) throw new Error('Stable tag already identifies another commit.');
  const routes = productionConfig?.env?.production?.routes;
  if (productionConfig?.name !== 'ppl-navlog' || productionConfig?.env?.production?.workers_dev !== false || !Array.isArray(routes) || routes.length !== 2 || !['navlog.benvon.net', 'navlog.pplstudyguide.com'].every((pattern) => routes.some((route) => route.pattern === pattern && route.custom_domain === true)) || !productionConfig.env.production.services?.some((service) => service.binding === 'RUNWAY_PICKER_API' && service.service === 'runway-picker-metar-api') || !productionConfig.env.production.ratelimits?.some((limit) => limit.name === 'API_RATE_LIMITER')) {
    throw new Error('Tagged commit lacks the required two-domain production Worker configuration.');
  }
  const artifactName = `static-assets-${ciRunId}-${run.run_attempt}`;
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 || artifact?.name !== artifactName || artifact?.expired !== false || artifact?.workflow_run?.head_sha !== tagSha) {
    throw new Error('Validated artifact from the successful CI attempt is unavailable.');
  }
  return { rcTag, stableTag, commitSha: tagSha, artifactName };
}

if (process.argv[1]?.endsWith('/verify-production-candidate.mjs')) {
  const rcTag = process.env.RC_TAG;
  const ciRunId = process.env.CI_RUN_ID;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!rcPattern.test(rcTag ?? '') || !/^[1-9]\d*$/.test(ciRunId ?? '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) {
    throw new Error('Invalid production promotion input.');
  }
  const gh = (endpoint) => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8' }));
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const run = gh(`repos/${repository}/actions/runs/${ciRunId}`);
  const release = gh(`repos/${repository}/releases/tags/${rcTag}`);
  const tagSha = git('rev-parse', `refs/tags/${rcTag}^{commit}`);
  const packageVersion = JSON.parse(git('show', `${tagSha}:package.json`)).version;
  const productionConfig = JSON.parse(git('show', `${tagSha}:wrangler.jsonc`));
  const stableTag = rcPattern.exec(rcTag)[1];
  const stableTagSha = git('tag', '--list', stableTag) === stableTag ? git('rev-parse', `refs/tags/${stableTag}^{commit}`) : undefined;
  const artifactName = `static-assets-${ciRunId}-${run.run_attempt}`;
  const artifacts = gh(`repos/${repository}/actions/runs/${ciRunId}/artifacts?name=${artifactName}&per_page=100`).artifacts;
  const artifact = artifacts?.find((item) => item.name === artifactName);
  const result = validateProductionCandidate({ rcTag, ciRunId, repository, run, release, artifact, tagSha, packageVersion, productionConfig, stableTagSha });
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required in the promotion workflow.');
  await appendFile(process.env.GITHUB_OUTPUT, `rc_tag=${result.rcTag}\nstable_tag=${result.stableTag}\ncommit_sha=${result.commitSha}\nartifact_name=${result.artifactName}\n`);
  console.log(`Verified ${result.rcTag} from successful CI run ${ciRunId}.`);
}
