import type {
  AirportCoordinates,
  CacheProvenance,
  WindsAloftLevel,
  WindsForecast,
  WindsForecastAvailability,
  WindsForecastCycle,
  WindsRegion,
  WindsRoutePoint,
  WindsStation
} from './contracts';
import { ApiError } from './errors';
import { readBoundedText } from './bounded-text';

const AVIATION_WEATHER_ORIGIN = 'https://aviationweather.gov';
const MAX_RESPONSE_BYTES = 512 * 1024;
const UPSTREAM_TIMEOUT_MS = 5_000;
const FRESH_TTL_MS = 20 * 60 * 1_000;
const STALE_TTL_MS = 2 * 60 * 60 * 1_000;
const MAX_STATION_IDS_PER_REQUEST = 100;
const FORECAST_CYCLES: readonly WindsForecastCycle[] = ['06', '12', '24'];

export interface ServiceFetcher { fetch(request: Request): Promise<Response>; }
export interface CacheStore { match(request: Request): Promise<Response | undefined>; put(request: Request, response: Response): Promise<void>; }

export interface WindsDataAdapter {
  getWindsStations(route: readonly WindsRoutePoint[]): Promise<{ stations: WindsStation[]; forecasts: WindsForecastAvailability[]; provenance: CacheProvenance[] }>;
  getWindsForecast(station: string, validTime: string, region: WindsRegion): Promise<{ forecast: WindsForecast; provenance: CacheProvenance }>;
}

interface CachedProduct {
  fetchedAt: string;
  freshUntil: string;
  staleUntil: string;
  region: WindsRegion;
  cycle: WindsForecastCycle;
  rawProduct: string;
  forecasts: DecodedForecast[];
}

