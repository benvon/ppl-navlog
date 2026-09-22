import { calculateGreatCircleDistanceAndInitialCourse, pointAlongGreatCircle } from "../domain/distance-course";
import { failure, propagateFailure, success, type DomainResult } from "../domain/errors";
import {
  placeGeneratedBoundary,
  type GeneratedBoundary,
  type GeneratedSubLeg,
  type RouteGeometryLeg,
} from "../domain/phase-geometry";
import {
  calculateConvergedVerticalPhase,
  type ConvergedVerticalPhase,
  type ConvergenceOptions,
  type EffectiveWindResolver,
} from "../domain/phase-planning";
import { calculateVerticalPhase, type VerticalPhaseCalculation, type VerticalPhaseKind, type VerticalPhasePerformance } from "../domain/phase-performance";
import { feetMsl, nauticalMiles, type FeetMsl, type NauticalMiles, type TrueCourse } from "../domain/units";
import type { Coordinate } from "../domain/coordinates";

/**
 * The selected altitude for one user-authored route leg. It is deliberately
 * separate from generated sublegs so a user checkpoint remains traceable after
 * phase boundaries split that leg.
 */
export interface RouteLegAltitude {
  readonly sourceLegId: string;
  readonly cruiseAltitude: FeetMsl;
}

export interface RoutePhaseAllocationInput {
  readonly route: readonly RouteGeometryLeg[];
  /** Must name every route leg once, in the same order as `route`. */
  readonly legAltitudes: readonly RouteLegAltitude[];
  /** Airport field elevation at departure, not an assumed sea-level value. */
  readonly departureAltitude: FeetMsl;
  /** Airport field elevation or other explicit descent target at destination. */
  readonly destinationAltitude: FeetMsl;
  readonly climbPerformance: Omit<VerticalPhasePerformance, "effectiveWind">;
  readonly descentPerformance: Omit<VerticalPhasePerformance, "effectiveWind">;
  readonly windResolver: EffectiveWindResolver;
  readonly convergence?: ConvergenceOptions;
}

export type AllocatedPhaseKind = VerticalPhaseKind | "cruise";

/**
 * A generated, flyable portion of a source user leg. Distances and altitudes
 * are unrounded planning values; UI formatting must not feed back into them.
 */
export interface AllocatedRouteSubLeg extends GeneratedSubLeg {
  readonly phase: AllocatedPhaseKind;
  readonly phaseId: string;
  readonly trueCourse: TrueCourse;
  readonly routeStartDistance: NauticalMiles;
  readonly routeEndDistance: NauticalMiles;
  readonly startingAltitude: FeetMsl;
  readonly endingAltitude: FeetMsl;
  /** The altitude the user selected for this source user leg. */
  readonly selectedCruiseAltitude: FeetMsl;
}

export interface AllocatedVerticalPhase {
  readonly id: string;
  readonly kind: VerticalPhaseKind;
  readonly start: Coordinate;
  readonly end: Coordinate;
  readonly startRouteDistance: NauticalMiles;
  readonly endRouteDistance: NauticalMiles;
  readonly startingAltitude: FeetMsl;
  readonly targetAltitude: FeetMsl;
  readonly calculation: VerticalPhaseCalculation;
  readonly convergenceIterations: number;
}

export interface PhaseRequirement {
  readonly id: string;
  readonly kind: VerticalPhaseKind;
  readonly startRouteDistance: number;
  readonly endRouteDistance: number;
  readonly startingAltitude: FeetMsl;
  readonly targetAltitude: FeetMsl;
  readonly calculation: VerticalPhaseCalculation;
  readonly convergenceIterations: number;
}

export type PhaseAllocationViolation =
  | {
    readonly kind: "phase-outside-route";
    readonly phaseId: string;
    readonly requiredStartRouteDistance: number;
    readonly requiredEndRouteDistance: number;
    readonly routeDistance: NauticalMiles;
  }
  | {
    readonly kind: "phase-overlap";
    readonly firstPhaseId: string;
    readonly secondPhaseId: string;
    readonly overlapDistance: NauticalMiles;
  };

export interface AllocatedRoutePhasePlan {
  readonly status: "allocated";
  readonly transitionPolicy: "begin-at-checkpoint-and-consume-following-route-space";
  readonly sublegs: readonly AllocatedRouteSubLeg[];
  readonly phases: readonly AllocatedVerticalPhase[];
  readonly boundaries: readonly GeneratedBoundary[];
  readonly warnings: readonly string[];
}

