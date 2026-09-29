import { describe, expect, it } from "vitest";

import { coordinate, type Coordinate } from "../domain/coordinates";
import type { DomainResult } from "../domain/errors";
import type { RouteDefinition, RoutePoint, UserRouteLeg } from "../domain/route";
import {
  estimateForwardVerticalWaypoint,
  estimateTopOfDescent,
  preparePilotRoute,
  type PreparedWaypoint,
} from "./waypoint-preparation";
import { wind } from "../domain/wind";

const value = <T>(result: DomainResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const point = (id: string, longitude: number, latitude = 0): RoutePoint => ({
  kind: "checkpoint",
  id,
  name: id,
  coordinate: value(coordinate(latitude, longitude)),
});

const leg = (id: string, fromPointId: string, toPointId: string): UserRouteLeg => ({
  id,
  fromPointId,
  toPointId,
  cruiseAltitudeFeetMsl: 3_000,
});

const route = (points: readonly RoutePoint[], legs: readonly UserRouteLeg[]): RouteDefinition => ({
  id: "route-1",
  points,
  legs,
});

const straightPreparedRoute = (degrees = 1) => value(preparePilotRoute(route(
  [point("departure", 0), point("destination", degrees)],
  [leg("leg-1", "departure", "destination")],
)));

const calmWind = value(wind(0, 0));

const verticalInput = (overrides: Partial<Parameters<typeof estimateForwardVerticalWaypoint>[0]> = {}) => ({
  route: straightPreparedRoute(2),
  kind: "estimated-toc" as const,
  id: "toc",
  label: "TOC",
  startRouteDistanceNauticalMiles: 0,
  startingAltitudeFeetMsl: 2_000,
  targetAltitudeFeetMsl: 5_000,
  verticalRateFeetPerMinute: 500,
  trueAirspeedKnots: 60,
  fuelFlowGallonsPerHour: 10,
  planningWind: calmWind,
  ...overrides,
});

const todInput = (overrides: Partial<Parameters<typeof estimateTopOfDescent>[0]> = {}) => ({
  route: straightPreparedRoute(1),
  currentWaypoint: {
    id: "departure",
    kind: "departure" as const,
    label: "Departure",
    coordinate: point("departure", 0).coordinate,
    routeDistanceNauticalMiles: 0,
  },
  cruiseAltitudeFeetMsl: 5_000,
  patternAltitudeFeetMsl: 1_000,
  descentRateFeetPerMinute: 500,
  descentTrueAirspeedKnots: 90,
  descentFuelFlowGallonsPerHour: 6,
  planningWind: calmWind,
  ...overrides,
});

describe("preparePilotRoute", () => {
  it("accumulates ordered geometry for a straight route without changing authored points", () => {
    const departure = point("departure", 0);
    const destination = point("destination", 2);
    const authoredLeg = leg("leg-1", "departure", "destination");
    const before = structuredClone({ points: [departure, destination], legs: [authoredLeg] });

    const prepared = value(preparePilotRoute(route([departure, destination], [authoredLeg])));

    expect(prepared.pilotPoints.map(({ point: source, routeDistanceNauticalMiles }) => ({
      id: source.id,
      routeDistanceNauticalMiles,
    }))).toEqual([
      { id: "departure", routeDistanceNauticalMiles: 0 },
      { id: "destination", routeDistanceNauticalMiles: expect.closeTo(120.08, 1) },
    ]);
    expect(prepared.legs).toHaveLength(1);
    expect(prepared.legs[0]).toMatchObject({ sourceLeg: authoredLeg, start: departure.coordinate, end: destination.coordinate });
    expect(prepared.legs[0]?.trueCourseDegrees).toBeCloseTo(90, 8);
    expect(prepared.legs[0]?.routeStartDistanceNauticalMiles).toBe(0);
    expect(prepared.legs[0]?.routeEndDistanceNauticalMiles).toBeCloseTo(120.08, 1);
    expect(prepared.totalRouteDistanceNauticalMiles).toBeCloseTo(120.08, 1);
    expect({ points: [departure, destination], legs: [authoredLeg] }).toEqual(before);
  });

  it("preserves each leg's local course and accumulates a bent route in authored order", () => {
    const points = [point("A", 0), point("B", 1), point("C", 1, 1)];
    const legs = [leg("AB", "A", "B"), leg("BC", "B", "C")];

    const prepared = value(preparePilotRoute(route(points, legs)));

    expect(prepared.pilotPoints.map((entry) => entry.point.id)).toEqual(["A", "B", "C"]);
    expect(prepared.legs.map((entry) => entry.sourceLeg.id)).toEqual(["AB", "BC"]);
    expect(prepared.legs[0]?.trueCourseDegrees).toBeCloseTo(90, 8);
    expect(prepared.legs[1]?.trueCourseDegrees).toBeCloseTo(0, 8);
    expect(prepared.legs[1]?.routeStartDistanceNauticalMiles).toBeCloseTo(prepared.legs[0]?.distanceNauticalMiles ?? 0, 8);
    expect(prepared.totalRouteDistanceNauticalMiles).toBeCloseTo(
      (prepared.legs[0]?.distanceNauticalMiles ?? 0) + (prepared.legs[1]?.distanceNauticalMiles ?? 0), 8,
    );
  });

  it("rejects duplicate IDs, missing references, and discontinuous leg order", () => {
    const a = point("A", 0);
    const b = point("B", 1);
    const c = point("C", 2);

    expect(preparePilotRoute(route([a, b, c], [leg("same", "A", "B"), leg("same", "B", "C")]))).toMatchObject({
      ok: false,
      error: { code: "ROUTE_GEOMETRY_ERROR" },
    });
    expect(preparePilotRoute(route([a, point("A", 2)], [leg("AB", "A", "A")]))).toMatchObject({
      ok: false,
      error: { code: "ROUTE_GEOMETRY_ERROR" },
    });
    expect(preparePilotRoute(route([a, b], [leg("AB", "A", "missing")]))).toMatchObject({
      ok: false,
      error: { code: "ROUTE_GEOMETRY_ERROR" },
    });
    expect(preparePilotRoute(route([a, b, c], [leg("AB", "A", "B"), leg("AC", "A", "C")]))).toMatchObject({
      ok: false,
      error: { code: "ROUTE_GEOMETRY_ERROR" },
    });
  });

  it("rejects persisted point coordinates outside the supported latitude and longitude ranges", () => {
    const invalidPoint: RoutePoint = {
      ...point("invalid", 1),
      coordinate: { latitude: 100, longitude: 1 } as Coordinate,
    };

    expect(preparePilotRoute(route([point("A", 0), invalidPoint], [leg("AB", "A", "invalid")]))).toMatchObject({
      ok: false,
      error: { code: "OUT_OF_RANGE" },
    });
  });
});

describe("estimateForwardVerticalWaypoint", () => {
  it("places a 3,000 foot climb at NM 6 and records its placement assumptions", () => {
    const result = value(estimateForwardVerticalWaypoint(verticalInput()));

    expect(result.kind).toBe("estimated-toc");
    expect(result.routeDistanceNauticalMiles).toBeCloseTo(6, 8);
    expect(result.coordinate.longitude).toBeCloseTo(0.1, 3);
    expect(result.placement).toMatchObject({
      altitudeDifferenceFeet: 3_000,
      estimatedDurationMinutes: 6,
      estimatedDistanceNauticalMiles: 6,
      formulaId: "vertical-rate-groundspeed-distance",
      sourceLegId: "leg-1",
    });
  });

  it("places a valid climb when fuel flow is zero because fuel does not affect position", () => {
    const result = estimateForwardVerticalWaypoint(verticalInput({ fuelFlowGallonsPerHour: 0 }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.routeDistanceNauticalMiles).toBeCloseTo(6, 8);
  });

  it("places a transition by walking forward and re-solving groundspeed after a turn", () => {
    const bent = value(preparePilotRoute(route(
      [point("A", 0), point("B", 1), point("C", 1, 1)],
      [leg("AB", "A", "B"), leg("BC", "B", "C")],
    )));
    const result = value(estimateForwardVerticalWaypoint(verticalInput({
      route: bent,
      kind: "estimated-transition-end",
      id: "transition-end",
      label: "Transition end",
      startRouteDistanceNauticalMiles: 59,
      startingAltitudeFeetMsl: 5_000,
      targetAltitudeFeetMsl: 6_000,
      verticalRateFeetPerMinute: 500,
      trueAirspeedKnots: 60,
      planningWind: value(wind(270, 30)),
    })));

    expect(result.routeDistanceNauticalMiles).toBeGreaterThan(61.1);
    expect(result.routeDistanceNauticalMiles).toBeLessThan(61.3);
    expect(result.coordinate.latitude).toBeGreaterThan(0);
    expect(result.coordinate.longitude).toBeCloseTo(1, 5);
    expect(result.placement?.sourceLegId).toBe("BC");
  });

  it("rejects invalid rates, speeds, altitudes, and route overflow", () => {
    expect(estimateForwardVerticalWaypoint(verticalInput({ verticalRateFeetPerMinute: 0 }))).toMatchObject({ ok: false });
    expect(estimateForwardVerticalWaypoint(verticalInput({ verticalRateFeetPerMinute: Number.NaN }))).toMatchObject({ ok: false });
    expect(estimateForwardVerticalWaypoint(verticalInput({ trueAirspeedKnots: Number.POSITIVE_INFINITY }))).toMatchObject({ ok: false });
    expect(estimateForwardVerticalWaypoint(verticalInput({ trueAirspeedKnots: 0 }))).toMatchObject({ ok: false });
    expect(estimateForwardVerticalWaypoint(verticalInput({
      kind: "estimated-toc",
      startingAltitudeFeetMsl: 5_000,
      targetAltitudeFeetMsl: 4_000,
    }))).toMatchObject({ ok: false });
    expect(estimateForwardVerticalWaypoint(verticalInput({ startRouteDistanceNauticalMiles: 119 }))).toMatchObject({
      ok: false,
      error: { code: "ROUTE_GEOMETRY_ERROR" },
    });
  });
});

describe("estimateTopOfDescent", () => {
  it("uses one no-wind descent estimate and places TOD at route total minus 12 NM", () => {
    const route = straightPreparedRoute(1);
    const result = value(estimateTopOfDescent(todInput({ route })));

    expect(result.kind).toBe("estimated-tod");
    expect(result.placement?.estimatedDurationMinutes).toBe(8);
    expect(result.placement?.estimatedDistanceNauticalMiles).toBeCloseTo(12, 8);
    expect(result.routeDistanceNauticalMiles).toBeCloseTo(route.totalRouteDistanceNauticalMiles - 12, 8);
    expect(result.placement?.formulaId).toBe("route-total-minus-final-course-descent-distance");
  });

  it("places valid TOD when descent fuel flow is zero because fuel does not affect position", () => {
    const route = straightPreparedRoute(1);
    const result = estimateTopOfDescent(todInput({ route, descentFuelFlowGallonsPerHour: 0 }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.routeDistanceNauticalMiles).toBeCloseTo(route.totalRouteDistanceNauticalMiles - 12, 8);
  });

  it("uses the final charted course once and does not integrate descent backward over a bend", () => {
    const bent = value(preparePilotRoute(route(
      [point("A", 0), point("B", 1), point("C", 1, 1)],
      [leg("AB", "A", "B"), leg("BC", "B", "C")],
    )));
    const result = value(estimateTopOfDescent(todInput({
      route: bent,
      descentTrueAirspeedKnots: 90,
      planningWind: value(wind(180, 30)),
    })));

    expect(result.placement?.estimatedDistanceNauticalMiles).toBeCloseTo(16, 8);
    expect(result.routeDistanceNauticalMiles).toBeCloseTo(bent.totalRouteDistanceNauticalMiles - 16, 8);
    expect(result.coordinate.latitude).toBeGreaterThan(0);
  });

  it("rejects a TOD before the current pilot checkpoint with named distances and guidance", () => {
    const route = straightPreparedRoute(1);
    const lake: PreparedWaypoint = {
      id: "lake",
      kind: "pilot-checkpoint",
      label: "Lake",
      coordinate: point("Lake", 50 / 60.04).coordinate,
      routeDistanceNauticalMiles: 50,
    };
    const result = estimateTopOfDescent(todInput({ route, currentWaypoint: lake }));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "ROUTE_GEOMETRY_ERROR",
        message: expect.stringMatching(/^TOD is calculated to be before final waypoint Lake/),
      },
    });
    if (!result.ok) {
      expect(result.error.message).toContain("NM 48");
      expect(result.error.message).toContain("NM 50");
      expect(result.error.message).toMatch(/waypoint position.*cruise altitude.*descent performance.*route/i);
    }
  });

  it("uses overlap wording when TOD would precede the current TOC", () => {
    const result = estimateTopOfDescent(todInput({
      currentWaypoint: {
        id: "toc",
        kind: "estimated-toc",
        label: "TOC",
        coordinate: point("toc", 0.9).coordinate,
        routeDistanceNauticalMiles: 54,
      },
    }));

    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/TOC.*TOD.*overlap/i) },
    });
  });

  it("rejects invalid inputs, an overlong descent, and unusable groundspeed", () => {
    expect(estimateTopOfDescent(todInput({ descentRateFeetPerMinute: 0 }))).toMatchObject({ ok: false });
    expect(estimateTopOfDescent(todInput({ descentRateFeetPerMinute: Number.POSITIVE_INFINITY }))).toMatchObject({ ok: false });
    expect(estimateTopOfDescent(todInput({ descentTrueAirspeedKnots: Number.NaN }))).toMatchObject({ ok: false });
    expect(estimateTopOfDescent(todInput({ descentTrueAirspeedKnots: 0 }))).toMatchObject({ ok: false });
    expect(estimateTopOfDescent(todInput({ patternAltitudeFeetMsl: 5_000 }))).toMatchObject({
      ok: false,
      error: { code: "INVALID_PHASE_ALTITUDES" },
    });
    expect(estimateTopOfDescent(todInput({
      descentTrueAirspeedKnots: 30,
      planningWind: value(wind(90, 40)),
    }))).toMatchObject({ ok: false, error: { code: "NONPOSITIVE_GROUNDSPEED" } });
    expect(estimateTopOfDescent(todInput({ route: straightPreparedRoute(0.1) }))).toMatchObject({
      ok: false,
      error: { code: "ROUTE_GEOMETRY_ERROR" },
    });
  });
});
