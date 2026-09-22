import { describe, expect, it } from 'vitest';
import { ApiError } from './errors';
import { createAviationWeatherAdapter, decodeWindsProduct, regionForRoute, type CacheStore, type ServiceFetcher } from './winds';

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

function responseFor(request: Request): Response {
  const url = new URL(request.url);
  if (url.pathname === '/api/data/windtemp') {
    const product = url.searchParams.get('fcst') === '12' ? PRODUCT.replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 220600Z   FOR USE 0200-0900Z')
      : url.searchParams.get('fcst') === '24' ? PRODUCT.replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 221800Z   FOR USE 1400-2100Z') : PRODUCT;
    return new Response(product, { headers: { 'Content-Type': 'text/plain' } });
  }
  if (url.pathname === '/api/data/stationinfo') return Response.json([
    { iataId: 'ABQ', faaId: 'ABQ', icaoId: 'KABQ', site: 'Albuquerque', lat: 35.0402, lon: -106.609, elev: 5355 },
    { iataId: 'ATL', faaId: 'ATL', icaoId: 'KATL', site: 'Atlanta', lat: 33.6407, lon: -84.4277, elev: 1026 },
    { iataId: 'BGR', faaId: 'BGR', icaoId: 'KBGR', site: 'Bangor', lat: 44.8074, lon: -68.8281, elev: 192 }
  ]);
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
    expect(result.forecasts).toHaveLength(3);
    expect(requestLog.requests.filter((request) => new URL(request.url).pathname === '/api/data/windtemp')).toHaveLength(3);
    expect(requestLog.requests.every((request) => new URL(request.url).origin === 'https://aviationweather.gov')).toBe(true);

    await adapter.getWindsStations([{ latitudeDeg: 42.6, longitudeDeg: -89.0 }]);
    expect(requestLog.requests.filter((request) => new URL(request.url).pathname === '/api/data/windtemp')).toHaveLength(3);
  });

  it('publishes only forecast periods that every selectable station reports', async () => {
    const stationSpecificFetcher: ServiceFetcher = {
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/api/data/windtemp' && url.searchParams.get('fcst') === '12') {
          return new Response(PRODUCT.replace(/^ATL.*$/m, ''), { headers: { 'Content-Type': 'text/plain' } });
        }
        return responseFor(request);
      },
    };
    const adapter = createAviationWeatherAdapter(stationSpecificFetcher, memoryCache(), () => FIXED_NOW);
    const result = await adapter.getWindsStations([{ latitudeDeg: 42.6, longitudeDeg: -89.0 }]);

    expect(result.forecasts.map((forecast) => forecast.forecastCycle)).toEqual(['06', '24']);
  });

  it('requires a published valid time and uses the selected region rather than silently substituting a forecast', async () => {
    const adapter = createAviationWeatherAdapter(fetcher().fetcher, memoryCache(), () => FIXED_NOW);
    const result = await adapter.getWindsForecast('ABQ', '2026-09-22T00:00:00.000Z', 'us');
    expect(result.forecast.station.id).toBe('ABQ');
    await expect(adapter.getWindsForecast('ABQ', '2026-09-22T01:00:00.000Z', 'us')).rejects.toMatchObject({ code: 'upstream_no_data' });
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
