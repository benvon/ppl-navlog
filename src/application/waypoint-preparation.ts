import { calculateGreatCircleDistanceAndInitialCourse, pointAlongGreatCircle } from "../domain/distance-course";
import { equalWithinArithmeticRoundoff } from "../domain/arithmetic-roundoff";
import { coordinate, type Coordinate } from "../domain/coordinates";
import { failure, propagateFailure, success, type DomainResult } from "../domain/errors";
import type { RouteDefinition, RoutePoint, UserRouteLeg } from "../domain/route";
import { feetMsl, nauticalMiles, positiveKnots, trueCourse, type Knots } from "../domain/units";
import type { Wind } from "../domain/wind";
import { solveWindTriangle } from "../domain/wind-triangle";

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
  readonly planningGroundspeedKnots?: number;
  readonly planningWind: Wind;
  readonly estimatedDurationMinutes: number;
  readonly estimatedDistanceNauticalMiles: number;
  readonly formulaId: string;
  readonly sourcePointId?: string;
  readonly sourceLegId?: string;
}

export interface PreparedWaypoint {
  readonly id: string;
  readonly kind: "departure" | "pilot-checkpoint" | "destination" | "estimated-toc" | "estimated-tod";
  readonly label: string;
  readonly coordinate: Coordinate;
  readonly routeDistanceNauticalMiles: number;
  readonly sourcePointId?: string;
  readonly sourceLegId?: string;
  readonly placement?: PreparedWaypointPlacement;
}

const invalidRoute = (message: string, details?: Readonly<Record<string, string | number | boolean | null>>): DomainResult<never> =>
  failure("ROUTE_GEOMETRY_ERROR", message, details);

const validatePilotRouteShape = (route: RouteDefinition): DomainResult<never> | undefined => {
  if (route.points.length < 2 || route.legs.length === 0) {
    return invalidRoute("A pilot route requires at least two points and one leg.");
  }
  if (route.legs.length !== route.points.length - 1) {
    return invalidRoute("A pilot route must have exactly one leg between each adjacent pair of points.", {
      pointCount: route.points.length,
      legCount: route.legs.length,
    });
  }
  return undefined;
};

const indexPilotRoutePoints = (route: RouteDefinition): DomainResult<Map<string, RoutePoint>> => {
  const pointById = new Map<string, RoutePoint>();
  for (const point of route.points) {
    if (!point.id || pointById.has(point.id)) {
      return invalidRoute("Pilot route point IDs must be present and unique.", { pointId: point.id });
    }
    const checkedCoordinate = coordinate(point.coordinate.latitude, point.coordinate.longitude);
    if (!checkedCoordinate.ok) return propagateFailure(checkedCoordinate);
    pointById.set(point.id, point);
  }
  return success(pointById);
};

const validatePilotRouteLegIds = (route: RouteDefinition, pointById: ReadonlyMap<string, RoutePoint>): DomainResult<never> | undefined => {
  const allIds = new Set(pointById.keys());
  for (const leg of route.legs) {
    if (!leg.id || allIds.has(leg.id)) {
      return invalidRoute("Pilot route point and leg IDs must be present and unique.", { legId: leg.id });
    }
    allIds.add(leg.id);
  }
  return undefined;
};

const preparePilotRouteLeg = (
  point: RoutePoint,
  nextPoint: RoutePoint,
  leg: UserRouteLeg,
  pointById: ReadonlyMap<string, RoutePoint>,
  accumulatedDistance: number,
): DomainResult<{ readonly preparedLeg: PreparedPilotLeg; readonly nextAccumulatedDistance: number }> => {
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
  const nextAccumulatedDistance = accumulatedDistance + geometry.value.distance;
  const endDistance = nauticalMiles(nextAccumulatedDistance);
  if (!endDistance.ok) return propagateFailure(endDistance);
  return success({
    preparedLeg: {
      sourceLeg: leg,
      start: point.coordinate,
      end: nextPoint.coordinate,
      trueCourseDegrees: geometry.value.initialTrueCourse,
      distanceNauticalMiles: geometry.value.distance,
      routeStartDistanceNauticalMiles: startDistance.value,
      routeEndDistanceNauticalMiles: endDistance.value,
    },
    nextAccumulatedDistance,
  });
};

/** Validates the pilot's ordered route and prepares its cumulative great-circle geometry. */
export const preparePilotRoute = (route: RouteDefinition): DomainResult<PreparedPilotRoute> => {
  const shapeError = validatePilotRouteShape(route);
  if (shapeError !== undefined) return shapeError;
  const pointIndex = indexPilotRoutePoints(route);
  if (!pointIndex.ok) return propagateFailure(pointIndex);
  const pointById = pointIndex.value;
  const legIdError = validatePilotRouteLegIds(route, pointById);
  if (legIdError !== undefined) return legIdError;

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
    const preparedLeg = preparePilotRouteLeg(point, nextPoint, leg, pointById, accumulatedDistance);
    if (!preparedLeg.ok) return propagateFailure(preparedLeg);
    accumulatedDistance = preparedLeg.value.nextAccumulatedDistance;
    preparedLegs.push(preparedLeg.value.preparedLeg);
  }

  const totalDistance = nauticalMiles(accumulatedDistance);
  if (!totalDistance.ok) return propagateFailure(totalDistance);
  return success({
    pilotPoints: preparedPoints,
    legs: preparedLegs,
    totalRouteDistanceNauticalMiles: totalDistance.value,
  });
};

