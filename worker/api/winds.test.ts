import { describe, expect, expectTypeOf, it } from 'vitest';
import { ApiError } from './errors';
import { createAviationWeatherAdapter, decodeWindsProduct, regionForRoute, type CacheStore, type ServiceFetcher, type WindsDataAdapter } from './winds';
import type { AloftPointQuery } from './contracts';

/** Captured from the official AWC US low-level FB product on 2026-09-21. */
const PRODUCT = `000
FBUS31 KWNO 212000
FD1US1
DATA BASED ON 211800Z
VALID 220000Z   FOR USE 2000-0300Z. TEMPS NEG ABV 24000

FT  3000    6000    9000   12000   18000   24000  30000  34000  39000
ABQ              9900+16 9900+07 2310-08 2322-19 253535 264844 256654
ATL 9900 9900+16 0407+11 0410+05 0607-08 9900-18 220733 200843 221354
BGR 0215 3512+02 3217+03 2925-01 2846-13 2861-24 278338 781146 770757
`;

const FIXED_NOW = new Date('2026-09-21T18:30:00.000Z');

const STATION_CATALOG = [
  { iataId: 'ABQ', faaId: 'ABQ', icaoId: 'KABQ', site: 'Albuquerque', lat: 35.0402, lon: -106.609, elev: 5355 },
  { iataId: 'ATL', faaId: 'ATL', icaoId: 'KATL', site: 'Atlanta', lat: 33.6407, lon: -84.4277, elev: 1026 },
  { iataId: 'BGR', faaId: 'BGR', icaoId: 'KBGR', site: 'Bangor', lat: 44.8074, lon: -68.8281, elev: 192 },
  { iataId: 'FAI', faaId: 'FAI', icaoId: 'PAFA', site: 'Fairbanks Intl', lat: 64.8031, lon: -147.87606, elev: 130 },
  { iataId: 'BRW', faaId: 'BRW', icaoId: 'PABR', site: 'Utqiagvik', lat: 71.28369, lon: -156.78427, elev: 6 },
  { iataId: 'ITO', faaId: 'ITO', icaoId: 'PHTO', site: 'Hilo Intl', lat: 19.71909, lon: -155.04897, elev: 9 },
  { iataId: 'LIH', faaId: 'LIH', icaoId: 'PHLI', site: 'Lihue Arpt', lat: 21.98047, lon: -159.33864, elev: 32 },
  { iataId: 'HNL', faaId: 'HNL', icaoId: 'PHNL', site: 'Honolulu Intl', lat: 21.31869, lon: -157.92242, elev: 13 },
];

async function stationCatalogResponse(): Promise<Response> {
  const encoded = new TextEncoder().encode(JSON.stringify(STATION_CATALOG));
  const source = new ReadableStream<BufferSource>({ start(controller) { controller.enqueue(encoded); controller.close(); } });
  const body = source.pipeThrough(new CompressionStream('gzip'));
  return new Response(await new Response(body).arrayBuffer());
}

async function responseFor(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/data/windtemp') {
    const product = url.searchParams.get('fcst') === '12' ? PRODUCT.replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 220600Z   FOR USE 0200-0900Z')
      : url.searchParams.get('fcst') === '24' ? PRODUCT.replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 221800Z   FOR USE 1400-2100Z') : PRODUCT;
    return new Response(product, { headers: { 'Content-Type': 'text/plain' } });
  }
  if (url.pathname === '/data/cache/stations.cache.json.gz') return stationCatalogResponse();
  return new Response(null, { status: 404 });
}

function fetcher(): { fetcher: ServiceFetcher; requests: Request[] } {
  const requests: Request[] = [];
  return { fetcher: { async fetch(request) { requests.push(request); return responseFor(request); } }, requests };
}

function memoryCache(): CacheStore {
  const entries = new Map<string, Response>();
  return {
    async match(request) { const entry = entries.get(request.url); return entry?.clone(); },
    async put(request, response) { entries.set(request.url, response.clone()); }
  };
}

