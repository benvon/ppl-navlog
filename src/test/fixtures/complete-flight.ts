import type { MetarSuccessPayload } from "../../../worker/api/contracts";
import { applyCruiseTasOverride } from "../../application/plan-use-cases";
import type { AircraftProfile } from "../../domain/aircraft";
import type { PlanDraft } from "../../domain/route";
import { aircraftProfile, planDraft } from "../../services/storage/__tests__/fixtures";
import type { MetarTransportClient } from "../../services/weather/winds-client";

/** Synthetic study data only; never use this fixture as a weather briefing or aircraft POH. */
export const COMPLETE_FLIGHT_TIME = "2026-09-21T21:30:00.000Z";
export const COMPLETE_FLIGHT_FORECAST_VALID_AT = "2026-09-22T00:00:00.000Z";

const cache = {
  status: "upstream_refresh" as const, source: "upstream" as const, ageSeconds: 0,
  fetchedAt: COMPLETE_FLIGHT_TIME, expiresAt: "2026-09-21T21:50:00.000Z", freshnessRemainingSeconds: 1200,
  servedAt: COMPLETE_FLIGHT_TIME, ttlSeconds: 1200, maxPayloadAgeSeconds: 7200, key: "synthetic-study-weather", resource: "winds-temps",
};

export const completeFlightWeatherClient: MetarTransportClient = {
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
    weatherSelection: { departureMetarIcao: "KORD" },
    fuelInputs: { fuelAboardGallons: 20, taxiRunupFuelGallons: 0.8, reserveFuelGallons: 3 },
    descentTargetAltitudeFeetMsl: {
      computedValue: null, effectiveValue: 808, origin: "pilot-input",
      provenance: { sourceId: "destination-field-elevation", sourceLabel: "Pilot-selected KJVL field elevation", recordedAt: COMPLETE_FLIGHT_TIME },
    },
  };
  return applyCruiseTasOverride(draft, profile, "leg-1", 102, "Teaching example: deliberate per-leg TAS change", { now: () => new Date(COMPLETE_FLIGHT_TIME) });
}