export interface ForwardVerticalWaypointInput {
  readonly route: PreparedPilotRoute;
  readonly kind: "estimated-toc";
  readonly id: string;
  readonly label: string;
  readonly startRouteDistanceNauticalMiles: number;
  readonly startingAltitudeFeetMsl: number;
  readonly targetAltitudeFeetMsl: number;
  readonly verticalRateFeetPerMinute: number;
  readonly trueAirspeedKnots: number;
  readonly fuelFlowGallonsPerHour: number;
  readonly planningWind: Wind;
}

export interface TopOfDescentInput {
  readonly route: PreparedPilotRoute;
  readonly currentWaypoint: PreparedWaypoint;
  readonly cruiseAltitudeFeetMsl: number;
  readonly patternAltitudeFeetMsl: number;
  readonly descentRateFeetPerMinute: number;
  readonly descentTrueAirspeedKnots: number;
  readonly descentFuelFlowGallonsPerHour: number;
  readonly planningWind: Wind;
}

const validPositive = (value: number, field: string): DomainResult<number> => {
  if (!Number.isFinite(value)) return failure("INVALID_NUMBER", `${field} must be a finite number.`, { field, value: String(value) });
  if (value <= 0) return failure("OUT_OF_RANGE", `${field} must be greater than zero.`, { field, value });
  return success(value);
};

const distanceLabel = (distance: number): string => `NM ${Math.round(distance)}`;
const preciseDistance = (distance: number): string => distance.toFixed(2);

// Great-circle coordinates accept 1e-12 degree equality. Convert that angular
// precision to route distance, then also cover accumulated IEEE-754 arithmetic.
const GREAT_CIRCLE_COORDINATE_ROUNDOFF_NM = 2 * Math.PI * 3440.065 * 1e-12 / 360;
const equalWithinAccumulatedRouteRoundoff = (left: number, right: number): boolean =>
  equalWithinArithmeticRoundoff(left, right) ||
  (Number.isFinite(left) && Number.isFinite(right) &&
    Math.abs(left - right) <= Math.max(GREAT_CIRCLE_COORDINATE_ROUNDOFF_NM, Number.EPSILON * 128 * Math.max(1, Math.abs(left), Math.abs(right))));

interface TodAltitudes {
  readonly cruiseAltitudeFeetMsl: number;
  readonly patternAltitudeFeetMsl: number;
}

const validateTodAltitudes = (input: TopOfDescentInput): DomainResult<TodAltitudes> => {
  const cruiseAltitude = feetMsl(input.cruiseAltitudeFeetMsl);
  if (!cruiseAltitude.ok) return propagateFailure(cruiseAltitude);
  const patternAltitude = feetMsl(input.patternAltitudeFeetMsl);
  if (!patternAltitude.ok) return propagateFailure(patternAltitude);
  if (cruiseAltitude.value <= patternAltitude.value) {
    return failure("INVALID_PHASE_ALTITUDES", "Cruise altitude must be above the selected pattern altitude for TOD estimation.", {
      cruiseAltitudeFeetMsl: cruiseAltitude.value,
      patternAltitudeFeetMsl: patternAltitude.value,
    });
  }
  return success({ cruiseAltitudeFeetMsl: cruiseAltitude.value, patternAltitudeFeetMsl: patternAltitude.value });
};

const validateCurrentWaypointDistance = (input: TopOfDescentInput): DomainResult<never> | undefined => {
  const distance = input.currentWaypoint.routeDistanceNauticalMiles;
  if (!Number.isFinite(distance) || distance < 0 || distance > input.route.totalRouteDistanceNauticalMiles) {
    return invalidRoute("Current waypoint distance must lie on the prepared route.", {
      waypointId: input.currentWaypoint.id,
      waypointDistanceNauticalMiles: distance,
      totalRouteDistanceNauticalMiles: input.route.totalRouteDistanceNauticalMiles,
    });
  }
  return undefined;
};

interface TodDescentEstimate {
  readonly finalLeg: PreparedPilotLeg;
  readonly durationMinutes: number;
  readonly descentDistanceNauticalMiles: number;
  readonly planningGroundspeedKnots: number;
  readonly candidateDistanceNauticalMiles: number;
}

interface ValidatedTodDescentPerformance {
  readonly verticalRateFeetPerMinute: number;
  readonly trueAirspeedKnots: Knots;
}

const validateTodDescentPerformance = (input: TopOfDescentInput): DomainResult<ValidatedTodDescentPerformance> => {
  const rate = validPositive(input.descentRateFeetPerMinute, "descent rate");
  if (!rate.ok) return propagateFailure(rate);
  const tas = positiveKnots(input.descentTrueAirspeedKnots);
  if (!tas.ok) return propagateFailure(tas);
  return success({ verticalRateFeetPerMinute: rate.value, trueAirspeedKnots: tas.value });
};

