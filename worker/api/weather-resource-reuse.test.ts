import { describe, expect, it, vi } from 'vitest';
import { createWeatherResourceClient } from './weather-resource-client';
import type { CacheStore, ServiceFetcher } from './winds';
import { createSharedWeatherResourceStore } from './weather-resource-store';
import type { WeatherResourceEnvelope, WeatherResourceResult } from '../weather-resources/contracts';

const NOW = '2026-10-06T12:00:00.000Z';
const FETCHED = '2026-10-06T06:00:00.000Z';
const STATION_FORECAST = {
  stationId: 'AAA', forecastCycle: '06' as const, issuedAt: '2026-10-06T06:00:00.000Z',
  validAt: NOW, useFrom: '2026-10-06T11:00:00.000Z', useUntil: '2026-10-06T17:00:00.000Z',
  levels: []
};

function windResource(options: { checkedAt?: string; fetchedAt?: string; rawProduct?: string } = {}): Extract<WeatherResourceEnvelope, { kind: 'winds' }> {
  const checkedAt = options.checkedAt ?? NOW;
  const fetchedAt = options.fetchedAt ?? FETCHED;
  const checkedMs = Date.parse(checkedAt);
  return {
    kind: 'winds', key: 'winds:us:06',
    metadata: {
      fetchedAt, checkedAt,
      refreshAfter: new Date(checkedMs + 60 * 60_000).toISOString(),
      staleUntil: new Date(checkedMs + 62 * 60_000).toISOString()
    },
    rawProduct: options.rawProduct ?? 'synthetic validated product',
    forecasts: [{ ...STATION_FORECAST, issuedAt: checkedAt, validAt: checkedAt }]
  };
}

function success(resource: WeatherResourceEnvelope, state: 'fresh' | 'grace' = 'fresh'): Response {
  return Response.json({ ok: true, state, resource } satisfies WeatherResourceResult);
}

function makeCache(match: () => Promise<Response | undefined>): CacheStore & { put: ReturnType<typeof vi.fn> } {
  return { match, put: vi.fn(async () => undefined) };
}

function coordinatorFor(resource: WeatherResourceEnvelope, state: 'fresh' | 'grace' = 'fresh'): ServiceFetcher & { fetch: ReturnType<typeof vi.fn> } {
  return { fetch: vi.fn(async () => success(resource, state)) };
}

function client(fetcher: ServiceFetcher, store = createSharedWeatherResourceStore(), cache?: CacheStore, now: () => Date = () => new Date(NOW)) {
  return { store, port: createWeatherResourceClient(fetcher, cache, 'production', now, undefined, store) };
}

describe('shared weather resource reuse', () => {
  it('does not serve retained data at the fresh-to-grace boundary when the coordinator fails', async () => {
    let current = NOW;
    const resource = windResource();
    const store = createSharedWeatherResourceStore();
    store.publish('production', resource, new Date(current));
    current = resource.metadata.refreshAfter;
    const fetcher: ServiceFetcher = {
      fetch: vi.fn(async () => Response.json({
        ok: false, code: 'upstream_unavailable', retryAt: '2026-10-06T13:03:00.000Z'
      } satisfies WeatherResourceResult, { status: 503 }))
    };
    const port = createWeatherResourceClient(fetcher, undefined, 'production', () => new Date(current), undefined, store);

    await expect(port.getResource('winds:us:06')).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(store.get('production', 'winds:us:06', new Date(current))).toBeUndefined();
    await expect(port.getResource('winds:us:06')).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(fetcher.fetch).toHaveBeenCalledTimes(2);
    expect(store.snapshot('production').entries).toBe(1);
  });

  it('returns coordinator grace data without retaining it and rechecks the coordinator next time', async () => {
    const now = '2026-10-06T12:00:00.000Z';
    const inGrace = windResource({ checkedAt: '2026-10-06T10:59:00.000Z' });
    const fetcher = coordinatorFor(inGrace, 'grace');
    const { port, store } = client(fetcher, createSharedWeatherResourceStore(), undefined, () => new Date(now));

    await expect(port.getResource('winds:us:06')).resolves.toMatchObject({ ok: true, state: 'grace', source: 'coordinator' });
    await expect(port.getResource('winds:us:06')).resolves.toMatchObject({ ok: true, state: 'grace', source: 'coordinator' });
    expect(fetcher.fetch).toHaveBeenCalledTimes(2);
    expect(store.snapshot('production')).toEqual({ entries: 0, retainedBytes: 0 });
  });

  it('serves a valid over-cap winds envelope for the request but does not retain it', async () => {
    const oversized = windResource({ rawProduct: 'x'.repeat(600 * 1024) });
    const fetcher = coordinatorFor(oversized);
    const { port, store } = client(fetcher, createSharedWeatherResourceStore(), undefined, () => new Date(NOW));

    await expect(port.getResource('winds:us:06')).resolves.toMatchObject({ ok: true, state: 'fresh', resource: { rawProduct: oversized.rawProduct } });
    await expect(port.getResource('winds:us:06')).resolves.toMatchObject({ ok: true, state: 'fresh' });
    expect(fetcher.fetch).toHaveBeenCalledTimes(2);
    expect(store.snapshot('production')).toEqual({ entries: 0, retainedBytes: 0 });
  });

  it.each([
    ['malformed JSON', async () => new Response('{not-json')],
    ['invalid envelope schema', async () => Response.json({ ok: true, state: 'fresh', resource: windResource() })]
  ])('falls back from %s and retains only the valid coordinator envelope', async (_label, edgeResponse) => {
    const resource = windResource();
    const cache = makeCache(async () => (await edgeResponse()).clone());
    const fetcher = coordinatorFor(resource);
    const { port, store } = client(fetcher, createSharedWeatherResourceStore(), cache, () => new Date(NOW));

    await expect(port.getResource('winds:us:06')).resolves.toMatchObject({ ok: true, state: 'fresh', source: 'coordinator' });
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    expect(store.snapshot('production').entries).toBe(1);
  });

  it('keeps the newer check when independent cold loads complete out of order', async () => {
    const older = windResource({ checkedAt: '2026-10-06T11:58:00.000Z', fetchedAt: FETCHED, rawProduct: 'older check' });
    const newer = windResource({ checkedAt: '2026-10-06T11:59:00.000Z', fetchedAt: FETCHED, rawProduct: 'newer check' });
    const deferred: Array<(response: Response) => void> = [];
    const fetcher: ServiceFetcher = {
      fetch: vi.fn(() => new Promise<Response>((resolve) => { deferred.push(resolve); }))
    };
    const store = createSharedWeatherResourceStore();
    const olderClient = client(fetcher, store, undefined, () => new Date(NOW)).port;
    const newerClient = client(fetcher, store, undefined, () => new Date(NOW)).port;
    const olderLoad = olderClient.getResource('winds:us:06');
    const newerLoad = newerClient.getResource('winds:us:06');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deferred).toHaveLength(2);

    deferred[1]!(success(newer));
    await newerLoad;
    deferred[0]!(success(older));
    await olderLoad;

    expect(store.get('production', 'winds:us:06', new Date(NOW))?.metadata).toMatchObject({
      fetchedAt: FETCHED, checkedAt: newer.metadata.checkedAt
    });
  });
});
