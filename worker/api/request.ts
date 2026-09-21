import { ICAO_PATTERN } from './contracts';
import { ApiError } from './errors';

const REQUEST_ID_HEADER = 'X-Request-Id';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ApiRoute = { readonly kind: 'health' } | { readonly kind: 'airport'; readonly icao: string } | { readonly kind: 'metar'; readonly icao: string };

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

export function parseApiRoute(request: Request): ApiRoute {
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length > 0) throw new ApiError('Query parameters are not accepted by this endpoint.', 400, 'invalid_request');
  const segments = url.pathname.split('/').filter(Boolean);
  const healthRoute = hasSegments(segments, ['api', 'health']);
  const airportRoute = hasSegments(segments.slice(0, 2), ['api', 'airports']) && segments.length === 3;
  const metarRoute = hasSegments(segments.slice(0, 3), ['api', 'weather', 'metar']) && segments.length === 4;
  if (healthRoute) return { kind: 'health' };
  if (airportRoute) return { kind: 'airport', icao: normalizeIcao(segments[2] ?? '') };
  if (metarRoute) return { kind: 'metar', icao: normalizeIcao(segments[3] ?? '') };
  throw new ApiError('API route not found.', 404, 'not_found');
}