interface DecodedForecast extends WindsForecastAvailability { readonly stationId: string; readonly levels: WindsAloftLevel[]; }
interface StationInfo { readonly id: string; readonly name: string | null; readonly coordinates: AirportCoordinates; readonly elevationFt: number | null; }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isFiniteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function isIsoTimestamp(value: unknown): value is string { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function isWindsRegion(value: unknown): value is WindsRegion { return value === 'us' || value === 'alaska' || value === 'hawaii'; }
function isCycle(value: unknown): value is WindsForecastCycle { return value === '06' || value === '12' || value === '24'; }
function isCoordinates(value: unknown): value is AirportCoordinates { return isRecord(value) && isFiniteNumber(value.latitudeDeg) && value.latitudeDeg >= -90 && value.latitudeDeg <= 90 && isFiniteNumber(value.longitudeDeg) && value.longitudeDeg >= -180 && value.longitudeDeg <= 180; }

function validateRoute(route: readonly WindsRoutePoint[]): void {
  if (route.length < 1 || route.length > 100 || !route.every(isCoordinates)) throw new ApiError('A winds route must contain between one and 100 valid latitude/longitude points.', 400, 'invalid_request');
}

export function regionForRoute(route: readonly WindsRoutePoint[]): WindsRegion {
  validateRoute(route);
  const regions = new Set(route.map(regionForPoint));
  if (regions.size !== 1) throw new ApiError('Winds route points must be within one supported forecast region.', 400, 'invalid_request');
  return [...regions][0] as WindsRegion;
}

function regionForPoint(point: AirportCoordinates): WindsRegion {
  if (isAlaska(point)) return 'alaska';
  if (isHawaii(point)) return 'hawaii';
  if (isContiguousUs(point)) return 'us';
  throw new ApiError('The official legacy Winds/Temps product does not cover this route location in v1.', 400, 'invalid_request');
}

function isAlaska(point: AirportCoordinates): boolean { return point.latitudeDeg >= 50 && point.latitudeDeg <= 75 && point.longitudeDeg >= -180 && point.longitudeDeg <= -129; }
function isHawaii(point: AirportCoordinates): boolean { return point.latitudeDeg >= 17 && point.latitudeDeg <= 24 && point.longitudeDeg >= -161 && point.longitudeDeg <= -154; }
function isContiguousUs(point: AirportCoordinates): boolean { return point.latitudeDeg >= 24 && point.latitudeDeg <= 50 && point.longitudeDeg >= -130 && point.longitudeDeg <= -60; }

function cacheRequest(region: WindsRegion, cycle: WindsForecastCycle): Request {
  return new Request(`https://ppl-navlog-cache.invalid/winds/${region}/${cycle}`);
}

function cacheProvenance(status: CacheProvenance['status'], source: CacheProvenance['source'], cacheKey: string, fetchedAt: string, freshUntil: string, staleUntil: string, now: Date): CacheProvenance {
  const fetchedMs = Date.parse(fetchedAt);
  const freshMs = Date.parse(freshUntil);
  const staleMs = Date.parse(staleUntil);
  return {
    status,
    source,
    ageSeconds: Math.max(0, Math.floor((now.getTime() - fetchedMs) / 1_000)),
    fetchedAt,
    expiresAt: freshUntil,
    freshnessRemainingSeconds: Math.max(0, Math.floor((freshMs - now.getTime()) / 1_000)),
    servedAt: now.toISOString(),
    ttlSeconds: Math.floor((freshMs - fetchedMs) / 1_000),
    maxPayloadAgeSeconds: Math.floor((staleMs - fetchedMs) / 1_000),
    key: cacheKey,
    resource: 'winds-temps'
  };
}

function isLevel(value: unknown): value is WindsAloftLevel {
  return isRecord(value) && isFiniteNumber(value.altitudeFt) && (value.windFromDegTrue === null || isFiniteNumber(value.windFromDegTrue))
    && (value.windSpeedKt === null || isFiniteNumber(value.windSpeedKt)) && (value.temperatureC === null || isFiniteNumber(value.temperatureC))
    && (value.availability === 'available' || value.availability === 'unavailable') && typeof value.raw === 'string';
}

function isDecodedForecast(value: unknown): value is DecodedForecast {
  return isRecord(value) && typeof value.stationId === 'string' && isCycle(value.forecastCycle) && isIsoTimestamp(value.issuedAt) && isIsoTimestamp(value.validAt)
    && isIsoTimestamp(value.useFrom) && isIsoTimestamp(value.useUntil) && Array.isArray(value.levels) && value.levels.every(isLevel);
}

function isCachedProduct(value: unknown): value is CachedProduct {
  return isRecord(value) && isIsoTimestamp(value.fetchedAt) && isIsoTimestamp(value.freshUntil) && isIsoTimestamp(value.staleUntil) && isWindsRegion(value.region)
    && isCycle(value.cycle) && typeof value.rawProduct === 'string' && Array.isArray(value.forecasts) && value.forecasts.every(isDecodedForecast);
}

async function boundedText(fetcher: ServiceFetcher, request: Request): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetcher.fetch(new Request(request, { signal: controller.signal }));
    if (response.status === 204) throw new ApiError('No Winds/Temps forecast is available for this request.', 404, 'upstream_no_data');
    if (!response.ok) throw new ApiError('Aviation Weather Center is unavailable.', 503, 'upstream_unavailable');
    try { return await readBoundedText(response, MAX_RESPONSE_BYTES); }
    catch { throw new ApiError('Aviation Weather Center returned an oversized or unreadable Winds/Temps response.', 502, 'upstream_invalid_response'); }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('Aviation Weather Center is unavailable.', 503, 'upstream_unavailable');
  } finally { clearTimeout(timeout); }
}

function resolveDayTime(day: number, hour: number, minute: number, reference: Date): Date {
  const candidates: Date[] = [];
  for (const offset of [-1, 0, 1]) {
    const candidate = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + offset, day, hour, minute));
    if (candidate.getUTCDate() === day) candidates.push(candidate);
  }
  return candidates.reduce((closest, candidate) => Math.abs(candidate.getTime() - reference.getTime()) < Math.abs(closest.getTime() - reference.getTime()) ? candidate : closest);
}

