export const ICAO_PATTERN = /^[A-Z0-9]{4}$/;

export interface ApiErrorPayload {
  error: string;
  code: ApiErrorCode;
  requestId: string;
}

export type ApiErrorCode = 'invalid_request' | 'method_not_allowed' | 'not_found' | 'service_unavailable' | 'upstream_invalid_response' | 'upstream_unavailable';

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

/** Schema-only seams; no winds upstream is selected or called in this tranche. */
export interface WindsStationSelectionSchema { route: readonly AirportCoordinates[]; requestedAt: string; }
export interface WindsForecastSchema { station: string; validTime: string; }