export interface InfeasibleRoutePhasePlan {
  readonly status: "infeasible";
  readonly transitionPolicy: "begin-at-checkpoint-and-consume-following-route-space";
  readonly phaseRequirements: readonly PhaseRequirement[];
  /** Boundaries that could still be located on the route. */
  readonly boundaries: readonly GeneratedBoundary[];
  readonly violations: readonly PhaseAllocationViolation[];
  readonly warnings: readonly string[];
}

export type RoutePhaseAllocationResult = AllocatedRoutePhasePlan | InfeasibleRoutePhasePlan;

interface CalculatedRouteLeg extends RouteGeometryLeg {
  readonly distance: NauticalMiles;
  readonly course: TrueCourse;
  readonly startRouteDistance: NauticalMiles;
  readonly endRouteDistance: NauticalMiles;
  readonly cruiseAltitude: FeetMsl;
}

interface PhaseRequirementInternal extends PhaseRequirement {
  readonly startRouteDistance: number;
  readonly endRouteDistance: number;
}

const EPSILON_NAUTICAL_MILES = 1e-9;
const POLICY_WARNING = "Altitude-transition policy: a changed user-leg altitude begins at that preceding checkpoint and consumes following route space; it is never applied as an instantaneous jump.";

/**
 * Allocates departure climb, every changed user-leg altitude, and arrival
 * descent against ordered route distance. A transition begins exactly at the
 * checkpoint before its newly selected altitude. If any required phase extends
 * beyond the route or overlaps another required phase, this returns an explicit
 * infeasible result and deliberately emits no partially allocated sublegs.
 */
export const allocateRoutePhases = (input: RoutePhaseAllocationInput): DomainResult<RoutePhaseAllocationResult> => {
  const route = calculateRoute(input.route, input.legAltitudes);
  if (!route.ok) return propagateFailure(route);
  const totalDistance = route.value[route.value.length - 1]?.endRouteDistance;
  if (totalDistance === undefined) return failure("ROUTE_GEOMETRY_ERROR", "At least one route leg is required.");

  const phaseCalculations = calculatePhaseRequirements(input, route.value, totalDistance);
  if (!phaseCalculations.ok) return propagateFailure(phaseCalculations);
  const requirements = phaseCalculations.value;
  const boundaries = locateAvailableBoundaries(input.route, requirements, totalDistance);
  if (!boundaries.ok) return propagateFailure(boundaries);
  const violations = assessAllocationFeasibility(requirements, totalDistance);
  if (violations.length > 0) {
    return success({
      status: "infeasible",
      transitionPolicy: "begin-at-checkpoint-and-consume-following-route-space",
      phaseRequirements: requirements,
      boundaries: boundaries.value,
      violations,
      warnings: [POLICY_WARNING, "Required vertical phases do not fit without overlap; no cruise or transition subleg was invented."],
    });
  }

  const phases = allocatedPhases(input.route, requirements);
  if (!phases.ok) return propagateFailure(phases);
  const sublegs = allocateSublegs(route.value, requirements);
  if (!sublegs.ok) return propagateFailure(sublegs);
  return success({
    status: "allocated",
    transitionPolicy: "begin-at-checkpoint-and-consume-following-route-space",
    sublegs: sublegs.value,
    phases: phases.value,
    boundaries: boundaries.value,
    warnings: [POLICY_WARNING],
  });
};

