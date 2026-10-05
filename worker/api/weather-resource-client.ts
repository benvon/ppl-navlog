import { ApiError } from './errors';
import type { ServiceFetcher, CacheStore } from './winds';
import { isWeatherResourceEnvelope, isWeatherResourceResult, parseResourceKey } from '../weather-resources/validation';
import type { WeatherResourceDelivery, WeatherResourceKey, WeatherResourcePort, WeatherResourceResult } from '../weather-resources/contracts';

const PRIVATE_COORDINATOR_URL = 'https://weather-coordinator.internal/resource';
const EDGE_CACHE_ROOT = 'https://ppl-navlog-cache.invalid/weather-resource/v1';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const COORDINATOR_TIMEOUT_MS = 15_000;
interface RequestDeadline { readonly wallAt: number; readonly monotonicAt: number; readonly now: () => Date; }

function remainingMs(deadline: RequestDeadline): number {
  return Math.min(deadline.wallAt - deadline.now().getTime(), deadline.monotonicAt - performance.now());
}

function deadlineError(): ApiError { return new ApiError('Weather coordinator is temporarily unavailable.', 503, 'service_unavailable'); }

async function beforeDeadline<T>(operation: Promise<T>, deadline: RequestDeadline, onTimeout?: () => void): Promise<T> {
  const observed = Promise.resolve(operation);
  const remaining = remainingMs(deadline);
  if (remaining <= 0) { void observed.catch(() => undefined); try { onTimeout?.(); } catch { /* Deadline cleanup is best effort. */ } throw deadlineError(); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { try { onTimeout?.(); } catch { /* Deadline cleanup is best effort. */ } reject(deadlineError()); }, remaining);
  });
  try { return await Promise.race([observed, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

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

async function readEdgeResource(cache: CacheStore | undefined, request: Request, key: WeatherResourceKey, deadline: RequestDeadline): Promise<WeatherResourceDelivery | undefined> {
  if (!cache) return undefined;
  try {
    const response = await beforeDeadline(cache.match(request), deadline);
    if (!response) return undefined;
    const body = await readResponseText(response, MAX_RESPONSE_BYTES, deadline);
    const value: unknown = JSON.parse(body);
    if (isWeatherResourceEnvelope(value) && value.key === key && freshUntil(value, deadline.now())) return { ok: true, resource: value, state: 'fresh', source: 'edge' };
  } catch { recordOutcome(key, 'cache_read_fault'); }
  return undefined;
}

async function readResponseText(response: Response, maxBytes: number, deadline: RequestDeadline): Promise<string> {
  const declared = Number.parseInt(response.headers.get('Content-Length') ?? '0', 10);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('upstream body exceeds limit');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let releaseWhenSettled = false;
  try {
    while (true) {
      pendingRead = reader.read();
      const next = await beforeDeadline(pendingRead, deadline, () => {
        releaseWhenSettled = true;
        void reader.cancel().catch(() => undefined);
        void pendingRead?.then(() => reader.releaseLock(), () => reader.releaseLock());
      });
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) { void reader.cancel().catch(() => undefined); throw new Error('upstream body exceeds limit'); }
      chunks.push(next.value);
    }
  } catch (error) {
    if (!releaseWhenSettled) {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    throw error;
  }
  if (!releaseWhenSettled) reader.releaseLock();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
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

async function requestCoordinator(fetcher: ServiceFetcher, key: WeatherResourceKey, deadline: RequestDeadline): Promise<WeatherResourceResult> {
  const controller = new AbortController();
  let response: Response | undefined;
  try {
    const request = new Request(PRIVATE_COORDINATOR_URL, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ resource: key }), signal: controller.signal });
    const fetchPromise = Promise.resolve().then(() => fetcher.fetch(request));
    try { response = await beforeDeadline(fetchPromise, deadline, () => controller.abort()); }
    catch (error) {
      void fetchPromise.then((lateResponse) => { void lateResponse.body?.cancel().catch(() => undefined); }, () => undefined);
      throw error;
    }
    const text = await readResponseText(response, MAX_RESPONSE_BYTES, deadline);
    return validateCoordinatorResponse(response, text, key, deadline.now);
  } catch (error) {
    controller.abort();
    if (response?.body) void response.body.cancel().catch(() => undefined);
    throw error;
  }
}

export function createWeatherResourceClient(
  fetcher: ServiceFetcher,
  cache: CacheStore | undefined,
  environment: 'development' | 'production',
  now: () => Date = () => new Date(),
  waitUntil?: (promise: Promise<unknown>) => void
): WeatherResourcePort {
  // The client is constructed once per public API request, so all resources
  // share the same absolute 15-second coordinator wait budget.
  const deadline: RequestDeadline = { wallAt: now().getTime() + COORDINATOR_TIMEOUT_MS, monotonicAt: performance.now() + COORDINATOR_TIMEOUT_MS, now };
  return {
    async getResource(key) {
      const resourceKey = parseResourceKey(key);
      const cacheKey = edgeRequest(environment, resourceKey);
      const cached = await readEdgeResource(cache, cacheKey, resourceKey, deadline);
      if (cached?.ok) { recordOutcome(resourceKey, 'edge_hit'); return cached; }
      if (remainingMs(deadline) <= 0) throw deadlineError();
      return fetchCoordinatorResource(fetcher, cache, cacheKey, resourceKey, deadline, now, waitUntil);
    }
  };
}

async function fetchCoordinatorResource(fetcher: ServiceFetcher, cache: CacheStore | undefined, cacheKey: Request, key: WeatherResourceKey, deadline: RequestDeadline, now: () => Date, waitUntil?: (promise: Promise<unknown>) => void): Promise<WeatherResourceDelivery> {
  const startedAt = now().getTime();
  try {
    const result = await requestCoordinator(fetcher, key, deadline);
    if (!result.ok) throw apiFailure(result);
    if (result.state === 'fresh' && freshUntil(result.resource, now()) && cache) cacheFreshResource(cache, cacheKey, key, result.resource, deadline, waitUntil);
    recordOutcome(key, result.state === 'grace' ? 'coordinator_grace' : 'coordinator_fresh', now().getTime() - startedAt);
    return { ...result, source: 'coordinator' };
  } catch (error) {
    recordOutcome(key, 'coordinator_failure', now().getTime() - startedAt);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Weather coordinator is temporarily unavailable.', 503, 'service_unavailable');
  }
}

function cacheFreshResource(cache: CacheStore, request: Request, key: WeatherResourceKey, resource: Extract<WeatherResourceResult, { ok: true }>['resource'], deadline: RequestDeadline, waitUntil?: (promise: Promise<unknown>) => void): void {
  const maxAgeSeconds = Math.max(0, Math.floor((Date.parse(resource.metadata.refreshAfter) - deadline.now().getTime()) / 1_000));
  const response = Response.json(resource, { headers: { 'Cache-Control': `public, max-age=${maxAgeSeconds}` } });
  try {
    const write = Promise.resolve().then(() => cache.put(request, response));
    const background = beforeDeadline(write, deadline, () => { void response.body?.cancel().catch(() => undefined); })
      .catch(() => { recordOutcome(key, 'cache_write_fault'); });
    if (waitUntil) waitUntil(background);
    else void background;
  } catch { recordOutcome(key, 'cache_write_fault'); }
}
