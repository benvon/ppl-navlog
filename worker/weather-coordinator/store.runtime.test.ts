import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
await import('./runtime-tooling');
const miniflarePackage = 'miniflare';
const { Miniflare } = await import(miniflarePackage);

interface Runtime { dispatchFetch(url: string, init: RequestInit): Promise<Response>; dispose(): Promise<void>; }
let mf: Runtime;
let tempDir: string;
async function call(op: string, key = 'winds:us:06', extra: Record<string, unknown> = {}) {
  const response = await mf.dispatchFetch('http://runtime.test/', { method: 'POST', body: JSON.stringify({ op, key, now: 1_800_000_000_000, ...extra }) });
  const body = await response.text();
  try { return JSON.parse(body) as Record<string, unknown>; } catch { throw new Error(body); }
}
beforeAll(async () => {
  tempDir = await mkdtemp(join(process.cwd(), '.weather-budget-test-'));
  const outfile = join(tempDir, 'worker.mjs');
  await build({ entryPoints: ['worker/weather-coordinator/test-harness.ts'], outfile, bundle: true, format: 'esm', platform: 'browser', target: 'es2022' });
  mf = new Miniflare({ scriptPath: outfile, modules: true, durableObjects: { STORE: { className: 'WeatherBudgetTestHarness', useSQLite: true, unsafeUniqueKey: 'weather-test-v1' } }, compatibilityDate: '2026-09-21', durableObjectsPersist: join(tempDir, 'do') }) as Runtime;
});
afterAll(async () => { await mf?.dispose(); if (tempDir) await rm(tempDir, { recursive: true, force: true }); });