const calculateRoute = (
  route: readonly RouteGeometryLeg[],
  legAltitudes: readonly RouteLegAltitude[],
): DomainResult<readonly CalculatedRouteLeg[]> => {
  if (route.length === 0) return failure("ROUTE_GEOMETRY_ERROR", "At least one route leg is required.");
  if (route.length !== legAltitudes.length) {
    return failure("ROUTE_GEOMETRY_ERROR", "Every route leg must have exactly one selected cruise altitude.");
  }
  let accumulatedDistance = 0;
  const calculated: CalculatedRouteLeg[] = [];
  for (let index = 0; index < route.length; index += 1) {
    const leg = route[index];
    const altitude = legAltitudes[index];
    if (leg === undefined || altitude === undefined || leg.sourceLegId !== altitude.sourceLegId) {
      return failure("ROUTE_GEOMETRY_ERROR", "Route-leg altitude entries must match route order and source-leg IDs.");
    }
    if (route.some((candidate, candidateIndex) => candidateIndex !== index && candidate.sourceLegId === leg.sourceLegId)) {
      return failure("ROUTE_GEOMETRY_ERROR", "Route source-leg IDs must be unique for phase allocation.", { sourceLegId: leg.sourceLegId });
    }
    const geometry = calculateGreatCircleDistanceAndInitialCourse(leg.start, leg.end);
    if (!geometry.ok) return propagateFailure(geometry);
    const startRouteDistance = nauticalMiles(accumulatedDistance);
    if (!startRouteDistance.ok) return propagateFailure(startRouteDistance);
    accumulatedDistance += geometry.value.distance;
    const endRouteDistance = nauticalMiles(accumulatedDistance);
    if (!endRouteDistance.ok) return propagateFailure(endRouteDistance);
    calculated.push({
      ...leg,
      distance: geometry.value.distance,
      course: geometry.value.initialTrueCourse,
      startRouteDistance: startRouteDistance.value,
      endRouteDistance: endRouteDistance.value,
      cruiseAltitude: altitude.cruiseAltitude,
    });
  }
  return success(calculated);
};

const calculatePhaseRequirements = (
  input: RoutePhaseAllocationInput,
  route: readonly CalculatedRouteLeg[],
  totalDistance: NauticalMiles,
): DomainResult<readonly PhaseRequirementInternal[]> => {
  const first = route[0];
  const final = route[route.length - 1];
  if (first === undefined || final === undefined) return failure("ROUTE_GEOMETRY_ERROR", "At least one route leg is required.");
  const requirements: PhaseRequirementInternal[] = [];
  const departureClimb = calculateOptionalForwardPhase({
    id: "departure-climb",
    kind: "climb",
    start: first.start,
    course: first.course,
    startRouteDistance: value(nauticalMiles(0)),
    startingAltitude: input.departureAltitude,
    targetAltitude: first.cruiseAltitude,
    performance: input.climbPerformance,
    windResolver: input.windResolver,
    convergence: input.convergence,
  });
  if (!departureClimb.ok) return propagateFailure(departureClimb);
  if (departureClimb.value !== undefined) requirements.push(departureClimb.value);
  const transitions = calculateTransitionRequirements(input, route);
  if (!transitions.ok) return propagateFailure(transitions);
  requirements.push(...transitions.value);

  const arrivalDescent = calculateOptionalArrivalDescent({
    route,
    totalDistance,
    startingAltitude: final.cruiseAltitude,
    targetAltitude: input.destinationAltitude,
    performance: input.descentPerformance,
    windResolver: input.windResolver,
    convergence: input.convergence,
  });
  if (!arrivalDescent.ok) return propagateFailure(arrivalDescent);
  if (arrivalDescent.value !== undefined) requirements.push(arrivalDescent.value);
  return success(requirements);
};

const calculateTransitionRequirements = (
  input: RoutePhaseAllocationInput,
  route: readonly CalculatedRouteLeg[],
): DomainResult<readonly PhaseRequirementInternal[]> => {
  const requirements: PhaseRequirementInternal[] = [];
  for (let index = 0; index < route.length - 1; index += 1) {
    const current = route[index];
    const next = route[index + 1];
    if (current === undefined || next === undefined || current.cruiseAltitude === next.cruiseAltitude) continue;
    const transition = calculateTransitionRequirement(input, current, next);
    if (!transition.ok) return propagateFailure(transition);
    if (transition.value !== undefined) requirements.push(transition.value);
  }
  return success(requirements);
};

const calculateTransitionRequirement = (
  input: RoutePhaseAllocationInput,
  current: CalculatedRouteLeg,
  next: CalculatedRouteLeg,
): DomainResult<PhaseRequirementInternal | undefined> => {
  const climbing = next.cruiseAltitude > current.cruiseAltitude;
  return calculateOptionalForwardPhase({
    id: `transition:${current.sourceLegId}->${next.sourceLegId}`,
    kind: climbing ? "transition-climb" : "transition-descent",
    start: current.end,
    course: next.course,
    startRouteDistance: current.endRouteDistance,
    startingAltitude: current.cruiseAltitude,
    targetAltitude: next.cruiseAltitude,
    performance: climbing ? input.climbPerformance : input.descentPerformance,
    windResolver: input.windResolver,
    convergence: input.convergence,
  });
};