function parseDateTimeGroup(value: string, reference: Date): Date {
  const match = /^(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) throw new ApiError('Aviation Weather Center returned an invalid Winds/Temps time group.', 502, 'upstream_invalid_response');
  const day = Number(match[1]);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (day < 1 || day > 31 || hour > 23 || minute > 59) throw new ApiError('Aviation Weather Center returned an out-of-range Winds/Temps time group.', 502, 'upstream_invalid_response');
  return resolveDayTime(day, hour, minute, reference);
}

function parseUseWindow(value: string, validAt: Date): { useFrom: Date; useUntil: Date } {
  const match = /^(\d{2})(\d{2})-(\d{2})(\d{2})Z$/.exec(value);
  if (!match) throw new ApiError('Aviation Weather Center returned an invalid Winds/Temps use window.', 502, 'upstream_invalid_response');
  const hours = [Number(match[1]), Number(match[3])];
  const minutes = [Number(match[2]), Number(match[4])];
  if (hours.some((hour) => hour > 23) || minutes.some((minute) => minute > 59)) throw new ApiError('Aviation Weather Center returned an out-of-range Winds/Temps use window.', 502, 'upstream_invalid_response');
  const toNearest = (hour: number, minute: number): Date => {
    const sameDay = new Date(Date.UTC(validAt.getUTCFullYear(), validAt.getUTCMonth(), validAt.getUTCDate(), hour, minute));
    const candidates = [-1, 0, 1].map((days) => new Date(sameDay.getTime() + days * 86_400_000));
    return candidates.reduce((closest, candidate) => Math.abs(candidate.getTime() - validAt.getTime()) < Math.abs(closest.getTime() - validAt.getTime()) ? candidate : closest);
  };
  const useFrom = toNearest(Number(match[1]), Number(match[2]));
  let useUntil = toNearest(Number(match[3]), Number(match[4]));
  if (useUntil <= useFrom) useUntil = new Date(useUntil.getTime() + 86_400_000);
  return { useFrom, useUntil };
}

function parseWind(raw: string): { windFromDegTrue: number | null; windSpeedKt: number | null; availability: WindsAloftLevel['availability'] } {
  if (raw.startsWith('9900')) return { windFromDegTrue: null, windSpeedKt: 0, availability: 'available' };
  const windPart = raw.slice(0, 4);
  if (!/^\d{4}$/.test(windPart)) throw new ApiError('Aviation Weather Center returned an invalid Winds/Temps wind group.', 502, 'upstream_invalid_response');
  let directionTens = Number(windPart.slice(0, 2));
  let speedKt = Number(windPart.slice(2, 4));
  if (directionTens > 50) { directionTens -= 50; speedKt += 100; }
  if (directionTens > 36 || speedKt > 199) throw new ApiError('Aviation Weather Center returned an out-of-range Winds/Temps wind group.', 502, 'upstream_invalid_response');
  return { windFromDegTrue: directionTens === 0 && speedKt === 0 ? null : directionTens * 10, windSpeedKt: speedKt, availability: 'available' };
}

function parseTemperature(altitudeFt: number, raw: string): number | null {
  const temperatureRaw = raw.slice(4);
  if (temperatureRaw.length === 0) return null;
  if (!/^[+-]?\d{2}$/.test(temperatureRaw)) throw new ApiError('Aviation Weather Center returned an invalid Winds/Temps temperature group.', 502, 'upstream_invalid_response');
  const temperatureC = Number(temperatureRaw);
  return !temperatureRaw.startsWith('+') && !temperatureRaw.startsWith('-') && altitudeFt >= 24_000 ? -temperatureC : temperatureC;
}

function decodeLevel(altitudeFt: number, raw: string): WindsAloftLevel {
  if (raw === '' || raw === '////' || raw === '//////' || raw === '///////') return { altitudeFt, windFromDegTrue: null, windSpeedKt: null, temperatureC: null, availability: 'unavailable', raw };
  const wind = parseWind(raw);
  return { altitudeFt, ...wind, temperatureC: parseTemperature(altitudeFt, raw), raw };
}

