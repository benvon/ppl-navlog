import { describe, expect, it } from "vitest";
import type { AloftPointAnswer, AloftPointQuery, MetarSuccessPayload } from "../../worker/api/contracts";
import { coordinate } from "../domain/coordinates";
import { calculateGreatCircleDistanceAndInitialCourse } from "../domain/distance-course";
import { pointAlongGreatCircle } from "../domain/distance-course";
import { nauticalMiles } from "../domain/units";
import { planDraft, aircraftProfile } from "../services/storage/__tests__/fixtures";
import { createFullNavlogCalculationEngine } from "./full-navlog-engine";
import { calculateCompletePlan } from "./complete-plan";
import { resolveRouteWeather } from "./route-weather-sampling";

const departure = "2029-09-21T12:00:00.000Z";
const periodEnd = "2029-09-21T18:00:00.000Z";
const asCoordinate = (lat: number, lon: number) => {
  const result = coordinate(lat, lon);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const metar = (windDirection = 270): MetarSuccessPayload => ({
  metar: { icao: "KORD", metarRaw: `METAR KORD 211200Z ${windDirection}10KT`, wind: { raw: `${windDirection}10KT`, directionType: "fixed", directionDegTrue: windDirection, directionVariation: null, speedKt: 10, gustKt: null }, source: "aviationweather", fetchedAt: departure, observedAt: departure },
  provenance: { adapter: "runway-picker", fetchedAt: departure, cache: { status: "upstream_refresh", freshnessRemainingSeconds: 300 } as never }, requestId: "metar-request",
});
const answer = (query: AloftPointQuery, direction: number, speed: number, useUntil = periodEnd, useFrom = departure, issuedAt = departure): AloftPointAnswer => ({
  query, windFromDegTrue: direction, windSpeedKt: speed, temperatureC: null, issuedAt, useFrom, useUntil,
  forecastCycle: "06", product: { region: "us", cycle: "06", cache: { status: "kv_hit", source: "kv", ageSeconds: 60, fetchedAt: "2029-09-21T11:59:00.000Z", expiresAt: departure, freshnessRemainingSeconds: 300, servedAt: departure } }, sources: [{ stationId: "BRL", latitudeDeg: 40.7, longitudeDeg: -91.1, distanceNauticalMiles: 30, horizontalWeight: 1, lowerAltitudeFeet: query.altitudeFeetMsl, upperAltitudeFeet: query.altitudeFeetMsl, verticalWeight: 1, lowerWindFromDegTrue: direction, lowerWindSpeedKt: speed, upperWindFromDegTrue: direction, upperWindSpeedKt: speed, temperatureLowerAltitudeFeet: null, temperatureUpperAltitudeFeet: null, temperatureVerticalWeight: null, temperatureLowerC: null, temperatureUpperC: null }],
  method: "station-level", requestId: `point-${query.latitudeDeg.toFixed(3)}-${query.longitudeDeg.toFixed(3)}`,
});
const endpoints = { departureMetar: metar() };
const routePlanDraft = () => { const draft = planDraft(); return { ...draft, fuelInputs: { ...draft.fuelInputs, fuelAboardGallons: 20 } }; };

async function planWith(draft: ReturnType<typeof planDraft>, directionAt: (query: AloftPointQuery) => number, options: { useUntil?: string | ((query: AloftPointQuery) => string); useFrom?: string | ((query: AloftPointQuery) => string); issuedAt?: string | ((query: AloftPointQuery) => string); speed?: number; profile?: ReturnType<typeof aircraftProfile>; rejectDestination?: boolean } = {}) {
  const queries: AloftPointQuery[] = [];
  const profile = options.profile ?? aircraftProfile();
  const solution = await resolveRouteWeather(draft, profile, {
    async fetchPoint(query) {
      queries.push(query);
      if (options.rejectDestination && Math.abs(query.latitudeDeg - draft.route.points.at(-1)!.coordinate.latitude) < 0.001 && Math.abs(query.longitudeDeg - draft.route.points.at(-1)!.coordinate.longitude) < 0.001) throw new Error("Destination aloft request is forbidden.");
      return answer(query, directionAt(query), options.speed ?? 15, typeof options.useUntil === "function" ? options.useUntil(query) : options.useUntil, typeof options.useFrom === "function" ? options.useFrom(query) : options.useFrom, typeof options.issuedAt === "function" ? options.issuedAt(query) : options.issuedAt);
    },
  }, endpoints);
  const result = await calculateCompletePlan(draft, profile, {
    weather: { resolve: async () => solution.weather },
    calculations: createFullNavlogCalculationEngine(),
  });
  return { queries, solution, result };
}

const navRows = (result: Awaited<ReturnType<typeof planWith>>["result"]) => {
  if (result.status !== "ready") throw new Error(result.message);
  const snapshot = result.calculationSnapshot as { readonly navlog: { readonly rows: readonly { readonly groundspeed: number; readonly estimatedTimeEnroute: number; readonly fuel: number; readonly trueHeading: number; readonly variation: { readonly effectiveValue: number; readonly provenance: { readonly recordedAt: string } }; readonly cumulative: { readonly routeDistance: number; readonly estimatedTimeEnroute: number; readonly enrouteFuel: number }; readonly effectiveWind: { readonly wind: { readonly effectiveValue: { readonly directionFrom: number; readonly speed: number }; readonly provenance: { readonly sourceLabel: string } }; readonly trace: { readonly inputs: readonly unknown[] } }; readonly traces: { readonly magneticVariation: { readonly inputs: readonly { readonly name: string; readonly value: number }[] } }; readonly subleg: { readonly phase: string; readonly routeStartDistance: number; readonly routeEndDistance: number; readonly startingAltitude: number; readonly endingAltitude: number; readonly distance: number; readonly trueCourse: number; readonly start: { readonly latitude: number; readonly longitude: number }; readonly end: { readonly latitude: number; readonly longitude: number } } }[] } };
  return snapshot.navlog.rows;
};
const assertTodCallUsesFixedAirspeedGeometry = (draft: ReturnType<typeof planDraft>, queries: readonly AloftPointQuery[]) => {
  const finalLeg = calculateGreatCircleDistanceAndInitialCourse(draft.route.points.at(-2)!.coordinate, draft.route.points.at(-1)!.coordinate);
  if (!finalLeg.ok) throw new Error(finalLeg.error.message);
  const descentMinutes = (draft.route.legs.at(-1)!.cruiseAltitudeFeetMsl - draft.descentTargetAltitudeFeetMsl.effectiveValue) / aircraftProfile().descentRateFeetPerMinute;
  const fixedTodDistanceFromDestination = aircraftProfile().descentTasKnots * descentMinutes / 60;
  const todOffset = nauticalMiles(finalLeg.value.distance - fixedTodDistanceFromDestination);
  if (!todOffset.ok) throw new Error(todOffset.error.message);
  const expectedTod = pointAlongGreatCircle(draft.route.points.at(-2)!.coordinate, finalLeg.value.initialTrueCourse, todOffset.value);
  if (!expectedTod.ok) throw new Error(expectedTod.error.message);
  expect(queries[3]?.latitudeDeg).toBeCloseTo(expectedTod.value.latitude, 4);
  expect(queries[3]?.longitudeDeg).toBeCloseTo(expectedTod.value.longitude, 4);
};
const assertPilotWaypointQueryLocations = (draft: ReturnType<typeof planDraft>, queries: readonly AloftPointQuery[]) => {
  expect([queries[0]!.latitudeDeg, queries[0]!.longitudeDeg]).toEqual([draft.route.points[0]!.coordinate.latitude, draft.route.points[0]!.coordinate.longitude]);
  expect([queries[2]!.latitudeDeg, queries[2]!.longitudeDeg]).toEqual([draft.route.points[1]!.coordinate.latitude, draft.route.points[1]!.coordinate.longitude]);
};
const assertProgressiveSnapshotEvidence = (result: Awaited<ReturnType<typeof planWith>>["result"]) => {
  const snapshotText = JSON.stringify(result);
  expect(snapshotText).toContain("TOC cumulative climb distance");
  expect(snapshotText).toContain("TOD no-wind placement distance");
  const climbRow = navRows(result).find((row) => row.subleg.phase === "climb");
  expect(JSON.stringify(climbRow?.effectiveWind.trace.inputs)).toContain("departure surface-to-aloft blend fraction");
  expect(JSON.stringify(climbRow?.effectiveWind.trace.inputs)).toContain("BRL lower wind speed");
  expect(JSON.stringify(climbRow?.effectiveWind.trace.inputs)).toContain("BRL upper wind from");
  expect(climbRow?.effectiveWind.trace.inputs).toContainEqual(expect.objectContaining({ name: "winds product cache status", value: "kv_hit" }));
  expect(climbRow?.effectiveWind.trace.inputs).toContainEqual(expect.objectContaining({ name: "winds product cycle", value: "06" }));
  expect(JSON.stringify(climbRow?.effectiveWind.trace.inputs)).toContain("KORD");
};
const assertProgressiveCallContract = (draft: ReturnType<typeof planDraft>, outcome: Awaited<ReturnType<typeof planWith>>) => {
  const { queries, solution, result } = outcome;
  expect(result, JSON.stringify(result)).toMatchObject({ status: "ready" });
  expect(queries).toHaveLength(draft.route.points.length + 1);
  expect(solution.sampledPoints).toHaveLength(draft.route.points.length + 1);
  expect(solution.iterations).toBe(1);
  assertPilotWaypointQueryLocations(draft, queries);
  expect(queries[0]?.altitudeFeetMsl).toBeGreaterThanOrEqual(3_000);
  expect(queries.at(-1)?.altitudeFeetMsl).toBeGreaterThanOrEqual(3_000);
  expect(queries[0]?.plannedUtc).toBe(departure);
  assertTodCallUsesFixedAirspeedGeometry(draft, queries);
  assertProgressiveSnapshotEvidence(result);
};

describe("route waypoint weather sampling", () => {
  it("makes one call at every interval start and generated TOC/TOD in route order", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const outcome = await planWith(draft, () => 270);
    assertProgressiveCallContract(draft, outcome);
  });

  it("uses a point's weather only for intervals starting at that event", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const result = await planWith(draft, (query) => query.longitudeDeg < -88.2 ? 270 : 90);
    const rows = navRows(result.result);

    expect(rows.length).toBeGreaterThan(draft.route.legs.length);
    expect(rows.every((row) => row.effectiveWind.wind.provenance.sourceLabel.includes("point"))).toBe(true);
    expect(rows.some((row) => row.cumulative.estimatedTimeEnroute > row.estimatedTimeEnroute)).toBe(true);
    expect(rows.at(-1)?.cumulative.estimatedTimeEnroute).toBeCloseTo(rows.reduce((sum, row) => sum + row.estimatedTimeEnroute, 0));
    expect(rows.at(-1)?.cumulative.routeDistance).toBeCloseTo(rows.reduce((sum, row) => sum + row.subleg.distance, 0));
    expect(rows.at(-1)?.cumulative.enrouteFuel).toBeCloseTo(rows.reduce((sum, row) => sum + row.fuel, 0));
  });

  it("uses generated TOD weather for the final descent through arrival", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const reference = await planWith(draft, () => 270);
    const todQuery = reference.queries[3]!;
    const destination = draft.route.points.at(-1)!.coordinate;
    const run = async (todDirection: number) => planWith(draft, (query) => {
      const atTod = Math.abs(query.latitudeDeg - todQuery.latitudeDeg) < 0.001 && Math.abs(query.longitudeDeg - todQuery.longitudeDeg) < 0.001;
      const atDestination = Math.abs(query.latitudeDeg - destination.latitude) < 0.001 && Math.abs(query.longitudeDeg - destination.longitude) < 0.001;
      return atTod ? todDirection : atDestination ? 90 : 270;
    });
    const west = await run(270), east = await run(280);
    const finalDescent = (outcome: typeof west) => navRows(outcome.result).filter((row) => row.subleg.phase === "descent");
    const westRows = finalDescent(west), eastRows = finalDescent(east);
    expect(westRows.length).toBeGreaterThan(0);
    westRows.forEach((row) => expect(row.effectiveWind.trace.inputs).toContainEqual(expect.objectContaining({ name: "point request id", value: west.solution.sampledPoints[3]!.requestId })));
    expect(westRows.at(-1)!.effectiveWind.wind.effectiveValue.directionFrom).toBeCloseTo(270, 0);
    expect(eastRows.at(-1)!.effectiveWind.wind.effectiveValue.directionFrom).toBeCloseTo(280, 0);
    expect([eastRows.at(-1)!.groundspeed, eastRows.at(-1)!.estimatedTimeEnroute, eastRows.at(-1)!.fuel])
      .not.toEqual([westRows.at(-1)!.groundspeed, westRows.at(-1)!.estimatedTimeEnroute, westRows.at(-1)!.fuel]);
  });

  it("does not request destination winds and uses the preceding TOD sample through arrival", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const outcome = await planWith(draft, () => 280, { rejectDestination: true });
    expect(outcome.result).toMatchObject({ status: "ready" });
    expect(outcome.queries.some((query) => Math.abs(query.latitudeDeg - draft.route.points.at(-1)!.coordinate.latitude) < 0.001 && Math.abs(query.longitudeDeg - draft.route.points.at(-1)!.coordinate.longitude) < 0.001)).toBe(false);
    const descentRows = navRows(outcome.result).filter((row) => row.subleg.phase === "descent");
    expect(descentRows.length).toBeGreaterThan(0);
    descentRows.forEach((row) => expect(row.effectiveWind.trace.inputs).toContainEqual(expect.objectContaining({ name: "point request id", value: outcome.solution.sampledPoints[3]!.requestId })));
  });

  it("does not require an aloft period at the destination", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const outcome = await planWith(draft, () => 270, { rejectDestination: true, useUntil: periodEnd });
    expect(outcome.result).toMatchObject({ status: "ready" });
    expect(navRows(outcome.result).some((row) => row.subleg.phase === "descent")).toBe(true);
  });

  it("does not let waypoint B weather change the already calculated A-to-B interval", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const run = (checkpointDirection: number) => planWith(draft, (query) => {
      const checkpoint = draft.route.points[1]!.coordinate;
      const atCheckpoint = Math.abs(query.latitudeDeg - checkpoint.latitude) < 0.001 && Math.abs(query.longitudeDeg - checkpoint.longitude) < 0.001;
      return atCheckpoint ? checkpointDirection : 270;
    });
    const calmCheckpoint = await run(270), alteredCheckpoint = await run(180);
    const boundary = calculateGreatCircleDistanceAndInitialCourse(draft.route.points[0]!.coordinate, draft.route.points[1]!.coordinate);
    if (!boundary.ok) throw new Error(boundary.error.message);
    const rowsBeforeB = (result: typeof calmCheckpoint.result) => navRows(result).filter((row) => row.subleg.routeEndDistance <= boundary.value.distance + 1e-6);
    const baselineRows = rowsBeforeB(calmCheckpoint.result), changedRows = rowsBeforeB(alteredCheckpoint.result);
    expect(changedRows).toHaveLength(baselineRows.length);
    expect(changedRows.map((row) => [row.estimatedTimeEnroute, row.effectiveWind.wind.effectiveValue.directionFrom])).toEqual(baselineRows.map((row) => [row.estimatedTimeEnroute, row.effectiveWind.wind.effectiveValue.directionFrom]));
  });

  it("projects generated phase positions correctly across a high-latitude antimeridian leg", async () => {
    const base = routePlanDraft();
    const start = asCoordinate(71, -179), end = asCoordinate(71, 179);
    const geometry = calculateGreatCircleDistanceAndInitialCourse(start, end);
    if (!geometry.ok) throw new Error(geometry.error.message);
    const midpointDistance = nauticalMiles(geometry.value.distance / 2);
    if (!midpointDistance.ok) throw new Error(midpointDistance.error.message);
    const midpoint = pointAlongGreatCircle(start, geometry.value.initialTrueCourse, midpointDistance.value);
    if (!midpoint.ok) throw new Error(midpoint.error.message);
    const points = [{ ...base.route.points[0]!, coordinate: start }, { ...base.route.points.at(-1)!, coordinate: end }];
    const route = { ...base.route, points, legs: [{ ...base.route.legs[0]!, toPointId: points[1]!.id }] };
    const queries: AloftPointQuery[] = [];
    const solution = await resolveRouteWeather({ ...base, departureTimeUtc: departure, route }, aircraftProfile(), { async fetchPoint(query) { queries.push(query); return answer(query, query.longitudeDeg < 0 ? 270 : 180, 15); } }, endpoints);
    const distance = nauticalMiles(5);
    if (!distance.ok) throw new Error(distance.error.message);
    const projected = solution.weather.phaseWindResolver.resolveEffectiveWind({ phase: "descent", start: midpoint.value, courseDegreesTrue: geometry.value.initialTrueCourse, startingAltitudeFeetMsl: 4_500, targetAltitudeFeetMsl: 3_000, estimatedDistanceNauticalMiles: distance.value, iteration: 1 });
    expect(queries).toHaveLength(3);
    expect(projected.ok && projected.value.directionFrom).toBeCloseTo(270, 0);
  });

  it("recalculates course and WMM variation at every generated segment on a curved high-latitude route", async () => {
    const base = routePlanDraft();
    const start = asCoordinate(68, -65), end = asCoordinate(70, -45);
    const geometry = calculateGreatCircleDistanceAndInitialCourse(start, end);
    if (!geometry.ok) throw new Error(geometry.error.message);
    const points = [{ ...base.route.points[0]!, coordinate: start }, { ...base.route.points.at(-1)!, coordinate: end }];
    const route = { ...base.route, points, legs: [{ ...base.route.legs[0]!, toPointId: points[1]!.id }] };
    const { result } = await planWith({ ...base, departureTimeUtc: departure, route }, () => 270, { speed: 0 });
    const rows = navRows(result);
    expect(rows.length).toBeGreaterThan(2);
    const calculatedCourses = rows.map((row) => {
      const course = calculateGreatCircleDistanceAndInitialCourse(asCoordinate(row.subleg.start.latitude, row.subleg.start.longitude), asCoordinate(row.subleg.end.latitude, row.subleg.end.longitude));
      if (!course.ok) throw new Error(course.error.message);
      expect(row.subleg.trueCourse).toBeCloseTo(course.value.initialTrueCourse, 8);
      return row.subleg.trueCourse;
    });
    expect(new Set(calculatedCourses.map((course) => course.toFixed(4))).size).toBeGreaterThan(1);

    const variationLocations = rows.map((row) => {
      const get = (name: string) => row.traces.magneticVariation.inputs.find((input) => input.name === name)?.value;
      return [get("latitude"), get("longitude"), get("altitude")];
    });
    expect(variationLocations.every((location) => location.every((value) => value !== undefined))).toBe(true);
    expect(new Set(variationLocations.map((location) => `${location[0]?.toFixed(5)},${location[1]?.toFixed(5)},${location[2]}`)).size).toBe(rows.length);
    rows.forEach((row) => {
      const rowStartMinutes = row.cumulative.estimatedTimeEnroute - row.estimatedTimeEnroute;
      expect(row.variation.provenance.recordedAt).toBe(new Date(Date.parse(departure) + rowStartMinutes * 60_000).toISOString());
    });
    const decimalYears = rows.map((row) => row.traces.magneticVariation.inputs.find((input) => input.name === "decimal year")?.value);
    expect(decimalYears.every((year, index) => index === 0 || (year !== undefined && year >= (decimalYears[index - 1] ?? year)))).toBe(true);
  });

  it("rejects Worker-unsupported altitude and a departure altitude below field elevation before point requests", async () => {
    const base = routePlanDraft();
    let requests = 0;
    const client = { async fetchPoint(query: AloftPointQuery) { requests += 1; return answer(query, 270, 10); } };
    const tooHigh = { ...base, departureTimeUtc: departure, route: { ...base.route, legs: base.route.legs.map((leg) => ({ ...leg, cruiseAltitudeFeetMsl: 53_001 })) } };
    await expect(resolveRouteWeather(tooHigh, aircraftProfile(), client, endpoints)).rejects.toThrow(/supported selected aloft altitude/i);
    const belowField = { ...base, departureTimeUtc: departure, route: { ...base.route, points: base.route.points.map((point, index) => index === 0 ? { ...point, elevationFeetMsl: 4_000 } : point), legs: base.route.legs.map((leg, index) => index === 0 ? { ...leg, cruiseAltitudeFeetMsl: 3_500 } : leg) } };
    await expect(resolveRouteWeather(belowField, aircraftProfile(), client, endpoints)).rejects.toThrow(/below the departure field elevation/i);
    expect(requests).toBe(0);
  });

  it("rejects an impossible destination descent target and invalid descent TAS before point requests", async () => {
    const base = { ...routePlanDraft(), departureTimeUtc: departure };
    let requests = 0;
    const client = { async fetchPoint(query: AloftPointQuery) { requests += 1; return answer(query, 270, 10); } };
    const aboveCruise = { ...base, descentTargetAltitudeFeetMsl: { ...base.descentTargetAltitudeFeetMsl, effectiveValue: 5_000 } };
    await expect(resolveRouteWeather(aboveCruise, aircraftProfile(), client, endpoints)).rejects.toThrow(/target altitude must be below the final selected cruise altitude/i);
    await expect(resolveRouteWeather(base, { ...aircraftProfile(), descentTasKnots: Number.NaN }, client, endpoints)).rejects.toThrow(/descent true airspeed must be finite and positive/i);
    expect(requests).toBe(0);
  });

  it("uses departure METAR and aloft wind together to place TOC, and aloft wind changes the result", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const run = (direction: number) => resolveRouteWeather(draft, aircraftProfile(), {
      async fetchPoint(query) {
        const isDeparture = Math.abs(query.latitudeDeg - draft.route.points[0]!.coordinate.latitude) < 0.001 && Math.abs(query.longitudeDeg - draft.route.points[0]!.coordinate.longitude) < 0.001;
        return answer(query, isDeparture ? direction : 270, 15);
      },
    }, endpoints);
    const westWind = await run(270), eastWind = await run(90);
    expect(westWind.sampledPoints[1]!.query.latitudeDeg).not.toBeCloseTo(eastWind.sampledPoints[1]!.query.latitudeDeg, 5);
    expect(westWind.sampledPoints[1]!.query.plannedUtc).toBe(eastWind.sampledPoints[1]!.query.plannedUtc);
    expect(westWind.weather.departureMetarPayload?.metar.wind.directionDegTrue).toBe(270);
    expect(eastWind.weather.departureMetarPayload?.metar.wind.directionDegTrue).toBe(270);
  });

  it("carries an unfinished climb through a pilot waypoint and changes weather only after its request", async () => {
    const base = routePlanDraft();
    const draft = { ...base, departureTimeUtc: departure, route: { ...base.route, legs: base.route.legs.map((leg, index) => index === 1 ? { ...leg, cruiseAltitudeFeetMsl: 5_500 } : leg) } };
    const { queries, result } = await planWith(draft, (query) => query.longitudeDeg < -88.2 ? 350 : 10);
    const rows = navRows(result);

    expect(queries).toHaveLength(draft.route.points.length + 1);
    expect(rows.some((row) => row.subleg.phase === "climb")).toBe(true);
    expect(rows.some((row) => row.subleg.phase === "descent")).toBe(true);
    expect(rows.some((row) => row.subleg.phase.startsWith("transition"))).toBe(true);
    expect(result.status === "ready" && result.warnings.join(" ")).toMatch(/starting waypoint/i);
    expect(rows.some((row) => row.subleg.routeEndDistance > row.subleg.routeStartDistance && row.effectiveWind.wind.effectiveValue.speed > 0)).toBe(true);
  });

  it("continues blending departure METAR wind after an early waypoint while still below the aloft sample altitude", async () => {
    const base = routePlanDraft();
    const earlyCheckpoint = { ...base.route.points[1]!, coordinate: asCoordinate(41.95, -87.98) };
    const draft = { ...base, departureTimeUtc: departure, route: { ...base.route, points: [base.route.points[0]!, earlyCheckpoint, base.route.points[2]!] } };
    const run = (checkpointDirection: number) => planWith(draft, (query) =>
      Math.abs(query.latitudeDeg - draft.route.points[0]!.coordinate.latitude) < 0.001
        && Math.abs(query.longitudeDeg - draft.route.points[0]!.coordinate.longitude) < 0.001 ? 10 : checkpointDirection,
    );
    const first = await run(350), changedCheckpoint = await run(340);
    const waypointDistance = calculateGreatCircleDistanceAndInitialCourse(draft.route.points[0]!.coordinate, draft.route.points[1]!.coordinate);
    if (!waypointDistance.ok) throw new Error(waypointDistance.error.message);
    const beforeWaypoint = (result: typeof first.result) => navRows(result)
      .filter((row) => row.subleg.routeEndDistance <= waypointDistance.value.distance + 1e-6)
      .map((row) => [row.estimatedTimeEnroute, row.effectiveWind.wind.effectiveValue.directionFrom]);
    expect(beforeWaypoint(changedCheckpoint.result)).toEqual(beforeWaypoint(first.result));
    const continuedClimb = navRows(first.result).find((row) =>
      row.subleg.phase === "climb"
      && row.subleg.routeStartDistance > 0
      && row.subleg.startingAltitude < 3_000,
    );

    expect(continuedClimb).toBeDefined();
    expect(JSON.stringify(continuedClimb?.effectiveWind.trace.inputs)).toContain("departure surface-to-aloft blend fraction");
    expect(JSON.stringify(continuedClimb?.effectiveWind.trace.inputs)).toContain("KORD");
    expect(continuedClimb?.effectiveWind.wind.effectiveValue.directionFrom).toBeCloseTo(350, 0);
    expect(JSON.stringify(continuedClimb?.effectiveWind.trace.inputs)).toContain("departure blend aloft longitude");
    expect(JSON.stringify(continuedClimb?.effectiveWind.trace.inputs)).toContain("-87.98");
  });

  it("uses the projected climb-start position without adding its already-traveled phase distance", async () => {
    const base = routePlanDraft();
    const draft = { ...base, departureTimeUtc: departure, route: { ...base.route, legs: base.route.legs.map((leg, index) => index === 1 ? { ...leg, cruiseAltitudeFeetMsl: 5_500 } : leg) } };
    const { result } = await planWith(draft, (query) => query.longitudeDeg < -87.91 ? 270 : 90);
    if (result.status !== "ready") throw new Error(result.message);
    const distance = nauticalMiles(5);
    if (!distance.ok) throw new Error(distance.error.message);
    const resolved = result.weather.phaseWindResolver.resolveEffectiveWind({ phase: "transition-climb", start: draft.route.points[1]!.coordinate, courseDegreesTrue: 270, startingAltitudeFeetMsl: 4_500, targetAltitudeFeetMsl: 5_500, estimatedDistanceNauticalMiles: distance.value, iteration: 2 });
    expect(resolved.ok && resolved.value.directionFrom).toBeCloseTo(270, 0);
  });

  it("retains bounded endpoint source provenance in the calculated snapshot", async () => {
    const { result } = await planWith({ ...routePlanDraft(), departureTimeUtc: departure }, () => 270);
    expect(result).toMatchObject({ calculationSnapshot: { weather: { endpointSources: {
      departureMetar: { stationIcao: "KORD", requestId: "metar-request", observedAt: departure, cache: { status: "upstream_refresh" } },
    } } } });
  });

  it("rejects a destination target equal to the final cruise altitude before point requests", async () => {
    const base = routePlanDraft();
    const cruiseAltitude = base.route.legs.at(-1)!.cruiseAltitudeFeetMsl;
    const draft = {
      ...base,
      departureTimeUtc: departure,
      descentTargetAltitudeFeetMsl: { ...base.descentTargetAltitudeFeetMsl, effectiveValue: cruiseAltitude },
    };
    let requests = 0;

    await expect(resolveRouteWeather(draft, aircraftProfile(), { async fetchPoint(query) { requests += 1; return answer(query, 270, 15); } }, endpoints)).rejects.toThrow(/destination target altitude must be below the final selected cruise altitude/i);
    expect(requests).toBe(0);
  });

  it("blocks when the starting point report expires before the completed outgoing interval", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const dependencies = {
      weather: { resolve: async () => (await resolveRouteWeather(draft, aircraftProfile(), { async fetchPoint(query) { return answer(query, query.longitudeDeg < -88.5 ? 270 : 90, 30, new Date(Date.parse(query.plannedUtc) + 1_000).toISOString()); } }, endpoints)).weather },
      calculations: createFullNavlogCalculationEngine(),
    };
    const result = await calculateCompletePlan(draft, aircraftProfile(), dependencies);
    expect(result).toMatchObject({ status: "blocked", reason: "weather-unavailable", message: expect.stringMatching(/completed interval/i) });
  });

  it("does not require interpolation or coverage from a future waypoint report", async () => {
    const base = routePlanDraft();
    const twoPointRoute = { ...base.route, points: [base.route.points[0]!, base.route.points.at(-1)!], legs: [base.route.legs[0]!] };
    const draft = { ...base, departureTimeUtc: departure, route: { ...twoPointRoute, legs: [{ ...twoPointRoute.legs[0]!, toPointId: twoPointRoute.points[1]!.id }] } };
    await expect(planWith(draft, () => 270, {
      useUntil: (query) => query.longitudeDeg === draft.route.points[0]!.coordinate.longitude ? "2029-09-21T12:01:00.000Z" : periodEnd,
      useFrom: () => departure,
      issuedAt: (query) => query.longitudeDeg === draft.route.points[1]!.coordinate.longitude ? new Date(Date.parse(query.plannedUtc) - 60_000).toISOString() : departure,
    })).rejects.toThrow(/completed interval/i);
  });

  it("does not request the next waypoint until the current answer resolves", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const pending: { query: AloftPointQuery; resolve: (answer: AloftPointAnswer) => void }[] = [];
    const operation = resolveRouteWeather(draft, aircraftProfile(), { fetchPoint(query) { return new Promise((resolve) => pending.push({ query, resolve })); } }, endpoints);
    expect(pending).toHaveLength(1);
    for (let index = 0; index < draft.route.points.length + 1; index += 1) {
      pending[index]!.resolve(answer(pending[index]!.query, 270, 15));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(pending).toHaveLength(index + 1 < draft.route.points.length + 1 ? index + 2 : index + 1);
    }
    const result = await operation;
    expect(result.sampledPoints).toHaveLength(draft.route.points.length + 1);
  });

  it("uses returned preceding waypoint wind to choose the following query UTC", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const run = async (secondWaypointDirection: number) => {
      const queries: AloftPointQuery[] = [];
      await resolveRouteWeather(draft, aircraftProfile(), { async fetchPoint(query) {
        queries.push(query);
        const checkpoint = draft.route.points[1]!.coordinate;
        const isCheckpoint = Math.abs(query.latitudeDeg - checkpoint.latitude) < 0.001 && Math.abs(query.longitudeDeg - checkpoint.longitude) < 0.001;
        const direction = isCheckpoint ? secondWaypointDirection : 270;
        return answer(query, direction, 18);
      } }, endpoints);
      return queries;
    };
    const tailwindRun = await run(90);
    const headwindRun = await run(270);
    expect(tailwindRun.at(-1)?.plannedUtc).not.toBe(headwindRun.at(-1)?.plannedUtc);
  });

  it("fails the whole update when any waypoint has no supported point forecast", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    let requests = 0;
    await expect(resolveRouteWeather(draft, aircraftProfile(), { async fetchPoint(query) {
      requests += 1;
      if (query.longitudeDeg < -88) throw new Error("No supported forecast point for waypoint");
      return answer(query, 270, 15);
    } }, endpoints)).rejects.toThrow(/supported forecast point/i);
    expect(requests).toBe(2);
    expect(requests).toBeLessThan(draft.route.points.length);
  });

  it("fails before calling the point API when route waypoint count exceeds the existing plan limit", async () => {
    const base = routePlanDraft();
    const points = Array.from({ length: 28 }, (_, index) => ({
      kind: index === 0 || index === 27 ? "airport" as const : "checkpoint" as const,
      id: `p-${index}`, name: `p-${index}`, icao: index === 0 ? "KORD" : "KJVL",
      coordinate: asCoordinate(40 + index * 0.01, -90 + index * 0.01), elevationFeetMsl: 500,
    }));
    const route = { ...base.route, points, legs: points.slice(0, -1).map((point, index) => ({ id: `l-${index}`, fromPointId: point.id, toPointId: points[index + 1]!.id, cruiseAltitudeFeetMsl: 4_500 })) };
    let requests = 0;
    await expect(resolveRouteWeather({ ...base, departureTimeUtc: departure, route }, aircraftProfile(), { async fetchPoint(query) { requests += 1; return answer(query, 270, 10); } }, endpoints)).rejects.toThrow(/waypoint.*limit/i);
    expect(requests).toBe(0);
  });
});
