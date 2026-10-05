import type { AirportCoordinates, WindsAloftLevel, WindsForecastAvailability, WindsForecastCycle, WindsRegion } from '../api/contracts';
export type WeatherResourceKey = `winds:${WindsRegion}:${WindsForecastCycle}` | 'station-catalog:v1';
export interface WeatherCheckMetadata { fetchedAt: string; checkedAt: string; refreshAfter: string; staleUntil: string; }
export interface StationCatalogEntry { readonly iataId: string; readonly info: { readonly name: string | null; readonly coordinates: AirportCoordinates; readonly elevationFt: number | null }; }
export interface WindsResourceEnvelope { kind: 'winds'; key: `winds:${WindsRegion}:${WindsForecastCycle}`; metadata: WeatherCheckMetadata; rawProduct: string; forecasts: Array<WindsForecastAvailability & { stationId: string; levels: WindsAloftLevel[] }>; }
export interface CatalogResourceEnvelope { kind: 'catalog'; key: 'station-catalog:v1'; metadata: WeatherCheckMetadata; entries: readonly StationCatalogEntry[]; }
export type WeatherResourceEnvelope = WindsResourceEnvelope | CatalogResourceEnvelope;
export type WeatherResourceResult = { ok: true; resource: WeatherResourceEnvelope; state: 'fresh' | 'grace' } | { ok: false; code: 'service_unavailable' | 'upstream_unavailable'; retryAt: string };
export interface WeatherResourcePort { getResource(key: WeatherResourceKey): Promise<WeatherResourceResult>; }
export type BudgetAttempt = { key: WeatherResourceKey; attemptedAtMs: number };
export type BudgetDecision = { allowed: true } | { allowed: false; retryAtMs: number };
export interface CachedWindsProduct { fetchedAt: string; freshUntil: string; staleUntil: string; region: WindsRegion; cycle: WindsForecastCycle; rawProduct: string; forecasts: Array<WindsForecastAvailability & { stationId: string; levels: WindsAloftLevel[] }>; }
export interface CachedStationCatalog { fetchedAt: string; freshUntil: string; staleUntil: string; entries: readonly StationCatalogEntry[]; }