/**
 * FB fixed-width fields are not aligned to the display start of every altitude
 * label. The 3,000-ft group has no temperature (4 chars), 6,000–24,000-ft
 * groups reserve 8 chars, and 30,000-ft-and-above groups reserve 7 chars.
 */
function fbColumnWidth(altitudeFt: number): number {
  if (altitudeFt === 3_000) return 4;
  return altitudeFt >= 30_000 ? 7 : 8;
}

function fixedWidthLevels(row: string, columns: readonly { altitudeFt: number; start: number }[]): WindsAloftLevel[] {
  let start = columns[0]!.start;
  return columns.map((column) => {
    const width = fbColumnWidth(column.altitudeFt);
    const raw = row.slice(start, start + width).trim();
    start += width;
    return decodeLevel(column.altitudeFt, raw);
  });
}

/** Decodes the official NCEP FB Winds/Temps text product without altering its raw text. */
export function decodeWindsProduct(rawProduct: string, cycle: WindsForecastCycle, fetchedAt: Date): DecodedForecast[] {
  const normalized = rawProduct.replace(/\r/g, '');
  const issuedMatch = /DATA\s+BASED\s+ON\s+(\d{6}Z)/i.exec(normalized);
  const validMatch = /VALID\s+(\d{6}Z)\s+FOR\s+USE\s+(\d{4}-\d{4}Z)/i.exec(normalized);
  const levelsMatch = /^[ \t]*FT[ \t]+(.+)$/mi.exec(normalized);
  if (!issuedMatch || !validMatch || !levelsMatch) throw new ApiError('Aviation Weather Center returned a Winds/Temps product with required headers missing.', 502, 'upstream_invalid_response');
  const issuedAt = parseDateTimeGroup(issuedMatch[1]!, fetchedAt);
  const validAt = parseDateTimeGroup(validMatch[1]!, issuedAt);
  const { useFrom, useUntil } = parseUseWindow(validMatch[2]!, validAt);
  const header = levelsMatch[0];
  const columns = [...header.matchAll(/\b\d{4,5}\b/g)].map((match) => ({ altitudeFt: Number(match[0]), start: match.index as number }));
  const altitudes = columns.map((column) => column.altitudeFt);
  if (altitudes.length === 0 || altitudes.some((altitude) => !Number.isSafeInteger(altitude) || altitude < 3_000 || altitude > 53_000)) throw new ApiError('Aviation Weather Center returned invalid Winds/Temps altitude columns.', 502, 'upstream_invalid_response');
  const dataStart = (levelsMatch.index ?? 0) + header.length;
  const rows = normalized.slice(dataStart).split('\n').filter((line) => line.trim().length > 0);
  const forecasts: DecodedForecast[] = [];
  for (const row of rows) {
    const stationId = row.slice(0, columns[0]!.start).trim();
    if (!stationId || !/^[A-Z0-9]{3}$/.test(stationId)) continue;
    const levels = fixedWidthLevels(row, columns);
    forecasts.push({ stationId, forecastCycle: cycle, issuedAt: issuedAt.toISOString(), validAt: validAt.toISOString(), useFrom: useFrom.toISOString(), useUntil: useUntil.toISOString(), levels });
  }
  if (forecasts.length === 0) throw new ApiError('Aviation Weather Center returned a Winds/Temps product without reporting stations.', 502, 'upstream_invalid_response');
  return forecasts;
}

function stationEntry(value: unknown): { identifiers: string[]; info: Omit<StationInfo, 'id'> } | null {
  if (!isRecord(value) || !isFiniteNumber(value.lat) || !isFiniteNumber(value.lon) || value.lat < -90 || value.lat > 90 || value.lon < -180 || value.lon > 180) return null;
  const identifiers = [value.iataId, value.faaId, value.icaoId].filter((identifier): identifier is string => typeof identifier === 'string' && /^[A-Z0-9]{3,4}$/.test(identifier));
  const name = typeof value.site === 'string' && value.site.length <= 200 ? value.site : null;
  return { identifiers, info: { name, coordinates: { latitudeDeg: value.lat, longitudeDeg: value.lon }, elevationFt: isFiniteNumber(value.elev) ? value.elev : null } };
}

