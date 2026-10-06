import { describe, expect, it, vi } from 'vitest';
import { errorResponse } from './response';

const payload = { error: 'Weather data is temporarily unavailable.', code: 'upstream_unavailable' as const, requestId: 'e531d3ef-89b8-4cbe-a7e9-c42c7fad7de5' };

describe('safe Retry-After responses', () => {
  it('converts a typed retry deadline to positive seconds and caps extreme values', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-05T12:00:00.000Z'));
    expect(errorResponse(payload, 503, Date.now() + 1_100).headers.get('Retry-After')).toBe('2');
    expect(errorResponse(payload, 503, Date.now() + 99 * 24 * 60 * 60_000).headers.get('Retry-After')).toBe('86400');
    vi.useRealTimers();
  });

  it('omits invalid, expired, and client-error retry deadlines', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-05T12:00:00.000Z'));
    expect(errorResponse(payload, 503, Number.NaN).headers.has('Retry-After')).toBe(false);
    expect(errorResponse(payload, 503, Date.now()).headers.has('Retry-After')).toBe(false);
    expect(errorResponse(payload, 429, Date.now() + 60_000).headers.has('Retry-After')).toBe(false);
    vi.useRealTimers();
  });
});
