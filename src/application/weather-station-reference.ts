import { calculateGreatCircleDistanceAndInitialCourse, pointAlongGreatCircle } from "../domain/distance-course";
import type { Coordinate } from "../domain/coordinates";
import type { RouteDefinition } from "../domain/route";
import { nauticalMiles } from "../domain/units";

/**
 * One documented representative point for the V1 station-based FB product:
 * halfway along the ordered route by great-circle nautical miles. This is a
 * station-selection rule, not spatial interpolation of the forecast.
 */
export const routeDistanceMidpoint = (route: RouteDefinition): Coordinate => {
  const points = new Map(route.points.map((point) => [point.id, point.coordinate]));
  const segments = route.legs.map((leg) => {
    const start = points.get(leg.fromPointId);
    const end = points.get(leg.toPointId);
    if (start === undefined || end === undefined) throw new Error("A route leg references a missing point.");
    const geometry = calculateGreatCircleDistanceAndInitialCourse(start, end);
    if (!geometry.ok) throw new Error(geometry.error.message);
    return { start, geometry: geometry.value };
  });
  const total = segments.reduce((sum, segment) => sum + segment.geometry.distance, 0);
  if (!(total > 0)) throw new Error("A route with positive distance is required for winds-station selection.");
  let remaining = total / 2;
  for (const segment of segments) {
    if (remaining <= segment.geometry.distance) {
      const distance = nauticalMiles(remaining);
      if (!distance.ok) throw new Error(distance.error.message);
      const midpoint = pointAlongGreatCircle(segment.start, segment.geometry.initialTrueCourse, distance.value);
      if (!midpoint.ok) throw new Error(midpoint.error.message);
      return midpoint.value;
    }
    remaining -= segment.geometry.distance;
  }
  throw new Error("Route midpoint could not be located.");
};
