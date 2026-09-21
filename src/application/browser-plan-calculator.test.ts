import { describe, expect, it } from "vitest";
import type { MetarSuccessPayload, WindsForecastSuccessPayload, WindsStationsSuccessPayload } from "../../worker/api/contracts";
import type { PlanFamily, PlanRevision, WeatherReferenceSnapshot } from "../domain/route";
import { aircraftProfile, planDraft } from "../services/storage/__tests__/fixtures";
import type { MetarTransportClient, WindsTransportClient } from "../services/weather/winds-client";
import { createBrowserPlanCalculator } from "./browser-plan-calculator";

const timestamp = "2026-09-21T21:30:00.000Z";
const cache = { status: "upstream_refresh" as const, source: "upstream" as const, ageSeconds: 0, fetchedAt: timestamp, expiresAt: "2026-09-21T21:50:00.000Z", freshnessRemainingSeconds: 1200, servedAt: timestamp, ttlSeconds: 1200, maxPayloadAgeSeconds: 7200, key: "weather", resource: "weather" };
const station = { id: "BRL", name: "Burlington", coordinates: { latitudeDeg: 40.7832, longitudeDeg: -91.1255 }, elevationFt: 698, region: "us" as const, availableForecastCycles: ["06" as const], source: "aviationweather" as const };
const provenance = { adapter: "aviationweather" as const, product: "NCEP FB Winds/Temps (legacy FD)" as const, region: "us" as const, endpoint: "https://aviationweather.gov/api/data/windtemp" as const, fetchedAt: timestamp, cache };
const period = { forecastCycle: "06" as const, issuedAt: "2026-09-21T18:00:00.000Z", validAt: "2026-09-22T00:00:00.000Z", useFrom: "2026-09-21T20:00:00.000Z", useUntil: "2026-09-22T03:00:00.000Z" };

const client: WindsTransportClient & MetarTransportClient = {
  discoverStations: async (): Promise<WindsStationsSuccessPayload> => ({ stations: [station], forecasts: [period], requestedRoute: [], provenance: [provenance], requestId: "11111111-1111-4111-8111-111111111111" }),
  fetchForecast: async (): Promise<WindsForecastSuccessPayload> => ({ forecast: {
    station, ...period, levels: [
      { altitudeFt: 3000, windFromDegTrue: 270, windSpeedKt: 15, temperatureC: 2, availability: "available", raw: "2715+02" },
      { altitudeFt: 6000, windFromDegTrue: 280, windSpeedKt: 20, temperatureC: -2, availability: "available", raw: "2820-02" },
      { altitudeFt: 9000, windFromDegTrue: 280, windSpeedKt: 25, temperatureC: -9, availability: "available", raw: "2825-09" },
    ], rawProduct: "official raw FB fixture", source: "aviationweather", fetchedAt: timestamp,
  }, provenance, requestId: "22222222-2222-4222-8222-222222222222" }),
  fetchMetar: async (): Promise<MetarSuccessPayload> => ({
    metar: { icao: "KORD", metarRaw: "KORD 212130Z 27010KT", wind: { raw: "27010KT", directionType: "fixed", directionDegTrue: 270, directionVariation: null, speedKt: 10, gustKt: null }, source: "aviationweather", fetchedAt: timestamp, observedAt: timestamp },
    provenance: { adapter: "runway-picker", fetchedAt: timestamp, cache: { ...cache, key: "metar:KORD", resource: "metar" } },
    requestId: "33333333-3333-4333-8333-333333333333",
  }),
};

describe("browser plan composition", () => {
  it("requires an explicit selected period before fetching or saving", async () => {
    let writes = 0;
    const calculator = createBrowserPlanCalculator({ saveCalculatedPlanRevision: async () => { writes += 1; } }, client, { next: () => "id-1" }, { now: () => new Date(timestamp) });
    const result = await calculator(planDraft(), aircraftProfile());
    expect(result).toMatchObject({ status: "blocked", reason: "forecast-not-selected" });
    expect(writes).toBe(0);
  });

  it("composes actual weather, field-elevation interpolation, phase rows, and atomic evidence save", async () => {
    const saved: { family: PlanFamily; revision: PlanRevision; snapshots: readonly WeatherReferenceSnapshot[] }[] = [];
    let next = 0;
    const calculator = createBrowserPlanCalculator({ saveCalculatedPlanRevision: async (family, revision, snapshots) => { saved.push({ family, revision, snapshots }); } }, client, { next: () => `new-${++next}` }, { now: () => new Date(timestamp) });
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T22:00:00.000Z", weatherSelection: { forecastValidTimeUtc: period.validAt, selectedAtUtc: timestamp } };
    const result = await calculator(draft, aircraftProfile());
    expect(result.status).toBe("saved");
    expect(saved).toHaveLength(1);
    expect(saved[0]?.revision.calculationSnapshot).toMatchObject({ schema: "complete-navlog/v1", status: "calculated", navlog: { rows: expect.any(Array) } });
    expect(saved[0]?.snapshots[0]?.payload).toMatchObject({ surfaceToAloftInterpolation: { status: "applied", fieldElevationFeetMsl: 680, fieldElevationSource: "departure-airport-data" } });
  });
});
