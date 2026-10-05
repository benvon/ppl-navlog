import type { CatalogResourceEnvelope, WeatherResourceEnvelope, WeatherResourceKey, WindsResourceEnvelope } from '../weather-resources/contracts';
import type { WindsForecastCycle, WindsRegion } from '../api/contracts';
import { decodeWindsProduct, parseStationCatalog } from '../weather-resources/validation';

export interface ServiceFetcher { fetch(request: Request): Promise<Response>; }
export class UpstreamFailure extends Error {
  constructor(readonly status: number | null, readonly retryAfter: string | null, message = 'Weather upstream unavailable.') { super(message); }
}
const ORIGIN = 'https://aviationweather.gov';
const USER_AGENT = 'ppl-navlog/0.1 (educational flight planning)';
const WINDS_LIMIT = 1024 * 1024;
const CATALOG_COMPRESSED_LIMIT = 3 * 1024 * 1024;
const CATALOG_INFLATED_LIMIT = 3 * 1024 * 1024;
const TIMEOUT_MS = 5_000;
function requestFor(key: WeatherResourceKey): { url: URL; accept: string; limit: number; gzip: boolean } {
  if (key === 'station-catalog:v1') return { url: new URL('/data/cache/stations.cache.json.gz', ORIGIN), accept: 'application/octet-stream', limit: CATALOG_COMPRESSED_LIMIT, gzip: true };
  const match = /^winds:(us|alaska|hawaii):(06|12|24)$/.exec(key);
  if (!match) throw new TypeError('Unsupported weather resource key.');
  const url = new URL('/api/data/windtemp', ORIGIN);
  url.searchParams.set('region', match[1]!); url.searchParams.set('level', 'low'); url.searchParams.set('fcst', match[2]!);
  return { url, accept: 'text/plain', limit: WINDS_LIMIT, gzip: false };
}
function timeoutSignal(controller: AbortController): { promise: Promise<never>; clear: () => void } {
  let rejectTimeout!: (error: Error) => void;
  const promise = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => { controller.abort(); rejectTimeout(new UpstreamFailure(null, null, 'Weather upstream request timed out.')); }, TIMEOUT_MS);
  return { promise, clear: () => clearTimeout(timer) };
}
async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, timeout: Promise<never>): Promise<Uint8Array> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new UpstreamFailure(null, null, 'Weather upstream response exceeds its size limit.');
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function metadata(key: WeatherResourceKey, checked: number, previous?: WeatherResourceEnvelope, unchanged = false): { fetchedAt: string; checkedAt: string; refreshAfter: string; staleUntil: string } {
  const fetchedAt = unchanged && previous ? previous.metadata.fetchedAt : new Date(checked).toISOString();
  const interval = key.startsWith('winds:') ? 3_600_000 : 86_400_000;
  return { fetchedAt, checkedAt: new Date(checked).toISOString(), refreshAfter: new Date(checked + interval).toISOString(), staleUntil: new Date(checked + interval + 120_000).toISOString() };
}
/** The optional prior envelope is server-owned and lets identical checks retain fetchedAt. */
// eslint-disable-next-line complexity -- One bounded request path keeps status, timeout, and validation failures within one cleanup scope.
export async function fetchWeatherResource(key: WeatherResourceKey, fetchedAtMs: number, fetcher: ServiceFetcher, previous?: WeatherResourceEnvelope, checkedAtMs = fetchedAtMs): Promise<WeatherResourceEnvelope> {
  if (!Number.isSafeInteger(fetchedAtMs) || fetchedAtMs < 0 || !Number.isSafeInteger(checkedAtMs) || checkedAtMs < fetchedAtMs) throw new TypeError('Invalid fetch timestamp.');
  const { url, accept, limit, gzip } = requestFor(key);
  const controller = new AbortController(); const timeout = timeoutSignal(controller);
  try {
    const request = new Request(url, { method: 'GET', redirect: 'manual', headers: { Accept: accept, 'User-Agent': USER_AGENT }, signal: controller.signal });
    const response = await Promise.race([fetcher.fetch(request), timeout.promise]);
    if (response.status === 204) throw new UpstreamFailure(204, null, 'No weather data is available.');
    if (response.status === 429) throw new UpstreamFailure(429, response.headers.get('Retry-After'));
    if (response.status >= 300 && response.status < 400) throw new UpstreamFailure(response.status, null, 'Weather upstream redirect rejected.');
    if (!response.ok) throw new UpstreamFailure(response.status, null);
    let stream = response.body;
    if (!stream) throw new UpstreamFailure(response.status, null, 'Weather upstream response body is empty.');
    if (gzip) {
      const compressed = await readBounded(stream, CATALOG_COMPRESSED_LIMIT, timeout.promise);
      stream = new Blob([Uint8Array.from(compressed).buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    }
    const bytes = await readBounded(stream, gzip ? CATALOG_INFLATED_LIMIT : limit, timeout.promise);
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (key === 'station-catalog:v1') {
      let json: unknown;
      try { json = JSON.parse(decoded); } catch { throw new UpstreamFailure(response.status, null, 'Invalid station catalog JSON.'); }
      const parsed = parseStationCatalog(json, new Date(checkedAtMs));
      const unchanged = previous?.kind === 'catalog' && JSON.stringify(previous.entries) === JSON.stringify(parsed.entries);
      const envelope: CatalogResourceEnvelope = { kind: 'catalog', key, metadata: metadata(key, checkedAtMs, previous, unchanged), entries: parsed.entries };
      return envelope;
    }
    const [, , cycle] = /^winds:(us|alaska|hawaii):(06|12|24)$/.exec(key)!;
    const rawProduct = decoded;
    const forecasts = decodeWindsProduct(rawProduct, cycle as WindsForecastCycle, new Date(checkedAtMs));
    const unchanged = previous?.kind === 'winds' && previous.rawProduct === rawProduct;
    return { kind: 'winds', key: key as `winds:${WindsRegion}:${WindsForecastCycle}`, metadata: metadata(key, checkedAtMs, previous, unchanged), rawProduct, forecasts } satisfies WindsResourceEnvelope;
  } finally { timeout.clear(); }
}
