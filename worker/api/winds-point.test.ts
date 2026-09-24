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

async function catalogResponse(entries = catalog): Promise<Response> {
  const bytes = new TextEncoder().encode(JSON.stringify(entries));
  const input = new ReadableStream<BufferSource>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  return new Response(await new Response(input.pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
function cache(capturedProducts: string[] = []): CacheStore {
  const entries = new Map<string, Response>();
  return { async match(request) { return entries.get(request.url)?.clone(); }, async put(request, response) {
    const copy = response.clone();
    const body = await copy.json() as { rawProduct?: unknown };
    if (typeof body.rawProduct === 'string') capturedProducts.push(body.rawProduct);
    entries.set(request.url, response.clone());
  } };
}
function adapterFor(overrides: { product?: (cycle: string) => Promise<Response>; failedCycle?: string; upstreamState?: { fail: boolean }; current?: () => Date; cacheProducts?: string[]; catalog?: () => Promise<Response> } = {}) {
  const upstream: ServiceFetcher = { async fetch(request) {
    const parsed = new URL(request.url);
    if (parsed.pathname.endsWith('/windtemp')) {
      const cycle = parsed.searchParams.get('fcst') ?? '06';
      if (cycle === overrides.failedCycle || overrides.upstreamState?.fail) throw new Error('unavailable');
      if (overrides.product) return overrides.product(cycle);
      const source = cycle === '12' ? product.replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 220600Z   FOR USE 0200-0900Z')
        : cycle === '24' ? product.replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 221800Z   FOR USE 1400-2100Z') : product;
      return new Response(source);
    }
    if (parsed.pathname.endsWith('.gz')) return overrides.catalog ? overrides.catalog() : catalogResponse();
    return new Response(null, { status: 404 });
  } };
  return createAviationWeatherAdapter(upstream, cache(overrides.cacheProducts), overrides.current ?? (() => FIXED_NOW));
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

  it('interpolates 4500-foot wind from the published 3000 and 6000 foot winds without inventing temperature', async () => {
    const answer = await adapterFor().getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 4500, plannedUtc: '2026-09-22T01:00:00.000Z' });
    expect(answer.windSpeedKt).toBeGreaterThan(19);
    expect(answer.temperatureC).toBeNull();
    expect(answer.sources[0]).toMatchObject({ lowerAltitudeFeet: 3000, upperAltitudeFeet: 6000, verticalWeight: 0.5 });
  });

  it('rejects unavailable cycles, out-of-coverage points, unsupported altitude, and stale product data', async () => {
    await expect(adapterFor({ failedCycle: '12' }).getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 4500, plannedUtc: '2026-09-22T01:00:00.000Z' })).rejects.toMatchObject({ code: 'upstream_unavailable' });
    await expect(adapterFor().getWindsPoint({ latitudeDeg: 35, longitudeDeg: -106, altitudeFeetMsl: 4500, plannedUtc: '2026-09-22T01:00:00.000Z' })).rejects.toMatchObject({ code: 'upstream_no_data' });
    await expect(adapterFor().getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 2500, plannedUtc: '2026-09-22T01:00:00.000Z' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects a point more than 100 NM from every usable station', async () => {
    await expect(adapterFor().getWindsPoint({ latitudeDeg: 44.4, longitudeDeg: -89, altitudeFeetMsl: 7500, plannedUtc: '2026-09-22T01:00:00.000Z' })).rejects.toMatchObject({ code: 'upstream_no_data' });
  });

  it('selects the newest issued product whose published use window contains the planned UTC', async () => {
    const query = { latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 7500, plannedUtc: '2026-09-22T07:00:00.000Z' };
    await expect(adapterFor({ product: async (cycle) => new Response(cycle === '12'
      ? product.replace('DATA BASED ON 211800Z', 'DATA BASED ON 220000Z').replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 220600Z   FOR USE 0200-0900Z')
      : product), current: () => new Date('2026-09-21T23:59:00.000Z') }).getWindsPoint(query)).rejects.toMatchObject({ code: 'upstream_no_data' });
    await expect(adapterFor({ product: async (cycle) => new Response(cycle === '12'
      ? product.replace('DATA BASED ON 211800Z', 'DATA BASED ON 220000Z').replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 220600Z   FOR USE 0200-0900Z')
      : product), current: () => new Date('2026-09-22T00:01:00.000Z') }).getWindsPoint(query)).resolves.toMatchObject({ forecastCycle: '12', issuedAt: '2026-09-22T00:00:00.000Z' });

    const future = adapterFor({ product: async (cycle) => new Response(cycle === '12'
      ? product.replace('DATA BASED ON 211800Z', 'DATA BASED ON 220800Z').replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 220600Z   FOR USE 0200-0900Z')
      : product) });
    await expect(future.getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 7500, plannedUtc: '2026-09-22T07:00:00.000Z' })).rejects.toMatchObject({ code: 'upstream_no_data' });
  });

  it('rejects two distinct applicable products issued at the same time', async () => {
    const ambiguous = adapterFor({ current: () => new Date('2026-09-22T00:01:00.000Z'), product: async (cycle) => {
      if (cycle === '12') return new Response(product.replace('DATA BASED ON 211800Z', 'DATA BASED ON 220000Z').replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 220600Z   FOR USE 0200-0900Z'));
      if (cycle === '24') return new Response(product.replace('DATA BASED ON 211800Z', 'DATA BASED ON 220000Z').replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 221200Z   FOR USE 0600-1200Z'));
      return new Response(product);
    } });
    await expect(ambiguous.getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 7500, plannedUtc: '2026-09-22T07:00:00.000Z' })).rejects.toMatchObject({ code: 'upstream_invalid_response', message: expect.stringContaining('Multiple distinct Winds/Temps products') });
  });

  it('rejects a fresh cached fetch when the published use window has already ended', async () => {
    await expect(adapterFor().getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 7500, plannedUtc: '2026-09-22T10:00:00.000Z' })).rejects.toMatchObject({ code: 'upstream_no_data' });
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
    const widths = [4, 8, 8, 8, 8, 8, 7, 7, 7];
    const fields = ['3520', '3520+15', '3520+10', '3520+05', '3520-05', '3520-10', '3520-20', '3520-30', '3520-40'];
    const row = (stationId: string, direction: string) => `${stationId} ${[direction, ...fields.slice(1)].map((value, index) => value.padEnd(widths[index]!, ' ')).join('')}`;
    const extraEntries = Array.from({ length: 8_998 }, (_, index) => {
      const id = index.toString(36).toUpperCase().padStart(3, '0');
      return { iataId: id, faaId: id, icaoId: `K${id}`, site: `Fixture ${id}`, lat: 35, lon: -100, elev: 0 };
    });
    const largeCatalog = [...catalog, ...extraEntries];
    const large = `000\nFBUS31 KWNO 212000\nFD1US1\nDATA BASED ON 211800Z\nVALID 220000Z   FOR USE 2000-0300Z. TEMPS NEG ABV 24000\n\nFT  3000    6000    9000   12000   18000   24000  30000  34000  39000\n${row('ABQ', '3520')}\n${row('ATL', '0120')}\n${extraEntries.map((entry) => row(entry.faaId, '3520')).join('\n')}\n`;
    expect(new TextEncoder().encode(large).byteLength).toBeGreaterThan(512 * 1024);
    const cachedProducts: string[] = [];
    const cycleProduct = (cycle: string) => cycle === '12' ? large.replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 220600Z   FOR USE 0200-0900Z')
      : cycle === '24' ? large.replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 221800Z   FOR USE 1400-2100Z') : large;
    const bigAdapter = adapterFor({ product: async (cycle) => new Response(cycleProduct(cycle)), catalog: () => catalogResponse(largeCatalog), cacheProducts: cachedProducts });
    await expect(bigAdapter.getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 7500, plannedUtc: '2026-09-22T01:00:00.000Z' })).resolves.toMatchObject({ forecastCycle: '06' });
    expect(cachedProducts.some((cached) => cached === large)).toBe(true);
    const tooLarge = adapterFor({ product: async () => new Response(large + 'x'.repeat(1024 * 1024)) });
    await expect(tooLarge.getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 7500, plannedUtc: '2026-09-22T01:00:00.000Z' })).rejects.toMatchObject({ diagnostic: 'winds_response_byte_limit' });
  });

  it('keeps unreadable stream diagnostics distinct from the byte-limit diagnostic', async () => {
    const unreadable = adapterFor({ product: async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('source read failed')); } })) });
    await expect(unreadable.getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 7500, plannedUtc: '2026-09-22T01:00:00.000Z' })).rejects.toMatchObject({ diagnostic: 'winds_response_unreadable' });
  });
});
