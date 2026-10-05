import { ApiError } from '../api/errors';
import type { AirportCoordinates, WindsAloftLevel, WindsForecastAvailability, WindsForecastCycle, WindsRegion } from '../api/contracts';
import type { CachedStationCatalog, CachedWindsProduct, StationCatalogEntry, WeatherCheckMetadata, WeatherResourceEnvelope, WeatherResourceKey, WeatherResourceResult } from './contracts';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PRODUCT_STATIONS = 10_000;
const MAX_PRODUCT_LINES = 12_000;
const MAX_CATALOG_ENTRIES = 20_000;
const STATION_CATALOG_FRESH_TTL_MS = 24 * 60 * 60 * 1_000;
const STATION_CATALOG_STALE_TTL_MS = STATION_CATALOG_FRESH_TTL_MS + 120_000;
type DecodedForecast = WindsForecastAvailability & { stationId: string; levels: WindsAloftLevel[] };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isIsoTimestamp = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const isWindsRegion = (value: unknown): value is WindsRegion => value === 'us' || value === 'alaska' || value === 'hawaii';
const isCycle = (value: unknown): value is WindsForecastCycle => value === '06' || value === '12' || value === '24';
const isCoordinates = (value: unknown): value is AirportCoordinates => isRecord(value) && isFiniteNumber(value.latitudeDeg) && value.latitudeDeg >= -90 && value.latitudeDeg <= 90 && isFiniteNumber(value.longitudeDeg) && value.longitudeDeg >= -180 && value.longitudeDeg <= 180;
const isMetadata = (value: unknown): value is WeatherCheckMetadata => isRecord(value) && hasOnlyKeys(value, ['fetchedAt', 'checkedAt', 'refreshAfter', 'staleUntil']) && isIsoTimestamp(value.fetchedAt) && isIsoTimestamp(value.checkedAt) && isIsoTimestamp(value.refreshAfter) && isIsoTimestamp(value.staleUntil) && Date.parse(value.fetchedAt) <= Date.parse(value.checkedAt) && Date.parse(value.checkedAt) <= Date.parse(value.refreshAfter) && Date.parse(value.refreshAfter) < Date.parse(value.staleUntil);
const isLevel = (value: unknown): value is WindsAloftLevel => isRecord(value) && hasOnlyKeys(value, ['altitudeFt', 'windFromDegTrue', 'windSpeedKt', 'temperatureC', 'availability', 'raw']) && isFiniteNumber(value.altitudeFt) && (value.windFromDegTrue === null || isFiniteNumber(value.windFromDegTrue)) && (value.windSpeedKt === null || isFiniteNumber(value.windSpeedKt)) && (value.temperatureC === null || isFiniteNumber(value.temperatureC)) && (value.availability === 'available' || value.availability === 'unavailable') && typeof value.raw === 'string';
function isForecastTimes(value: Record<string, unknown>): boolean {
  return isIsoTimestamp(value.issuedAt) && isIsoTimestamp(value.validAt) && isIsoTimestamp(value.useFrom) && isIsoTimestamp(value.useUntil) && Date.parse(value.useFrom) < Date.parse(value.useUntil);
}
function isForecastLevels(value: Record<string, unknown>): boolean {
  return Array.isArray(value.levels) && value.levels.length <= 40 && value.levels.every(isLevel);
}
function isForecast(value: unknown): value is WindsForecastAvailability & { stationId: string; levels: WindsAloftLevel[] } {
  if (!isRecord(value) || !hasOnlyKeys(value, ['stationId', 'forecastCycle', 'issuedAt', 'validAt', 'useFrom', 'useUntil', 'levels'])) return false;
  return typeof value.stationId === 'string' && /^[A-Z0-9]{3}$/.test(value.stationId) && isCycle(value.forecastCycle) && isForecastTimes(value) && isForecastLevels(value);
}
const isCatalogEntry = (value: unknown): value is StationCatalogEntry => isRecord(value) && typeof value.iataId === 'string' && /^[A-Z0-9]{3}$/.test(value.iataId) && isRecord(value.info) && hasOnlyKeys(value.info, ['name', 'coordinates', 'elevationFt']) && (value.info.name === null || (typeof value.info.name === 'string' && value.info.name.length <= 200)) && isCoordinates(value.info.coordinates) && (value.info.elevationFt === null || isFiniteNumber(value.info.elevationFt));

