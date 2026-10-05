import type { WeatherResourceEnvelope, WeatherResourceKey, WeatherResourceResult } from '../weather-resources/contracts';
import { resourceEligibility, parseRetryAfter } from '../weather-resources/policy';
import { parseResourceKey } from '../weather-resources/validation';
import { WeatherBudgetStore, type StoreStorage } from './store';
import { fetchWeatherResource, UpstreamFailure } from './upstream';
import { RefreshQueue } from './queue';

const PRIVATE_URL = 'https://weather-coordinator.internal/resource';
const OBJECT_NAME = 'awc-budget-v1';
const MAX_WAITERS = 64;
const CALLER_WAIT_MS = 15_000;
const PRIVATE_BODY_LIMIT = 256;
const PRIVATE_BODY_TIMEOUT_MS = 1_000;
type CoordinatorState = { storage: StoreStorage; waitUntil(promise: Promise<unknown>): void };
type CoordinatorEnv = Record<string, never>;
export type Outcome = { result?: WeatherResourceEnvelope; retryAtMs?: number; code?: 'service_unavailable' | 'upstream_unavailable'; callerEnded?: true };
const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
function safeRetryAt(value: number | undefined): string {
  const fallback = Math.min(253_402_300_799_000, Date.now() + 86_400_000);
  const date = value === undefined || !Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime()) ? fallback : value;
  return new Date(date).toISOString();
}
function unavailable(code: 'service_unavailable' | 'upstream_unavailable', retryAtMs?: number): WeatherResourceResult {
  return { ok: false, code, retryAt: safeRetryAt(retryAtMs) };
}
export async function waitForRefreshOwner(owner: Promise<Outcome>, signal?: AbortSignal): Promise<Outcome> {
  let abort!: () => void;
  let waitTimer: ReturnType<typeof setTimeout>;
  const callerEnded = new Promise<Outcome>((resolve) => {
    const finish = (): void => { clearTimeout(waitTimer); signal?.removeEventListener('abort', onAbort); resolve({ callerEnded: true, code: 'service_unavailable', retryAtMs: Date.now() + 60_000 }); };
    const onAbort = (): void => finish();
    abort = onAbort;
    waitTimer = setTimeout(finish, CALLER_WAIT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) finish();
  });
  try { return await Promise.race([owner, callerEnded]); }
  catch { return { code: 'service_unavailable', retryAtMs: Date.now() + 60_000 }; }
  finally { clearTimeout(waitTimer!); signal?.removeEventListener('abort', abort); }
}
export function assembleWaiterResult(outcome: Outcome, previous: WeatherResourceEnvelope | undefined, now: number): WeatherResourceResult {
  if (outcome.callerEnded) return unavailable(outcome.code ?? 'service_unavailable', outcome.retryAtMs);
  const candidate = outcome.result ?? previous;
  if (candidate && Date.parse(candidate.metadata.checkedAt) <= now) {
    const state = resourceEligibility(candidate.metadata, now);
    if (state !== 'expired') return { ok: true, resource: candidate, state };
  }
  return unavailable(outcome.code ?? 'upstream_unavailable', outcome.retryAtMs);
}
function validatePrivateRequest(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (url.origin !== new URL(PRIVATE_URL).origin) return json({ ok: false, code: 'service_unavailable' }, 400);
  if (request.method !== 'POST') return json({ ok: false, code: 'service_unavailable' }, 405);
  if (url.pathname !== '/resource') return json({ ok: false, code: 'service_unavailable' }, 404);
  if (url.search || url.hash) return json({ ok: false, code: 'service_unavailable' }, 400);
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? '')) return json({ ok: false, code: 'service_unavailable' }, 400);
  return undefined;
}
async function readBoundedJson(request: Request): Promise<unknown> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > PRIVATE_BODY_LIMIT)) throw new TypeError('Invalid private request body.');
  if (!request.body) throw new TypeError('Invalid private request body.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TypeError('Private request body timed out.')), PRIVATE_BODY_TIMEOUT_MS); });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > PRIVATE_BODY_LIMIT) throw new TypeError('Invalid private request body.');
      chunks.push(part.value);
    }
  } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
  finally { clearTimeout(timer!); try { reader.releaseLock(); } catch { /* Pending stream reads are bounded by the deadline. */ } }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
async function readResourceKey(request: Request): Promise<WeatherResourceKey | Response> {
  const invalid = validatePrivateRequest(request);
  if (invalid) return invalid;
  try {
    const body: unknown = await readBoundedJson(request);
    if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'resource')) return json({ ok: false, code: 'service_unavailable' }, 400);
    return parseResourceKey((body as { resource: unknown }).resource);
  } catch { return json({ ok: false, code: 'service_unavailable' }, 400); }
}

