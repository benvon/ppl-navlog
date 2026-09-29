import { calculateGreatCircleDistanceAndInitialCourse, pointAlongGreatCircle } from "../domain/distance-course";
import { coordinate, type Coordinate } from "../domain/coordinates";
import { failure, propagateFailure, success, type DomainResult } from "../domain/errors";
import type { RouteDefinition, RoutePoint, UserRouteLeg } from "../domain/route";
import { feetMsl, nauticalMiles, positiveKnots, trueCourse } from "../domain/units";
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

export interface ForwardVerticalWaypointInput {
  readonly route: PreparedPilotRoute;
  readonly kind: "estimated-toc" | "estimated-transition-end";
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

/** Places a TOC or transition end by consuming estimated time along charted legs in forward order. */
export const estimateForwardVerticalWaypoint = (
  input: ForwardVerticalWaypointInput,
): DomainResult<PreparedWaypoint> => {
  const { route } = input;
  if (!input.id || !input.label) return invalidRoute("Generated vertical waypoint requires an ID and label.");
  if (!Number.isFinite(input.startRouteDistanceNauticalMiles) || input.startRouteDistanceNauticalMiles < 0 ||
      input.startRouteDistanceNauticalMiles > route.totalRouteDistanceNauticalMiles) {
    return invalidRoute("Vertical waypoint start distance must lie on the prepared route.", {
      startRouteDistanceNauticalMiles: input.startRouteDistanceNauticalMiles,
      totalRouteDistanceNauticalMiles: route.totalRouteDistanceNauticalMiles,
    });
  }
  const startAltitude = feetMsl(input.startingAltitudeFeetMsl);
  if (!startAltitude.ok) return propagateFailure(startAltitude);
  const targetAltitude = feetMsl(input.targetAltitudeFeetMsl);
  if (!targetAltitude.ok) return propagateFailure(targetAltitude);
  const altitudeDifference = Math.abs(targetAltitude.value - startAltitude.value);
  if (altitudeDifference === 0 || (input.kind === "estimated-toc" && targetAltitude.value <= startAltitude.value)) {
    return failure("INVALID_PHASE_ALTITUDES", input.kind === "estimated-toc"
      ? "TOC target altitude must be above the starting altitude."
      : "Transition end altitude must differ from the starting altitude.", {
      startingAltitudeFeetMsl: startAltitude.value,
      targetAltitudeFeetMsl: targetAltitude.value,
    });
  }
  const rate = validPositive(input.verticalRateFeetPerMinute, "vertical rate");
  if (!rate.ok) return propagateFailure(rate);
  const tas = positiveKnots(input.trueAirspeedKnots);
  if (!tas.ok) return propagateFailure(tas);
  const duration = altitudeDifference / rate.value;
  if (!Number.isFinite(duration) || duration <= 0) return failure("NON_FINITE_RESULT", "Vertical waypoint duration is not usable.");

  let remainingMinutes = duration;
  let estimatedDistance = 0;
  let cursorDistance = input.startRouteDistanceNauticalMiles;
  let placedLeg: PreparedPilotLeg | undefined;
  let placedCoordinate: Coordinate | undefined;
  for (const leg of route.legs) {
    if (leg.routeEndDistanceNauticalMiles <= cursorDistance) continue;
    if (remainingMinutes <= 0) break;
    const segmentStart = Math.max(cursorDistance, leg.routeStartDistanceNauticalMiles);
    const availableDistance = leg.routeEndDistanceNauticalMiles - segmentStart;
    if (availableDistance <= 0) continue;
    const course = trueCourse(leg.trueCourseDegrees);
    if (!course.ok) return propagateFailure(course);
    const triangle = solveWindTriangle(course.value, tas.value, input.planningWind);
    if (!triangle.ok) return propagateFailure(triangle);
    const segmentMinutes = (availableDistance / triangle.value.groundspeed) * 60;
    const traveled = Math.min(availableDistance, triangle.value.groundspeed * remainingMinutes / 60);
    estimatedDistance += traveled;
    if (remainingMinutes <= segmentMinutes) {
      const positionDistance = nauticalMiles(segmentStart - leg.routeStartDistanceNauticalMiles + traveled);
      if (!positionDistance.ok) return propagateFailure(positionDistance);
      const position = pointAlongGreatCircle(leg.start, course.value, positionDistance.value);
      if (!position.ok) return propagateFailure(position);
      placedLeg = leg;
      placedCoordinate = position.value;
      cursorDistance = segmentStart + traveled;
      remainingMinutes = 0;
      break;
    }
    remainingMinutes -= segmentMinutes;
    cursorDistance = leg.routeEndDistanceNauticalMiles;
  }
  if (remainingMinutes > 1e-10 || placedLeg === undefined || placedCoordinate === undefined) {
    return invalidRoute(`${input.label} estimate extends beyond the prepared route.`, {
      startRouteDistanceNauticalMiles: input.startRouteDistanceNauticalMiles,
      estimatedDistanceNauticalMiles: estimatedDistance,
      totalRouteDistanceNauticalMiles: route.totalRouteDistanceNauticalMiles,
    });
  }
  const routeDistance = nauticalMiles(cursorDistance);
  if (!routeDistance.ok) return propagateFailure(routeDistance);
  return success({
    id: input.id,
    kind: input.kind,
    label: input.label,
    coordinate: placedCoordinate,
    routeDistanceNauticalMiles: routeDistance.value,
    sourceLegId: placedLeg.sourceLeg.id,
    placement: {
      altitudeDifferenceFeet: altitudeDifference,
      verticalRateFeetPerMinute: rate.value,
      trueAirspeedKnots: tas.value,
      planningWind: input.planningWind,
      estimatedDurationMinutes: duration,
      estimatedDistanceNauticalMiles: estimatedDistance,
      formulaId: "vertical-rate-groundspeed-distance",
      sourceLegId: placedLeg.sourceLeg.id,
    },
  });
};

/** Estimates TOD once from the final charted course, then locates it forward on route geometry. */
export const estimateTopOfDescent = (input: TopOfDescentInput): DomainResult<PreparedWaypoint> => {
  const { route, currentWaypoint } = input;
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
  const rate = validPositive(input.descentRateFeetPerMinute, "descent rate");
  if (!rate.ok) return propagateFailure(rate);
  const tas = positiveKnots(input.descentTrueAirspeedKnots);
  if (!tas.ok) return propagateFailure(tas);
  if (!Number.isFinite(currentWaypoint.routeDistanceNauticalMiles) || currentWaypoint.routeDistanceNauticalMiles < 0 ||
      currentWaypoint.routeDistanceNauticalMiles > route.totalRouteDistanceNauticalMiles) {
    return invalidRoute("Current waypoint distance must lie on the prepared route.", {
      waypointId: currentWaypoint.id,
      waypointDistanceNauticalMiles: currentWaypoint.routeDistanceNauticalMiles,
      totalRouteDistanceNauticalMiles: route.totalRouteDistanceNauticalMiles,
    });
  }
  const finalLeg = route.legs[route.legs.length - 1];
  if (finalLeg === undefined) return invalidRoute("TOD requires a prepared route with a final charted leg.");
  const course = trueCourse(finalLeg.trueCourseDegrees);
  if (!course.ok) return propagateFailure(course);
  const triangle = solveWindTriangle(course.value, tas.value, input.planningWind);
  if (!triangle.ok) return propagateFailure(triangle);
  const duration = (cruiseAltitude.value - patternAltitude.value) / rate.value;
  const descentDistance = triangle.value.groundspeed * duration / 60;
  if (!Number.isFinite(descentDistance) || descentDistance <= 0) {
    return failure("NON_FINITE_RESULT", "TOD descent distance is not usable.");
  }
  const candidateDistance = route.totalRouteDistanceNauticalMiles - descentDistance;
  if (candidateDistance < 0) {
    return invalidRoute(`Estimated TOD descent distance ${distanceLabel(descentDistance)} exceeds total route distance ${distanceLabel(route.totalRouteDistanceNauticalMiles)}. Review the selected cruise altitude, descent performance, or route.`, {
      descentDistanceNauticalMiles: descentDistance,
      totalRouteDistanceNauticalMiles: route.totalRouteDistanceNauticalMiles,
    });
  }
  if (candidateDistance < currentWaypoint.routeDistanceNauticalMiles) {
    const candidateLabel = distanceLabel(candidateDistance);
    const currentLabel = distanceLabel(currentWaypoint.routeDistanceNauticalMiles);
    if (currentWaypoint.kind === "estimated-toc") {
      return invalidRoute(`Estimated TOC at ${currentLabel} and TOD at ${candidateLabel} overlap on the route. Review the selected cruise altitude, climb/descent performance, or route.`, {
        waypointId: currentWaypoint.id,
        currentWaypointDistanceNauticalMiles: currentWaypoint.routeDistanceNauticalMiles,
        todDistanceNauticalMiles: candidateDistance,
      });
    }
    return invalidRoute(`TOD is calculated to be before final waypoint ${currentWaypoint.label} (estimated TOD at ${candidateLabel}; waypoint at ${currentLabel}). Review the waypoint position, selected cruise altitude, descent performance, or route.`, {
      waypointId: currentWaypoint.id,
      currentWaypointDistanceNauticalMiles: currentWaypoint.routeDistanceNauticalMiles,
      todDistanceNauticalMiles: candidateDistance,
    });
  }
  let locatedLeg: PreparedPilotLeg | undefined;
  for (const leg of route.legs) {
    if (candidateDistance <= leg.routeEndDistanceNauticalMiles) {
      locatedLeg = leg;
      break;
    }
  }
  if (locatedLeg === undefined) return invalidRoute("Estimated TOD could not be located on the prepared route.", { todDistanceNauticalMiles: candidateDistance });
  const legOffset = nauticalMiles(candidateDistance - locatedLeg.routeStartDistanceNauticalMiles);
  if (!legOffset.ok) return propagateFailure(legOffset);
  const locatedCourse = trueCourse(locatedLeg.trueCourseDegrees);
  if (!locatedCourse.ok) return propagateFailure(locatedCourse);
  const position = pointAlongGreatCircle(locatedLeg.start, locatedCourse.value, legOffset.value);
  if (!position.ok) return propagateFailure(position);
  const routeDistance = nauticalMiles(candidateDistance);
  if (!routeDistance.ok) return propagateFailure(routeDistance);
  return success({
    id: "estimated-tod",
    kind: "estimated-tod",
    label: "TOD",
    coordinate: position.value,
    routeDistanceNauticalMiles: routeDistance.value,
    sourceLegId: locatedLeg.sourceLeg.id,
    placement: {
      altitudeDifferenceFeet: cruiseAltitude.value - patternAltitude.value,
      verticalRateFeetPerMinute: rate.value,
      trueAirspeedKnots: tas.value,
      planningWind: input.planningWind,
      estimatedDurationMinutes: duration,
      estimatedDistanceNauticalMiles: descentDistance,
      formulaId: "route-total-minus-final-course-descent-distance",
      sourceLegId: finalLeg.sourceLeg.id,
    },
  });
};

const generatedWaypointKindOrder: Readonly<Record<PreparedWaypoint["kind"], number>> = {
  departure: 0,
  "pilot-checkpoint": 0,
  "estimated-toc": 1,
  "estimated-transition-end": 2,
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

interface PreparedWaypointTransition {
  readonly startPointId: string;
  readonly end: PreparedWaypoint;
  readonly nextPilotPointId: string;
}

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

const compareWaypointEntries = (left: WaypointOrderEntry, right: WaypointOrderEntry): number => {
  const distanceDifference = left.waypoint.routeDistanceNauticalMiles - right.waypoint.routeDistanceNauticalMiles;
  if (distanceDifference !== 0) return distanceDifference;
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

const findTransitionPilotPoints = (
  route: PreparedPilotRoute,
  transition: PreparedWaypointTransition,
): DomainResult<{ readonly start: PreparedPilotPoint; readonly next: PreparedPilotPoint }> => {
  const startIndex = route.pilotPoints.findIndex(({ point }) => point.id === transition.startPointId);
  const start = route.pilotPoints[startIndex];
  const next = route.pilotPoints.find(({ point }) => point.id === transition.nextPilotPointId);
  const actualNext = startIndex >= 0 ? route.pilotPoints[startIndex + 1] : undefined;
  if (start === undefined || next === undefined || actualNext === undefined) {
    return invalidRoute(`Transition ${transition.end.label} must reference a pilot point and its following route checkpoint.`, {
      transitionEndId: transition.end.id,
      startPointId: transition.startPointId,
      nextPilotPointId: transition.nextPilotPointId,
    });
  }
  if (next.point.id !== actualNext.point.id) {
    return invalidRoute(
      `Transition from ${start.point.name} identifies ${next.point.name} at ${distanceLabel(next.routeDistanceNauticalMiles)} as its next checkpoint, but ${actualNext.point.name} at ${distanceLabel(actualNext.routeDistanceNauticalMiles)} immediately follows ${start.point.name} at ${distanceLabel(start.routeDistanceNauticalMiles)}. Correct the checkpoint selection or route.`,
      {
        startPointId: transition.startPointId,
        startPointLabel: start.point.name,
        startPointDistanceNauticalMiles: start.routeDistanceNauticalMiles,
        nextPilotPointId: transition.nextPilotPointId,
        nextPilotPointLabel: next.point.name,
        nextPilotPointDistanceNauticalMiles: next.routeDistanceNauticalMiles,
        actualNextPilotPointId: actualNext.point.id,
        actualNextPilotPointLabel: actualNext.point.name,
        actualNextPilotPointDistanceNauticalMiles: actualNext.routeDistanceNauticalMiles,
      },
    );
  }
  return success({ start, next });
};

/** Rejects estimated climb/descent geometry that cannot be ordered on the prepared route. */
export const validateWaypointGeometry = (input: {
  readonly route: PreparedPilotRoute;
  readonly toc: PreparedWaypoint;
  readonly tod: PreparedWaypoint;
  readonly transitions: readonly PreparedWaypointTransition[];
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

  for (const transition of input.transitions) {
    const endDistance = validateDistance(transition.end);
    if (!endDistance.ok) return endDistance;
    const pilotPoints = findTransitionPilotPoints(input.route, transition);
    if (!pilotPoints.ok) return propagateFailure(pilotPoints);
    const { start, next } = pilotPoints.value;
    if (start.routeDistanceNauticalMiles >= next.routeDistanceNauticalMiles) {
      return invalidRoute(`Transition ${transition.end.label} must start before its next pilot checkpoint. Review the authored route order.`, {
        startPointId: transition.startPointId,
        startPointDistanceNauticalMiles: start.routeDistanceNauticalMiles,
        nextPilotPointId: transition.nextPilotPointId,
        nextPilotPointDistanceNauticalMiles: next.routeDistanceNauticalMiles,
      });
    }
    if (transition.end.routeDistanceNauticalMiles <= start.routeDistanceNauticalMiles) {
      return invalidRoute(
        `Transition ${transition.end.label} at ${distanceLabel(transition.end.routeDistanceNauticalMiles)} must follow ${start.point.name} at ${distanceLabel(start.routeDistanceNauticalMiles)}. Revise the transition performance or route inputs.`,
        {
          transitionEndId: transition.end.id,
          transitionEndDistanceNauticalMiles: transition.end.routeDistanceNauticalMiles,
          startPointId: transition.startPointId,
          startPointDistanceNauticalMiles: start.routeDistanceNauticalMiles,
        },
      );
    }
    if (transition.end.routeDistanceNauticalMiles > next.routeDistanceNauticalMiles) {
      return invalidRoute(
        `Transition end ${transition.end.label} at ${distanceLabel(transition.end.routeDistanceNauticalMiles)} extends beyond next pilot checkpoint ${next.point.name} at ${distanceLabel(next.routeDistanceNauticalMiles)}. Choose a lower or more reachable altitude, revise performance assumptions, move the checkpoint, or revise the route.`,
        {
          transitionEndId: transition.end.id,
          transitionEndLabel: transition.end.label,
          transitionEndDistanceNauticalMiles: transition.end.routeDistanceNauticalMiles,
          nextPilotPointId: transition.nextPilotPointId,
          nextPilotPointLabel: next.point.name,
          nextPilotPointDistanceNauticalMiles: next.routeDistanceNauticalMiles,
        },
      );
    }
    if (transition.end.routeDistanceNauticalMiles > input.tod.routeDistanceNauticalMiles) {
      return invalidRoute(
        `Transition end ${transition.end.label} at ${distanceLabel(transition.end.routeDistanceNauticalMiles)} crosses estimated TOD ${input.tod.label} at ${distanceLabel(input.tod.routeDistanceNauticalMiles)}. Choose a lower or more reachable altitude, revise performance assumptions, or revise the route.`,
        {
          transitionEndId: transition.end.id,
          transitionEndLabel: transition.end.label,
          transitionEndDistanceNauticalMiles: transition.end.routeDistanceNauticalMiles,
          todWaypointId: input.tod.id,
          todWaypointLabel: input.tod.label,
          todDistanceNauticalMiles: input.tod.routeDistanceNauticalMiles,
        },
      );
    }
  }

  return success(true);
};
