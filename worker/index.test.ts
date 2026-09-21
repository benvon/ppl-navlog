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

  it('adds security headers to static asset responses', async () => {
    const response = await worker.fetch(new Request('https://example.test/'), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(response.headers.get('X-Request-Id')).toMatch(UUID_PATTERN);
  });
});

const UUID_PATTERN = /^[0-9a-f]{8}-/;
