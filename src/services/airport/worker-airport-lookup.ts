import type { AirportSuccessPayload } from "../../../worker/api/contracts";
import { normalizeAirportCode, type AirportLookup } from "../../application/airport-lookup";
import { coordinate } from "../../domain/coordinates";
import type { AirportRoutePoint } from "../../domain/route";

const MAX_RESPONSE_BYTES = 256 * 1024;

/** Same-origin Worker lookup; no browser request is made to the upstream provider. */
export class WorkerAirportLookup implements AirportLookup {
  public constructor(
    private readonly fetcher: Pick<typeof globalThis, "fetch"> = globalThis,
    private readonly baseUrl: string = globalThis.location?.origin ?? "http://localhost",
  ) {}

  public async lookupAirportCode(value: string): Promise<AirportRoutePoint> {
    const code = normalizeAirportCode(value);
    const url = new URL(`/api/airports/${code}`, this.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await this.fetcher.fetch(url, { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response));
      if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new Error("Airport lookup did not return JSON.");
      const payload = await readBoundedJson(response);
      return airportRoutePoint(payload, code);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("Airport lookup timed out.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
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
