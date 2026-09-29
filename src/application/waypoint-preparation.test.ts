import { describe, expect, it } from "vitest";

import { coordinate, type Coordinate } from "../domain/coordinates";
import type { DomainResult } from "../domain/errors";
import type { RouteDefinition, RoutePoint, UserRouteLeg } from "../domain/route";
import {
  estimateForwardVerticalWaypoint,
  estimateTopOfDescent,
  orderPreparedWaypoints,
  preparePilotRoute,
  type PreparedWaypoint,
  validateWaypointGeometry,
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

const routeAtDistances = (distances: readonly number[]) => {
  const points = distances.map((distance, index) => point(`P${index}`, distance / 60.0404607326));
  const legs = points.slice(1).map((destination, index) => leg(`L${index}`, points[index]?.id ?? "", destination.id));
  return { points, legs, prepared: value(preparePilotRoute(route(points, legs))) };
};

const waypointAt = (
  id: string,
  kind: PreparedWaypoint["kind"],
  label: string,
  routeDistanceNauticalMiles: number,
): PreparedWaypoint => ({
  id,
  kind,
  label,
  coordinate: point(id, routeDistanceNauticalMiles / 60.0404607326).coordinate,
  routeDistanceNauticalMiles,
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

  it("places a boundary at the destination despite a floating-point time residual", () => {
    const preparedRoute = straightPreparedRoute(1);
    const legMinutes = (preparedRoute.totalRouteDistanceNauticalMiles / 60) * 60;
    const rate = 3_000 / (legMinutes + Number.EPSILON * legMinutes * 4);
    const result = estimateForwardVerticalWaypoint(verticalInput({ route: preparedRoute, verticalRateFeetPerMinute: rate }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.routeDistanceNauticalMiles).toBe(preparedRoute.totalRouteDistanceNauticalMiles);
      expect(result.value.sourceLegId).toBe("leg-1");
    }
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
  });

  it("reports destination, available distance, and remaining phase time on route overflow", () => {
    const route = straightPreparedRoute(2);
    const availableDistance = route.totalRouteDistanceNauticalMiles - 119;
    const remainingPhaseTime = 6 - availableDistance;
    const result = estimateForwardVerticalWaypoint(verticalInput({ route, startRouteDistanceNauticalMiles: 119 }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ROUTE_GEOMETRY_ERROR");
    expect(result.error.message).toContain("destination destination at NM 120");
    expect(result.error.message).toContain(`${availableDistance.toFixed(2)} NM from the start point; ${availableDistance.toFixed(2)} NM can be traveled`);
    expect(result.error.message).toContain(`${remainingPhaseTime.toFixed(2)} minutes remaining in the phase`);
    expect(result.error.message).toContain("Review the target altitude, vertical performance, or route.");
    expect(result.error.details).toMatchObject({
      destinationPointId: "destination",
      destinationPointName: "destination",
      destinationRouteDistanceNauticalMiles: route.totalRouteDistanceNauticalMiles,
      availableDistanceNauticalMiles: availableDistance,
      traveledDistanceNauticalMiles: availableDistance,
      remainingPhaseTimeMinutes: remainingPhaseTime,
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

describe("orderPreparedWaypoints", () => {
  it("orders the 60 NM and 24 NM examples into positive split spans without changing authored points", () => {
    const sixtyNm = routeAtDistances([0, 20, 40, 60]);
    const authoredSnapshot = structuredClone({ points: sixtyNm.points, legs: sixtyNm.legs });
    const orderedSixty = value(orderPreparedWaypoints(sixtyNm.prepared, [
      waypointAt("tod", "estimated-tod", "TOD", 48),
      waypointAt("toc", "estimated-toc", "TOC", 6),
    ]));

    expect(orderedSixty.waypoints.map(({ label }) => label)).toEqual([
      "P0", "TOC", "P1", "P2", "TOD", "P3",
    ]);
    [6, 14, 20, 8, 12].forEach((distance, index) => {
      expect(orderedSixty.spans[index]?.distanceNauticalMiles).toBeCloseTo(distance, 2);
    });
    expect(orderedSixty.spans.map(({ sourceLegId }) => sourceLegId)).toEqual(["L0", "L0", "L1", "L2", "L2"]);
    expect(orderedSixty.spans).toHaveLength(5);
    expect(orderedSixty.spans.reduce((total, span) => total + span.distanceNauticalMiles, 0)).toBeCloseTo(60, 2);
    expect({ points: sixtyNm.points, legs: sixtyNm.legs }).toEqual(authoredSnapshot);

    const twentyFourNm = routeAtDistances([0, 9, 24]);
    const orderedTwentyFour = value(orderPreparedWaypoints(twentyFourNm.prepared, [
      waypointAt("tod", "estimated-tod", "TOD", 12),
      waypointAt("toc", "estimated-toc", "TOC", 6),
    ]));

    expect(orderedTwentyFour.waypoints.map(({ label }) => label)).toEqual([
      "P0", "TOC", "P1", "TOD", "P2",
    ]);
    [6, 3, 3, 12].forEach((distance, index) => {
      expect(orderedTwentyFour.spans[index]?.distanceNauticalMiles).toBeCloseTo(distance, 2);
    });
    expect(orderedTwentyFour.spans.map(({ sourceLegId }) => sourceLegId)).toEqual(["L0", "L0", "L1", "L1"]);
    expect(orderedTwentyFour.spans).toHaveLength(4);
    expect(orderedTwentyFour.spans.reduce((total, span) => total + span.distanceNauticalMiles, 0)).toBeCloseTo(24, 2);
  });

  it("retains a coincident pilot/generated pair without a zero span and keeps a nearby positive span", () => {
    const preparedRoute = routeAtDistances([0, 20, 40, 60]).prepared;
    const checkpointDistance = preparedRoute.pilotPoints[1]?.routeDistanceNauticalMiles ?? 0;
    const ordered = value(orderPreparedWaypoints(preparedRoute, [
      waypointAt("near", "estimated-transition-end", "Transition end", checkpointDistance + 0.01),
      waypointAt("tied-transition", "estimated-transition-end", "Transition start", checkpointDistance),
      waypointAt("toc", "estimated-toc", "TOC", checkpointDistance),
    ]));
    const orderedInReverse = value(orderPreparedWaypoints(preparedRoute, [
      waypointAt("toc", "estimated-toc", "TOC", checkpointDistance),
      waypointAt("tied-transition", "estimated-transition-end", "Transition start", checkpointDistance),
      waypointAt("near", "estimated-transition-end", "Transition end", checkpointDistance + 0.01),
    ]));
    const coincident = ordered.waypoints.filter(({ routeDistanceNauticalMiles }) => routeDistanceNauticalMiles === checkpointDistance);

    expect(coincident.map(({ label }) => label)).toEqual(["P1", "TOC", "Transition start"]);
    expect(orderedInReverse.waypoints.map(({ id }) => id)).toEqual(ordered.waypoints.map(({ id }) => id));
    expect(ordered.spans.every(({ distanceNauticalMiles }) => distanceNauticalMiles > 0)).toBe(true);
    expect(ordered.spans.some(({ from, to, distanceNauticalMiles }) =>
      from.label === "Transition start" && to.label === "Transition end" && distanceNauticalMiles > 0,
    )).toBe(true);
  });

  it("keeps the destination last when a generated transition ends there", () => {
    const preparedRoute = routeAtDistances([0, 30, 60]).prepared;
    const transition = waypointAt("transition", "estimated-transition-end", "Transition end", preparedRoute.totalRouteDistanceNauticalMiles);
    const ordered = value(orderPreparedWaypoints(preparedRoute, [transition]));

    expect(ordered.waypoints.slice(-2).map(({ id }) => id)).toEqual(["transition", "P2"]);
    expect(ordered.spans.at(-1)?.to.id).toBe("transition");
    expect(ordered.spans.every(({ distanceNauticalMiles }) => distanceNauticalMiles > 0)).toBe(true);
  });

  it("rejects duplicate generated IDs and collisions with pilot point IDs", () => {
    const preparedRoute = routeAtDistances([0, 30, 60]).prepared;
    const transition = waypointAt("transition", "estimated-transition-end", "Transition end", 40);

    expect(orderPreparedWaypoints(preparedRoute, [transition, waypointAt("transition", "estimated-tod", "TOD", 50)]))
      .toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
    expect(orderPreparedWaypoints(preparedRoute, [waypointAt("P1", "estimated-toc", "TOC", 6)]))
      .toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
  });
});

describe("validateWaypointGeometry", () => {
  it("keeps an early pilot checkpoint but rejects a transition started before TOC", () => {
    const preparedRoute = routeAtDistances([0, 3, 30, 60]).prepared;
    const toc = waypointAt("toc", "estimated-toc", "TOC", 6);
    const tod = waypointAt("tod", "estimated-tod", "TOD", 48);

    expect(validateWaypointGeometry({ route: preparedRoute, toc, tod, transitions: [] })).toEqual({ ok: true, value: true });

    const result = validateWaypointGeometry({
      route: preparedRoute,
      toc,
      tod,
      transitions: [{
        startPointId: "P1",
        end: waypointAt("transition", "estimated-transition-end", "Transition end", 8),
        nextPilotPointId: "P2",
      }],
    });
    expect(result).toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
    if (!result.ok) {
      expect(result.error.message).toMatch(/P1.*NM 3.*before.*TOC.*NM 6/i);
      expect(result.error.details).toMatchObject({
        startPointId: "P1",
        tocWaypointId: "toc",
        tocDistanceNauticalMiles: 6,
      });
      expect(result.error.details?.startPointDistanceNauticalMiles).toBeCloseTo(3, 8);
    }
  });

  it("accepts ordered phase boundaries and a transition ending at its next checkpoint", () => {
    const preparedRoute = routeAtDistances([0, 30, 50, 80]).prepared;

    expect(validateWaypointGeometry({
      route: preparedRoute,
      toc: waypointAt("toc", "estimated-toc", "TOC", 6),
      tod: waypointAt("tod", "estimated-tod", "TOD", 60),
      transitions: [{
        startPointId: "P1",
        end: waypointAt("transition", "estimated-transition-end", "Transition end", 50),
        nextPilotPointId: "P2",
      }],
    })).toEqual({ ok: true, value: true });
  });

  it("rejects TOC/TOD overlap with both distances and corrective guidance", () => {
    const preparedRoute = routeAtDistances([0, 14]).prepared;
    const result = validateWaypointGeometry({
      route: preparedRoute,
      toc: waypointAt("toc", "estimated-toc", "TOC", 6),
      tod: waypointAt("tod", "estimated-tod", "TOD", 2),
      transitions: [],
    });

    expect(result).toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
    if (!result.ok) {
      expect(result.error.message).toMatch(/TOC.*NM 6.*TOD.*NM 2/i);
      expect(result.error.message).toMatch(/review|revise|lower|performance|route/i);
      expect(result.error.details).toMatchObject({
        tocWaypointId: "toc",
        tocWaypointLabel: "TOC",
        tocDistanceNauticalMiles: 6,
        todWaypointId: "tod",
        todWaypointLabel: "TOD",
        todDistanceNauticalMiles: 2,
      });
    }
  });

  it("rejects coincident TOC and TOD because they leave no positive cruise span", () => {
    const preparedRoute = routeAtDistances([0, 14]).prepared;
    const result = validateWaypointGeometry({
      route: preparedRoute,
      toc: waypointAt("toc", "estimated-toc", "TOC", 6),
      tod: waypointAt("tod", "estimated-tod", "TOD", 6),
      transitions: [],
    });

    expect(result).toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
  });

  it("rejects a transition extending beyond its next pilot checkpoint", () => {
    const preparedRoute = routeAtDistances([0, 30, 50, 80]).prepared;
    const result = validateWaypointGeometry({
      route: preparedRoute,
      toc: waypointAt("toc", "estimated-toc", "TOC", 6),
      tod: waypointAt("tod", "estimated-tod", "TOD", 68),
      transitions: [{
        startPointId: "P1",
        end: waypointAt("transition", "estimated-transition-end", "Transition end", 52),
        nextPilotPointId: "P2",
      }],
    });

    expect(result).toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
    if (!result.ok) {
      expect(result.error.message).toMatch(/Transition end.*NM 52.*P2.*NM 50/i);
      expect(result.error.message).toMatch(/revise|performance|checkpoint|route/i);
      expect(result.error.details).toMatchObject({
        transitionEndId: "transition",
        transitionEndLabel: "Transition end",
        transitionEndDistanceNauticalMiles: 52,
        nextPilotPointId: "P2",
        nextPilotPointLabel: "P2",
      });
      expect(result.error.details?.nextPilotPointDistanceNauticalMiles).toBeCloseTo(50, 8);
    }
  });

  it("rejects a transition that skips the immediate checkpoint when naming its next checkpoint", () => {
    const preparedRoute = routeAtDistances([0, 30, 50, 80]).prepared;
    const result = validateWaypointGeometry({
      route: preparedRoute,
      toc: waypointAt("toc", "estimated-toc", "TOC", 6),
      tod: waypointAt("tod", "estimated-tod", "TOD", 68),
      transitions: [{
        startPointId: "P0",
        end: waypointAt("transition", "estimated-transition-end", "Transition end", 32),
        nextPilotPointId: "P2",
      }],
    });

    expect(result).toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
    if (!result.ok) {
      expect(result.error.message).toMatch(/P1 at NM 30 immediately follows P0/i);
      expect(result.error.message).toMatch(/checkpoint|route/i);
      expect(result.error.details).toMatchObject({
        startPointId: "P0",
        nextPilotPointId: "P2",
        actualNextPilotPointId: "P1",
      });
      expect(result.error.details?.actualNextPilotPointDistanceNauticalMiles).toBeCloseTo(30, 8);
    }
  });

  it("rejects a transition whose estimated end crosses TOD", () => {
    const preparedRoute = routeAtDistances([0, 30, 80]).prepared;
    const result = validateWaypointGeometry({
      route: preparedRoute,
      toc: waypointAt("toc", "estimated-toc", "TOC", 6),
      tod: waypointAt("tod", "estimated-tod", "TOD", 60),
      transitions: [{
        startPointId: "P1",
        end: waypointAt("transition", "estimated-transition-end", "Transition end", 70),
        nextPilotPointId: "P2",
      }],
    });

    expect(result).toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
    if (!result.ok) {
      expect(result.error.message).toMatch(/Transition end.*NM 70.*TOD.*NM 60/i);
      expect(result.error.message).toMatch(/revise|performance|descent|route/i);
      expect(result.error.details).toMatchObject({
        transitionEndId: "transition",
        transitionEndLabel: "Transition end",
        transitionEndDistanceNauticalMiles: 70,
        todWaypointId: "tod",
        todWaypointLabel: "TOD",
        todDistanceNauticalMiles: 60,
      });
    }
  });
});
