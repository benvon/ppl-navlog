import { afterEach, describe, expect, it, vi } from 'vitest';
import { runwayPickerAirportFixture, runwayPickerCacheFixture } from './api/fixtures/runway-picker';
import worker, { type Env } from './index';

const env: Env = {
  APP_ENV: 'local',
  APP_VERSION: 'v0.1.0',
  APP_COMMIT_SHA: 'abcdef1',
  ASSETS: {
    fetch: async () => new Response('<!doctype html><title>PPL Navlog</title>', { headers: { 'Content-Type': 'text/html' } })
  }
};

describe('Worker foundation', () => {
  it('returns a non-sensitive health response with a request ID', async () => {
    const suppliedRequestId = 'e531d3ef-89b8-4cbe-a7e9-c42c7fad7de5';
    const response = await worker.fetch(new Request('https://example.test/api/health', { headers: { 'X-Request-Id': suppliedRequestId } }), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Request-Id')).toBe(suppliedRequestId);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      version: 'v0.1.0',
      commitSha: 'abcdef1',
      requestId: suppliedRequestId
    });
  });

  it('rejects unsupported API methods without proxying them', async () => {
    const response = await worker.fetch(new Request('https://example.test/api/health', { method: 'POST' }), env);

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({ code: 'method_not_allowed' });
  });

  it('passes static asset responses through unchanged', async () => {
    const assetResponse = new Response('<!doctype html><title>PPL Navlog</title>', {
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache', 'X-Asset-Marker': 'preserved' }
    });
    const response = await worker.fetch(new Request('https://example.test/'), {
      ...env, APP_ENV: 'production', ASSETS: { fetch: async () => assetResponse }
    });

    expect(response).toBe(assetResponse);
    expect(response.headers.get('X-Request-Id')).toBeNull();
    expect(response.headers.get('X-Asset-Marker')).toBe('preserved');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('keeps static assets available without a limiter in protected environments', async () => {
    const response = await worker.fetch(new Request('https://example.test/'), { ...env, APP_ENV: 'production' });
    expect(response.status).toBe(200);
  });
});

const suppliedRequestId = 'e531d3ef-89b8-4cbe-a7e9-c42c7fad7de5';
const dataPaths = [
  '/api/airports/KJVL',
  '/api/weather/metar/KJVL',
  '/api/weather/taf/KORD',
  '/api/weather/winds/point?lat=42.6&lon=-89&altitudeFeetMsl=4500&plannedUtc=2026-09-22T01%3A00%3A00.000Z',
];
const environmentValues = ['development', 'production', undefined, 'unknown', '', 'LOCAL'];

afterEach(() => vi.unstubAllGlobals());

function request(path: string): Request {
  return new Request(`https://example.test${path}`, {
    headers: { 'CF-Connecting-IP': '192.0.2.1', 'X-Request-Id': suppliedRequestId }
  });
}

function providerSpies() {
  const runwayPicker = vi.fn(async () => Response.json({ ...runwayPickerAirportFixture, cache: runwayPickerCacheFixture }));
  const aviationWeather = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', aviationWeather);
  return { runwayPicker, aviationWeather };
}

async function expectBlocked(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get('X-Request-Id')).toBe(suppliedRequestId);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  await expect(response.json()).resolves.toEqual({
    error: status === 429 ? 'Too many requests. Please retry shortly.' : 'API temporarily unavailable.',
    code, requestId: suppliedRequestId
  });
}

describe.each(environmentValues)('API admission with APP_ENV=%s', (APP_ENV) => {
  it.each([...dataPaths, '/api/health'])('fails closed without a limiter for %s', async (path) => {
    const providers = providerSpies();
    const response = await worker.fetch(request(path), {
      ...env, APP_ENV, RUNWAY_PICKER_API: { fetch: providers.runwayPicker }
    });

    await expectBlocked(response, 503, 'service_unavailable');
    expect(providers.runwayPicker).not.toHaveBeenCalled();
    expect(providers.aviationWeather).not.toHaveBeenCalled();
  });
});

describe.each([...environmentValues, 'local'])('configured limiter with APP_ENV=%s', (APP_ENV) => {
  it.each(dataPaths)('blocks %s when the limiter denies', async (path) => {
    const providers = providerSpies();
    const limit = vi.fn(async () => ({ success: false }));
    const response = await worker.fetch(request(path), {
      ...env, APP_ENV, RUNWAY_PICKER_API: { fetch: providers.runwayPicker }, API_RATE_LIMITER: { limit }
    });

    await expectBlocked(response, 429, 'rate_limited');
    expect(limit).toHaveBeenCalledWith({ key: '192.0.2.1' });
    expect(providers.runwayPicker).not.toHaveBeenCalled();
    expect(providers.aviationWeather).not.toHaveBeenCalled();
  });

  it.each(dataPaths)('fails closed for %s when the limiter throws', async (path) => {
    const providers = providerSpies();
    const response = await worker.fetch(request(path), {
      ...env, APP_ENV, RUNWAY_PICKER_API: { fetch: providers.runwayPicker },
      API_RATE_LIMITER: { async limit() { throw new Error('provider unavailable'); } }
    });

    await expectBlocked(response, 503, 'service_unavailable');
    expect(providers.runwayPicker).not.toHaveBeenCalled();
    expect(providers.aviationWeather).not.toHaveBeenCalled();
  });

  it('serves a provider response when the limiter allows', async () => {
    const providers = providerSpies();
    const response = await worker.fetch(request('/api/airports/KJVL'), {
      ...env, APP_ENV, RUNWAY_PICKER_API: { fetch: providers.runwayPicker },
      API_RATE_LIMITER: { async limit() { return { success: true }; } }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ airport: { icao: 'KJVL' }, requestId: suppliedRequestId });
    expect(providers.runwayPicker).toHaveBeenCalledOnce();
    expect(providers.aviationWeather).not.toHaveBeenCalled();
  });
});

it('does not assign an edge cache identity to unknown environments even with an admitted limiter', async () => {
  const coordinator = { fetch: vi.fn(async () => Response.json({ ok: false, code: 'upstream_unavailable', retryAt: new Date(Date.now() + 60_000).toISOString() }, { status: 503 })) };
  const response = await worker.fetch(request('/api/weather/winds/stations?route=40,-100'), {
    ...env, APP_ENV: 'LOCAL', AWC_COORDINATOR_API: coordinator,
    API_RATE_LIMITER: { async limit() { return { success: true }; } }
  });

  expect(response.status).toBe(503);
  expect(coordinator.fetch).not.toHaveBeenCalled();
});

it('permits provider calls without a limiter only in explicit local mode', async () => {
  const providers = providerSpies();
  const response = await worker.fetch(request('/api/airports/KJVL'), {
    ...env, APP_ENV: 'local', RUNWAY_PICKER_API: { fetch: providers.runwayPicker }
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ airport: { icao: 'KJVL' } });
  expect(providers.runwayPicker).toHaveBeenCalledOnce();
});