describe('official Winds/Temps decoder', () => {
  it('decodes official headers, 9900, temperatures, and 100-knot encoding without altering raw product data', () => {
    const decoded = decodeWindsProduct(PRODUCT, '06', FIXED_NOW);
    expect(decoded).toHaveLength(3);
    expect(decoded[0]).toMatchObject({ stationId: 'ABQ', issuedAt: '2026-09-21T18:00:00.000Z', validAt: '2026-09-22T00:00:00.000Z', useFrom: '2026-09-21T20:00:00.000Z', useUntil: '2026-09-22T03:00:00.000Z' });
    expect(decoded[0]?.levels).toEqual([
      { altitudeFt: 3000, windFromDegTrue: null, windSpeedKt: null, temperatureC: null, availability: 'unavailable', raw: '' },
      { altitudeFt: 6000, windFromDegTrue: null, windSpeedKt: null, temperatureC: null, availability: 'unavailable', raw: '' },
      { altitudeFt: 9000, windFromDegTrue: null, windSpeedKt: 0, temperatureC: 16, availability: 'available', raw: '9900+16' },
      { altitudeFt: 12000, windFromDegTrue: null, windSpeedKt: 0, temperatureC: 7, availability: 'available', raw: '9900+07' },
      { altitudeFt: 18000, windFromDegTrue: 230, windSpeedKt: 10, temperatureC: -8, availability: 'available', raw: '2310-08' },
      { altitudeFt: 24000, windFromDegTrue: 230, windSpeedKt: 22, temperatureC: -19, availability: 'available', raw: '2322-19' },
      { altitudeFt: 30000, windFromDegTrue: 250, windSpeedKt: 35, temperatureC: -35, availability: 'available', raw: '253535' },
      { altitudeFt: 34000, windFromDegTrue: 260, windSpeedKt: 48, temperatureC: -44, availability: 'available', raw: '264844' },
      { altitudeFt: 39000, windFromDegTrue: 250, windSpeedKt: 66, temperatureC: -54, availability: 'available', raw: '256654' }
    ]);
    expect(decoded[2]?.levels[7]).toMatchObject({ windFromDegTrue: 280, windSpeedKt: 111, temperatureC: -46, raw: '781146' });
  });

  it('decodes a calm 9900 group with a positive temperature suffix without inventing a direction', () => {
    const productWithPositiveCalmTemperature = PRODUCT.replace('9900+16', '9900+19');
    const decoded = decodeWindsProduct(productWithPositiveCalmTemperature, '06', FIXED_NOW);
    expect(decoded[0]?.levels[2]).toEqual({ altitudeFt: 9000, windFromDegTrue: null, windSpeedKt: 0, temperatureC: 19, availability: 'available', raw: '9900+19' });
  });

  it('rejects malformed provider records rather than attempting to repair them', () => {
    expect(() => decodeWindsProduct(PRODUCT.replace('9900+16', '99000+16'), '06', FIXED_NOW)).toThrow(ApiError);
    expect(() => decodeWindsProduct('FT 3000\nBRL 9900', '06', FIXED_NOW)).toThrow(ApiError);
  });
});