function parseStationInfo(value: unknown): Map<string, StationInfo> {
  if (!Array.isArray(value)) throw new ApiError('Aviation Weather Center returned an invalid station-info response.', 502, 'upstream_invalid_response');
  const result = new Map<string, StationInfo>();
  for (const entry of value) {
    const parsed = stationEntry(entry);
    if (!parsed) continue;
    for (const identifier of parsed.identifiers) result.set(identifier, { id: identifier, ...parsed.info });
  }
  return result;
}

async function stationInfo(fetcher: ServiceFetcher, stationIds: readonly string[]): Promise<Map<string, StationInfo>> {
  const result = new Map<string, StationInfo>();
  for (let start = 0; start < stationIds.length; start += MAX_STATION_IDS_PER_REQUEST) {
    const ids = stationIds.slice(start, start + MAX_STATION_IDS_PER_REQUEST);
    const url = new URL('/api/data/stationinfo', AVIATION_WEATHER_ORIGIN);
    url.searchParams.set('ids', ids.join(','));
    url.searchParams.set('format', 'json');
    const text = await boundedText(fetcher, new Request(url, { headers: { Accept: 'application/json', 'User-Agent': 'ppl-navlog/0.1 (educational flight planning)' } }));
    let payload: unknown;
    try { payload = JSON.parse(text) as unknown; } catch { throw new ApiError('Aviation Weather Center returned invalid station-info JSON.', 502, 'upstream_invalid_response'); }
    for (const [id, info] of parseStationInfo(payload)) result.set(id, info);
  }
  return result;
}

