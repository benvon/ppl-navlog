import type {
  AirportCoordinates,
  AloftPointAnswer,
  AloftPointQuery,
  WeatherResourceCacheProvenance,
  WindsAloftLevel,
  WindsForecast,
  WindsForecastAvailability,
  WindsForecastCycle,
  WindsRegion,
  WindsRoutePoint,
  WindsStation
} from './contracts';
import { ApiError } from './errors';
import { decodeWindsProduct } from '../weather-resources/validation';
export { decodeWindsProduct };
import type { CachedStationCatalog, CachedWindsProduct, WeatherResourcePort, WeatherResourceEnvelope, WeatherResourceKey } from '../weather-resources/contracts';

const MAX_POINT_DISTANCE_NM = 100;
const MAX_POINT_SOURCES = 3;
const FORECAST_CYCLES: readonly WindsForecastCycle[] = ['06', '12', '24'];

export interface ServiceFetcher { fetch(request: Request): Promise<Response>; }
export interface CacheStore { match(request: Request): Promise<Response | undefined>; put(request: Request, response: Response): Promise<void>; }

export interface WindsDataAdapter {
  getWindsPoint(query: AloftPointQuery): Promise<AloftPointAnswer>;
  getWindsStations(route: readonly WindsRoutePoint[]): Promise<{ stations: WindsStation[]; forecasts: WindsForecastAvailability[]; unavailableForecastCycles: WindsForecastCycle[]; provenance: WeatherResourceCacheProvenance[]; catalog: WeatherResourceCacheProvenance }>;
  getWindsForecast(station: string, validTime: string, region: WindsRegion): Promise<{ forecast: WindsForecast; provenance: WeatherResourceCacheProvenance; catalog: WeatherResourceCacheProvenance }>;
}

type CachedProduct = CachedWindsProduct & { checkedAt: string; refreshAfter: string; staleUntil: string; status: WeatherResourceCacheProvenance['status']; source: WeatherResourceCacheProvenance['source'] };

interface DecodedForecast extends WindsForecastAvailability { readonly stationId: string; readonly levels: WindsAloftLevel[]; }
interface StationInfo { readonly id: string; readonly name: string | null; readonly coordinates: AirportCoordinates; readonly elevationFt: number | null; }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isFiniteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
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


function requireUniqueForecastMatch(
  matches: readonly { readonly forecast: DecodedForecast; readonly product: CachedProduct; readonly provenance: WeatherResourceCacheProvenance }[],
  unavailableCycles: readonly WindsForecastCycle[],
): void {
  if (matches.length === 1) return;
  if (matches.length > 1) throw new ApiError('The requested Winds/Temps station and valid time match multiple forecast cycles.', 502, 'upstream_invalid_response');
  if (unavailableCycles.length > 0) throw new ApiError('The requested forecast is inconclusive because one or more supported cycles are unavailable.', 503, 'upstream_unavailable');
  throw new ApiError('The requested Winds/Temps station and valid time are not available. Select one of the published valid times.', 404, 'upstream_no_data');
}

function stationInfo(catalog: CachedStationCatalog, stationIds: readonly string[], expectedRegion: WindsRegion): Map<string, StationInfo> {
  const requestedIds = new Set(stationIds);
  const matches = new Map<string, StationInfo[]>();
  for (const entry of catalog.entries) {
    const identifier = entry.iataId;
    if (identifier && requestedIds.has(identifier)) {
      const records = matches.get(identifier) ?? [];
      records.push({ id: identifier, ...entry.info });
      matches.set(identifier, records);
    }
  }
  const result = new Map<string, StationInfo>();
  for (const identifier of requestedIds) {
    const records = matches.get(identifier) ?? [];
    if (records.length > 1) throw new ApiError('Aviation Weather Center station catalog returned conflicting identities for a reported station.', 502, 'upstream_invalid_response');
    if (records.length === 0) continue;
    let actualRegion: WindsRegion;
    try { actualRegion = regionForPoint(records[0]!.coordinates); }
    catch { throw new ApiError('Aviation Weather Center station catalog placed a reported station outside its supported product region.', 502, 'upstream_invalid_response'); }
    if (actualRegion !== expectedRegion) throw new ApiError('Aviation Weather Center station catalog placed a reported station in a different product region.', 502, 'upstream_invalid_response');
    result.set(identifier, records[0]!);
  }
  return result;
}

