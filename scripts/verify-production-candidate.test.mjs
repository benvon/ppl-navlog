import { describe, expect, it } from 'vitest';
import { validateProductionCandidate } from './verify-production-candidate.mjs';

const sha = 'a'.repeat(40);
const input = {
  stableTag: 'v0.1.0',
  devTag: 'dev-42',
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
  release: { tag_name: 'dev-42', draft: false, prerelease: true },
  artifacts: [{ name: 'static-assets-12345-1', expired: false, workflow_run: { head_sha: sha } }],
  tagSha: sha,
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
  it('accepts a stable tag on a published development build from successful main CI', () => {
    expect(validateProductionCandidate(input)).toEqual({
      stableTag: 'v0.1.0', devTag: 'dev-42', commitSha: sha, ciRunId: 12345, artifactName: 'static-assets-12345-1',
    });
  });

  it('keeps stable release SemVer independent of the development build ID', () => {
    const result = validateProductionCandidate({ ...input, stableTag: 'v7.8.9' });
    expect(result.stableTag).toBe('v7.8.9');
    expect(result.devTag).toBe('dev-42');
  });

  it.each([
    [{ stableTag: 'v0.1.0-rc.42' }, /stable/],
    [{ devTag: 'dev-43' }, /run number/],
    [{ run: { ...input.run, event: 'pull_request' } }, /successful main/],
    [{ run: { ...input.run, conclusion: 'failure' } }, /successful main/],
    [{ run: { ...input.run, head_sha: 'b'.repeat(40) } }, /same commit/],
    [{ release: { ...input.release, prerelease: false } }, /prerelease/],
    [{ artifacts: [{ ...input.artifacts[0], name: 'static-assets-12345-3' }] }, /artifact/],
    [{ artifacts: [{ ...input.artifacts[0], expired: true }] }, /artifact/],
    [{ productionConfig: { name: 'ppl-navlog', env: { production: { routes: [] } } } }, /two-domain/],
  ])('rejects an invalid stable-tag promotion source', (change, error) => {
    expect(() => validateProductionCandidate({ ...input, ...change })).toThrow(error);
  });
});