/** One durable coordinator owns reservations, upstream I/O, joins, and response eligibility. */
export class WeatherBudgetCoordinator {
  private readonly store: WeatherBudgetStore;
  private readonly queue = new RefreshQueue(2, 10, 10_000);
  private readonly jobs = new Map<WeatherResourceKey, Promise<Outcome>>();
  private readonly waiters = new Map<WeatherResourceKey, number>();
  private totalWaiters = 0;
  constructor(private readonly ctx: CoordinatorState, _env: CoordinatorEnv) { this.store = new WeatherBudgetStore(ctx.storage); }
  async fetch(request: Request): Promise<Response> {
    const key = await readResourceKey(request);
    if (key instanceof Response) return key;
    try { return json(this.finalizeResponse(await this.getResource(key, request.signal))); }
    catch { return json(unavailable('service_unavailable', Date.now() + 60_000), 503); }
  }
  async getResource(key: WeatherResourceKey, signal?: AbortSignal): Promise<WeatherResourceResult> {
    const observedAt = Date.now();
    if (!Number.isSafeInteger(observedAt)) return unavailable('service_unavailable', observedAt + 60_000);
    let previous: WeatherResourceEnvelope | undefined;
    try { previous = await this.store.readResource(key); }
    catch { return unavailable('service_unavailable', Date.now() + 60_000); }
    const now = Date.now();
    if (!Number.isSafeInteger(now)) return unavailable('service_unavailable', now + 60_000);
    if (previous && Date.parse(previous.metadata.checkedAt) <= now && resourceEligibility(previous.metadata, now) === 'fresh') return this.finalizeResponse({ ok: true, resource: previous, state: 'fresh' });
    if (signal?.aborted) return unavailable('service_unavailable', now + 60_000);
    if (this.totalWaiters >= MAX_WAITERS) { this.emit(key, 'waiter_denied', 0, 1); return unavailable('service_unavailable', now + 60_000); }
    const job = this.getOrStartJob(key, previous);
    this.totalWaiters += 1;
    this.waiters.set(key, (this.waiters.get(key) ?? 0) + 1);
    const outcome = await waitForRefreshOwner(job, signal);
    this.releaseWaiter(key);
    return this.finalizeResponse(assembleWaiterResult(outcome, previous, Date.now()));
  }
  private getOrStartJob(key: WeatherResourceKey, previous?: WeatherResourceEnvelope): Promise<Outcome> {
    let job = this.jobs.get(key);
    if (!job) {
      job = this.queue.enqueue(key, async () => this.refresh(key, previous));
      this.jobs.set(key, job);
      void job.finally(() => { if (this.jobs.get(key) === job) this.jobs.delete(key); }).catch(() => undefined);
      this.ctx.waitUntil(job.then(() => undefined, () => undefined));
    }
    return job;
  }
  private releaseWaiter(key: WeatherResourceKey): void {
    this.totalWaiters -= 1;
    const remaining = (this.waiters.get(key) ?? 1) - 1;
    if (remaining > 0) this.waiters.set(key, remaining); else this.waiters.delete(key);
  }
  private finalizeResponse(result: WeatherResourceResult): WeatherResourceResult {
    if (!result.ok) return result;
    const now = Date.now();
    if (Date.parse(result.resource.metadata.checkedAt) > now) return unavailable('service_unavailable', now + 60_000);
    const state = resourceEligibility(result.resource.metadata, now);
    return state === 'expired' ? unavailable('upstream_unavailable', now + 60_000) : { ...result, state };
  }
  private emit(key: WeatherResourceKey, outcome: string, durationMs: number, denials: number): void {
    console.info('weather_coordinator', JSON.stringify({ resourceKind: key.startsWith('winds:') ? 'winds' : 'catalog', outcome, durationMs: Math.max(0, durationMs), joins: Math.max(0, (this.waiters.get(key) ?? 1) - 1), denials }));
  }
  private async refresh(key: WeatherResourceKey, previous?: WeatherResourceEnvelope): Promise<Outcome> {
    const startedAt = Date.now();
    const reservation = await this.reserveDispatch(key, startedAt);
    if ('outcome' in reservation) return reservation.outcome;
    try {
      const resource = await fetchWeatherResource(key, { fetch: (request) => fetch(request) }, previous);
      const published = await this.store.publishResource(key, reservation.generation, resource, Date.now());
      if (!published) return await this.recordFailure(key, reservation.generation, undefined, startedAt, 'publish_rejected');
      this.emit(key, 'success', Date.now() - startedAt, 0);
      return { result: resource };
    } catch (error) { return this.recordFailure(key, reservation.generation, error, startedAt); }
  }
  private async reserveDispatch(key: WeatherResourceKey, startedAt: number): Promise<{ generation: number } | { outcome: Outcome }> {
    try {
      const reservation = await this.store.reserveAttempt(key, Date.now());
      if (reservation.allowed) return { generation: reservation.generation };
      this.emit(key, 'dispatch_denied', Date.now() - startedAt, 1);
      return { outcome: { code: 'upstream_unavailable', retryAtMs: reservation.retryAtMs } };
    } catch {
      this.emit(key, 'storage_denied', Date.now() - startedAt, 1);
      return { outcome: { code: 'service_unavailable', retryAtMs: Date.now() + 60_000 } };
    }
  }
  private async recordFailure(key: WeatherResourceKey, generation: number, error: unknown, startedAt: number, outcome = 'failure'): Promise<Outcome> {
    const now = Date.now();
    const isProviderLimit = error instanceof UpstreamFailure && error.status === 429;
    const providerRetry = isProviderLimit ? parseRetryAfter(error.retryAfter, now) : undefined;
    try {
      await this.store.recordFailure(key, generation, now, providerRetry);
      const state = await this.store.readResourceState(key);
      const retryAtMs = providerRetry === 'operator_required' ? now + 86_400_000 : Math.max(state?.retryAtMs ?? now + 60_000, typeof providerRetry === 'number' ? providerRetry : 0);
      this.emit(key, isProviderLimit ? 'provider_cooldown' : outcome, now - startedAt, 0);
      return { code: 'upstream_unavailable', retryAtMs };
    } catch {
      this.emit(key, 'storage_failure', now - startedAt, 1);
      return { code: 'service_unavailable', retryAtMs: now + 60_000 };
    }
  }
}

export default {
  async fetch(request: Request, env: { WEATHER_BUDGET: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }): Promise<Response> {
    const key = await readResourceKey(request);
    if (key instanceof Response) return key;
    const id = env.WEATHER_BUDGET.idFromName(OBJECT_NAME);
    return env.WEATHER_BUDGET.get(id).fetch(new Request(PRIVATE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resource: key }), signal: request.signal }));
  },
};
