import { describe, expect, it } from 'vitest';
import { createRunwayPickerAdapter, type ServiceFetcher } from './adapters';
import { runwayPickerAirportFixture, runwayPickerCacheFixture, runwayPickerMetarFixture } from './fixtures/runway-picker';
import { handleApiRequest } from './handlers';
import type { WindsDataAdapter } from './winds';
import type { WindsStation } from './contracts';

const fetcher: ServiceFetcher = { async fetch(request) { return Response.json(new URL(request.url).pathname === '/api/airport' ? { ...runwayPickerAirportFixture, cache: runwayPickerCacheFixture } : { ...runwayPickerMetarFixture, cache: runwayPickerCacheFixture }); } };
const aviationData = createRunwayPickerAdapter(fetcher, 'https://runway-picker.internal');
const windsData: WindsDataAdapter = {
  async getWindsStations(_route) {
    return { stations: [{ id: 'BRL', name: 'Burlington', coordinates: { latitudeDeg: 40.7832, longitudeDeg: -91.1255 }, elevationFt: 698, region: 'us', availableForecastCycles: ['06'], source: 'aviationweather' }], forecasts: [{ forecastCycle: '06', issuedAt: '2026-09-21T18:00:00.000Z', validAt: '2026-09-22T00:00:00.000Z', useFrom: '2026-09-21T20:00:00.000Z', useUntil: '2026-09-22T03:00:00.000Z' }], provenance: [{ status: 'upstream_refresh', source: 'upstream', ageSeconds: 0, fetchedAt: '2026-09-21T18:00:00.000Z', expiresAt: '2026-09-21T18:20:00.000Z', freshnessRemainingSeconds: 1200, servedAt: '2026-09-21T18:00:00.000Z', ttlSeconds: 1200, maxPayloadAgeSeconds: 7200, key: 'winds:us:06', resource: 'winds-temps' }] };
  },
  async getWindsForecast(station, validTime, region) {
    const stationValue: WindsStation = { id: station, name: 'Burlington', coordinates: { latitudeDeg: 40.7832, longitudeDeg: -91.1255 }, elevationFt: 698, region, availableForecastCycles: ['06'], source: 'aviationweather' };
    const cache = { status: 'upstream_refresh' as const, source: 'upstream' as const, ageSeconds: 0, fetchedAt: '2026-09-21T18:00:00.000Z', expiresAt: '2026-09-21T18:20:00.000Z', freshnessRemainingSeconds: 1200, servedAt: '2026-09-21T18:00:00.000Z', ttlSeconds: 1200, maxPayloadAgeSeconds: 7200, key: 'winds:us:06', resource: 'winds-temps' };
    return { forecast: { station: stationValue, forecastCycle: '06' as const, issuedAt: '2026-09-21T18:00:00.000Z', validAt: validTime, useFrom: '2026-09-21T20:00:00.000Z', useUntil: '2026-09-22T03:00:00.000Z', levels: [], rawProduct: 'raw official product', source: 'aviationweather' as const, fetchedAt: '2026-09-21T18:00:00.000Z' }, provenance: cache };
  }
};

describe('API handlers', () => {
  it('maps an airport response into the navlog transport contract', async () => {
    const response = await handleApiRequest(new Request('https://example.test/api/airports/kjvl'), { aviationData });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ airport: { icao: 'KJVL' }, provenance: { adapter: 'runway-picker' } });
  });

  it('rejects malformed ICAO identifiers before the adapter is called', async () => {
    const response = await handleApiRequest(new Request('https://example.test/api/airports/KJV'), { aviationData });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects query parameters to make cache inputs unambiguous', async () => {
    const response = await handleApiRequest(new Request('https://example.test/api/weather/metar/KJVL?debug=true'), { aviationData });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'invalid_request' });
  });

  it('returns a structured configuration error when no aviation service is bound', async () => {
    const response = await handleApiRequest(new Request('https://example.test/api/weather/metar/KJVL'), {});
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'service_unavailable' });
  });

  it('returns decoded winds stations with every upstream product provenance exposed', async () => {
    const response = await handleApiRequest(new Request('https://example.test/api/weather/winds/stations?route=42.6,-89.0'), { windsData });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ stations: [{ id: 'BRL' }], requestedRoute: [{ latitudeDeg: 42.6, longitudeDeg: -89 }], provenance: [{ product: 'NCEP FB Winds/Temps (legacy FD)' }] });
  });

  it('requires a canonical valid time and selected region for a winds forecast', async () => {
    const invalidResponse = await handleApiRequest(new Request('https://example.test/api/weather/winds?station=BRL&validTime=tomorrow&region=us'), { windsData });
    expect(invalidResponse.status).toBe(400);
    const response = await handleApiRequest(new Request('https://example.test/api/weather/winds?station=BRL&validTime=2026-09-22T00%3A00%3A00.000Z&region=us'), { windsData });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ forecast: { station: { id: 'BRL' }, rawProduct: 'raw official product' } });
  });
});