export function parseResourceKey(value: unknown): WeatherResourceKey {
  if (value === 'station-catalog:v1') return value;
  if (typeof value === 'string' && /^winds:(us|alaska|hawaii):(06|12|24)$/.test(value)) return value as WeatherResourceKey;
  throw new TypeError('Unsupported weather resource key.');
}
function isWeatherError(value: Record<string, unknown>): boolean {
  return hasOnlyKeys(value, ['ok', 'code', 'retryAt']) && (value.code === 'service_unavailable' || value.code === 'upstream_unavailable') && isIsoTimestamp(value.retryAt);
}
function isCatalogEnvelope(value: Record<string, unknown>, metadata: WeatherCheckMetadata): boolean {
  return hasOnlyKeys(value, ['kind', 'key', 'metadata', 'entries']) && value.key === 'station-catalog:v1' && Date.parse(metadata.refreshAfter) - Date.parse(metadata.checkedAt) === 24 * 60 * 60 * 1_000 && Date.parse(metadata.staleUntil) - Date.parse(metadata.refreshAfter) === 120_000 && Array.isArray(value.entries) && value.entries.length > 0 && value.entries.length <= MAX_CATALOG_ENTRIES && value.entries.every(isCatalogEntry);
}
function isWindsEnvelope(value: Record<string, unknown>, metadata: WeatherCheckMetadata): boolean {
  let key: WeatherResourceKey;
  try { key = parseResourceKey(value.key); } catch { return false; }
  if (key === 'station-catalog:v1') return false;
  return Date.parse(metadata.refreshAfter) - Date.parse(metadata.checkedAt) === 60 * 60 * 1_000 && Date.parse(metadata.staleUntil) - Date.parse(metadata.refreshAfter) === 120_000 && hasOnlyKeys(value, ['kind', 'key', 'metadata', 'rawProduct', 'forecasts']) && typeof value.rawProduct === 'string' && new TextEncoder().encode(value.rawProduct).byteLength <= MAX_RESPONSE_BYTES && Array.isArray(value.forecasts) && value.forecasts.length > 0 && value.forecasts.length <= MAX_PRODUCT_STATIONS && value.forecasts.every((forecast) => isForecast(forecast) && forecast.forecastCycle === key.slice(-2));
}
export function isWeatherResourceEnvelope(value: unknown): value is WeatherResourceEnvelope {
  if (!isRecord(value) || !isMetadata(value.metadata)) return false;
  if (value.kind === 'catalog') return isCatalogEnvelope(value, value.metadata);
  if (value.kind === 'winds') return isWindsEnvelope(value, value.metadata);
  return false;
}
function isWeatherSuccess(value: Record<string, unknown>): boolean {
  return hasOnlyKeys(value, ['ok', 'resource', 'state']) && (value.state === 'fresh' || value.state === 'grace') && isWeatherResourceEnvelope(value.resource);
}
export function isWeatherResourceResult(value: unknown): value is WeatherResourceResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) return isWeatherError(value);
  return value.ok === true && isWeatherSuccess(value);
}
export function isCachedWindsProduct(value: unknown): value is CachedWindsProduct {
  return isRecord(value) && isIsoTimestamp(value.fetchedAt) && isIsoTimestamp(value.freshUntil) && isIsoTimestamp(value.staleUntil) && isWindsRegion(value.region) && isCycle(value.cycle) && typeof value.rawProduct === 'string' && new TextEncoder().encode(value.rawProduct).byteLength <= MAX_RESPONSE_BYTES && Array.isArray(value.forecasts) && value.forecasts.length <= MAX_PRODUCT_STATIONS && value.forecasts.every(isForecast);
}
export function isCachedStationCatalog(value: unknown): value is CachedStationCatalog {
  return isRecord(value) && isIsoTimestamp(value.fetchedAt) && isIsoTimestamp(value.freshUntil) && isIsoTimestamp(value.staleUntil) && Array.isArray(value.entries) && value.entries.length > 0 && value.entries.length <= MAX_CATALOG_ENTRIES && value.entries.every(isCatalogEntry);
}
function catalogCoordinates(value: Record<string, unknown>): AirportCoordinates | null {
  if (!isFiniteNumber(value.lat) || !isFiniteNumber(value.lon) || value.lat < -90 || value.lat > 90 || value.lon < -180 || value.lon > 180) return null;
  return { latitudeDeg: value.lat, longitudeDeg: value.lon };
}
function catalogIataId(value: Record<string, unknown>): string | null {
  return typeof value.iataId === 'string' && /^[A-Z0-9]{3}$/.test(value.iataId) ? value.iataId : null;
}
function stationEntry(value: unknown): StationCatalogEntry | null {
  if (!isRecord(value)) return null;
  const coordinates = catalogCoordinates(value);
  const iataId = catalogIataId(value);
  if (coordinates === null || iataId === null) return null;
  const name = typeof value.site === 'string' && value.site.length <= 200 ? value.site : null;
  return { iataId, info: { name, coordinates, elevationFt: isFiniteNumber(value.elev) ? value.elev : null } };
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

function requireStationBudget(count: number): void {
  if (count > MAX_PRODUCT_STATIONS) throw new ApiError('Aviation Weather Center returned a Winds/Temps product with too many stations.', 502, 'upstream_invalid_response');
}

function fbSeparatedColumnWidth(altitudeFt: number): number {
  // Official FB rows separate groups with one space; 3,000-ft groups carry
  // four characters, 6,000–24,000-ft groups seven, and high groups six.
  if (altitudeFt <= 3_000) return 4;
  return altitudeFt >= 30_000 ? 6 : 7;
}

function fixedWidthLevels(row: string, columns: readonly { altitudeFt: number; start: number }[]): WindsAloftLevel[] {
  let cursor = columns[0]!.start;
  return columns.map((column, index) => {
    const width = fbSeparatedColumnWidth(column.altitudeFt);
    const raw = row.slice(cursor, cursor + width).trim();
    cursor += width + (index < columns.length - 1 ? 1 : 0);
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
  if (altitudes.length === 0 || altitudes.some((altitude) => !Number.isSafeInteger(altitude) || altitude < 1_000 || altitude > 53_000)) throw new ApiError('Aviation Weather Center returned invalid Winds/Temps altitude columns.', 502, 'upstream_invalid_response');
  const dataStart = (levelsMatch.index ?? 0) + header.length;
  const rows = normalized.slice(dataStart).split('\n').filter((line) => line.trim().length > 0);
  if (rows.length > MAX_PRODUCT_LINES) throw new ApiError('Aviation Weather Center returned a Winds/Temps product with too many rows.', 502, 'upstream_invalid_response');
  const stationRows = rows.map((row) => ({ row, stationId: row.slice(0, columns[0]!.start).trim() }))
    .filter(({ stationId }) => /^[A-Z0-9]{3}$/.test(stationId));
  const stationIds = stationRows.map(({ stationId }) => stationId);
  if (new Set(stationIds).size !== stationIds.length) throw new ApiError('Aviation Weather Center returned duplicate station identities in one Winds/Temps product.', 502, 'upstream_invalid_response');
  const forecasts: DecodedForecast[] = stationRows.map(({ row, stationId }) => ({ stationId, forecastCycle: cycle,
    issuedAt: issuedAt.toISOString(), validAt: validAt.toISOString(), useFrom: useFrom.toISOString(), useUntil: useUntil.toISOString(), levels: fixedWidthLevels(row, columns) }));
  requireStationBudget(forecasts.length);
  if (forecasts.length === 0) throw new ApiError('Aviation Weather Center returned a Winds/Temps product without reporting stations.', 502, 'upstream_invalid_response');
  return forecasts;
}

export function parseStationCatalog(value: unknown, fetchedAt: Date): CachedStationCatalog {
  if (!Array.isArray(value)) throw new ApiError('Aviation Weather Center returned an invalid station catalog.', 502, 'upstream_invalid_response');
  const entries = value.map(stationEntry).filter((entry): entry is StationCatalogEntry => entry !== null);
  if (entries.length === 0 || entries.length > MAX_CATALOG_ENTRIES) throw new ApiError('Aviation Weather Center returned an unusable station catalog.', 502, 'upstream_invalid_response');
  return { fetchedAt: fetchedAt.toISOString(), freshUntil: new Date(fetchedAt.getTime() + STATION_CATALOG_FRESH_TTL_MS).toISOString(), staleUntil: new Date(fetchedAt.getTime() + STATION_CATALOG_STALE_TTL_MS).toISOString(), entries };
}