const estimateTodDescentDistance = (
  input: TopOfDescentInput,
  altitudes: TodAltitudes,
  performance: ValidatedTodDescentPerformance,
): DomainResult<TodDescentEstimate> => {
  const finalLeg = input.route.legs[input.route.legs.length - 1];
  if (finalLeg === undefined) return invalidRoute("TOD requires a prepared route with a final charted leg.");
  const course = trueCourse(finalLeg.trueCourseDegrees);
  if (!course.ok) return propagateFailure(course);
  const triangle = solveWindTriangle(course.value, performance.trueAirspeedKnots, input.planningWind);
  if (!triangle.ok) return propagateFailure(triangle);
  const durationMinutes = (altitudes.cruiseAltitudeFeetMsl - altitudes.patternAltitudeFeetMsl) / performance.verticalRateFeetPerMinute;
  const descentDistanceNauticalMiles = triangle.value.groundspeed * durationMinutes / 60;
  if (!Number.isFinite(descentDistanceNauticalMiles) || descentDistanceNauticalMiles <= 0) {
    return failure("NON_FINITE_RESULT", "TOD descent distance is not usable.");
  }
  const calculatedDistance = input.route.totalRouteDistanceNauticalMiles - descentDistanceNauticalMiles;
  const anchors = [
    input.currentWaypoint.routeDistanceNauticalMiles,
    ...input.route.pilotPoints.map(({ routeDistanceNauticalMiles }) => routeDistanceNauticalMiles),
  ];
  const candidateDistanceNauticalMiles = anchors.find((distance) =>
    equalWithinAccumulatedRouteRoundoff(calculatedDistance, distance)) ?? calculatedDistance;
  return success({
    finalLeg,
    durationMinutes,
    descentDistanceNauticalMiles,
    planningGroundspeedKnots: triangle.value.groundspeed,
    candidateDistanceNauticalMiles,
  });
};

const validateTodCandidateDistance = (
  input: TopOfDescentInput,
  estimate: TodDescentEstimate,
): DomainResult<never> | undefined => {
  const { candidateDistanceNauticalMiles: candidateDistance, descentDistanceNauticalMiles: descentDistance } = estimate;
  if (candidateDistance < 0) {
    return invalidRoute(`Estimated TOD descent distance ${distanceLabel(descentDistance)} exceeds total route distance ${distanceLabel(input.route.totalRouteDistanceNauticalMiles)}. Review the selected cruise altitude, descent performance, or route.`, {
      descentDistanceNauticalMiles: descentDistance,
      totalRouteDistanceNauticalMiles: input.route.totalRouteDistanceNauticalMiles,
    });
  }
  if (candidateDistance < input.currentWaypoint.routeDistanceNauticalMiles) {
    const candidateLabel = distanceLabel(candidateDistance);
    const currentLabel = distanceLabel(input.currentWaypoint.routeDistanceNauticalMiles);
    if (input.currentWaypoint.kind === "estimated-toc") {
      return invalidRoute(`Estimated TOC at ${currentLabel} and TOD at ${candidateLabel} overlap on the route. Review the selected cruise altitude, climb/descent performance, or route.`, {
        waypointId: input.currentWaypoint.id,
        currentWaypointDistanceNauticalMiles: input.currentWaypoint.routeDistanceNauticalMiles,
        todDistanceNauticalMiles: candidateDistance,
      });
    }
    return invalidRoute(`TOD is calculated to be before final waypoint ${input.currentWaypoint.label} (estimated TOD at ${candidateLabel}; waypoint at ${currentLabel}). Review the waypoint position, selected cruise altitude, descent performance, or route.`, {
      waypointId: input.currentWaypoint.id,
      currentWaypointDistanceNauticalMiles: input.currentWaypoint.routeDistanceNauticalMiles,
      todDistanceNauticalMiles: candidateDistance,
    });
  }
  return undefined;
};

interface LocatedTod {
  readonly leg: PreparedPilotLeg;
  readonly coordinate: Coordinate;
  readonly routeDistanceNauticalMiles: number;
}

const locateTodOnRoute = (route: PreparedPilotRoute, candidateDistance: number): DomainResult<LocatedTod> => {
  let locatedLeg: PreparedPilotLeg | undefined;
  for (const leg of route.legs) {
    if (candidateDistance <= leg.routeEndDistanceNauticalMiles) {
      locatedLeg = leg;
      break;
    }
  }
  if (locatedLeg === undefined) return invalidRoute("Estimated TOD could not be located on the prepared route.", { todDistanceNauticalMiles: candidateDistance });
  if (candidateDistance === locatedLeg.routeStartDistanceNauticalMiles) {
    return success({ leg: locatedLeg, coordinate: locatedLeg.start, routeDistanceNauticalMiles: candidateDistance });
  }
  if (candidateDistance === locatedLeg.routeEndDistanceNauticalMiles) {
    return success({ leg: locatedLeg, coordinate: locatedLeg.end, routeDistanceNauticalMiles: candidateDistance });
  }
  const legOffset = nauticalMiles(candidateDistance - locatedLeg.routeStartDistanceNauticalMiles);
  if (!legOffset.ok) return propagateFailure(legOffset);
  const locatedCourse = trueCourse(locatedLeg.trueCourseDegrees);
  if (!locatedCourse.ok) return propagateFailure(locatedCourse);
  const position = pointAlongGreatCircle(locatedLeg.start, locatedCourse.value, legOffset.value);
  if (!position.ok) return propagateFailure(position);
  return success({ leg: locatedLeg, coordinate: position.value, routeDistanceNauticalMiles: candidateDistance });
};

