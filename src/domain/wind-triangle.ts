import { trace, type CalculationTrace } from "./calculation-trace";
import { failure, propagateFailure, success, type DomainResult } from "./errors";
import { degreesToRadians, knots, radiansToDegrees, signedDegrees, trueHeading, type Knots, type SignedDegrees, type TrueCourse, type TrueHeading } from "./units";
import { windToVector, type Wind } from "./wind";

export interface WindTriangle {
  /** Signed: positive is a correction right of course; negative is left. */
  readonly windCorrectionAngle: SignedDegrees;
  readonly trueHeading: TrueHeading;
  readonly groundspeed: Knots;
  readonly trace: CalculationTrace;
}

/** Solves aircraft airspeed plus wind as a single vector equation. */
export const solveWindTriangle = (
  course: TrueCourse,
  trueAirspeed: Knots,
  wind: Wind,
): DomainResult<WindTriangle> => {
  if (trueAirspeed <= 0) {
    return failure("OUT_OF_RANGE", "True airspeed must be greater than zero.", { trueAirspeed });
  }
  const courseRadians = degreesToRadians(course);
  const windVector = windToVector(wind);
  const alongTrack = windVector.north * Math.cos(courseRadians) + windVector.east * Math.sin(courseRadians);
  const rightOfTrack = windVector.east * Math.cos(courseRadians) - windVector.north * Math.sin(courseRadians);
  const sineCorrection = -rightOfTrack / trueAirspeed;
  if (Math.abs(sineCorrection) > 1 + 1e-12) {
    return failure("INVALID_WIND_TRIANGLE", "Crosswind component exceeds true airspeed.", {
      crosswind: rightOfTrack,
      trueAirspeed,
    });
  }
  const correctionRadians = Math.asin(Math.max(-1, Math.min(1, sineCorrection)));
  const airspeedAlongTrack = Math.sqrt(Math.max(0, trueAirspeed ** 2 - rightOfTrack ** 2));
  const groundspeedValue = alongTrack + airspeedAlongTrack;
  if (!Number.isFinite(groundspeedValue)) {
    return failure("NON_FINITE_RESULT", "Wind-triangle calculation produced a non-finite groundspeed.");
  }
  if (groundspeedValue <= 0) {
    return failure("NONPOSITIVE_GROUNDSPEED", "Wind triangle produces a nonpositive groundspeed.", {
      groundspeed: groundspeedValue,
    });
  }
  const correction = signedDegrees(radiansToDegrees(correctionRadians));
  if (!correction.ok) return propagateFailure(correction);
  const heading = trueHeading(course + correction.value);
  if (!heading.ok) return propagateFailure(heading);
  const groundspeed = knots(groundspeedValue);
  if (!groundspeed.ok) return propagateFailure(groundspeed);
  return success({
    windCorrectionAngle: correction.value,
    trueHeading: heading.value,
    groundspeed: groundspeed.value,
    trace: trace(
      "wind-triangle-vector-solution",
      [
        { name: "true course", value: course, unit: "degrees-true" },
        { name: "true airspeed", value: trueAirspeed, unit: "knots" },
        { name: "wind direction from", value: wind.directionFrom, unit: "degrees-true" },
        { name: "wind speed", value: wind.speed, unit: "knots" },
      ],
      [
        { name: "wind north vector", value: windVector.north, unit: "knots" },
        { name: "wind east vector", value: windVector.east, unit: "knots" },
        { name: "wind along-track component", value: alongTrack, unit: "knots" },
        { name: "wind right-of-track component", value: rightOfTrack, unit: "knots" },
        { name: "airspeed along-track component", value: airspeedAlongTrack, unit: "knots" },
      ],
      { name: "groundspeed", value: groundspeed.value, unit: "knots" },
    ),
  });
};
