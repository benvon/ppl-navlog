import { describe, expect, it, vi } from "vitest";
import type { AloftPointAnswer, AloftPointQuery, MetarSuccessPayload } from "../../worker/api/contracts";
import { coordinate } from "../domain/coordinates";
import { calculateGreatCircleDistanceAndInitialCourse } from "../domain/distance-course";
import { pointAlongGreatCircle } from "../domain/distance-course";
import { nauticalMiles, trueCourse } from "../domain/units";
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
  const snapshot = result.calculationSnapshot as { readonly navlog: { readonly rows: readonly { readonly groundspeed: number; readonly estimatedTimeEnroute: number; readonly fuel: number; readonly fuelFlow: { readonly effectiveValue: number }; readonly trueHeading: number; readonly variation: { readonly effectiveValue: number; readonly provenance: { readonly recordedAt: string } }; readonly cumulative: { readonly routeDistance: number; readonly estimatedTimeEnroute: number; readonly enrouteFuel: number }; readonly effectiveWind: { readonly wind: { readonly effectiveValue: { readonly directionFrom: number; readonly speed: number }; readonly provenance: { readonly sourceLabel: string } }; readonly trace: { readonly inputs: readonly unknown[] } }; readonly traces: { readonly magneticVariation: { readonly inputs: readonly { readonly name: string; readonly value: number }[] } }; readonly subleg: { readonly sourceLegId: string; readonly phase: string; readonly routeStartDistance: number; readonly routeEndDistance: number; readonly startingAltitude: number; readonly endingAltitude: number; readonly distance: number; readonly trueCourse: number; readonly start: { readonly latitude: number; readonly longitude: number }; readonly end: { readonly latitude: number; readonly longitude: number } } }[] } };
  return snapshot.navlog.rows;
};
const assertPilotWaypointQueryLocations = (draft: ReturnType<typeof planDraft>, queries: readonly AloftPointQuery[]) => {
  expect([queries[1]!.latitudeDeg, queries[1]!.longitudeDeg]).toEqual([draft.route.points[1]!.coordinate.latitude, draft.route.points[1]!.coordinate.longitude]);
  expect(queries[0]!.plannedUtc).not.toBe(departure);
};
const assertProgressiveSnapshotEvidence = (result: Awaited<ReturnType<typeof planWith>>["result"]) => {
  const snapshotText = JSON.stringify(result);
  expect(snapshotText).toContain("TOC cumulative climb distance");
  expect(snapshotText).toContain("TOD placement distance using preceding forecast");
  const climbRow = navRows(result).find((row) => row.subleg.phase === "climb");
  expect(climbRow?.effectiveWind.wind.provenance.sourceLabel).toContain("Departure METAR");
  expect(JSON.stringify(climbRow?.effectiveWind.trace.inputs)).not.toContain("aloft");
  expect(JSON.stringify(climbRow?.effectiveWind.trace.inputs)).toContain("KORD");
};
const assertProgressiveCallContract = (draft: ReturnType<typeof planDraft>, outcome: Awaited<ReturnType<typeof planWith>>) => {
  const { queries, solution, result } = outcome;
  expect(result, JSON.stringify(result)).toMatchObject({ status: "ready" });
  expect(queries.length).toBe(draft.route.points.length);
  expect(solution.sampledPoints).toHaveLength(queries.length);
  expect(solution.iterations).toBe(1);
  assertPilotWaypointQueryLocations(draft, queries);
  expect(queries[0]?.altitudeFeetMsl).toBe(draft.route.legs[0]!.cruiseAltitudeFeetMsl);
  expect(queries[1]?.altitudeFeetMsl).toBe(draft.route.legs[0]!.cruiseAltitudeFeetMsl);
  expect(queries.at(-1)?.altitudeFeetMsl).toBe(draft.route.legs.at(-1)!.cruiseAltitudeFeetMsl);
  expect(queries[0]?.plannedUtc).not.toBe(departure);
  assertProgressiveSnapshotEvidence(result);
};

