import { describe, expect, it } from "vitest";

import { coordinate } from "../domain/coordinates";
import type { DomainResult } from "../domain/errors";
import type { RouteDefinition, RoutePoint, UserRouteLeg } from "../domain/route";
import { preparePilotRoute } from "./waypoint-preparation";

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
});
