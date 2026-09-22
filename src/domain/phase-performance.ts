import { type CalculationTrace, trace } from "./calculation-trace";
import { failure, propagateFailure, success, type DomainResult } from "./errors";
import { pointAlongGreatCircle } from "./distance-course";
import { calculateFuelForDuration } from "./time-fuel";
import {
  feetMsl,
  gallonsPerHour,
  minutes,
  nauticalMiles,
  positiveKnots,
  type FeetMsl,
  type Gallons,
  type GallonsPerHour,
  type Knots,
  type Minutes,
  type NauticalMiles,
  type TrueCourse,
} from "./units";
import { solveWindTriangle, type WindTriangle } from "./wind-triangle";
import type { Coordinate } from "./coordinates";
import type { Wind } from "./wind";

export type VerticalPhaseKind = "climb" | "descent" | "transition-climb" | "transition-descent";

export interface VerticalPhasePerformance {
  /** A positive vertical rate. Direction is determined by the phase kind. */
  readonly verticalRateFeetPerMinute: number;
  readonly trueAirspeed: Knots;
  readonly fuelFlow: GallonsPerHour;
  /** A deterministic sampled/effective wind supplied by the caller. */
  readonly effectiveWind: Wind;
}

export interface VerticalPhaseInput {
  readonly kind: VerticalPhaseKind;
  readonly start: Coordinate;
  readonly course: TrueCourse;
  readonly startingAltitude: FeetMsl;
  readonly targetAltitude: FeetMsl;
  readonly performance: VerticalPhasePerformance;
}

export interface VerticalPhaseCalculation {
  readonly kind: VerticalPhaseKind;
  readonly altitudeChange: number;
  readonly duration: Minutes;
  readonly distance: NauticalMiles;
  readonly fuel: Gallons;
  readonly windTriangle: WindTriangle;
  readonly end: Coordinate;
  readonly trace: CalculationTrace;
}

const isClimb = (kind: VerticalPhaseKind): boolean => kind === "climb" || kind === "transition-climb";

const validatePhaseDirection = (kind: VerticalPhaseKind, altitudeChange: number): DomainResult<void> => {
  const climbing = isClimb(kind);
  if ((climbing && altitudeChange <= 0) || (!climbing && altitudeChange >= 0)) {
    return failure(
      "INVALID_PHASE_ALTITUDES",
      climbing
        ? "A climb phase target altitude must be above its starting altitude."
        : "A descent phase target altitude must be below its starting altitude.",
      { altitudeChange, kind },
    );
  }
  return success(undefined);
};

const validateVerticalRate = (verticalRateFeetPerMinute: number): DomainResult<void> =>
  !Number.isFinite(verticalRateFeetPerMinute) || verticalRateFeetPerMinute <= 0
    ? failure("INVALID_PHASE_PERFORMANCE", "Vertical rate must be finite and greater than zero.", {
        verticalRateFeetPerMinute,
      })
    : success(undefined);

/** Validates raw profile numbers at the pure calculation boundary. */
export const verticalPhasePerformance = (
  verticalRateFeetPerMinute: number,
  trueAirspeedKnots: number,
  fuelFlowGallonsPerHour: number,
  effectiveWind: Wind,
): DomainResult<VerticalPhasePerformance> => {
  const validRate = validateVerticalRate(verticalRateFeetPerMinute);
  if (!validRate.ok) return propagateFailure(validRate);
  const trueAirspeed = positiveKnots(trueAirspeedKnots);
  if (!trueAirspeed.ok) return propagateFailure(trueAirspeed);
  const fuelFlow = gallonsPerHour(fuelFlowGallonsPerHour);
  if (!fuelFlow.ok) return propagateFailure(fuelFlow);
  return success({ verticalRateFeetPerMinute, trueAirspeed: trueAirspeed.value, fuelFlow: fuelFlow.value, effectiveWind });
};

/**
 * Calculates one climb, descent, or altitude-transition phase from a supplied
 * effective wind. It intentionally has no weather, storage, or UI dependency.
 */