interface ForwardPhaseInput {
  readonly id: string;
  readonly kind: "climb" | "transition-climb" | "transition-descent";
  readonly start: Coordinate;
  readonly course: TrueCourse;
  readonly startRouteDistance: NauticalMiles;
  readonly startingAltitude: FeetMsl;
  readonly targetAltitude: FeetMsl;
  readonly performance: Omit<VerticalPhasePerformance, "effectiveWind">;
  readonly windResolver: EffectiveWindResolver;
  readonly convergence?: ConvergenceOptions;
}

const calculateOptionalForwardPhase = (input: ForwardPhaseInput): DomainResult<PhaseRequirementInternal | undefined> => {
  if (input.startingAltitude === input.targetAltitude) return success(undefined);
  const converged = calculateConvergedVerticalPhase({
    kind: input.kind,
    start: input.start,
    course: input.course,
    startingAltitude: input.startingAltitude,
    targetAltitude: input.targetAltitude,
    performance: input.performance,
  }, input.windResolver, input.convergence);
  if (!converged.ok) return propagateFailure(converged);
  return requirementFromForwardConvergence(input, converged.value);
};

const requirementFromForwardConvergence = (
  input: ForwardPhaseInput,
  converged: ConvergedVerticalPhase,
): DomainResult<PhaseRequirementInternal> => {
  const endRouteDistance = input.startRouteDistance + converged.calculation.distance;
  return success({
    id: input.id,
    kind: input.kind,
    startRouteDistance: input.startRouteDistance,
    endRouteDistance,
    startingAltitude: input.startingAltitude,
    targetAltitude: input.targetAltitude,
    calculation: converged.calculation,
    convergenceIterations: converged.iterations,
  });
};

interface ArrivalDescentInput {
  readonly route: readonly CalculatedRouteLeg[];
  readonly totalDistance: NauticalMiles;
  readonly startingAltitude: FeetMsl;
  readonly targetAltitude: FeetMsl;
  readonly performance: Omit<VerticalPhasePerformance, "effectiveWind">;
  readonly windResolver: EffectiveWindResolver;
  readonly convergence?: ConvergenceOptions;
}

/** Resolves each descent wind sample at its candidate TOD and local route course. */
const calculateOptionalArrivalDescent = (input: ArrivalDescentInput): DomainResult<PhaseRequirementInternal | undefined> => {
  if (input.startingAltitude === input.targetAltitude) return success(undefined);
  const options = resolveConvergenceOptions(input.convergence);
  if (!options.ok) return propagateFailure(options);
  let previousDistance = 0;
  for (let iteration = 1; iteration <= options.value.maxIterations; iteration += 1) {
    const calculation = calculateArrivalDescentIteration(input, previousDistance, iteration);
    if (!calculation.ok) return propagateFailure(calculation);
    const difference = Math.abs(calculation.value.distance - previousDistance);
    if (iteration > 1 && difference <= options.value.tolerance) {
      return success({
        id: "arrival-descent",
        kind: "descent",
        startRouteDistance: input.totalDistance - calculation.value.distance,
        endRouteDistance: input.totalDistance,
        startingAltitude: input.startingAltitude,
        targetAltitude: input.targetAltitude,
        calculation: calculation.value,
        convergenceIterations: iteration,
      });
    }
    previousDistance = calculation.value.distance;
  }
  return failure("NON_CONVERGENT_PHASE_GEOMETRY", "Phase geometry did not converge within the configured iteration bound.", {
    maxIterations: options.value.maxIterations,
    tolerance: options.value.tolerance,
    finalDistance: previousDistance,
  });
};

const resolveConvergenceOptions = (convergence: ConvergenceOptions | undefined): DomainResult<{ readonly tolerance: number; readonly maxIterations: number }> => {
  const tolerance = convergence?.distanceToleranceNauticalMiles ?? 0.01;
  const maxIterations = convergence?.maxIterations ?? 8;
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    return failure("OUT_OF_RANGE", "Convergence distance tolerance must be a finite positive number.", { distanceToleranceNauticalMiles: tolerance });
  }
  return Number.isInteger(maxIterations) && maxIterations >= 1
    ? success({ tolerance, maxIterations })
    : failure("OUT_OF_RANGE", "Convergence maximum iterations must be a positive integer.", { maxIterations });
};

