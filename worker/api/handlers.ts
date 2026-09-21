import type { AviationDataAdapter } from './adapters';
import type { AirportSuccessPayload, MetarSuccessPayload } from './contracts';
import { ApiError, errorPayload } from './errors';
import { createRequestId, parseApiRoute, requireGet } from './request';
import { errorResponse, jsonResponse } from './response';

export interface ApiEnvironment { APP_VERSION?: string; APP_COMMIT_SHA?: string; aviationData?: AviationDataAdapter; }

function normalizeBuildVersion(value: string | undefined): string { const candidate = value?.trim(); return candidate && /^v?[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(candidate) ? candidate : 'v0.0.0-dev'; }
function normalizeCommitSha(value: string | undefined): string { const candidate = value?.trim().toLowerCase(); return candidate && (/^[a-f0-9]{7,40}$/.test(candidate) || candidate === 'local') ? candidate : 'local'; }

export async function handleApiRequest(request: Request, env: ApiEnvironment): Promise<Response> {
  const requestId = createRequestId(request);
  try {
    requireGet(request);
    const route = parseApiRoute(request);
    if (route.kind === 'health') return jsonResponse({ status: 'ok', version: normalizeBuildVersion(env.APP_VERSION), commitSha: normalizeCommitSha(env.APP_COMMIT_SHA), requestId }, 200, requestId);
    if (!env.aviationData) throw new ApiError('Aviation data service is not configured.', 503, 'service_unavailable');
    if (route.kind === 'airport') {
      const { airport, cache } = await env.aviationData.getAirport(route.icao);
      const payload: AirportSuccessPayload = { airport, provenance: { adapter: 'runway-picker', fetchedAt: airport.fetchedAt, cache }, requestId };
      return jsonResponse(payload, 200, requestId);
    }
    const { metar, cache } = await env.aviationData.getMetar(route.icao);
    const payload: MetarSuccessPayload = { metar, provenance: { adapter: 'runway-picker', fetchedAt: metar.fetchedAt, cache }, requestId };
    return jsonResponse(payload, 200, requestId);
  } catch (error) {
    const apiError = error instanceof ApiError ? error : new ApiError('Unexpected API failure.', 500, 'upstream_unavailable');
    return errorResponse(errorPayload(apiError, requestId), apiError.status);
  }
}