interface ValidatedForwardVerticalWaypointInput {
  readonly altitudeDifferenceFeet: number;
  readonly verticalRateFeetPerMinute: number;
  readonly trueAirspeedKnots: Knots;
  readonly durationMinutes: number;
}

const validateForwardWaypointIdentityAndStart = (input: ForwardVerticalWaypointInput): DomainResult<never> | undefined => {
  if (!input.id || !input.label) return invalidRoute("Generated vertical waypoint requires an ID and label.");
  if (!Number.isFinite(input.startRouteDistanceNauticalMiles) || input.startRouteDistanceNauticalMiles < 0 ||
      input.startRouteDistanceNauticalMiles > input.route.totalRouteDistanceNauticalMiles) {
    return invalidRoute("Vertical waypoint start distance must lie on the prepared route.", {
      startRouteDistanceNauticalMiles: input.startRouteDistanceNauticalMiles,
      totalRouteDistanceNauticalMiles: input.route.totalRouteDistanceNauticalMiles,
    });
  }
  return undefined;
};

const getVerticalAltitudeDifference = (input: ForwardVerticalWaypointInput): DomainResult<number> => {
  const startAltitude = feetMsl(input.startingAltitudeFeetMsl);
  if (!startAltitude.ok) return propagateFailure(startAltitude);
  const targetAltitude = feetMsl(input.targetAltitudeFeetMsl);
  if (!targetAltitude.ok) return propagateFailure(targetAltitude);
  const altitudeDifferenceFeet = Math.abs(targetAltitude.value - startAltitude.value);
  if (altitudeDifferenceFeet === 0 || (input.kind === "estimated-toc" && targetAltitude.value <= startAltitude.value)) {
    return failure("INVALID_PHASE_ALTITUDES", input.kind === "estimated-toc"
      ? "TOC target altitude must be above the starting altitude."
      : "Transition end altitude must differ from the starting altitude.", {
      startingAltitudeFeetMsl: startAltitude.value,
      targetAltitudeFeetMsl: targetAltitude.value,
    });
  }
  return success(altitudeDifferenceFeet);
};

const estimateVerticalDuration = (altitudeDifferenceFeet: number, input: ForwardVerticalWaypointInput): DomainResult<{
  readonly verticalRateFeetPerMinute: number;
  readonly trueAirspeedKnots: Knots;
  readonly durationMinutes: number;
}> => {
  const rate = validPositive(input.verticalRateFeetPerMinute, "vertical rate");
  if (!rate.ok) return propagateFailure(rate);
  const tas = positiveKnots(input.trueAirspeedKnots);
  if (!tas.ok) return propagateFailure(tas);
  const durationMinutes = altitudeDifferenceFeet / rate.value;
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return failure("NON_FINITE_RESULT", "Vertical waypoint duration is not usable.");
  }
  return success({ verticalRateFeetPerMinute: rate.value, trueAirspeedKnots: tas.value, durationMinutes });
};

const validateForwardVerticalWaypointInput = (
  input: ForwardVerticalWaypointInput,
): DomainResult<ValidatedForwardVerticalWaypointInput> => {
  const identityError = validateForwardWaypointIdentityAndStart(input);
  if (identityError !== undefined) return identityError;
  const altitudeDifference = getVerticalAltitudeDifference(input);
  if (!altitudeDifference.ok) return propagateFailure(altitudeDifference);
  const duration = estimateVerticalDuration(altitudeDifference.value, input);
  if (!duration.ok) return propagateFailure(duration);
  return success({ altitudeDifferenceFeet: altitudeDifference.value, ...duration.value });
};

interface LocatedForwardVerticalWaypoint {
  readonly leg: PreparedPilotLeg;
  readonly coordinate: Coordinate;
  readonly routeDistanceNauticalMiles: number;
  readonly estimatedDistanceNauticalMiles: number;
}

type ForwardVerticalLegEstimate =
  | { readonly kind: "skip" }
  | { readonly kind: "traverse"; readonly traveled: number; readonly segmentMinutes: number }
  | { readonly kind: "placed"; readonly traveled: number; readonly coordinate: Coordinate; readonly routeDistanceNauticalMiles: number };