describe('SQLite-backed weather budget in workerd', () => {
  it('atomic_reservations_obey_all_windows', async () => {
    const keys = ['winds:us:06','winds:us:12','winds:us:24','winds:alaska:06','winds:alaska:12','winds:alaska:24','winds:hawaii:06','winds:hawaii:12','winds:hawaii:24','station-catalog:v1'];
    const reservations = await Promise.all(keys.map((key) => call('reserve', key, { objectId: 101 })));
    expect(reservations.filter((item) => item.allowed === true)).toHaveLength(10);
    const metadata = await call('metadata', 'winds:us:06', { objectId: 101 });
    expect(metadata.attempts24h).toBe(10);
  });
  it('restart_preserves_attempts_and_expired_lease_cooldown', async () => {
    const reservation = await call('reserve', 'winds:alaska:12');
    expect(reservation.generation).toBe(1);
    await mf.dispose();
    mf = new Miniflare({ scriptPath: join(tempDir, 'worker.mjs'), modules: true, durableObjects: { STORE: { className: 'WeatherBudgetTestHarness', useSQLite: true, unsafeUniqueKey: 'weather-test-v1' } }, compatibilityDate: '2026-09-21', durableObjectsPersist: join(tempDir, 'do') }) as Runtime;
    const busy = await call('reserve', 'winds:alaska:12', { now: 1_800_000_031_000 });
    expect(busy.allowed).toBe(false);
    expect(busy.retryAtMs).toBe(1_800_000_091_000);
    expect((await call('state', 'winds:alaska:12')).generation).toBe(1);
  });

  it('per_key_window_denial_does_not_debit_again', async () => {
    const key = 'winds:hawaii:24'; const start = 1_800_100_000_000;
    for (let index = 0; index < 8; index += 1) {
      const now = start + index * 30_000;
      const reserved = await call('reserve', key, { now, objectId: 202 });
      expect(reserved.allowed).toBe(true);
      const resource = { kind: 'winds', key, metadata: { fetchedAt: new Date(now).toISOString(), checkedAt: new Date(now).toISOString(), refreshAfter: new Date(now + 3_600_000).toISOString(), staleUntil: new Date(now + 3_720_000).toISOString() }, rawProduct: 'same', forecasts: [{ stationId: 'ABC', forecastCycle: '24', issuedAt: new Date(now).toISOString(), validAt: new Date(now).toISOString(), useFrom: new Date(now).toISOString(), useUntil: new Date(now + 3_600_000).toISOString(), levels: [] }] };
      expect((await call('publish', key, { now, generation: Number(reserved.generation), resource, objectId: 202 })).published).toBe(true);
    }
    const denied = await call('reserve', key, { now: start + 8 * 30_000, objectId: 202 });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAtMs).toBe(start + 6 * 60 * 60_000);
    expect((await call('metadata', key, { now: start + 8 * 30_000, objectId: 202 })).attempts24h).toBe(8);
  });
  it('obsolete_generation_cannot_publish', async () => {
    const key = 'station-catalog:v1'; const start = 1_800_200_000_000;
    const first = await call('reserve', key, { now: start, objectId: 303 });
    const resource = { kind: 'catalog', key, metadata: { fetchedAt: new Date(start).toISOString(), checkedAt: new Date(start).toISOString(), refreshAfter: new Date(start + 86_400_000).toISOString(), staleUntil: new Date(start + 86_520_000).toISOString() }, entries: [{ iataId: 'ABC', info: { name: null, coordinates: { latitudeDeg: 1, longitudeDeg: 2 }, elevationFt: null } }] };
    expect((await call('publish', key, { now: start, generation: Number(first.generation), resource, objectId: 303 })).published).toBe(true);
    expect((await call('publish', key, { now: start, generation: 999, resource, objectId: 303 })).published).toBe(false);
    const late = { ...resource, metadata: { ...resource.metadata, checkedAt: new Date(start + 31_000).toISOString(), refreshAfter: new Date(start + 86_431_000).toISOString(), staleUntil: new Date(start + 86_551_000).toISOString() } };
    expect((await call('publish', key, { now: start + 31_000, generation: Number(first.generation), resource: late, objectId: 303 })).published).toBe(false);
    await call('corrupt', key, { objectId: 303 });
    expect((await call('read', key, { objectId: 303 })).resource).toBe(null);
  });


  it('operator_required_provider_cooldown_is_fail_closed', async () => {
    const start = 1_800_300_000_000;
    const a = await call('reserve', 'winds:us:12', { now: start, objectId: 404 });
    const b = await call('reserve', 'winds:alaska:12', { now: start, objectId: 404 });
    await call('fail', 'winds:us:12', { now: start + 1, generation: Number(a.generation), providerRetryAt: 'operator_required', objectId: 404 });
    await call('fail', 'winds:alaska:12', { now: start + 2, generation: Number(b.generation), providerRetryAt: start + 90_000, objectId: 404 });
    expect((await call('cooldown', 'winds:us:12', { objectId: 404 })).cooldown).toBe('operator_required');
    expect((await call('reserve', 'winds:hawaii:06', { now: start + 5, objectId: 404 })).allowed).toBe(false);
    expect((await call('metadata', 'winds:us:12', { objectId: 404 })).attempts24h).toBe(2);
  });


  it('storage_fault_denies_reservation_without_partial_debit', async () => {
    const key = 'winds:us:24'; const objectId = 505;
    await call('fault', key, { objectId });
    const failed = await mf.dispatchFetch('http://runtime.test/', { method: 'POST', body: JSON.stringify({ op: 'reserve', key, now: 1_800_400_000_000, objectId }) });
    expect(failed.status).toBe(500);
    expect((await call('metadata', key, { objectId })).attempts24h).toBe(0);
  });
  it('clock_regression_is_clamped_for_new_leases', async () => {
    const key = 'winds:hawaii:06'; const objectId = 606;
    await call('reserve', key, { now: 1_800_500_000_100, objectId });
    const next = await call('reserve', 'winds:hawaii:12', { now: 1_800_400_000_000, objectId });
    expect(next.allowed).toBe(true);
    expect((await call('state', 'winds:hawaii:12', { objectId })).leaseUntilMs).toBe(1_800_500_030_100);
  });


  it('publish_rejects_when_shared_clock_advanced_past_lease', async () => {
    const start = 1_800_600_000_000; const objectId = 707; const key = 'station-catalog:v1';
    const first = await call('reserve', key, { now: start, objectId });
    await call('reserve', 'winds:us:06', { now: start + 31_000, objectId });
    const resource = { kind: 'catalog', key, metadata: { fetchedAt: new Date(start).toISOString(), checkedAt: new Date(start).toISOString(), refreshAfter: new Date(start + 86_400_000).toISOString(), staleUntil: new Date(start + 86_520_000).toISOString() }, entries: [{ iataId: 'ABC', info: { name: null, coordinates: { latitudeDeg: 1, longitudeDeg: 2 }, elevationFt: null } }] };
    expect((await call('publish', key, { now: start, generation: Number(first.generation), resource, objectId })).published).toBe(false);
  });
  it('catalog_and_overall_rolling_limits_do_not_debit_on_denial', async () => {
    const catalogStart = 1_800_700_000_000; const objectId = 808;
    const catalog = { kind: 'catalog', key: 'station-catalog:v1', metadata: { fetchedAt: new Date(catalogStart).toISOString(), checkedAt: new Date(catalogStart).toISOString(), refreshAfter: new Date(catalogStart + 86_400_000).toISOString(), staleUntil: new Date(catalogStart + 86_520_000).toISOString() }, entries: [{ iataId: 'ABC', info: { name: null, coordinates: { latitudeDeg: 1, longitudeDeg: 2 }, elevationFt: null } }] };
    for (let index = 0; index < 4; index += 1) { const r = await call('reserve', 'station-catalog:v1', { now: catalogStart, objectId }); expect(r.allowed).toBe(true); expect((await call('publish', 'station-catalog:v1', { now: catalogStart, generation: Number(r.generation), resource: catalog, objectId })).published).toBe(true); }
    const catalogDenied = await call('reserve', 'station-catalog:v1', { now: catalogStart, objectId }); expect(catalogDenied.allowed).toBe(false);
    expect((await call('metadata', 'station-catalog:v1', { now: catalogStart, objectId })).attempts24h).toBe(4);
    const totalId = 809; const start = 1_800_800_000_000;
    const keys = ['winds:us:06','winds:us:12','winds:us:24','winds:alaska:06','winds:alaska:12','winds:alaska:24','winds:hawaii:06','winds:hawaii:12','winds:hawaii:24','station-catalog:v1'];
    for (let round = 0; round < 2; round += 1) for (const key of keys) {
      const r = await call('reserve', key, { now: start, objectId: totalId }); expect(r.allowed).toBe(true);
      const checkedAt = new Date(start).toISOString();
      const resource = key === 'station-catalog:v1' ? catalog : { kind: 'winds', key, metadata: { fetchedAt: checkedAt, checkedAt, refreshAfter: new Date(start + 3_600_000).toISOString(), staleUntil: new Date(start + 3_720_000).toISOString() }, rawProduct: 'x', forecasts: [{ stationId: 'ABC', forecastCycle: key.slice(-2), issuedAt: checkedAt, validAt: checkedAt, useFrom: checkedAt, useUntil: new Date(start + 3_600_000).toISOString(), levels: [] }] };
      expect((await call('publish', key, { now: start, generation: Number(r.generation), resource, objectId: totalId })).published).toBe(true);
    }
    expect((await call('reserve', 'winds:us:06', { now: start, objectId: totalId })).allowed).toBe(false);
    expect((await call('metadata', 'winds:us:06', { now: start, objectId: totalId })).attempts24h).toBe(20);
  });


  it('ordinary_provider_cooldown_survives_store_restart', async () => {
    const start = 1_800_900_000_000; const objectId = 909;
    const first = await call('reserve', 'winds:us:06', { now: start, objectId });
    await call('fail', 'winds:us:06', { now: start + 1, generation: Number(first.generation), providerRetryAt: start + 90_000, objectId });
    expect((await call('cooldown', 'winds:us:06', { objectId })).cooldown).toBe(start + 90_000);
    await mf.dispose();
    mf = new Miniflare({ scriptPath: join(tempDir, 'worker.mjs'), modules: true, durableObjects: { STORE: { className: 'WeatherBudgetTestHarness', useSQLite: true, unsafeUniqueKey: 'weather-test-v1' } }, compatibilityDate: '2026-09-21', durableObjectsPersist: join(tempDir, 'do') }) as Runtime;
    expect((await call('cooldown', 'winds:us:06', { objectId })).cooldown).toBe(start + 90_000);
    const denied = await call('reserve', 'winds:alaska:06', { now: start + 10_000, objectId });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAtMs).toBe(start + 90_000);
  });
  it('failure_preserves_previous_valid_resource_and_regressed_winds', async () => {
    const start = 1_801_000_000_000; const objectId = 1001; const key = 'winds:us:06';
    const checked = new Date(start).toISOString();
    const original = { kind: 'winds', key, metadata: { fetchedAt: checked, checkedAt: checked, refreshAfter: new Date(start + 3_600_000).toISOString(), staleUntil: new Date(start + 3_720_000).toISOString() }, rawProduct: 'newer', forecasts: [{ stationId: 'ABC', forecastCycle: '06', issuedAt: checked, validAt: checked, useFrom: checked, useUntil: new Date(start + 3_600_000).toISOString(), levels: [] }] };
    const first = await call('reserve', key, { now: start, objectId });
    expect((await call('publish', key, { now: start, generation: Number(first.generation), resource: original, objectId })).published).toBe(true);
    await call('fail', key, { now: start + 1, generation: Number(first.generation), objectId });
    expect(((await call('read', key, { objectId })).resource as { rawProduct: string }).rawProduct).toBe('newer');
    const retryAt = start + 60_001; const second = await call('reserve', key, { now: retryAt, objectId });
    const oldIssue = new Date(start - 3_600_000).toISOString(); const checked2 = new Date(retryAt).toISOString();
    const regressed = { ...original, metadata: { fetchedAt: checked2, checkedAt: checked2, refreshAfter: new Date(retryAt + 3_600_000).toISOString(), staleUntil: new Date(retryAt + 3_720_000).toISOString() }, rawProduct: 'older', forecasts: [{ ...original.forecasts[0], issuedAt: oldIssue }] };
    expect((await call('publish', key, { now: retryAt, generation: Number(second.generation), resource: regressed, objectId })).published).toBe(false);
    expect(((await call('read', key, { objectId })).resource as { rawProduct: string }).rawProduct).toBe('newer');
  });

});
