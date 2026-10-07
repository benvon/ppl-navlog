import type {
  ApiErrorCode,
  ApiErrorPayload,
  AloftPointAnswer,
  AloftPointQuery,
  AloftSourceWeight,
  CacheProvenance,
  MetarData,
  MetarSuccessPayload,
  SourceProvenance,
  WindsRegion,
} from "../../../worker/api/contracts";
import { canonicalPointCoordinateDegrees } from "../../domain/coordinates";
import { RequestReuse } from "../request-reuse";

const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const WEATHER_REQUEST_TIMEOUT_MS = 20_000;
const UTC_MILLISECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface BrowserFetch {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** Compatible Worker METAR boundary, kept separate so aloft-only adapters remain testable. */
export interface AloftPointTransportClient { fetchPoint(query: AloftPointQuery): Promise<AloftPointAnswer>; }

export interface MetarTransportClient {
  fetchMetar(icao: string): Promise<MetarSuccessPayload>;
}

export class WindsClientError extends Error {
  public constructor(
    readonly code: "INVALID_INPUT" | "TRANSPORT_FAILURE" | "INVALID_RESPONSE" | "API_FAILURE",
    message: string,
    readonly requestId?: string,
    readonly apiCode?: ApiErrorCode,
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

const isCacheProvenance = (value: unknown): value is CacheProvenance =>
  isRecord(value) && all(
    oneOf(value.status, ["edge_hit", "kv_hit", "upstream_refresh", "stale_while_refresh", "stale_on_error"]),
    oneOf(value.source, ["edge", "kv", "upstream", "stale"]),
    isFiniteNumber(value.ageSeconds), isUtcMilliseconds(value.fetchedAt), isUtcMilliseconds(value.expiresAt),
    isFiniteNumber(value.freshnessRemainingSeconds), isUtcMilliseconds(value.servedAt), isFiniteNumber(value.ttlSeconds),
    isFiniteNumber(value.maxPayloadAgeSeconds), isString(value.key, 512), isString(value.resource, 128),
  );

const isMetarSourceProvenance = (value: unknown): value is SourceProvenance =>
  isRecord(value) && value.adapter === "runway-picker" && isUtcMilliseconds(value.fetchedAt) && isCacheProvenance(value.cache);

const isFixedMetarWind = (value: Record<string, unknown>): boolean =>
  value.directionType === "fixed" && isBoundedNumber(value.directionDegTrue, 0, 360) && value.directionVariation === null;

const isVariableMetarWind = (value: Record<string, unknown>): boolean =>
  value.directionType === "variable" && value.directionDegTrue === null && isRecord(value.directionVariation) &&
  isBoundedNumber(value.directionVariation.fromDegTrue, 0, 360) && isBoundedNumber(value.directionVariation.toDegTrue, 0, 360);

const isCalmMetarWind = (value: Record<string, unknown>): boolean =>
  value.directionType === "calm" && value.directionDegTrue === null && value.directionVariation === null && value.speedKt === 0 && value.gustKt === null;

const isMetarWind = (value: unknown): value is MetarData["wind"] =>
  isRecord(value) && isString(value.raw, 64) && isBoundedNumber(value.speedKt, 0, 199) &&
  nullable(value.gustKt, (candidate) => isBoundedNumber(candidate, 0, 199)) &&
  (isFixedMetarWind(value) || isVariableMetarWind(value) || isCalmMetarWind(value));

const isMetar = (value: unknown): value is MetarData =>
  isRecord(value) && all(
    isString(value.icao, 4), typeof value.icao === "string" && /^[A-Z0-9]{4}$/.test(value.icao),
    isString(value.metarRaw, 4096), isMetarWind(value.wind), value.source === "aviationweather",
    isUtcMilliseconds(value.fetchedAt), nullable(value.observedAt, isUtcMilliseconds),
  );

const isRequestId = (value: unknown): value is string => isString(value, 128) && /^[0-9a-f-]{8,128}$/i.test(value);

const POINT_QUERY_KEYS = ["latitudeDeg", "longitudeDeg", "altitudeFeetMsl", "plannedUtc"] as const;
const POINT_PRODUCT_KEYS = ["region", "cycle", "cache"] as const;
const POINT_CACHE_KEYS = ["status", "source", "ageSeconds", "fetchedAt", "expiresAt", "freshnessRemainingSeconds", "servedAt", "ttlSeconds", "maxPayloadAgeSeconds", "key", "resource", "checkedAt", "refreshAfter", "staleUntil"] as const;
type PointCacheShape = Record<string, unknown> & {
  status: CacheProvenance["status"];
  source: CacheProvenance["source"];
  ageSeconds: number;
  fetchedAt: string;
  expiresAt: string;
  freshnessRemainingSeconds: number;
  servedAt: string;
  ttlSeconds: number;
  maxPayloadAgeSeconds: number;
  key: string;
  resource: string;
  checkedAt: string;
  refreshAfter: string;
  staleUntil: string;
};
const POINT_SOURCE_KEYS = ["stationId", "latitudeDeg", "longitudeDeg", "distanceNauticalMiles", "horizontalWeight", "lowerAltitudeFeet", "upperAltitudeFeet", "verticalWeight", "lowerWindFromDegTrue", "lowerWindSpeedKt", "upperWindFromDegTrue", "upperWindSpeedKt", "temperatureLowerAltitudeFeet", "temperatureUpperAltitudeFeet", "temperatureVerticalWeight", "temperatureLowerC", "temperatureUpperC"] as const;
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const isAloftPointQuery = (value: unknown): value is AloftPointQuery => isRecord(value) && hasExactKeys(value, POINT_QUERY_KEYS) &&
  isBoundedNumber(value.latitudeDeg, -90, 90) && isBoundedNumber(value.longitudeDeg, -180, 180) &&
  isBoundedInteger(value.altitudeFeetMsl, 3000, 53000) && isUtcMilliseconds(value.plannedUtc);
const isPointSourceIdentity = (value: Record<string, unknown>): boolean => typeof value.stationId === "string" && /^[A-Z0-9]{3}$/.test(value.stationId) &&
  isBoundedNumber(value.latitudeDeg, -90, 90) && isBoundedNumber(value.longitudeDeg, -180, 180) && isBoundedNumber(value.distanceNauticalMiles, 0, 100);
const isPointWindWeights = (value: Record<string, unknown>): boolean => isBoundedNumber(value.horizontalWeight, 0, 1) &&
  isBoundedInteger(value.lowerAltitudeFeet, 0, 53000) && isBoundedInteger(value.upperAltitudeFeet, value.lowerAltitudeFeet as number, 53000) && isBoundedNumber(value.verticalWeight, 0, 1) &&
  isPointWind(value.lowerWindFromDegTrue, value.lowerWindSpeedKt) && isPointWind(value.upperWindFromDegTrue, value.upperWindSpeedKt);
const isPointTemperatureWeights = (value: Record<string, unknown>): boolean => {
  if ([value.temperatureLowerAltitudeFeet, value.temperatureUpperAltitudeFeet, value.temperatureVerticalWeight, value.temperatureLowerC, value.temperatureUpperC].every((item) => item === null)) return true;
  return isBoundedInteger(value.temperatureLowerAltitudeFeet, 0, 53000) &&
    isBoundedInteger(value.temperatureUpperAltitudeFeet, value.temperatureLowerAltitudeFeet as number, 53000) &&
    isBoundedNumber(value.temperatureVerticalWeight, 0, 1) && isBoundedNumber(value.temperatureLowerC, -100, 100) && isBoundedNumber(value.temperatureUpperC, -100, 100);
};
const isAloftSourceWeight = (value: unknown): value is AloftSourceWeight => isRecord(value) && hasExactKeys(value, POINT_SOURCE_KEYS) &&
  isPointSourceIdentity(value) && isPointWindWeights(value) && isPointTemperatureWeights(value);
const isPointSourceSet = (value: unknown): value is AloftSourceWeight[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || !value.every(isAloftSourceWeight)) return false;
  return Math.abs(value.reduce((total, source) => total + source.horizontalWeight, 0) - 1) <= 0.001;
};
const isPointDirection = (value: unknown): boolean => isFiniteNumber(value) && value >= 0 && value <= 360;
const isPointWind = (direction: unknown, speed: unknown): boolean => isBoundedNumber(speed, 0, 199) &&
  ((speed === 0 && direction === null) || isPointDirection(direction));
const isPointResourceCache = (value: unknown, expectedKey: string, expectedResource: string, ttlSeconds: number): boolean => {
  if (!isRecord(value) || !hasExactKeys(value, POINT_CACHE_KEYS) || !isPointCacheShape(value)) return false;
  if (!all(
    value.ageSeconds >= 0, value.maxPayloadAgeSeconds >= 0, value.key === expectedKey, value.resource === expectedResource,
    value.ttlSeconds === ttlSeconds, value.expiresAt === value.refreshAfter,
    value.ageSeconds === Math.floor((Date.parse(value.servedAt) - Date.parse(value.fetchedAt)) / 1000),
    value.maxPayloadAgeSeconds === Math.floor((Date.parse(value.staleUntil) - Date.parse(value.fetchedAt)) / 1000),
    Date.parse(value.fetchedAt) <= Date.parse(value.checkedAt), Date.parse(value.checkedAt) <= Date.parse(value.servedAt),
    Date.parse(value.refreshAfter) - Date.parse(value.checkedAt) === ttlSeconds * 1000,
    Date.parse(value.staleUntil) - Date.parse(value.refreshAfter) === 120_000,
    Date.parse(value.servedAt) < Date.parse(value.staleUntil), Date.parse(value.servedAt) <= Date.now(), Date.parse(value.checkedAt) <= Date.now(),
  )) return false;
  const stale = value.status === "stale_on_error" && value.source === "stale";
  if (stale) return value.freshnessRemainingSeconds === 0 && Date.now() >= Date.parse(value.refreshAfter) && Date.now() < Date.parse(value.staleUntil);
  return oneOf(value.status, ["edge_hit", "kv_hit", "upstream_refresh"]) && oneOf(value.source, ["edge", "kv", "upstream"]) &&
    value.freshnessRemainingSeconds >= 0 && Date.now() < Date.parse(value.refreshAfter);
};
const isPointCacheShape = (value: Record<string, unknown>): value is PointCacheShape => all(
    oneOf(value.status, ["edge_hit", "kv_hit", "upstream_refresh", "stale_on_error"]),
    oneOf(value.source, ["edge", "kv", "upstream", "stale"]), isFiniteNumber(value.ageSeconds), isFiniteNumber(value.freshnessRemainingSeconds),
    isFiniteNumber(value.ttlSeconds), isFiniteNumber(value.maxPayloadAgeSeconds), isUtcMilliseconds(value.fetchedAt), isUtcMilliseconds(value.checkedAt),
    isUtcMilliseconds(value.refreshAfter), isUtcMilliseconds(value.staleUntil), isUtcMilliseconds(value.expiresAt), isUtcMilliseconds(value.servedAt),
    isString(value.key, 512), isString(value.resource, 128),
);
const isPointProduct = (value: unknown): boolean => isRecord(value) && all(
  hasExactKeys(value, POINT_PRODUCT_KEYS), isRegion(value.region), isForecastCycle(value.cycle),
  isPointResourceCache(value.cache, `winds:${value.region}:${value.cycle}`, "winds-temps", 3600),
);
const isPointAnswerTiming = (value: Record<string, unknown>): boolean => isUtcMilliseconds(value.issuedAt) && isUtcMilliseconds(value.useFrom) && isUtcMilliseconds(value.useUntil) &&
  Date.parse(value.issuedAt) <= Date.parse((value.query as AloftPointQuery).plannedUtc) && Date.parse(value.useFrom) < Date.parse(value.useUntil) &&
  Date.parse(value.useFrom) <= Date.parse((value.query as AloftPointQuery).plannedUtc) && Date.parse((value.query as AloftPointQuery).plannedUtc) < Date.parse(value.useUntil);
const POINT_ANSWER_KEYS = ["query", "windFromDegTrue", "windSpeedKt", "temperatureC", "issuedAt", "useFrom", "useUntil", "forecastCycle", "sources", "method", "product", "catalog", "requestId"] as const;
const isAloftPointAnswer = (value: unknown): value is AloftPointAnswer => isRecord(value) && hasExactKeys(value, POINT_ANSWER_KEYS) &&
  isAloftPointQuery(value.query) && all(
  isPointWind(value.windFromDegTrue, value.windSpeedKt), nullable(value.temperatureC, (n) => isBoundedNumber(n, -100, 100)),
  isPointAnswerTiming(value), isForecastCycle(value.forecastCycle),
  isPointSourceSet(value.sources), oneOf(value.method, ["station-level", "vertical-vector", "horizontal-vector", "horizontal-vertical-vector"]),
  isPointProduct(value.product), isRecord(value.catalog) && hasExactKeys(value.catalog, ["cache"]),
  isRecord(value.catalog) && isPointResourceCache(value.catalog.cache, "station-catalog:v1", "station-catalog", 86400), isRequestId(value.requestId),
);

const isMetarPayload = (value: unknown): value is MetarSuccessPayload =>
  isRecord(value) && isMetar(value.metar) && isMetarSourceProvenance(value.provenance) && isRequestId(value.requestId);

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

const samePointQuery = (a: AloftPointQuery, b: AloftPointQuery): boolean => a.latitudeDeg === b.latitudeDeg && a.longitudeDeg === b.longitudeDeg && a.altitudeFeetMsl === b.altitudeFeetMsl && a.plannedUtc === b.plannedUtc;

const ensureIcao = (icao: string): string => {
  const normalized = icao.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(normalized)) {
    throw new WindsClientError("INVALID_INPUT", "METAR airport must be exactly four alphanumeric characters.");
  }
  return normalized;
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

export class WorkerWindsClient implements MetarTransportClient, AloftPointTransportClient {
  private readonly baseUrl: URL;
  private readonly reuse = new RequestReuse<MetarSuccessPayload | AloftPointAnswer>();

  public constructor(
    private readonly fetcher: BrowserFetch = globalThis,
    baseUrl: string = defaultBaseUrl(),
  ) {
    this.baseUrl = parseBaseUrl(baseUrl);
  }

  public async fetchMetar(icao: string): Promise<MetarSuccessPayload> {
    const normalizedIcao = ensureIcao(icao);
    const url = new URL(`/api/weather/metar/${normalizedIcao}`, this.baseUrl);
    let retryAfter: string | null = null;
    return this.reuse.run(url.href, {
      validateReuse: (value) => { if (!("metar" in value) || !isMetarPayload(value) || value.metar.icao !== normalizedIcao) throw new WindsClientError("INVALID_RESPONSE", "METAR response did not match the documented contract."); },
      retryAfter: () => retryAfter,
      freshness: (value) => metarReuseDeadline(value as MetarSuccessPayload, normalizedIcao),
      age: (value, now) => { const payload = value as MetarSuccessPayload; return { ...payload, provenance: { ...payload.provenance, cache: { ...payload.provenance.cache,
        freshnessRemainingSeconds: Math.max(0, payload.provenance.cache.freshnessRemainingSeconds - Math.max(0, Math.floor((now - Date.parse(payload.provenance.cache.servedAt)) / 1000))) } } }; },
      safeError: (error) => error instanceof WindsClientError ? new WindsClientError(error.code, error.message, error.requestId, error.apiCode) : undefined,
      request: async () => {
        const payload = await this.requestJson(url, REQUEST_TIMEOUT_MS, (value) => { retryAfter = value; });
        if (!isMetarPayload(payload) || payload.metar.icao !== normalizedIcao) throw new WindsClientError("INVALID_RESPONSE", "METAR response did not match the documented contract.");
        return payload;
      },
    }) as Promise<MetarSuccessPayload>;
  }

  public async fetchPoint(query: AloftPointQuery): Promise<AloftPointAnswer> {
    if (!isAloftPointQuery(query)) throw new WindsClientError("INVALID_INPUT", "Winds point query must include a bounded coordinate, supported MSL altitude, and canonical UTC instant.");
    const canonicalQuery = { ...query, latitudeDeg: canonicalPointCoordinateDegrees(query.latitudeDeg), longitudeDeg: canonicalPointCoordinateDegrees(query.longitudeDeg) };
    const url = new URL("/api/weather/winds/point", this.baseUrl);
    url.searchParams.set("lat", canonicalQuery.latitudeDeg.toString());
    url.searchParams.set("lon", canonicalQuery.longitudeDeg.toString());
    url.searchParams.set("altitudeFeetMsl", String(canonicalQuery.altitudeFeetMsl));
    url.searchParams.set("plannedUtc", canonicalQuery.plannedUtc);
    let retryAfter: string | null = null;
    return this.reuse.run(url.href, {
      validateReuse: (value) => { if (!("query" in value) || !isAloftPointAnswer(value) || !samePointQuery(value.query, canonicalQuery)) throw new WindsClientError("INVALID_RESPONSE", "Winds point response did not match the requested query and documented contract."); },
      retryAfter: () => retryAfter,
      safeError: (error) => error instanceof WindsClientError ? new WindsClientError(error.code, error.message, error.requestId, error.apiCode) : undefined,
      freshness: (value) => pointReuseDeadline(value as AloftPointAnswer),
      age: (value, now) => { const answer = value as AloftPointAnswer; return { ...answer,
        product: { ...answer.product, cache: { ...answer.product.cache, freshnessRemainingSeconds: Math.max(0, answer.product.cache.freshnessRemainingSeconds - Math.max(0, Math.floor((now - Date.parse(answer.product.cache.servedAt)) / 1000))) } },
        catalog: { cache: { ...answer.catalog.cache, freshnessRemainingSeconds: Math.max(0, answer.catalog.cache.freshnessRemainingSeconds - Math.max(0, Math.floor((now - Date.parse(answer.catalog.cache.servedAt)) / 1000))) } },
      }; },
      request: async () => {
        const payload = await this.requestJson(url, WEATHER_REQUEST_TIMEOUT_MS, (value) => { retryAfter = value; });
        if (!isAloftPointAnswer(payload) || !samePointQuery(payload.query, canonicalQuery)) throw new WindsClientError("INVALID_RESPONSE", "Winds point response did not match the requested query and documented contract.");
        return payload;
      },
    }) as Promise<AloftPointAnswer>;
  }

  private async requestJson(url: URL, timeoutMs = REQUEST_TIMEOUT_MS, onRetryAfter?: (value: string | null) => void): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetcher.fetch(url, { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal });
      } catch {
        throw new WindsClientError("TRANSPORT_FAILURE", "Winds API request could not be completed.");
      }
      if (!response.ok) onRetryAfter?.(response.headers.get("Retry-After"));
      const payload = await readBoundedJson(response);
      if (!response.ok) {
        if (isErrorPayload(payload)) {
          throw new WindsClientError("API_FAILURE", `Winds API request failed: ${payload.code}.`, payload.requestId, payload.code);
        }
        throw new WindsClientError("INVALID_RESPONSE", "Winds API returned an unsuccessful response without a valid error contract.");
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }
}

const freshResourceDeadline = (cache: CacheProvenance, expectedKey: string, expectedResource: string): number | undefined => {
  if (!isFreshResource(cache) || cache.key !== expectedKey || cache.resource !== expectedResource) return undefined;
  const fetched = Date.parse(cache.fetchedAt), served = Date.parse(cache.servedAt), expires = Date.parse(cache.expiresAt);
  const now = Date.now();
  if (!isValidResourceTiming(cache, fetched, served, expires, now)) return undefined;
  return Math.min(expires, served + cache.freshnessRemainingSeconds * 1000, fetched + cache.maxPayloadAgeSeconds * 1000);
};
const isFreshResource = (cache: CacheProvenance): boolean => oneOf(cache.status, ["edge_hit", "kv_hit", "upstream_refresh"]) && oneOf(cache.source, ["edge", "kv", "upstream"]);
const isValidResourceTiming = (cache: CacheProvenance, fetched: number, served: number, expires: number, now: number): boolean =>
  [fetched, served, expires].every(Number.isFinite) && served >= fetched && served <= now && cache.ageSeconds >= 0 && cache.ttlSeconds >= 0 &&
  cache.freshnessRemainingSeconds >= 0 && cache.freshnessRemainingSeconds <= cache.ttlSeconds && cache.maxPayloadAgeSeconds >= 0 && cache.ageSeconds === Math.floor((served - fetched) / 1000);

const metarReuseDeadline = (payload: MetarSuccessPayload, icao: string): number | undefined => {
  const cache = payload.provenance.cache;
  if (payload.provenance.adapter !== "runway-picker" || payload.provenance.fetchedAt !== payload.metar.fetchedAt || cache.fetchedAt !== payload.metar.fetchedAt || (cache.key !== `v1:metar:${icao}` && cache.key !== `metar:${icao}`) || cache.resource !== "metar") return undefined;
  return freshResourceDeadline(cache, cache.key, "metar");
};
const pointReuseDeadline = (answer: AloftPointAnswer): number | undefined => {
  const product = freshResourceDeadline(answer.product.cache, `winds:${answer.product.region}:${answer.product.cycle}`, "winds-temps");
  const catalog = freshResourceDeadline(answer.catalog.cache, "station-catalog:v1", "station-catalog");
  return product === undefined || catalog === undefined ? undefined : Math.min(product, catalog);
};
