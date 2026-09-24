import { describe, expect, it } from "vitest";
import type { AloftPointAnswer, AloftPointQuery, MetarSuccessPayload, TafAnswer } from "../../worker/api/contracts";
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
const taf = (shiftAt = "2029-09-21T16:00:00.000Z"): TafAnswer => ({
  stationIcao: "KJVL", issuedAt: departure, validFrom: departure, validUntil: "2029-09-22T12:00:00.000Z", rawTaf: "TAF KJVL fixture", requestId: "taf-request",
  groups: [
    { kind: "prevailing", fromUtc: departure, windDirectionType: "fixed", windFromDegTrue: 270, windSpeedKt: 8, gustKt: null, probabilityPercent: null, raw: "27008KT", untilUtc: "2029-09-21T18:00:00.000Z" },
    { kind: "TEMPO", fromUtc: shiftAt, untilUtc: "2029-09-21T17:00:00.000Z", windDirectionType: "fixed", windFromDegTrue: 90, windSpeedKt: 20, gustKt: 30, probabilityPercent: null, raw: "TEMPO 09020G30KT" },
  ],
});
const answer = (query: AloftPointQuery, direction: number, speed: number, useUntil = periodEnd, useFrom = departure, issuedAt = departure): AloftPointAnswer => ({
  query, windFromDegTrue: direction, windSpeedKt: speed, temperatureC: null, issuedAt, useFrom, useUntil,
  forecastCycle: "06", sources: [{ stationId: "BRL", latitudeDeg: 40.7, longitudeDeg: -91.1, distanceNauticalMiles: 30, horizontalWeight: 1, lowerAltitudeFeet: query.altitudeFeetMsl, upperAltitudeFeet: query.altitudeFeetMsl, verticalWeight: 1, temperatureLowerAltitudeFeet: null, temperatureUpperAltitudeFeet: null, temperatureVerticalWeight: null }],
  method: "station-level", requestId: `point-${query.latitudeDeg.toFixed(3)}-${query.longitudeDeg.toFixed(3)}`,
});
const endpoints = { departureMetar: metar(), destinationTaf: taf() };

async function planWith(draft: ReturnType<typeof planDraft>, directionAt: (query: AloftPointQuery) => number, options: { useUntil?: string | ((query: AloftPointQuery) => string); useFrom?: string | ((query: AloftPointQuery) => string); issuedAt?: string | ((query: AloftPointQuery) => string); destinationTaf?: TafAnswer; speed?: number } = {}) {
  const queries: AloftPointQuery[] = [];
  const solution = await resolveRouteWeather(draft, aircraftProfile(), {
    async fetchPoint(query) { queries.push(query); return answer(query, directionAt(query), options.speed ?? 15, typeof options.useUntil === "function" ? options.useUntil(query) : options.useUntil, typeof options.useFrom === "function" ? options.useFrom(query) : options.useFrom, typeof options.issuedAt === "function" ? options.issuedAt(query) : options.issuedAt); },
  }, { ...endpoints, destinationTaf: options.destinationTaf ?? taf() });
  const result = await calculateCompletePlan(draft, aircraftProfile(), {
    weather: { resolve: async () => solution.weather },
    calculations: createFullNavlogCalculationEngine(),
  });
  return { queries, solution, result };
}

const navRows = (result: Awaited<ReturnType<typeof planWith>>["result"]) => {
  if (result.status !== "ready") throw new Error(result.message);
  const snapshot = result.calculationSnapshot as { readonly navlog: { readonly rows: readonly { readonly groundspeed: number; readonly estimatedTimeEnroute: number; readonly fuel: number; readonly effectiveWind: { readonly wind: { readonly effectiveValue: { readonly directionFrom: number; readonly speed: number } } }; readonly subleg: { readonly phase: string; readonly routeStartDistance: number; readonly routeEndDistance: number } }[] } };
  return snapshot.navlog.rows;
};

