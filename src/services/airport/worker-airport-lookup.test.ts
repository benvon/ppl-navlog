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
    const airport = await new WorkerAirportLookup(fetcher, "https://example.test").lookupExactIcao("kjvl");
    expect(requested).toBe("https://example.test/api/airports/KJVL");
    expect(airport).toMatchObject({ icao: "KJVL", elevationFeetMsl: 808, coordinate: { latitude: 42.6203, longitude: -89.0416 } });
  });

  it("rejects mismatched airports and missing field elevation", async () => {
    const mismatched = { fetch: async (): Promise<Response> => Response.json({ ...payload, airport: { ...payload.airport, icao: "KORD" } }) };
    await expect(new WorkerAirportLookup(mismatched, "https://example.test").lookupExactIcao("KJVL")).rejects.toThrow(/different/u);
    const noElevation = { fetch: async (): Promise<Response> => Response.json({ ...payload, airport: { ...payload.airport, elevationFt: null } }) };
    await expect(new WorkerAirportLookup(noElevation, "https://example.test").lookupExactIcao("KJVL")).rejects.toThrow(/field elevation/u);
  });

  it("rejects oversized responses before JSON parsing", async () => {
    const oversized = { fetch: async (): Promise<Response> => new Response("x".repeat(256 * 1024 + 1), { headers: { "Content-Type": "application/json" } }) };
    await expect(new WorkerAirportLookup(oversized, "https://example.test").lookupExactIcao("KJVL")).rejects.toThrow(/size limit/u);
  });
});
