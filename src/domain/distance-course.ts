import { trace, type CalculationTrace } from "./calculation-trace";
import { coordinate, requireDistinctCoordinates, type Coordinate } from "./coordinates";
import { failure, propagateFailure, success, type DomainResult } from "./errors";
import {
  degreesToRadians,
  nauticalMiles,
  radiansToDegrees,
  trueCourse,
  type NauticalMiles,
  type TrueCourse,
} from "./units";

/** Mean Earth radius expressed in nautical miles; adequate for VFR planning geodesics. */
export const MEAN_EARTH_RADIUS_NAUTICAL_MILES = 3440.065;

export interface DistanceAndCourse {
  readonly distance: NauticalMiles;
  readonly initialTrueCourse: TrueCourse;
  readonly trace: CalculationTrace;
}

/**
 * Calculates a spherical great-circle distance and initial bearing. This is not
 * a substitute for drawing a course line on a sectional chart.
 */
export const calculateGreatCircleDistanceAndInitialCourse = (
  start: Coordinate,
  end: Coordinate,
): DomainResult<DistanceAndCourse> => {
  const distinct = requireDistinctCoordinates(start, end);
  if (!distinct.ok) return propagateFailure(distinct);

  const startLatitude = degreesToRadians(start.latitude);
  const endLatitude = degreesToRadians(end.latitude);
  const deltaLatitude = endLatitude - startLatitude;
  const deltaLongitude = degreesToRadians(end.longitude - start.longitude);
  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(deltaLongitude / 2) ** 2;
  const centralAngle = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));

  // An exact antipode has infinitely many initial courses.
  if (Math.abs(Math.PI - centralAngle) < 1e-12) {
    return failure("ANTIPODAL_COORDINATES", "Initial true course is undefined for antipodal route endpoints.");
  }

  const y = Math.sin(deltaLongitude) * Math.cos(endLatitude);
  const x =
    Math.cos(startLatitude) * Math.sin(endLatitude) -
    Math.sin(startLatitude) * Math.cos(endLatitude) * Math.cos(deltaLongitude);
  const initialBearing = radiansToDegrees(Math.atan2(y, x));
  const checkedCourse = trueCourse(initialBearing);
  if (!checkedCourse.ok) return propagateFailure(checkedCourse);
  const checkedDistance = nauticalMiles(MEAN_EARTH_RADIUS_NAUTICAL_MILES * centralAngle);
  if (!checkedDistance.ok) return propagateFailure(checkedDistance);

  return success({
    distance: checkedDistance.value,
    initialTrueCourse: checkedCourse.value,
    trace: trace(
      "great-circle-distance-and-initial-true-course",
      [
        { name: "start latitude", value: start.latitude, unit: "degrees" },
        { name: "start longitude", value: start.longitude, unit: "degrees" },
        { name: "end latitude", value: end.latitude, unit: "degrees" },
        { name: "end longitude", value: end.longitude, unit: "degrees" },
      ],
      [
        { name: "central angle", value: centralAngle, unit: "unitless" },
        { name: "initial bearing before normalization", value: initialBearing, unit: "degrees-true" },
      ],
      { name: "distance", value: checkedDistance.value, unit: "nautical-miles" },
    ),
  });
};

/** Returns the destination after traveling a distance on a great-circle initial course. */
export const pointAlongGreatCircle = (
  start: Coordinate,
  initialCourse: TrueCourse,
  distance: NauticalMiles,
): DomainResult<Coordinate> => {
  const angularDistance = distance / MEAN_EARTH_RADIUS_NAUTICAL_MILES;
  const bearing = degreesToRadians(initialCourse);
  const startLatitude = degreesToRadians(start.latitude);
  const startLongitude = degreesToRadians(start.longitude);
  const endLatitude = Math.asin(
    Math.sin(startLatitude) * Math.cos(angularDistance) +
      Math.cos(startLatitude) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const endLongitude =
    startLongitude +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(startLatitude),
      Math.cos(angularDistance) - Math.sin(startLatitude) * Math.sin(endLatitude),
    );
  const normalizedLongitude = ((radiansToDegrees(endLongitude) + 540) % 360) - 180;
  return coordinate(radiansToDegrees(endLatitude), normalizedLongitude);
};