describe("route waypoint weather sampling", () => {
  it("makes exactly one aloft call per waypoint and none at generated boundaries", async () => {
    const draft = { ...planDraft(), departureTimeUtc: departure };
    const { queries, solution, result } = await planWith(draft, () => 270);

    expect(result, JSON.stringify(result)).toMatchObject({ status: "ready" });
    expect(queries).toHaveLength(draft.route.points.length);
    expect(solution.sampledPoints).toHaveLength(draft.route.points.length);
    expect(solution.iterations).toBe(1);
    expect(queries.map((query) => [query.latitudeDeg, query.longitudeDeg])).toEqual(draft.route.points.map((point) => [point.coordinate.latitude, point.coordinate.longitude]));
    expect(queries[0]?.altitudeFeetMsl).toBe(draft.route.legs[0]?.cruiseAltitudeFeetMsl);
    expect(queries.at(-1)?.altitudeFeetMsl).toBe(draft.route.legs.at(-1)?.cruiseAltitudeFeetMsl);
    expect(queries[0]?.plannedUtc).toBe(departure);
  });

  it("interpolates distinct same-altitude waypoint winds into changed row GS, ETE, and fuel", async () => {
    const draft = { ...planDraft(), departureTimeUtc: departure };
    const result = await planWith(draft, (query) => query.longitudeDeg < -88.2 ? 270 : 90);
    const rows = navRows(result.result);

    expect(rows.length).toBeGreaterThan(draft.route.legs.length);
    expect(new Set(rows.map((row) => row.groundspeed)).size).toBeGreaterThan(1);
    expect(new Set(rows.map((row) => row.estimatedTimeEnroute)).size).toBeGreaterThan(1);
    expect(new Set(rows.map((row) => row.fuel)).size).toBeGreaterThan(1);
    expect(rows.some((row) => row.effectiveWind.wind.effectiveValue.directionFrom !== 270)).toBe(true);
  });

  it("projects generated phase positions correctly across a high-latitude antimeridian leg", async () => {
    const base = planDraft();
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
    expect(projected.ok && projected.value.directionFrom).toBeCloseTo(225, 0);
  });

  it("rejects Worker-unsupported altitude and a departure altitude below field elevation before point requests", async () => {
    const base = planDraft();
    let requests = 0;
    const client = { async fetchPoint(query: AloftPointQuery) { requests += 1; return answer(query, 270, 10); } };
    const tooHigh = { ...base, departureTimeUtc: departure, route: { ...base.route, legs: base.route.legs.map((leg) => ({ ...leg, cruiseAltitudeFeetMsl: 53_001 })) } };
    await expect(resolveRouteWeather(tooHigh, aircraftProfile(), client, endpoints)).rejects.toThrow(/supported selected aloft altitude/i);
    const belowField = { ...base, departureTimeUtc: departure, route: { ...base.route, points: base.route.points.map((point, index) => index === 0 ? { ...point, elevationFeetMsl: 4_000 } : point), legs: base.route.legs.map((leg, index) => index === 0 ? { ...leg, cruiseAltitudeFeetMsl: 3_500 } : leg) } };
    await expect(resolveRouteWeather(belowField, aircraftProfile(), client, endpoints)).rejects.toThrow(/below the departure field elevation/i);
    expect(requests).toBe(0);
  });

  it("uses endpoint anchors and interpolates the same waypoint answers at phase boundaries", async () => {
    const base = planDraft();
    const draft = { ...base, departureTimeUtc: departure, route: { ...base.route, legs: base.route.legs.map((leg, index) => index === 1 ? { ...leg, cruiseAltitudeFeetMsl: 5_500 } : leg) } };
    const { queries, result } = await planWith(draft, (query) => query.longitudeDeg < -88.2 ? 350 : 10);
    const rows = navRows(result);

    expect(queries).toHaveLength(draft.route.points.length);
    expect(rows.some((row) => row.subleg.phase === "climb")).toBe(true);
    expect(rows.some((row) => row.subleg.phase === "descent")).toBe(true);
    expect(rows.some((row) => row.subleg.phase.startsWith("transition"))).toBe(true);
    expect(result.status === "ready" && result.warnings.join(" ")).toMatch(/departure METAR.*surface anchor/i);
    expect(rows.some((row) => row.subleg.routeEndDistance > row.subleg.routeStartDistance && row.effectiveWind.wind.effectiveValue.speed > 0)).toBe(true);
  });

  it("uses the projected climb-start position without adding its already-traveled phase distance", async () => {
    const base = planDraft();
    const draft = { ...base, departureTimeUtc: departure, route: { ...base.route, legs: base.route.legs.map((leg, index) => index === 1 ? { ...leg, cruiseAltitudeFeetMsl: 5_500 } : leg) } };
    const { result } = await planWith(draft, (query) => query.longitudeDeg < -87.91 ? 270 : 90);
    if (result.status !== "ready") throw new Error(result.message);
    const distance = nauticalMiles(5);
    if (!distance.ok) throw new Error(distance.error.message);
    const resolved = result.weather.phaseWindResolver.resolveEffectiveWind({ phase: "transition-climb", start: draft.route.points[1]!.coordinate, courseDegreesTrue: 270, startingAltitudeFeetMsl: 4_500, targetAltitudeFeetMsl: 5_500, estimatedDistanceNauticalMiles: distance.value, iteration: 2 });
    expect(resolved.ok && resolved.value.directionFrom).toBeCloseTo(90, 0);
  });

  it("does not apply destination TAF wind to a cruise row near the destination", async () => {
    const base = planDraft();
    const draft = { ...base, departureTimeUtc: departure, descentTargetAltitudeFeetMsl: { ...base.descentTargetAltitudeFeetMsl, effectiveValue: 4_500 }, route: { ...base.route, legs: base.route.legs.map((leg, index) => index === 1 ? { ...leg, cruiseAltitudeFeetMsl: 5_500 } : leg) } };
    const { result } = await planWith(draft, () => 270, { destinationTaf: { ...taf(), groups: [{ kind: "prevailing", fromUtc: departure, untilUtc: periodEnd, windDirectionType: "fixed", windFromDegTrue: 90, windSpeedKt: 5, gustKt: null, probabilityPercent: null, raw: "09005KT" }] } });
    const rows = navRows(result);
    const finalCruiseRow = rows.filter((row) => row.subleg.phase === "cruise").at(-1);
    expect(finalCruiseRow?.effectiveWind.wind.effectiveValue.directionFrom).toBeCloseTo(270, 0);
  });

  it("blocks when a point report covers provisional UTC but expires before corrected waypoint UTC", async () => {
    const draft = { ...planDraft(), departureTimeUtc: departure };
    const dependencies = {
      weather: { resolve: async () => (await resolveRouteWeather(draft, aircraftProfile(), { async fetchPoint(query) { return answer(query, query.longitudeDeg < -88.5 ? 270 : 90, 30, new Date(Date.parse(query.plannedUtc) + 1_000).toISOString()); } }, endpoints)).weather },
      calculations: createFullNavlogCalculationEngine(),
    };
    const result = await calculateCompletePlan(draft, aircraftProfile(), dependencies);
    expect(result).toMatchObject({ status: "blocked", reason: "weather-unavailable", message: expect.stringMatching(/corrected arrival/i) });
  });

  it("blocks when endpoint products leave a time gap inside a leg despite covering both waypoint instants", async () => {
    const base = planDraft();
    const twoPointRoute = { ...base.route, points: [base.route.points[0]!, base.route.points.at(-1)!], legs: [base.route.legs[0]!] };
    const draft = { ...base, departureTimeUtc: departure, route: { ...twoPointRoute, legs: [{ ...twoPointRoute.legs[0]!, toPointId: twoPointRoute.points[1]!.id }] } };
    const result = await planWith(draft, () => 270, {
      useUntil: (query) => query.longitudeDeg === draft.route.points[0]!.coordinate.longitude ? "2029-09-21T12:10:00.000Z" : periodEnd,
      useFrom: () => departure,
      issuedAt: (query) => query.longitudeDeg === draft.route.points[1]!.coordinate.longitude ? new Date(Date.parse(query.plannedUtc) - 60_000).toISOString() : departure,
    });
    expect(result.result).toMatchObject({ status: "blocked", reason: "weather-unavailable", message: expect.stringMatching(/uncovered time gap/i) });
  });

  it("does not request the next waypoint until the current answer resolves", async () => {
    const draft = { ...planDraft(), departureTimeUtc: departure };
    const pending: { query: AloftPointQuery; resolve: (answer: AloftPointAnswer) => void }[] = [];
    const operation = resolveRouteWeather(draft, aircraftProfile(), { fetchPoint(query) { return new Promise((resolve) => pending.push({ query, resolve })); } }, endpoints);
    expect(pending).toHaveLength(1);
    pending[0]!.resolve(answer(pending[0]!.query, 270, 15));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pending).toHaveLength(2);
    pending[1]!.resolve(answer(pending[1]!.query, 270, 15));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pending).toHaveLength(3);
    pending[2]!.resolve(answer(pending[2]!.query, 270, 15));
    const result = await operation;
    expect(result.sampledPoints).toHaveLength(draft.route.points.length);
  });

  it("uses returned preceding waypoint wind to choose the following query UTC", async () => {
    const draft = { ...planDraft(), departureTimeUtc: departure };
    const run = async (secondWaypointDirection: number) => {
      const queries: AloftPointQuery[] = [];
      await resolveRouteWeather(draft, aircraftProfile(), { async fetchPoint(query) {
        const index = queries.length;
        queries.push(query);
        const direction = index === 0 ? 270 : index === 1 ? secondWaypointDirection : 90;
        return answer(query, direction, 18);
      } }, endpoints);
      return queries;
    };
    const tailwindRun = await run(90);
    const headwindRun = await run(270);
    expect(tailwindRun[0]?.plannedUtc).toBe(headwindRun[0]?.plannedUtc);
    expect(tailwindRun[1]?.plannedUtc).toBe(headwindRun[1]?.plannedUtc);
    expect(tailwindRun[2]?.plannedUtc).not.toBe(headwindRun[2]?.plannedUtc);
  });

  it("blocks when calculated arrival moves into a different TAF group", async () => {
    const draft = { ...planDraft(), departureTimeUtc: departure };
    const outcome = await planWith(draft, (query) => query.longitudeDeg < -88.2 ? 270 : 90, { destinationTaf: taf("2029-09-21T12:49:55.000Z") });
    const { result } = outcome;
    expect(result).toMatchObject({ status: "blocked", reason: "weather-unavailable", message: expect.stringMatching(/different TAF wind group/i) });
  });

  it("fails the whole update when any waypoint has no supported point forecast", async () => {
    const draft = { ...planDraft(), departureTimeUtc: departure };
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
    const base = planDraft();
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
