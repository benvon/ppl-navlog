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

export function errorResponse(payload: ApiErrorPayload, status: number): Response {
  return jsonResponse(payload, status, payload.requestId);
}
