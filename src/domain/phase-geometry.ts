import { type CalculationTrace, trace } from "./calculation-trace";
import type { Coordinate } from "./coordinates";
import { calculateGreatCircleDistanceAndInitialCourse, pointAlongGreatCircle } from "./distance-course";
import { failure, propagateFailure, success, type DomainResult } from "./errors";
import { nauticalMiles, type NauticalMiles, type TrueCourse } from "./units";

export interface RouteGeometryLeg {
  readonly sourceLegId: string;
  readonly start: Coordinate;
  readonly end: Coordinate;
}

export type GeneratedBoundaryKind = "top-of-climb" | "top-of-descent" | "altitude-transition";

export interface GeneratedBoundary {
  readonly kind: GeneratedBoundaryKind;
  readonly id: string;
  readonly coordinate: Coordinate;
  readonly sourceLegId: string;
  /** Unrounded distance from the source leg start to this generated point. */
  readonly sourceLegDistance: NauticalMiles;
  /** Unrounded distance from route start to this generated point. */
  readonly routeDistance: NauticalMiles;
  readonly trace: CalculationTrace;
}

export interface GeneratedSubLeg {
  readonly id: string;
  readonly sourceLegId: string;
  readonly phase: "climb" | "cruise" | "descent" | "transition-climb" | "transition-descent";
  readonly start: Coordinate;
  readonly end: Coordinate;
  readonly distance: NauticalMiles;
}

interface CalculatedGeometryLeg extends RouteGeometryLeg {
  readonly distance: NauticalMiles;
  readonly course: TrueCourse;
}

const calculateRouteGeometry = (legs: readonly RouteGeometryLeg[]): DomainResult<readonly CalculatedGeometryLeg[]> => {
  if (legs.length === 0) return failure("ROUTE_GEOMETRY_ERROR", "At least one route geometry leg is required.");
  const calculated: CalculatedGeometryLeg[] = [];
  for (const leg of legs) {
    if (leg.sourceLegId.length === 0) {
      return failure("ROUTE_GEOMETRY_ERROR", "Every route geometry leg requires a source leg ID.");
    }
    const geometry = calculateGreatCircleDistanceAndInitialCourse(leg.start, leg.end);
    if (!geometry.ok) return propagateFailure(geometry);
    calculated.push({
      ...leg,
      distance: geometry.value.distance,
      course: geometry.value.initialTrueCourse,
    });
  }
  return success(calculated);
};

export const calculateRouteDistance = (legs: readonly RouteGeometryLeg[]): DomainResult<NauticalMiles> => {
  const geometry = calculateRouteGeometry(legs);
  if (!geometry.ok) return propagateFailure(geometry);
  return nauticalMiles(geometry.value.reduce((sum, leg) => sum + leg.distance, 0));
};

/**
 * Places a generated point along the ordered route. At a checkpoint boundary,
 * the preceding source leg owns the generated point so its distance is stable.
 */
