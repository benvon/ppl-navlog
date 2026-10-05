import { describe, expect, it } from 'vitest';
import worker, { type Env } from './index';

const env: Env = {
  APP_ENV: 'development',
  API_RATE_LIMITER: { limit: async () => ({ success: true }) },
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

  it('denies a rate-limited API request before invoking an upstream adapter', async () => {
    const response = await worker.fetch(new Request('https://example.test/api/health', { headers: { 'CF-Connecting-IP': '192.0.2.1' } }), {
      ...env,
      API_RATE_LIMITER: { async limit() { return { success: false }; } }
    });
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: 'rate_limited' });
  });

  it('fails closed when development rate limiting is absent or unavailable', async () => {
    const request = new Request('https://example.test/api/health');
    const withoutLimiter = { ...env };
    delete withoutLimiter.API_RATE_LIMITER;
    const missing = await worker.fetch(request, { ...withoutLimiter, APP_ENV: 'development' });
    expect(missing.status).toBe(503);
    await expect(missing.json()).resolves.toMatchObject({ code: 'service_unavailable' });

    const failed = await worker.fetch(request, {
      ...env,
      APP_ENV: 'development',
      API_RATE_LIMITER: { async limit() { throw new Error('provider unavailable'); } }
    });
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toMatchObject({ code: 'service_unavailable' });
  });

  it('fails closed for deployed production API requests when limiter or weather coordinator is missing', async () => {
    const request = new Request('https://example.test/api/weather/winds/stations?route=42.6%2C-89');
    const withoutLimiter = { ...env };
    delete withoutLimiter.API_RATE_LIMITER;
    const missingLimiter = await worker.fetch(request, { ...withoutLimiter, APP_ENV: 'production', AWC_COORDINATOR_API: { fetch: async () => Response.error() } });
    expect(missingLimiter.status).toBe(503);
    await expect(missingLimiter.json()).resolves.toMatchObject({ code: 'service_unavailable' });
    const missingCoordinator = await worker.fetch(request, { ...env, APP_ENV: 'production', API_RATE_LIMITER: { limit: async () => ({ success: true }) } });
    expect(missingCoordinator.status).toBe(503);
    await expect(missingCoordinator.json()).resolves.toMatchObject({ code: 'service_unavailable' });
    const developmentMissingCoordinator = await worker.fetch(request, { ...env, AWC_COORDINATOR_API: undefined });
    expect(developmentMissingCoordinator.status).toBe(503);
    await expect(developmentMissingCoordinator.json()).resolves.toMatchObject({ code: 'service_unavailable' });
    const unknownEnvironment = await worker.fetch(request, { ...env, APP_ENV: 'preview' });
    expect(unknownEnvironment.status).toBe(503);
  });

  it('returns not found for the removed TAF route without calling the coordinator', async () => {
    let coordinatorCalls = 0;
    const response = await worker.fetch(new Request('https://example.test/api/weather/taf/KORD'), {
      ...env,
      APP_ENV: 'development',
      API_RATE_LIMITER: { limit: async () => ({ success: true }) },
      AWC_COORDINATOR_API: { fetch: async () => { coordinatorCalls += 1; return Response.error(); } }
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: 'not_found' });
    expect(coordinatorCalls).toBe(0);
  });

  it('adds security headers to static asset responses', async () => {
    const response = await worker.fetch(new Request('https://example.test/'), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(response.headers.get('X-Request-Id')).toMatch(UUID_PATTERN);
  });
});

const UUID_PATTERN = /^[0-9a-f]{8}-/;
