import { describe, expect, it } from 'vitest';
import { selectValidatedArtifact } from './validated-artifact.mjs';

const sha = 'a'.repeat(40);
const artifact = (attempt, overrides = {}) => ({
  name: `static-assets-12345-${attempt}`, expired: false,
  workflow_run: { head_sha: sha }, ...overrides,
});

describe('validated CI artifact selection', () => {
  it('uses the original validated artifact when only the failed deploy job reruns', () => {
    expect(selectValidatedArtifact({ runId: 12345, runAttempt: 2, sha, artifacts: [artifact(1)] }).name)
      .toBe('static-assets-12345-1');
  });

  it('uses the latest validated artifact when the entire workflow reruns', () => {
    expect(selectValidatedArtifact({ runId: 12345, runAttempt: 2, sha, artifacts: [artifact(1), artifact(2)] }).name)
      .toBe('static-assets-12345-2');
  });

  it.each([
    [artifact(3)],
    [artifact(1, { expired: true })],
    [artifact(1, { workflow_run: { head_sha: 'b'.repeat(40) } })],
    [artifact(1, { name: 'static-assets-99999-1' })],
  ])('rejects an unavailable or unrelated artifact', (...artifacts) => {
    expect(() => selectValidatedArtifact({ runId: 12345, runAttempt: 2, sha, artifacts })).toThrow(/artifact/i);
  });
});
