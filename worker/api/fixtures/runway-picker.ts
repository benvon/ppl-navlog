import type { AirportData, CacheProvenance, MetarData } from '../contracts';

export const runwayPickerCacheFixture: CacheProvenance = {
  status: 'upstream_refresh', source: 'upstream', ageSeconds: 0, fetchedAt: '2026-09-21T18:00:00.000Z', expiresAt: '2026-09-21T18:15:00.000Z', freshnessRemainingSeconds: 900, servedAt: '2026-09-21T18:00:00.000Z', ttlSeconds: 900, maxPayloadAgeSeconds: 1800, key: 'metar:KJVL', resource: 'metar'
};

export const runwayPickerAirportFixture: AirportData = {
  requestedIcao: 'KJVL', icao: 'KJVL', name: 'Southern Wisconsin Regional Airport', municipality: 'Janesville', countryCode: 'US', countryName: 'United States', elevationFt: 808, coordinates: { latitudeDeg: 42.6203, longitudeDeg: -89.0416 }, runwayEnds: [{ id: '18', headingDegTrue: 181, isClosed: false, lengthFt: 7001 }], frequencies: [{ type: 'CTAF', description: 'Common traffic advisory frequency', frequencyMhz: '123.0' }], source: 'airportdb', fetchedAt: '2026-09-21T18:00:00.000Z'
};

export const runwayPickerMetarFixture: MetarData = {
  icao: 'KJVL', metarRaw: 'KJVL 211755Z 18010KT 10SM FEW050 25/12 A3002 RMK AO2', wind: { raw: '18010KT', directionType: 'fixed', directionDegTrue: 180, directionVariation: null, speedKt: 10, gustKt: null }, source: 'aviationweather', fetchedAt: '2026-09-21T18:00:00.000Z', observedAt: '2026-09-21T17:55:00.000Z'
};
