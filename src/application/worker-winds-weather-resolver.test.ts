import { describe, expect, it } from "vitest";

import type { MetarSuccessPayload, WindsForecastSuccessPayload, WindsRegion, WindsStation, WindsStationsSuccessPayload } from "../../worker/api/contracts";
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
  forecasts: [{ stationId: "BRL", forecastCycle: "06", issuedAt: "2026-09-21T18:00:00.000Z", validAt: "2026-09-22T00:00:00.000Z", useFrom: "2026-09-21T20:00:00.000Z", useUntil: "2026-09-22T03:00:00.000Z" }],
  unavailableForecastCycles: [],
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
      weatherSnapshotId: "winds-snapshot-1",
    });
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T22:00:00.000Z", weatherSelection: { forecastValidTimeUtc: "2026-09-22T00:00:00.000Z", selectedAtUtc: "2026-09-21T18:30:00.000Z" } };
    const result = await resolver.resolve({ draft, aircraftProfile: aircraftProfile(), routeLegs: [] });

    expect(client.route).toHaveLength(draft.route.points.length);
    expect(result).toMatchObject({
      snapshotIds: ["winds-snapshot-1"],
      selectedForecastValidTimeUtc: "2026-09-22T00:00:00.000Z",
      referenceSnapshots: [{ source: "aviationweather:NCEP-FB-Winds-Temps", payload: { selectedStation: { id: "BRL" } } }],
    });
    await expect(resolver.resolve({ draft: { ...draft, weatherSelection: undefined }, aircraftProfile: aircraftProfile(), routeLegs: [] })).rejects.toThrow(/Choose an available winds forecast period/u);
  });

  it("anchors the departure METAR at airport-data field elevation and stores the assumption evidence", async () => {
    const metar: MetarSuccessPayload = {
      metar: { icao: "KORD", metarRaw: "KORD 212130Z 27010KT", wind: { raw: "27010KT", directionType: "fixed", directionDegTrue: 270, directionVariation: null, speedKt: 10, gustKt: null }, source: "aviationweather", fetchedAt: "2026-09-21T21:31:00.000Z", observedAt: "2026-09-21T21:30:00.000Z" },
      provenance: { adapter: "runway-picker", fetchedAt: "2026-09-21T21:31:00.000Z", cache: { ...cache, key: "metar:KORD", resource: "metar", fetchedAt: "2026-09-21T21:31:00.000Z", servedAt: "2026-09-21T21:31:00.000Z", expiresAt: "2026-09-21T21:46:00.000Z" } },
      requestId: "33333333-3333-4333-8333-333333333333",
    };
    const resolver = createWorkerWindsPlanWeatherResolver(new WorkerWindsAdapter(new Client()), {
      stationSelectionCoordinate: value(coordinate(40.8, -91.1)), weatherSnapshotId: "winds-snapshot-2",
    }, { fetchMetar: async () => metar });
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T22:00:00.000Z", weatherSelection: { forecastValidTimeUtc: "2026-09-22T00:00:00.000Z", selectedAtUtc: "2026-09-21T18:30:00.000Z", surfaceWeatherIcao: "KORD" } };
    const result = await resolver.resolve({ draft, aircraftProfile: aircraftProfile(), routeLegs: [] });
    expect(result.loadedWindsData?.surfaceToAloftInterpolation).toMatchObject({ status: "applied", fieldElevationFeetMsl: 680, fieldElevationSource: "departure-airport-data" });
    expect(result.referenceSnapshots?.[0]?.payload).toMatchObject({ surfaceToAloftInterpolation: { status: "applied", metar: { metarRaw: "KORD 212130Z 27010KT" } } });
  });

  it("uses only an explicit nearby ICAO METAR source for a FAA-LID departure", async () => {
    const metar: MetarSuccessPayload = {
      metar: { icao: "KORD", metarRaw: "KORD 212130Z 27010KT", wind: { raw: "27010KT", directionType: "fixed", directionDegTrue: 270, directionVariation: null, speedKt: 10, gustKt: null }, source: "aviationweather", fetchedAt: "2026-09-21T21:31:00.000Z", observedAt: "2026-09-21T21:30:00.000Z" },
      provenance: { adapter: "runway-picker", fetchedAt: "2026-09-21T21:31:00.000Z", cache: { ...cache, key: "metar:KORD", resource: "metar", fetchedAt: "2026-09-21T21:31:00.000Z", servedAt: "2026-09-21T21:31:00.000Z", expiresAt: "2026-09-21T21:46:00.000Z" } },
      requestId: "33333333-3333-4333-8333-333333333333",
    };
    const requested: string[] = [];
    const resolver = createWorkerWindsPlanWeatherResolver(new WorkerWindsAdapter(new Client()), {
      stationSelectionCoordinate: value(coordinate(40.8, -91.1)), weatherSnapshotId: "winds-snapshot-lid",
    }, { fetchMetar: async (icao) => { requested.push(icao); return metar; } });
    const base = planDraft();
    const draft = {
      ...base,
      departureTimeUtc: "2026-09-21T22:00:00.000Z",
      route: { ...base.route, points: [{ ...base.route.points[0]!, icao: "1C8" }, ...base.route.points.slice(1)] },
      weatherSelection: { forecastValidTimeUtc: "2026-09-22T00:00:00.000Z", selectedAtUtc: "2026-09-21T18:30:00.000Z", surfaceWeatherIcao: "KORD" },
    };

    const result = await resolver.resolve({ draft, aircraftProfile: aircraftProfile(), routeLegs: [] });
    expect(requested).toEqual(["KORD"]);
    expect(result.loadedWindsData?.surfaceToAloftInterpolation).toMatchObject({ status: "applied", airportIcao: "1C8", surfaceWeatherIcao: "KORD", fieldElevationFeetMsl: 680 });
  });

  it("does not infer a METAR source from an ICAO-looking departure identifier", async () => {
    const requested: string[] = [];
    const resolver = createWorkerWindsPlanWeatherResolver(new WorkerWindsAdapter(new Client()), {
      stationSelectionCoordinate: value(coordinate(40.8, -91.1)), weatherSnapshotId: "winds-snapshot-implicit-source",
    }, { fetchMetar: async (icao) => { requested.push(icao); throw new Error("unexpected METAR request"); } });
    const base = planDraft();
    const draft = {
      ...base,
      departureTimeUtc: "2026-09-21T22:00:00.000Z",
      route: { ...base.route, points: [{ ...base.route.points[0]!, icao: "KORD" }, ...base.route.points.slice(1)] },
      weatherSelection: { forecastValidTimeUtc: "2026-09-22T00:00:00.000Z", selectedAtUtc: "2026-09-21T18:30:00.000Z" },
    };

    const result = await resolver.resolve({ draft, aircraftProfile: aircraftProfile(), routeLegs: [] });

    expect(requested).toEqual([]);
    expect(result.loadedWindsData?.surfaceToAloftInterpolation).toBeUndefined();
  });

  it("warns when an explicitly selected surface METAR cannot be loaded", async () => {
    const resolver = createWorkerWindsPlanWeatherResolver(new WorkerWindsAdapter(new Client()), {
      stationSelectionCoordinate: value(coordinate(40.8, -91.1)), weatherSnapshotId: "winds-snapshot-metar-failure",
    }, { fetchMetar: async () => { throw new Error("transport details must not be exposed"); } });
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T22:00:00.000Z", weatherSelection: { forecastValidTimeUtc: "2026-09-22T00:00:00.000Z", selectedAtUtc: "2026-09-21T18:30:00.000Z", surfaceWeatherIcao: "KORD" } };

    const result = await resolver.resolve({ draft, aircraftProfile: aircraftProfile(), routeLegs: [] });

    expect(result.warnings).toEqual(["Selected surface METAR KORD could not be loaded; calculation uses winds aloft only."]);
    expect(result.loadedWindsData?.surfaceToAloftInterpolation).toBeUndefined();
  });

  it("does not apply interpolation when the returned METAR identity mismatches the selected source", async () => {
    const metar: MetarSuccessPayload = {
      metar: { icao: "KMKE", metarRaw: "KMKE 212130Z 27010KT", wind: { raw: "27010KT", directionType: "fixed", directionDegTrue: 270, directionVariation: null, speedKt: 10, gustKt: null }, source: "aviationweather", fetchedAt: "2026-09-21T21:31:00.000Z", observedAt: "2026-09-21T21:30:00.000Z" },
      provenance: { adapter: "runway-picker", fetchedAt: "2026-09-21T21:31:00.000Z", cache: { ...cache, key: "metar:KORD", resource: "metar", fetchedAt: "2026-09-21T21:31:00.000Z", servedAt: "2026-09-21T21:31:00.000Z", expiresAt: "2026-09-21T21:46:00.000Z" } },
      requestId: "33333333-3333-4333-8333-333333333333",
    };
    const resolver = createWorkerWindsPlanWeatherResolver(new WorkerWindsAdapter(new Client()), {
      stationSelectionCoordinate: value(coordinate(40.8, -91.1)), weatherSnapshotId: "winds-snapshot-metar-mismatch",
    }, { fetchMetar: async () => metar });
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T22:00:00.000Z", weatherSelection: { forecastValidTimeUtc: "2026-09-22T00:00:00.000Z", selectedAtUtc: "2026-09-21T18:30:00.000Z", surfaceWeatherIcao: "KORD" } };

    const result = await resolver.resolve({ draft, aircraftProfile: aircraftProfile(), routeLegs: [] });

    expect(result.loadedWindsData?.surfaceToAloftInterpolation).toMatchObject({ status: "unavailable", reason: "airport-identity-mismatch", surfaceWeatherIcao: "KORD" });
    expect(result.warnings).toEqual(["Selected surface METAR KORD was not usable; calculation uses winds aloft only."]);
  });

  it("continues without a METAR anchor when the optional METAR dependency is unavailable", async () => {
    const resolver = createWorkerWindsPlanWeatherResolver(new WorkerWindsAdapter(new Client()), {
      stationSelectionCoordinate: value(coordinate(40.8, -91.1)), weatherSnapshotId: "winds-snapshot-3",
    }, { fetchMetar: async () => { throw new Error("temporary METAR outage"); } });
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T22:00:00.000Z", weatherSelection: { forecastValidTimeUtc: "2026-09-22T00:00:00.000Z", selectedAtUtc: "2026-09-21T18:30:00.000Z" } };

    const result = await resolver.resolve({ draft, aircraftProfile: aircraftProfile(), routeLegs: [] });

    expect(result.loadedWindsData?.surfaceToAloftInterpolation).toBeUndefined();
  });

  it("warns when the winds product is retained only because upstream refresh failed", async () => {
    const staleForecast = forecast();
    const staleProvenance = { ...staleForecast.provenance, cache: { ...staleForecast.provenance.cache, status: "stale_on_error" as const, source: "stale" as const, freshnessRemainingSeconds: 0 } };
    const winds: WindsTransportClient = {
      discoverStations: async () => discovery(),
      fetchForecast: async () => ({ ...staleForecast, provenance: staleProvenance }),
    };
    const resolver = createWorkerWindsPlanWeatherResolver(new WorkerWindsAdapter(winds), {
      stationSelectionCoordinate: value(coordinate(40.8, -91.1)), weatherSnapshotId: "winds-snapshot-stale",
    });
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T22:00:00.000Z", weatherSelection: { forecastValidTimeUtc: "2026-09-22T00:00:00.000Z", selectedAtUtc: "2026-09-21T18:30:00.000Z" } };

    await expect(resolver.resolve({ draft, aircraftProfile: aircraftProfile(), routeLegs: [] })).resolves.toMatchObject({ warnings: [expect.stringMatching(/stale cache/i)] });
  });

  it("composes selected-METAR failure and stale-winds warnings", async () => {
    const staleForecast = forecast();
    const staleProvenance = { ...staleForecast.provenance, cache: { ...staleForecast.provenance.cache, status: "stale_on_error" as const, source: "stale" as const, freshnessRemainingSeconds: 0 } };
    const winds: WindsTransportClient = {
      discoverStations: async () => discovery(),
      fetchForecast: async () => ({ ...staleForecast, provenance: staleProvenance }),
    };
    const resolver = createWorkerWindsPlanWeatherResolver(new WorkerWindsAdapter(winds), {
      stationSelectionCoordinate: value(coordinate(40.8, -91.1)), weatherSnapshotId: "winds-snapshot-stale-metar-failure",
    }, { fetchMetar: async () => { throw new Error("METAR outage"); } });
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T22:00:00.000Z", weatherSelection: { forecastValidTimeUtc: "2026-09-22T00:00:00.000Z", selectedAtUtc: "2026-09-21T18:30:00.000Z", surfaceWeatherIcao: "KORD" } };

    const result = await resolver.resolve({ draft, aircraftProfile: aircraftProfile(), routeLegs: [] });

    expect(result.warnings).toEqual([
      "Selected surface METAR KORD could not be loaded; calculation uses winds aloft only.",
      expect.stringMatching(/stale cache/i),
    ]);
  });
});
