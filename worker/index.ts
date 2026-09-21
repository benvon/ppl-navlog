import { createRunwayPickerAdapter, type ServiceFetcher } from './api/adapters';
import { handleApiRequest } from './api/handlers';

export interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  APP_VERSION?: string;
  APP_COMMIT_SHA?: string;
  RUNWAY_PICKER_API?: ServiceFetcher;
  RUNWAY_PICKER_ORIGIN?: string;
}

const API_PATH_PREFIX = '/api/';

const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'; form-action 'none'; object-src 'none'",
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
};

function responseWithHeaders(response: Response, headersToApply: Readonly<Record<string, string>>, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Request-Id', requestId);
  for (const [name, value] of Object.entries(headersToApply)) {
    headers.set(name, value);
  }

  return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith(API_PATH_PREFIX)) {
      const aviationData = env.RUNWAY_PICKER_API
        ? createRunwayPickerAdapter(env.RUNWAY_PICKER_API, env.RUNWAY_PICKER_ORIGIN ?? 'https://runway-picker.internal')
        : undefined;
      return handleApiRequest(request, { APP_VERSION: env.APP_VERSION, APP_COMMIT_SHA: env.APP_COMMIT_SHA, aviationData });
    }

    const assetResponse = await env.ASSETS.fetch(request);
    return responseWithHeaders(assetResponse, STATIC_SECURITY_HEADERS, crypto.randomUUID());
  }
};
