import { describe, expect, it } from "vitest";
import { WorkerAirportLookup } from "./worker-airport-lookup";

const payload = {
  airport: {
    requestedIcao: "KJVL", icao: "KJVL", name: "Southern Wisconsin Regional", municipality: "Janesville", countryCode: "US", countryName: "United States",
    elevationFt: 808, coordinates: { latitudeDeg: 42.6203, longitudeDeg: -89.0416 }, runwayEnds: [], frequencies: [], source: "airportdb", fetchedAt: "2026-09-21T12:00:00.000Z",
  },
  provenance: {}, requestId: "11111111-1111-4111-8111-111111111111",
};

describe("Worker airport lookup", () => {
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

  it("passes an exact FAA LID through without inferring an ICAO prefix", async () => {
    let requested = "";
    const lidPayload = { ...payload, airport: { ...payload.airport, requestedIcao: "1C8", icao: "1C8", name: "FAA LID study airport" } };
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