export const calculateVerticalPhase = (input: VerticalPhaseInput): DomainResult<VerticalPhaseCalculation> => {
  const altitudeChange = input.targetAltitude - input.startingAltitude;
  const validDirection = validatePhaseDirection(input.kind, altitudeChange);
  if (!validDirection.ok) return propagateFailure(validDirection);
  const validRate = validateVerticalRate(input.performance.verticalRateFeetPerMinute);
  if (!validRate.ok) return propagateFailure(validRate);
  const duration = minutes((Math.abs(altitudeChange) / input.performance.verticalRateFeetPerMinute));
  if (!duration.ok) return propagateFailure(duration);
  const windTriangle = solveWindTriangle(input.course, input.performance.trueAirspeed, input.performance.effectiveWind);
  if (!windTriangle.ok) return propagateFailure(windTriangle);
  const distance = nauticalMiles((windTriangle.value.groundspeed * duration.value) / 60);
  if (!distance.ok) return propagateFailure(distance);
  const fuel = calculateFuelForDuration(duration.value, input.performance.fuelFlow);
  if (!fuel.ok) return propagateFailure(fuel);
  const end = pointAlongGreatCircle(input.start, input.course, distance.value);
  if (!end.ok) return propagateFailure(end);
  return success({
    kind: input.kind,
    altitudeChange,
    duration: duration.value,
    distance: distance.value,
    fuel: fuel.value.fuel,
    windTriangle: windTriangle.value,
    end: end.value,
    trace: trace(
      "vertical-phase-performance",
      [
        { name: "phase", value: input.kind, unit: "unitless" },
        { name: "starting altitude", value: input.startingAltitude, unit: "feet-msl" },
        { name: "target altitude", value: input.targetAltitude, unit: "feet-msl" },
        { name: "vertical rate", value: input.performance.verticalRateFeetPerMinute, unit: "unitless" },
        { name: "true airspeed", value: input.performance.trueAirspeed, unit: "knots" },
        { name: "fuel flow", value: input.performance.fuelFlow, unit: "gallons-per-hour" },
      ],
      [
        { name: "altitude change", value: altitudeChange, unit: "feet-msl" },
        { name: "phase duration", value: duration.value, unit: "minutes" },
        { name: "groundspeed", value: windTriangle.value.groundspeed, unit: "knots" },
        { name: "phase distance", value: distance.value, unit: "nautical-miles" },
      ],
      { name: "phase fuel", value: fuel.value.fuel, unit: "gallons" },
    ),
  });
};

export const phasePerformanceFromAircraftValues = (
  verticalRateFeetPerMinute: number,
  trueAirspeedKnots: number,
  fuelFlowGallonsPerHour: number,
  effectiveWind: Wind,
): DomainResult<VerticalPhasePerformance> =>
  verticalPhasePerformance(verticalRateFeetPerMinute, trueAirspeedKnots, fuelFlowGallonsPerHour, effectiveWind);

/** Convenience construction for adapters accepting unvalidated numeric altitudes. */
export const phaseAltitudes = (
  startingAltitudeFeetMsl: number,
  targetAltitudeFeetMsl: number,
): DomainResult<{ readonly startingAltitude: FeetMsl; readonly targetAltitude: FeetMsl }> => {
  const startingAltitude = feetMsl(startingAltitudeFeetMsl);
  if (!startingAltitude.ok) return propagateFailure(startingAltitude);
  const targetAltitude = feetMsl(targetAltitudeFeetMsl);
  if (!targetAltitude.ok) return propagateFailure(targetAltitude);
  return success({ startingAltitude: startingAltitude.value, targetAltitude: targetAltitude.value });
};

/** Convenience construction for adapters accepting a raw phase speed. */
export const phaseSpeed = (value: number): DomainResult<Knots> => {
  const speed = positiveKnots(value);
  return speed.ok ? success(speed.value) : propagateFailure(speed);
};
