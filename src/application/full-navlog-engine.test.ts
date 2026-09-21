import { describe, expect, it } from "vitest";

import { calculateGreatCircleDistanceAndInitialCourse, pointAlongGreatCircle } from "../domain/distance-course";
import { windAtAltitude } from "../domain/wind";
import { nauticalMiles } from "../domain/units";
import type { CompletePlanRouteLeg, CompletePlanWeather } from "./complete-plan";
import { createFullNavlogCalculationEngine } from "./full-navlog-engine";
import { calculatePlanningMagneticVariation } from "./magnetic-variation";
import { createSampledPhaseWindResolver, type LoadedWindsData } from "../services/weather/winds-adapter";
import { aircraftProfile, planDraft } from "../services/storage/__tests__/fixtures";

const value = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!result.ok) throw new Error("Expected a valid fixture value.");
  return result.value;
};

const loadedWinds = (): LoadedWindsData => ({
  availableLevels: [
    value(windAtAltitude(0, 270, 10)),
    value(windAtAltitude(3_000, 270, 15)),
    value(windAtAltitude(6_000, 280, 20)),
    value(windAtAltitude(9_000, 280, 25)),
    value(windAtAltitude(12_000, 280, 30)),
    value(windAtAltitude(18_000, 280, 35)),
    value(windAtAltitude(30_000, 280, 40)),
  ],
  forecastSelection: { period: { id: "2026-09-21T12:00:00.000Z", validFromUtc: "2026-09-21T10:00:00.000Z", validToUtc: "2026-09-21T16:00:00.000Z" } },
  forecastPayload: {
    forecast: {
      station: { id: "BRL", name: "Burlington", coordinates: { latitudeDeg: 40.7, longitudeDeg: -91.1 }, elevationFt: 698, region: "us", availableForecastCycles: ["06"], source: "aviationweather" },
      forecastCycle: "06", issuedAt: "2026-09-21T06:00:00.000Z", validAt: "2026-09-21T12:00:00.000Z", useFrom: "2026-09-21T10:00:00.000Z", useUntil: "2026-09-21T16:00:00.000Z",
      levels: [], rawProduct: "fixture", source: "aviationweather", fetchedAt: "2026-09-21T11:00:00.000Z",
    },
    provenance: {} as never,
    requestId: "forecast-request",
  },
}) as unknown as LoadedWindsData;

const completeLegs = (draft = { ...planDraft(), departureTimeUtc: "2026-09-21T12:00:00.000Z" }): readonly CompletePlanRouteLeg[] => {
  const points = new Map(draft.route.points.map((point) => [point.id, point]));
  return draft.route.legs.map((sourceLeg) => {
    const start = points.get(sourceLeg.fromPointId);
    const end = points.get(sourceLeg.toPointId);
    if (start === undefined || end === undefined) throw new Error("Fixture route is incomplete.");
    const geometry = value(calculateGreatCircleDistanceAndInitialCourse(start.coordinate, end.coordinate));
    const midpoint = value(pointAlongGreatCircle(start.coordinate, geometry.initialTrueCourse, value(nauticalMiles(geometry.distance / 2))));
    return {
      sourceLeg, start, end, distance: geometry.distance, trueCourse: geometry.initialTrueCourse, magneticCoordinate: midpoint,
      magneticVariation: calculatePlanningMagneticVariation({ coordinate: midpoint, date: new Date(draft.departureTimeUtc), altitudeFeetMsl: sourceLeg.cruiseAltitudeFeetMsl }),
    };
  });
};

const weather = (loaded = loadedWinds()): CompletePlanWeather => ({
  snapshotIds: ["winds-1"],
  selectedForecastValidTimeUtc: loaded.forecastSelection.period.id,
  phaseWindResolver: createSampledPhaseWindResolver(loaded),
  loadedWindsData: loaded,
  warnings: [],
  provenance: { source: "fixture-selected-winds" },
});

