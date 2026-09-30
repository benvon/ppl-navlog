import { describe, expect, it, vi } from "vitest";
import type { AloftPointAnswer, AloftPointQuery, MetarSuccessPayload } from "../../worker/api/contracts";
import { calculateGreatCircleDistanceAndInitialCourse, pointAlongGreatCircle } from "../domain/distance-course";
import { nauticalMiles, trueCourse } from "../domain/units";
import { planDraft, aircraftProfile } from "../services/storage/__tests__/fixtures";
import { resolveRouteWeather, validateWorksheetPlanningInputs } from "./route-weather-sampling";

interface TestTraceEntry { readonly name: string; readonly value: number; }
interface TestBoundary {
  readonly kind: string;
  readonly placementTrace: readonly TestTraceEntry[];
  readonly placementAssumption: string;
}
interface TestRow {
  readonly subleg: { readonly phase: string; readonly startingAltitude?: number; readonly endingAltitude?: number; readonly selectedCruiseAltitude?: number; readonly altitudePresentation?: string; readonly endLabel?: string };
  readonly effectiveWind: { readonly wind: { readonly effectiveValue: { readonly directionFrom: number; readonly speed: number } } };
  readonly assumptions: readonly string[];
  readonly traces: Record<string, { readonly formulaId: string }>;
}
interface TestSnapshot {
  readonly schema: string;
  readonly phaseAllocation: { readonly navlogEndpoint: { readonly kind: string; readonly routeDistanceNauticalMiles: number; readonly elevationFeetMsl?: number }; readonly boundaries: readonly TestBoundary[] };
  readonly weather: { readonly endpointSources: { readonly destinationCruiseAltitudeForecast: { readonly plannedUtc: string } } };
  readonly navlog: { readonly rows: readonly TestRow[]; readonly fuelSummary: { readonly fuelAboard: number; readonly usableFuel?: number; readonly estimatedArrivalFuel: number } };
}

const departure = "2029-09-21T12:00:00.000Z";
const periodEnd = "2029-09-21T18:00:00.000Z";
const metar = (windDirection = 270): MetarSuccessPayload => ({
  metar: { icao: "KORD", metarRaw: `METAR KORD 211200Z ${windDirection}10KT`, wind: { raw: `${windDirection}10KT`, directionType: "fixed", directionDegTrue: windDirection, directionVariation: null, speedKt: 10, gustKt: null }, source: "aviationweather", fetchedAt: departure, observedAt: departure },
  provenance: { adapter: "runway-picker", fetchedAt: departure, cache: { status: "upstream_refresh", freshnessRemainingSeconds: 300 } as never }, requestId: "metar-request",
});
const answer = (query: AloftPointQuery, direction: number, speed: number): AloftPointAnswer => ({
  query, windFromDegTrue: direction, windSpeedKt: speed, temperatureC: null, issuedAt: departure, useFrom: departure, useUntil: periodEnd,
  forecastCycle: "06", product: { region: "us", cycle: "06", cache: { status: "kv_hit", source: "kv", ageSeconds: 60, fetchedAt: departure, expiresAt: departure, freshnessRemainingSeconds: 300, servedAt: departure } },
  sources: [{ stationId: "BRL", latitudeDeg: 40.7, longitudeDeg: -91.1, distanceNauticalMiles: 30, horizontalWeight: 1, lowerAltitudeFeet: query.altitudeFeetMsl, upperAltitudeFeet: query.altitudeFeetMsl, verticalWeight: 1, lowerWindFromDegTrue: direction, lowerWindSpeedKt: speed, upperWindFromDegTrue: direction, upperWindSpeedKt: speed, temperatureLowerAltitudeFeet: null, temperatureUpperAltitudeFeet: null, temperatureVerticalWeight: null, temperatureLowerC: null, temperatureUpperC: null }],
  method: "station-level", requestId: `point-${query.latitudeDeg.toFixed(3)}-${query.longitudeDeg.toFixed(3)}`,
});
const baseDraft = () => {
  const draft = planDraft();
  return { ...draft, departureTimeUtc: departure, fuelInputs: { ...draft.fuelInputs, fuelAboardGallons: 20 } };
};
const directEastboundDraft = () => {
  const draft = baseDraft();
  const start = draft.route.points[0]!;
  const destination = draft.route.points.at(-1)!;
  const distance = nauticalMiles(120), course = trueCourse(90);
  if (!distance.ok || !course.ok) throw new Error("Invalid direct-route fixture values.");
  const endpoint = pointAlongGreatCircle(start.coordinate, course.value, distance.value);
  if (!endpoint.ok) throw new Error(endpoint.error.message);
  const points = [start, { ...destination, coordinate: endpoint.value }];
  return { ...draft, route: { ...draft.route, points, legs: [{ ...draft.route.legs[0]!, fromPointId: start.id, toPointId: destination.id }] } };
};
const run = async (draft = directEastboundDraft(), windAt: (query: AloftPointQuery) => { direction: number; speed: number } = () => ({ direction: 270, speed: 15 })) => {
  const queries: AloftPointQuery[] = [];
  const solution = await resolveRouteWeather(draft, aircraftProfile(), { async fetchPoint(query) {
    queries.push(query);
    const selected = windAt(query);
    return answer(query, selected.direction, selected.speed);
  } }, { departureMetar: metar() });
  return { draft, queries, solution, snapshot: solution.weather.progressiveCalculationSnapshot as unknown as TestSnapshot };
};
const routeDistance = (draft: ReturnType<typeof directEastboundDraft>): number => draft.route.legs.reduce((sum, _leg, index) => {
  const geometry = calculateGreatCircleDistanceAndInitialCourse(draft.route.points[index]!.coordinate, draft.route.points[index + 1]!.coordinate);
  if (!geometry.ok) throw new Error(geometry.error.message);
  return sum + geometry.value.distance;
}, 0);


