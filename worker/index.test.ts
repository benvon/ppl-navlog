import { describe, expect, it } from 'vitest';
import worker, { type Env } from './index';

const env: Env = {
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
    const missing = await worker.fetch(request, { ...env, APP_ENV: 'development' });
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

  it('passes non-API asset responses through unchanged', async () => {
    const assetResponse = new Response('<!doctype html><title>PPL Navlog</title>', {
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache', 'X-Asset-Marker': 'preserved' }
    });
    const assetEnv = { ...env, ASSETS: { fetch: async () => assetResponse } };
    const response = await worker.fetch(new Request('https://example.test/'), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Request-Id')).toBeNull();
    expect(response.headers.get('X-Asset-Marker')).toBeNull();
    const passthrough = await worker.fetch(new Request('https://example.test/missing'), assetEnv);
    expect(passthrough.headers.get('X-Request-Id')).toBeNull();
    expect(passthrough.headers.get('X-Asset-Marker')).toBe('preserved');
    expect(passthrough.headers.get('Cache-Control')).toBe('no-cache');
  });
});
