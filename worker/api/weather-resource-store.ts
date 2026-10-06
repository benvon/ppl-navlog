import { isWeatherResourceEnvelope, parseResourceKey } from '../weather-resources/validation';
import type { StationCatalogEntry, WeatherResourceEnvelope, WeatherResourceKey } from '../weather-resources/contracts';

export type WeatherCacheEnvironment = 'development' | 'production';
const MAX_WINDS_BYTES = 512 * 1024;
const MAX_CATALOG_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_RESOURCE_KEYS = 10;
export const WEATHER_RESOURCE_CACHE_LIMITS = Object.freeze({ maxWindsBytes: MAX_WINDS_BYTES, maxCatalogBytes: MAX_CATALOG_BYTES, maxTotalBytes: MAX_TOTAL_BYTES, maxResourcesPerEnvironment: MAX_RESOURCE_KEYS });

export type StationCatalogIdentityIndex = Readonly<Record<string, readonly StationCatalogEntry[]>>;

export interface SharedWeatherResourceStore {
  get(environment: WeatherCacheEnvironment, key: WeatherResourceKey, now: Date): WeatherResourceEnvelope | undefined;
  publish(environment: WeatherCacheEnvironment, resource: WeatherResourceEnvelope, checkedAt: Date): void;
  getCatalogIdentityIndex(entries: readonly StationCatalogEntry[]): StationCatalogIdentityIndex | undefined;
  snapshot(environment: WeatherCacheEnvironment): { entries: number; retainedBytes: number };
  reset(environment?: WeatherCacheEnvironment): void;
}

type ResourceKey = `${WeatherCacheEnvironment}:${WeatherResourceKey}`;
type Entry = { resource: WeatherResourceEnvelope; bytes: number };
const isCatalogKey = (key: WeatherResourceKey): boolean => key === 'station-catalog:v1';
function assertEnvironment(value: string): asserts value is WeatherCacheEnvironment {
  if (value !== 'development' && value !== 'production') throw new TypeError('Unsupported weather cache environment.');
}
const scopedKey = (environment: WeatherCacheEnvironment, key: WeatherResourceKey): ResourceKey => `${environment}:${key}`;
function isFresh(resource: WeatherResourceEnvelope, now: Date): boolean {
  const checkedAt = Date.parse(resource.metadata.checkedAt);
  return Number.isFinite(checkedAt) && checkedAt <= now.getTime() && now.getTime() < Date.parse(resource.metadata.refreshAfter);
}
function isRetained(resource: WeatherResourceEnvelope, now: Date): boolean { return now.getTime() < Date.parse(resource.metadata.staleUntil); }
function cloneResource(resource: WeatherResourceEnvelope): WeatherResourceEnvelope {
  const metadata = { fetchedAt: resource.metadata.fetchedAt, checkedAt: resource.metadata.checkedAt, refreshAfter: resource.metadata.refreshAfter, staleUntil: resource.metadata.staleUntil };
  if (resource.kind === 'catalog') return {
    kind: 'catalog', key: resource.key, metadata,
    entries: resource.entries.map((entry) => ({ iataId: entry.iataId, info: { name: entry.info.name,
      coordinates: { latitudeDeg: entry.info.coordinates.latitudeDeg, longitudeDeg: entry.info.coordinates.longitudeDeg }, elevationFt: entry.info.elevationFt } }))
  };
  return {
    kind: 'winds', key: resource.key, metadata, rawProduct: resource.rawProduct,
    forecasts: resource.forecasts.map((forecast) => ({ stationId: forecast.stationId, forecastCycle: forecast.forecastCycle,
      issuedAt: forecast.issuedAt, validAt: forecast.validAt, useFrom: forecast.useFrom, useUntil: forecast.useUntil,
      levels: forecast.levels.map((level) => ({ altitudeFt: level.altitudeFt, windFromDegTrue: level.windFromDegTrue,
        windSpeedKt: level.windSpeedKt, temperatureC: level.temperatureC, availability: level.availability, raw: level.raw })) }))
  };
}
function freezeDeep<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

function buildCatalogIndex(entries: readonly StationCatalogEntry[]): StationCatalogIdentityIndex {
  const buckets = new Map<string, StationCatalogEntry[]>();
  for (const entry of entries) {
    const records = buckets.get(entry.iataId) ?? [];
    records.push(entry);
    buckets.set(entry.iataId, records);
  }
  const index: Record<string, readonly StationCatalogEntry[]> = Object.create(null) as Record<string, readonly StationCatalogEntry[]>;
  for (const [id, records] of buckets) index[id] = Object.freeze(records);
  return Object.freeze(index);
}

