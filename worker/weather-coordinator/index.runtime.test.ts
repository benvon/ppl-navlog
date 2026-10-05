import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
const miniflarePackage = 'miniflare';
const { Miniflare } = await import(miniflarePackage);
interface Runtime { dispatchFetch(url: string, init?: RequestInit): Promise<Response>; dispose(): Promise<void>; }
let mf: Runtime;
let tempDir: string;
async function createRuntime(): Promise<Runtime> {
  const outfile = join(tempDir, 'worker.mjs');
  if (!(await stat(outfile).catch(() => undefined))) await build({ entryPoints: ['worker/weather-coordinator/runtime-harness.ts'], outfile, bundle: true, format: 'esm', platform: 'browser', target: 'es2022' });
  return new Miniflare({ scriptPath: outfile, modules: true, durableObjects: { WEATHER_BUDGET: { className: 'WeatherBudgetCoordinator', useSQLite: true, unsafeUniqueKey: 'awc-budget-v1' } }, compatibilityDate: '2026-07-30', durableObjectsPersist: join(tempDir, 'do') }) as Runtime;
}
beforeAll(async () => {
  tempDir = await mkdtemp(join(process.cwd(), '.weather-coordinator-test-'));
  const outfile = join(tempDir, 'worker.mjs');
  await build({ entryPoints: ['worker/weather-coordinator/runtime-harness.ts'], outfile, bundle: true, format: 'esm', platform: 'browser', target: 'es2022' });
  mf = await createRuntime();
});
afterAll(async () => { await mf?.dispose(); if (tempDir) await rm(tempDir, { recursive: true, force: true }); });
const privateRequest = (body: string, init: RequestInit = {}) => mf.dispatchFetch(`https://weather-coordinator.internal/resource`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, ...init });
describe('weather coordinator Worker and SQLite object in workerd', () => {
  it('rejects invalid protocol before accessing the object', async () => {
    expect((await mf.dispatchFetch('https://weather-coordinator.internal/resource?x=1', { method: 'POST', body: '{' })).status).toBe(400);
    expect((await mf.dispatchFetch('https://weather-coordinator.internal/other', { method: 'POST', body: '{' })).status).toBe(404);
    expect((await privateRequest('{"resource":"winds:us:06","extra":true}')).status).toBe(400);
    expect((await mf.dispatchFetch('https://weather-coordinator.internal/resource', { method: 'GET' })).status).toBe(405);
    expect((await privateRequest(`{"resource":"winds:us:06","padding":"${'x'.repeat(300)}"}`)).status).toBe(400);
    expect((await (await mf.dispatchFetch('https://weather-coordinator.internal/_test/upstream-count')).json() as { count: number }).count).toBe(0);
  });
  it('serves one upstream result to concurrent callers', async () => {
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/provider?mode=blocked');
    const requests = Array.from({ length: 6 }, () => privateRequest('{"resource":"winds:us:06"}'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const beforeRelease = await (await mf.dispatchFetch('https://weather-coordinator.internal/_test/upstream-count')).json() as { count: number };
    expect(beforeRelease.count).toBe(1);
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/release');
    const responses = await Promise.all(requests);
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/provider?mode=ok');
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(new Set(await Promise.all(responses.map(async (response) => await response.text()))).size).toBe(1);
    const before = await (await mf.dispatchFetch('https://weather-coordinator.internal/_test/upstream-count')).json() as { count: number };
    const cached = await privateRequest('{"resource":"winds:us:06"}');
    expect(cached.status).toBe(200);
    const after = await (await mf.dispatchFetch('https://weather-coordinator.internal/_test/upstream-count')).json() as { count: number };
    expect(after.count).toBe(before.count);
  });
  it('uses a fresh trusted clock after the awaited SQLite resource read', async () => {
    const body = await (await privateRequest('{"resource":"winds:us:06"}')).json() as { resource: { metadata: { refreshAfter: string } } };
    const deadline = Date.parse(body.resource.metadata.refreshAfter);
    const current = await (await mf.dispatchFetch('https://weather-coordinator.internal/_test/advance?ms=0')).json() as { now: number };
    await mf.dispatchFetch(`https://weather-coordinator.internal/_test/advance?ms=${deadline - current.now + 1}`);
    await mf.dispatchFetch(`https://weather-coordinator.internal/_test/clock-sequence?first=${deadline - 1}`);
    const before = await (await mf.dispatchFetch('https://weather-coordinator.internal/_test/upstream-count')).json() as { count: number };
    const checked = await privateRequest('{"resource":"winds:us:06"}');
    expect((await checked.json() as { ok: boolean }).ok).toBe(true);
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/clock-sequence');
    const after = await (await mf.dispatchFetch('https://weather-coordinator.internal/_test/upstream-count')).json() as { count: number };
    expect(after.count).toBe(before.count + 1);
  });
  it('rechecks cached eligibility at final response assembly', async () => {
    const currentResource = await (await privateRequest('{"resource":"winds:us:06"}')).json() as { resource: { metadata: { refreshAfter: string; staleUntil: string } } };
    const beforeDeadline = Date.parse(currentResource.resource.metadata.refreshAfter) - 1;
    const current = await (await mf.dispatchFetch('https://weather-coordinator.internal/_test/advance?ms=0')).json() as { now: number };
    await mf.dispatchFetch(`https://weather-coordinator.internal/_test/advance?ms=${Date.parse(currentResource.resource.metadata.staleUntil) - current.now + 1}`);
    await mf.dispatchFetch(`https://weather-coordinator.internal/_test/clock-sequence?first=${beforeDeadline}&second=${beforeDeadline}`);
    const response = await (await privateRequest('{"resource":"winds:us:06"}')).json() as { ok: boolean };
    expect(response.ok).toBe(false);
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/clock-sequence');
  });
  it('serves grace only inside its original deadline and preserves fetchedAt on identical revalidation', async () => {
    const resourceKey = 'winds:hawaii:12';
    const first = await privateRequest(JSON.stringify({ resource: resourceKey }));
    const original = await first.json() as { ok: true; resource: { metadata: { fetchedAt: string; checkedAt: string; refreshAfter: string; staleUntil: string } } };
    const checked = Date.parse(original.resource.metadata.refreshAfter) - 3_600_000;
    await mf.dispatchFetch(`https://weather-coordinator.internal/_test/advance?ms=${Date.parse(original.resource.metadata.refreshAfter) - checked}`);
    const same = await (await privateRequest(JSON.stringify({ resource: resourceKey }))).json() as typeof original;
    expect(same.resource.metadata.fetchedAt).toBe(original.resource.metadata.fetchedAt);
    await mf.dispatchFetch(`https://weather-coordinator.internal/_test/advance?ms=${Date.parse(same.resource.metadata.refreshAfter) - Date.parse(same.resource.metadata.checkedAt)}`);
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/provider?mode=fail');
    const failed = await (await privateRequest(JSON.stringify({ resource: resourceKey }))).json() as { ok: boolean; state?: string };
    expect(failed).toMatchObject({ ok: true, state: 'grace' });
    await mf.dispatchFetch(`https://weather-coordinator.internal/_test/advance?ms=${Date.parse(same.resource.metadata.staleUntil) - Date.parse(same.resource.metadata.refreshAfter) + 1}`);
    const expired = await (await privateRequest(JSON.stringify({ resource: resourceKey }))).json() as { ok: boolean };
    expect(expired.ok).toBe(false);

    const lateKey = 'winds:hawaii:24';
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/provider?mode=ok');
    const lateInitial = await (await privateRequest(JSON.stringify({ resource: lateKey }))).json() as typeof original;
    await mf.dispatchFetch(`https://weather-coordinator.internal/_test/advance?ms=${Date.parse(lateInitial.resource.metadata.refreshAfter) - Date.parse(lateInitial.resource.metadata.checkedAt)}`);
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/provider?mode=blocked-fail');
    const lateResponse = privateRequest(JSON.stringify({ resource: lateKey }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await mf.dispatchFetch(`https://weather-coordinator.internal/_test/advance?ms=${Date.parse(lateInitial.resource.metadata.staleUntil) - Date.parse(lateInitial.resource.metadata.refreshAfter) + 1}`);
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/release');
    const late = await (await lateResponse).json() as { ok: boolean };
    expect(late.ok).toBe(false);
  });
  it('applies provider cooldown to new dispatches while retaining fresh hits', async () => {
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/provider?mode=ok');
    expect((await privateRequest('{"resource":"winds:alaska:06"}')).status).toBe(200);
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/provider?mode=429');
    const limited = await privateRequest('{"resource":"winds:alaska:12"}');
    expect(limited.status).toBe(200);
    expect((await limited.json() as { ok: boolean }).ok).toBe(false);
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/provider?mode=ok');
    expect((await privateRequest('{"resource":"winds:hawaii:06"}')).status).toBe(200);
    expect((await privateRequest('{"resource":"winds:alaska:06"}')).status).toBe(200);
  });
  it('does not let concurrent success clear provider cooldown', async () => {
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/provider?mode=race');
    const success = privateRequest('{"resource":"winds:us:12"}');
    const limited = await privateRequest('{"resource":"winds:us:24"}');
    expect((await limited.json() as { ok: boolean }).ok).toBe(false);
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/release');
    expect((await success).status).toBe(200);
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/provider?mode=ok');
    const blocked = await (await privateRequest('{"resource":"winds:us:06"}')).json() as { ok: boolean };
    expect(blocked.ok).toBe(false);
  });
  it('advances per-resource failure cooldown through 60, 120, then 300 seconds', async () => {
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/advance?ms=61000');
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/provider?mode=fail');
    const key = 'winds:us:24';
    for (const expectedSeconds of [60, 120, 300, 300]) {
      const before = await (await mf.dispatchFetch('https://weather-coordinator.internal/_test/advance?ms=0')).json() as { now: number };
      const result = await (await privateRequest(JSON.stringify({ resource: key }))).json() as { ok: boolean; retryAt: string };
      expect(result.ok).toBe(false);
      expect(Date.parse(result.retryAt) - before.now).toBe(expectedSeconds * 1_000);
      await mf.dispatchFetch(`https://weather-coordinator.internal/_test/advance?ms=${expectedSeconds * 1_000 + 1}`);
    }
  });
  it('bounds the real HTTP queue to two starts and expires queued jobs after ten seconds', async () => {
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/advance?ms=86401000');
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/provider?mode=blocked');
    const keys = ['winds:us:06', 'winds:us:12', 'winds:us:24', 'winds:alaska:06', 'winds:alaska:12', 'winds:alaska:24', 'winds:hawaii:06', 'winds:hawaii:12', 'winds:hawaii:24', 'station-catalog:v1'];
    const before = await (await mf.dispatchFetch('https://weather-coordinator.internal/_test/upstream-count')).json() as { count: number };
    const requests = keys.map((resource) => privateRequest(JSON.stringify({ resource })));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const activeStarts = await (await mf.dispatchFetch('https://weather-coordinator.internal/_test/upstream-count')).json() as { count: number };
    expect(activeStarts.count - before.count).toBe(2);
    const queuedResults = await Promise.all(requests.slice(2));
    expect(queuedResults.every((response) => response.status === 200)).toBe(true);
    expect((await Promise.all(queuedResults.map(async (response) => await response.json() as { ok: boolean }))).every((result) => !result.ok)).toBe(true);
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/release');
    expect((await Promise.all(requests.slice(0, 2))).every((response) => response.status === 200)).toBe(true);
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/provider?mode=ok');
    const recovered = await privateRequest('{"resource":"winds:alaska:06"}');
    expect((await recovered.json() as { ok: boolean }).ok).toBe(true);
    const total = await (await mf.dispatchFetch('https://weather-coordinator.internal/_test/upstream-count')).json() as { count: number };
    expect(total.count).toBe(activeStarts.count + 1);
  }, 30_000);
  it('bounds waiting callers at 64 and releases aborted waiters while owner work continues', async () => {
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/advance?ms=61000');
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/provider?mode=blocked');
    const callers = Array.from({ length: 64 }, () => privateRequest('{"resource":"winds:alaska:24"}'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const excess = await privateRequest('{"resource":"winds:alaska:24"}');
    expect((await excess.json() as { ok: boolean }).ok).toBe(false);
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/release');
    expect((await Promise.all(callers)).every((response) => response.status === 200)).toBe(true);

    await mf.dispatchFetch('https://weather-coordinator.internal/_test/provider?mode=blocked');
    const controller = new AbortController();
    const canceledCaller = privateRequest('{"resource":"winds:hawaii:24"}', { signal: controller.signal }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await canceledCaller;
    const remainingWaiters = Array.from({ length: 64 }, () => privateRequest('{"resource":"winds:hawaii:24"}'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/release');
    expect((await Promise.all(remainingWaiters)).every((response) => response.status === 200)).toBe(true);
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/provider?mode=ok');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const fresh = await privateRequest('{"resource":"winds:hawaii:24"}');
    expect((await fresh.json() as { ok: boolean; state?: string })).toMatchObject({ ok: true, state: 'fresh' });
  }, 30_000);
  it('recovers an abandoned lease after a SQLite object restart', async () => {
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/provider?mode=blocked');
    const pending = privateRequest('{"resource":"winds:hawaii:12"}').catch(() => new Response(null, { status: 499 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await mf.dispose();
    mf = await createRuntime();
    await mf.dispatchFetch('https://weather-coordinator.internal/_test/advance?ms=10831000');
    let recovered = await (await privateRequest('{"resource":"winds:hawaii:12"}')).json() as { ok: boolean; retryAt?: string };
    expect(recovered.ok).toBe(false);
    for (let attempt = 0; attempt < 3 && !recovered.ok; attempt += 1) {
      const current = await (await mf.dispatchFetch('https://weather-coordinator.internal/_test/advance?ms=0')).json() as { now: number };
      const target = Date.parse(recovered.retryAt ?? '') || current.now + 60_000;
      await mf.dispatchFetch(`https://weather-coordinator.internal/_test/advance?ms=${Math.max(1, target - current.now + 1)}`);
      recovered = await (await privateRequest('{"resource":"winds:hawaii:12"}')).json() as { ok: boolean; retryAt?: string };
    }
    expect(recovered.ok).toBe(true);
    void pending;
  });
});