const calculateArrivalDescentIteration = (
  input: ArrivalDescentInput,
  previousDistance: number,
  iteration: number,
): DomainResult<VerticalPhaseCalculation> => {
  // A required TOD can be before route origin. Clamp the sampling coordinate
  // only to quantify infeasibility; the requirement keeps its off-route TOD.
  const candidate = routePosition(input.route, Math.max(0, input.totalDistance - previousDistance));
  if (!candidate.ok) return propagateFailure(candidate);
  const effectiveWind = input.windResolver.resolveEffectiveWind({
    phase: "descent", start: candidate.value.coordinate, courseDegreesTrue: candidate.value.leg.course,
    startingAltitudeFeetMsl: input.startingAltitude, targetAltitudeFeetMsl: input.targetAltitude,
    estimatedDistanceNauticalMiles: value(nauticalMiles(previousDistance)), iteration,
  });
  if (!effectiveWind.ok) return propagateFailure(effectiveWind);
  return calculateVerticalPhase({
    kind: "descent", start: candidate.value.coordinate, course: candidate.value.leg.course,
    startingAltitude: input.startingAltitude, targetAltitude: input.targetAltitude,
    performance: { ...input.performance, effectiveWind: effectiveWind.value },
  });
};

const locateAvailableBoundaries = (
  route: readonly RouteGeometryLeg[],
  requirements: readonly PhaseRequirementInternal[],
  totalDistance: NauticalMiles,
): DomainResult<readonly GeneratedBoundary[]> => {
  const boundaries: GeneratedBoundary[] = [];
  for (const requirement of requirements) {
    const located = locateRequirementBoundaries(route, requirement, totalDistance);
    if (!located.ok) return propagateFailure(located);
    boundaries.push(...located.value);
  }
  return success(boundaries);
};

const locateRequirementBoundaries = (
  route: readonly RouteGeometryLeg[],
  requirement: PhaseRequirementInternal,
  totalDistance: NauticalMiles,
): DomainResult<readonly GeneratedBoundary[]> => {
  if (requirement.id === "departure-climb") return locateBoundary(route, requirement.endRouteDistance, totalDistance, "top-of-climb", "generated-toc");
  if (requirement.id === "arrival-descent") return locateBoundary(route, requirement.startRouteDistance, totalDistance, "top-of-descent", "generated-tod");
  if (requirement.kind !== "transition-climb" && requirement.kind !== "transition-descent") return success([]);
  const start = locateBoundary(route, requirement.startRouteDistance, totalDistance, "altitude-transition", `${requirement.id}:start`);
  if (!start.ok) return propagateFailure(start);
  const end = locateBoundary(route, requirement.endRouteDistance, totalDistance, "altitude-transition", `${requirement.id}:end`);
  return end.ok ? success([...start.value, ...end.value]) : propagateFailure(end);
};

const locateBoundary = (
  route: readonly RouteGeometryLeg[],
  routeDistance: number,
  totalDistance: NauticalMiles,
  kind: GeneratedBoundary["kind"],
  id: string,
): DomainResult<readonly GeneratedBoundary[]> => {
  if (!withinRoute(routeDistance, totalDistance)) return success([]);
  const boundary = placeGeneratedBoundary(route, value(nauticalMiles(routeDistance)), kind, id);
  return boundary.ok ? success([boundary.value]) : propagateFailure(boundary);
};

const assessAllocationFeasibility = (
  requirements: readonly PhaseRequirementInternal[],
  totalDistance: NauticalMiles,
): readonly PhaseAllocationViolation[] => {
  const violations: PhaseAllocationViolation[] = [];
  for (const requirement of requirements) {
    if (!withinRoute(requirement.startRouteDistance, totalDistance) || !withinRoute(requirement.endRouteDistance, totalDistance)) {
      violations.push({
        kind: "phase-outside-route",
        phaseId: requirement.id,
        requiredStartRouteDistance: requirement.startRouteDistance,
        requiredEndRouteDistance: requirement.endRouteDistance,
        routeDistance: totalDistance,
      });
    }
  }
  const sorted = [...requirements].sort((left, right) => left.startRouteDistance - right.startRouteDistance);
  for (let index = 1; index < sorted.length; index += 1) {
    const first = sorted[index - 1];
    const second = sorted[index];
    if (first === undefined || second === undefined) continue;
    const overlap = first.endRouteDistance - second.startRouteDistance;
    if (overlap > EPSILON_NAUTICAL_MILES) {
      const overlapDistance = nauticalMiles(overlap);
      if (overlapDistance.ok) {
        violations.push({ kind: "phase-overlap", firstPhaseId: first.id, secondPhaseId: second.id, overlapDistance: overlapDistance.value });
      }
    }
  }
  return violations;
};

