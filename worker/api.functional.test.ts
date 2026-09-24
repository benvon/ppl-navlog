import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from './index';
import { runwayPickerAirportFixture, runwayPickerCacheFixture, runwayPickerMetarFixture } from './api/fixtures/runway-picker';
import type { ServiceFetcher } from './api/adapters';
import type { CacheStore } from './api/winds';

const FIXED_REQUEST_ID = 'e531d3ef-89b8-4cbe-a7e9-c42c7fad7de5';
const FIXED_NOW = '2026-09-21T18:30:00.000Z';

/** An official-format FB product fixture, used only as hermetic test data. */
const WINDS_PRODUCT = `000
FBUS31 KWNO 212000
FD1US1
DATA BASED ON 211800Z
VALID 220000Z   FOR USE 2000-0300Z. TEMPS NEG ABV 24000

FT  3000    6000    9000   12000   18000   24000  30000  34000  39000
ABQ              9900+16 9900+07 2310-08 2322-19 253535 264844 256654
`;

const STATION_CATALOG = [
  { iataId: 'ABQ', faaId: 'ABQ', icaoId: 'KABQ', site: 'Albuquerque', lat: 35.0402, lon: -106.609, elev: 5355 },
];

async function stationCatalogResponse(): Promise<Response> {
  const encoded = new TextEncoder().encode(JSON.stringify(STATION_CATALOG));
  const source = new ReadableStream<BufferSource>({ start(controller) { controller.enqueue(encoded); controller.close(); } });
  const compressed = source.pipeThrough(new CompressionStream('gzip'));
  return new Response(await new Response(compressed).arrayBuffer());
}

function memoryCache(): CacheStore {
  const entries = new Map<string, Response>();
  return {
    async match(request) { return entries.get(request.url)?.clone(); },
    async put(request, response) { entries.set(request.url, response.clone()); }
  };
}

function runwayPicker(fetches: Request[]): ServiceFetcher {
  return {
    async fetch(request) {
      fetches.push(request);
      const url = new URL(request.url);
      const icao = url.searchParams.get('icao');
      if (icao !== 'KJVL') return new Response(null, { status: 404 });
      return Response.json(url.pathname === '/api/airport'
        ? { ...runwayPickerAirportFixture, cache: runwayPickerCacheFixture }
        : { ...runwayPickerMetarFixture, cache: runwayPickerCacheFixture });
    }
  };
}

function aviationWeatherFetch(fetches: Request[]): typeof globalThis.fetch {
  return async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    fetches.push(request);
    const url = new URL(request.url);
    if (url.origin !== 'https://aviationweather.gov') return new Response(null, { status: 500 });
    if (url.pathname === '/api/data/windtemp') {
      const cycle = url.searchParams.get('fcst');
      const product = cycle === '12'
        ? WINDS_PRODUCT.replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 220600Z   FOR USE 0200-0900Z')
        : cycle === '24'
          ? WINDS_PRODUCT.replace('VALID 220000Z   FOR USE 2000-0300Z', 'VALID 221800Z   FOR USE 1400-2100Z')
          : WINDS_PRODUCT;
      return new Response(product, { headers: { 'Content-Type': 'text/plain' } });
    }
    if (url.pathname === '/data/cache/stations.cache.json.gz') return stationCatalogResponse();
    return new Response(null, { status: 404 });
  };
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    APP_VERSION: 'v0.1.0',
    APP_COMMIT_SHA: 'abcdef1',
    ASSETS: { async fetch() { return new Response('asset'); } },
    ...overrides
  };
}

