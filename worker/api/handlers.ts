import type { AviationDataAdapter } from './adapters';
import type { AirportSuccessPayload, MetarSuccessPayload, TafAnswer, WindsForecastSuccessPayload, WindsSourceProvenance, WindsStationsSuccessPayload } from './contracts';
import { ApiError, errorPayload } from './errors';
import { createRequestId, parseApiRoute, requireGet } from './request';
import { errorResponse, jsonResponse } from './response';
import type { WindsDataAdapter } from './winds';

export interface ApiEnvironment { APP_VERSION?: string; APP_COMMIT_SHA?: string; aviationData?: AviationDataAdapter; windsData?: WindsDataAdapter; tafData?: { getTaf(icao: string): Promise<Omit<TafAnswer, 'requestId'>> }; }

type TerminalRoute = Extract<ReturnType<typeof parseApiRoute>, { kind: 'airport' | 'metar' | 'taf' }>;
async function handleTerminalRoute(route: TerminalRoute, env: ApiEnvironment, requestId: string): Promise<Response> {
  if (route.kind === 'taf') {
    if (!env.tafData) throw new ApiError('TAF data service is not configured.', 503, 'service_unavailable');
    return jsonResponse({ ...(await env.tafData.getTaf(route.icao)), requestId }, 200, requestId);
  }
  if (!env.aviationData) throw new ApiError('Aviation data service is not configured.', 503, 'service_unavailable');
  if (route.kind === 'airport') {
    const { airport, cache } = await env.aviationData.getAirport(route.icao);
    const payload: AirportSuccessPayload = { airport, provenance: { adapter: 'runway-picker', fetchedAt: airport.fetchedAt, cache }, requestId };
    return jsonResponse(payload, 200, requestId);
  }
  const { metar, cache } = await env.aviationData.getMetar(route.icao);
  const payload: MetarSuccessPayload = { metar, provenance: { adapter: 'runway-picker', fetchedAt: metar.fetchedAt, cache }, requestId };
  return jsonResponse(payload, 200, requestId);
}

function normalizeBuildVersion(value: string | undefined): string { const candidate = value?.trim(); return candidate && /^v?[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(candidate) ? candidate : 'v0.0.0-dev'; }
function normalizeCommitSha(value: string | undefined): string { const candidate = value?.trim().toLowerCase(); return candidate && (/^[a-f0-9]{7,40}$/.test(candidate) || candidate === 'local') ? candidate : 'local'; }

export async function handleApiRequest(request: Request, env: ApiEnvironment): Promise<Response> {
  const requestId = createRequestId(request);
  try {
    requireGet(request);
    const route = parseApiRoute(request);
    if (route.kind === 'health') return jsonResponse({ status: 'ok', version: normalizeBuildVersion(env.APP_VERSION), commitSha: normalizeCommitSha(env.APP_COMMIT_SHA), requestId }, 200, requestId);
    if (route.kind === 'winds-stations') {
      if (!env.windsData) throw new ApiError('Winds data service is not configured.', 503, 'service_unavailable');
      const { stations, forecasts, unavailableForecastCycles, provenance } = await env.windsData.getWindsStations(route.route);
      const sourceProvenance: WindsSourceProvenance[] = provenance.map((cache) => ({ adapter: 'aviationweather', product: 'NCEP FB Winds/Temps (legacy FD)', region: stations[0]?.region ?? 'us', endpoint: 'https://aviationweather.gov/api/data/windtemp', fetchedAt: cache.fetchedAt, cache }));
      const payload: WindsStationsSuccessPayload = { stations, forecasts, unavailableForecastCycles, requestedRoute: route.route, provenance: sourceProvenance, requestId };
      return jsonResponse(payload, 200, requestId);
    }
    if (route.kind === 'winds-forecast') {
      if (!env.windsData) throw new ApiError('Winds data service is not configured.', 503, 'service_unavailable');
      const { forecast, provenance } = await env.windsData.getWindsForecast(route.station, route.validTime, route.region);
      const sourceProvenance: WindsSourceProvenance = { adapter: 'aviationweather', product: 'NCEP FB Winds/Temps (legacy FD)', region: route.region, endpoint: 'https://aviationweather.gov/api/data/windtemp', fetchedAt: provenance.fetchedAt, cache: provenance };
      const payload: WindsForecastSuccessPayload = { forecast, provenance: sourceProvenance, requestId };
      return jsonResponse(payload, 200, requestId);
    }
    if (route.kind === 'winds-point') {
      if (!env.windsData) throw new ApiError('Winds data service is not configured.', 503, 'service_unavailable');
      const answer = await env.windsData.getWindsPoint({ latitudeDeg: route.latitudeDeg, longitudeDeg: route.longitudeDeg, altitudeFeetMsl: route.altitudeFeetMsl, plannedUtc: route.plannedUtc });
      return jsonResponse({ ...answer, requestId }, 200, requestId);
    }
    return await handleTerminalRoute(route, env, requestId);
  } catch (error) {
    const apiError = error instanceof ApiError ? error : new ApiError('Unexpected API failure.', 500, 'upstream_unavailable');
    return errorResponse(errorPayload(apiError, requestId), apiError.status);
  }
}