const estimateForwardVerticalLeg = (
  leg: PreparedPilotLeg,
  cursorDistance: number,
  remainingMinutes: number,
  trueAirspeedKnots: Knots,
  planningWind: Wind,
): DomainResult<ForwardVerticalLegEstimate> => {
  const segmentStart = Math.max(cursorDistance, leg.routeStartDistanceNauticalMiles);
  const availableDistance = leg.routeEndDistanceNauticalMiles - segmentStart;
  if (availableDistance <= 0) return success({ kind: "skip" });
  const course = trueCourse(leg.trueCourseDegrees);
  if (!course.ok) return propagateFailure(course);
  const triangle = solveWindTriangle(course.value, trueAirspeedKnots, planningWind);
  if (!triangle.ok) return propagateFailure(triangle);
  const segmentMinutes = (availableDistance / triangle.value.groundspeed) * 60;
  const traveled = Math.min(availableDistance, triangle.value.groundspeed * remainingMinutes / 60);
  const reachesEndpoint = equalWithinArithmeticRoundoff(remainingMinutes, segmentMinutes);
  if (remainingMinutes > segmentMinutes && !reachesEndpoint) {
    return success({ kind: "traverse", traveled, segmentMinutes });
  }
  if (reachesEndpoint) {
    return success({
      kind: "placed",
      traveled: availableDistance,
      coordinate: leg.end,
      routeDistanceNauticalMiles: leg.routeEndDistanceNauticalMiles,
    });
  }
  const positionDistance = nauticalMiles(segmentStart - leg.routeStartDistanceNauticalMiles + traveled);
  if (!positionDistance.ok) return propagateFailure(positionDistance);
  const position = pointAlongGreatCircle(leg.start, course.value, positionDistance.value);
  if (!position.ok) return propagateFailure(position);
  return success({ kind: "placed", traveled, coordinate: position.value, routeDistanceNauticalMiles: segmentStart + traveled });
};

const forwardVerticalOverflowFailure = (
  input: ForwardVerticalWaypointInput,
  traveledDistanceNauticalMiles: number,
  remainingPhaseTimeMinutes: number,
): DomainResult<never> => {
  const { route } = input;
  const destination = route.pilotPoints[route.pilotPoints.length - 1]?.point;
  const availableDistance = route.totalRouteDistanceNauticalMiles - input.startRouteDistanceNauticalMiles;
  return invalidRoute(
    `${input.label} estimate extends beyond destination ${destination?.name ?? "route endpoint"} at ${distanceLabel(route.totalRouteDistanceNauticalMiles)}. The route provides ${preciseDistance(availableDistance)} NM from the start point; ${preciseDistance(traveledDistanceNauticalMiles)} NM can be traveled before the destination, with ${preciseDistance(remainingPhaseTimeMinutes)} minutes remaining in the phase. Review the target altitude, vertical performance, or route.`,
    {
      startRouteDistanceNauticalMiles: input.startRouteDistanceNauticalMiles,
      destinationPointId: destination?.id ?? null,
      destinationPointName: destination?.name ?? null,
      destinationRouteDistanceNauticalMiles: route.totalRouteDistanceNauticalMiles,
      availableDistanceNauticalMiles: availableDistance,
      traveledDistanceNauticalMiles,
      remainingPhaseTimeMinutes,
      totalRouteDistanceNauticalMiles: route.totalRouteDistanceNauticalMiles,
    },
  );
};

const locateForwardVerticalWaypoint = (
  input: ForwardVerticalWaypointInput,
  durationMinutes: number,
  trueAirspeedKnots: Knots,
): DomainResult<LocatedForwardVerticalWaypoint> => {
  const { route } = input;
  let remainingMinutes = durationMinutes;
  let estimatedDistance = 0;
  let cursorDistance = input.startRouteDistanceNauticalMiles;
  let placedLeg: PreparedPilotLeg | undefined;
  let placedCoordinate: Coordinate | undefined;
  for (const leg of route.legs) {
    if (leg.routeEndDistanceNauticalMiles <= cursorDistance) continue;
    if (remainingMinutes <= 0) break;
    const segment = estimateForwardVerticalLeg(leg, cursorDistance, remainingMinutes, trueAirspeedKnots, input.planningWind);
    if (!segment.ok) return propagateFailure(segment);
    if (segment.value.kind === "skip") continue;
    estimatedDistance += segment.value.traveled;
    if (segment.value.kind === "placed") {
      placedLeg = leg;
      placedCoordinate = segment.value.coordinate;
      cursorDistance = segment.value.routeDistanceNauticalMiles;
      remainingMinutes = 0;
      break;
    }
    remainingMinutes -= segment.value.segmentMinutes;
    cursorDistance = leg.routeEndDistanceNauticalMiles;
  }
  if ((remainingMinutes > 0 && !equalWithinArithmeticRoundoff(remainingMinutes, 0)) ||
      placedLeg === undefined || placedCoordinate === undefined) {
    return forwardVerticalOverflowFailure(input, estimatedDistance, remainingMinutes);
  }
  return success({
    leg: placedLeg,
    coordinate: placedCoordinate,
    routeDistanceNauticalMiles: cursorDistance,
    estimatedDistanceNauticalMiles: estimatedDistance,
  });
};

