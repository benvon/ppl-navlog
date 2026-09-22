import { type CalculationTrace, trace } from "./calculation-trace";
import type { Coordinate } from "./coordinates";
import { failure, propagateFailure, success, type DomainResult } from "./errors";
import {
  calculateVerticalPhase,
  type VerticalPhaseCalculation,
  type VerticalPhaseInput,
  type VerticalPhaseKind,
} from "./phase-performance";
import { gallons, nauticalMiles, signedGallons, type Gallons, type NauticalMiles, type SignedGallons } from "./units";
import type { Wind } from "./wind";

export interface PhaseWindRequest {
  readonly phase: VerticalPhaseKind;
  readonly start: Coordinate;
  readonly courseDegreesTrue: number;
  readonly startingAltitudeFeetMsl: number;
  readonly targetAltitudeFeetMsl: number;
  /** The prior computed distance; zero for the initial resolution. */
  readonly estimatedDistanceNauticalMiles: NauticalMiles;
  readonly iteration: number;
}

/** Implemented later by sampled-winds logic; remains pure/deterministic here. */
export interface EffectiveWindResolver {
  resolveEffectiveWind(request: PhaseWindRequest): DomainResult<Wind>;
}

export interface ConvergenceOptions {
  readonly distanceToleranceNauticalMiles?: number;
  readonly maxIterations?: number;
}

export interface ConvergedVerticalPhase {
  readonly calculation: VerticalPhaseCalculation;
  readonly iterations: number;
  readonly distanceToleranceNauticalMiles: number;
  readonly trace: CalculationTrace;
}

const DEFAULT_DISTANCE_TOLERANCE_NAUTICAL_MILES = 0.01;
const DEFAULT_MAX_ITERATIONS = 8;

const resolveConvergenceOptions = (options: ConvergenceOptions): DomainResult<Required<ConvergenceOptions>> => {
  const distanceToleranceNauticalMiles = options.distanceToleranceNauticalMiles ?? DEFAULT_DISTANCE_TOLERANCE_NAUTICAL_MILES;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (!Number.isFinite(distanceToleranceNauticalMiles) || distanceToleranceNauticalMiles <= 0) {
    return failure("OUT_OF_RANGE", "Convergence distance tolerance must be a finite positive number.", {
      distanceToleranceNauticalMiles,
    });
  }
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    return failure("OUT_OF_RANGE", "Convergence maximum iterations must be a positive integer.", { maxIterations });
  }
  return success({ distanceToleranceNauticalMiles, maxIterations });
};

/**
 * Bounded fixed-point convergence for cases where an effective wind depends on
 * the geometry it helps calculate. It never silently returns a last estimate.
 */
export const calculateConvergedVerticalPhase = (
  input: Omit<VerticalPhaseInput, "performance"> & {
    readonly performance: Omit<VerticalPhaseInput["performance"], "effectiveWind">;
  },
  resolver: EffectiveWindResolver,
  options: ConvergenceOptions = {},
): DomainResult<ConvergedVerticalPhase> => {
  const resolvedOptions = resolveConvergenceOptions(options);
  if (!resolvedOptions.ok) return propagateFailure(resolvedOptions);
  const { distanceToleranceNauticalMiles: tolerance, maxIterations } = resolvedOptions.value;
  const initialDistance = nauticalMiles(0);
  if (!initialDistance.ok) return propagateFailure(initialDistance);
  let previousDistance = initialDistance.value;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const effectiveWind = resolver.resolveEffectiveWind({
      phase: input.kind,
      start: input.start,
      courseDegreesTrue: input.course,
      startingAltitudeFeetMsl: input.startingAltitude,
      targetAltitudeFeetMsl: input.targetAltitude,
      estimatedDistanceNauticalMiles: previousDistance,
      iteration,
    });
    if (!effectiveWind.ok) return propagateFailure(effectiveWind);
    const calculation = calculateVerticalPhase({
      ...input,
      performance: { ...input.performance, effectiveWind: effectiveWind.value },
    });
    if (!calculation.ok) return propagateFailure(calculation);
    const difference = Math.abs(calculation.value.distance - previousDistance);
    if (iteration > 1 && difference <= tolerance) {
      return success({
        calculation: calculation.value,
        iterations: iteration,
        distanceToleranceNauticalMiles: tolerance,
        trace: trace(
          "bounded-phase-geometry-convergence",
          [
            { name: "distance tolerance", value: tolerance, unit: "nautical-miles" },
            { name: "maximum iterations", value: maxIterations, unit: "unitless" },
          ],
          [
            { name: "iterations", value: iteration, unit: "unitless" },
            { name: "final distance difference", value: difference, unit: "nautical-miles" },
          ],
          { name: "converged distance", value: calculation.value.distance, unit: "nautical-miles" },
        ),
      });
    }
    previousDistance = calculation.value.distance;
  }
  return failure("NON_CONVERGENT_PHASE_GEOMETRY", "Phase geometry did not converge within the configured iteration bound.", {
    maxIterations,
    tolerance,
    finalDistance: previousDistance,
  });
};

