import type { BudgetAttempt, BudgetDecision, WeatherCheckMetadata, WeatherResourceKey } from './contracts';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GRACE_MS = 120_000;
const isDateRepresentable = (timestamp: number): boolean => Number.isFinite(new Date(timestamp).getTime());
export function resourceEligibility(metadata: WeatherCheckMetadata, nowMs: number): 'fresh' | 'grace' | 'expired' {
  const refreshAfter = Date.parse(metadata.refreshAfter);
  const staleUntil = Date.parse(metadata.staleUntil);
  if (!Number.isFinite(nowMs) || !Number.isFinite(refreshAfter) || !Number.isFinite(staleUntil) || staleUntil - refreshAfter !== GRACE_MS) return 'expired';
  if (nowMs < refreshAfter) return 'fresh';
  if (nowMs < staleUntil) return 'grace';
  return 'expired';
}
function policy(key: WeatherResourceKey): Array<{ limit: number; windowMs: number; matches: (attempt: BudgetAttempt) => boolean }> {
  const winds = key.startsWith('winds:');
  const sameKey = (attempt: BudgetAttempt): boolean => attempt.key === key;
  return [
    { limit: 20, windowMs: MINUTE, matches: () => true },
    { limit: 300, windowMs: DAY, matches: () => true },
    ...(winds ? [
      { limit: 288, windowMs: DAY, matches: (attempt: BudgetAttempt) => attempt.key.startsWith('winds:') },
      { limit: 8, windowMs: 6 * HOUR, matches: sameKey },
      { limit: 32, windowMs: DAY, matches: sameKey },
    ] : [{ limit: 4, windowMs: DAY, matches: sameKey }]),
  ];
}
export function budgetDecision(key: WeatherResourceKey, attempts: readonly BudgetAttempt[], nowMs: number): BudgetDecision {
  if (!Number.isFinite(nowMs)) return { allowed: false, retryAtMs: Number.MAX_SAFE_INTEGER };
  const deadlines: number[] = [];
  for (const rule of policy(key)) {
    const relevant = attempts.filter((attempt) => rule.matches(attempt) && Number.isFinite(attempt.attemptedAtMs) && attempt.attemptedAtMs > nowMs - rule.windowMs && attempt.attemptedAtMs <= nowMs).sort((a, b) => a.attemptedAtMs - b.attemptedAtMs);
    if (relevant.length >= rule.limit) deadlines.push(relevant[relevant.length - rule.limit]!.attemptedAtMs + rule.windowMs);
  }
  return deadlines.length ? { allowed: false, retryAtMs: Math.max(...deadlines) } : { allowed: true };
}
function retryAfterTimestamp(value: string, nowMs: number): number | 'default' | 'operator_required' {
  if (/^\d+$/.test(value.trim())) {
    const seconds = Number(value.trim());
    if (!Number.isSafeInteger(seconds) || seconds > Math.floor((Number.MAX_SAFE_INTEGER - nowMs) / 1_000)) return 'operator_required';
    const requested = nowMs + seconds * 1_000;
    return isDateRepresentable(requested) ? requested : 'operator_required';
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 'default';
}
export function parseRetryAfter(value: string | null, nowMs: number): number | 'operator_required' {
  const fallback = nowMs + MINUTE;
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(fallback) || !isDateRepresentable(nowMs) || !isDateRepresentable(fallback)) return 'operator_required';
  if (value === null) return fallback;
  const requested = retryAfterTimestamp(value, nowMs);
  if (requested === 'operator_required') return requested;
  const effectiveDeadline = requested === 'default' ? fallback : Math.max(fallback, requested);
  return isDateRepresentable(effectiveDeadline) ? effectiveDeadline : 'operator_required';
}
