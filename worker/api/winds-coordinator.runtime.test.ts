import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
const miniflarePackage = 'miniflare';
const { Miniflare } = await import(miniflarePackage);
interface WorkerFetcher { fetch(url: string, init?: RequestInit): Promise<Response>; }
interface Runtime { dispatchFetch(url: string, init?: RequestInit): Promise<Response>; getWorker(name: string): Promise<WorkerFetcher>; dispose(): Promise<void>; }
let runtime: Runtime;
let coordinator: WorkerFetcher;
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
      { name: 'navlog', scriptPath: navlogBundle, modules: true, compatibilityDate: '2026-07-30', bindings: { APP_ENV: 'development' }, serviceBindings: { AWC_COORDINATOR_API: 'weather-coordinator' } },
      { name: 'weather-coordinator', scriptPath: coordinatorBundle, modules: true, compatibilityDate: '2026-07-30', durableObjects: { WEATHER_BUDGET: { className: 'WeatherBudgetCoordinator', useSQLite: true, unsafeUniqueKey: 'awc-budget-v1' } } }
    ],
    defaultWorker: 'navlog',
    durableObjectsPersist: join(tempDir, 'do')
  }) as Runtime;
  coordinator = await runtime.getWorker('weather-coordinator');
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
    const payload = await response.json() as { stations: Array<{ id: string }>; provenance: Array<{ cache: { key: string } }>; catalog: { cache: { key: string; checkedAt: string; refreshAfter: string; staleUntil: string } } };
    expect(payload.stations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'ABC' })]));
    expect(payload.provenance.map((item) => item.cache.key)).toEqual(expect.arrayContaining(['winds:us:06', 'winds:us:12', 'winds:us:24']));
    expect(payload.catalog.cache).toMatchObject({ key: 'station-catalog:v1', checkedAt: expect.any(String), refreshAfter: expect.any(String), staleUntil: expect.any(String) });
    const afterFirst = await calls();
    expect(afterFirst).toBe(4);
    expect((await runtime.dispatchFetch(url)).status).toBe(200);
    expect(await calls()).toBe(afterFirst);
  });
});
