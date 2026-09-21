import type {
  ApiErrorCode,
  ApiErrorPayload,
  CacheProvenance,
  WindsAloftLevel,
  WindsForecast,
  WindsForecastAvailability,
  WindsForecastSuccessPayload,
  WindsRegion,
  WindsSourceProvenance,
  WindsStation,
  WindsStationsSuccessPayload,
} from "../../../worker/api/contracts";
import type { Coordinate } from "../../domain/coordinates";

const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const UTC_MILLISECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface BrowserFetch {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface WindsTransportClient {
  discoverStations(route: readonly Coordinate[]): Promise<WindsStationsSuccessPayload>;
  fetchForecast(stationId: string, validTimeUtc: string, region: WindsRegion): Promise<WindsForecastSuccessPayload>;
}

export class WindsClientError extends Error {
  public constructor(
    readonly code: "INVALID_INPUT" | "TRANSPORT_FAILURE" | "INVALID_RESPONSE" | "API_FAILURE",
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "WindsClientError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isString = (value: unknown, maximumLength = 4096): value is string => typeof value === "string" && value.length <= maximumLength;
const isUtcMilliseconds = (value: unknown): value is string => {
  if (!isString(value, 64) || !UTC_MILLISECONDS_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
};
const isRegion = (value: unknown): value is WindsRegion => value === "us" || value === "alaska" || value === "hawaii";
const isForecastCycle = (value: unknown): value is "06" | "12" | "24" => value === "06" || value === "12" || value === "24";
const all = (...conditions: readonly boolean[]): boolean => conditions.every(Boolean);
const oneOf = (value: unknown, accepted: readonly string[]): boolean => typeof value === "string" && accepted.includes(value);
const nullable = (value: unknown, predicate: (candidate: unknown) => boolean): boolean => value === null || predicate(value);
const isBoundedArray = <T>(value: unknown, maximumLength: number, predicate: (candidate: unknown) => candidate is T): value is T[] =>
  Array.isArray(value) && value.length > 0 && value.length <= maximumLength && value.every(predicate);
const isBoundedInteger = (value: unknown, minimum: number, maximum: number): boolean =>
  isFiniteNumber(value) && Number.isInteger(value) && value >= minimum && value <= maximum;
const isBoundedNumber = (value: unknown, minimum: number, maximum: number): boolean =>
  isFiniteNumber(value) && value >= minimum && value <= maximum;
const isApiErrorCode = (value: unknown): value is ApiErrorCode =>
  value === "invalid_request" ||
  value === "method_not_allowed" ||
  value === "not_found" ||
  value === "service_unavailable" ||
  value === "rate_limited" ||
  value === "upstream_invalid_response" ||
  value === "upstream_unavailable" ||
  value === "upstream_no_data";

const isCoordinate = (value: unknown): value is { readonly latitudeDeg: number; readonly longitudeDeg: number } =>
  isRecord(value) &&
  isFiniteNumber(value.latitudeDeg) &&
  value.latitudeDeg >= -90 &&
  value.latitudeDeg <= 90 &&
  isFiniteNumber(value.longitudeDeg) &&
  value.longitudeDeg >= -180 &&
  value.longitudeDeg <= 180;

const isCacheProvenance = (value: unknown): value is CacheProvenance =>
  isRecord(value) && all(
    oneOf(value.status, ["edge_hit", "kv_hit", "upstream_refresh", "stale_while_refresh", "stale_on_error"]),
    oneOf(value.source, ["edge", "kv", "upstream", "stale"]),
    isFiniteNumber(value.ageSeconds), isUtcMilliseconds(value.fetchedAt), isUtcMilliseconds(value.expiresAt),
    isFiniteNumber(value.freshnessRemainingSeconds), isUtcMilliseconds(value.servedAt), isFiniteNumber(value.ttlSeconds),
    isFiniteNumber(value.maxPayloadAgeSeconds), isString(value.key, 512), isString(value.resource, 128),
  );

const isWindsStation = (value: unknown): value is WindsStation =>
  isRecord(value) && all(
    isString(value.id, 3), typeof value.id === "string" && /^[A-Z0-9]{3}$/.test(value.id),
    nullable(value.name, (candidate) => isString(candidate, 200)), isCoordinate(value.coordinates),
    nullable(value.elevationFt, isFiniteNumber), isRegion(value.region), Array.isArray(value.availableForecastCycles),
    Array.isArray(value.availableForecastCycles) && value.availableForecastCycles.length > 0 && value.availableForecastCycles.every(isForecastCycle),
    value.source === "aviationweather",
  );

const isForecastAvailability = (value: unknown): value is WindsForecastAvailability =>
  isRecord(value) &&
  isForecastCycle(value.forecastCycle) &&
  isUtcMilliseconds(value.issuedAt) &&
  isUtcMilliseconds(value.validAt) &&
  isUtcMilliseconds(value.useFrom) &&
  isUtcMilliseconds(value.useUntil);

const isLevel = (value: unknown): value is WindsAloftLevel =>
  isRecord(value) && all(
    isBoundedInteger(value.altitudeFt, 0, 60_000),
    nullable(value.windFromDegTrue, (candidate) => isBoundedNumber(candidate, 0, 360)),
    nullable(value.windSpeedKt, (candidate) => isBoundedNumber(candidate, 0, 199)),
    nullable(value.temperatureC, (candidate) => isBoundedNumber(candidate, -100, 100)),
    oneOf(value.availability, ["available", "unavailable"]), isString(value.raw, 64),
  );

const isForecast = (value: unknown): value is WindsForecast =>
  isRecord(value) && all(
    isWindsStation(value.station), isForecastCycle(value.forecastCycle), isUtcMilliseconds(value.issuedAt),
    isUtcMilliseconds(value.validAt), isUtcMilliseconds(value.useFrom), isUtcMilliseconds(value.useUntil),
    Array.isArray(value.levels) && value.levels.length > 0 && value.levels.length <= 30 && value.levels.every(isLevel),
    isString(value.rawProduct, MAX_RESPONSE_BYTES), value.source === "aviationweather", isUtcMilliseconds(value.fetchedAt),
  );

const isSourceProvenance = (value: unknown): value is WindsSourceProvenance =>
  isRecord(value) &&
  value.adapter === "aviationweather" &&
  value.product === "NCEP FB Winds/Temps (legacy FD)" &&
  isRegion(value.region) &&
  value.endpoint === "https://aviationweather.gov/api/data/windtemp" &&
  isUtcMilliseconds(value.fetchedAt) &&
  isCacheProvenance(value.cache);

const isRequestId = (value: unknown): value is string => isString(value, 128) && /^[0-9a-f-]{8,128}$/i.test(value);

const isStationsPayload = (value: unknown): value is WindsStationsSuccessPayload =>
  isRecord(value) && all(
    isBoundedArray(value.stations, 500, isWindsStation),
    isBoundedArray(value.forecasts, 10, isForecastAvailability),
    isBoundedArray(value.requestedRoute, 100, isCoordinate),
    isBoundedArray(value.provenance, 10, isSourceProvenance),
    isRequestId(value.requestId),
  );

const isForecastPayload = (value: unknown): value is WindsForecastSuccessPayload =>
  isRecord(value) && isForecast(value.forecast) && isSourceProvenance(value.provenance) && isRequestId(value.requestId);

const isErrorPayload = (value: unknown): value is ApiErrorPayload =>
  isRecord(value) && isString(value.error, 512) && isApiErrorCode(value.code) && isRequestId(value.requestId);

const parseBaseUrl = (value: string): URL => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Unsupported protocol");
    return parsed;
  } catch {
    throw new WindsClientError("INVALID_INPUT", "Winds API base URL must be an absolute HTTP(S) URL.");
  }
};

const defaultBaseUrl = (): string => {
  if (typeof globalThis.location === "undefined" || !globalThis.location.origin) {
    throw new WindsClientError("INVALID_INPUT", "Winds API base URL is required outside a browser context.");
  }
  return globalThis.location.origin;
};

const ensureRoute = (route: readonly Coordinate[]): void => {
  if (route.length < 1 || route.length > 100 || !route.every((point) => isFiniteNumber(point.latitude) && point.latitude >= -90 && point.latitude <= 90 && isFiniteNumber(point.longitude) && point.longitude >= -180 && point.longitude <= 180)) {
    throw new WindsClientError("INVALID_INPUT", "Winds station discovery requires one through 100 route coordinates.");
  }
};

const canonicalCoordinateDecimal = (value: number): string => {
  const formatted = value.toFixed(12).replace(/(?:\.0+|(?:(\.\d*?[1-9]))0+)$/, "$1");
  return formatted === "-0" ? "0" : formatted;
};

const routeParameter = (route: readonly Coordinate[]): string =>
  route.map((point) => `${canonicalCoordinateDecimal(point.latitude)},${canonicalCoordinateDecimal(point.longitude)}`).join(";");

const ensureStationId = (stationId: string): string => {
  const normalized = stationId.trim().toUpperCase();
  if (!/^[A-Z0-9]{3}$/.test(normalized)) {
    throw new WindsClientError("INVALID_INPUT", "Winds forecast station must be exactly three alphanumeric characters.");
  }
  return normalized;
};

const ensureValidTime = (value: string): void => {
  if (!isUtcMilliseconds(value)) {
    throw new WindsClientError("INVALID_INPUT", "Winds forecast valid time must be a canonical UTC timestamp with milliseconds.");
  }
};

const readBoundedText = async (response: Response): Promise<string> => {
  const contentLength = Number.parseInt(response.headers.get("Content-Length") ?? "0", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new WindsClientError("INVALID_RESPONSE", "Winds API response exceeded the configured size limit.");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new WindsClientError("INVALID_RESPONSE", "Winds API response body was unavailable.");
  }
  let bytesRead = 0;
  let text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new WindsClientError("INVALID_RESPONSE", "Winds API response exceeded the configured size limit.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
};

const readBoundedJson = async (response: Response): Promise<unknown> => {
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    throw new WindsClientError("INVALID_RESPONSE", "Winds API response must be JSON.");
  }
  const text = await readBoundedText(response);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WindsClientError("INVALID_RESPONSE", "Winds API response was not valid JSON.");
  }
};

export class WorkerWindsClient implements WindsTransportClient {
  private readonly baseUrl: URL;

  public constructor(
    private readonly fetcher: BrowserFetch = globalThis,
    baseUrl: string = defaultBaseUrl(),
  ) {
    this.baseUrl = parseBaseUrl(baseUrl);
  }

  public async discoverStations(route: readonly Coordinate[]): Promise<WindsStationsSuccessPayload> {
    ensureRoute(route);
    const url = new URL("/api/weather/winds/stations", this.baseUrl);
    url.searchParams.set("route", routeParameter(route));
    const payload = await this.requestJson(url);
    if (!isStationsPayload(payload)) {
      throw new WindsClientError("INVALID_RESPONSE", "Winds station discovery response did not match the documented contract.");
    }
    return payload;
  }

  public async fetchForecast(stationId: string, validTimeUtc: string, region: WindsRegion): Promise<WindsForecastSuccessPayload> {
    const station = ensureStationId(stationId);
    ensureValidTime(validTimeUtc);
    const url = new URL("/api/weather/winds", this.baseUrl);
    url.searchParams.set("station", station);
    url.searchParams.set("validTime", validTimeUtc);
    url.searchParams.set("region", region);
    const payload = await this.requestJson(url);
    if (!isForecastPayload(payload)) {
      throw new WindsClientError("INVALID_RESPONSE", "Winds forecast response did not match the documented contract.");
    }
    return payload;
  }

  private async requestJson(url: URL): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await this.fetcher.fetch(url, { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal });
      } catch {
        throw new WindsClientError("TRANSPORT_FAILURE", "Winds API request could not be completed.");
      }
      const payload = await readBoundedJson(response);
      if (!response.ok) {
        if (isErrorPayload(payload)) {
          throw new WindsClientError("API_FAILURE", `Winds API request failed: ${payload.code}.`, payload.requestId);
        }
        throw new WindsClientError("INVALID_RESPONSE", "Winds API returned an unsuccessful response without a valid error contract.");
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }
}
