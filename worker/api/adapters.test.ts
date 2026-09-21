import { describe, expect, it } from 'vitest';
import { createRunwayPickerAdapter, type ServiceFetcher } from './adapters';
import { runwayPickerAirportFixture, runwayPickerCacheFixture, runwayPickerMetarFixture } from './fixtures/runway-picker';

function fetcherFor(payload: object): { fetcher: ServiceFetcher; requests: Request[] } {
  const requests: Request[] = [];
  return { fetcher: { async fetch(request) { requests.push(request); return Response.json(payload); } }, requests };
}

describe('runway-picker adapter', () => {
  it('uses the evidenced airport endpoint and validates its response', async () => {
    const { fetcher, requests } = fetcherFor({ ...runwayPickerAirportFixture, cache: runwayPickerCacheFixture });
    const result = await createRunwayPickerAdapter(fetcher, 'https://runway-picker.internal').getAirport('KJVL');
    expect(result.airport).toEqual(runwayPickerAirportFixture);
    expect(new URL(requests[0]?.url ?? '').pathname).toBe('/api/airport');
    expect(new URL(requests[0]?.url ?? '').searchParams.get('icao')).toBe('KJVL');
  });

  it('uses the evidenced METAR endpoint and validates its response', async () => {
    const { fetcher, requests } = fetcherFor({ ...runwayPickerMetarFixture, cache: runwayPickerCacheFixture });
    const result = await createRunwayPickerAdapter(fetcher, 'https://runway-picker.internal').getMetar('KJVL');
    expect(result.metar).toEqual(runwayPickerMetarFixture);
    expect(new URL(requests[0]?.url ?? '').pathname).toBe('/api/metar');
  });

  it('rejects an upstream payload that claims a different airport identity', async () => {
    const { fetcher } = fetcherFor({ ...runwayPickerAirportFixture, icao: 'KORD', cache: runwayPickerCacheFixture });
    await expect(createRunwayPickerAdapter(fetcher, 'https://runway-picker.internal').getAirport('KJVL')).rejects.toMatchObject({ code: 'upstream_invalid_response', status: 502 });
  });

  it('rejects an airport response with an invalid nested runway value', async () => {
    const { fetcher } = fetcherFor({ ...runwayPickerAirportFixture, runwayEnds: [{ ...runwayPickerAirportFixture.runwayEnds[0], headingDegTrue: '181' }], cache: runwayPickerCacheFixture });
    await expect(createRunwayPickerAdapter(fetcher, 'https://runway-picker.internal').getAirport('KJVL')).rejects.toMatchObject({ code: 'upstream_invalid_response', status: 502 });
  });
});
