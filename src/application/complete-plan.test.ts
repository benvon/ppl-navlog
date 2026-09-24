import { describe, expect, it } from "vitest";

import { failure, success } from "../domain/errors";
import { wind } from "../domain/wind";
import { aircraftProfile, planDraft } from "../services/storage/__tests__/fixtures";
import { calculateCompletePlan, type CompletePlanDependencies } from "./complete-plan";
import { createVerticalProfileCalculationEngine } from "./phase-calculation-engine";

const resolvedWind = wind(270, 20);
if (!resolvedWind.ok) throw new Error("Test wind must be valid.");

const dependencies = (overrides: Partial<CompletePlanDependencies> = {}): CompletePlanDependencies => ({
  weather: {
    resolve: async () => ({
      snapshotIds: ["weather-winds-1"],
      selectedForecastValidTimeUtc: "2026-09-21T12:00:00.000Z",
      phaseWindResolver: { resolveEffectiveWind: () => success(resolvedWind.value) },
      warnings: ["Forecast is a fixture."],
      provenance: { source: "fixture" },
    }),
  },
  calculations: {
    calculate: async ({ routeLegs, weather }) => ({
      calculationSnapshot: { calculatedRouteLegCount: routeLegs.length, forecast: weather.selectedForecastValidTimeUtc ?? null },
      warnings: [],
    }),
  },
  ...overrides,
});

