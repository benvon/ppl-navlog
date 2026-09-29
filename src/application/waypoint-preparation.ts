import { calculateGreatCircleDistanceAndInitialCourse } from "../domain/distance-course";
import { coordinate, type Coordinate } from "../domain/coordinates";
import { failure, propagateFailure, success, type DomainResult } from "../domain/errors";
import type { RouteDefinition, RoutePoint, UserRouteLeg } from "../domain/route";
import { nauticalMiles } from "../domain/units";
import type { Wind } from "../domain/wind";

export interface PreparedPilotPoint {
  readonly point: RoutePoint;
  readonly routeDistanceNauticalMiles: number;
}

export interface PreparedPilotLeg {
  readonly sourceLeg: UserRouteLeg;
  readonly start: Coordinate;
  readonly end: Coordinate;
  readonly trueCourseDegrees: number;
  readonly distanceNauticalMiles: number;
  readonly routeStartDistanceNauticalMiles: number;
  readonly routeEndDistanceNauticalMiles: number;
}

export interface PreparedPilotRoute {
  readonly pilotPoints: readonly PreparedPilotPoint[];
  readonly legs: readonly PreparedPilotLeg[];
  readonly totalRouteDistanceNauticalMiles: number;
}

export interface PreparedWaypointPlacement {
  readonly altitudeDifferenceFeet: number;
  readonly verticalRateFeetPerMinute: number;
  readonly trueAirspeedKnots: number;
  readonly planningWind: Wind;
  readonly estimatedDurationMinutes: number;
  readonly estimatedDistanceNauticalMiles: number;
  readonly formulaId: string;
  readonly sourcePointId?: string;
  readonly sourceLegId?: string;
}

export interface PreparedWaypoint {
  readonly id: string;
  readonly kind: "departure" | "pilot-checkpoint" | "destination" | "estimated-toc" | "estimated-tod" | "estimated-transition-end";
  readonly label: string;
  readonly coordinate: Coordinate;
  readonly routeDistanceNauticalMiles: number;
  readonly sourcePointId?: string;
  readonly sourceLegId?: string;
  readonly placement?: PreparedWaypointPlacement;
}

const invalidRoute = (message: string, details?: Readonly<Record<string, string | number | boolean | null>>): DomainResult<never> =>
  failure("ROUTE_GEOMETRY_ERROR", message, details);

/** Validates the pilot's ordered route and prepares its cumulative great-circle geometry. */
export const preparePilotRoute = (route: RouteDefinition): DomainResult<PreparedPilotRoute> => {
  if (route.points.length < 2 || route.legs.length === 0) {
    return invalidRoute("A pilot route requires at least two points and one leg.");
  }
  if (route.legs.length !== route.points.length - 1) {
    return invalidRoute("A pilot route must have exactly one leg between each adjacent pair of points.", {
      pointCount: route.points.length,
      legCount: route.legs.length,
    });
  }

  const pointById = new Map<string, RoutePoint>();
  const allIds = new Set<string>();
  for (const point of route.points) {
    if (!point.id || allIds.has(point.id)) {
      return invalidRoute("Pilot route point IDs must be present and unique.", { pointId: point.id });
    }
    const checkedCoordinate = coordinate(point.coordinate.latitude, point.coordinate.longitude);
    if (!checkedCoordinate.ok) return propagateFailure(checkedCoordinate);
    allIds.add(point.id);
    pointById.set(point.id, point);
  }
  for (const leg of route.legs) {
    if (!leg.id || allIds.has(leg.id)) {
      return invalidRoute("Pilot route point and leg IDs must be present and unique.", { legId: leg.id });
    }
    allIds.add(leg.id);
  }

  const preparedPoints: PreparedPilotPoint[] = [];
  const preparedLegs: PreparedPilotLeg[] = [];
  let accumulatedDistance = 0;

  for (let index = 0; index < route.points.length; index += 1) {
    const point = route.points[index];
    if (point === undefined) return invalidRoute("Pilot route contains a missing point.", { index });
    const pointDistance = nauticalMiles(accumulatedDistance);
    if (!pointDistance.ok) return propagateFailure(pointDistance);
    preparedPoints.push({ point, routeDistanceNauticalMiles: pointDistance.value });

    if (index === route.points.length - 1) continue;
    const nextPoint = route.points[index + 1];
    const leg = route.legs[index];
    if (nextPoint === undefined || leg === undefined) {
      return invalidRoute("Pilot route is missing a point or leg in its ordered geometry.", { index });
    }
    if (!pointById.has(leg.fromPointId) || !pointById.has(leg.toPointId)) {
      return invalidRoute("A route leg references a point that does not exist.", {
        legId: leg.id,
        fromPointId: leg.fromPointId,
        toPointId: leg.toPointId,
      });
    }
    if (leg.fromPointId !== point.id || leg.toPointId !== nextPoint.id) {
      return invalidRoute("Route legs must connect adjacent pilot points in authored order.", {
        legId: leg.id,
        expectedFromPointId: point.id,
        expectedToPointId: nextPoint.id,
        fromPointId: leg.fromPointId,
        toPointId: leg.toPointId,
      });
    }

    const geometry = calculateGreatCircleDistanceAndInitialCourse(point.coordinate, nextPoint.coordinate);
    if (!geometry.ok) return propagateFailure(geometry);
    const startDistance = nauticalMiles(accumulatedDistance);
    if (!startDistance.ok) return propagateFailure(startDistance);
    accumulatedDistance += geometry.value.distance;
    const endDistance = nauticalMiles(accumulatedDistance);
    if (!endDistance.ok) return propagateFailure(endDistance);
    preparedLegs.push({
      sourceLeg: leg,
      start: point.coordinate,
      end: nextPoint.coordinate,
      trueCourseDegrees: geometry.value.initialTrueCourse,
      distanceNauticalMiles: geometry.value.distance,
      routeStartDistanceNauticalMiles: startDistance.value,
      routeEndDistanceNauticalMiles: endDistance.value,
    });
  }

  const totalDistance = nauticalMiles(accumulatedDistance);
  if (!totalDistance.ok) return propagateFailure(totalDistance);
  return success({
    pilotPoints: preparedPoints,
    legs: preparedLegs,
    totalRouteDistanceNauticalMiles: totalDistance.value,
  });
};