describe("full navlog calculation engine", () => {
  it("combines allocated phases with subleg weather and retains rows, boundaries, phase traces, and source provenance", async () => {
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T12:00:00.000Z" };
    const result = await createFullNavlogCalculationEngine().calculate({ draft, aircraftProfile: aircraftProfile(), routeLegs: completeLegs(draft), weather: weather() });

    expect(result.calculationSnapshot).toMatchObject({
      schema: "complete-navlog/v1",
      status: "calculated",
      weather: { selectedForecastValidTimeUtc: "2026-09-21T12:00:00.000Z", snapshotIds: ["winds-1"] },
      phaseAllocation: { status: "allocated", boundaries: expect.any(Array), phases: expect.any(Array) },
      navlog: { schema: "navlog-calculation/v1", rows: expect.any(Array) },
    });
    const snapshot = result.calculationSnapshot as { readonly phaseAllocation: { readonly phases: readonly { readonly calculation: { readonly trace: { readonly formulaId: string } } }[] }; readonly navlog: { readonly rows: readonly { readonly effectiveWind: { readonly wind: { readonly provenance: { readonly sourceId: string } } } }[] } };
    expect(snapshot.phaseAllocation.phases[0]?.calculation.trace.formulaId).toBe("vertical-phase-performance");
    expect(snapshot.navlog.rows[0]?.effectiveWind.wind.provenance.sourceId).toContain("winds-aloft:BRL");
    expect(result.warnings.join(" ")).toMatch(/altitude-transition policy/i);
  });

  it("records an infeasible allocation without fabricating navlog rows", async () => {
    const base = planDraft();
    const draft = {
      ...base,
      departureTimeUtc: "2026-09-21T12:00:00.000Z",
      route: { ...base.route, legs: base.route.legs.map((leg) => ({ ...leg, cruiseAltitudeFeetMsl: 30_000 })) },
    };
    const result = await createFullNavlogCalculationEngine().calculate({ draft, aircraftProfile: aircraftProfile(), routeLegs: completeLegs(draft), weather: weather() });

    expect(result.calculationSnapshot).toMatchObject({
      schema: "complete-navlog/v1",
      status: "infeasible-phase-allocation",
      phaseAllocation: { status: "infeasible", violations: expect.any(Array) },
    });
    expect(result.calculationSnapshot).not.toHaveProperty("navlog");
    expect(result.warnings.join(" ")).toMatch(/no cruise or transition subleg was invented/i);
  });

  it("fails closed when orchestration did not retain the selected loaded weather data", async () => {
    const noLoadedWeather = { ...weather() };
    delete (noLoadedWeather as { loadedWindsData?: LoadedWindsData }).loadedWindsData;
    await expect(createFullNavlogCalculationEngine().calculate({
      draft: { ...planDraft(), departureTimeUtc: "2026-09-21T12:00:00.000Z" }, aircraftProfile: aircraftProfile(), routeLegs: completeLegs(), weather: noLoadedWeather,
    })).rejects.toMatchObject({ name: "WeatherPhaseResolutionError" });
  });

  it("carries the applied field-elevation METAR interpolation disclosure into complete navlog rows", async () => {
    const loaded = {
      ...loadedWinds(),
      surfaceToAloftInterpolation: {
        status: "applied",
        assumption: "metar-at-field-elevation-vector-interpolated-to-first-fb-level",
        statement: "Planning assumption: departure METAR wind at the airport-data field elevation is vector-interpolated to the first FB level.",
        airportIcao: "KORD",
        fieldElevationFeetMsl: 680,
        fieldElevationSource: "departure-airport-data",
        metar: { icao: "KORD", metarRaw: "METAR KORD 211200Z 27010KT" },
        directionTreatment: "fixed-true",
        firstAloftLevel: { domainLevel: value(windAtAltitude(3_000, 270, 15)) },
      },
    } as unknown as LoadedWindsData;
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T12:00:00.000Z" };
    const result = await createFullNavlogCalculationEngine().calculate({ draft, aircraftProfile: aircraftProfile(), routeLegs: completeLegs(draft), weather: weather(loaded) });
    const snapshot = result.calculationSnapshot as { readonly navlog: { readonly rows: readonly { readonly assumptions: readonly string[] }[] } };
    expect(snapshot.navlog.rows.some((row) => row.assumptions.some((assumption) => assumption.includes("field elevation")))).toBe(true);
  });

  it("maps selected-weather envelope failures to weather resolution failures", async () => {
    const base = planDraft();
    const draft = {
      ...base, departureTimeUtc: "2026-09-21T12:00:00.000Z",
      route: { ...base.route, legs: base.route.legs.map((leg) => ({ ...leg, cruiseAltitudeFeetMsl: 35_000 })) },
    };
    await expect(createFullNavlogCalculationEngine().calculate({
      draft, aircraftProfile: aircraftProfile(), routeLegs: completeLegs(draft), weather: weather(),
    })).rejects.toMatchObject({ name: "WeatherPhaseResolutionError" });
  });

  it("fails closed on an invalid compass table instead of storing a partial navlog", async () => {
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T12:00:00.000Z" };
    await expect(createFullNavlogCalculationEngine().calculate({
      draft, aircraftProfile: { ...aircraftProfile(), compassDeviationTable: [] }, routeLegs: completeLegs(draft), weather: weather(),
    })).rejects.toMatchObject({ name: "UnsupportedCompletePlanInputError" });
  });

  it("rejects invalid route endpoints and non-finite snapshot data", async () => {
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T12:00:00.000Z" };
    const legs = completeLegs(draft);
    const invalidEndpoints = [{ ...legs[0]!, start: draft.route.points[1]! }, ...legs.slice(1)] as readonly CompletePlanRouteLeg[];
    await expect(createFullNavlogCalculationEngine().calculate({
      draft, aircraftProfile: aircraftProfile(), routeLegs: invalidEndpoints, weather: weather(),
    })).rejects.toMatchObject({ name: "UnsupportedCompletePlanInputError" });
    await expect(createFullNavlogCalculationEngine().calculate({
      draft, aircraftProfile: aircraftProfile(), routeLegs: legs, weather: { ...weather(), provenance: { invalid: Number.POSITIVE_INFINITY } } as unknown as CompletePlanWeather,
    })).rejects.toMatchObject({ name: "UnsupportedCompletePlanInputError" });
  });

  it("rejects invalid climb and descent vertical rates before allocation", async () => {
    const draft = { ...planDraft(), departureTimeUtc: "2026-09-21T12:00:00.000Z" };
    const base = { draft, routeLegs: completeLegs(draft), weather: weather() };
    await expect(createFullNavlogCalculationEngine().calculate({ ...base, aircraftProfile: { ...aircraftProfile(), climbRateFeetPerMinute: 0 } })).rejects.toMatchObject({ name: "UnsupportedCompletePlanInputError" });
    await expect(createFullNavlogCalculationEngine().calculate({ ...base, aircraftProfile: { ...aircraftProfile(), descentRateFeetPerMinute: Number.NaN } })).rejects.toMatchObject({ name: "UnsupportedCompletePlanInputError" });
  });
});