describe("route weather sampling for the waypoint worksheet", () => {
  it("validates a recent same-station METAR and requests preliminary destination and sequential TOC winds", async () => {
    const { draft, queries, solution, snapshot } = await run();
    const distance = routeDistance(draft);
    const expectedPreliminaryUtc = new Date(Date.parse(departure) + distance / aircraftProfile().cruiseTasKnots * 3_600_000).toISOString();
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({
      latitudeDeg: Number(draft.route.points.at(-1)!.coordinate.latitude.toFixed(10)),
      longitudeDeg: Number(draft.route.points.at(-1)!.coordinate.longitude.toFixed(10)),
      altitudeFeetMsl: draft.route.legs[0]!.cruiseAltitudeFeetMsl,
      plannedUtc: expectedPreliminaryUtc,
    });
    expect(Date.parse(queries[1]!.plannedUtc)).toBeGreaterThan(Date.parse(departure));
    expect(snapshot.schema).toBe("complete-navlog/v1");
    expect(snapshot.phaseAllocation.navlogEndpoint.kind).toBe("field-elevation-airport");
    expect(snapshot.phaseAllocation.navlogEndpoint.routeDistanceNauticalMiles).toBeCloseTo(distance, 6);
    expect(snapshot.weather.endpointSources.destinationCruiseAltitudeForecast.plannedUtc).toBe(expectedPreliminaryUtc);
    expect(solution.weather.departureMetarPayload?.requestId).toBe("metar-request");
    const rows = snapshot.navlog.rows;
    const climbRow = rows.find((row) => row.subleg.phase === "climb")!;
    expect(climbRow.effectiveWind.wind.effectiveValue).toMatchObject({ directionFrom: 270, speed: 10 });
    expect(climbRow.assumptions).toContain("TOC placement uses departure METAR wind as an initial climb approximation.");
    expect(rows.some((row) => row.traces.windTriangle && row.traces.estimatedTimeEnroute && row.traces.fuel)).toBe(true);
  });

  it("uses destination cruise-altitude wind for TOD placement and keeps vertical time fixed with wind", async () => {
    const draft = directEastboundDraft();
    const tailwind = await run(draft, (query) => query.latitudeDeg === Number(draft.route.points.at(-1)!.coordinate.latitude.toFixed(10)) ? { direction: 270, speed: 30 } : { direction: 270, speed: 0 });
    const headwind = await run(draft, (query) => query.latitudeDeg === Number(draft.route.points.at(-1)!.coordinate.latitude.toFixed(10)) ? { direction: 90, speed: 30 } : { direction: 270, speed: 0 });
    const boundary = (snapshot: TestSnapshot) => snapshot.phaseAllocation.boundaries.find((item) => item.kind === "top-of-descent");
    const tail = boundary(tailwind.snapshot)!, head = boundary(headwind.snapshot)!;
    const traceValue = (item: TestBoundary, name: string) => item.placementTrace.find((entry) => entry.name === name)!.value;
    expect(traceValue(tail, "estimated duration")).toBe(traceValue(head, "estimated duration"));
    expect(traceValue(tail, "estimated distance")).toBeGreaterThan(traceValue(head, "estimated distance"));
    expect(tail.placementAssumption).toContain("constant for descent placement");
    const descent = tailwind.snapshot.navlog.rows.find((row) => row.subleg.phase === "descent")!;
    expect(descent.effectiveWind.wind.effectiveValue.directionFrom).toBe(270);
    expect(descent.assumptions).toContain("A single cruise-altitude forecast above the destination is treated as constant for TOD placement.");
  });

  it("stores cruise altitude as an assumption and retains destination field elevation and row traces", async () => {
    const { draft, snapshot } = await run();
    const lastRow = snapshot.navlog.rows.at(-1);
    const destination = draft.route.points.at(-1)!;
    if (destination.kind !== "airport") throw new Error("Fixture destination must be an airport.");
    expect(snapshot.phaseAllocation.navlogEndpoint.elevationFeetMsl).toBe(destination.elevationFeetMsl);
    for (const row of snapshot.navlog.rows) {
      expect(row.subleg.altitudePresentation).toBe("cruise-assumption");
      expect(row.subleg.selectedCruiseAltitude).toBe(draft.route.legs[0]!.cruiseAltitudeFeetMsl);
      expect(row.subleg).not.toHaveProperty("startingAltitude");
      expect(row.subleg).not.toHaveProperty("endingAltitude");
    }
    expect(lastRow!.subleg.endLabel).toBe(destination.name);
    expect(lastRow!.traces).toMatchObject({ windTriangle: { formulaId: expect.any(String) }, magneticVariation: { formulaId: expect.any(String) }, trueToMagnetic: { formulaId: expect.any(String) }, compassDeviation: { formulaId: expect.any(String) }, magneticToCompass: { formulaId: expect.any(String) }, estimatedTimeEnroute: { formulaId: expect.any(String) }, fuel: { formulaId: expect.any(String) } });
    expect(snapshot.navlog.fuelSummary.fuelAboard).toBe(20);
    expect(snapshot.navlog.fuelSummary.usableFuel).toBe(24);
    expect(snapshot.navlog.fuelSummary.estimatedArrivalFuel).toBeGreaterThan(0);
  });

  it("rejects differing cruise altitudes before making weather requests", async () => {
    const draft = baseDraft();
    const route = { ...draft.route, legs: draft.route.legs.map((leg, index) => index === 0 ? leg : { ...leg, cruiseAltitudeFeetMsl: leg.cruiseAltitudeFeetMsl + 500 }) };
    const fetchPoint = vi.fn(async (query: AloftPointQuery) => answer(query, 270, 15));
    await expect(resolveRouteWeather({ ...draft, route }, aircraftProfile(), { fetchPoint }, { departureMetar: metar() })).rejects.toThrow(/one cruise altitude/u);
    expect(fetchPoint).not.toHaveBeenCalled();
  });

  it("rejects unsupported aloft altitude and missing fuel before point requests", async () => {
    const draft = directEastboundDraft();
    const fetchPoint = vi.fn(async (query: AloftPointQuery) => answer(query, 270, 15));
    const unsupported = { ...draft, route: { ...draft.route, legs: draft.route.legs.map((leg) => ({ ...leg, cruiseAltitudeFeetMsl: 2_500 })) } };
    await expect(resolveRouteWeather(unsupported, aircraftProfile(), { fetchPoint }, { departureMetar: metar() })).rejects.toThrow(/3,000 through 53,000/u);
    const missingFuel = { ...draft, fuelInputs: { taxiRunupFuelGallons: 1, reserveFuelGallons: 3 } };
    await expect(resolveRouteWeather(missingFuel, aircraftProfile(), { fetchPoint }, { departureMetar: metar() })).rejects.toThrow(/Fuel aboard is required/u);
    expect(fetchPoint).not.toHaveBeenCalled();
  });

  it("rejects invalid endpoint elevations and duplicate normalized deviation headings in preflight", () => {
    const draft = directEastboundDraft();
    const destination = draft.route.points.at(-1)!;
    if (destination.kind !== "airport") throw new Error("Fixture destination must be an airport.");
    const invalidEndpoint = { ...draft, route: { ...draft.route, points: draft.route.points.map((point) => point.id === destination.id ? { ...destination, elevationFeetMsl: Number.NaN } : point) } };
    expect(() => validateWorksheetPlanningInputs(invalidEndpoint, aircraftProfile())).toThrow(/field elevations must be finite/u);
    const profile = aircraftProfile();
    const first = profile.compassDeviationTable[0]!;
    const duplicateHeading = { ...profile, compassDeviationTable: [...profile.compassDeviationTable, { ...first, magneticHeadingDegrees: first.magneticHeadingDegrees + 360 }] };
    expect(() => validateWorksheetPlanningInputs(draft, duplicateHeading)).toThrow(/duplicate normalized magnetic headings/u);
  });

  it("retains the original point-service failure context", async () => {
    const fetchPoint = vi.fn(async () => { throw new Error("point service unavailable"); });
    await expect(resolveRouteWeather(directEastboundDraft(), aircraftProfile(), { fetchPoint }, { departureMetar: metar() })).rejects.toThrow("point service unavailable");
  });

  it("reports why the departure METAR is ineligible", async () => {
    const stale = { ...metar(), provenance: { ...metar().provenance, cache: { status: "stale_on_error", freshnessRemainingSeconds: 0 } as never } };
    const fetchPoint = vi.fn(async (query: AloftPointQuery) => answer(query, 270, 15));
    await expect(resolveRouteWeather(directEastboundDraft(), aircraftProfile(), { fetchPoint }, { departureMetar: stale })).rejects.toThrow(/cache.*stale/u);
    expect(fetchPoint).not.toHaveBeenCalled();
  });
});
