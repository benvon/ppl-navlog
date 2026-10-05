import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
await import('../weather-coordinator/runtime-tooling');
const miniflarePackage = 'miniflare';
const { Miniflare } = await import(miniflarePackage);
interface WorkerFetcher { fetch(url: string, init?: RequestInit): Promise<Response>; }
interface Runtime { dispatchFetch(url: string, init?: RequestInit): Promise<Response>; getWorker(name: string): Promise<WorkerFetcher>; dispose(): Promise<void>; }
let runtime: Runtime;
let coordinator: WorkerFetcher;
let productionApi: WorkerFetcher;
let productionCoordinator: WorkerFetcher;
let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(process.cwd(), '.navlog-weather-test-'));
  const coordinatorBundle = join(tempDir, 'coordinator.mjs');
  const navlogBundle = join(tempDir, 'navlog.mjs');
  await Promise.all([
    build({ entryPoints: ['worker/weather-coordinator/runtime-harness.ts'], outfile: coordinatorBundle, bundle: true, format: 'esm', platform: 'browser', target: 'es2022' }),
    build({ entryPoints: ['worker/api/runtime-harness.ts'], outfile: navlogBundle, bundle: true, format: 'esm', platform: 'browser', target: 'es2022' })
  ]);
  runtime = new Miniflare({
    workers: [
      { name: 'navlog', scriptPath: navlogBundle, modules: true, compatibilityDate: '2026-09-21', bindings: { APP_ENV: 'development' }, serviceBindings: { AWC_COORDINATOR_API: 'weather-coordinator' } },
      { name: 'weather-coordinator', scriptPath: coordinatorBundle, modules: true, compatibilityDate: '2026-09-21', durableObjects: { WEATHER_BUDGET: { className: 'WeatherBudgetTestCoordinator', useSQLite: true, unsafeUniqueKey: 'awc-budget-v1' } } },
      { name: 'navlog-production', scriptPath: navlogBundle, modules: true, compatibilityDate: '2026-09-21', bindings: { APP_ENV: 'production' }, serviceBindings: { AWC_COORDINATOR_API: 'weather-coordinator-production' } },
      { name: 'weather-coordinator-production', scriptPath: coordinatorBundle, modules: true, compatibilityDate: '2026-09-21', durableObjects: { WEATHER_BUDGET: { className: 'WeatherBudgetTestCoordinator', useSQLite: true, unsafeUniqueKey: 'awc-budget-production-test-v1' } } }
    ],
    defaultWorker: 'navlog',
    durableObjectsPersist: join(tempDir, 'do')
  }) as Runtime;
  coordinator = await runtime.getWorker('weather-coordinator');
  productionApi = await runtime.getWorker('navlog-production');
  productionCoordinator = await runtime.getWorker('weather-coordinator-production');
});

afterAll(async () => { await runtime?.dispose(); if (tempDir) await rm(tempDir, { recursive: true, force: true }); });