export const placeGeneratedBoundary = (
  route: readonly RouteGeometryLeg[],
  distanceFromRouteStart: NauticalMiles,
  kind: GeneratedBoundaryKind,
  id: string,
): DomainResult<GeneratedBoundary> => {
  const geometry = calculateRouteGeometry(route);
  if (!geometry.ok) return propagateFailure(geometry);
  const totalDistance = geometry.value.reduce((sum, leg) => sum + leg.distance, 0);
  if (distanceFromRouteStart < 0 || distanceFromRouteStart > totalDistance) {
    return failure("ROUTE_GEOMETRY_ERROR", "Generated boundary distance must fall within the route.", {
      distanceFromRouteStart,
      totalDistance,
    });
  }
  let routeDistanceBeforeLeg = 0;
  for (const leg of geometry.value) {
    const routeDistanceAtLegEnd = routeDistanceBeforeLeg + leg.distance;
    if (distanceFromRouteStart <= routeDistanceAtLegEnd + 1e-10) {
      const sourceLegDistance = nauticalMiles(Math.max(0, distanceFromRouteStart - routeDistanceBeforeLeg));
      if (!sourceLegDistance.ok) return propagateFailure(sourceLegDistance);
      const coordinate = pointAlongGreatCircle(leg.start, leg.course, sourceLegDistance.value);
      if (!coordinate.ok) return propagateFailure(coordinate);
      return success({
        kind,
        id,
        coordinate: coordinate.value,
        sourceLegId: leg.sourceLegId,
        sourceLegDistance: sourceLegDistance.value,
        routeDistance: distanceFromRouteStart,
        trace: trace(
          "generated-boundary-route-placement",
          [
            { name: "route distance", value: distanceFromRouteStart, unit: "nautical-miles" },
            { name: "source leg distance", value: leg.distance, unit: "nautical-miles" },
          ],
          [
            { name: "distance before source leg", value: routeDistanceBeforeLeg, unit: "nautical-miles" },
            { name: "distance within source leg", value: sourceLegDistance.value, unit: "nautical-miles" },
          ],
          { name: "generated boundary route distance", value: distanceFromRouteStart, unit: "nautical-miles" },
        ),
      });
    }
    routeDistanceBeforeLeg = routeDistanceAtLegEnd;
  }
  return failure("ROUTE_GEOMETRY_ERROR", "Could not place the generated boundary on the route.");
};

export const placeTopOfClimb = (
  route: readonly RouteGeometryLeg[],
  climbDistance: NauticalMiles,
): DomainResult<GeneratedBoundary> => placeGeneratedBoundary(route, climbDistance, "top-of-climb", "generated-toc");

export const placeTopOfDescent = (
  route: readonly RouteGeometryLeg[],
  descentDistance: NauticalMiles,
): DomainResult<GeneratedBoundary> => {
  const totalDistance = calculateRouteDistance(route);
  if (!totalDistance.ok) return propagateFailure(totalDistance);
  if (descentDistance > totalDistance.value) {
    return failure("ROUTE_GEOMETRY_ERROR", "Top of descent cannot be placed before the start of this route.", {
      descentDistance,
      totalDistance: totalDistance.value,
    });
  }
  const distanceFromStart = nauticalMiles(totalDistance.value - descentDistance);
  if (!distanceFromStart.ok) return propagateFailure(distanceFromStart);
  return placeGeneratedBoundary(route, distanceFromStart.value, "top-of-descent", "generated-tod");
};

/** Splits a source route leg at a generated boundary while retaining source-leg identity. */
export const splitSourceLegAtBoundary = (
  leg: RouteGeometryLeg,
  boundary: GeneratedBoundary,
  beforePhase: GeneratedSubLeg["phase"],
  afterPhase: GeneratedSubLeg["phase"],
): DomainResult<readonly GeneratedSubLeg[]> => {
  if (boundary.sourceLegId !== leg.sourceLegId) {
    return failure("ROUTE_GEOMETRY_ERROR", "Boundary does not belong to the supplied source leg.", {
      boundarySourceLegId: boundary.sourceLegId,
      sourceLegId: leg.sourceLegId,
    });
  }
  const geometry = calculateGreatCircleDistanceAndInitialCourse(leg.start, leg.end);
  if (!geometry.ok) return propagateFailure(geometry);
  if (boundary.sourceLegDistance < 0 || boundary.sourceLegDistance > geometry.value.distance) {
    return failure("ROUTE_GEOMETRY_ERROR", "Boundary falls outside its source leg.");
  }
  const before = nauticalMiles(boundary.sourceLegDistance);
  if (!before.ok) return propagateFailure(before);
  const after = nauticalMiles(geometry.value.distance - boundary.sourceLegDistance);
  if (!after.ok) return propagateFailure(after);
  return success([
    {
      id: `${leg.sourceLegId}:before:${boundary.id}`,
      sourceLegId: leg.sourceLegId,
      phase: beforePhase,
      start: leg.start,
      end: boundary.coordinate,
      distance: before.value,
    },
    {
      id: `${leg.sourceLegId}:after:${boundary.id}`,
      sourceLegId: leg.sourceLegId,
      phase: afterPhase,
      start: boundary.coordinate,
      end: leg.end,
      distance: after.value,
    },
  ]);
};
