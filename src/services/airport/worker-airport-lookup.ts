import type { AirportSuccessPayload, CacheProvenance } from "../../../worker/api/contracts";
import { normalizeAirportCode, type AirportLookup } from "../../application/airport-lookup";
import { coordinate } from "../../domain/coordinates";
import type { AirportRoutePoint } from "../../domain/route";
import { RequestReuse } from "../request-reuse";

const MAX_RESPONSE_BYTES = 256 * 1024;

/** Same-origin Worker lookup; no browser request is made to the upstream provider. */
export class WorkerAirportLookup implements AirportLookup {
  private readonly reuse = new RequestReuse<{ point: AirportRoutePoint; cache?: CacheProvenance; fetchedAt: string; provenanceFetchedAt?: string; code: string }>();
  public constructor(
    private readonly fetcher: Pick<typeof globalThis, "fetch"> = globalThis,
    private readonly baseUrl: string = globalThis.location?.origin ?? "http://localhost",
  ) {}

  public async lookupAirportCode(value: string): Promise<AirportRoutePoint> {
    const code = normalizeAirportCode(value);
    const url = new URL(`/api/airports/${code}`, this.baseUrl);
    let retryAfter: string | null = null;
    return this.reuse.run(url.href, {
      retryAfter: () => retryAfter,
      freshness: (result) => result.cache === undefined || result.provenanceFetchedAt === undefined ? undefined : airportDeadline(result.cache, result.fetchedAt, result.provenanceFetchedAt, result.code),
      age: (result, now) => result.cache === undefined ? result : ({ ...result, cache: { ...result.cache, freshnessRemainingSeconds: Math.max(0, result.cache.freshnessRemainingSeconds - Math.max(0, Math.floor((now - Date.parse(result.cache.servedAt)) / 1000))) } }),
      request: async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);
        try {
          const response = await this.fetcher.fetch(url, { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal });
          if (!response.ok) { retryAfter = response.headers.get("Retry-After"); throw new Error(await responseError(response)); }
          if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new Error("Airport lookup did not return JSON.");
          const payload = await readBoundedJson(response);
          const point = airportRoutePoint(payload, code);
          const cache = isAirportSuccessPayload(payload) ? payload.provenance.cache : undefined;
          const fetchedAt = (payload as { airport: { fetchedAt: string } }).airport.fetchedAt;
          return { point, cache, fetchedAt, provenanceFetchedAt: isAirportSuccessPayload(payload) ? payload.provenance.fetchedAt : undefined, code };
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw new Error("Airport lookup timed out.");
          throw error;
        } finally {
          clearTimeout(timeout);
        }
      },
    }).then((result) => structuredClone(result.point));
  }
}

const readBoundedJson = async (response: Response): Promise<unknown> => {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Airport lookup returned an empty response.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Airport lookup response exceeded the size limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new Error("Airport lookup returned invalid JSON."); }
};

const responseError = async (response: Response): Promise<string> => {
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return `Airport lookup failed with HTTP ${response.status}.`;
  try {
    const payload = await readBoundedJson(response);
    if (typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string" && payload.error.trim() !== "") {
      return payload.error;
    }
  } catch {
    // The generic status below intentionally avoids revealing transport details.
  }
  return `Airport lookup failed with HTTP ${response.status}.`;
};

const requiredAirport = (value: unknown, requestedIcao: string): AirportSuccessPayload["airport"] => {
  if (typeof value !== "object" || value === null || !("airport" in value)) throw new Error("Airport lookup response lacked airport data.");
  const airport = (value as Partial<AirportSuccessPayload>).airport;
  if (airport?.icao !== requestedIcao || airport.requestedIcao !== requestedIcao || typeof airport.name !== "string" || airport.name.trim() === "") {
    throw new Error("Airport lookup returned a different or unnamed airport.");
  }
  return airport;
};

const airportRoutePoint = (value: unknown, requestedIcao: string): AirportRoutePoint => {
  const airport = requiredAirport(value, requestedIcao);
  const latitude = airport.coordinates?.latitudeDeg;
  const longitude = airport.coordinates?.longitudeDeg;
  const elevation = airport.elevationFt;
  if (latitude === undefined || longitude === undefined || elevation === null || elevation === undefined || !Number.isFinite(elevation)) {
    throw new Error("Airport lookup lacks coordinates or field elevation required for flight planning.");
  }
  const checked = coordinate(latitude, longitude);
  if (!checked.ok) throw new Error("Airport lookup returned invalid coordinates.");
  return { kind: "airport", id: `airport-${requestedIcao.toLowerCase()}`, icao: requestedIcao, name: airport.name, coordinate: checked.value, elevationFeetMsl: elevation };
};

function isAirportSuccessPayload(value: unknown): value is AirportSuccessPayload {
  if (typeof value !== "object" || value === null || !("airport" in value) || !("provenance" in value)) return false;
  const payload = value as AirportSuccessPayload;
  return isAirportProvenance(payload.provenance, payload.airport.icao);
}
function isAirportProvenance(provenance: AirportSuccessPayload["provenance"], code: string): boolean {
  const cache = provenance?.cache;
  if (provenance?.adapter !== "runway-picker" || !isAirportCache(cache)) return false;
  return (cache.key === `v1:airport:${code}` || cache.key === `airport:${code}`) && cache.resource === "airport";
}
function isAirportCache(cache: unknown): cache is CacheProvenance {
  if (typeof cache !== "object" || cache === null || Array.isArray(cache)) return false;
  const value = cache as Record<string, unknown>;
  if (!isAirportCacheStatus(value.status) || !isAirportCacheSource(value.source)) return false;
  if (!hasNonnegativeCacheNumbers(value) || (value.freshnessRemainingSeconds as number) > (value.ttlSeconds as number)) return false;
  return hasAirportCacheTimestamps(value) && typeof value.key === "string" && typeof value.resource === "string";
}
function isAirportCacheStatus(status: unknown): boolean {
  return typeof status === "string" && ["edge_hit", "kv_hit", "upstream_refresh"].includes(status);
}
function isAirportCacheSource(source: unknown): boolean {
  return typeof source === "string" && ["edge", "kv", "upstream"].includes(source);
}
function hasNonnegativeCacheNumbers(value: Record<string, unknown>): boolean {
  return [value.ageSeconds, value.freshnessRemainingSeconds, value.maxPayloadAgeSeconds, value.ttlSeconds]
    .every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0);
}
function hasAirportCacheTimestamps(value: Record<string, unknown>): boolean {
  return typeof value.fetchedAt === "string" && typeof value.servedAt === "string" && typeof value.expiresAt === "string";
}
function airportDeadline(cache: CacheProvenance, fetchedAt: string, provenanceFetchedAt: string, code: string): number | undefined {
  const fetched = Date.parse(cache.fetchedAt), served = Date.parse(cache.servedAt), expires = Date.parse(cache.expiresAt), payloadFetched = Date.parse(fetchedAt);
  const now = Date.now();
  if ((cache.key !== `v1:airport:${code}` && cache.key !== `airport:${code}`) || cache.resource !== "airport" || provenanceFetchedAt !== fetchedAt || payloadFetched !== fetched ||
      ![fetched, served, expires].every(Number.isFinite) || served < fetched || served > now ||
      cache.ageSeconds !== Math.floor((served - fetched) / 1000)) return undefined;
  const deadline = Math.min(expires, served + cache.freshnessRemainingSeconds * 1000, fetched + cache.maxPayloadAgeSeconds * 1000);
  return deadline > now ? deadline : undefined;
}
