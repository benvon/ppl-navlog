// @vitest-environment node
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { WeatherBudgetStore, type StoreStorage } from './store';
import type { WeatherResourceEnvelope } from '../weather-resources/contracts';
import { isWeatherResourceEnvelope } from '../weather-resources/validation';

const NOW = 1_800_000_000_000;
let database: DatabaseSync | undefined;

function createStore(): WeatherBudgetStore {
  database = new DatabaseSync(':memory:');
  const storage: StoreStorage = {
    sql: {
      exec<T>(query: string, ...bindings: unknown[]) {
        if (bindings.length === 0 && !/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query)) {
          database!.exec(query);
          return { toArray: () => [] };
        }
        const statement = database!.prepare(query);
        if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query)) {
          const rows = statement.all(...bindings as SQLInputValue[]) as T[];
          return { toArray: () => rows };
        }
        statement.run(...bindings as SQLInputValue[]);
        return { toArray: () => [] };
      }
    },
    transactionSync<T>(closure: () => T): T {
      database!.exec('BEGIN');
      try { const value = closure(); database!.exec('COMMIT'); return value; }
      catch (error) { database!.exec('ROLLBACK'); throw error; }
    }
  };
  return new WeatherBudgetStore(storage);
}

function windsResource(issuedAtMs = NOW - 1_000): WeatherResourceEnvelope {
  const checkedAt = new Date(NOW).toISOString();
  return {
    kind: 'winds', key: 'winds:us:06', rawProduct: 'official product',
    metadata: { fetchedAt: checkedAt, checkedAt, refreshAfter: new Date(NOW + 3_600_000).toISOString(), staleUntil: new Date(NOW + 3_720_000).toISOString() },
    forecasts: [{ stationId: 'ABC', forecastCycle: '06', issuedAt: new Date(issuedAtMs).toISOString(), validAt: checkedAt, useFrom: checkedAt, useUntil: new Date(NOW + 3_600_000).toISOString(), levels: [] }]
  };
}

afterEach(() => { database?.close(); database = undefined; });

describe('SQLite accounting store on Node test adapter', () => {
  it('persists reservations and publication while rejecting obsolete generations', async () => {
    const store = createStore();
    const first = await store.reserveAttempt('winds:us:06', NOW);
    expect(first).toEqual({ allowed: true, generation: 1 });
    if (!first.allowed) throw new Error('Expected first reservation to be allowed.');
    expect(isWeatherResourceEnvelope(windsResource())).toBe(true);
    expect(await store.publishResource('winds:us:06', first.generation, windsResource(), NOW)).toBe(true);
    await expect(store.readResource('winds:us:06')).resolves.toEqual(windsResource());
    const second = await store.reserveAttempt('winds:us:06', NOW + 1);
    expect(second).toEqual({ allowed: true, generation: 2 });
    if (!second.allowed) throw new Error('Expected second reservation to be allowed.');
    expect(await store.publishResource('winds:us:06', first.generation, windsResource(), NOW + 1)).toBe(false);
    expect(await store.publishResource('winds:us:06', second.generation, windsResource(NOW - 2_000), NOW + 1)).toBe(false);
    expect(await store.readAccountingMetadata()).toMatchObject({ attempts24h: 2, resources: 1 });
    await store.clearResource('winds:us:06');
    expect(await store.readResource('winds:us:06')).toBeUndefined();
  });

  it('applies per-key cooldowns, provider cooldowns, and stale-generation failure guards', async () => {
    const store = createStore();
    const reservation = await store.reserveAttempt('station-catalog:v1', NOW);
    if (!reservation.allowed) throw new Error('Expected first reservation to be allowed.');
    await store.recordFailure('station-catalog:v1', reservation.generation, NOW, NOW + 90_000);
    await expect(store.readResourceState('station-catalog:v1')).resolves.toMatchObject({ failures: 1, retryAtMs: NOW + 60_000 });
    await expect(store.readProviderCooldown()).resolves.toBe(NOW + 90_000);
    expect(await store.reserveAttempt('station-catalog:v1', NOW + 30_000)).toEqual({ allowed: false, retryAtMs: NOW + 90_000 });
    await store.recordFailure('station-catalog:v1', reservation.generation - 1, NOW + 100_000);
    await expect(store.readResourceState('station-catalog:v1')).resolves.toMatchObject({ failures: 1, retryAtMs: NOW + 60_000 });
    await store.recordFailure('station-catalog:v1', reservation.generation, NOW + 100_000, 'operator_required');
    await expect(store.readProviderCooldown()).resolves.toBe('operator_required');
    await expect(store.readAccountingMetadata()).resolves.toMatchObject({ attempts24h: 1, providerCooldownUntil: 'operator_required' });
  });

  it('fails closed on invalid keys and clocks and ignores malformed stored envelopes', async () => {
    const store = createStore();
    await expect(store.reserveAttempt('winds:bad:06' as 'winds:us:06', NOW)).rejects.toThrow(/Unsupported weather resource key/);
    await expect(store.reserveAttempt('winds:us:06', -1)).rejects.toThrow(/Invalid accounting clock/);
    const reservation = await store.reserveAttempt('winds:us:06', NOW);
    if (!reservation.allowed) throw new Error('Expected reservation to be allowed.');
    database!.prepare('INSERT INTO resources(resource_key,generation,envelope) VALUES(?,?,?)').run('winds:us:06', 1, '{');
    await expect(store.readResource('winds:us:06')).resolves.toBeUndefined();
    expect(await store.publishResource('winds:us:06', reservation.generation, { ...windsResource(), key: 'winds:us:12' } as WeatherResourceEnvelope, NOW)).toBe(false);
  });
});
