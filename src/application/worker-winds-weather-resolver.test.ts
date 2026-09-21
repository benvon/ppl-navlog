import { describe, expect, it } from "vitest";

import type { WindsForecastSuccessPayload, WindsRegion, WindsStation, WindsStationsSuccessPayload } from "../../worker/api/contracts";
import { coordinate, type Coordinate } from "../domain/coordinates";
import { aircraftProfile, planDraft } from "../services/storage/__tests__/fixtures";
import { WorkerWindsAdapter } from "../services/weather/winds-adapter";
import type { WindsTransportClient } from "../services/weather/winds-client";
import { createWorkerWindsPlanWeatherResolver } from "./worker-winds-weather-resolver";

const value = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!result.ok) throw new Error("Expected valid test data.");
  return result.value;
};

const cache = {
  status: "upstream_refresh" as const, source: "upstream" as const, ageSeconds: 0,
  fetchedAt: "2026-09-21T18:30:00.000Z", expiresAt: "2026-09-21T18:50:00.000Z", freshnessRemainingSeconds: 1200,
  servedAt: "2026-09-21T18:30:00.000Z", ttlSeconds: 1200, maxPayloadAgeSeconds: 7200, key: "winds/us/06", resource: "winds-temps",
};
const provenance = { adapter: "aviationweather" as const, product: "NCEP FB Winds/Temps (legacy FD)" as const, region: "us" as const, endpoint: "https://aviationweather.gov/api/data/windtemp" as const, fetchedAt: "2026-09-21T18:30:00.000Z", cache };
const station: WindsStation = { id: "BRL", name: "Burlington", coordinates: { latitudeDeg: 40.7832, longitudeDeg: -91.1255 }, elevationFt: 698, region: "us", availableForecastCycles: ["06"], source: "aviationweather" };
const discovery = (): WindsStationsSuccessPayload => ({
  stations: [station],
  forecasts: [{ forecastCycle: "06", issuedAt: "2026-09-21T18:00:00.000Z", validAt: "2026-09-22T00:00:00.000Z", useFrom: "2026-09-21T20:00:00.000Z", useUntil: "2026-09-22T03:00:00.000Z" }],
  requestedRoute: [{ latitudeDeg: 40.8, longitudeDeg: -91.1 }], provenance: [provenance], requestId: "11111111-1111-4111-8111-111111111111",
});
const forecast = (): WindsForecastSuccessPayload => ({
  forecast: {
    station, forecastCycle: "06", issuedAt: "2026-09-21T18:00:00.000Z", validAt: "2026-09-22T00:00:00.000Z",
    useFrom: "2026-09-21T20:00:00.000Z", useUntil: "2026-09-22T03:00:00.000Z",
    levels: [{ altitudeFt: 3000, windFromDegTrue: 270, windSpeedKt: 20, temperatureC: 2, availability: "available", raw: "2720+02" }, { altitudeFt: 6000, windFromDegTrue: 280, windSpeedKt: 22, temperatureC: -2, availability: "available", raw: "2822-02" }],
    rawProduct: "official product text", source: "aviationweather", fetchedAt: "2026-09-21T18:30:00.000Z",
  }, provenance, requestId: "22222222-2222-4222-8222-222222222222",
});

class Client implements WindsTransportClient {
  public route: readonly Coordinate[] = [];
  public async discoverStations(route: readonly Coordinate[]): Promise<WindsStationsSuccessPayload> { this.route = route; return discovery(); }
  public async fetchForecast(_station: string, _validTimeUtc: string, _region: WindsRegion): Promise<WindsForecastSuccessPayload> { return forecast(); }
}

describe("Worker winds complete-plan resolver", () => {
  it("requires explicit forecast/station selection and returns immutable source evidence without persisting it", async () => {
    const client = new Client();
    const resolver = createWorkerWindsPlanWeatherResolver(new WorkerWindsAdapter(client), {
      stationSelectionCoordinate: value(coordinate(40.8, -91.1)),
      selectedForecastValidTimeUtc: "2026-09-22T00:00:00.000Z",
      weatherSnapshotId: "winds-snapshot-1",
    });
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T22:00:00.000Z" };
    const result = await resolver.resolve({ draft, aircraftProfile: aircraftProfile(), routeLegs: [] });

    expect(client.route).toHaveLength(draft.route.points.length);
    expect(result).toMatchObject({
      snapshotIds: ["winds-snapshot-1"],
      selectedForecastValidTimeUtc: "2026-09-22T00:00:00.000Z",
      referenceSnapshots: [{ source: "aviationweather:NCEP-FB-Winds-Temps", payload: { selectedStation: { id: "BRL" } } }],
    });
  });
});