describe("complete plan orchestration", () => {
  it("composes route geometry, profile, selected weather, WMM variation, and the phase-calculation seam", async () => {
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T12:00:00.000Z" };
    const result = await calculateCompletePlan(draft, aircraftProfile(), dependencies());

    expect(result).toMatchObject({
      status: "ready",
      weather: { snapshotIds: ["weather-winds-1"] },
      calculationSnapshot: { calculatedRouteLegCount: 2 },
    });
    if (result.status !== "ready") throw new Error("Expected a completed plan.");
    expect(result.routeLegs[0]?.magneticVariation.variation.provenance.sourceLabel).toContain("WMM-2025");
    expect(result.routeLegs[0]?.magneticCoordinate).not.toEqual(result.routeLegs[0]?.start.coordinate);
  });

  it("fails closed when selected forecast data or magnetic data cannot be resolved", async () => {
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T12:00:00.000Z" };
    const weatherUnavailable = await calculateCompletePlan(draft, aircraftProfile(), dependencies({ weather: { resolve: async () => { throw new Error("Winds source unavailable."); } } }));
    expect(weatherUnavailable).toMatchObject({ status: "blocked", reason: "weather-unavailable", message: "Winds source unavailable." });

    const magneticUnavailable = await calculateCompletePlan(
      { ...draft, departureTimeUtc: "2030-01-01T12:00:00.000Z" },
      aircraftProfile(),
      dependencies(),
    );
    expect(magneticUnavailable).toMatchObject({ status: "blocked", reason: "magnetic-unavailable" });
  });

  it("uses the concrete vertical-profile slice to calculate TOC, TOD, and an explicit infeasible-profile result", async () => {
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T12:00:00.000Z" };
    const result = await calculateCompletePlan(draft, aircraftProfile(), dependencies({ calculations: createVerticalProfileCalculationEngine() }));

    expect(result).toMatchObject({
      status: "ready",
      calculationSnapshot: {
        schema: "vertical-profile-plan/v1",
        scope: "vertical-profile-only",
        status: "calculated",
        topOfClimb: { sourceLegId: "leg-1" },
        topOfDescent: { sourceLegId: "leg-2" },
      },
    });

    const tooShort = {
      ...draft,
      route: { ...draft.route, legs: draft.route.legs.map((leg) => ({ ...leg, cruiseAltitudeFeetMsl: 18_000 })) },
    };
    const infeasible = await calculateCompletePlan(tooShort, aircraftProfile(), dependencies({ calculations: createVerticalProfileCalculationEngine() }));
    expect(infeasible).toMatchObject({ status: "ready", calculationSnapshot: { status: "infeasible-profile" } });
  });

  it("reports the unresolved transition-allocation policy instead of silently planning a multi-altitude route", async () => {
    const draft = {
      ...planDraft(),
      departureTimeUtc: "2026-09-21T12:00:00.000Z",
      route: { ...planDraft().route, legs: planDraft().route.legs.map((leg, index) => ({ ...leg, cruiseAltitudeFeetMsl: index === 0 ? 4_500 : 6_500 })) },
    };
    const result = await calculateCompletePlan(draft, aircraftProfile(), dependencies({ calculations: createVerticalProfileCalculationEngine() }));
    expect(result).toMatchObject({ status: "blocked", reason: "unsupported-plan-input", message: expect.stringMatching(/transition-phase allocation/iu) });
  });

  it("preserves infeasible allocation evidence without applying weather-time validation", async () => {
    const result = await calculateCompletePlan({ ...planDraft(), departureTimeUtc: "2026-09-21T12:00:00.000Z" }, aircraftProfile(), dependencies({
      weather: { resolve: async () => ({ snapshotIds: [], phaseWindResolver: { resolveEffectiveWind: () => success(resolvedWind.value) }, warnings: [], provenance: { source: "fixture" }, validateCalculatedTiming: () => "timing should not be inspected" }) },
      calculations: { calculate: async () => ({ calculationSnapshot: { status: "infeasible-phase-allocation" }, warnings: ["No navlog rows were produced."] }) },
    }));
    expect(result).toMatchObject({ status: "ready", calculationSnapshot: { status: "infeasible-phase-allocation" } });
  });

  it("resolves each descent convergence iteration at its candidate TOD instead of the final user-leg origin", async () => {
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T12:00:00.000Z" };
    const descentStarts: Array<{ readonly latitude: number; readonly longitude: number }> = [];
    const result = await calculateCompletePlan(draft, aircraftProfile(), dependencies({
      weather: {
        resolve: async () => ({
          snapshotIds: ["weather-winds-1"],
          selectedForecastValidTimeUtc: "2026-09-21T12:00:00.000Z",
          phaseWindResolver: {
            resolveEffectiveWind: (request) => {
              if (request.phase === "descent") descentStarts.push(request.start);
              return success(resolvedWind.value);
            },
          },
          warnings: [],
          provenance: { source: "fixture" },
        }),
      },
      calculations: createVerticalProfileCalculationEngine(),
    }));

    expect(result.status).toBe("ready");
    expect(descentStarts[0]?.latitude).toBeCloseTo(draft.route.points[2]?.coordinate.latitude ?? Number.NaN, 10);
    expect(descentStarts[0]?.longitude).toBeCloseTo(draft.route.points[2]?.coordinate.longitude ?? Number.NaN, 10);
    expect(descentStarts[0]?.longitude).not.toBeCloseTo(draft.route.points[1]?.coordinate.longitude ?? Number.NaN, 10);
  });

  it("does not extrapolate phase wind below a published weather envelope", async () => {
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T12:00:00.000Z" };
    const result = await calculateCompletePlan(draft, aircraftProfile(), dependencies({
      weather: {
        resolve: async () => ({
          snapshotIds: ["weather-winds-1"],
          selectedForecastValidTimeUtc: "2026-09-21T12:00:00.000Z",
          phaseWindResolver: {
            resolveEffectiveWind: () => failure("UNSUPPORTED_WIND_ALTITUDE", "Climb crosses below the published winds-aloft envelope."),
          },
          warnings: [],
          provenance: { source: "fixture" },
        }),
      },
      calculations: createVerticalProfileCalculationEngine(),
    }));
    expect(result).toMatchObject({ status: "blocked", reason: "weather-unavailable", message: expect.stringMatching(/published winds-aloft envelope/iu) });
  });
});
