export const ICAO_PATTERN = /^[A-Z0-9]{4}$/;
/** Exact AirportDB identifiers: FAA LIDs and ICAO codes. No inferred prefix. */
export const AIRPORT_CODE_PATTERN = /^[A-Z0-9]{3,4}$/;

export interface ApiErrorPayload {
  error: string;
  code: ApiErrorCode;
  requestId: string;
}

export type ApiErrorCode = 'invalid_request' | 'method_not_allowed' | 'not_found' | 'service_unavailable' | 'rate_limited' | 'upstream_invalid_response' | 'upstream_unavailable' | 'upstream_no_data';

export interface CacheProvenance {
  status: 'edge_hit' | 'kv_hit' | 'upstream_refresh' | 'stale_while_refresh' | 'stale_on_error';
  source: 'edge' | 'kv' | 'upstream' | 'stale';
  ageSeconds: number;
  fetchedAt: string;
  expiresAt: string;
  freshnessRemainingSeconds: number;
  servedAt: string;
  ttlSeconds: number;
  maxPayloadAgeSeconds: number;
  key: string;
  resource: string;
}

export interface AirportCoordinates { latitudeDeg: number; longitudeDeg: number; }
export interface AirportRunwayEnd { id: string; headingDegTrue: number; isClosed: boolean; lengthFt: number | null; }
export interface AirportFrequency { type: string; description: string; frequencyMhz: string; }

export interface AirportData {
  /** Historical field name retained for the runway-picker contract; may be an FAA LID or ICAO code. */
  requestedIcao: string;
  icao: string;
  name: string;
  municipality: string;
  countryCode: string;
  countryName: string;
  elevationFt: number | null;
  coordinates: AirportCoordinates | null;
  runwayEnds: AirportRunwayEnd[];
  frequencies: AirportFrequency[];
  source: 'airportdb';
  fetchedAt: string;
}

export interface MetarWindDirectionVariation { fromDegTrue: number; toDegTrue: number; }
export interface MetarWind { raw: string; directionType: 'fixed' | 'variable' | 'calm'; directionDegTrue: number | null; directionVariation: MetarWindDirectionVariation | null; speedKt: number; gustKt: number | null; }

export interface MetarData {
  icao: string;
  metarRaw: string;
  wind: MetarWind;
  source: 'aviationweather';
  fetchedAt: string;
  observedAt: string | null;
}

export interface SourceProvenance { adapter: 'runway-picker'; fetchedAt: string; cache: CacheProvenance; }
export interface AirportSuccessPayload { airport: AirportData; provenance: SourceProvenance; requestId: string; }
export interface MetarSuccessPayload { metar: MetarData; provenance: SourceProvenance; requestId: string; }

export type WindsRoutePoint = AirportCoordinates;
export type WindsForecastCycle = '06' | '12' | '24';
export type WindsRegion = 'us' | 'alaska' | 'hawaii';

export interface AloftPointQuery { latitudeDeg: number; longitudeDeg: number; altitudeFeetMsl: number; plannedUtc: string; }
export interface AloftSourceWeight {
  stationId: string;
  latitudeDeg: number;
  longitudeDeg: number;
  distanceNauticalMiles: number;
  horizontalWeight: number;
  lowerAltitudeFeet: number;
  upperAltitudeFeet: number;
  verticalWeight: number;
  temperatureLowerAltitudeFeet: number | null;
  temperatureUpperAltitudeFeet: number | null;
  temperatureVerticalWeight: number | null;
}
export interface AloftPointAnswer {
  query: AloftPointQuery;
  windFromDegTrue: number | null;
  windSpeedKt: number;
  temperatureC: number | null;
  issuedAt: string;
  useFrom: string;
  useUntil: string;
  forecastCycle: WindsForecastCycle;
  sources: AloftSourceWeight[];
  method: 'station-level' | 'vertical-vector' | 'horizontal-vector' | 'horizontal-vertical-vector';
  requestId: string;
}

export interface WindsStation {
  id: string;
  name: string | null;
  coordinates: AirportCoordinates;
  elevationFt: number | null;
  region: WindsRegion;
  availableForecastCycles: WindsForecastCycle[];
  source: 'aviationweather';
}

export interface WindsForecastAvailability {
  stationId: string;
  forecastCycle: WindsForecastCycle;
  issuedAt: string;
  validAt: string;
  useFrom: string;
  useUntil: string;
}

export interface WindsAloftLevel {
  altitudeFt: number;
  windFromDegTrue: number | null;
  windSpeedKt: number | null;
  temperatureC: number | null;
  availability: 'available' | 'unavailable';
  raw: string;
}

export interface WindsForecast {
  station: WindsStation;
  forecastCycle: WindsForecastCycle;
  issuedAt: string;
  validAt: string;
  useFrom: string;
  useUntil: string;
  levels: WindsAloftLevel[];
  rawProduct: string;
  source: 'aviationweather';
  fetchedAt: string;
}

export interface WindsSourceProvenance {
  adapter: 'aviationweather';
  product: 'NCEP FB Winds/Temps (legacy FD)';
  region: WindsRegion;
  endpoint: 'https://aviationweather.gov/api/data/windtemp';
  fetchedAt: string;
  cache: CacheProvenance;
}

export interface WindsStationsSuccessPayload {
  stations: WindsStation[];
  forecasts: WindsForecastAvailability[];
  /** Cycles that failed to load; their products are unknown, not absent. */
  unavailableForecastCycles: WindsForecastCycle[];
  requestedRoute: WindsRoutePoint[];
  provenance: WindsSourceProvenance[];
  requestId: string;
}

export interface WindsForecastSuccessPayload { forecast: WindsForecast; provenance: WindsSourceProvenance; requestId: string; }
