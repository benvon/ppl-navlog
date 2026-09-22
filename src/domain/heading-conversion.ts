import { trace, type CalculationTrace } from "./calculation-trace";
import { propagateFailure, success, type DomainResult } from "./errors";
import {
  compassHeading,
  magneticHeading,
  type CompassHeading,
  type MagneticHeading,
  type SignedDegrees,
  type TrueHeading,
} from "./units";

export interface HeadingConversion<T> {
  readonly heading: T;
  readonly trace: CalculationTrace;
}

/**
 * Positive variation/deviation is east. With that convention:
 * magnetic = true - variation; compass = magnetic - deviation.
 */
export const convertTrueToMagneticHeading = (
  trueHeading: TrueHeading,
  eastPositiveVariation: SignedDegrees,
): DomainResult<HeadingConversion<MagneticHeading>> => {
  const converted = magneticHeading(trueHeading - eastPositiveVariation);
  if (!converted.ok) return propagateFailure(converted);
  return success({
    heading: converted.value,
    trace: trace(
      "true-to-magnetic-heading",
      [
        { name: "true heading", value: trueHeading, unit: "degrees-true" },
        { name: "variation (east positive)", value: eastPositiveVariation, unit: "degrees" },
      ],
      [{ name: "magnetic heading before normalization", value: trueHeading - eastPositiveVariation, unit: "degrees-magnetic" }],
      { name: "magnetic heading", value: converted.value, unit: "degrees-magnetic" },
    ),
  });
};

export const convertMagneticToCompassHeading = (
  magneticHeadingValue: MagneticHeading,
  eastPositiveDeviation: SignedDegrees,
): DomainResult<HeadingConversion<CompassHeading>> => {
  const converted = compassHeading(magneticHeadingValue - eastPositiveDeviation);
  if (!converted.ok) return propagateFailure(converted);
  return success({
    heading: converted.value,
    trace: trace(
      "magnetic-to-compass-heading",
      [
        { name: "magnetic heading", value: magneticHeadingValue, unit: "degrees-magnetic" },
        { name: "deviation (east positive)", value: eastPositiveDeviation, unit: "degrees" },
      ],
      [{ name: "compass heading before normalization", value: magneticHeadingValue - eastPositiveDeviation, unit: "degrees-compass" }],
      { name: "compass heading", value: converted.value, unit: "degrees-compass" },
    ),
  });
};
