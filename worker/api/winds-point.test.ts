import { describe, expect, it } from 'vitest';
import { parseApiRoute } from './request';
import { ApiError } from './errors';
import { createAviationWeatherAdapter, type CacheStore, type ServiceFetcher } from './winds';

const url = '/api/weather/winds/point?lat=42.6&lon=-89&altitudeFeetMsl=4500&plannedUtc=2026-09-22T01%3A00%3A00.000Z';

const FIXED_NOW = new Date('2026-09-21T18:30:00.000Z');
const product = `000\nFBUS31 KWNO 212000\nFD1US1\nDATA BASED ON 211800Z\nVALID 220000Z   FOR USE 2000-0300Z. TEMPS NEG ABV 24000\n\nFT  3000    6000    9000   12000\nABQ 35203520+15 3520+10 3520+05\nATL 01200120+15 0120+10 0120+05\n`;
const catalog = [
  { iataId: 'ABQ', faaId: 'ABQ', icaoId: 'KABQ', site: 'Station A', lat: 42.5, lon: -89, elev: 0 },
  { iataId: 'ATL', faaId: 'ATL', icaoId: 'KATL', site: 'Station B', lat: 42.7, lon: -89, elev: 0 }
];

async function catalogResponse(): Promise<Response> {
  const bytes = new TextEncoder().encode(JSON.stringify(catalog));
  const input = new ReadableStream<BufferSource>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  return new Response(await new Response(input.pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
function cache(): CacheStore {
  const entries = new Map<string, Response>();
  return { async match(request) { return entries.get(request.url)?.clone(); }, async put(request, response) { entries.set(request.url, response.clone()); } };
}
function adapterFor(overrides: { product?: (cycle: string) => Promise<Response>; failedCycle?: string; upstreamState?: { fail: boolean }; current?: () => Date } = {}) {
  const upstream: ServiceFetcher = { async fetch(request) {
    const parsed = new URL(request.url);
    if (parsed.pathname.endsWith('/windtemp')) {
      const cycle = parsed.searchParams.get('fcst') ?? '06';
      if (cycle === overrides.failedCycle || overrides.upstreamState?.fail) throw new Error('unavailable');
      return overrides.product ? overrides.product(cycle) : new Response(product);
    }
    if (parsed.pathname.endsWith('.gz')) return catalogResponse();
    return new Response(null, { status: 404 });
  } };
  return createAviationWeatherAdapter(upstream, cache(), overrides.current ?? (() => FIXED_NOW));
}

describe('winds point request', () => {
  it('parses one canonical point query', () => {
    expect(parseApiRoute(new Request(`https://navlog.test${url}`))).toEqual({ kind: 'winds-point', latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 4500, plannedUtc: '2026-09-22T01:00:00.000Z' });
  });

  it.each([
    `${url}&lat=43`, `${url}&extra=1`, url.replace('2026-09-22T01%3A00%3A00.000Z', '2026-02-30T01%3A00%3A00.000Z'),
    url.replace('lat=42.6', 'lat=90.1'), url.replace('altitudeFeetMsl=4500', 'altitudeFeetMsl=5000.5'),
    `${url}&${'x'.repeat(520)}`
  ])('rejects invalid or oversized query: %s', (path) => {
    expect(() => parseApiRoute(new Request(`https://navlog.test${path}`))).toThrow(ApiError);
  });

  it('interpolates wind in vector components across north and returns bounded vertical evidence', async () => {
    const answer = await adapterFor().getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 7500, plannedUtc: '2026-09-22T01:00:00.000Z' });
    expect(answer.windFromDegTrue).toBeCloseTo(0, 0);
    expect(answer.windSpeedKt).toBeGreaterThan(19);
    expect(answer.temperatureC).toBe(12.5);
    expect(answer.sources).toHaveLength(2);
    expect(answer.sources.reduce((sum, source) => sum + source.horizontalWeight, 0)).toBeCloseTo(1);
    expect(answer.sources[0]).toMatchObject({ lowerAltitudeFeet: 6000, upperAltitudeFeet: 9000, verticalWeight: 0.5 });
    expect(answer.useFrom <= answer.query.plannedUtc && answer.query.plannedUtc < answer.useUntil).toBe(true);
  });

  it('returns different same-altitude winds at distinct nearby route points', async () => {
    const adapter = adapterFor();
    const departure = await adapter.getWindsPoint({ latitudeDeg: 42.51, longitudeDeg: -89, altitudeFeetMsl: 7500, plannedUtc: '2026-09-22T01:00:00.000Z' });
    const destination = await adapter.getWindsPoint({ latitudeDeg: 42.69, longitudeDeg: -89, altitudeFeetMsl: 7500, plannedUtc: '2026-09-22T01:00:00.000Z' });
    expect(departure.windFromDegTrue).toBeGreaterThan(330);
    expect(destination.windFromDegTrue).toBeLessThan(30);
  });

  it('rejects unavailable cycles, out-of-coverage points, unsupported altitude, and stale product data', async () => {
    await expect(adapterFor({ failedCycle: '12' }).getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 4500, plannedUtc: '2026-09-22T01:00:00.000Z' })).rejects.toMatchObject({ code: 'upstream_unavailable' });
    await expect(adapterFor().getWindsPoint({ latitudeDeg: 35, longitudeDeg: -106, altitudeFeetMsl: 4500, plannedUtc: '2026-09-22T01:00:00.000Z' })).rejects.toMatchObject({ code: 'upstream_no_data' });
    await expect(adapterFor().getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 2500, plannedUtc: '2026-09-22T01:00:00.000Z' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('selects the newest issued product whose published use window contains the planned UTC', async () => {
    const newest = adapterFor({ product: async (cycle) => new Response(cycle === '12'
      ? product.replace('DATA BASED ON 211800Z', 'DATA BASED ON 220000Z').replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 220600Z   FOR USE 0200-0900Z')
      : product) });
    await expect(newest.getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 7500, plannedUtc: '2026-09-22T07:00:00.000Z' })).resolves.toMatchObject({ forecastCycle: '12', issuedAt: '2026-09-22T00:00:00.000Z' });

    const future = adapterFor({ product: async (cycle) => new Response(cycle === '12'
      ? product.replace('DATA BASED ON 211800Z', 'DATA BASED ON 220800Z').replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 220600Z   FOR USE 0200-0900Z')
      : product) });
    await expect(future.getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 7500, plannedUtc: '2026-09-22T07:00:00.000Z' })).rejects.toMatchObject({ code: 'upstream_no_data' });
  });

  it('rejects a fresh cached fetch when the published use window has already ended', async () => {
    await expect(adapterFor().getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 7500, plannedUtc: '2026-09-22T04:00:00.000Z' })).rejects.toMatchObject({ code: 'upstream_no_data' });
  });

  it('does not use a fresh cache fetch after its product use window or on stale-on-error fallback', async () => {
    let current = FIXED_NOW;
    const state = { fail: false };
    const adapter = adapterFor({ upstreamState: state, current: () => current });
    const query = { latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 7500, plannedUtc: '2026-09-22T01:00:00.000Z' };
    await expect(adapter.getWindsPoint(query)).resolves.toMatchObject({ forecastCycle: '06' });
    current = new Date(FIXED_NOW.getTime() + 21 * 60 * 1_000);
    state.fail = true;
    await expect(adapter.getWindsPoint(query)).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });

  it('accepts and caches a valid source over 512 KiB while rejecting one over its finite cap', async () => {
    const large = product + `\n#${'x'.repeat(600 * 1024)}`;
    const bigAdapter = adapterFor({ product: async () => new Response(large) });
    await expect(bigAdapter.getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 7500, plannedUtc: '2026-09-22T01:00:00.000Z' })).resolves.toMatchObject({ forecastCycle: '06' });
    const tooLarge = adapterFor({ product: async () => new Response(product + `\n#${'x'.repeat(1024 * 1024)}`) });
    await expect(tooLarge.getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 7500, plannedUtc: '2026-09-22T01:00:00.000Z' })).rejects.toMatchObject({ diagnostic: 'winds_response_byte_limit' });
  });

  it('keeps unreadable stream diagnostics distinct from the byte-limit diagnostic', async () => {
    const unreadable = adapterFor({ product: async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('source read failed')); } })) });
    await expect(unreadable.getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 7500, plannedUtc: '2026-09-22T01:00:00.000Z' })).rejects.toMatchObject({ diagnostic: 'winds_response_unreadable' });
  });
});
