import { describe, expect, it } from 'vitest';
import { rcVersion } from './rc-version.mjs';

describe('release candidate version', () => {
  it('uses the stable package version and unique workflow run number', () => {
    expect(rcVersion('0.1.0', '42')).toBe('v0.1.0-rc.42');
  });

  it('rejects invalid versions and run numbers', () => {
    expect(() => rcVersion('0.1.0-rc.1', '42')).toThrow();
    expect(() => rcVersion('0.1.0', '0')).toThrow();
    expect(() => rcVersion('0.1.0', '1;echo x')).toThrow();
  });
});
