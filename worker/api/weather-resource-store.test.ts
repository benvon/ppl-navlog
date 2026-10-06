import { describe, expect, it } from 'vitest';
import type { WeatherResourceEnvelope } from '../weather-resources/contracts';
import { createSharedWeatherResourceStore, WEATHER_RESOURCE_CACHE_LIMITS } from './weather-resource-store';

const checked = '2026-10-05T12:00:00.000Z';
function metadata(checkedAt: string, refreshAfter: string, staleUntil: string) {
  return { fetchedAt: checkedAt, checkedAt, refreshAfter, staleUntil };
}
function wind(checkedAt = checked, rawProduct = 'raw'): WeatherResourceEnvelope {
  const checkedMs = Date.parse(checkedAt);
  return { kind: 'winds', key: 'winds:us:06', metadata: metadata(checkedAt, new Date(checkedMs + 60 * 60_000).toISOString(), new Date(checkedMs + 62 * 60_000).toISOString()), rawProduct,
    forecasts: [{ stationId: 'ABQ', forecastCycle: '06', issuedAt: checkedAt, validAt: checkedAt, useFrom: checkedAt, useUntil: '2026-10-05T14:00:00.000Z', levels: [] }] };
}
function catalog(checkedAt: string, name: string, extra = false): WeatherResourceEnvelope {
  const entry = { iataId: 'ABQ', info: { name, coordinates: { latitudeDeg: 35.04, longitudeDeg: -106.6, ...(extra ? { ignoredCoordinateField: true } : {}) }, elevationFt: 5355 }, ...(extra ? { ignoredEntryField: true } : {}) };
  const checkedMs = Date.parse(checkedAt);
  return { kind: 'catalog', key: 'station-catalog:v1', metadata: metadata(checkedAt, new Date(checkedMs + 24 * 60 * 60_000).toISOString(), new Date(checkedMs + 24 * 60 * 60_000 + 120_000).toISOString()), entries: [entry] } as unknown as WeatherResourceEnvelope;
}

describe('shared completed weather resources', () => {
  it('isolates environments and expires fresh data at refreshAfter without serving grace', () => {
    const store = createSharedWeatherResourceStore();
    store.publish('production', wind(), new Date(checked));
    store.publish('development', wind(checked, 'development'), new Date(checked));
    const production = store.get('production', 'winds:us:06', new Date(checked));
    const development = store.get('development', 'winds:us:06', new Date(checked));
    expect(production?.kind === 'winds' ? production.rawProduct : undefined).toBe('raw');
    expect(development?.kind === 'winds' ? development.rawProduct : undefined).toBe('development');
    expect(store.get('production', 'winds:us:06', new Date('2026-10-05T13:00:00.000Z'))).toBeUndefined();
    expect(store.snapshot('production').entries).toBe(1);
    expect(store.get('production', 'winds:us:06', new Date('2026-10-05T13:02:00.000Z'))).toBeUndefined();
    expect(store.snapshot('production')).toEqual({ entries: 0, retainedBytes: 0 });
    expect(store.snapshot('development').entries).toBe(1);
  });

  it('does not retain a grace-age resource or an invalid resource', () => {
    const store = createSharedWeatherResourceStore();
    store.publish('production', wind(), new Date('2026-10-05T13:01:00.000Z'));
    store.publish('production', { ...wind(), unexpected: true } as unknown as WeatherResourceEnvelope, new Date(checked));
    expect(store.snapshot('production')).toEqual({ entries: 0, retainedBytes: 0 });
  });

  it('canonicalizes catalog entries and keeps the identity index attached to that exact array', () => {
    const store = createSharedWeatherResourceStore();
    const value = catalog(checked, 'Albuquerque', true) as Extract<WeatherResourceEnvelope, { kind: 'catalog' }>;
    const duplicate = { ...value, entries: [...value.entries, ...value.entries] };
    store.publish('production', duplicate, new Date(checked));
    const retained = store.get('production', 'station-catalog:v1', new Date(checked));
    if (!retained || retained.kind !== 'catalog') throw new Error('catalog was not retained');
    expect(store.getCatalogIdentityIndex(retained.entries)?.ABQ).toHaveLength(2);
    expect(Object.keys(retained.entries[0]!)).toEqual(['iataId', 'info']);
    expect(Object.keys(retained.entries[0]!.info.coordinates)).toEqual(['latitudeDeg', 'longitudeDeg']);
    expect(Reflect.set(retained.entries[0]!.info.coordinates, 'latitudeDeg', 99)).toBe(false);
  });

  it('removes catalog index mappings when the resource is replaced or reset', () => {
    const store = createSharedWeatherResourceStore();
    store.publish('production', catalog(checked, 'Albuquerque'), new Date(checked));
    const previous = store.get('production', 'station-catalog:v1', new Date(checked));
    if (!previous || previous.kind !== 'catalog') throw new Error('catalog was not retained');
    store.publish('production', catalog('2026-10-05T12:01:00.000Z', 'Updated Albuquerque'), new Date('2026-10-05T12:01:00.000Z'));
    expect(store.getCatalogIdentityIndex(previous.entries)).toBeUndefined();
    const next = store.get('production', 'station-catalog:v1', new Date('2026-10-05T12:01:00.000Z'));
    expect(next?.kind === 'catalog' && next.entries[0]?.info.name).toBe('Updated Albuquerque');
    if (next?.kind === 'catalog') expect(store.getCatalogIdentityIndex(next.entries)?.ABQ).toHaveLength(1);
    store.reset('production');
    if (next?.kind === 'catalog') expect(store.getCatalogIdentityIndex(next.entries)).toBeUndefined();
  });

  it('records an oversized newer publication watermark and rejects a slower older result', () => {
    const store = createSharedWeatherResourceStore();
    store.publish('production', wind(), new Date(checked));
    const oversizedChecked = '2026-10-05T12:01:00.000Z';
    store.publish('production', wind(oversizedChecked, 'x'.repeat(600 * 1024)), new Date(oversizedChecked));
    expect(store.snapshot('production')).toEqual({ entries: 0, retainedBytes: 0 });
    store.publish('production', wind(), new Date(checked));
    expect(store.get('production', 'winds:us:06', new Date(checked))).toBeUndefined();
    expect(store.snapshot('production').retainedBytes).toBeLessThanOrEqual(WEATHER_RESOURCE_CACHE_LIMITS.maxTotalBytes);
  });
});