export function createAviationWeatherAdapter(fetcher: ServiceFetcher, cache: CacheStore | undefined, now: () => Date = () => new Date()): WindsDataAdapter {
  async function upstream(region: WindsRegion, cycle: WindsForecastCycle, fetchedAt: Date): Promise<CachedProduct> {
    const url = new URL('/api/data/windtemp', AVIATION_WEATHER_ORIGIN);
    url.searchParams.set('region', region);
    url.searchParams.set('level', 'low');
    url.searchParams.set('fcst', cycle);
    const rawProduct = await boundedText(fetcher, new Request(url, { headers: { Accept: 'text/plain', 'User-Agent': 'ppl-navlog/0.1 (educational flight planning)' } }));
    return { fetchedAt: fetchedAt.toISOString(), freshUntil: new Date(fetchedAt.getTime() + FRESH_TTL_MS).toISOString(), staleUntil: new Date(fetchedAt.getTime() + STALE_TTL_MS).toISOString(), region, cycle, rawProduct, forecasts: decodeWindsProduct(rawProduct, cycle, fetchedAt) };
  }

  async function product(region: WindsRegion, cycle: WindsForecastCycle): Promise<{ product: CachedProduct; provenance: CacheProvenance }> {
    const request = cacheRequest(region, cycle);
    const current = now();
    let cached: CachedProduct | undefined;
    if (cache) {
      const response = await cache.match(request);
      if (response) {
        try {
          const payload = await response.json() as unknown;
          if (isCachedProduct(payload)) cached = payload;
        } catch { /* Invalid edge cache values are discarded by replacement below. */ }
      }
    }
    if (cached && Date.parse(cached.freshUntil) > current.getTime()) return { product: cached, provenance: cacheProvenance('edge_hit', 'edge', request.url, cached.fetchedAt, cached.freshUntil, cached.staleUntil, current) };
    try {
      const refreshed = await upstream(region, cycle, current);
      if (cache) await cache.put(request, Response.json(refreshed, { headers: { 'Cache-Control': `max-age=${STALE_TTL_MS / 1_000}` } }));
      return { product: refreshed, provenance: cacheProvenance('upstream_refresh', 'upstream', request.url, refreshed.fetchedAt, refreshed.freshUntil, refreshed.staleUntil, current) };
    } catch (error) {
      if (cached && Date.parse(cached.staleUntil) > current.getTime()) return { product: cached, provenance: cacheProvenance('stale_on_error', 'stale', request.url, cached.fetchedAt, cached.freshUntil, cached.staleUntil, current) };
      throw error;
    }
  }

  async function allProducts(region: WindsRegion): Promise<Array<{ product: CachedProduct; provenance: CacheProvenance }>> {
    return Promise.all(FORECAST_CYCLES.map((cycle) => product(region, cycle)));
  }

  return {
    async getWindsStations(route) {
      const region = regionForRoute(route);
      const products = await allProducts(region);
      const stationCycles = new Map<string, Set<WindsForecastCycle>>();
      const availability = new Map<string, WindsForecastAvailability>();
      for (const { product: item } of products) for (const forecast of item.forecasts) {
        const cycles = stationCycles.get(forecast.stationId) ?? new Set<WindsForecastCycle>();
        cycles.add(forecast.forecastCycle);
        stationCycles.set(forecast.stationId, cycles);
        availability.set(`${forecast.forecastCycle}:${forecast.validAt}`, forecast);
      }
      const stationsById = await stationInfo(fetcher, [...stationCycles.keys()].sort());
      const stations = [...stationCycles.entries()].flatMap(([id, cycles]) => {
        const info = stationsById.get(id);
        return info ? [{ id, name: info.name, coordinates: info.coordinates, elevationFt: info.elevationFt, region, availableForecastCycles: [...cycles].sort() as WindsForecastCycle[], source: 'aviationweather' as const }] : [];
      }).sort((left, right) => left.id.localeCompare(right.id));
      if (stations.length === 0) throw new ApiError('No Winds/Temps reporting stations with verified coordinates are available for this forecast region.', 404, 'upstream_no_data');
      return { stations, forecasts: [...availability.values()].sort((left, right) => left.validAt.localeCompare(right.validAt) || left.forecastCycle.localeCompare(right.forecastCycle)), provenance: products.map(({ provenance }) => provenance) };
    },
    async getWindsForecast(station, validTime, region) {
      if (!/^[A-Z0-9]{3}$/.test(station)) throw new ApiError('Invalid Winds/Temps station identifier. Expected exactly three alphanumeric characters.', 400, 'invalid_request');
      const requestedMs = Date.parse(validTime);
      if (!Number.isFinite(requestedMs) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(validTime)) throw new ApiError('Invalid winds validTime. Expected a canonical UTC ISO timestamp.', 400, 'invalid_request');
      const matches: Array<{ forecast: DecodedForecast; product: CachedProduct; provenance: CacheProvenance }> = [];
      for (const item of await allProducts(region)) for (const forecast of item.product.forecasts) if (forecast.stationId === station && forecast.validAt === validTime) matches.push({ forecast, product: item.product, provenance: item.provenance });
      if (matches.length !== 1) throw new ApiError('The requested Winds/Temps station and valid time are not available. Select one of the published valid times.', 404, 'upstream_no_data');
      const match = matches[0] as { forecast: DecodedForecast; product: CachedProduct; provenance: CacheProvenance };
      const info = await stationInfo(fetcher, [station]);
      const stationInfoValue = info.get(station);
      if (!stationInfoValue) throw new ApiError('The requested Winds/Temps station does not have verified Aviation Weather Center coordinates.', 502, 'upstream_invalid_response');
      const windsStation: WindsStation = { id: station, name: stationInfoValue.name, coordinates: stationInfoValue.coordinates, elevationFt: stationInfoValue.elevationFt, region: match.product.region, availableForecastCycles: [match.forecast.forecastCycle], source: 'aviationweather' };
      return { forecast: { station: windsStation, forecastCycle: match.forecast.forecastCycle, issuedAt: match.forecast.issuedAt, validAt: match.forecast.validAt, useFrom: match.forecast.useFrom, useUntil: match.forecast.useUntil, levels: match.forecast.levels, rawProduct: match.product.rawProduct, source: 'aviationweather', fetchedAt: match.product.fetchedAt }, provenance: match.provenance };
    }
  };
}
