import { ICAO_PATTERN, type WindsRegion, type WindsRoutePoint } from './contracts';
import { ApiError } from './errors';

const REQUEST_ID_HEADER = 'X-Request-Id';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ApiRoute = { readonly kind: 'health' } | { readonly kind: 'airport'; readonly icao: string } | { readonly kind: 'metar'; readonly icao: string }
  | { readonly kind: 'winds-stations'; readonly route: WindsRoutePoint[] }
  | { readonly kind: 'winds-forecast'; readonly station: string; readonly validTime: string; readonly region: WindsRegion };

export function createRequestId(request: Request): string {
  const suppliedRequestId = request.headers.get(REQUEST_ID_HEADER)?.trim();
  return suppliedRequestId && UUID_PATTERN.test(suppliedRequestId) ? suppliedRequestId : crypto.randomUUID();
}

export function requireGet(request: Request): void {
  if (request.method !== 'GET') throw new ApiError('Method not allowed.', 405, 'method_not_allowed');
}

function normalizeIcao(value: string): string {
  const icao = value.trim().toUpperCase();
  if (!ICAO_PATTERN.test(icao)) throw new ApiError('Invalid ICAO code. Expected exactly four alphanumeric characters.', 400, 'invalid_request');
  return icao;
}

function hasSegments(segments: string[], expected: readonly string[]): boolean {
  return segments.length === expected.length && expected.every((segment, index) => segments[index] === segment);
}

function requiredSingleQuery(url: URL, name: string): string {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || !values[0]) throw new ApiError(`Expected exactly one ${name} query parameter.`, 400, 'invalid_request');
  return values[0];
}

function parseRoute(value: string): WindsRoutePoint[] {
  if (value.length > 4_096) throw new ApiError('route query exceeds the supported length.', 400, 'invalid_request');
  const points = value.split(';');
  if (points.length < 1 || points.length > 100) throw new ApiError('route must contain between one and 100 latitude,longitude points.', 400, 'invalid_request');
  return points.map((point) => {
    const match = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?),(-?(?:0|[1-9]\d*)(?:\.\d+)?)$/.exec(point);
    if (!match) throw new ApiError('route points must use canonical decimal latitude,longitude values.', 400, 'invalid_request');
    const latitudeDeg = Number(match[1]);
    const longitudeDeg = Number(match[2]);
    if (!Number.isFinite(latitudeDeg) || !Number.isFinite(longitudeDeg) || latitudeDeg < -90 || latitudeDeg > 90 || longitudeDeg < -180 || longitudeDeg > 180) throw new ApiError('route contains an out-of-range coordinate.', 400, 'invalid_request');
    return { latitudeDeg, longitudeDeg };
  });
}

function parseWindsStation(value: string): string {
  const station = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{3}$/.test(station)) throw new ApiError('Invalid Winds/Temps station identifier. Expected exactly three alphanumeric characters.', 400, 'invalid_request');
  return station;
}

function parseValidTime(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) throw new ApiError('validTime must be a canonical UTC ISO timestamp.', 400, 'invalid_request');
  return value;
}

function parseWindsRegion(value: string): WindsRegion {
  if (value === 'us' || value === 'alaska' || value === 'hawaii') return value;
  throw new ApiError('region must be one of us, alaska, or hawaii.', 400, 'invalid_request');
}

export function parseApiRoute(request: Request): ApiRoute {
  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter(Boolean);
  const baseRoute = parseBaseRoute(segments, url);
  if (baseRoute) return baseRoute;
  const windsRoute = parseWindsRoute(segments, url);
  if (windsRoute) return windsRoute;
  throw new ApiError('API route not found.', 404, 'not_found');
}

function parseBaseRoute(segments: string[], url: URL): ApiRoute | null {
  const healthRoute = hasSegments(segments, ['api', 'health']);
  const airportRoute = hasSegments(segments.slice(0, 2), ['api', 'airports']) && segments.length === 3;
  const metarRoute = hasSegments(segments.slice(0, 3), ['api', 'weather', 'metar']) && segments.length === 4;
  if (healthRoute) {
    if ([...url.searchParams.keys()].length > 0) throw new ApiError('Query parameters are not accepted by this endpoint.', 400, 'invalid_request');
    return { kind: 'health' };
  }
  if (airportRoute) {
    if ([...url.searchParams.keys()].length > 0) throw new ApiError('Query parameters are not accepted by this endpoint.', 400, 'invalid_request');
    return { kind: 'airport', icao: normalizeIcao(segments[2] ?? '') };
  }
  if (metarRoute) {
    if ([...url.searchParams.keys()].length > 0) throw new ApiError('Query parameters are not accepted by this endpoint.', 400, 'invalid_request');
    return { kind: 'metar', icao: normalizeIcao(segments[3] ?? '') };
  }
  return null;
}

function parseWindsRoute(segments: string[], url: URL): ApiRoute | null {
  const windsStationsRoute = hasSegments(segments, ['api', 'weather', 'winds', 'stations']);
  const windsForecastRoute = hasSegments(segments, ['api', 'weather', 'winds']);
  if (windsStationsRoute) {
    if ([...url.searchParams.keys()].some((key) => key !== 'route')) throw new ApiError('Only the route query parameter is accepted by this endpoint.', 400, 'invalid_request');
    return { kind: 'winds-stations', route: parseRoute(requiredSingleQuery(url, 'route')) };
  }
  if (windsForecastRoute) {
    if ([...url.searchParams.keys()].some((key) => key !== 'station' && key !== 'validTime' && key !== 'region')) throw new ApiError('Only station, validTime, and region query parameters are accepted by this endpoint.', 400, 'invalid_request');
    return { kind: 'winds-forecast', station: parseWindsStation(requiredSingleQuery(url, 'station')), validTime: parseValidTime(requiredSingleQuery(url, 'validTime')), region: parseWindsRegion(requiredSingleQuery(url, 'region')) };
  }
  return null;
}
