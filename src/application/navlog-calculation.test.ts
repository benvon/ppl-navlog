import { describe, expect, it } from "vitest";

import { trace } from "../domain/calculation-trace";
import { coordinate } from "../domain/coordinates";
import { failure, success } from "../domain/errors";
import type { PlanningValue } from "../domain/planning-value";
import { feetMsl, nauticalMiles, signedDegrees, trueCourse } from "../domain/units";
import { wind } from "../domain/wind";
import type { AircraftProfile } from "../domain/aircraft";
import { isJsonValue } from "../services/storage/validation";
import { calculateNavlog, calculateNavlogRow, createNavlogCalculationSession, createNavlogCalculationState, finalizeNavlog, toNavlogCalculationSnapshot, type AllocatedNavlogSubleg, type NavlogSourceLeg, type ResolvedNavlogWind } from "./navlog-calculation";

const value = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!result.ok) throw new Error("Expected a valid test value.");
  return result.value;
};

const testTrace = (formulaId: string) => trace(formulaId, [], [], { name: "result", value: 1, unit: "unitless" });

const planningValue = <T>(effectiveValue: T, overrides: Partial<PlanningValue<T>> = {}): PlanningValue<T> => ({
  computedValue: effectiveValue,
  effectiveValue,
  origin: "calculated",
  provenance: { sourceId: "fixture", sourceLabel: "Fixture", recordedAt: "2026-09-21T12:00:00.000Z" },
  ...overrides,
});

const profile = (): AircraftProfile => ({
  schemaVersion: 1,
  id: "profile-1",
  name: "Fixture aircraft",
  cruiseTasKnots: 100,
  cruiseFuelFlowGallonsPerHour: 8,
  climbRateFeetPerMinute: 700,
  climbTasKnots: 80,
  climbFuelFlowGallonsPerHour: 12,
  descentRateFeetPerMinute: 500,
  descentTasKnots: 90,
  descentFuelFlowGallonsPerHour: 6,
  usableFuelGallons: 50,
  compassDeviationTable: [
    { magneticHeadingDegrees: 0, deviationDegrees: 0 },
    { magneticHeadingDegrees: 180, deviationDegrees: 2 },
  ],
  createdAt: "2026-09-21T12:00:00.000Z",
  updatedAt: "2026-09-21T12:00:00.000Z",
});

const subleg = (id: string, phase: AllocatedNavlogSubleg["phase"], distance: number): AllocatedNavlogSubleg => ({
  id,
  sourceLegId: "leg-1",
  phase,
  phaseId: phase,
  start: value(coordinate(42, -89)),
  end: value(coordinate(42, -88.8)),
  distance: value(nauticalMiles(distance)),
  trueCourse: value(trueCourse(90)),
  routeStartDistance: value(nauticalMiles(0)),
  routeEndDistance: value(nauticalMiles(distance)),
  startingAltitude: value(feetMsl(700)),
  endingAltitude: value(feetMsl(4_500)),
  selectedCruiseAltitude: value(feetMsl(4_500)),
});

const sourceLeg = (override = false): NavlogSourceLeg => ({
  sourceLeg: {
    id: "leg-1",
    fromPointId: "departure",
    toPointId: "destination",
    cruiseAltitudeFeetMsl: 4_500,
    ...(override ? {
      performanceOverrides: {
        cruiseTasKnots: planningValue(100, {
          effectiveValue: 105,
          override: { value: 105, reason: "Instructor exercise", createdAt: "2026-09-21T12:05:00.000Z" },
        }),
      },
    } : {}),
  },
  magneticVariation: {
    variation: planningValue(value(signedDegrees(10)), {
      effectiveValue: value(signedDegrees(12)),
      override: { value: value(signedDegrees(12)), reason: "Chart exercise", createdAt: "2026-09-21T12:05:00.000Z" },
    }),
    trace: testTrace("wmm2025-magnetic-variation"),
  },
});

