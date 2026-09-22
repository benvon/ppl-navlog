import type { AirportData, CacheProvenance, MetarData } from './contracts';
import { ApiError } from './errors';
import { readBoundedText } from './bounded-text';

const MAX_UPSTREAM_RESPONSE_BYTES = 256 * 1024;
const UPSTREAM_TIMEOUT_MS = 5_000;

export interface ServiceFetcher { fetch(request: Request): Promise<Response>; }
export interface AviationDataAdapter {
  getAirport(icao: string): Promise<{ airport: AirportData; cache: CacheProvenance }>;
  getMetar(icao: string): Promise<{ metar: MetarData; cache: CacheProvenance }>;
}

interface RunwayPickerAirportPayload extends AirportData { cache: CacheProvenance; }
interface RunwayPickerMetarPayload extends MetarData { cache: CacheProvenance; }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isFiniteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function isIsoTimestamp(value: unknown): value is string { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }

function isCacheProvenance(value: unknown): value is CacheProvenance {
  if (!isRecord(value)) return false;
  return new Set(['edge_hit', 'kv_hit', 'upstream_refresh', 'stale_while_refresh', 'stale_on_error']).has(value.status as string)
    && new Set(['edge', 'kv', 'upstream', 'stale']).has(value.source as string)
    && isFiniteNumber(value.ageSeconds) && isIsoTimestamp(value.fetchedAt) && isIsoTimestamp(value.expiresAt)
    && isFiniteNumber(value.freshnessRemainingSeconds) && isIsoTimestamp(value.servedAt) && isFiniteNumber(value.ttlSeconds)
    && isFiniteNumber(value.maxPayloadAgeSeconds) && typeof value.key === 'string' && typeof value.resource === 'string';
}

function isAirportCoordinates(value: unknown): boolean {
  return value === null || (isRecord(value) && isFiniteNumber(value.latitudeDeg) && isFiniteNumber(value.longitudeDeg));
}

function hasAirportIdentity(value: Record<string, unknown>, requestedIcao: string): boolean {
  return value.requestedIcao === requestedIcao && value.icao === requestedIcao;
}

function hasAirportDetails(value: Record<string, unknown>): boolean {
  return typeof value.name === 'string' && typeof value.municipality === 'string' && typeof value.countryCode === 'string' && typeof value.countryName === 'string';
}

function isRunwayEnd(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && isFiniteNumber(value.headingDegTrue) && typeof value.isClosed === 'boolean' && (value.lengthFt === null || isFiniteNumber(value.lengthFt));
}

function isAirportFrequency(value: unknown): boolean {
  return isRecord(value) && typeof value.type === 'string' && typeof value.description === 'string' && typeof value.frequencyMhz === 'string';
}

function hasAirportPhysicalData(value: Record<string, unknown>): boolean {
  return (value.elevationFt === null || isFiniteNumber(value.elevationFt)) && isAirportCoordinates(value.coordinates) && Array.isArray(value.runwayEnds) && value.runwayEnds.every(isRunwayEnd) && Array.isArray(value.frequencies) && value.frequencies.every(isAirportFrequency);
}

function isAirportPayload(value: unknown, requestedIcao: string): value is RunwayPickerAirportPayload {
  if (!isRecord(value) || !isCacheProvenance(value.cache)) return false;
  return hasAirportIdentity(value, requestedIcao) && hasAirportDetails(value) && hasAirportPhysicalData(value) && value.source === 'airportdb' && isIsoTimestamp(value.fetchedAt);
}

function isDirectionVariation(value: unknown): boolean {
  return value === null || (isRecord(value) && isFiniteNumber(value.fromDegTrue) && isFiniteNumber(value.toDegTrue));
}

function isMetarWind(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const directionValid = new Set(['fixed', 'variable', 'calm']).has(value.directionType as string) && (value.directionDegTrue === null || isFiniteNumber(value.directionDegTrue));
  const speedValid = isFiniteNumber(value.speedKt) && (value.gustKt === null || isFiniteNumber(value.gustKt));
  return typeof value.raw === 'string' && directionValid && speedValid && isDirectionVariation(value.directionVariation);
}

function isMetarPayload(value: unknown, requestedIcao: string): value is RunwayPickerMetarPayload {
  if (!isRecord(value) || !isMetarWind(value.wind) || !isCacheProvenance(value.cache)) return false;
  const timingValid = isIsoTimestamp(value.fetchedAt) && (value.observedAt === null || isIsoTimestamp(value.observedAt));
  return value.icao === requestedIcao && typeof value.metarRaw === 'string' && value.source === 'aviationweather' && timingValid;
}

async function readJsonResponse(fetcher: ServiceFetcher, request: Request): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetcher.fetch(new Request(request, { signal: controller.signal }));
    if (!response.ok) throw new ApiError('Aviation data service is unavailable.', 503, 'upstream_unavailable');
    let text: string;
    try { text = await readBoundedText(response, MAX_UPSTREAM_RESPONSE_BYTES); }
    catch { throw new ApiError('Aviation data service returned an oversized or unreadable response.', 502, 'upstream_invalid_response'); }
    try { return JSON.parse(text) as unknown; } catch { throw new ApiError('Aviation data service returned invalid JSON.', 502, 'upstream_invalid_response'); }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('Aviation data service is unavailable.', 503, 'upstream_unavailable');
  } finally { clearTimeout(timeout); }
}

export function createRunwayPickerAdapter(fetcher: ServiceFetcher, baseUrl: string): AviationDataAdapter {
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:') throw new Error('Runway-picker adapter base URL must use HTTP or HTTPS.');
  async function requestResource(path: string, icao: string): Promise<unknown> {
    const url = new URL(path, origin);
    url.searchParams.set('icao', icao);
    return readJsonResponse(fetcher, new Request(url, { method: 'GET', headers: { Accept: 'application/json' } }));
  }
  return {
    async getAirport(icao) {
      const payload = await requestResource('/api/airport', icao);
      if (!isAirportPayload(payload, icao)) throw new ApiError('Aviation data service returned an invalid airport response.', 502, 'upstream_invalid_response');
      const { cache, ...airport } = payload;
      return { airport, cache };
    },
    async getMetar(icao) {
      const payload = await requestResource('/api/metar', icao);
      if (!isMetarPayload(payload, icao)) throw new ApiError('Aviation data service returned an invalid METAR response.', 502, 'upstream_invalid_response');
      const { cache, ...metar } = payload;
      return { metar, cache };
    }
  };
}