export interface InfeasibleProfileResult {
  readonly feasible: boolean;
  readonly routeDistance: NauticalMiles;
  readonly climbAndTransitionDistance: NauticalMiles;
  readonly descentDistance: NauticalMiles;
  readonly overlapDistance: NauticalMiles;
  readonly trace: CalculationTrace;
}

/** Compares independently calculated phase requirements; it never truncates either phase. */
export const assessProfileFeasibility = (
  routeDistance: NauticalMiles,
  climbAndTransitionDistance: NauticalMiles,
  descentDistance: NauticalMiles,
): DomainResult<InfeasibleProfileResult> => {
  const requiredDistance = climbAndTransitionDistance + descentDistance;
  // The unit constructor also protects this result from non-finite arithmetic.
  const overlap = nauticalMiles(Math.max(0, requiredDistance - routeDistance));
  if (!overlap.ok) return propagateFailure(overlap);
  return success({
    feasible: overlap.value === 0,
    routeDistance,
    climbAndTransitionDistance,
    descentDistance,
    overlapDistance: overlap.value,
    trace: trace(
      "phase-profile-feasibility",
      [
        { name: "route distance", value: routeDistance, unit: "nautical-miles" },
        { name: "climb and transition distance", value: climbAndTransitionDistance, unit: "nautical-miles" },
        { name: "descent distance", value: descentDistance, unit: "nautical-miles" },
      ],
      [{ name: "required phase distance", value: requiredDistance, unit: "nautical-miles" }],
      { name: "overlap distance", value: overlap.value, unit: "nautical-miles" },
      "UI decides presentation rounding.",
      overlap.value > 0 ? ["Climb/transition and descent requirements overlap; no cruise distance is invented."] : [],
    ),
  });
};

export interface FuelSummaryInput {
  readonly taxiRunupFuel: Gallons;
  readonly climbFuel: Gallons;
  readonly transitionFuel: Gallons;
  readonly cruiseFuel: Gallons;
  readonly descentFuel: Gallons;
  readonly reserveFuel: Gallons;
  readonly usableFuel?: Gallons;
}

export interface FuelSummary {
  readonly taxiRunupFuel: Gallons;
  readonly climbFuel: Gallons;
  readonly transitionFuel: Gallons;
  readonly cruiseFuel: Gallons;
  readonly descentFuel: Gallons;
  readonly reserveFuel: Gallons;
  readonly enrouteFuel: Gallons;
  readonly requiredFuel: Gallons;
  readonly usableFuel?: Gallons;
  /** Positive when usable fuel exceeds required fuel; negative when insufficient. */
  readonly usableFuelDifference?: SignedGallons;
  readonly sufficientUsableFuel?: boolean;
  readonly trace: CalculationTrace;
}

/** Keeps taxi/run-up and reserve fuel explicit rather than folding them into enroute fuel. */
export const calculateFuelSummary = (input: FuelSummaryInput): DomainResult<FuelSummary> => {
  const enrouteFuel = gallons(input.climbFuel + input.transitionFuel + input.cruiseFuel + input.descentFuel);
  if (!enrouteFuel.ok) return propagateFailure(enrouteFuel);
  const requiredFuel = gallons(input.taxiRunupFuel + enrouteFuel.value + input.reserveFuel);
  if (!requiredFuel.ok) return propagateFailure(requiredFuel);
  const usableFuelDifference = input.usableFuel === undefined ? undefined : signedGallons(input.usableFuel - requiredFuel.value);
  if (usableFuelDifference !== undefined && !usableFuelDifference.ok) return propagateFailure(usableFuelDifference);
  return success({
    ...input,
    enrouteFuel: enrouteFuel.value,
    requiredFuel: requiredFuel.value,
    usableFuelDifference: usableFuelDifference?.value,
    sufficientUsableFuel: input.usableFuel === undefined ? undefined : input.usableFuel >= requiredFuel.value,
    trace: trace(
      "fuel-summary",
      [
        { name: "taxi/run-up fuel", value: input.taxiRunupFuel, unit: "gallons" },
        { name: "climb fuel", value: input.climbFuel, unit: "gallons" },
        { name: "transition fuel", value: input.transitionFuel, unit: "gallons" },
        { name: "cruise fuel", value: input.cruiseFuel, unit: "gallons" },
        { name: "descent fuel", value: input.descentFuel, unit: "gallons" },
        { name: "reserve fuel", value: input.reserveFuel, unit: "gallons" },
      ],
      [{ name: "enroute fuel", value: enrouteFuel.value, unit: "gallons" }],
      { name: "required fuel", value: requiredFuel.value, unit: "gallons" },
    ),
  });
};
