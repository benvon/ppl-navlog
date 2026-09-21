import { trace, type CalculationTrace } from "./calculation-trace";
import { failure, propagateFailure, success, type DomainResult } from "./errors";
import { magneticHeading, signedDegrees, type MagneticHeading, type SignedDegrees } from "./units";

export interface DeviationTablePoint {
  readonly magneticHeading: MagneticHeading;
  /** East-positive signed degrees supplied by the pilot or aircraft data. */
  readonly deviation: SignedDegrees;
}

export interface DeviationInterpolation {
  readonly deviation: SignedDegrees;
  readonly trace: CalculationTrace;
}

export const deviationTablePoint = (
  magneticHeadingDegrees: number,
  eastPositiveDeviationDegrees: number,
): DomainResult<DeviationTablePoint> => {
  const heading = magneticHeading(magneticHeadingDegrees);
  if (!heading.ok) return propagateFailure(heading);
  const deviation = signedDegrees(eastPositiveDeviationDegrees);
  if (!deviation.ok) return propagateFailure(deviation);
  return success({ magneticHeading: heading.value, deviation: deviation.value });
};

const validateTable = (table: readonly DeviationTablePoint[]): DomainResult<readonly DeviationTablePoint[]> => {
  if (table.length === 0) return failure("INVALID_DEVIATION_TABLE", "Deviation table requires at least one point.");
  const sorted = [...table].sort((left, right) => left.magneticHeading - right.magneticHeading);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (previous.magneticHeading === current.magneticHeading) {
      return failure("INVALID_DEVIATION_TABLE", "Deviation table has duplicate magnetic-heading points.", {
        heading: current.magneticHeading,
      });
    }
  }
  return success(sorted);
};

/** Interpolates the pilot-supplied deviation table across 360/000 continuously. */
export const interpolateCompassDeviation = (
  table: readonly DeviationTablePoint[],
  requestedHeading: MagneticHeading,
): DomainResult<DeviationInterpolation> => {
  const validTable = validateTable(table);
  if (!validTable.ok) return propagateFailure(validTable);
  const points = validTable.value;
  if (points.length === 1) {
    const onlyPoint = points[0]!;
    return success({
      deviation: onlyPoint.deviation,
      trace: trace(
        "compass-deviation-single-point",
        [{ name: "magnetic heading", value: requestedHeading, unit: "degrees-magnetic" }],
        [{ name: "pilot table heading", value: onlyPoint.magneticHeading, unit: "degrees-magnetic" }],
        { name: "deviation", value: onlyPoint.deviation, unit: "degrees" },
      ),
    });
  }

  const firstPoint = points[0]!;
  const extended = [...points, { ...firstPoint, magneticHeading: (firstPoint.magneticHeading + 360) as MagneticHeading }];
  const adjustedRequested =
    requestedHeading < firstPoint.magneticHeading ? requestedHeading + 360 : requestedHeading;
  let lower = extended[0]!;
  let upper = extended[1]!;
  for (let index = 0; index < extended.length - 1; index += 1) {
    const candidateLower = extended[index]!;
    const candidateUpper = extended[index + 1]!;
    if (adjustedRequested >= candidateLower.magneticHeading && adjustedRequested <= candidateUpper.magneticHeading) {
      lower = candidateLower;
      upper = candidateUpper;
      break;
    }
  }
  const fraction = (adjustedRequested - lower.magneticHeading) / (upper.magneticHeading - lower.magneticHeading);
  const value = lower.deviation + (upper.deviation - lower.deviation) * fraction;
  const deviation = signedDegrees(value);
  if (!deviation.ok) return propagateFailure(deviation);
  return success({
    deviation: deviation.value,
    trace: trace(
      "compass-deviation-circular-linear-interpolation",
      [{ name: "magnetic heading", value: requestedHeading, unit: "degrees-magnetic" }],
      [
        { name: "lower table heading", value: lower.magneticHeading % 360, unit: "degrees-magnetic" },
        { name: "upper table heading", value: upper.magneticHeading % 360, unit: "degrees-magnetic" },
        { name: "interpolation fraction", value: fraction, unit: "unitless" },
      ],
      { name: "deviation", value: deviation.value, unit: "degrees" },
    ),
  });
};
