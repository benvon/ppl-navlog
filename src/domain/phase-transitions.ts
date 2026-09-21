import { propagateFailure, success, type DomainResult } from "./errors";
import { calculateVerticalPhase, type VerticalPhaseCalculation, type VerticalPhaseInput } from "./phase-performance";
import type { FeetMsl } from "./units";

export interface AltitudeTransitionInput {
  readonly start: VerticalPhaseInput["start"];
  readonly course: VerticalPhaseInput["course"];
  readonly startingAltitude: FeetMsl;
  readonly targetAltitude: FeetMsl;
  readonly climbPerformance: VerticalPhaseInput["performance"];
  readonly descentPerformance: VerticalPhaseInput["performance"];
}

export type AltitudeTransition =
  | { readonly required: false; readonly startingAltitude: FeetMsl; readonly targetAltitude: FeetMsl }
  | { readonly required: true; readonly calculation: VerticalPhaseCalculation };

/**
 * Makes every cruise-altitude change explicit. Equal adjacent altitudes do not
 * manufacture a zero-length phase; all other changes use the appropriate
 * climb/descent performance model.
 */
export const calculateAltitudeTransition = (input: AltitudeTransitionInput): DomainResult<AltitudeTransition> => {
  if (input.startingAltitude === input.targetAltitude) {
    return success({
      required: false,
      startingAltitude: input.startingAltitude,
      targetAltitude: input.targetAltitude,
    });
  }
  const climbing = input.targetAltitude > input.startingAltitude;
  const calculation = calculateVerticalPhase({
    kind: climbing ? "transition-climb" : "transition-descent",
    start: input.start,
    course: input.course,
    startingAltitude: input.startingAltitude,
    targetAltitude: input.targetAltitude,
    performance: climbing ? input.climbPerformance : input.descentPerformance,
  });
  if (!calculation.ok) return propagateFailure(calculation);
  return success({ required: true, calculation: calculation.value });
};