describe('Aviation Weather Center adapter', () => {
  it('uses only documented fixed upstream paths, enriches stations with verified official coordinates, and caches products', async () => {
    const requestLog = fetcher();
    const adapter = createAviationWeatherAdapter(requestLog.fetcher, memoryCache(), () => FIXED_NOW);
    const result = await adapter.getWindsStations([{ latitudeDeg: 42.6, longitudeDeg: -89.0 }]);
    expect(result.stations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'ABQ', region: 'us', coordinates: { latitudeDeg: 35.0402, longitudeDeg: -106.609 }, availableForecastCycles: ['06', '12', '24'] })]));
    expect(result.forecasts).toHaveLength(9);
    expect(result.unavailableForecastCycles).toEqual([]);
    expect(requestLog.requests.filter((request) => new URL(request.url).pathname === '/api/data/windtemp')).toHaveLength(3);
    const stationRequest = requestLog.requests.find((request) => new URL(request.url).pathname === '/data/cache/stations.cache.json.gz');
    expect(stationRequest).toBeDefined();
    expect(requestLog.requests.every((request) => new URL(request.url).origin === 'https://aviationweather.gov')).toBe(true);

    await adapter.getWindsStations([{ latitudeDeg: 42.6, longitudeDeg: -89.0 }]);
    expect(requestLog.requests.filter((request) => new URL(request.url).pathname === '/api/data/windtemp')).toHaveLength(3);
    expect(requestLog.requests.filter((request) => new URL(request.url).pathname === '/data/cache/stations.cache.json.gz')).toHaveLength(1);
  });

  it('maps Alaska and Hawaii FB station IDs through the official station catalog', async () => {
    const alaskaProduct = PRODUCT.replace(/^ABQ/gm, 'FAI').replace(/^ATL/gm, 'BRW').replace(/^BGR.*\n?/gm, '');
    const hawaiiProduct = PRODUCT.replace(/^ABQ/gm, 'ITO').replace(/^ATL/gm, 'LIH').replace(/^BGR/gm, 'HNL');
    const requests: Request[] = [];
    const regionalFetcher: ServiceFetcher = { async fetch(request) {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === '/api/data/windtemp') {
        const baseProduct = url.searchParams.get('region') === 'alaska' ? alaskaProduct : hawaiiProduct;
        const product = url.searchParams.get('fcst') === '12' ? baseProduct.replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 220600Z   FOR USE 0200-0900Z')
          : url.searchParams.get('fcst') === '24' ? baseProduct.replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 221800Z   FOR USE 1400-2100Z') : baseProduct;
        return new Response(product, { headers: { 'Content-Type': 'text/plain' } });
      }
      if (url.pathname === '/data/cache/stations.cache.json.gz') return stationCatalogResponse();
      return new Response(null, { status: 404 });
    } };

    const alaska = createAviationWeatherAdapter(regionalFetcher, memoryCache(), () => FIXED_NOW);
    await expect(alaska.getWindsStations([{ latitudeDeg: 61.2, longitudeDeg: -150 }])).resolves.toMatchObject({
      stations: expect.arrayContaining([expect.objectContaining({ id: 'FAI', coordinates: { latitudeDeg: 64.8031, longitudeDeg: -147.87606 } }), expect.objectContaining({ id: 'BRW', coordinates: { latitudeDeg: 71.28369, longitudeDeg: -156.78427 } })]),
    });
    const hawaii = createAviationWeatherAdapter(regionalFetcher, memoryCache(), () => FIXED_NOW);
    await expect(hawaii.getWindsForecast('ITO', '2026-09-22T00:00:00.000Z', 'hawaii')).resolves.toMatchObject({
      forecast: { station: { id: 'ITO', coordinates: { latitudeDeg: 19.71909, longitudeDeg: -155.04897 } } },
    });
    expect(requests.filter((request) => new URL(request.url).pathname === '/api/data/stationinfo')).toHaveLength(0);
    expect(requests.filter((request) => new URL(request.url).pathname === '/data/cache/stations.cache.json.gz')).toHaveLength(2);
  });

  it('rejects ambiguous and region-inconsistent exact station identities', async () => {
    const encodeCatalog = async (catalog: typeof STATION_CATALOG): Promise<Response> => {
      const encoded = new TextEncoder().encode(JSON.stringify(catalog));
      return new Response(await new Response(new ReadableStream<BufferSource>({ start(controller) { controller.enqueue(encoded); controller.close(); } }).pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    };
    const duplicateCatalog = [...STATION_CATALOG, { iataId: 'BRL', faaId: 'BRL', icaoId: 'KBRL', site: 'Burlington', lat: 40.7832, lon: -91.1255, elev: 698 }, { iataId: 'BRL', faaId: 'BRL', icaoId: 'KBRL', site: 'Conflicting Burlington', lat: 60, lon: -150, elev: 0 }];
    const duplicateFetcher: ServiceFetcher = { async fetch(request) {
      if (new URL(request.url).pathname === '/api/data/windtemp') return new Response(PRODUCT.replace(/^ABQ/gm, 'BRL'), { headers: { 'Content-Type': 'text/plain' } });
      if (new URL(request.url).pathname === '/data/cache/stations.cache.json.gz') {
        return encodeCatalog(duplicateCatalog);
      }
      return responseFor(request);
    } };
    await expect(createAviationWeatherAdapter(duplicateFetcher, memoryCache(), () => FIXED_NOW).getWindsStations([{ latitudeDeg: 42.6, longitudeDeg: -89 }])).rejects.toMatchObject({ code: 'upstream_invalid_response' });

    const missingCatalog = STATION_CATALOG;
    const missingFetcher: ServiceFetcher = { async fetch(request) {
      if (new URL(request.url).pathname === '/api/data/windtemp') return new Response(PRODUCT.replace(/^ABQ/gm, 'BRL'), { headers: { 'Content-Type': 'text/plain' } });
      if (new URL(request.url).pathname === '/data/cache/stations.cache.json.gz') {
        return encodeCatalog(missingCatalog);
      }
      return responseFor(request);
    } };
    await expect(createAviationWeatherAdapter(missingFetcher, memoryCache(), () => FIXED_NOW).getWindsStations([{ latitudeDeg: 42.6, longitudeDeg: -89 }])).rejects.toMatchObject({ code: 'upstream_invalid_response' });

    const wrongRegionCatalog = [...STATION_CATALOG.filter((entry) => entry.faaId !== 'ABQ'), { iataId: 'ABQ', faaId: 'ABQ', icaoId: 'KABQ', site: 'Mislocated ABQ', lat: 64, lon: -147, elev: 0 }];
    const wrongRegionFetcher: ServiceFetcher = { async fetch(request) {
      if (new URL(request.url).pathname === '/data/cache/stations.cache.json.gz') return encodeCatalog(wrongRegionCatalog);
      return responseFor(request);
    } };
    await expect(createAviationWeatherAdapter(wrongRegionFetcher, memoryCache(), () => FIXED_NOW).getWindsStations([{ latitudeDeg: 42.6, longitudeDeg: -89 }])).rejects.toMatchObject({ code: 'upstream_invalid_response' });
  });

  it('exposes the point-query contract for Task 2', () => {
    const query: AloftPointQuery = { latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 4500, plannedUtc: '2026-09-22T01:00:00.000Z' };
    expectTypeOf<WindsDataAdapter['getWindsPoint']>().toBeFunction();
    expect(query).toMatchObject({ altitudeFeetMsl: 4500 });
  });

  it('publishes availability independently for each verified station', async () => {
    const stationSpecificFetcher: ServiceFetcher = {
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/api/data/windtemp' && url.searchParams.get('fcst') === '12') {
          return new Response(PRODUCT.replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 220600Z   FOR USE 0200-0900Z').replace(/^ATL.*$/m, ''), { headers: { 'Content-Type': 'text/plain' } });
        }
        return responseFor(request);
      },
    };
    const adapter = createAviationWeatherAdapter(stationSpecificFetcher, memoryCache(), () => FIXED_NOW);
    const result = await adapter.getWindsStations([{ latitudeDeg: 42.6, longitudeDeg: -89.0 }]);

    expect(result.forecasts.some((forecast) => forecast.stationId === 'ABQ' && forecast.forecastCycle === '12')).toBe(true);
    expect(result.forecasts.some((forecast) => forecast.stationId === 'ATL' && forecast.forecastCycle === '12')).toBe(false);
    await expect(adapter.getWindsForecast('ABQ', '2026-09-22T06:00:00.000Z', 'us')).resolves.toMatchObject({ forecast: { station: { id: 'ABQ' } } });
    await expect(adapter.getWindsForecast('ATL', '2026-09-22T06:00:00.000Z', 'us')).rejects.toMatchObject({ code: 'upstream_no_data' });
  });

  it('requires a published valid time and uses the selected region rather than silently substituting a forecast', async () => {
    const adapter = createAviationWeatherAdapter(fetcher().fetcher, memoryCache(), () => FIXED_NOW);
    const result = await adapter.getWindsForecast('ABQ', '2026-09-22T00:00:00.000Z', 'us');
    expect(result.forecast.station.id).toBe('ABQ');
    await expect(adapter.getWindsForecast('ABQ', '2026-09-22T01:00:00.000Z', 'us')).rejects.toMatchObject({ code: 'upstream_no_data' });
  });

  it('keeps successful cycles usable and marks failed-cycle discovery incomplete', async () => {
    const partialFetcher: ServiceFetcher = { async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/api/data/windtemp' && url.searchParams.get('fcst') === '12') return new Response(null, { status: 204 });
      return responseFor(request);
    } };
    const adapter = createAviationWeatherAdapter(partialFetcher, memoryCache(), () => FIXED_NOW);

    const discovery = await adapter.getWindsStations([{ latitudeDeg: 42.6, longitudeDeg: -89.0 }]);
    expect(discovery.unavailableForecastCycles).toEqual(['12']);
    expect(discovery.forecasts.some((forecast) => forecast.stationId === 'ABQ' && forecast.forecastCycle === '06')).toBe(true);
    expect(discovery.provenance.map((entry) => entry.key)).toHaveLength(2);
    expect(discovery.provenance.map((entry) => entry.key)).toEqual(expect.arrayContaining([expect.stringContaining('/06'), expect.stringContaining('/24')]));
    expect(discovery.provenance.some((entry) => entry.key.endsWith('/12'))).toBe(false);
    await expect(adapter.getWindsForecast('ABQ', '2026-09-22T00:00:00.000Z', 'us')).resolves.toMatchObject({ provenance: { status: 'edge_hit', key: expect.stringContaining('/06') } });
    await expect(adapter.getWindsForecast('ABQ', '2026-09-22T06:00:00.000Z', 'us')).rejects.toMatchObject({ code: 'upstream_unavailable' });
    await expect(adapter.getWindsForecast('ABQ', '2026-09-22T03:00:00.000Z', 'us')).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });

  it('returns no-data only when all forecast cycles were checked successfully', async () => {
    const adapter = createAviationWeatherAdapter(fetcher().fetcher, memoryCache(), () => FIXED_NOW);
    await expect(adapter.getWindsForecast('ABQ', '2026-09-22T03:00:00.000Z', 'us')).rejects.toMatchObject({ code: 'upstream_no_data' });
  });

  it('rejects duplicate station and valid-time products as ambiguous', async () => {
    const duplicateTimeFetcher: ServiceFetcher = { async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/api/data/windtemp' && url.searchParams.get('fcst') === '12') return new Response(PRODUCT, { headers: { 'Content-Type': 'text/plain' } });
      return responseFor(request);
    } };
    const adapter = createAviationWeatherAdapter(duplicateTimeFetcher, memoryCache(), () => FIXED_NOW);
    await expect(adapter.getWindsStations([{ latitudeDeg: 42.6, longitudeDeg: -89.0 }])).rejects.toMatchObject({ code: 'upstream_invalid_response' });
    await expect(adapter.getWindsForecast('ABQ', '2026-09-22T00:00:00.000Z', 'us')).rejects.toMatchObject({ code: 'upstream_invalid_response' });
  });

  it('treats cache match failures as misses for wind products and station catalog resources', async () => {
    const rejectingCache: CacheStore = { async match() { throw new Error('cache read unavailable'); }, async put() {} };
    const adapter = createAviationWeatherAdapter(fetcher().fetcher, rejectingCache, () => FIXED_NOW);
    const result = await adapter.getWindsForecast('ABQ', '2026-09-22T00:00:00.000Z', 'us');
    expect(result.forecast.station.id).toBe('ABQ');
    expect(result.provenance.status).toBe('upstream_refresh');

    const discovery = await createAviationWeatherAdapter(fetcher().fetcher, rejectingCache, () => FIXED_NOW).getWindsStations([{ latitudeDeg: 42.6, longitudeDeg: -89.0 }]);
    expect(discovery.stations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'ABQ' })]));
    expect(discovery.provenance.every((entry) => entry.status === 'upstream_refresh')).toBe(true);

    const invalidJsonCache: CacheStore = { async match(_request) { return new Response('not-json', { headers: { 'Content-Type': 'application/json' } }); }, async put() {} };
    const invalidJsonResult = await createAviationWeatherAdapter(fetcher().fetcher, invalidJsonCache, () => FIXED_NOW).getWindsForecast('ABQ', '2026-09-22T00:00:00.000Z', 'us');
    expect(invalidJsonResult.provenance.status).toBe('upstream_refresh');

    let upstreamUnavailable = false;
    const failingFetcher: ServiceFetcher = { async fetch(request) {
      if (upstreamUnavailable) throw new Error('upstream unavailable');
      return responseFor(request);
    } };
    const failingAdapter = createAviationWeatherAdapter(failingFetcher, rejectingCache, () => FIXED_NOW);
    upstreamUnavailable = true;
    await expect(failingAdapter.getWindsForecast('ABQ', '2026-09-22T00:00:00.000Z', 'us')).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });

  it('serves an explicitly labeled stale product only when upstream refresh fails inside the bounded stale window', async () => {
    let current = FIXED_NOW;
    let failWinds = false;
    const resilientFetcher: ServiceFetcher = { async fetch(request) {
      if (failWinds && new URL(request.url).pathname === '/api/data/windtemp') throw new Error('upstream outage');
      return responseFor(request);
    } };
    const adapter = createAviationWeatherAdapter(resilientFetcher, memoryCache(), () => current);
    await adapter.getWindsForecast('ABQ', '2026-09-22T00:00:00.000Z', 'us');
    current = new Date(FIXED_NOW.getTime() + 21 * 60 * 1_000);
    failWinds = true;
    const stale = await adapter.getWindsForecast('ABQ', '2026-09-22T00:00:00.000Z', 'us');
    expect(stale.provenance.status).toBe('stale_on_error');
  });

  it('serves fresh validated winds when an edge-cache write fails', async () => {
    const rejectingCache: CacheStore = {
      async match() { return undefined; },
      async put() { throw new Error('cache write unavailable'); },
    };
    const adapter = createAviationWeatherAdapter(fetcher().fetcher, rejectingCache, () => FIXED_NOW);

    const result = await adapter.getWindsForecast('ABQ', '2026-09-22T00:00:00.000Z', 'us');

    expect(result.forecast.station.id).toBe('ABQ');
    expect(result.provenance.status).toBe('upstream_refresh');
  });

  it('rejects routes that cross product regions or fall outside documented v1 support', () => {
    expect(() => regionForRoute([{ latitudeDeg: 42.6, longitudeDeg: -89.0 }, { latitudeDeg: 21.3, longitudeDeg: -157.8 }])).toThrow(ApiError);
    expect(() => regionForRoute([{ latitudeDeg: 10, longitudeDeg: 10 }])).toThrow(ApiError);
  });
});
