import { describe, expect, it } from 'vitest';
import { validateProductionCandidate } from './verify-production-candidate.mjs';

const sha = 'a'.repeat(40);
const input = {
  rcTag: 'v0.1.0-rc.42',
  ciRunId: '12345',
  repository: 'benvon/ppl-navlog',
  run: {
    id: 12345,
    run_number: 42,
    run_attempt: 2,
    event: 'push',
    head_branch: 'main',
    status: 'completed',
    conclusion: 'success',
    head_repository: { full_name: 'benvon/ppl-navlog' },
    path: '.github/workflows/ci.yml',
    head_sha: sha,
  },
  release: { tag_name: 'v0.1.0-rc.42', draft: false, prerelease: true },
  artifact: { name: 'static-assets-12345-2', expired: false, workflow_run: { head_sha: sha } },
  tagSha: sha,
  packageVersion: '0.1.0',
  productionConfig: {
    name: 'ppl-navlog',
    env: { production: {
      workers_dev: false,
      routes: [
        { pattern: 'navlog.benvon.net', custom_domain: true },
        { pattern: 'navlog.pplstudyguide.com', custom_domain: true },
      ],
      services: [{ binding: 'RUNWAY_PICKER_API', service: 'runway-picker-metar-api' }],
      ratelimits: [{ name: 'API_RATE_LIMITER' }],
    } },
  },
};

describe('production promotion candidate', () => {
  it('accepts a published RC built by the matching successful main CI attempt', () => {
    expect(validateProductionCandidate(input)).toEqual({
      rcTag: 'v0.1.0-rc.42', stableTag: 'v0.1.0', commitSha: sha, artifactName: 'static-assets-12345-2',
    });
  });

  it.each([
    [{ rcTag: 'v0.1.0-rc.0' }, /RC tag/],
    [{ ciRunId: '0' }, /run ID/],
    [{ run: { ...input.run, event: 'pull_request' } }, /successful main/],
    [{ run: { ...input.run, conclusion: 'failure' } }, /successful main/],
    [{ run: { ...input.run, head_sha: 'b'.repeat(40) } }, /same commit/],
    [{ release: { ...input.release, prerelease: false } }, /prerelease/],
    [{ artifact: { ...input.artifact, name: 'static-assets-12345-1' } }, /artifact/],
    [{ artifact: { ...input.artifact, expired: true } }, /artifact/],
    [{ stableTagSha: 'b'.repeat(40) }, /another commit/],
    [{ productionConfig: { name: 'ppl-navlog', env: { production: { routes: [] } } } }, /two-domain/],
  ])('rejects an invalid promotion source', (change, error) => {
    expect(() => validateProductionCandidate({ ...input, ...change })).toThrow(error);
  });
});
