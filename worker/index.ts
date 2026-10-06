import { createRunwayPickerAdapter, type ServiceFetcher } from './api/adapters';
import { ApiError, errorPayload } from './api/errors';
import { handleApiRequest } from './api/handlers';
import { createRequestId } from './api/request';
import { errorResponse } from './api/response';
import { createAviationWeatherAdapter, type CacheStore } from './api/winds';
import { createWeatherResourceClient } from './api/weather-resource-client';
import { createSharedWeatherResourceStore, type SharedWeatherResourceStore, type WeatherCacheEnvironment } from './api/weather-resource-store';

interface RateLimiter { limit(options: { key: string }): Promise<{ success: boolean }>; }

export interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  APP_VERSION?: string;
  APP_COMMIT_SHA?: string;
  APP_ENV?: string;
  RUNWAY_PICKER_API?: ServiceFetcher;
  RUNWAY_PICKER_ORIGIN?: string;
  WINDS_CACHE?: CacheStore;
  API_RATE_LIMITER?: RateLimiter;
  AWC_COORDINATOR_API?: ServiceFetcher;
}

interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; }

const API_PATH_PREFIX = '/api/';

function unavailableResponse(requestId: string): Response {
  return errorResponse(errorPayload(new ApiError('API temporarily unavailable.', 503, 'service_unavailable'), requestId), 503);
}

function weatherCacheEnvironment(appEnvironment: string | undefined): WeatherCacheEnvironment | undefined {
  if (appEnvironment === 'local') return 'development';
  return appEnvironment === 'development' || appEnvironment === 'production' ? appEnvironment : undefined;
}

async function admitApiRequest(request: Request, env: Env, requestId: string): Promise<Response | undefined> {
  if (!env.API_RATE_LIMITER) return env.APP_ENV === 'local' ? undefined : unavailableResponse(requestId);
  try {
    const sourceKey = request.headers.get('CF-Connecting-IP') ?? 'unattributed';
    const decision = await env.API_RATE_LIMITER.limit({ key: sourceKey });
    if (!decision.success) return errorResponse(errorPayload(new ApiError('Too many requests. Please retry shortly.', 429, 'rate_limited'), requestId), 429);
    return undefined;
  } catch { return unavailableResponse(requestId); }
}

interface WeatherStoreScope {
  noCache: Map<WeatherCacheEnvironment, SharedWeatherResourceStore>;
  byCache: WeakMap<object, Map<WeatherCacheEnvironment, SharedWeatherResourceStore>>;
}
const coordinatorWeatherStores = new WeakMap<object, WeatherStoreScope>();

function weatherStoreFor(environment: WeatherCacheEnvironment, coordinator: ServiceFetcher, cache?: CacheStore): SharedWeatherResourceStore {
  let scope = coordinatorWeatherStores.get(coordinator as object);
  if (!scope) { scope = { noCache: new Map(), byCache: new WeakMap() }; coordinatorWeatherStores.set(coordinator as object, scope); }
  const stores = cache
    ? getOrCreateCacheStores(scope, cache as object)
    : scope.noCache;
  let store = stores.get(environment);
  if (!store) { store = createSharedWeatherResourceStore(); stores.set(environment, store); }
  return store;
}

function getOrCreateCacheStores(scope: WeatherStoreScope, cache: object): Map<WeatherCacheEnvironment, SharedWeatherResourceStore> {
  let stores = scope.byCache.get(cache);
  if (!stores) { stores = new Map(); scope.byCache.set(cache, stores); }
  return stores;
}


function createWindsAdapter(env: Env, edgeCache: CacheStore | undefined, environment: WeatherCacheEnvironment | undefined, context?: ExecutionContext) {
  const coordinator = env.AWC_COORDINATOR_API;
  if (!coordinator || !environment) return undefined;
  const shared = weatherStoreFor(environment, coordinator, edgeCache);
  const client = createWeatherResourceClient(coordinator, edgeCache, environment, undefined, context?.waitUntil.bind(context), shared);
  return createAviationWeatherAdapter(client, () => new Date(), shared);
}

export function getWeatherResourceCacheStatsForTesting(environment: WeatherCacheEnvironment, coordinator: ServiceFetcher, cache?: CacheStore): ReturnType<SharedWeatherResourceStore['snapshot']> {
  return weatherStoreFor(environment, coordinator, cache).snapshot(environment);
}
export default {
  async fetch(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith(API_PATH_PREFIX)) {
      const requestId = createRequestId(request);
      const admissionError = await admitApiRequest(request, env, requestId);
      if (admissionError) return admissionError;
      const aviationData = env.RUNWAY_PICKER_API
        ? createRunwayPickerAdapter(env.RUNWAY_PICKER_API, env.RUNWAY_PICKER_ORIGIN ?? 'https://runway-picker.internal')
        : undefined;
      const edgeCache = env.WINDS_CACHE ?? (globalThis as unknown as { caches?: { default?: CacheStore } }).caches?.default;
      const weatherEnvironment = weatherCacheEnvironment(env.APP_ENV);
      const windsData = createWindsAdapter(env, edgeCache, weatherEnvironment, context);
      return handleApiRequest(request, { APP_VERSION: env.APP_VERSION, APP_COMMIT_SHA: env.APP_COMMIT_SHA, aviationData, windsData });
    }

    return env.ASSETS.fetch(request);
  }
};