/** Legacy TOC estimator that consumes estimated time along charted legs in forward order. */
export const estimateForwardVerticalWaypoint = (
  input: ForwardVerticalWaypointInput,
): DomainResult<PreparedWaypoint> => {
  const validated = validateForwardVerticalWaypointInput(input);
  if (!validated.ok) return propagateFailure(validated);
  const located = locateForwardVerticalWaypoint(input, validated.value.durationMinutes, validated.value.trueAirspeedKnots);
  if (!located.ok) return propagateFailure(located);
  // Route occurrence is positional. A later visit to the same coordinates must
  // not snap a generated point to the first occurrence of that location.
  const coincidentPilot = input.route.pilotPoints.find(({ routeDistanceNauticalMiles }) =>
    equalWithinAccumulatedRouteRoundoff(located.value.routeDistanceNauticalMiles, routeDistanceNauticalMiles));
  const routeDistance = nauticalMiles(coincidentPilot?.routeDistanceNauticalMiles ?? located.value.routeDistanceNauticalMiles);
  if (!routeDistance.ok) return propagateFailure(routeDistance);
  return success({
    id: input.id,
    kind: input.kind,
    label: input.label,
    coordinate: coincidentPilot?.point.coordinate ?? located.value.coordinate,
    routeDistanceNauticalMiles: routeDistance.value,
    sourceLegId: located.value.leg.sourceLeg.id,
    placement: {
      altitudeDifferenceFeet: validated.value.altitudeDifferenceFeet,
      verticalRateFeetPerMinute: validated.value.verticalRateFeetPerMinute,
      trueAirspeedKnots: validated.value.trueAirspeedKnots,
      planningWind: input.planningWind,
      estimatedDurationMinutes: validated.value.durationMinutes,
      estimatedDistanceNauticalMiles: located.value.estimatedDistanceNauticalMiles,
      formulaId: "vertical-rate-groundspeed-distance",
      sourceLegId: located.value.leg.sourceLeg.id,
    },
  });
};

/** Estimates TOC with one wind-triangle solution on the route course at departure. */
export const estimateSingleCourseForwardWaypoint = (input: ForwardVerticalWaypointInput): DomainResult<PreparedWaypoint> => {
  const validated = validateForwardVerticalWaypointInput(input);
  if (!validated.ok) return propagateFailure(validated);
  const leg = input.route.legs.find(({ routeStartDistanceNauticalMiles, routeEndDistanceNauticalMiles }) =>
    input.startRouteDistanceNauticalMiles >= routeStartDistanceNauticalMiles && input.startRouteDistanceNauticalMiles < routeEndDistanceNauticalMiles) ?? input.route.legs.at(-1);
  if (leg === undefined) return invalidRoute("Vertical waypoint requires a charted route course at its starting point.");
  const course = trueCourse(leg.trueCourseDegrees);
  if (!course.ok) return propagateFailure(course);
  const triangle = solveWindTriangle(course.value, validated.value.trueAirspeedKnots, input.planningWind);
  if (!triangle.ok) return propagateFailure(triangle);
  const estimatedDistance = triangle.value.groundspeed * validated.value.durationMinutes / 60;
  const candidateDistance = input.startRouteDistanceNauticalMiles + estimatedDistance;
  const withinRoute = validateSingleCourseCandidate(input, candidateDistance, estimatedDistance);
  if (!withinRoute.ok) return propagateFailure(withinRoute);
  const located = locateTodOnRoute(input.route, candidateDistance);
  if (!located.ok) return propagateFailure(located);
  const coincidentPilot = input.route.pilotPoints.find(({ routeDistanceNauticalMiles }) =>
    equalWithinAccumulatedRouteRoundoff(candidateDistance, routeDistanceNauticalMiles));
  return success({
    id: input.id, kind: input.kind, label: input.label,
    coordinate: coincidentPilot?.point.coordinate ?? located.value.coordinate,
    routeDistanceNauticalMiles: coincidentPilot?.routeDistanceNauticalMiles ?? candidateDistance,
    sourceLegId: located.value.leg.sourceLeg.id,
    placement: {
      altitudeDifferenceFeet: validated.value.altitudeDifferenceFeet,
      verticalRateFeetPerMinute: validated.value.verticalRateFeetPerMinute,
      trueAirspeedKnots: validated.value.trueAirspeedKnots,
      planningGroundspeedKnots: triangle.value.groundspeed,
      planningWind: input.planningWind,
      estimatedDurationMinutes: validated.value.durationMinutes,
      estimatedDistanceNauticalMiles: estimatedDistance,
      formulaId: "initial-route-course-groundspeed-distance",
      sourceLegId: located.value.leg.sourceLeg.id,
    },
  });
};

const validateSingleCourseCandidate = (input: ForwardVerticalWaypointInput, candidate: number, distance: number): DomainResult<true> =>
  !Number.isFinite(candidate) || candidate > input.route.totalRouteDistanceNauticalMiles
    ? forwardVerticalOverflowFailure(input, distance, 0)
    : success(true);

