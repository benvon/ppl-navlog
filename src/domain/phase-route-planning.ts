import { failure, propagateFailure, success, type DomainResult } from "./errors";
import {
  calculateRouteDistance,
  placeTopOfClimb,
  placeTopOfDescent,
  type GeneratedBoundary,
  type RouteGeometryLeg,
} from "./phase-geometry";
import { calculateVerticalPhase, type VerticalPhaseCalculation, type VerticalPhaseInput } from "./phase-performance";

export interface ClimbToTopOfClimb {
  readonly climb: VerticalPhaseCalculation;
  readonly topOfClimb: GeneratedBoundary;
}

export interface DescentFromTopOfDescent {
  readonly descent: VerticalPhaseCalculation;
  readonly topOfDescent: GeneratedBoundary;
}

/** Calculates a climb and locates its generated TOC on the user route. */
export const calculateClimbToTopOfClimb = (
  input: Omit<VerticalPhaseInput, "kind">,
  route: readonly RouteGeometryLeg[],
): DomainResult<ClimbToTopOfClimb> => {
  const climb = calculateVerticalPhase({ ...input, kind: "climb" });
  if (!climb.ok) return propagateFailure(climb);
  const routeDistance = calculateRouteDistance(route);
  if (!routeDistance.ok) return propagateFailure(routeDistance);
  if (climb.value.distance > routeDistance.value) {
    return failure("INFEASIBLE_PROFILE", "Climb distance exceeds available route distance; no TOC can be placed.", {
      climbDistance: climb.value.distance,
      routeDistance: routeDistance.value,
    });
  }
  const topOfClimb = placeTopOfClimb(route, climb.value.distance);
  if (!topOfClimb.ok) return propagateFailure(topOfClimb);
  return success({ climb: climb.value, topOfClimb: topOfClimb.value });
};

/** Calculates a descent and locates its generated TOD on the user route. */
export const calculateDescentFromTopOfDescent = (
  input: Omit<VerticalPhaseInput, "kind">,
  route: readonly RouteGeometryLeg[],
): DomainResult<DescentFromTopOfDescent> => {
  const descent = calculateVerticalPhase({ ...input, kind: "descent" });
  if (!descent.ok) return propagateFailure(descent);
  const routeDistance = calculateRouteDistance(route);
  if (!routeDistance.ok) return propagateFailure(routeDistance);
  if (descent.value.distance > routeDistance.value) {
    return failure("INFEASIBLE_PROFILE", "Descent distance exceeds available route distance; no TOD can be placed.", {
      descentDistance: descent.value.distance,
      routeDistance: routeDistance.value,
    });
  }
  const topOfDescent = placeTopOfDescent(route, descent.value.distance);
  if (!topOfDescent.ok) return propagateFailure(topOfDescent);
  return success({ descent: descent.value, topOfDescent: topOfDescent.value });
};