describe('public navlog winds route through coordinator service binding and SQLite Durable Object', () => {
  it('validates public routes before coordinator work, then serves coordinator-backed winds and catalog with provenance', async () => {
    const coordinatorRequest = (path: string) => coordinator.fetch(`https://weather-coordinator.internal${path}`);
    const calls = async (): Promise<number> => (await (await coordinatorRequest('/_test/upstream-count')).json() as { count: number }).count;
    expect((await calls())).toBe(0);
    expect((await runtime.dispatchFetch('https://navlog.test/api/weather/winds/point')).status).toBe(400);
    expect((await runtime.dispatchFetch('https://navlog.test/api/weather/unknown')).status).toBe(404);
    expect((await runtime.dispatchFetch('https://navlog.test/api/weather/taf/KORD')).status).toBe(404);
    expect((await calls())).toBe(0);

    const url = 'https://navlog.test/api/weather/winds/stations?route=40%2C-100';
    const response = await runtime.dispatchFetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const payload = await response.json() as { stations: Array<{ id: string }>; provenance: Array<{ cache: { key: string } }>; catalog: { cache: { key: string; checkedAt: string; refreshAfter: string; staleUntil: string } } };
    expect(payload.stations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'ABC' })]));
    expect(payload.provenance.map((item) => item.cache.key)).toEqual(expect.arrayContaining(['winds:us:06', 'winds:us:12', 'winds:us:24']));
    expect(payload.catalog.cache).toMatchObject({ key: 'station-catalog:v1', checkedAt: expect.any(String), refreshAfter: expect.any(String), staleUntil: expect.any(String) });
    const afterFirst = await calls();
    expect(afterFirst).toBe(4);
    const resourceRequestsAfterFirst = await (await coordinator.fetch('https://weather-coordinator.internal/_test/resource-count')).json() as { count: number };
    expect((await runtime.dispatchFetch(url)).status).toBe(200);
    expect(await calls()).toBe(afterFirst);
    const resourceRequestsAfterSecond = await (await coordinator.fetch('https://weather-coordinator.internal/_test/resource-count')).json() as { count: number };
    expect(resourceRequestsAfterSecond.count).toBe(resourceRequestsAfterFirst.count);
  });

  it('multi_edge_fanout_obeys_each_application_budget', async () => {
    const route = 'https://navlog.test/api/weather/winds/stations?route=20%2C-155';
    const [developmentFirst, productionFirst] = await Promise.all([runtime.dispatchFetch(route), productionApi.fetch(route)]);
    expect(developmentFirst.status).toBe(200);
    expect(productionFirst.status).toBe(200);
    const count = async (worker: WorkerFetcher) => (await (await worker.fetch('https://weather-coordinator.internal/_test/upstream-count')).json() as { count: number }).count;
    const completedCount = async (worker: WorkerFetcher) => (await (await worker.fetch('https://weather-coordinator.internal/_test/upstream-completed-count')).json() as { count: number }).count;
    expect(await count(coordinator)).toBe(7);
    expect(await count(productionCoordinator)).toBe(4);

    const resource = (worker: WorkerFetcher, key: string) => worker.fetch('https://weather-coordinator.internal/resource', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resource: key }) });
    for (const worker of [coordinator, productionCoordinator]) {
      for (const cycle of ['06', '12']) expect(await (await resource(worker, `winds:alaska:${cycle}`)).json()).toMatchObject({ ok: true, state: 'fresh' });
    }

    const completedBeforeBlock = [await completedCount(coordinator), await completedCount(productionCoordinator)];
    await coordinator.fetch('https://weather-coordinator.internal/_test/provider?mode=blocked');
    await productionCoordinator.fetch('https://weather-coordinator.internal/_test/provider?mode=blocked');
    const fanout = [
      runtime.dispatchFetch('https://navlog.test/api/weather/winds/stations?route=60%2C-150'),
      runtime.dispatchFetch('https://navlog.test/api/weather/winds/stations?route=60%2C-150'),
      productionApi.fetch('https://navlog.test/api/weather/winds/stations?route=60%2C-150'),
      productionApi.fetch('https://navlog.test/api/weather/winds/stations?route=60%2C-150')
    ];
    const waitForCalls = async (worker: WorkerFetcher, target: number) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await count(worker) >= target) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Mock upstream did not reach ${target} calls.`);
    };
    await Promise.all([waitForCalls(coordinator, 10), waitForCalls(productionCoordinator, 7)]);
    expect(await count(coordinator)).toBe(10);
    expect(await count(productionCoordinator)).toBe(7);
    expect([await completedCount(coordinator), await completedCount(productionCoordinator)]).toEqual(completedBeforeBlock);
    await Promise.all([
      coordinator.fetch('https://weather-coordinator.internal/_test/release'),
      productionCoordinator.fetch('https://weather-coordinator.internal/_test/release')
    ]);
    expect((await Promise.all(fanout)).every((response) => response.status === 200)).toBe(true);
    expect(await count(coordinator)).toBe(10);
    expect(await count(productionCoordinator)).toBe(7);
    await Promise.all([
      coordinator.fetch('https://weather-coordinator.internal/_test/provider?mode=ok'),
      productionCoordinator.fetch('https://weather-coordinator.internal/_test/provider?mode=ok')
    ]);
  });

  it('dev_exhaustion_cannot_change_production_state', async () => {
    const route = 'https://navlog.test/api/weather/winds/stations?route=20%2C-155';
    const count = async (worker: WorkerFetcher) => (await (await worker.fetch('https://weather-coordinator.internal/_test/upstream-count')).json() as { count: number }).count;
    const completedCount = async (worker: WorkerFetcher) => (await (await worker.fetch('https://weather-coordinator.internal/_test/upstream-completed-count')).json() as { count: number }).count;
    const attemptsBeforeCatalogFailures = await count(coordinator);
    await coordinator.fetch('https://weather-coordinator.internal/_test/provider?mode=429');
    const advance = async (ms: number) => coordinator.fetch(`https://weather-coordinator.internal/_test/advance?ms=${ms}`);
    const catalogRequest = () => coordinator.fetch('https://weather-coordinator.internal/resource', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"resource":"station-catalog:v1"}' });
    await advance(86_520_001);
    expect(await (await catalogRequest()).json()).toMatchObject({ ok: false, code: 'upstream_unavailable' });
    const afterProviderLimit = await count(coordinator);
    expect(await (await catalogRequest()).json()).toMatchObject({ ok: false, code: 'upstream_unavailable' });
    expect(await count(coordinator)).toBe(afterProviderLimit);
    for (const cooldownMs of [121_000, 121_000, 300_000]) {
      await advance(cooldownMs);
      expect(await (await catalogRequest()).json()).toMatchObject({ ok: false, code: 'upstream_unavailable' });
    }
    const beforeDenied = await count(coordinator);
    expect(beforeDenied - attemptsBeforeCatalogFailures).toBe(4);
    await advance(300_000);
    expect(await (await catalogRequest()).json()).toMatchObject({ ok: false, code: 'upstream_unavailable' });
    expect(await count(coordinator)).toBe(beforeDenied);
    expect((await productionApi.fetch(route)).status).toBe(200);
    expect(await (await productionCoordinator.fetch('https://weather-coordinator.internal/resource', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"resource":"station-catalog:v1"}' })).json()).toMatchObject({ ok: true, state: 'fresh' });
  });
});
