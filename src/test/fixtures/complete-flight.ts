import type { MetarSuccessPayload, WindsForecastSuccessPayload, WindsStationsSuccessPayload } from "../../../worker/api/contracts";
import { createBrowserPlanCalculator } from "../../application/browser-plan-calculator";
import { applyCruiseTasOverride } from "../../application/plan-use-cases";
import type { AircraftProfile } from "../../domain/aircraft";
import type { PlanDraft, PlanFamily, PlanRevision, WeatherReferenceSnapshot } from "../../domain/route";
import { aircraftProfile, planDraft } from "../../services/storage/__tests__/fixtures";
import type { MetarTransportClient, WindsTransportClient } from "../../services/weather/winds-client";

/** Synthetic study data only; never use this fixture as a weather briefing or aircraft POH. */
export const COMPLETE_FLIGHT_TIME = "2026-09-21T21:30:00.000Z";
export const COMPLETE_FLIGHT_FORECAST_VALID_AT = "2026-09-22T00:00:00.000Z";

const cache = {
  status: "upstream_refresh" as const, source: "upstream" as const, ageSeconds: 0,
  fetchedAt: COMPLETE_FLIGHT_TIME, expiresAt: "2026-09-21T21:50:00.000Z", freshnessRemainingSeconds: 1200,
  servedAt: COMPLETE_FLIGHT_TIME, ttlSeconds: 1200, maxPayloadAgeSeconds: 7200, key: "synthetic-study-weather", resource: "winds-temps",
};
const station = { id: "BRL", name: "Synthetic study winds station", coordinates: { latitudeDeg: 40.7832, longitudeDeg: -91.1255 }, elevationFt: 698, region: "us" as const, availableForecastCycles: ["06" as const], source: "aviationweather" as const };
const period = { stationId: "BRL", forecastCycle: "06" as const, issuedAt: "2026-09-21T18:00:00.000Z", validAt: COMPLETE_FLIGHT_FORECAST_VALID_AT, useFrom: "2026-09-21T20:00:00.000Z", useUntil: "2026-09-22T03:00:00.000Z" };
const provenance = { adapter: "aviationweather" as const, product: "NCEP FB Winds/Temps (legacy FD)" as const, region: "us" as const, endpoint: "https://aviationweather.gov/api/data/windtemp" as const, fetchedAt: COMPLETE_FLIGHT_TIME, cache };

export const completeFlightWeatherClient: WindsTransportClient & MetarTransportClient = {
  discoverStations: async (): Promise<WindsStationsSuccessPayload> => ({
    stations: [station], forecasts: [period], unavailableForecastCycles: [], requestedRoute: [], provenance: [provenance], requestId: "11111111-1111-4111-8111-111111111111",
  }),
  fetchForecast: async (): Promise<WindsForecastSuccessPayload> => ({
    forecast: {
      station, ...period,
      levels: [
        { altitudeFt: 3000, windFromDegTrue: 270, windSpeedKt: 15, temperatureC: 2, availability: "available", raw: "2715+02" },
        { altitudeFt: 6000, windFromDegTrue: 280, windSpeedKt: 20, temperatureC: -2, availability: "available", raw: "2820-02" },
        { altitudeFt: 9000, windFromDegTrue: 280, windSpeedKt: 25, temperatureC: -9, availability: "available", raw: "2825-09" },
      ],
      rawProduct: "SYNTHETIC STUDY FB PRODUCT — not an official forecast",
      source: "aviationweather", fetchedAt: COMPLETE_FLIGHT_TIME,
    },
    provenance, requestId: "22222222-2222-4222-8222-222222222222",
  }),
  fetchMetar: async (): Promise<MetarSuccessPayload> => ({
    metar: {
      icao: "KORD", metarRaw: "SYNTHETIC KORD 212130Z 27010KT", wind: { raw: "27010KT", directionType: "fixed", directionDegTrue: 270, directionVariation: null, speedKt: 10, gustKt: null },
      source: "aviationweather", fetchedAt: COMPLETE_FLIGHT_TIME, observedAt: COMPLETE_FLIGHT_TIME,
    },
    provenance: { adapter: "runway-picker", fetchedAt: COMPLETE_FLIGHT_TIME, cache: { ...cache, key: "synthetic-metar:KORD", resource: "metar" } },
    requestId: "33333333-3333-4333-8333-333333333333",
  }),
};

export function completeFlightProfile(): AircraftProfile {
  return {
    ...aircraftProfile(), name: "Synthetic study aircraft — not POH performance",
    compassDeviationTable: [
      { magneticHeadingDegrees: 0, deviationDegrees: -1 },
      { magneticHeadingDegrees: 90, deviationDegrees: 1 },
      { magneticHeadingDegrees: 180, deviationDegrees: 0 },
      { magneticHeadingDegrees: 270, deviationDegrees: -2 },
    ],
  };
}

export function completeFlightDraft(): PlanDraft {
  const base = planDraft();
  const profile = completeFlightProfile();
  const draft: PlanDraft = {
    ...base,
    title: "Synthetic KORD → KJVL teaching flight",
    departureTimeUtc: "2026-09-21T22:00:00.000Z",
    route: { ...base.route, legs: base.route.legs.map((leg, index) => ({ ...leg, cruiseAltitudeFeetMsl: index === 0 ? 4_500 : 5_500 })) },
    weatherSelection: { forecastValidTimeUtc: COMPLETE_FLIGHT_FORECAST_VALID_AT, selectedAtUtc: COMPLETE_FLIGHT_TIME, surfaceWeatherIcao: "KORD" },
    fuelInputs: { fuelAboardGallons: 20, taxiRunupFuelGallons: 0.8, reserveFuelGallons: 3 },
    descentTargetAltitudeFeetMsl: {
      computedValue: null, effectiveValue: 808, origin: "pilot-input",
      provenance: { sourceId: "destination-field-elevation", sourceLabel: "Pilot-selected KJVL field elevation", recordedAt: COMPLETE_FLIGHT_TIME },
    },
  };
  return applyCruiseTasOverride(draft, profile, "leg-1", 102, "Teaching example: deliberate per-leg TAS change", { now: () => new Date(COMPLETE_FLIGHT_TIME) });
}

export interface CompleteFlightFixture {
  readonly profile: AircraftProfile;
  readonly draft: PlanDraft;
  readonly family: PlanFamily;
  readonly revision: PlanRevision;
  readonly weatherSnapshots: readonly WeatherReferenceSnapshot[];
}

/** Runs the actual application composition with frozen transport and clock inputs. */
export async function createCompleteFlightFixture(): Promise<CompleteFlightFixture> {
  const profile = completeFlightProfile();
  const draft = completeFlightDraft();
  let saved: { family: PlanFamily; revision: PlanRevision; snapshots: readonly WeatherReferenceSnapshot[] } | undefined;
  let next = 0;
  const calculate = createBrowserPlanCalculator({ saveCalculatedPlanRevision: async (family, revision, snapshots) => { saved = { family, revision, snapshots }; } }, completeFlightWeatherClient, { next: () => `synthetic-${++next}` }, { now: () => new Date(COMPLETE_FLIGHT_TIME) });
  const result = await calculate(draft, profile);
  if (result.status !== "saved" || saved === undefined) throw new Error(`Synthetic complete flight did not calculate: ${result.status === "blocked" ? result.message : "no saved revision"}`);
  const record: { family: PlanFamily; revision: PlanRevision; snapshots: readonly WeatherReferenceSnapshot[] } = saved;
  return { profile, draft, family: record.family, revision: record.revision, weatherSnapshots: record.snapshots };
}
