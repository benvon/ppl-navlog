import { describe, expect, it } from 'vitest';
import { budgetDecision, parseRetryAfter, resourceEligibility } from './policy';
import type { BudgetAttempt, WeatherCheckMetadata, WeatherResourceKey } from './contracts';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const metadata = (refreshAfterMs: number, staleUntilMs: number): WeatherCheckMetadata => ({ fetchedAt: new Date(NOW - 1_000).toISOString(), checkedAt: new Date(NOW - 1_000).toISOString(), refreshAfter: new Date(refreshAfterMs).toISOString(), staleUntil: new Date(staleUntilMs).toISOString() });
const attempts = (key: WeatherResourceKey, times: number[]): BudgetAttempt[] => times.map((attemptedAtMs) => ({ key, attemptedAtMs }));

describe('weather resource policy', () => {
  it('eligibility_has_fixed_exclusive_grace_end', () => {
    const dueAt = NOW;
    const value = metadata(dueAt, dueAt + 120_000);
    expect(resourceEligibility(value, dueAt - 1)).toBe('fresh');
    expect(resourceEligibility(value, dueAt)).toBe('grace');
    expect(resourceEligibility(value, dueAt + 119_999)).toBe('grace');
    expect(resourceEligibility(value, dueAt + 120_000)).toBe('expired');
  });

  it('rolling_windows_do_not_reset_at_clock_boundaries', () => {
    const key: WeatherResourceKey = 'winds:us:06';
    const perKey = attempts(key, Array.from({ length: 8 }, (_, i) => NOW - 6 * 60 * 60_000 + 1 + i));
    expect(budgetDecision(key, perKey, NOW)).toEqual({ allowed: false, retryAtMs: perKey[0]!.attemptedAtMs + 6 * 60 * 60_000 });
    expect(budgetDecision(key, perKey, perKey[0]!.attemptedAtMs + 6 * 60 * 60_000)).toEqual({ allowed: true });
    const threeKeys: WeatherResourceKey[] = ['winds:us:06', 'winds:us:12', 'winds:us:24'];
    const minute = threeKeys.flatMap((value, keyIndex) => attempts(value, Array.from({ length: keyIndex === 2 ? 6 : 7 }, (_, i) => NOW - 59_000 + i * 2_000 + keyIndex * 10_000)));
    expect(budgetDecision(key, minute, NOW)).toEqual({ allowed: false, retryAtMs: minute.reduce((a, b) => a.attemptedAtMs < b.attemptedAtMs ? a : b).attemptedAtMs + 60_000 });
    const validKeys: WeatherResourceKey[] = ['winds:us:06', 'winds:us:12', 'winds:us:24', 'winds:alaska:06', 'winds:alaska:12', 'winds:alaska:24', 'winds:hawaii:06', 'winds:hawaii:12', 'winds:hawaii:24', 'station-catalog:v1'];
    const threeHundredAttempts = Array.from({ length: 300 }, (_, index) => ({ key: validKeys[index % validKeys.length]!, attemptedAtMs: NOW - 24 * 60 * 60_000 + 1 + index * 280_000 }));
    expect(budgetDecision(key, threeHundredAttempts, NOW)).toEqual({ allowed: false, retryAtMs: threeHundredAttempts.reduce((a, b) => a.attemptedAtMs < b.attemptedAtMs ? a : b).attemptedAtMs + 24 * 60 * 60_000 });
  });

  it('catalog_and_winds_limits_are_independent', () => {
    const catalog: WeatherResourceKey = 'station-catalog:v1';
    const winds: WeatherResourceKey = 'winds:us:06';
    expect(budgetDecision(catalog, attempts(catalog, [NOW - 1, NOW - 2, NOW - 3, NOW - 4]), NOW)).toEqual({ allowed: false, retryAtMs: NOW - 4 + 24 * 60 * 60_000 });
    expect(budgetDecision(winds, attempts(catalog, [NOW - 1, NOW - 2, NOW - 3, NOW - 4]), NOW)).toEqual({ allowed: true });
    const keys: WeatherResourceKey[] = ['winds:us:06', 'winds:us:12', 'winds:us:24', 'winds:alaska:06', 'winds:alaska:12', 'winds:alaska:24', 'winds:hawaii:06', 'winds:hawaii:12', 'winds:hawaii:24'];
    const dailyWinds: BudgetAttempt[] = [];
    keys.forEach((key, keyIndex) => {
      for (let cluster = 0; cluster < 4; cluster += 1) {
        for (let attempt = 0; attempt < 8; attempt += 1) dailyWinds.push({ key, attemptedAtMs: NOW - 23 * 60 * 60_000 + cluster * (6 * 60 * 60_000 + 4 * 60_000) + attempt * 30_000 + keyIndex * 1_000 });
      }
    });
    expect(dailyWinds).toHaveLength(288);
    const perKeyLastWindowStart = NOW - 23 * 60 * 60_000 + 3 * (6 * 60 * 60_000 + 4 * 60_000);
    expect(budgetDecision('winds:us:06', attempts('winds:us:06', dailyWinds.filter((attempt) => attempt.key === 'winds:us:06').map((attempt) => attempt.attemptedAtMs)), NOW)).toEqual({ allowed: false, retryAtMs: perKeyLastWindowStart + 6 * 60 * 60_000 });
    // The 288 wind cap is reached alongside all nine per-key 32/day caps; overall 300/day remains below its redundant ceiling.
    expect(budgetDecision(winds, dailyWinds, NOW)).toEqual({ allowed: false, retryAtMs: perKeyLastWindowStart + 6 * 60 * 60_000 });
  });

  it('retry_after_never_shortens_provider_delay', () => {
    expect(parseRetryAfter('30', NOW)).toBe(NOW + 60_000);
    expect(parseRetryAfter(null, NOW)).toBe(NOW + 60_000);
    expect(parseRetryAfter('120', NOW)).toBe(NOW + 120_000);
    expect(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(NOW + 90_000);
    expect(parseRetryAfter('-1', NOW)).toBe(NOW + 60_000);
    expect(parseRetryAfter('bogus', NOW)).toBe(NOW + 60_000);
    expect(parseRetryAfter('999999999999999999999999999', NOW)).toBe('operator_required');
    expect(parseRetryAfter('8640000000000', NOW)).toBe('operator_required');
    expect(parseRetryAfter(null, Number.MAX_SAFE_INTEGER - 10)).toBe('operator_required');
    expect(parseRetryAfter(null, 8_640_000_000_000_000)).toBe('operator_required');
  });
});
