import { ApiError } from './errors';
import type { CacheStore, ServiceFetcher } from './winds';
import { decodeWindsProduct, parseStationCatalog } from '../weather-resources/validation';
import type { CatalogResourceEnvelope, WeatherResourceKey, WeatherResourcePort, WeatherResourceResult, WindsResourceEnvelope } from '../weather-resources/contracts';

export function resourcesFromFakeCoordinator(fetcher: ServiceFetcher, now: () => Date): WeatherResourcePort {
  const stored = new Map<WeatherResourceKey, CatalogResourceEnvelope | WindsResourceEnvelope>();
  return { async getResource(key) {
    const current = now();
    const previous = stored.get(key);
    if (previous && current.getTime() < Date.parse(previous.metadata.refreshAfter)) return { ok: true, resource: previous, state: 'fresh', source: 'edge' };
    try {
      const resource = key === 'station-catalog:v1'
        ? await fetchCatalogResource(fetcher, current, previous as CatalogResourceEnvelope | undefined)
        : await fetchWindsResource(fetcher, key, current, previous as WindsResourceEnvelope | undefined);
      stored.set(key, resource);
      return { ok: true, resource, state: 'fresh', source: 'coordinator' };
    } catch (error) {
      if (previous && current.getTime() < Date.parse(previous.metadata.staleUntil)) return { ok: true, resource: previous, state: 'grace', source: 'coordinator' };
      return { ok: false, code: error instanceof ApiError ? error.code === 'service_unavailable' ? 'service_unavailable' : 'upstream_unavailable' : 'upstream_unavailable', retryAt: new Date(current.getTime() + 60_000).toISOString() } satisfies WeatherResourceResult;
    }
  } };
}

async function fetchCatalogResource(fetcher: ServiceFetcher, current: Date, previous?: CatalogResourceEnvelope): Promise<CatalogResourceEnvelope> {
  const response = await fetcher.fetch(new Request('https://aviationweather.gov/data/cache/stations.cache.json.gz'));
  if (!response.ok || !response.body) throw new ApiError('catalog unavailable', 503, 'upstream_unavailable');
  const text = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text();
  const parsed = parseStationCatalog(JSON.parse(text) as unknown, current);
  return { kind: 'catalog', key: 'station-catalog:v1', entries: parsed.entries, metadata: metadata(current, previous?.metadata.fetchedAt, 24 * 60 * 60_000) };
}

async function fetchWindsResource(fetcher: ServiceFetcher, key: Exclude<WeatherResourceKey, 'station-catalog:v1'>, current: Date, previous?: WindsResourceEnvelope): Promise<WindsResourceEnvelope> {
  const [, region, cycle] = key.split(':') as ['winds', 'us' | 'alaska' | 'hawaii', '06' | '12' | '24'];
  const url = new URL('https://aviationweather.gov/api/data/windtemp');
  url.searchParams.set('region', region); url.searchParams.set('level', 'low'); url.searchParams.set('fcst', cycle);
  const response = await fetcher.fetch(new Request(url));
  if (response.status === 204) throw new ApiError('no data', 503, 'upstream_unavailable');
  if (!response.ok) throw new ApiError('upstream unavailable', 503, 'upstream_unavailable');
  const rawProduct = await response.text();
  if (new TextEncoder().encode(rawProduct).byteLength > 1024 * 1024) throw new ApiError('oversized test product', 502, 'upstream_invalid_response', 'winds_response_byte_limit');
  const forecasts = decodeWindsProduct(rawProduct, cycle, current);
  return { kind: 'winds', key, rawProduct, forecasts, metadata: metadata(current, previous?.metadata.fetchedAt, 60 * 60_000) };
}

function metadata(checkedAt: Date, fetchedAt: string | undefined, intervalMs: number) {
  const checked = checkedAt.toISOString(); const refreshAfter = new Date(checkedAt.getTime() + intervalMs).toISOString();
  return { fetchedAt: fetchedAt ?? checked, checkedAt: checked, refreshAfter, staleUntil: new Date(checkedAt.getTime() + intervalMs + 120_000).toISOString() };
}

export function unusedFixtureCache(): CacheStore { return { match: async () => undefined, put: async () => undefined }; }