/** Estimates TOD once from the final charted course, then locates it forward on route geometry. */
export const estimateTopOfDescent = (input: TopOfDescentInput): DomainResult<PreparedWaypoint> => {
  const altitudes = validateTodAltitudes(input);
  if (!altitudes.ok) return propagateFailure(altitudes);
  const performance = validateTodDescentPerformance(input);
  if (!performance.ok) return propagateFailure(performance);
  const currentWaypointError = validateCurrentWaypointDistance(input);
  if (currentWaypointError !== undefined) return currentWaypointError;
  const estimate = estimateTodDescentDistance(input, altitudes.value, performance.value);
  if (!estimate.ok) return propagateFailure(estimate);
  const candidateError = validateTodCandidateDistance(input, estimate.value);
  if (candidateError !== undefined) return candidateError;
  const located = locateTodOnRoute(input.route, estimate.value.candidateDistanceNauticalMiles);
  if (!located.ok) return propagateFailure(located);
  const routeDistance = nauticalMiles(located.value.routeDistanceNauticalMiles);
  if (!routeDistance.ok) return propagateFailure(routeDistance);
  return success({
    id: "estimated-tod",
    kind: "estimated-tod",
    label: "TOD",
    coordinate: located.value.coordinate,
    routeDistanceNauticalMiles: routeDistance.value,
    sourceLegId: located.value.leg.sourceLeg.id,
    placement: {
      altitudeDifferenceFeet: altitudes.value.cruiseAltitudeFeetMsl - altitudes.value.patternAltitudeFeetMsl,
      verticalRateFeetPerMinute: performance.value.verticalRateFeetPerMinute,
      trueAirspeedKnots: performance.value.trueAirspeedKnots,
      planningGroundspeedKnots: estimate.value.planningGroundspeedKnots,
      planningWind: input.planningWind,
      estimatedDurationMinutes: estimate.value.durationMinutes,
      estimatedDistanceNauticalMiles: estimate.value.descentDistanceNauticalMiles,
      formulaId: "route-total-minus-final-course-descent-distance",
      sourceLegId: estimate.value.finalLeg.sourceLeg.id,
    },
  });
};

const generatedWaypointKindOrder: Readonly<Record<PreparedWaypoint["kind"], number>> = {
  departure: 0,
  "pilot-checkpoint": 0,
  "estimated-toc": 1,
  "estimated-tod": 3,
  destination: 4,
};

interface WaypointOrderEntry {
  readonly waypoint: PreparedWaypoint;
  readonly authoredIndex?: number;
}

type PreparedWaypointSpan = {
  readonly from: PreparedWaypoint;
  readonly to: PreparedWaypoint;
  readonly sourceLegId: string;
  readonly distanceNauticalMiles: number;
};

const pilotWaypointEntries = (route: PreparedPilotRoute): WaypointOrderEntry[] => route.pilotPoints.map(
  ({ point: source, routeDistanceNauticalMiles }, index) => ({
    waypoint: {
      id: source.id,
      kind: index === 0 ? "departure" : index === route.pilotPoints.length - 1 ? "destination" : "pilot-checkpoint",
      label: source.name,
      coordinate: source.coordinate,
      routeDistanceNauticalMiles,
      sourcePointId: source.id,
    },
    authoredIndex: index,
  }),
);

const compareDestinationTie = (left: PreparedWaypoint, right: PreparedWaypoint): number => {
  if (left.kind === "destination" && right.kind !== "destination") return 1;
  if (right.kind === "destination" && left.kind !== "destination") return -1;
  return 0;
};

const compareWaypointEntries = (left: WaypointOrderEntry, right: WaypointOrderEntry): number => {
  const distanceDifference = left.waypoint.routeDistanceNauticalMiles - right.waypoint.routeDistanceNauticalMiles;
  if (distanceDifference !== 0) return distanceDifference;
  const destinationTieOrder = compareDestinationTie(left.waypoint, right.waypoint);
  if (destinationTieOrder !== 0) return destinationTieOrder;
  if (left.authoredIndex !== undefined && right.authoredIndex !== undefined) return left.authoredIndex - right.authoredIndex;
  if (left.authoredIndex !== undefined) return -1;
  if (right.authoredIndex !== undefined) return 1;
  const kindDifference = generatedWaypointKindOrder[left.waypoint.kind] - generatedWaypointKindOrder[right.waypoint.kind];
  if (kindDifference !== 0) return kindDifference;
  return left.waypoint.id < right.waypoint.id ? -1 : left.waypoint.id > right.waypoint.id ? 1 : 0;
};

const validateGeneratedWaypoint = (
  route: PreparedPilotRoute,
  waypoint: PreparedWaypoint,
  authoredIds: ReadonlySet<string>,
  seenGeneratedIds: ReadonlySet<string>,
): DomainResult<true> => {
  if (!waypoint.id || authoredIds.has(waypoint.id) || seenGeneratedIds.has(waypoint.id)) {
    return invalidRoute("Generated waypoint IDs must be present and distinct from route point IDs.", {
      waypointId: waypoint.id,
    });
  }
  if (!Number.isFinite(waypoint.routeDistanceNauticalMiles) || waypoint.routeDistanceNauticalMiles < 0 ||
      waypoint.routeDistanceNauticalMiles > route.totalRouteDistanceNauticalMiles) {
    return invalidRoute(`Generated waypoint ${waypoint.label} must lie on the prepared route.`, {
      waypointId: waypoint.id,
      waypointLabel: waypoint.label,
      waypointDistanceNauticalMiles: waypoint.routeDistanceNauticalMiles,
      totalRouteDistanceNauticalMiles: route.totalRouteDistanceNauticalMiles,
    });
  }
  return success(true);
};

