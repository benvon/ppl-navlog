import { createRunwayPickerAdapter, type ServiceFetcher } from './api/adapters';
import { ApiError, errorPayload } from './api/errors';
import { handleApiRequest } from './api/handlers';
import { createRequestId } from './api/request';
import { errorResponse } from './api/response';
import { createAviationWeatherAdapter, type CacheStore } from './api/winds';

interface RateLimiter { limit(options: { key: string }): Promise<{ success: boolean }>; }

export interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  APP_VERSION?: string;
  APP_COMMIT_SHA?: string;
  RUNWAY_PICKER_API?: ServiceFetcher;
  RUNWAY_PICKER_ORIGIN?: string;
  WINDS_CACHE?: CacheStore;
  API_RATE_LIMITER?: RateLimiter;
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
      const requestId = createRequestId(request);
      if (env.API_RATE_LIMITER) {
        const sourceKey = request.headers.get('CF-Connecting-IP') ?? 'unattributed';
        const decision = await env.API_RATE_LIMITER.limit({ key: sourceKey });
        if (!decision.success) return errorResponse(errorPayload(new ApiError('Too many requests. Please retry shortly.', 429, 'rate_limited'), requestId), 429);
      }
      const aviationData = env.RUNWAY_PICKER_API
        ? createRunwayPickerAdapter(env.RUNWAY_PICKER_API, env.RUNWAY_PICKER_ORIGIN ?? 'https://runway-picker.internal')
        : undefined;
      const edgeCache = env.WINDS_CACHE ?? (globalThis as unknown as { caches?: { default?: CacheStore } }).caches?.default;
      const windsData = createAviationWeatherAdapter({ fetch: globalThis.fetch.bind(globalThis) }, edgeCache);
      return handleApiRequest(request, { APP_VERSION: env.APP_VERSION, APP_COMMIT_SHA: env.APP_COMMIT_SHA, aviationData, windsData });
    }

    const assetResponse = await env.ASSETS.fetch(request);
    return responseWithHeaders(assetResponse, STATIC_SECURITY_HEADERS, crypto.randomUUID());
  }
};
