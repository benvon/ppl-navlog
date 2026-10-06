import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WeatherResourceEnvelope } from '../weather-resources/contracts';
import { assembleWaiterResult, waitForRefreshOwner } from './index';

afterEach(() => vi.useRealTimers());
const priorGraceResource = (): WeatherResourceEnvelope => {
  const base = Date.parse('2026-10-05T00:00:00.000Z');
  return {
    kind: 'winds', key: 'winds:us:06', rawProduct: '', forecasts: [],
    metadata: { fetchedAt: new Date(base).toISOString(), checkedAt: new Date(base).toISOString(), refreshAfter: new Date(base + 3_600_000).toISOString(), staleUntil: new Date(base + 3_720_000).toISOString() },
  };
};
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

describe('coordinator caller wait ownership', () => {
  it('aborted caller gets unavailable even while a previous resource remains in grace', async () => {
    const owner = deferred<{ result?: WeatherResourceEnvelope }>();
    const controller = new AbortController();
    const waiting = waitForRefreshOwner(owner.promise, controller.signal);
    controller.abort();
    const outcome = await waiting;
    const previous = priorGraceResource();
    expect(assembleWaiterResult(outcome, previous, Date.parse(previous.metadata.refreshAfter) + 1)).toMatchObject({ ok: false, code: 'service_unavailable' });
    owner.resolve({ result: previous });
    await owner.promise;
  });

  it('15-second caller deadline returns unavailable while owner promise remains live', async () => {
    vi.useFakeTimers();
    const owner = deferred<{ result?: WeatherResourceEnvelope }>();
    const previous = priorGraceResource();
    const waiting = waitForRefreshOwner(owner.promise);
    let settled = false;
    void waiting.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await waiting;
    expect(assembleWaiterResult(outcome, previous, Date.parse(previous.metadata.refreshAfter) + 1)).toMatchObject({ ok: false, code: 'service_unavailable' });
    owner.resolve({ result: previous });
    await expect(owner.promise).resolves.toMatchObject({ result: previous });
  });
});