/** Retains only plain, validated completed envelopes under the fixed 10-key vocabulary per environment. */
class BoundedWeatherResourceStore implements SharedWeatherResourceStore {
  #entries = new Map<ResourceKey, Entry>();
  // Bounded to the 10 validated resource keys per environment. Keep the latest check even when it was too large to retain, so a slower older load cannot repopulate the slot.
  #checkedAt = new Map<ResourceKey, number>();
  #catalogIndexes = new WeakMap<object, StationCatalogIdentityIndex>();
  #retainedBytes: Record<WeatherCacheEnvironment, number> = { development: 0, production: 0 };

  get(environment: WeatherCacheEnvironment, key: WeatherResourceKey, now: Date): WeatherResourceEnvelope | undefined {
    assertEnvironment(environment);
    const slot = scopedKey(environment, parseResourceKey(key));
    const entry = this.#entries.get(slot);
    if (!entry) return undefined;
    if (!isRetained(entry.resource, now)) { this.#delete(slot); return undefined; }
    return isFresh(entry.resource, now) ? entry.resource : undefined;
  }

  publish(environment: WeatherCacheEnvironment, input: WeatherResourceEnvelope, checkedAt: Date): void {
    assertEnvironment(environment);
    if (!isWeatherResourceEnvelope(input) || !isFresh(input, checkedAt) || !isRetained(input, checkedAt)) return;
    const key = parseResourceKey(input.key);
    const slot = scopedKey(environment, key);
    const checkedAtMs = Date.parse(input.metadata.checkedAt);
    if (!this.#recordNewerCheck(slot, checkedAtMs)) return;
    const resource = freezeDeep(cloneResource(input));
    const bytes = new TextEncoder().encode(JSON.stringify(resource)).byteLength;
    this.#retain(environment, slot, key, resource, bytes);
  }

  #recordNewerCheck(slot: ResourceKey, checkedAt: number): boolean {
    const latest = this.#checkedAt.get(slot);
    if (latest !== undefined && latest >= checkedAt) return false;
    this.#checkedAt.set(slot, checkedAt);
    return true;
  }

  #retain(environment: WeatherCacheEnvironment, slot: ResourceKey, key: WeatherResourceKey, resource: WeatherResourceEnvelope, bytes: number): void {
    const previous = this.#entries.get(slot);
    const limit = isCatalogKey(key) ? MAX_CATALOG_BYTES : MAX_WINDS_BYTES;
    const retainedBytes = this.#retainedBytes[environment] - (previous?.bytes ?? 0) + bytes;
    if (bytes > limit || retainedBytes > MAX_TOTAL_BYTES) { if (previous) this.#delete(slot); return; }
    if (previous?.resource.kind === 'catalog') this.#catalogIndexes.delete(previous.resource.entries);
    this.#entries.set(slot, { resource, bytes });
    this.#retainedBytes[environment] = retainedBytes;
    if (resource.kind === 'catalog') this.#catalogIndexes.set(resource.entries, buildCatalogIndex(resource.entries));
  }

  getCatalogIdentityIndex(entries: readonly StationCatalogEntry[]): StationCatalogIdentityIndex | undefined { return this.#catalogIndexes.get(entries); }

  snapshot(environment: WeatherCacheEnvironment): { entries: number; retainedBytes: number } {
    assertEnvironment(environment);
    let entries = 0;
    for (const key of this.#entries.keys()) if (key.startsWith(`${environment}:`)) entries += 1;
    return { entries, retainedBytes: this.#retainedBytes[environment] };
  }

  reset(environment?: WeatherCacheEnvironment): void {
    if (environment) assertEnvironment(environment);
    for (const key of [...this.#entries.keys()]) if (!environment || key.startsWith(`${environment}:`)) this.#delete(key);
    for (const key of [...this.#checkedAt.keys()]) if (!environment || key.startsWith(`${environment}:`)) this.#checkedAt.delete(key);
    if (environment) this.#retainedBytes[environment] = 0;
    else { this.#retainedBytes.development = 0; this.#retainedBytes.production = 0; }
  }

  #delete(key: ResourceKey): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    if (entry.resource.kind === 'catalog') this.#catalogIndexes.delete(entry.resource.entries);
    const environment = key.startsWith('development:') ? 'development' : 'production';
    this.#retainedBytes[environment] -= entry.bytes;
  }
}

export function createSharedWeatherResourceStore(): SharedWeatherResourceStore { return new BoundedWeatherResourceStore(); }
