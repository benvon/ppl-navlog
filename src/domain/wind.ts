import { trace, type CalculationTrace } from "./calculation-trace";
import { failure, propagateFailure, success, type DomainResult } from "./errors";
import {
  degreesToRadians,
  feetMsl,
  knots,
  radiansToDegrees,
  trueCourse,
  type FeetMsl,
  type Knots,
  type TrueCourse,
} from "./units";

export interface Wind {
  /** Direction, true north referenced, from which the wind blows. */
  readonly directionFrom: TrueCourse;
  readonly speed: Knots;
}

/** North/east velocity components in knots, positive toward north/east. */
export interface WindVector {
  readonly north: number;
  readonly east: number;
}

export interface WindAtAltitude {
  readonly altitude: FeetMsl;
  readonly wind: Wind;
}

export interface InterpolatedWind {
  readonly wind: Wind;
  readonly vector: WindVector;
  readonly trace: CalculationTrace;
}

export const wind = (directionFromDegrees: number, speedKnots: number): DomainResult<Wind> => {
  const directionFrom = trueCourse(directionFromDegrees);
  if (!directionFrom.ok) return propagateFailure(directionFrom);
  const speed = knots(speedKnots);
  if (!speed.ok) return propagateFailure(speed);
  return success({ directionFrom: directionFrom.value, speed: speed.value });
};

/** Converts meteorological "from" direction into a velocity vector "toward". */
export const windToVector = (source: Wind): WindVector => {
  const directionRadians = degreesToRadians(source.directionFrom);
  return {
    north: -source.speed * Math.cos(directionRadians),
    east: -source.speed * Math.sin(directionRadians),
  };
};

export const vectorToWind = (vector: WindVector): DomainResult<Wind> => {
  if (!Number.isFinite(vector.north) || !Number.isFinite(vector.east)) {
    return failure("INVALID_NUMBER", "Wind vector components must be finite.");
  }
  const speed = Math.hypot(vector.north, vector.east);
  if (speed < 1e-12) return wind(0, 0);
  // Reverse the toward-vector to obtain a meteorological from direction.
  const directionFrom = radiansToDegrees(Math.atan2(-vector.east, -vector.north));
  return wind(directionFrom, speed);
};

export const interpolateWindAtAltitude = (
  lower: WindAtAltitude,
  upper: WindAtAltitude,
  targetAltitude: FeetMsl,
): DomainResult<InterpolatedWind> => {
  if (upper.altitude <= lower.altitude) {
    return failure("OUT_OF_RANGE", "Upper wind altitude must be greater than lower wind altitude.", {
      lowerAltitude: lower.altitude,
      upperAltitude: upper.altitude,
    });
  }
  if (targetAltitude < lower.altitude || targetAltitude > upper.altitude) {
    return failure("OUT_OF_RANGE", "Target altitude must lie within the selected wind levels.", {
      targetAltitude,
      lowerAltitude: lower.altitude,
      upperAltitude: upper.altitude,
    });
  }
  const fraction = (targetAltitude - lower.altitude) / (upper.altitude - lower.altitude);
  const lowerVector = windToVector(lower.wind);
  const upperVector = windToVector(upper.wind);
  const vector = {
    north: lowerVector.north + (upperVector.north - lowerVector.north) * fraction,
    east: lowerVector.east + (upperVector.east - lowerVector.east) * fraction,
  };
  const interpolated = vectorToWind(vector);
  if (!interpolated.ok) return propagateFailure(interpolated);
  return success({
    wind: interpolated.value,
    vector,
    trace: trace(
      "wind-altitude-vector-interpolation",
      [
        { name: "lower altitude", value: lower.altitude, unit: "feet-msl" },
        { name: "upper altitude", value: upper.altitude, unit: "feet-msl" },
        { name: "target altitude", value: targetAltitude, unit: "feet-msl" },
        { name: "lower wind from", value: lower.wind.directionFrom, unit: "degrees-true" },
        { name: "lower wind speed", value: lower.wind.speed, unit: "knots" },
        { name: "upper wind from", value: upper.wind.directionFrom, unit: "degrees-true" },
        { name: "upper wind speed", value: upper.wind.speed, unit: "knots" },
      ],
      [
        { name: "interpolation fraction", value: fraction, unit: "unitless" },
        { name: "lower north vector", value: lowerVector.north, unit: "knots" },
        { name: "lower east vector", value: lowerVector.east, unit: "knots" },
        { name: "upper north vector", value: upperVector.north, unit: "knots" },
        { name: "upper east vector", value: upperVector.east, unit: "knots" },
        { name: "interpolated north vector", value: vector.north, unit: "knots" },
        { name: "interpolated east vector", value: vector.east, unit: "knots" },
      ],
      { name: "interpolated wind speed", value: interpolated.value.speed, unit: "knots" },
    ),
  });
};

export interface WindSample {
  readonly wind: Wind;
  readonly weight: number;
}

/** Averages wind vectors, never the circular direction values. */
export const averageWindSamples = (samples: readonly WindSample[]): DomainResult<Wind> => {
  if (samples.length === 0) return failure("OUT_OF_RANGE", "At least one wind sample is required.");
  let totalWeight = 0;
  let north = 0;
  let east = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample.weight) || sample.weight <= 0) {
      return failure("OUT_OF_RANGE", "Wind sample weights must be finite and greater than zero.", {
        weight: sample.weight,
      });
    }
    const vector = windToVector(sample.wind);
    totalWeight += sample.weight;
    north += vector.north * sample.weight;
    east += vector.east * sample.weight;
  }
  return vectorToWind({ north: north / totalWeight, east: east / totalWeight });
};

/** Convenience validator for weather adapters with raw published altitude values. */
export const windAtAltitude = (
  altitudeFeetMsl: number,
  directionFromDegrees: number,
  speedKnots: number,
): DomainResult<WindAtAltitude> => {
  const altitude = feetMsl(altitudeFeetMsl);
  if (!altitude.ok) return propagateFailure(altitude);
  const checkedWind = wind(directionFromDegrees, speedKnots);
  if (!checkedWind.ok) return propagateFailure(checkedWind);
  return success({ altitude: altitude.value, wind: checkedWind.value });
};