const findSpanLeg = (route: PreparedPilotRoute, from: PreparedWaypoint, to: PreparedWaypoint): PreparedPilotLeg | undefined =>
  route.legs.find((leg) =>
    from.routeDistanceNauticalMiles >= leg.routeStartDistanceNauticalMiles &&
    to.routeDistanceNauticalMiles <= leg.routeEndDistanceNauticalMiles,
  );

const buildPositiveWaypointSpans = (
  route: PreparedPilotRoute,
  waypoints: readonly PreparedWaypoint[],
): DomainResult<readonly PreparedWaypointSpan[]> => {
  const spans: PreparedWaypointSpan[] = [];
  for (let index = 0; index < waypoints.length - 1; index += 1) {
    const from = waypoints[index];
    const to = waypoints[index + 1];
    if (from === undefined || to === undefined) continue;
    const distanceNauticalMiles = to.routeDistanceNauticalMiles - from.routeDistanceNauticalMiles;
    if (distanceNauticalMiles === 0) continue;
    const containingLeg = findSpanLeg(route, from, to);
    if (containingLeg === undefined) {
      return invalidRoute(
        `Unable to place the span from ${from.label} (${distanceLabel(from.routeDistanceNauticalMiles)}) to ${to.label} (${distanceLabel(to.routeDistanceNauticalMiles)}) on one charted leg. Review the waypoint positions or route.`,
        {
          fromWaypointId: from.id,
          fromWaypointDistanceNauticalMiles: from.routeDistanceNauticalMiles,
          toWaypointId: to.id,
          toWaypointDistanceNauticalMiles: to.routeDistanceNauticalMiles,
        },
      );
    }
    spans.push({ from, to, sourceLegId: containingLeg.sourceLeg.id, distanceNauticalMiles });
  }
  return success(spans);
};

/** Orders authored and estimated points, preserving coincident labels and omitting only zero-length spans. */
export const orderPreparedWaypoints = (
  route: PreparedPilotRoute,
  generated: readonly PreparedWaypoint[],
): DomainResult<{
  readonly waypoints: readonly PreparedWaypoint[];
  readonly spans: readonly PreparedWaypointSpan[];
}> => {
  const authoredIds = new Set(route.pilotPoints.map(({ point: source }) => source.id));
  const seenGeneratedIds = new Set<string>();
  const entries = pilotWaypointEntries(route);

  for (const waypoint of generated) {
    const validWaypoint = validateGeneratedWaypoint(route, waypoint, authoredIds, seenGeneratedIds);
    if (!validWaypoint.ok) return propagateFailure(validWaypoint);
    seenGeneratedIds.add(waypoint.id);
    entries.push({ waypoint });
  }

  entries.sort(compareWaypointEntries);

  const waypoints = entries.map(({ waypoint }) => waypoint);
  const spans = buildPositiveWaypointSpans(route, waypoints);
  if (!spans.ok) return propagateFailure(spans);
  return success({ waypoints, spans: spans.value });
};

/** Rejects estimated climb/descent geometry that cannot be ordered on the prepared route. */
export const validateWaypointGeometry = (input: {
  readonly route: PreparedPilotRoute;
  readonly toc: PreparedWaypoint;
  readonly tod: PreparedWaypoint;
}): DomainResult<true> => {
  const validateDistance = (waypoint: PreparedWaypoint): DomainResult<true> => {
    if (!Number.isFinite(waypoint.routeDistanceNauticalMiles) || waypoint.routeDistanceNauticalMiles < 0 ||
        waypoint.routeDistanceNauticalMiles > input.route.totalRouteDistanceNauticalMiles) {
      return invalidRoute(`Waypoint ${waypoint.label} must lie on the prepared route.`, {
        waypointId: waypoint.id,
        waypointDistanceNauticalMiles: waypoint.routeDistanceNauticalMiles,
        totalRouteDistanceNauticalMiles: input.route.totalRouteDistanceNauticalMiles,
      });
    }
    return success(true);
  };

  for (const waypoint of [input.toc, input.tod]) {
    const distanceResult = validateDistance(waypoint);
    if (!distanceResult.ok) return distanceResult;
  }
  if (input.toc.routeDistanceNauticalMiles >= input.tod.routeDistanceNauticalMiles) {
    return invalidRoute(
      `Estimated TOC ${input.toc.label} at ${distanceLabel(input.toc.routeDistanceNauticalMiles)} is at or after estimated TOD ${input.tod.label} at ${distanceLabel(input.tod.routeDistanceNauticalMiles)}, leaving no positive cruise span. Review the selected cruise altitude, climb/descent performance, or route.`,
      {
        tocWaypointId: input.toc.id,
        tocWaypointLabel: input.toc.label,
        tocDistanceNauticalMiles: input.toc.routeDistanceNauticalMiles,
        todWaypointId: input.tod.id,
        todWaypointLabel: input.tod.label,
        todDistanceNauticalMiles: input.tod.routeDistanceNauticalMiles,
      },
    );
  }

  return success(true);
};
