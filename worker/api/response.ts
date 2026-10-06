import type { ApiErrorPayload } from './contracts';

export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
};

export function jsonResponse(payload: object, status: number, requestId: string): Response {
  const headers = new Headers(API_SECURITY_HEADERS);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('X-Request-Id', requestId);
  return new Response(JSON.stringify(payload), { headers, status });
}

export function errorResponse(payload: ApiErrorPayload, status: number, retryAt?: number): Response {
  const response = jsonResponse(payload, status, payload.requestId);
  if (retryAt === undefined || status < 500) return response;
  const seconds = Math.ceil((retryAt - Date.now()) / 1_000);
  if (!Number.isFinite(seconds) || seconds <= 0) return response;
  response.headers.set('Retry-After', String(Math.min(86_400, seconds)));
  return response;
}
