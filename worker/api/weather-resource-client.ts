import { ApiError } from './errors';
import { readBoundedText } from './bounded-text';
import type { ServiceFetcher, CacheStore } from './winds';
import { isWeatherResourceEnvelope, isWeatherResourceResult, parseResourceKey } from '../weather-resources/validation';
import type { WeatherResourceDelivery, WeatherResourceKey, WeatherResourcePort, WeatherResourceResult } from '../weather-resources/contracts';

const PRIVATE_COORDINATOR_URL = 'https://weather-coordinator.internal/resource';
const EDGE_CACHE_ROOT = 'https://ppl-navlog-cache.invalid/weather-resource/v1';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const COORDINATOR_TIMEOUT_MS = 15_000;

function edgeRequest(environment: 'development' | 'production', key: WeatherResourceKey): Request {
  return new Request(`${EDGE_CACHE_ROOT}/${environment}/${key.replace(':', '/')}`);
}

function freshUntil(resource: { metadata: { checkedAt: string; refreshAfter: string } }, now: Date): boolean {
  const deadline = Date.parse(resource.metadata.refreshAfter);
  const checkedAt = Date.parse(resource.metadata.checkedAt);
  return Number.isFinite(deadline) && Number.isFinite(checkedAt) && checkedAt <= now.getTime() && now.getTime() < deadline;
}

function resourceKind(key: WeatherResourceKey): 'winds' | 'catalog' { return key === 'station-catalog:v1' ? 'catalog' : 'winds'; }
function recordOutcome(key: WeatherResourceKey, outcome: 'edge_hit' | 'cache_read_fault' | 'cache_write_fault' | 'coordinator_fresh' | 'coordinator_grace' | 'coordinator_failure', durationMs?: number): void {
  console.info('weather_resource', { kind: resourceKind(key), outcome, ...(durationMs === undefined ? {} : { durationMs: Math.max(0, Math.floor(durationMs)) }) });
}

function apiFailure(result: Extract<WeatherResourceResult, { ok: false }>): ApiError {
  const retryAt = Date.parse(result.retryAt);
  return new ApiError('Weather data is temporarily unavailable.', 503, result.code, undefined, Number.isFinite(retryAt) ? retryAt : undefined);
}

async function readEdgeResource(cache: CacheStore | undefined, request: Request, key: WeatherResourceKey, now: () => Date): Promise<WeatherResourceDelivery | undefined> {
  if (!cache) return undefined;
  try {
    const response = await cache.match(request);
    if (!response) return undefined;
    const body = await readBoundedText(response, MAX_RESPONSE_BYTES);
    const value: unknown = JSON.parse(body);
    if (isWeatherResourceEnvelope(value) && value.key === key && freshUntil(value, now())) return { ok: true, resource: value, state: 'fresh', source: 'edge' };
  } catch { recordOutcome(key, 'cache_read_fault'); }
  return undefined;
}

function validateCoordinatorResponse(response: Response, text: string, key: WeatherResourceKey, now: () => Date): WeatherResourceResult {
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { throw new ApiError('Weather coordinator returned an invalid response.', 503, 'service_unavailable'); }
  if (!isWeatherResourceResult(value)) throw new ApiError('Weather coordinator returned an invalid response.', 503, 'service_unavailable');
  if (!value.ok) throw apiFailure(value);
  if (response.status < 200 || response.status >= 300 || value.resource.key !== key || Date.parse(value.resource.metadata.checkedAt) > now().getTime()) throw new ApiError('Weather coordinator returned an invalid response.', 503, 'service_unavailable');
  return value;
}

async function requestCoordinator(fetcher: ServiceFetcher, key: WeatherResourceKey, remainingMs: number, now: () => Date): Promise<WeatherResourceResult> {
  const controller = new AbortController();
  let response: Response | undefined;
  let rejectDeadline: (reason: Error) => void = () => undefined;
  const deadlineExceeded = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const timeout = setTimeout(() => { controller.abort(); void response?.body?.cancel().catch(() => undefined); rejectDeadline(new Error('coordinator deadline exceeded')); }, remainingMs);
  try {
    const request = new Request(PRIVATE_COORDINATOR_URL, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ resource: key }), signal: controller.signal });
    response = await fetcher.fetch(request);
    const text = await Promise.race([readBoundedText(response, MAX_RESPONSE_BYTES), deadlineExceeded]);
    return validateCoordinatorResponse(response, text, key, now);
  } finally { clearTimeout(timeout); }
}

export function createWeatherResourceClient(
  fetcher: ServiceFetcher,
  cache: CacheStore | undefined,
  environment: 'development' | 'production',
  now: () => Date = () => new Date()
): WeatherResourcePort {
  // The client is constructed once per public API request, so all resources
  // share the same absolute 15-second coordinator wait budget.
  const deadline = now().getTime() + COORDINATOR_TIMEOUT_MS;
  return {
    async getResource(key) {
      const resourceKey = parseResourceKey(key);
      const cacheKey = edgeRequest(environment, resourceKey);
      const cached = await readEdgeResource(cache, cacheKey, resourceKey, now);
      if (cached?.ok) { recordOutcome(resourceKey, 'edge_hit'); return cached; }
      const remainingMs = deadline - now().getTime();
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new ApiError('Weather coordinator is temporarily unavailable.', 503, 'service_unavailable');
      return fetchCoordinatorResource(fetcher, cache, cacheKey, resourceKey, remainingMs, now);
    }
  };
}

async function fetchCoordinatorResource(fetcher: ServiceFetcher, cache: CacheStore | undefined, cacheKey: Request, key: WeatherResourceKey, remainingMs: number, now: () => Date): Promise<WeatherResourceDelivery> {
  const startedAt = now().getTime();
  try {
    const result = await requestCoordinator(fetcher, key, remainingMs, now);
    if (!result.ok) throw apiFailure(result);
    if (result.state === 'fresh' && freshUntil(result.resource, now()) && cache) await cacheFreshResource(cache, cacheKey, key, result.resource);
    recordOutcome(key, result.state === 'grace' ? 'coordinator_grace' : 'coordinator_fresh', now().getTime() - startedAt);
    return { ...result, source: 'coordinator' };
  } catch (error) {
    recordOutcome(key, 'coordinator_failure', now().getTime() - startedAt);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Weather coordinator is temporarily unavailable.', 503, 'service_unavailable');
  }
}

async function cacheFreshResource(cache: CacheStore, request: Request, key: WeatherResourceKey, resource: Extract<WeatherResourceResult, { ok: true }>['resource']): Promise<void> {
  try { await cache.put(request, Response.json(resource, { headers: { 'Cache-Control': 'private, max-age=3600' } })); }
  catch { recordOutcome(key, 'cache_write_fault'); }
}