async function api(path: string, testEnv: Env, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`https://navlog.test${path}`, {
    ...init,
    headers: { 'X-Request-Id': FIXED_REQUEST_ID, ...init.headers }
  }), testEnv);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Worker API functional contracts', () => {
  it('serves an exact normalized airport lookup including field elevation and provenance', async () => {
    const upstream: Request[] = [];
    const response = await api('/api/airports/kjvl', env({ RUNWAY_PICKER_API: runwayPicker(upstream) }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('X-Request-Id')).toBe(FIXED_REQUEST_ID);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const payload = await response.json();
    expect(payload.airport.elevationFt).toBe(runwayPickerAirportFixture.elevationFt);
    expect(payload).toEqual({
      airport: runwayPickerAirportFixture,
      provenance: { adapter: 'runway-picker', fetchedAt: runwayPickerAirportFixture.fetchedAt, cache: runwayPickerCacheFixture },
      requestId: FIXED_REQUEST_ID
    });
    expect(upstream).toHaveLength(1);
    expect(new URL(upstream[0]!.url)).toMatchObject({ origin: 'https://runway-picker.internal', pathname: '/api/airport' });
    expect(new URL(upstream[0]!.url).searchParams.get('icao')).toBe('KJVL');
  });

  it('serves METAR wind fields unchanged through the browser response contract', async () => {
    const response = await api('/api/weather/metar/KJVL', env({ RUNWAY_PICKER_API: runwayPicker([]) }));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.metar.wind).toEqual(runwayPickerMetarFixture.wind);
    expect(payload).toEqual({
      metar: runwayPickerMetarFixture,
      provenance: { adapter: 'runway-picker', fetchedAt: runwayPickerMetarFixture.fetchedAt, cache: runwayPickerCacheFixture },
      requestId: FIXED_REQUEST_ID
    });
  });

  it('discovers published winds stations and exposes provenance for every forecast product', async () => {
    const awcRequests: Request[] = [];
    vi.stubGlobal('fetch', aviationWeatherFetch(awcRequests));
    const response = await api('/api/weather/winds/stations?route=42.6,-89.0', env({ WINDS_CACHE: memoryCache() }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      stations: [{ id: 'ABQ', coordinates: { latitudeDeg: 35.0402, longitudeDeg: -106.609 }, elevationFt: 5355, region: 'us', availableForecastCycles: ['06', '12', '24'], source: 'aviationweather' }],
      forecasts: [
        { stationId: 'ABQ', forecastCycle: '06', validAt: '2026-09-22T00:00:00.000Z' },
        { stationId: 'ABQ', forecastCycle: '12', validAt: '2026-09-22T06:00:00.000Z' },
        { stationId: 'ABQ', forecastCycle: '24', validAt: '2026-09-22T18:00:00.000Z' }
      ],
      unavailableForecastCycles: [],
      requestedRoute: [{ latitudeDeg: 42.6, longitudeDeg: -89 }],
      provenance: [
        { adapter: 'aviationweather', product: 'NCEP FB Winds/Temps (legacy FD)', region: 'us', endpoint: 'https://aviationweather.gov/api/data/windtemp', fetchedAt: FIXED_NOW, cache: { status: 'upstream_refresh', source: 'upstream' } },
        { adapter: 'aviationweather', product: 'NCEP FB Winds/Temps (legacy FD)', region: 'us', endpoint: 'https://aviationweather.gov/api/data/windtemp', fetchedAt: FIXED_NOW, cache: { status: 'upstream_refresh', source: 'upstream' } },
        { adapter: 'aviationweather', product: 'NCEP FB Winds/Temps (legacy FD)', region: 'us', endpoint: 'https://aviationweather.gov/api/data/windtemp', fetchedAt: FIXED_NOW, cache: { status: 'upstream_refresh', source: 'upstream' } }
      ],
      requestId: FIXED_REQUEST_ID
    });
    expect(awcRequests.filter((request) => new URL(request.url).pathname === '/api/data/windtemp')).toHaveLength(3);
    expect(awcRequests.filter((request) => new URL(request.url).pathname === '/data/cache/stations.cache.json.gz')).toHaveLength(1);
  });

  it('serves the selected forecast and raw official product without a live network dependency', async () => {
    const awcRequests: Request[] = [];
    vi.stubGlobal('fetch', aviationWeatherFetch(awcRequests));
    const response = await api('/api/weather/winds?station=ABQ&validTime=2026-09-22T00%3A00%3A00.000Z&region=us', env({ WINDS_CACHE: memoryCache() }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      forecast: {
        station: { id: 'ABQ', elevationFt: 5355, region: 'us' },
        forecastCycle: '06',
        validAt: '2026-09-22T00:00:00.000Z',
        rawProduct: WINDS_PRODUCT,
        source: 'aviationweather',
        fetchedAt: FIXED_NOW
      },
      provenance: { adapter: 'aviationweather', cache: { status: 'upstream_refresh', source: 'upstream' } },
      requestId: FIXED_REQUEST_ID
    });
    expect(awcRequests.every((request) => new URL(request.url).origin === 'https://aviationweather.gov')).toBe(true);
  });

  it('serves a validated aloft point answer with the request id and no station discovery payload', async () => {
    const awcRequests: Request[] = [];
    vi.stubGlobal('fetch', aviationWeatherFetch(awcRequests));
    const response = await api('/api/weather/winds/point?lat=35.0402&lon=-106.609&altitudeFeetMsl=9000&plannedUtc=2026-09-22T01%3A00%3A00.000Z', env({ WINDS_CACHE: memoryCache() }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ query: { latitudeDeg: 35.0402, longitudeDeg: -106.609, altitudeFeetMsl: 9000 }, forecastCycle: '06', windSpeedKt: 0, requestId: FIXED_REQUEST_ID });
    expect(awcRequests.filter((request) => new URL(request.url).pathname === '/api/data/windtemp')).toHaveLength(3);
    expect(awcRequests.filter((request) => new URL(request.url).pathname === '/data/cache/stations.cache.json.gz')).toHaveLength(1);
  });

  it('returns browser-safe failures for invalid input, upstream failure, and rate limiting', async () => {
    const invalid = await api('/api/airports/KJ', env({ RUNWAY_PICKER_API: runwayPicker([]) }));
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: 'Invalid airport code. Expected exactly three or four alphanumeric characters, such as 1C8 or KORD.', code: 'invalid_request', requestId: FIXED_REQUEST_ID });

    const unavailable = await api('/api/airports/KJVL', env({ RUNWAY_PICKER_API: { async fetch() { throw new Error('network detail must not escape'); } } }));
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: 'Aviation data service is unavailable.', code: 'upstream_unavailable', requestId: FIXED_REQUEST_ID });

    const limited = await api('/api/health', env({ API_RATE_LIMITER: { async limit() { return { success: false }; } } }));
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({ error: 'Too many requests. Please retry shortly.', code: 'rate_limited', requestId: FIXED_REQUEST_ID });
    expect(limited.headers.get('Content-Security-Policy')).toBe("default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  });
});