const windValue = (overridden = false): ResolvedNavlogWind => {
  const fixtureWind = value(wind(180, 10));
  return {
    wind: planningValue(fixtureWind, overridden ? {
      effectiveValue: value(wind(190, 12)),
      override: { value: value(wind(190, 12)), reason: "Observed local wind", createdAt: "2026-09-21T12:04:00.000Z" },
    } : {}),
    trace: testTrace("effective-phase-wind"),
  };
};

describe("navlog calculation", () => {
  it("finalizes each progressive interval once, carries cumulative state, and summarizes the finalized rows", () => {
    const base = {
      routeLegs: [sourceLeg()], aircraftProfile: profile(),
      fuelInputs: { taxiRunupFuelGallons: 1, reserveFuelGallons: 5 },
      windResolver: { resolveEffectiveWind: () => success(windValue()) },
    };
    const session = createNavlogCalculationSession(base);
    expect(session.ok).toBe(true);
    if (!session.ok) throw new Error(session.error.message);
    const firstInterval = subleg("pilot-waypoint-a", "cruise", 10);
    const secondInterval: AllocatedNavlogSubleg = {
      ...subleg("generated-tod", "descent", 5),
      routeStartDistance: value(nauticalMiles(10)),
      routeEndDistance: value(nauticalMiles(15)),
      start: value(coordinate(42, -88.8)),
      end: value(coordinate(42, -88.7)),
    };
    let state = createNavlogCalculationState();
    let firstWindCalls = 0;
    const first = calculateNavlogRow(session.value, state, firstInterval, {
      resolveEffectiveWind: () => { firstWindCalls += 1; return success(windValue()); },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    state = first.value.state;
    expect(firstWindCalls).toBe(1);
    expect(first.value.row.cumulative.routeDistance).toBe(10);

    let secondWindCalls = 0;
    const second = calculateNavlogRow(session.value, state, secondInterval, {
      resolveEffectiveWind: () => { secondWindCalls += 1; return success(windValue()); },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error.message);
    state = second.value.state;
    expect(secondWindCalls).toBe(1);
    expect(second.value.row.cumulative.routeDistance).toBe(15);
    expect(second.value.row.cumulative.estimatedTimeEnroute).toBeCloseTo(
      first.value.row.estimatedTimeEnroute + second.value.row.estimatedTimeEnroute,
      10,
    );

    const finalized = finalizeNavlog(session.value, state);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) throw new Error(finalized.error.message);
    expect(finalized.value.rows).toEqual([first.value.row, second.value.row]);
    expect(finalized.value.fuelSummary.enrouteFuel).toBeCloseTo(first.value.row.fuel + second.value.row.fuel, 10);
    expect(finalized.value.fuelSummary.descentFuel).toBe(second.value.row.fuel);
  });

  it("calculates complete PHAK-style rows and keeps taxi, reserve, phase, and cumulative fuel distinct", () => {
    const result = calculateNavlog({
      allocatedSublegs: [subleg("climb", "climb", 5), subleg("cruise", "cruise", 10), subleg("descent", "descent", 5)],
      routeLegs: [sourceLeg()],
      aircraftProfile: profile(),
      fuelInputs: { taxiRunupFuelGallons: 1, reserveFuelGallons: 5 },
      windResolver: { resolveEffectiveWind: () => success(windValue()) },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.rows).toHaveLength(3);
    const cruise = result.value.rows[1]!;
    expect(cruise).toMatchObject({
      subleg: { phase: "cruise" },
      trueAirspeed: { effectiveValue: 100 },
      fuelFlow: { effectiveValue: 8 },
      variation: { effectiveValue: 12 },
      groundspeed: expect.any(Number),
      estimatedTimeEnroute: expect.any(Number),
      fuel: expect.any(Number),
    });
    expect(cruise.traces.windTriangle.formulaId).toBe("wind-triangle-vector-solution");
    expect(cruise.traces.trueToMagnetic.formulaId).toBe("true-to-magnetic-heading");
    expect(cruise.traces.compassDeviation.formulaId).toBe("compass-deviation-circular-linear-interpolation");
    expect(cruise.cumulative.requiredFuelWithTaxiRunupAndReserve).toBeCloseTo(
      cruise.cumulative.enrouteFuel + 6,
      10,
    );
    expect(result.value.fuelSummary).toMatchObject({ taxiRunupFuel: 1, reserveFuel: 5, usableFuel: 50 });
    expect(result.value.fuelSummary.enrouteFuel).toBeCloseTo(result.value.rows.reduce((sum, row) => sum + row.fuel, 0), 10);
    expect(result.value.fuelSummary.requiredFuel).toBeCloseTo(result.value.fuelSummary.enrouteFuel + 6, 10);
  });

  it("retains each applied override alongside its computed value instead of collapsing it into the effective result", () => {
    const result = calculateNavlog({
      allocatedSublegs: [subleg("cruise", "cruise", 10)],
      routeLegs: [sourceLeg(true)],
      aircraftProfile: profile(),
      fuelInputs: { taxiRunupFuelGallons: 1, reserveFuelGallons: 5 },
      windResolver: { resolveEffectiveWind: () => success(windValue(true)) },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const row = result.value.rows[0]!;
    expect(row.appliedOverrides).toEqual(expect.arrayContaining([
      expect.objectContaining({ input: "effective-wind", reason: "Observed local wind" }),
      expect.objectContaining({ input: "true-airspeed", computedValue: 100, effectiveValue: 105 }),
      expect.objectContaining({ input: "magnetic-variation", computedValue: 10, effectiveValue: 12 }),
    ]));
    expect(row.trueAirspeed.override?.value).toBe(105);
    expect(row.variation.override?.value).toBe(12);
  });

  it("carries a field-elevation METAR interpolation statement into the row and plan warnings", () => {
    const result = calculateNavlog({
      allocatedSublegs: [subleg("climb", "climb", 5)],
      routeLegs: [sourceLeg()],
      aircraftProfile: profile(),
      fuelInputs: { taxiRunupFuelGallons: 1, reserveFuelGallons: 5 },
      windResolver: {
        resolveEffectiveWind: () => success({
          ...windValue(),
          surfaceToAloftInterpolation: {
            status: "applied",
            assumption: "metar-at-field-elevation-vector-interpolated-to-first-fb-level",
            statement: "METAR wind at KFIX field elevation 700 ft MSL is vector-interpolated to the first forecast level.",
            airportIcao: "KFIX",
            surfaceWeatherIcao: "KFIX",
            fieldElevationFeetMsl: 700,
            fieldElevationSource: "departure-airport-data",
            metar: {
              icao: "KFIX", metarRaw: "METAR KFIX 211200Z 18010KT", observedAt: "2026-09-21T12:00:00.000Z", fetchedAt: "2026-09-21T12:01:00.000Z", source: "aviationweather",
              provenance: {
                adapter: "runway-picker", fetchedAt: "2026-09-21T12:01:00.000Z",
                cache: {
                  status: "edge_hit", source: "edge", ageSeconds: 0, fetchedAt: "2026-09-21T12:01:00.000Z", expiresAt: "2026-09-21T12:02:00.000Z",
                  freshnessRemainingSeconds: 60, servedAt: "2026-09-21T12:01:00.000Z", ttlSeconds: 60, maxPayloadAgeSeconds: 60, key: "fixture", resource: "metar",
                },
              }, requestId: "request-1",
              wind: { raw: "18010KT", directionType: "fixed", directionDegTrue: 180, directionVariation: null, speedKt: 10, gustKt: null },
            },
            directionTreatment: "fixed-true",
            firstAloftLevel: {
              transport: { altitudeFt: 3_000, availability: "available", windFromDegTrue: 190, windSpeedKt: 15, temperatureC: 10, raw: "19015+10" },
              domainLevel: { altitude: value(feetMsl(3_000)), wind: value(wind(190, 15)) },
              directionTreatment: "published-direction",
            },
            trace: testTrace("surface-to-aloft-vector-interpolation"),
          },
        }),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.rows[0]?.assumptions).toEqual([
      "METAR wind at KFIX field elevation 700 ft MSL is vector-interpolated to the first forecast level.",
    ]);
    expect(result.value.warnings).toContain("METAR wind at KFIX field elevation 700 ft MSL is vector-interpolated to the first forecast level.");
    expect(result.value.rows[0]?.effectiveWind.surfaceToAloftInterpolation?.fieldElevationFeetMsl).toBe(700);
  });

  it("fails closed when a weather resolver cannot supply an effective wind", () => {
    const result = calculateNavlog({
      allocatedSublegs: [subleg("cruise", "cruise", 10)],
      routeLegs: [sourceLeg()],
      aircraftProfile: profile(),
      fuelInputs: { taxiRunupFuelGallons: 1, reserveFuelGallons: 5 },
      windResolver: { resolveEffectiveWind: () => failure("UNSUPPORTED_WIND_ALTITUDE", "No wind is available at this altitude.") },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_WIND_ALTITUDE" } });
  });

  it("serializes the calculation as finite JSON while omitting absent optional values", () => {
    const calculation = calculateNavlog({
      allocatedSublegs: [subleg("cruise", "cruise", 10)], routeLegs: [sourceLeg()], aircraftProfile: profile(),
      fuelInputs: { taxiRunupFuelGallons: 1, reserveFuelGallons: 5 }, windResolver: { resolveEffectiveWind: () => success(windValue()) },
    });
    if (!calculation.ok) throw new Error(calculation.error.message);
    const snapshot = toNavlogCalculationSnapshot(calculation.value);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(isJsonValue(snapshot.value)).toBe(true);
    expect(snapshot.value).toMatchObject({ schema: "navlog-calculation/v1", rows: [{ appliedOverrides: expect.any(Array) }] });
    expect(JSON.stringify(snapshot.value)).not.toContain("undefined");
  });

  it("rejects invalid fuel, missing route-leg lineage, unusable fuel, and invalid cruise override values", () => {
    const base = {
      allocatedSublegs: [subleg("cruise", "cruise", 10)], routeLegs: [sourceLeg()], aircraftProfile: profile(),
      fuelInputs: { taxiRunupFuelGallons: 1, reserveFuelGallons: 5 }, windResolver: { resolveEffectiveWind: () => success(windValue()) },
    };
    expect(calculateNavlog({ ...base, fuelInputs: { taxiRunupFuelGallons: -1, reserveFuelGallons: 5 } })).toMatchObject({ ok: false, error: { code: "OUT_OF_RANGE" } });
    expect(calculateNavlog({ ...base, fuelInputs: { taxiRunupFuelGallons: 1, reserveFuelGallons: -1 } })).toMatchObject({ ok: false, error: { code: "OUT_OF_RANGE" } });
    expect(calculateNavlog({ ...base, routeLegs: [] })).toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
    expect(calculateNavlog({ ...base, aircraftProfile: { ...profile(), usableFuelGallons: -1 } })).toMatchObject({ ok: false, error: { code: "OUT_OF_RANGE" } });
    const original = sourceLeg();
    const invalidOverride: NavlogSourceLeg = {
      ...original,
      sourceLeg: { ...original.sourceLeg, performanceOverrides: { cruiseTasKnots: planningValue(0) } },
    };
    expect(calculateNavlog({ ...base, routeLegs: [invalidOverride] })).toMatchObject({ ok: false, error: { code: "OUT_OF_RANGE" } });
  });

  it("fails closed for an impossible wind triangle, invalid compass table, and incomplete METAR interpolation evidence", () => {
    const base = {
      allocatedSublegs: [subleg("cruise", "cruise", 10)], routeLegs: [sourceLeg()], aircraftProfile: profile(),
      fuelInputs: { taxiRunupFuelGallons: 1, reserveFuelGallons: 5 }, windResolver: { resolveEffectiveWind: () => success(windValue()) },
    };
    expect(calculateNavlog({ ...base, windResolver: { resolveEffectiveWind: () => success({ ...windValue(), wind: planningValue(value(wind(0, 200))) }) } })).toMatchObject({ ok: false, error: { code: "INVALID_WIND_TRIANGLE" } });
    expect(calculateNavlog({ ...base, aircraftProfile: { ...profile(), compassDeviationTable: [] } })).toMatchObject({ ok: false, error: { code: "INVALID_DEVIATION_TABLE" } });
    const incompleteSurface = {
      ...windValue(),
      surfaceToAloftInterpolation: {
        status: "applied", assumption: "metar-at-field-elevation-vector-interpolated-to-first-fb-level", statement: "Fixture assumption.", airportIcao: "KFIX", surfaceWeatherIcao: "KFIX",
        fieldElevationFeetMsl: 700, fieldElevationSource: "departure-airport-data", metar: { icao: "KFIX" }, directionTreatment: "fixed-true", firstAloftLevel: {}, trace: testTrace("fixture"),
      },
    } as ResolvedNavlogWind;
    expect(calculateNavlog({ ...base, windResolver: { resolveEffectiveWind: () => success(incompleteSurface) } })).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_WIND_ALTITUDE" } });
  });

  it("rejects a non-finite value before JSON snapshot persistence", () => {
    const result = calculateNavlog({
      allocatedSublegs: [subleg("cruise", "cruise", 10)], routeLegs: [sourceLeg()], aircraftProfile: profile(),
      fuelInputs: { taxiRunupFuelGallons: 1, reserveFuelGallons: 5 }, windResolver: { resolveEffectiveWind: () => success(windValue()) },
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(toNavlogCalculationSnapshot({ ...result.value, warnings: [Number.POSITIVE_INFINITY as unknown as string] })).toMatchObject({ ok: false, error: { code: "INVALID_NUMBER" } });
  });

  it("uses climb defaults for transition climbs, preserves an override without a reason, and supports profiles without usable-fuel data", () => {
    const source = sourceLeg();
    const routeLeg: NavlogSourceLeg = {
      ...source,
      sourceLeg: {
        ...source.sourceLeg,
        performanceOverrides: {
          cruiseFuelFlowGallonsPerHour: planningValue(8, { effectiveValue: 7, override: { value: 7, createdAt: "2026-09-21T12:05:00.000Z" } }),
        },
      },
    };
    const transition = subleg("transition", "transition-climb", 5);
    const result = calculateNavlog({
      allocatedSublegs: [transition, subleg("cruise", "cruise", 5)], routeLegs: [routeLeg], aircraftProfile: { ...profile(), usableFuelGallons: undefined },
      fuelInputs: { taxiRunupFuelGallons: 1, reserveFuelGallons: 5 }, windResolver: { resolveEffectiveWind: () => success({ ...windValue(), warnings: ["Fixture weather warning."] }) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.rows[0]).toMatchObject({ trueAirspeed: { effectiveValue: 80 }, fuelFlow: { effectiveValue: 12 } });
    const fuelOverride = result.value.rows[1]?.appliedOverrides.find((override) => override.input === "fuel-flow");
    expect(fuelOverride).toMatchObject({ input: "fuel-flow", effectiveValue: 7 });
    expect(fuelOverride).not.toHaveProperty("reason");
    expect(result.value.fuelSummary.usableFuel).toBeUndefined();
    expect(result.value.warnings).toContain("Fixture weather warning.");
  });
});
