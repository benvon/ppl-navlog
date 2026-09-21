import { describe, expect, it } from 'vitest';
import { createRunwayPickerAdapter, type ServiceFetcher } from './adapters';
import { runwayPickerAirportFixture, runwayPickerCacheFixture, runwayPickerMetarFixture } from './fixtures/runway-picker';
import { handleApiRequest } from './handlers';

const fetcher: ServiceFetcher = { async fetch(request) { return Response.json(new URL(request.url).pathname === '/api/airport' ? { ...runwayPickerAirportFixture, cache: runwayPickerCacheFixture } : { ...runwayPickerMetarFixture, cache: runwayPickerCacheFixture }); } };
const aviationData = createRunwayPickerAdapter(fetcher, 'https://runway-picker.internal');

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
});