describe("route waypoint weather sampling", () => {
  it("accepts a recent same-station METAR returned from a fresh cache hit", async () => {
    const cachedMetar = {
      ...metar(),
      provenance: { ...metar().provenance, cache: { ...metar().provenance.cache, status: "edge_hit", freshnessRemainingSeconds: 45 } as never },
    };
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const solution = await resolveRouteWeather(draft, aircraftProfile(), {
      async fetchPoint(query) { return answer(query, 270, 15); },
    }, { departureMetar: cachedMetar });

    expect(solution.weather.departureMetarPayload?.requestId).toBe("metar-request");
  });

  it.each([
    ["after planned departure", (source: MetarSuccessPayload) => ({ ...source, metar: { ...source.metar, observedAt: "2029-09-21T12:01:00.000Z" } }), /observed after the planned departure/i],
    ["more than two hours old", (source: MetarSuccessPayload) => ({ ...source, metar: { ...source.metar, observedAt: "2029-09-21T09:59:59.999Z" } }), /more than two hours before planned departure/i],
    ["wrong station", (source: MetarSuccessPayload) => ({ ...source, metar: { ...source.metar, icao: "KJVL" } }), /not the departure airport/i],
    ["stale cache", (source: MetarSuccessPayload) => ({ ...source, provenance: { ...source.provenance, cache: { ...source.provenance.cache, status: "stale_on_error", freshnessRemainingSeconds: 0 } as never } }), /cache.*stale/i],
    ["refreshing stale cache", (source: MetarSuccessPayload) => ({ ...source, provenance: { ...source.provenance, cache: { ...source.provenance.cache, status: "stale_while_refresh", freshnessRemainingSeconds: 30 } as never } }), /cache.*stale/i],
    ["missing observation time", (source: MetarSuccessPayload) => ({ ...source, metar: { ...source.metar, observedAt: null } }), /no observation time/i],
    ["unusable wind", (source: MetarSuccessPayload) => ({ ...source, metar: { ...source.metar, wind: { ...source.metar.wind, directionType: "variable" as const, directionDegTrue: null } } }), /usable fixed or calm wind/i],
  ])("reports why a departure METAR is ineligible: %s", async (_case, transform, expected) => {
    const source = transform(metar());
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };

    await expect(resolveRouteWeather(draft, aircraftProfile(), {
      async fetchPoint(query) { return answer(query, 270, 15); },
    }, { departureMetar: source })).rejects.toThrow(expected);
  });

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
    expect(rows[0]?.effectiveWind.wind.provenance.sourceLabel).toContain("Departure METAR");
    expect(rows.slice(1).every((row) => row.effectiveWind.wind.provenance.sourceLabel.includes("point"))).toBe(true);
    expect(rows.some((row) => row.cumulative.estimatedTimeEnroute > row.estimatedTimeEnroute)).toBe(true);
    expect(rows.at(-1)?.cumulative.estimatedTimeEnroute).toBeCloseTo(rows.reduce((sum, row) => sum + row.estimatedTimeEnroute, 0));
    expect(rows.at(-1)?.cumulative.routeDistance).toBeCloseTo(rows.reduce((sum, row) => sum + row.subleg.distance, 0));
    expect(rows.at(-1)?.cumulative.enrouteFuel).toBeCloseTo(rows.reduce((sum, row) => sum + row.fuel, 0));
  });

  it("uses the latest pre-TOD forecast for placement and the TOD sample for descent", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const run = async (todDirection: number) => planWith(draft, (query) => {
      const atDeparture = Math.abs(query.latitudeDeg - draft.route.points[0]!.coordinate.latitude) < 0.001 && Math.abs(query.longitudeDeg - draft.route.points[0]!.coordinate.longitude) < 0.001;
      return atDeparture ? 270 : todDirection;
    });
    const west = await run(270), east = await run(280);
    const finalDescent = (outcome: typeof west) => navRows(outcome.result).filter((row) => row.subleg.phase === "descent");
    const westRows = finalDescent(west), eastRows = finalDescent(east);
    expect(westRows.length).toBeGreaterThan(0);
    const precedingForecastId = west.solution.sampledPoints.at(-1)!.requestId;
    westRows.forEach((row) => expect(row.effectiveWind.trace.inputs).toContainEqual(expect.objectContaining({ name: "point request id", value: precedingForecastId })));
    expect(westRows.at(-1)!.effectiveWind.wind.effectiveValue.directionFrom).toBeCloseTo(270, 0);
    expect(eastRows.at(-1)!.effectiveWind.wind.effectiveValue.directionFrom).toBeCloseTo(280, 0);
    expect(eastRows.at(-1)!.subleg.routeStartDistance).not.toBeCloseTo(westRows.at(-1)!.subleg.routeStartDistance, 6);
  });

  it("ends the final descent at pattern altitude at the airport", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const { result } = await planWith(draft, () => 270, { speed: 0 });
    const rows = navRows(result);
    const endDistance = rows.at(-1)!.subleg.routeEndDistance;
    const destinationDistance = draft.route.legs.reduce((sum, _leg, index) => {
      const segment = calculateGreatCircleDistanceAndInitialCourse(draft.route.points[index]!.coordinate, draft.route.points[index + 1]!.coordinate);
      if (!segment.ok) throw new Error(segment.error.message);
      return sum + segment.value.distance;
    }, 0);

    expect(destinationDistance - endDistance).toBeCloseTo(0, 1);
    expect(rows.at(-1)!.subleg.phase).toBe("descent");
    expect(Math.abs(rows.at(-1)!.subleg.endingAltitude - draft.descentTargetAltitudeFeetMsl.effectiveValue)).toBeLessThanOrEqual(50);
    if (result.status !== "ready") throw new Error(result.message);
    const snapshot = result.calculationSnapshot as { readonly phaseAllocation: { readonly navlogEndpoint: { readonly kind: string; readonly routeDistanceNauticalMiles: number } } };
    expect(snapshot.phaseAllocation.navlogEndpoint.kind).toBe("pattern-altitude-airport");
    expect(snapshot.phaseAllocation.navlogEndpoint.routeDistanceNauticalMiles).toBeCloseTo(endDistance, 6);
  });

  it.each([270, 90])("uses descent groundspeed to place TOD with wind direction %i and requests TOD weather", async (direction) => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const { queries, result } = await planWith(draft, () => direction, { speed: 30 });
    const rows = navRows(result);
    const todRow = rows.find((row) => row.subleg.phase === "descent");
    expect(todRow).toBeDefined();
    expect(queries.some((query) => Math.abs(query.latitudeDeg - todRow!.subleg.start.latitude) < 0.001 && Math.abs(query.longitudeDeg - todRow!.subleg.start.longitude) < 0.001)).toBe(true);
    expect(Math.abs(rows.at(-1)!.subleg.endingAltitude - draft.descentTargetAltitudeFeetMsl.effectiveValue)).toBeLessThanOrEqual(50);
    expect(rows.at(-1)!.subleg.routeEndDistance).toBeCloseTo(rows.at(-1)!.cumulative.routeDistance, 6);
  });

  it("uses candidate TOD-to-airport course for a long final leg with crosswind", async () => {
    const base = routePlanDraft();
    const start = base.route.points[0]!;
    const destination = base.route.points.at(-1)!;
    const distance = nauticalMiles(500);
    const course = trueCourse(90);
    if (!distance.ok || !course.ok) throw new Error("Could not build the long route fixture.");
    const endpoint = pointAlongGreatCircle(start.coordinate, course.value, distance.value);
    if (!endpoint.ok) throw new Error(endpoint.error.message);
    const points = [start, { ...destination, coordinate: endpoint.value }];
    const route = { ...base.route, points, legs: [{ ...base.route.legs[0]!, toPointId: points[1]!.id }] };
    const outcome = await planWith({ ...base, departureTimeUtc: departure, route }, () => 0, { speed: 45 });
    const rows = navRows(outcome.result);
    expect(outcome.result, JSON.stringify(outcome.result)).toMatchObject({ status: "ready" });
    expect(Math.abs(rows.at(-1)!.subleg.endingAltitude - base.descentTargetAltitudeFeetMsl.effectiveValue)).toBeLessThanOrEqual(50);
    expect(outcome.queries).toHaveLength(2);
    const descentStart = rows.find((row) => row.subleg.phase === "descent")!.subleg.start;
    expect(outcome.queries.some((query) => Math.abs(query.latitudeDeg - descentStart.latitude) < 0.001 && Math.abs(query.longitudeDeg - descentStart.longitude) < 0.001)).toBe(true);
  });

  it("calculates TOD at the final leg origin using final-leg descent geometry", async () => {
    const base = routePlanDraft();
    const checkpoint = base.route.points[1]!;
    const descentDistance = (base.route.legs.at(-1)!.cruiseAltitudeFeetMsl - base.descentTargetAltitudeFeetMsl.effectiveValue)
      / aircraftProfile().descentRateFeetPerMinute * aircraftProfile().descentTasKnots / 60;
    const course = trueCourse(90);
    const distance = nauticalMiles(descentDistance);
    if (!course.ok || !distance.ok) throw new Error("Could not build final-leg boundary fixture.");
    const end = pointAlongGreatCircle(checkpoint.coordinate, course.value, distance.value);
    if (!end.ok) throw new Error(end.error.message);
    const destination = { ...base.route.points.at(-1)!, coordinate: end.value };
    const route = { ...base.route, points: [base.route.points[0]!, checkpoint, destination], legs: [base.route.legs[0]!, { ...base.route.legs[1]!, toPointId: destination.id }] };
    const outcome = await planWith({ ...base, departureTimeUtc: departure, route }, () => 270, { speed: 0 });
    expect(outcome.result).toMatchObject({ status: "ready" });
    const descent = navRows(outcome.result).find((row) => row.subleg.phase === "descent")!;
    expect(descent.subleg.routeStartDistance).toBeCloseTo(navRows(outcome.result).filter((row) => row.subleg.sourceLegId === route.legs[0]!.id).at(-1)!.subleg.routeEndDistance, 4);
  });

  it("uses the TOD point forecast for descent", async () => {
    const base = routePlanDraft();
    const points = [base.route.points[0]!, base.route.points.at(-1)!];
    const route = { ...base.route, points, legs: [{ ...base.route.legs[0]!, toPointId: points[1]!.id }] };
    const outcome = await planWith({ ...base, departureTimeUtc: departure, route }, () => 270, { speed: 0 });
    const descentRows = navRows(outcome.result).filter((row) => row.subleg.phase === "descent");
    expect(descentRows.length).toBeGreaterThan(0);
    const preceding = outcome.solution.sampledPoints.at(-1)!;
    expect(descentRows[0]!.effectiveWind.trace.inputs).toContainEqual(expect.objectContaining({ name: "point request id", value: preceding.requestId }));
    expect(outcome.queries.some((query) => Math.abs(query.latitudeDeg - descentRows[0]!.subleg.start.latitude) < 0.001 && Math.abs(query.longitudeDeg - descentRows[0]!.subleg.start.longitude) < 0.001)).toBe(true);
  });

  it.each([0.9, 1, 1.1])("collapses only a direct-route cruise interval of %i calculated minutes", async (cruiseMinutes) => {
    const base = routePlanDraft();
    const start = base.route.points[0]!;
    const destination = base.route.points.at(-1)!;
    const directRoute = (distance: number) => {
      const checkedDistance = nauticalMiles(distance), course = trueCourse(90);
      if (!checkedDistance.ok || !course.ok) throw new Error("Could not build the direct-route fixture.");
      const endpoint = pointAlongGreatCircle(start.coordinate, course.value, checkedDistance.value);
      if (!endpoint.ok) throw new Error(endpoint.error.message);
      const points = [start, { ...destination, coordinate: endpoint.value }];
      return { ...base.route, points, legs: [{ ...base.route.legs[0]!, toPointId: points[1]!.id }] };
    };

    // Use a normal direct plan to measure the calculated TOC, descent distance,
    // and cruise groundspeed, then place TOD at the requested time boundary.
    const longRoute = directRoute(35);
    const calibration = await planWith({ ...base, departureTimeUtc: departure, route: longRoute }, () => 270, { speed: 15 });
    const calibrationRows = navRows(calibration.result);
    const tocDistance = calibrationRows.filter((row) => row.subleg.phase === "climb").at(-1)!.subleg.routeEndDistance;
    const descentRows = calibrationRows.filter((row) => row.subleg.phase === "descent");
    const descentDistance = descentRows.reduce((sum, row) => sum + row.subleg.distance, 0);
    const cruiseGroundspeed = calibrationRows.find((row) => row.subleg.phase === "cruise")!.groundspeed;
    const normalDescentTime = descentRows.reduce((sum, row) => sum + row.estimatedTimeEnroute, 0);
    const normalDescentFuel = descentRows.reduce((sum, row) => sum + row.fuel, 0);
    let targetDistance = tocDistance + descentDistance + cruiseGroundspeed * cruiseMinutes / 60;
    let outcome = await planWith({ ...base, departureTimeUtc: departure, route: directRoute(targetDistance) }, () => 270, { speed: 15 });
    // Great-circle endpoint encoding introduces tiny distance differences.
    // Tune the fixture against the planner's unrounded result for an exact 1m case.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const measuredRows = navRows(outcome.result).filter((row) => row.subleg.phase === "cruise");
      if (measuredRows.length === 0) break;
      const measuredMinutes = measuredRows.reduce((sum, row) => sum + row.estimatedTimeEnroute, 0);
      const measuredSpeed = measuredRows.at(-1)!.groundspeed;
      if (Math.abs(measuredMinutes - cruiseMinutes) < 1e-9) break;
      targetDistance -= (measuredMinutes - cruiseMinutes) * measuredSpeed / 60;
      outcome = await planWith({ ...base, departureTimeUtc: departure, route: directRoute(targetDistance) }, () => 270, { speed: 15 });
    }
    const rows = navRows(outcome.result);
    const cruiseRows = rows.filter((row) => row.subleg.phase === "cruise");
    const descent = rows.filter((row) => row.subleg.phase === "descent");

    expect(outcome.result, JSON.stringify(outcome.result)).toMatchObject({ status: "ready" });
    expect(outcome.queries).toHaveLength(2);
    expect(descent.length).toBeGreaterThan(0);
    expect(Math.abs(rows.at(-1)!.subleg.endingAltitude - base.descentTargetAltitudeFeetMsl.effectiveValue)).toBeLessThanOrEqual(50);
    expect(rows.at(-1)!.cumulative.estimatedTimeEnroute).toBeGreaterThan(0);
    expect(rows.at(-1)!.cumulative.enrouteFuel).toBeGreaterThan(0);
    if (cruiseMinutes <= 1) {
      expect(cruiseRows).toHaveLength(0);
      expect(descent[0]!.subleg.routeStartDistance).toBeCloseTo(rows.filter((row) => row.subleg.phase === "climb").at(-1)!.subleg.routeEndDistance, 6);
      expect(descent.reduce((sum, row) => sum + row.estimatedTimeEnroute, 0)).toBeGreaterThan(normalDescentTime);
      expect(descent.reduce((sum, row) => sum + row.estimatedTimeEnroute, 0)).toBeCloseTo(descent.reduce((sum, row) => sum + row.subleg.distance / row.groundspeed * 60, 0), 6);
      expect(descent.reduce((sum, row) => sum + row.fuel, 0)).toBeCloseTo(descent.reduce((sum, row) => sum + row.fuelFlow.effectiveValue * row.estimatedTimeEnroute / 60, 0), 6);
      expect(descent.reduce((sum, row) => sum + row.fuel, 0)).toBeGreaterThan(normalDescentFuel);
    } else {
      expect(cruiseRows.reduce((sum, row) => sum + row.estimatedTimeEnroute, 0)).toBeGreaterThan(1);
    }
  });

  it("fails clearly when backward TOD overlaps the active climb", async () => {
    const base = routePlanDraft();
    const start = base.route.points[0]!;
    const destination = base.route.points.at(-1)!;
    const distance = nauticalMiles(11);
    const course = trueCourse(90);
    if (!distance.ok || !course.ok) throw new Error("Could not build the short route fixture.");
    const endpoint = pointAlongGreatCircle(start.coordinate, course.value, distance.value);
    if (!endpoint.ok) throw new Error(endpoint.error.message);
    const points = [start, { ...destination, coordinate: endpoint.value }];
    const route = { ...base.route, points, legs: [{ ...base.route.legs[0]!, toPointId: points[1]!.id }] };
    const fetchPoint = vi.fn(async (query: AloftPointQuery) => answer(query, 90, 20));
    await expect(resolveRouteWeather({ ...base, departureTimeUtc: departure, route }, aircraftProfile(), { fetchPoint }, endpoints)).rejects.toThrow(/route is too short.*TOC.*TOD/i);
    expect(fetchPoint).not.toHaveBeenCalled();
  });

  it("rejects a wind-induced TOC/TOD overlap after weather changes nominal separation", async () => {
    const base = routePlanDraft();
    const start = base.route.points[0]!;
    const destination = base.route.points.at(-1)!;
    const distance = nauticalMiles(20);
    const course = trueCourse(90);
    if (!distance.ok || !course.ok) throw new Error("Could not build the direct-route fixture.");
    const endpoint = pointAlongGreatCircle(start.coordinate, course.value, distance.value);
    if (!endpoint.ok) throw new Error(endpoint.error.message);
    const points = [start, { ...destination, coordinate: endpoint.value }];
    const route = { ...base.route, points, legs: [{ ...base.route.legs[0]!, toPointId: points[1]!.id }] };
    const fetchPoint = vi.fn(async (query: AloftPointQuery) => answer(query, 270, 70));
    await expect(resolveRouteWeather({ ...base, departureTimeUtc: departure, route }, aircraftProfile(), { fetchPoint }, endpoints)).rejects.toThrow(/top of descent meets or precedes top of climb/i);
    expect(fetchPoint).toHaveBeenCalledTimes(1);
  });

  it("ends a one-leg route at the airport with the pattern-altitude target", async () => {
    const base = routePlanDraft();
    const points = [base.route.points[0]!, base.route.points.at(-1)!];
    const route = { ...base.route, points, legs: [{ ...base.route.legs[0]!, toPointId: points[1]!.id }] };
    const outcome = await planWith({ ...base, departureTimeUtc: departure, route }, () => 270, { speed: 15 });
    expect(outcome.result, JSON.stringify(outcome.result)).toMatchObject({ status: "ready" });
    const rows = navRows(outcome.result);
    expect(rows.some((row) => row.subleg.phase === "climb")).toBe(true);
    expect(rows.some((row) => row.subleg.phase === "descent")).toBe(true);
    expect(rows.at(-1)!.subleg.routeEndDistance).toBeCloseTo(rows.at(-1)!.cumulative.routeDistance, 6);
    expect(Math.abs(rows.at(-1)!.subleg.endingAltitude - base.descentTargetAltitudeFeetMsl.effectiveValue)).toBeLessThanOrEqual(50);
  });

  it("rejects a short route that cannot fit its climb and descent", async () => {
    const base = routePlanDraft();
    const start = base.route.points[0]!;
    const destination = base.route.points.at(-1)!;
    const shortDistance = nauticalMiles(5);
    if (!shortDistance.ok) throw new Error(shortDistance.error.message);
    const eastCourse = trueCourse(90);
    if (!eastCourse.ok) throw new Error(eastCourse.error.message);
    const shortEndpoint = pointAlongGreatCircle(start.coordinate, eastCourse.value, shortDistance.value);
    if (!shortEndpoint.ok) throw new Error(shortEndpoint.error.message);
    const points = [start, { ...destination, coordinate: shortEndpoint.value }];
    const route = { ...base.route, points, legs: [{ ...base.route.legs[0]!, toPointId: points[1]!.id }] };
    await expect(resolveRouteWeather({ ...base, departureTimeUtc: departure, route }, aircraftProfile(), {
      async fetchPoint(query) { return answer(query, 270, 15); },
    }, endpoints)).rejects.toThrow(/too short|cannot reach|cannot fit|available route/i);
  });

  it("does not request destination winds and uses the preceding TOD sample through arrival", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const outcome = await planWith(draft, () => 280, { rejectDestination: true });
    expect(outcome.result).toMatchObject({ status: "ready" });
    expect(outcome.queries.some((query) => Math.abs(query.latitudeDeg - draft.route.points.at(-1)!.coordinate.latitude) < 0.001 && Math.abs(query.longitudeDeg - draft.route.points.at(-1)!.coordinate.longitude) < 0.001)).toBe(false);
    const descentRows = navRows(outcome.result).filter((row) => row.subleg.phase === "descent");
    expect(descentRows.length).toBeGreaterThan(0);
    const precedingForecastId = outcome.solution.sampledPoints.at(-1)!.requestId;
    descentRows.forEach((row) => expect(row.effectiveWind.trace.inputs).toContainEqual(expect.objectContaining({ name: "point request id", value: precedingForecastId })));
  });

  it("does not require an aloft period at the destination", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const outcome = await planWith(draft, () => 270, { rejectDestination: true, useUntil: periodEnd });
    expect(outcome.result).toMatchObject({ status: "ready" });
    expect(navRows(outcome.result).some((row) => row.subleg.phase === "descent")).toBe(true);
  });

  it("samples TOD wind for descent and warns when its required rate exceeds 150%", async () => {
    const base = routePlanDraft();
    const start = base.route.points[0]!;
    const distance = nauticalMiles(100);
    const course = trueCourse(90);
    if (!distance.ok || !course.ok) throw new Error("Could not build the direct route.");
    const projected = pointAlongGreatCircle(start.coordinate, course.value, distance.value);
    if (!projected.ok) throw new Error(projected.error.message);
    const destination = { ...base.route.points.at(-1)!, coordinate: projected.value };
    const route = { ...base.route, points: [start, destination], legs: [{ ...base.route.legs[0]!, toPointId: destination.id }] };
    const draft = { ...base, departureTimeUtc: departure, route };
    const queries: AloftPointQuery[] = [];
    const solution = await resolveRouteWeather(draft, aircraftProfile(), { async fetchPoint(query) {
      queries.push(query);
      return answer(query, queries.length === 2 ? 270 : 90, 50);
    } }, endpoints);
    const result = await calculateCompletePlan(draft, aircraftProfile(), {
      weather: { resolve: async () => solution.weather }, calculations: createFullNavlogCalculationEngine(),
    });
    expect(result).toMatchObject({ status: "ready", warnings: [expect.stringMatching(/150%/)] });
    const descent = navRows(result).filter((row) => row.subleg.phase === "descent");
    expect(queries).toHaveLength(2);
    expect(queries[1]!.latitudeDeg).toBeCloseTo(descent[0]!.subleg.start.latitude, 7);
    expect(queries[1]!.longitudeDeg).toBeCloseTo(descent[0]!.subleg.start.longitude, 7);
    expect(descent[0]!.effectiveWind.trace.inputs).toContainEqual(expect.objectContaining({ name: "point request id", value: solution.sampledPoints[1]!.requestId }));
    expect(descent.at(-1)!.subleg.endingAltitude).toBeCloseTo(draft.descentTargetAltitudeFeetMsl.effectiveValue, 1);
    if (result.status !== "ready") throw new Error(result.message);
    const snapshot = result.calculationSnapshot as { readonly phaseAllocation: { readonly boundaries: readonly { readonly kind: string; readonly placementTrace: readonly { readonly name: string; readonly value: number }[] }[] } };
    const todTrace = snapshot.phaseAllocation.boundaries.find((boundary) => boundary.kind === "top-of-descent")!.placementTrace;
    expect(todTrace).toContainEqual(expect.objectContaining({ name: "TOD placement descent rate", value: aircraftProfile().descentRateFeetPerMinute }));
    expect(todTrace).toContainEqual(expect.objectContaining({ name: "TOD required descent rate", value: expect.any(Number) }));
    expect(todTrace.find((entry) => entry.name === "TOD required descent rate")!.value).toBeGreaterThan(aircraftProfile().descentRateFeetPerMinute * 1.5);
  });

  it("rejects a TOD forecast that does not cover the TOD request time", async () => {
    const base = routePlanDraft();
    const points = [base.route.points[0]!, base.route.points.at(-1)!];
    const route = { ...base.route, points, legs: [{ ...base.route.legs[0]!, toPointId: points[1]!.id }] };
    const draft = { ...base, departureTimeUtc: departure, route };
    let requests = 0;
    await expect(resolveRouteWeather(draft, aircraftProfile(), { async fetchPoint(query) {
      requests += 1;
      return answer(query, 270, 15, requests === 2 ? query.plannedUtc : periodEnd);
    } }, endpoints)).rejects.toThrow(/does not cover its planned waypoint UTC/i);
    expect(requests).toBe(2);
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
    expect(queries).toHaveLength(2);
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
    const noClimb = { ...base, departureTimeUtc: departure, route: { ...base.route, points: base.route.points.map((point, index) => index === 0 ? { ...point, elevationFeetMsl: 4_500 } : point) } };
    await expect(resolveRouteWeather(noClimb, aircraftProfile(), client, endpoints)).rejects.toThrow(/must be above the departure field elevation/i);
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

  it("uses departure METAR alone to place TOC regardless of aloft answers", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const run = (direction: number) => resolveRouteWeather(draft, aircraftProfile(), {
      async fetchPoint(query) {
        const isDeparture = Math.abs(query.latitudeDeg - draft.route.points[0]!.coordinate.latitude) < 0.001 && Math.abs(query.longitudeDeg - draft.route.points[0]!.coordinate.longitude) < 0.001;
        return answer(query, isDeparture ? direction : 270, 15);
      },
    }, endpoints);
    const westWind = await run(270), eastWind = await run(90);
    expect(westWind.sampledPoints[0]!.query.latitudeDeg).toBeCloseTo(eastWind.sampledPoints[0]!.query.latitudeDeg, 5);
    expect(westWind.sampledPoints[1]!.query.plannedUtc).toBe(eastWind.sampledPoints[1]!.query.plannedUtc);
    expect(westWind.weather.departureMetarPayload?.metar.wind.directionDegTrue).toBe(270);
    expect(eastWind.weather.departureMetarPayload?.metar.wind.directionDegTrue).toBe(270);
  });

  it("carries an unfinished climb through a pilot waypoint and changes weather only after its request", async () => {
    const base = routePlanDraft();
    const draft = { ...base, departureTimeUtc: departure, route: { ...base.route, legs: base.route.legs.map((leg, index) => index === 1 ? { ...leg, cruiseAltitudeFeetMsl: 5_500 } : leg) } };
    const { queries, result } = await planWith(draft, (query) => query.longitudeDeg < -88.2 ? 350 : 10);
    const rows = navRows(result);

    expect(queries).toHaveLength(draft.route.points.length);
    expect(rows.some((row) => row.subleg.phase === "climb")).toBe(true);
    expect(rows.some((row) => row.subleg.phase === "descent")).toBe(true);
    expect(rows.some((row) => row.subleg.phase.startsWith("transition"))).toBe(true);
    expect(result.status === "ready" && result.warnings).toEqual([]);
    expect(rows.some((row) => row.subleg.routeEndDistance > row.subleg.routeStartDistance && row.effectiveWind.wind.effectiveValue.speed > 0)).toBe(true);
  });

  it("ends an accepted climb at the pilot-entered waypoint altitude", async () => {
    const base = routePlanDraft();
    const start = base.route.points[0]!;
    const checkpoint = base.route.points[1]!;
    const destination = base.route.points.at(-1)!;
    const course = trueCourse(90);
    const checkpointDistance = nauticalMiles(10.8);
    const destinationDistance = nauticalMiles(35);
    if (!course.ok || !checkpointDistance.ok || !destinationDistance.ok) throw new Error("Could not build the waypoint-altitude fixture.");
    const checkpointCoordinate = pointAlongGreatCircle(start.coordinate, course.value, checkpointDistance.value);
    const destinationCoordinate = pointAlongGreatCircle(start.coordinate, course.value, destinationDistance.value);
    if (!checkpointCoordinate.ok || !destinationCoordinate.ok) throw new Error("Could not project waypoint coordinates.");
    const points = [start, { ...checkpoint, coordinate: checkpointCoordinate.value }, { ...destination, coordinate: destinationCoordinate.value }];
    const route = {
      ...base.route,
      points,
      legs: [
        { ...base.route.legs[0]!, toPointId: points[1]!.id, cruiseAltitudeFeetMsl: 4_500 },
        { ...base.route.legs[1]!, fromPointId: points[1]!.id, toPointId: points[2]!.id, cruiseAltitudeFeetMsl: 4_500 },
      ],
    };
    const { queries, result } = await planWith({ ...base, departureTimeUtc: departure, route }, () => 270, { speed: 0 });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ready" });
    const rows = navRows(result);
    const climbRows = rows.filter((row) => row.subleg.phase === "climb");
    expect(climbRows.length).toBeGreaterThan(0);
    expect(climbRows.every((row) => row.subleg.routeEndDistance <= checkpointDistance.value + 1e-6)).toBe(true);
    const finalClimb = climbRows.at(-1)!;
    expect(finalClimb.subleg.endingAltitude).toBe(4_500);
    const nextLegRows = rows.filter((row) => row.subleg.sourceLegId === route.legs[1]!.id);
    expect(nextLegRows[0]!.subleg.startingAltitude).toBe(4_500);
    expect(queries.filter((query) => Math.abs(query.latitudeDeg - checkpointCoordinate.value.latitude) < 0.001 && Math.abs(query.longitudeDeg - checkpointCoordinate.value.longitude) < 0.001)).toHaveLength(1);
    expect(queries.find((query) => Math.abs(query.latitudeDeg - checkpointCoordinate.value.latitude) < 0.001 && Math.abs(query.longitudeDeg - checkpointCoordinate.value.longitude) < 0.001)?.altitudeFeetMsl).toBe(4_500);
    if (result.status !== "ready") throw new Error(result.message);
    const snapshot = result.calculationSnapshot as { readonly phaseAllocation: { readonly boundaries: readonly { readonly kind: string; readonly routeDistanceNauticalMiles: number }[] } };
    const toc = snapshot.phaseAllocation.boundaries.find((boundary) => boundary.kind === "top-of-climb");
    expect(toc?.routeDistanceNauticalMiles).toBeCloseTo(checkpointDistance.value, 6);
  });

  it("queries a supported aloft altitude at TOD after accepting a near-3000-foot checkpoint", async () => {
    const base = routePlanDraft();
    const start = base.route.points[0]!;
    const checkpoint = base.route.points[1]!;
    const destination = base.route.points.at(-1)!;
    const course = trueCourse(90);
    const checkpointDistance = nauticalMiles(6.6);
    const destinationDistance = nauticalMiles(35);
    if (!course.ok || !checkpointDistance.ok || !destinationDistance.ok) throw new Error("Could not build the low-altitude fixture.");
    const checkpointPosition = pointAlongGreatCircle(start.coordinate, course.value, checkpointDistance.value);
    const destinationPosition = pointAlongGreatCircle(start.coordinate, course.value, destinationDistance.value);
    if (!checkpointPosition.ok || !destinationPosition.ok) throw new Error("Could not project the low-altitude fixture.");
    const points = [start, { ...checkpoint, coordinate: checkpointPosition.value }, { ...destination, coordinate: destinationPosition.value }];
    const route = { ...base.route, points, legs: [
      { ...base.route.legs[0]!, toPointId: checkpoint.id, cruiseAltitudeFeetMsl: 3_000 },
      { ...base.route.legs[1]!, fromPointId: checkpoint.id, toPointId: destination.id, cruiseAltitudeFeetMsl: 3_000 },
    ] };
    const outcome = await planWith({ ...base, departureTimeUtc: departure, route }, () => 270, { speed: 0 });
    const tod = outcome.queries.at(-1)!;
    expect(outcome.result).toMatchObject({ status: "ready" });
    expect(tod.altitudeFeetMsl).toBe(3_000);
  });

  it("rejects an early waypoint where the selected inbound altitude cannot be reached", async () => {
    const base = routePlanDraft();
    const earlyCheckpoint = { ...base.route.points[1]!, coordinate: asCoordinate(41.95, -87.98) };
    const draft = { ...base, departureTimeUtc: departure, route: { ...base.route, points: [base.route.points[0]!, earlyCheckpoint, base.route.points[2]!] } };
    await expect(planWith(draft, () => 350)).rejects.toThrow(/selected inbound altitude cannot be reached within 50 ft at waypoint 2/i);
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
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error(result.message);
    expect(result.weather.warnings).toEqual([]);
    expect(result.weather.provenance).toMatchObject({ source: "progressive-route-point-winds", eventCount: expect.any(Number) });
    expect(result.calculationSnapshot).toMatchObject({ phaseAllocation: { warnings: [] } });
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

  it("uses a forecast valid at the starting point even when it expires during the outgoing interval", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const dependencies = {
      weather: { resolve: async () => (await resolveRouteWeather(draft, aircraftProfile(), { async fetchPoint(query) { return answer(query, query.longitudeDeg < -88.5 ? 270 : 90, 30, new Date(Date.parse(query.plannedUtc) + 1_000).toISOString()); } }, endpoints)).weather },
      calculations: createFullNavlogCalculationEngine(),
    };
    const result = await calculateCompletePlan(draft, aircraftProfile(), dependencies);
    expect(result).toMatchObject({ status: "ready" });
  });

  it("validates a forecast at each requested point rather than through its outgoing row", async () => {
    const base = routePlanDraft();
    const twoPointRoute = { ...base.route, points: [base.route.points[0]!, base.route.points.at(-1)!], legs: [base.route.legs[0]!] };
    const draft = { ...base, departureTimeUtc: departure, route: { ...twoPointRoute, legs: [{ ...twoPointRoute.legs[0]!, toPointId: twoPointRoute.points[1]!.id }] } };
    const outcome = await planWith(draft, () => 270, {
      useUntil: (query) => query.longitudeDeg === draft.route.points[0]!.coordinate.longitude ? "2029-09-21T12:01:00.000Z" : periodEnd,
      useFrom: () => departure,
      issuedAt: (query) => query.longitudeDeg === draft.route.points[1]!.coordinate.longitude ? new Date(Date.parse(query.plannedUtc) - 60_000).toISOString() : departure,
    });
    expect(outcome.result).toMatchObject({ status: "ready" });
  });

  it("does not request the next waypoint until the current answer resolves", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    const pending: { query: AloftPointQuery; resolve: (answer: AloftPointAnswer) => void }[] = [];
    const operation = resolveRouteWeather(draft, aircraftProfile(), { fetchPoint(query) { return new Promise((resolve) => pending.push({ query, resolve })); } }, endpoints);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pending).toHaveLength(1);
    let finished = false;
    void operation.then(() => { finished = true; });
    for (let index = 0; index < draft.route.points.length + 4 && !finished; index += 1) {
      if (pending[index] === undefined) break;
      pending[index]!.resolve(answer(pending[index]!.query, 270, 15));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(pending.length).toBeLessThanOrEqual(index + 2);
    }
    const result = await operation;
    expect(result.sampledPoints).toHaveLength(draft.route.points.length);
  });

  it("does not make a candidate forecast query to reconcile TOD", async () => {
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
    expect(tailwindRun).toHaveLength(draft.route.points.length);
    expect(headwindRun).toHaveLength(draft.route.points.length);
  });

  it("fails the whole update when any waypoint has no supported point forecast", async () => {
    const draft = { ...routePlanDraft(), departureTimeUtc: departure };
    let requests = 0;
    await expect(resolveRouteWeather(draft, aircraftProfile(), { async fetchPoint(query) {
      requests += 1;
      if (query.longitudeDeg < -88) throw new Error("No supported forecast point for waypoint");
      return answer(query, 270, 15);
    } }, endpoints)).rejects.toThrow(/supported forecast point/i);
    expect(requests).toBe(1);
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