/** Point interpolation only uses exact, unique, catalog-verified identities in the product region. */
function pointStationInfo(catalog: CachedStationCatalog, stationIds: readonly string[], expectedRegion: WindsRegion): Map<string, StationInfo> {
  const requestedIds = new Set(stationIds);
  const matches = new Map<string, StationInfo[]>();
  for (const entry of catalog.entries) {
    const identifier = entry.iataId;
    if (identifier && requestedIds.has(identifier)) {
      const records = matches.get(identifier) ?? [];
      records.push({ id: identifier, ...entry.info });
      matches.set(identifier, records);
    }
  }
  const result = new Map<string, StationInfo>();
  for (const identifier of requestedIds) {
    const records = matches.get(identifier) ?? [];
    if (records.length > 1) throw new ApiError('Aviation Weather Center station catalog returned conflicting identities for a reported station.', 502, 'upstream_invalid_response');
    if (records.length === 0) continue;
    try {
      if (regionForPoint(records[0]!.coordinates) === expectedRegion) result.set(identifier, records[0]!);
    } catch { /* Uncovered catalog entries cannot participate in geographic math. */ }
  }
  return result;
}

const radians = (degrees: number): number => degrees * Math.PI / 180;
function distanceNm(left: AirportCoordinates, right: AirportCoordinates): number {
  const lat1 = radians(left.latitudeDeg);
  const lat2 = radians(right.latitudeDeg);
  const dLat = lat2 - lat1;
  const dLon = radians(right.longitudeDeg - left.longitudeDeg);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 3_440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function verticalLevels(levels: readonly WindsAloftLevel[], altitude: number): { lower: WindsAloftLevel; upper: WindsAloftLevel; weight: number } | null {
  const available = levels.filter((level) => level.availability === 'available' && level.windSpeedKt !== null && level.windSpeedKt >= 0);
  const lower = [...available].filter((level) => level.altitudeFt <= altitude).sort((a, b) => b.altitudeFt - a.altitudeFt)[0];
  const upper = [...available].filter((level) => level.altitudeFt >= altitude).sort((a, b) => a.altitudeFt - b.altitudeFt)[0];
  if (!lower || !upper) return null;
  return { lower, upper, weight: lower.altitudeFt === upper.altitudeFt ? 0 : (altitude - lower.altitudeFt) / (upper.altitudeFt - lower.altitudeFt) };
}

type TemperatureInterpolation = { value: number; lowerAltitudeFeet: number; upperAltitudeFeet: number; verticalWeight: number; lowerC: number; upperC: number };
function temperatureAtAltitude(levels: readonly WindsAloftLevel[], altitude: number): TemperatureInterpolation | null {
  const available = levels.filter((level) => level.availability === 'available' && level.temperatureC !== null);
  const lower = [...available].filter((level) => level.altitudeFt <= altitude).sort((a, b) => b.altitudeFt - a.altitudeFt)[0];
  const upper = [...available].filter((level) => level.altitudeFt >= altitude).sort((a, b) => a.altitudeFt - b.altitudeFt)[0];
  if (!lower || !upper) return null;
  const weight = lower.altitudeFt === upper.altitudeFt ? 0 : (altitude - lower.altitudeFt) / (upper.altitudeFt - lower.altitudeFt);
  return { value: lower.temperatureC! + (upper.temperatureC! - lower.temperatureC!) * weight, lowerAltitudeFeet: lower.altitudeFt, upperAltitudeFeet: upper.altitudeFt, verticalWeight: weight, lowerC: lower.temperatureC!, upperC: upper.temperatureC! };
}

function levelVector(level: WindsAloftLevel): { u: number; v: number } {
  if (level.windSpeedKt === 0 || level.windFromDegTrue === null) return { u: 0, v: 0 };
  const direction = radians(level.windFromDegTrue);
  return { u: -(level.windSpeedKt ?? 0) * Math.sin(direction), v: -(level.windSpeedKt ?? 0) * Math.cos(direction) };
}

function interpolateVector(lower: WindsAloftLevel, upper: WindsAloftLevel, weight: number): { u: number; v: number } {
  const a = levelVector(lower);
  const b = levelVector(upper);
  return { u: a.u + (b.u - a.u) * weight, v: a.v + (b.v - a.v) * weight };
}

function windFromVector(u: number, v: number): { direction: number | null; speed: number } {
  const speed = Math.hypot(u, v);
  if (speed < 0.01) return { direction: null, speed: 0 };
  return { direction: (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360, speed };
}

type ProductEntry = { product: CachedProduct; provenance: WeatherResourceCacheProvenance };
type ApplicableProduct = ProductEntry & { forecast: DecodedForecast };
type PointStation = { forecast: DecodedForecast; identity: StationInfo; levels: { lower: WindsAloftLevel; upper: WindsAloftLevel; weight: number }; distance: number; temperature: TemperatureInterpolation | null };

function validateAloftPointQuery(query: AloftPointQuery, current: Date): WindsRegion {
  if (!isCoordinates(query) || !Number.isSafeInteger(query.altitudeFeetMsl) || query.altitudeFeetMsl < 3_000 || query.altitudeFeetMsl > 53_000
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(query.plannedUtc) || !Number.isFinite(Date.parse(query.plannedUtc))
    || new Date(query.plannedUtc).toISOString() !== query.plannedUtc) throw new ApiError('Winds point query is outside supported coordinate, altitude, or UTC bounds.', 400, 'invalid_request');
  const plannedMs = Date.parse(query.plannedUtc);
  if (plannedMs < current.getTime() - 60 * 60 * 1_000 || plannedMs > current.getTime() + 48 * 60 * 60 * 1_000) throw new ApiError('Winds point query time is outside the supported planning horizon.', 400, 'invalid_request');
  return regionForPoint(query);
}

function chooseApplicableProduct(products: ProductEntry[], unavailableCycles: WindsForecastCycle[], failures: unknown[], query: AloftPointQuery, current: Date): ApplicableProduct {
  const boundedFailure = failures.find((failure): failure is ApiError => failure instanceof ApiError && failure.diagnostic !== undefined);
  if (boundedFailure) throw new ApiError('Aviation Weather Center returned an invalid Winds/Temps response.', 502, 'upstream_invalid_response', boundedFailure.diagnostic);
  if (unavailableCycles.length > 0) throw new ApiError('The point forecast is inconclusive because a supported forecast cycle could not be checked.', 503, 'upstream_unavailable');
  const plannedMs = Date.parse(query.plannedUtc);
  const candidates = products.flatMap((entry) => entry.product.forecasts
    .filter((forecast) => Date.parse(forecast.issuedAt) <= current.getTime() && Date.parse(forecast.issuedAt) <= plannedMs && Date.parse(forecast.useFrom) <= plannedMs && plannedMs < Date.parse(forecast.useUntil))
    .map((forecast) => ({ ...entry, forecast })))
    .sort((a, b) => Date.parse(b.forecast.issuedAt) - Date.parse(a.forecast.issuedAt) || a.forecast.forecastCycle.localeCompare(b.forecast.forecastCycle));
  const chosen = candidates[0];
  if (!chosen) throw new ApiError('No fresh Winds/Temps product covers the requested point time.', 404, 'upstream_no_data');
  const newestIssueCycles = new Set(candidates.filter((candidate) => candidate.forecast.issuedAt === chosen.forecast.issuedAt).map((candidate) => candidate.forecast.forecastCycle));
  if (newestIssueCycles.size > 1) throw new ApiError('Multiple distinct Winds/Temps products with the same newest issue cover the requested time.', 502, 'upstream_invalid_response');
  return chosen;
}

function selectPointStations(query: AloftPointQuery, chosen: ApplicableProduct, identities: Map<string, StationInfo>): PointStation[] {
  const sameIssue = chosen.product.forecasts.filter((forecast) => forecast.issuedAt === chosen.forecast.issuedAt);
  if (sameIssue.some((forecast) => forecast.useFrom !== chosen.forecast.useFrom || forecast.useUntil !== chosen.forecast.useUntil)) throw new ApiError('Aviation Weather Center returned mixed Winds/Temps periods for one product issue.', 502, 'upstream_invalid_response');
  const stations = chosen.product.forecasts.filter((forecast) => forecast.issuedAt === chosen.forecast.issuedAt && forecast.useFrom === chosen.forecast.useFrom && forecast.useUntil === chosen.forecast.useUntil)
    .flatMap((forecast) => {
      const identity = identities.get(forecast.stationId);
      const levels = verticalLevels(forecast.levels, query.altitudeFeetMsl);
      if (!identity || !levels) return [];
      const distance = distanceNm(query, identity.coordinates);
      return distance <= MAX_POINT_DISTANCE_NM ? [{ forecast, identity, levels, distance, temperature: temperatureAtAltitude(forecast.levels, query.altitudeFeetMsl) }] : [];
    }).sort((a, b) => a.distance - b.distance || a.forecast.stationId.localeCompare(b.forecast.stationId)).slice(0, MAX_POINT_SOURCES);
  if (stations.length === 0) throw new ApiError('No reporting station with usable levels is within supported point coverage.', 404, 'upstream_no_data');
  const exact = stations.find((station) => station.distance < 0.01);
  return exact ? [exact] : stations;
}

function answerFromPointStations(query: AloftPointQuery, chosen: ApplicableProduct, stations: PointStation[], catalog: WeatherResourceCacheProvenance): AloftPointAnswer {
  const inverseWeights = stations.map((station) => station.distance < 0.01 ? Number.POSITIVE_INFINITY : 1 / station.distance);
  const weightTotal = inverseWeights.some((weight) => !Number.isFinite(weight)) ? 1 : inverseWeights.reduce((sum, weight) => sum + weight, 0);
  const horizontalWeights = inverseWeights.map((weight) => Number.isFinite(weight) ? weight / weightTotal : 1);
  let u = 0; let v = 0; let temperatureTotal = 0;
  const temperatureAvailable = stations.every((station) => station.temperature !== null);
  stations.forEach((station, index) => {
    const weight = station.levels.weight;
    const vector = interpolateVector(station.levels.lower, station.levels.upper, weight);
    u += vector.u * horizontalWeights[index]!;
    v += vector.v * horizontalWeights[index]!;
    if (station.temperature !== null) temperatureTotal += station.temperature.value * horizontalWeights[index]!;
  });
  const wind = windFromVector(u, v);
  const sources = stations.map((station, index) => ({ stationId: station.forecast.stationId, latitudeDeg: station.identity.coordinates.latitudeDeg, longitudeDeg: station.identity.coordinates.longitudeDeg,
    distanceNauticalMiles: station.distance, horizontalWeight: horizontalWeights[index]!, lowerAltitudeFeet: station.levels.lower.altitudeFt, upperAltitudeFeet: station.levels.upper.altitudeFt, verticalWeight: station.levels.weight,
    lowerWindFromDegTrue: station.levels.lower.windFromDegTrue, lowerWindSpeedKt: station.levels.lower.windSpeedKt!,
    upperWindFromDegTrue: station.levels.upper.windFromDegTrue, upperWindSpeedKt: station.levels.upper.windSpeedKt!,
    temperatureLowerAltitudeFeet: station.temperature?.lowerAltitudeFeet ?? null, temperatureUpperAltitudeFeet: station.temperature?.upperAltitudeFeet ?? null,
    temperatureVerticalWeight: station.temperature?.verticalWeight ?? null,
    temperatureLowerC: station.temperature?.lowerC ?? null, temperatureUpperC: station.temperature?.upperC ?? null }));
  const vertical = stations.some((station) => station.levels.lower.altitudeFt !== station.levels.upper.altitudeFt);
  const horizontal = stations.length > 1;
  return { query, windFromDegTrue: wind.direction, windSpeedKt: wind.speed, temperatureC: temperatureAvailable ? temperatureTotal : null, issuedAt: chosen.forecast.issuedAt, useFrom: chosen.forecast.useFrom, useUntil: chosen.forecast.useUntil,
    forecastCycle: chosen.forecast.forecastCycle, product: { region: chosen.product.region, cycle: chosen.product.cycle, cache: chosen.provenance }, catalog: { cache: catalog }, sources, method: horizontal ? (vertical ? 'horizontal-vertical-vector' : 'horizontal-vector') : (vertical ? 'vertical-vector' : 'station-level'), requestId: '' };
}

function requireWeatherResource(result: Awaited<ReturnType<WeatherResourcePort['getResource']>>): asserts result is Extract<Awaited<ReturnType<WeatherResourcePort['getResource']>>, { ok: true }> {
  if (!result.ok) throw new ApiError('Weather data is temporarily unavailable.', 503, result.code, undefined, Date.parse(result.retryAt));
}

function needsWeatherRecheck(result: Extract<Awaited<ReturnType<WeatherResourcePort['getResource']>>, { ok: true }>, now: Date): boolean {
  return result.state === 'fresh' && now.getTime() >= Date.parse(result.resource.metadata.refreshAfter);
}

function afterWeatherRecheck(previous: Extract<Awaited<ReturnType<WeatherResourcePort['getResource']>>, { ok: true }>, refreshed: Awaited<ReturnType<WeatherResourcePort['getResource']>>, now: Date) {
  if (refreshed.ok) return refreshed;
  if (now.getTime() >= Date.parse(previous.resource.metadata.staleUntil)) throw new ApiError('Weather data is temporarily unavailable.', 503, refreshed.code, undefined, Date.parse(refreshed.retryAt));
  return { ...previous, state: 'grace' as const };
}
function assertWeatherEligible(provenance: WeatherResourceCacheProvenance, current: Date): void {
  if (current.getTime() >= Date.parse(provenance.staleUntil)
    || (provenance.status !== 'stale_on_error' && current.getTime() >= Date.parse(provenance.refreshAfter))) {
    throw new ApiError('Weather data is temporarily unavailable.', 503, 'upstream_unavailable');
  }
}
export function createAviationWeatherAdapter(resources: WeatherResourcePort, now: () => Date = () => new Date()): WindsDataAdapter {
  function provenance(envelope: WeatherResourceEnvelope, state: 'fresh' | 'grace', source: 'edge' | 'coordinator' | undefined, key: WeatherResourceKey): WeatherResourceCacheProvenance {
    const current = now();
    const status = state === 'grace' ? 'stale_on_error' : source === 'edge' ? 'edge_hit' : 'upstream_refresh';
    const metadata = envelope.metadata;
    const fetched = Date.parse(metadata.fetchedAt);
    const checkedAt = Date.parse(metadata.checkedAt);
    const refreshAfter = Date.parse(metadata.refreshAfter);
    const staleUntil = Date.parse(metadata.staleUntil);
    return { status, source: state === 'grace' ? 'stale' : source === 'edge' ? 'edge' : 'upstream', ageSeconds: Math.max(0, Math.floor((current.getTime() - fetched) / 1_000)), fetchedAt: metadata.fetchedAt,
      expiresAt: metadata.refreshAfter, freshnessRemainingSeconds: Math.max(0, Math.floor((refreshAfter - current.getTime()) / 1_000)), servedAt: current.toISOString(), ttlSeconds: Math.max(0, Math.floor((refreshAfter - checkedAt) / 1_000)),
      maxPayloadAgeSeconds: Math.max(0, Math.floor((staleUntil - fetched) / 1_000)), key, resource: envelope.kind === 'catalog' ? 'station-catalog' : 'winds-temps', checkedAt: metadata.checkedAt, refreshAfter: metadata.refreshAfter, staleUntil: metadata.staleUntil };
  }

  async function resource(key: WeatherResourceKey): Promise<{ envelope: WeatherResourceEnvelope; state: 'fresh' | 'grace'; provenance: WeatherResourceCacheProvenance }> {
    let result = await resources.getResource(key);
    requireWeatherResource(result);
    let sampledAt = now();
    if (result.resource.key !== key) throw new ApiError('Weather coordinator returned an invalid resource.', 503, 'service_unavailable');
    if (Date.parse(result.resource.metadata.checkedAt) > sampledAt.getTime()) throw new ApiError('Weather coordinator returned an invalid resource.', 503, 'service_unavailable');
    if (sampledAt.getTime() >= Date.parse(result.resource.metadata.staleUntil)) throw new ApiError('Weather data is temporarily unavailable.', 503, 'upstream_unavailable');
    if (needsWeatherRecheck(result, sampledAt)) {
      const previous = result;
      const refreshed = await resources.getResource(key);
      sampledAt = now();
      result = afterWeatherRecheck(previous, refreshed, sampledAt);
    }
    if (result.resource.key !== key || sampledAt.getTime() >= Date.parse(result.resource.metadata.staleUntil)) throw new ApiError('Weather data is temporarily unavailable.', 503, 'upstream_unavailable');
    if (result.state === 'fresh' && sampledAt.getTime() >= Date.parse(result.resource.metadata.refreshAfter)) throw new ApiError('Weather data is temporarily unavailable.', 503, 'upstream_unavailable');
    return { envelope: result.resource, state: result.state, provenance: provenance(result.resource, result.state, result.source, key) };
  }

  async function stationCatalog(): Promise<{ product: CachedStationCatalog; provenance: WeatherResourceCacheProvenance }> {
    const loaded = await resource('station-catalog:v1');
    if (loaded.envelope.kind !== 'catalog') throw new ApiError('Weather coordinator returned an invalid catalog.', 503, 'service_unavailable');
    return { product: { fetchedAt: loaded.envelope.metadata.fetchedAt, freshUntil: loaded.envelope.metadata.refreshAfter, staleUntil: loaded.envelope.metadata.staleUntil, entries: loaded.envelope.entries }, provenance: loaded.provenance };
  }

  async function product(region: WindsRegion, cycle: WindsForecastCycle): Promise<ProductEntry> {
    const key = `winds:${region}:${cycle}` as const;
    const loaded = await resource(key);
    if (loaded.envelope.kind !== 'winds') throw new ApiError('Weather coordinator returned an invalid winds resource.', 503, 'service_unavailable');
    const metadata = loaded.envelope.metadata;
    const cache = loaded.provenance;
    return { product: { fetchedAt: metadata.fetchedAt, freshUntil: metadata.refreshAfter, staleUntil: metadata.staleUntil, checkedAt: metadata.checkedAt, refreshAfter: metadata.refreshAfter, region, cycle, rawProduct: loaded.envelope.rawProduct, forecasts: loaded.envelope.forecasts, status: cache.status, source: cache.source }, provenance: cache };
  }

  async function allProducts(region: WindsRegion): Promise<{ products: ProductEntry[]; unavailableCycles: WindsForecastCycle[]; failures: unknown[] }> {
    const results = await Promise.allSettled(FORECAST_CYCLES.map((cycle) => product(region, cycle)));
    const products: ProductEntry[] = []; const unavailableCycles: WindsForecastCycle[] = []; const failures: unknown[] = [];
    results.forEach((result, index) => { if (result.status === 'fulfilled') products.push(result.value); else { unavailableCycles.push(FORECAST_CYCLES[index]!); failures.push(result.reason); } });
    return { products, unavailableCycles, failures };
  }

  return {
    async getWindsPoint(query) {
      const current = now(); const region = validateAloftPointQuery(query, current);
      const [{ products, unavailableCycles, failures }, catalog] = await Promise.all([allProducts(region), stationCatalog()]);
      const chosen = chooseApplicableProduct(products, unavailableCycles, failures, query, now());
      const ids = [...new Set(chosen.product.forecasts.map((forecast) => forecast.stationId))].sort();
      const identities = pointStationInfo(catalog.product, ids, region);
      const stations = selectPointStations(query, chosen, identities);
      const assembledAt = now();
      assertWeatherEligible(chosen.provenance, assembledAt);
      assertWeatherEligible(catalog.provenance, assembledAt);
      return answerFromPointStations(query, chosen, stations, catalog.provenance);
    },
    async getWindsStations(route) {
      const region = regionForRoute(route); const [{ products, unavailableCycles }, catalog] = await Promise.all([allProducts(region), stationCatalog()]);
      if (products.length === 0) throw new ApiError('Winds forecast availability is temporarily unavailable.', 503, 'upstream_unavailable');
      const stationCycles = new Map<string, Set<WindsForecastCycle>>(); const availability = new Map<string, WindsForecastAvailability>();
      for (const { product: item } of products) for (const forecast of item.forecasts) {
        const cycles = stationCycles.get(forecast.stationId) ?? new Set<WindsForecastCycle>(); cycles.add(forecast.forecastCycle); stationCycles.set(forecast.stationId, cycles);
        const key = `${forecast.stationId}:${forecast.validAt}`; if (availability.has(key)) throw new ApiError('Winds product returned ambiguous station and valid-time forecasts.', 502, 'upstream_invalid_response'); availability.set(key, forecast);
      }
      const stationsById = stationInfo(catalog.product, [...stationCycles.keys()].sort(), region);
      const stations = [...stationCycles.entries()].flatMap(([id, cycles]) => { const info = stationsById.get(id); return info ? [{ id, name: info.name, coordinates: info.coordinates, elevationFt: info.elevationFt, region, availableForecastCycles: [...cycles].sort() as WindsForecastCycle[], source: 'aviationweather' as const }] : []; }).sort((left, right) => left.id.localeCompare(right.id));
      if (stations.length === 0) throw new ApiError('No verified winds station has usable forecast data.', 404, 'upstream_no_data');
      const selectableIds = new Set(stations.map((station) => station.id));
      const forecasts = [...availability.values()].filter((forecast) => selectableIds.has(forecast.stationId)).sort((left, right) => left.validAt.localeCompare(right.validAt) || left.forecastCycle.localeCompare(right.forecastCycle) || left.stationId.localeCompare(right.stationId));
      if (forecasts.length === 0) throw unavailableCycles.length > 0 ? new ApiError('Winds forecast availability is temporarily unavailable.', 503, 'upstream_unavailable') : new ApiError('No verified winds station has a usable forecast period.', 404, 'upstream_no_data');
      const assembledAt = now();
      assertWeatherEligible(catalog.provenance, assembledAt);
      products.forEach((item) => assertWeatherEligible(item.provenance, assembledAt));
      return { stations, forecasts, unavailableForecastCycles: unavailableCycles, provenance: products.map(({ provenance: item }) => item), catalog: catalog.provenance };
    },
    async getWindsForecast(station, validTime, region) {
      if (!/^[A-Z0-9]{3}$/.test(station)) throw new ApiError('Invalid Winds/Temps station identifier. Expected exactly three alphanumeric characters.', 400, 'invalid_request');
      const requestedMs = Date.parse(validTime);
      if (!Number.isFinite(requestedMs) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(validTime)) throw new ApiError('Invalid winds validTime. Expected a canonical UTC ISO timestamp.', 400, 'invalid_request');
      const [{ products, unavailableCycles }, catalog] = await Promise.all([allProducts(region), stationCatalog()]);
      const matches: Array<{ forecast: DecodedForecast; product: CachedProduct; provenance: WeatherResourceCacheProvenance }> = [];
      for (const item of products) for (const forecast of item.product.forecasts) if (forecast.stationId === station && forecast.validAt === validTime) matches.push({ forecast, product: item.product, provenance: item.provenance });
      requireUniqueForecastMatch(matches, unavailableCycles); const match = matches[0]!;
      const info = stationInfo(catalog.product, [station], region).get(station);
      if (!info) throw new ApiError('The requested winds station lacks verified coordinates.', 502, 'upstream_invalid_response');
      const assembledAt = now();
      assertWeatherEligible(catalog.provenance, assembledAt);
      assertWeatherEligible(match.provenance, assembledAt);
      const windsStation: WindsStation = { id: station, name: info.name, coordinates: info.coordinates, elevationFt: info.elevationFt, region: match.product.region, availableForecastCycles: [match.forecast.forecastCycle], source: 'aviationweather' };
      return { forecast: { station: windsStation, forecastCycle: match.forecast.forecastCycle, issuedAt: match.forecast.issuedAt, validAt: match.forecast.validAt, useFrom: match.forecast.useFrom, useUntil: match.forecast.useUntil, levels: match.forecast.levels, rawProduct: match.product.rawProduct, source: 'aviationweather', fetchedAt: match.product.fetchedAt }, provenance: match.provenance, catalog: catalog.provenance };
    }
  };
}
