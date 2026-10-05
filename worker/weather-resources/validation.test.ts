import { describe, expect, it } from 'vitest';
import { isWeatherResourceResult, parseResourceKey, parseStationCatalog } from './validation';

describe('weather resource validation', () => {
  it('rejects_unknown_or_extra_resource_input', () => {
    expect(parseResourceKey('winds:us:06')).toBe('winds:us:06');
    expect(() => parseResourceKey('winds:us:03')).toThrow();
    expect(() => parseResourceKey('winds:us:06:extra')).toThrow();
    expect(() => parseResourceKey({ resource: 'winds:us:06', url: 'https://example.test' })).toThrow();
  });

  it('preserves_existing_product_and_catalog_validation', () => {
    const valid = { ok: true, state: 'fresh', resource: { kind: 'catalog', key: 'station-catalog:v1', metadata: { fetchedAt: '2026-10-05T00:00:00.000Z', checkedAt: '2026-10-05T00:00:00.000Z', refreshAfter: '2026-10-06T00:00:00.000Z', staleUntil: '2026-10-06T00:02:00.000Z' }, entries: [{ iataId: 'ABQ', info: { name: 'Albuquerque', coordinates: { latitudeDeg: 35.0402, longitudeDeg: -106.609 }, elevationFt: 5355 } }] } };
    expect(isWeatherResourceResult(valid)).toBe(true);
    expect(isWeatherResourceResult({ ...valid, unexpected: true })).toBe(false);
    expect(isWeatherResourceResult({ ok: true, state: 'fresh', resource: { ...valid.resource, key: 'winds:us:06' } })).toBe(false);
    expect(isWeatherResourceResult({ ...valid, resource: { ...valid.resource, metadata: { ...valid.resource.metadata, refreshAfter: '2026-10-05T23:00:00.000Z', staleUntil: '2026-10-06T00:02:00.000Z' } } })).toBe(false);
    expect(isWeatherResourceResult({ ...valid, resource: { ...valid.resource, metadata: { ...valid.resource.metadata, checkedAt: '2026-10-05' } } })).toBe(false);
    const parsed = parseStationCatalog([{ iataId: 'ABQ', site: 'Albuquerque', lat: 35.0402, lon: -106.609, elev: 5355 }, { iataId: 'bad', lat: 999, lon: 0 }], new Date('2026-10-05T00:00:00.000Z'));
    expect(parsed).toEqual({ fetchedAt: '2026-10-05T00:00:00.000Z', freshUntil: '2026-10-06T02:00:00.000Z', staleUntil: '2026-10-12T00:00:00.000Z', entries: [{ iataId: 'ABQ', info: { name: 'Albuquerque', coordinates: { latitudeDeg: 35.0402, longitudeDeg: -106.609 }, elevationFt: 5355 } }] });
    const winds = { ok: true, state: 'fresh', resource: { kind: 'winds', key: 'winds:us:06', metadata: { fetchedAt: '2026-10-05T00:00:00.000Z', checkedAt: '2026-10-05T00:00:00.000Z', refreshAfter: '2026-10-05T01:00:00.000Z', staleUntil: '2026-10-05T01:02:00.000Z' }, rawProduct: 'FB product', forecasts: [{ stationId: 'ABQ', forecastCycle: '06', issuedAt: '2026-10-05T00:00:00.000Z', validAt: '2026-10-05T06:00:00.000Z', useFrom: '2026-10-05T03:00:00.000Z', useUntil: '2026-10-05T09:00:00.000Z', levels: [{ altitudeFt: 3000, windFromDegTrue: null, windSpeedKt: null, temperatureC: null, availability: 'unavailable', raw: '' }] }] } };
    expect(isWeatherResourceResult(winds)).toBe(true);
    expect(isWeatherResourceResult({ ...winds, resource: { ...winds.resource, forecasts: [{ ...winds.resource.forecasts[0], forecastCycle: '12' }] } })).toBe(false);
    expect(isWeatherResourceResult({ ...winds, resource: { ...winds.resource, forecasts: [{ ...winds.resource.forecasts[0], extra: 'unexpected' }] } })).toBe(false);
  });
});