const allocatedPhases = (
  route: readonly RouteGeometryLeg[],
  requirements: readonly PhaseRequirementInternal[],
): DomainResult<readonly AllocatedVerticalPhase[]> => {
  const phases: AllocatedVerticalPhase[] = [];
  for (const requirement of requirements) {
    const start = pointOnRoute(route, requirement.startRouteDistance);
    if (!start.ok) return propagateFailure(start);
    const end = pointOnRoute(route, requirement.endRouteDistance);
    if (!end.ok) return propagateFailure(end);
    const startRouteDistance = nauticalMiles(requirement.startRouteDistance);
    if (!startRouteDistance.ok) return propagateFailure(startRouteDistance);
    const endRouteDistance = nauticalMiles(requirement.endRouteDistance);
    if (!endRouteDistance.ok) return propagateFailure(endRouteDistance);
    phases.push({
      ...requirement,
      startRouteDistance: startRouteDistance.value,
      endRouteDistance: endRouteDistance.value,
      start: start.value,
      end: end.value,
    });
  }
  return success(phases);
};

const allocateSublegs = (
  route: readonly CalculatedRouteLeg[],
  requirements: readonly PhaseRequirementInternal[],
): DomainResult<readonly AllocatedRouteSubLeg[]> => {
  const cuts = uniqueSorted([
    0,
    ...route.map((leg) => leg.endRouteDistance),
    ...requirements.flatMap((requirement) => [requirement.startRouteDistance, requirement.endRouteDistance]),
  ]);
  const sublegs: AllocatedRouteSubLeg[] = [];
  for (let cutIndex = 1; cutIndex < cuts.length; cutIndex += 1) {
    const startDistance = cuts[cutIndex - 1];
    const endDistance = cuts[cutIndex];
    if (startDistance === undefined || endDistance === undefined || endDistance - startDistance <= EPSILON_NAUTICAL_MILES) continue;
    const intervalSublegs = allocateCutInterval(route, requirements, startDistance, endDistance, sublegs.length);
    if (!intervalSublegs.ok) return propagateFailure(intervalSublegs);
    sublegs.push(...intervalSublegs.value);
  }
  return success(sublegs);
};

const allocateCutInterval = (
  route: readonly CalculatedRouteLeg[],
  requirements: readonly PhaseRequirementInternal[],
  startDistance: number,
  endDistance: number,
  ordinalBeforeInterval: number,
): DomainResult<readonly AllocatedRouteSubLeg[]> => {
  const sublegs: AllocatedRouteSubLeg[] = [];
  for (const leg of route) {
    const intervalStart = Math.max(startDistance, leg.startRouteDistance);
    const intervalEnd = Math.min(endDistance, leg.endRouteDistance);
    if (intervalEnd - intervalStart <= EPSILON_NAUTICAL_MILES) continue;
    const subleg = buildAllocatedSubleg(leg, requirements, intervalStart, intervalEnd, ordinalBeforeInterval + sublegs.length + 1);
    if (!subleg.ok) return propagateFailure(subleg);
    sublegs.push(subleg.value);
  }
  return success(sublegs);
};

