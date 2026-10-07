import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerAirportLookup } from "./worker-airport-lookup";

const payload = {
  airport: {
    requestedIcao: "KJVL", icao: "KJVL", name: "Southern Wisconsin Regional", municipality: "Janesville", countryCode: "US", countryName: "United States",
    elevationFt: 808, coordinates: { latitudeDeg: 42.6203, longitudeDeg: -89.0416 }, runwayEnds: [], frequencies: [], source: "airportdb", fetchedAt: "2026-09-21T12:00:00.000Z",
  },
  provenance: { adapter: "runway-picker", fetchedAt: "2026-09-21T12:00:00.000Z", cache: { status: "upstream_refresh", source: "upstream", ageSeconds: 0, fetchedAt: "2026-09-21T12:00:00.000Z", expiresAt: "2026-09-21T12:15:00.000Z", freshnessRemainingSeconds: 900, servedAt: "2026-09-21T12:00:00.000Z", ttlSeconds: 900, maxPayloadAgeSeconds: 1800, key: "v1:airport:KJVL", resource: "airport" } }, requestId: "11111111-1111-4111-8111-111111111111",
};

describe("Worker airport lookup", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-21T12:00:00.000Z")); });
  afterEach(() => vi.useRealTimers());
  it("maps exact ICAO, coordinates, and field elevation from the same-origin Worker", async () => {
    let requested = "";
    const fetcher = { fetch: async (input: RequestInfo | URL): Promise<Response> => {
      requested = String(input);
      return Response.json(payload);
    } };
    const airport = await new WorkerAirportLookup(fetcher, "https://example.test").lookupAirportCode("kjvl");
    expect(requested).toBe("https://example.test/api/airports/KJVL");
    expect(airport).toMatchObject({ icao: "KJVL", elevationFeetMsl: 808, coordinate: { latitude: 42.6203, longitude: -89.0416 } });
  });

  it("reuses fresh exact lookups and isolates returned route points", async () => {
    const fetcher = { fetch: vi.fn(async (): Promise<Response> => Response.json(payload)) };
    const lookup = new WorkerAirportLookup(fetcher, "https://example.test");
    const first = await lookup.lookupAirportCode("kjvl");
    Object.assign(first, { name: "caller mutation" });
    const second = await lookup.lookupAirportCode(" KJVL ");
    expect(second.name).toBe("Southern Wisconsin Regional");
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([null, undefined, "broken", [], { ttlSeconds: 899 }, { status: "unknown" }, { status: ["edge_hit"] }, { status: { toString: null } }, { status: 1 }, { source: ["upstream"] }, { source: { toString: null } }, { source: 1 }])("returns usable airport data with malformed cache policy %j but does not retain it", async (cache) => {
    const policy = typeof cache === "object" && cache !== null && !Array.isArray(cache) ? { ...payload.provenance.cache, ...cache } : cache;
    const malformed = { ...payload, provenance: { adapter: "runway-picker", fetchedAt: payload.airport.fetchedAt, cache: policy } };
    const fetcher = { fetch: vi.fn(async (): Promise<Response> => Response.json(malformed)) };
    const lookup = new WorkerAirportLookup(fetcher, "https://example.test");
    await expect(lookup.lookupAirportCode("KJVL")).resolves.toMatchObject({ icao: "KJVL" });
    await expect(lookup.lookupAirportCode("KJVL")).resolves.toMatchObject({ icao: "KJVL" });
    expect(fetcher.fetch).toHaveBeenCalledTimes(2);
  });

  it("enforces airport expiresAt, freshness, max-age, and timestamp consistency", async () => {
    const baseCache = payload.provenance.cache;
    const cases = [
      { name: "expiresAt", cache: { ...baseCache }, advanceMs: 15 * 60_000 },
      { name: "freshness", cache: { ...baseCache, freshnessRemainingSeconds: 1 }, advanceMs: 1000 },
      { name: "maxPayloadAgeSeconds", cache: { ...baseCache, maxPayloadAgeSeconds: 1 }, advanceMs: 1000 },
      { name: "fetchedAt mismatch", cache: { ...baseCache, fetchedAt: "2026-09-21T11:59:00.000Z", ageSeconds: 60 }, advanceMs: 0 },
    ];
    for (const testCase of cases) {
      vi.setSystemTime(new Date("2026-09-21T12:00:00.000Z"));
      const value = { ...payload, provenance: { ...payload.provenance, cache: testCase.cache } };
      const fetcher = { fetch: vi.fn(async (): Promise<Response> => Response.json(value)) };
      const lookup = new WorkerAirportLookup(fetcher, "https://example.test");
      await lookup.lookupAirportCode("KJVL");
      vi.advanceTimersByTime(testCase.advanceMs);
      await lookup.lookupAirportCode("KJVL");
      expect(fetcher.fetch, testCase.name).toHaveBeenCalledTimes(2);
    }
  });

  it("passes an exact FAA LID through without inferring an ICAO prefix", async () => {
    let requested = "";
    const lidPayload = { ...payload, airport: { ...payload.airport, requestedIcao: "1C8", icao: "1C8", name: "FAA LID study airport" }, provenance: { ...payload.provenance, cache: { ...payload.provenance.cache, key: "v1:airport:1C8" } } };
    const fetcher = { fetch: async (input: RequestInfo | URL): Promise<Response> => {
      requested = String(input);
      return Response.json(lidPayload);
    } };

    const airport = await new WorkerAirportLookup(fetcher, "https://example.test").lookupAirportCode("1c8");
    expect(requested).toBe("https://example.test/api/airports/1C8");
    expect(airport).toMatchObject({ icao: "1C8", name: "FAA LID study airport" });
  });

  it("surfaces a documented Worker error rather than a bare HTTP status", async () => {
    const fetcher = { fetch: async (): Promise<Response> => Response.json(
      { error: "Airport code was not found.", code: "upstream_no_data", requestId: "11111111-1111-4111-8111-111111111111" },
      { status: 404 },
    ) };
    await expect(new WorkerAirportLookup(fetcher, "https://example.test").lookupAirportCode("1C8")).rejects.toThrow("Airport code was not found.");
  });

  it("rejects mismatched airports and missing field elevation", async () => {
    const mismatched = { fetch: async (): Promise<Response> => Response.json({ ...payload, airport: { ...payload.airport, icao: "KORD" } }) };
    await expect(new WorkerAirportLookup(mismatched, "https://example.test").lookupAirportCode("KJVL")).rejects.toThrow(/different/u);
    const noElevation = { fetch: async (): Promise<Response> => Response.json({ ...payload, airport: { ...payload.airport, elevationFt: null } }) };
    await expect(new WorkerAirportLookup(noElevation, "https://example.test").lookupAirportCode("KJVL")).rejects.toThrow(/field elevation/u);
  });

  it("rejects oversized responses before JSON parsing", async () => {
    const oversized = { fetch: async (): Promise<Response> => new Response("x".repeat(256 * 1024 + 1), { headers: { "Content-Type": "application/json" } }) };
    await expect(new WorkerAirportLookup(oversized, "https://example.test").lookupAirportCode("KJVL")).rejects.toThrow(/size limit/u);
  });
});
