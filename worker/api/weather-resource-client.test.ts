import { describe, expect, it, vi } from 'vitest';
import { createWeatherResourceClient } from './weather-resource-client';
import type { CacheStore, ServiceFetcher } from './winds';

const checked = '2026-10-05T12:00:00.000Z';
const wind = { kind: 'winds', key: 'winds:us:06', metadata: { fetchedAt: checked, checkedAt: checked, refreshAfter: '2026-10-05T13:00:00.000Z', staleUntil: '2026-10-05T13:02:00.000Z' }, rawProduct: 'raw', forecasts: [{ stationId: 'ABQ', forecastCycle: '06', issuedAt: checked, validAt: checked, useFrom: checked, useUntil: '2026-10-05T14:00:00.000Z', levels: [] }] } as const;
function cache(): CacheStore & { entries: Map<string, Response> } {
  const entries = new Map<string, Response>();
  return { entries, match: async (request) => entries.get(request.url)?.clone(), put: async (request, response) => { entries.set(request.url, response.clone()); } };
}

describe('weather resource client', () => {
  it.each(['cache match', 'cache body', 'cache write', 'coordinator fetch', 'coordinator body'] as const)('bounds a hanging %s by the shared 15-second deadline', async (operation) => {
    vi.useFakeTimers();
    try {
      const never = new Promise<never>(() => undefined);
      let bodyCanceled = false;
      const hangingBody = new Response(new ReadableStream({ pull: () => never, cancel: () => { bodyCanceled = true; } }));
      let writeStarted = false;
      const hangingCache: CacheStore = {
        match: operation === 'cache match' ? () => never : async () => operation === 'cache body' ? hangingBody : undefined,
        put: operation === 'cache write' ? () => { writeStarted = true; return never; } : async () => undefined,
      };
      const fetch = operation === 'coordinator fetch'
        ? vi.fn(() => never)
        : vi.fn(async () => operation === 'coordinator body' ? hangingBody : Response.json({ ok: true, state: 'fresh', resource: wind }));
      const pending = createWeatherResourceClient({ fetch } as ServiceFetcher, hangingCache, 'production', () => new Date(checked)).getResource('winds:us:06');
      if (operation === 'cache write') {
        await expect(pending).resolves.toMatchObject({ ok: true, state: 'fresh' });
        expect(writeStarted).toBe(true);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(fetch).toHaveBeenCalledTimes(1);
        return;
      }
      const rejected = expect(pending).rejects.toMatchObject({ code: 'service_unavailable' });
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      expect(fetch).toHaveBeenCalledTimes(operation === 'coordinator fetch' || operation === 'coordinator body' ? 1 : 0);
      if (operation === 'cache body' || operation === 'coordinator body') expect(bodyCanceled).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('aborts the coordinator call and cancels a response that arrives after the deadline', async () => {
    vi.useFakeTimers();
    let resolveFetch!: (response: Response) => void;
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((request: Request) => {
      requestSignal = request.signal;
      return new Promise<Response>((resolve) => { resolveFetch = resolve; });
    });
    try {
      const pending = createWeatherResourceClient({ fetch } as ServiceFetcher, undefined, 'production', () => new Date(checked)).getResource('winds:us:06');
      const rejected = expect(pending).rejects.toMatchObject({ code: 'service_unavailable' });
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      expect(requestSignal?.aborted).toBe(true);
      const cancel = vi.fn();
      resolveFetch(new Response(new ReadableStream({ cancel })));
      await Promise.resolve();
      await Promise.resolve();
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('uses a fixed private POST request with only the resource key', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://weather-coordinator.internal/resource');
      expect(request.method).toBe('POST');
      expect(request.headers.get('content-type')).toContain('application/json');
      expect(await request.json()).toEqual({ resource: 'winds:us:06' });
      return Response.json({ ok: true, state: 'fresh', resource: wind });
    });
    const port = createWeatherResourceClient({ fetch } as ServiceFetcher, undefined, 'production', () => new Date(checked));
    await expect(port.getResource('winds:us:06')).resolves.toMatchObject({ ok: true, state: 'fresh' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('isolates edge resources by environment and bypasses the coordinator for fresh validated data', async () => {
    const edge = cache();
    const productionFetch = vi.fn(async (_request: Request) => Response.json({ ok: true, state: 'fresh', resource: wind }));
    const developmentFetch = vi.fn(async (_request: Request) => Response.json({ ok: true, state: 'fresh', resource: { ...wind, rawProduct: 'development' } }));
    const production = createWeatherResourceClient({ fetch: productionFetch } as ServiceFetcher, edge, 'production', () => new Date(checked));
    const development = createWeatherResourceClient({ fetch: developmentFetch } as ServiceFetcher, edge, 'development', () => new Date(checked));
    await production.getResource('winds:us:06');
    await production.getResource('winds:us:06');
    await development.getResource('winds:us:06');
    expect(productionFetch).toHaveBeenCalledTimes(1);
    expect(developmentFetch).toHaveBeenCalledTimes(1);
    expect(edge.entries.size).toBe(2);
  });

  it('falls through malformed or failed cache reads to coordinator and never contacts AWC directly', async () => {
    const badCache: CacheStore = { match: async () => { throw new Error('cache failure'); }, put: async () => { throw new Error('cache failure'); } };
    const fetch = vi.fn(async (_request: Request) => Response.json({ ok: true, state: 'fresh', resource: wind }));
    await createWeatherResourceClient({ fetch } as ServiceFetcher, badCache, 'production', () => new Date(checked)).getResource('winds:us:06');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).not.toContain('aviationweather.gov');
  });
});