const buildAllocatedSubleg = (
  leg: CalculatedRouteLeg,
  requirements: readonly PhaseRequirementInternal[],
  intervalStart: number,
  intervalEnd: number,
  ordinal: number,
): DomainResult<AllocatedRouteSubLeg> => {
  const activePhase = phaseAt(requirements, (intervalStart + intervalEnd) / 2);
  const start = pointAlongGreatCircle(leg.start, leg.course, value(nauticalMiles(intervalStart - leg.startRouteDistance)));
  if (!start.ok) return propagateFailure(start);
  const end = pointAlongGreatCircle(leg.start, leg.course, value(nauticalMiles(intervalEnd - leg.startRouteDistance)));
  if (!end.ok) return propagateFailure(end);
  const geometry = calculateGreatCircleDistanceAndInitialCourse(start.value, end.value);
  if (!geometry.ok) return propagateFailure(geometry);
  const altitude = sublegAltitudes(activePhase, intervalStart, intervalEnd, leg.cruiseAltitude);
  if (!altitude.ok) return propagateFailure(altitude);
  return success({
    id: `${leg.sourceLegId}:${activePhase?.id ?? "cruise"}:${ordinal}`,
    sourceLegId: leg.sourceLegId, phase: activePhase?.kind ?? "cruise", phaseId: activePhase?.id ?? `cruise:${leg.sourceLegId}`,
    start: start.value, end: end.value, distance: geometry.value.distance, trueCourse: geometry.value.initialTrueCourse,
    routeStartDistance: value(nauticalMiles(intervalStart)), routeEndDistance: value(nauticalMiles(intervalEnd)),
    startingAltitude: altitude.value.startingAltitude, endingAltitude: altitude.value.endingAltitude, selectedCruiseAltitude: leg.cruiseAltitude,
  });
};

const sublegAltitudes = (
  phase: PhaseRequirementInternal | undefined,
  startDistance: number,
  endDistance: number,
  cruiseAltitude: FeetMsl,
): DomainResult<{ readonly startingAltitude: FeetMsl; readonly endingAltitude: FeetMsl }> => {
  if (phase === undefined) return success({ startingAltitude: cruiseAltitude, endingAltitude: cruiseAltitude });
  const phaseDistance = phase.endRouteDistance - phase.startRouteDistance;
  const altitudeAt = (distance: number): DomainResult<FeetMsl> => feetMsl(
    phase.startingAltitude + ((distance - phase.startRouteDistance) / phaseDistance) * (phase.targetAltitude - phase.startingAltitude),
  );
  const startingAltitude = altitudeAt(startDistance);
  if (!startingAltitude.ok) return propagateFailure(startingAltitude);
  const endingAltitude = altitudeAt(endDistance);
  return endingAltitude.ok ? success({ startingAltitude: startingAltitude.value, endingAltitude: endingAltitude.value }) : propagateFailure(endingAltitude);
};

const phaseAt = (requirements: readonly PhaseRequirementInternal[], distance: number): PhaseRequirementInternal | undefined =>
  requirements.find((requirement) => distance > requirement.startRouteDistance + EPSILON_NAUTICAL_MILES && distance < requirement.endRouteDistance - EPSILON_NAUTICAL_MILES);

const routePosition = (
  route: readonly CalculatedRouteLeg[],
  routeDistance: number,
): DomainResult<{ readonly coordinate: Coordinate; readonly leg: CalculatedRouteLeg }> => {
  const leg = route.find((candidate) => routeDistance <= candidate.endRouteDistance + EPSILON_NAUTICAL_MILES);
  if (leg === undefined || routeDistance < -EPSILON_NAUTICAL_MILES) {
    return failure("ROUTE_GEOMETRY_ERROR", "Generated route position falls outside the route.", { routeDistance });
  }
  const withinLeg = nauticalMiles(Math.max(0, routeDistance - leg.startRouteDistance));
  if (!withinLeg.ok) return propagateFailure(withinLeg);
  const coordinate = pointAlongGreatCircle(leg.start, leg.course, withinLeg.value);
  return coordinate.ok ? success({ coordinate: coordinate.value, leg }) : propagateFailure(coordinate);
};

const pointOnRoute = (route: readonly RouteGeometryLeg[], routeDistance: number): DomainResult<Coordinate> => {
  const distance = nauticalMiles(routeDistance);
  if (!distance.ok) return propagateFailure(distance);
  const point = placeGeneratedBoundary(route, distance.value, "altitude-transition", "generated-route-point");
  return point.ok ? success(point.value.coordinate) : propagateFailure(point);
};

const withinRoute = (distance: number, totalDistance: NauticalMiles): boolean =>
  distance >= -EPSILON_NAUTICAL_MILES && distance <= totalDistance + EPSILON_NAUTICAL_MILES;

const uniqueSorted = (values: readonly number[]): readonly number[] =>
  [...values].sort((left, right) => left - right).filter((value, index, sorted) => index === 0 || Math.abs(value - (sorted[index - 1] ?? value)) > EPSILON_NAUTICAL_MILES);

const value = <T>(result: DomainResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
