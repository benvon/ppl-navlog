import { trace, type CalculationTrace } from "./calculation-trace";
import { failure, propagateFailure, success, type DomainResult } from "./errors";
import { feetMsl, type FeetMsl } from "./units";
import { averageWindSamples, windToVector, type Wind, type WindAtAltitude, type WindVector } from "./wind";
import { resolveWindAtAltitude, type AltitudeResolvedWind } from "./weather-altitude";

export interface EffectiveWindSample {
  readonly altitude: FeetMsl;
  /** Trapezoidal sample weight; endpoint samples receive half weight. */
  readonly weight: number;
  readonly resolvedWind: AltitudeResolvedWind;
  readonly vector: WindVector;
}

export interface EffectivePhaseWind {
  readonly wind: Wind;
  readonly samples: readonly EffectiveWindSample[];
  readonly samplingMethod: "even-altitude-trapezoidal-vector-average";
  readonly trace: CalculationTrace;
}

export interface EffectiveWindSamplingOptions {
  /** Number of inclusive endpoint samples. Defaults to five. */
  readonly sampleCount?: number;
}

const DEFAULT_SAMPLE_COUNT = 5;

const resolvedSampleCount = (options: EffectiveWindSamplingOptions): DomainResult<number> => {
  const sampleCount = options.sampleCount ?? DEFAULT_SAMPLE_COUNT;
  if (!Number.isInteger(sampleCount) || sampleCount < 2 || sampleCount > 25) {
    return failure("INVALID_WIND_SAMPLING", "Effective wind sample count must be an integer from 2 through 25.", {
      sampleCount,
    });
  }
  return success(sampleCount);
};

const sampleAltitude = (lower: FeetMsl, upper: FeetMsl, index: number, count: number): DomainResult<FeetMsl> =>
  feetMsl(lower + ((upper - lower) * index) / (count - 1));

/**
 * Samples inclusive endpoints at evenly spaced altitudes and applies
 * trapezoidal weights before vector averaging. Input order may be climb or
 * descent; each result remains deterministic and uses the same altitude set.
 */
export const sampleEffectivePhaseWind = (
  levels: readonly WindAtAltitude[],
  startingAltitude: FeetMsl,
  targetAltitude: FeetMsl,
  options: EffectiveWindSamplingOptions = {},
): DomainResult<EffectivePhaseWind> => {
  if (startingAltitude === targetAltitude) {
    return failure("INVALID_WIND_SAMPLING", "Effective phase wind requires distinct starting and target altitudes.", {
      startingAltitude,
      targetAltitude,
    });
  }
  const count = resolvedSampleCount(options);
  if (!count.ok) return propagateFailure(count);
  const lower = Math.min(startingAltitude, targetAltitude) as FeetMsl;
  const upper = Math.max(startingAltitude, targetAltitude) as FeetMsl;
  const samples: EffectiveWindSample[] = [];
  for (let index = 0; index < count.value; index += 1) {
    const altitude = sampleAltitude(lower, upper, index, count.value);
    if (!altitude.ok) return propagateFailure(altitude);
    const resolvedWind = resolveWindAtAltitude(levels, altitude.value);
    if (!resolvedWind.ok) return propagateFailure(resolvedWind);
    const weight = index === 0 || index === count.value - 1 ? 0.5 : 1;
    samples.push({
      altitude: altitude.value,
      weight,
      resolvedWind: resolvedWind.value,
      vector: windToVector(resolvedWind.value.wind),
    });
  }
  const averaged = averageWindSamples(samples.map((sample) => ({ wind: sample.resolvedWind.wind, weight: sample.weight })));
  if (!averaged.ok) return propagateFailure(averaged);
  const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0);
  const averageVector = samples.reduce(
    (sum, sample) => ({
      north: sum.north + (sample.vector.north * sample.weight) / totalWeight,
      east: sum.east + (sample.vector.east * sample.weight) / totalWeight,
    }),
    { north: 0, east: 0 },
  );
  return success({
    wind: averaged.value,
    samples,
    samplingMethod: "even-altitude-trapezoidal-vector-average",
    trace: trace(
      "effective-phase-wind-vector-sampling",
      [
        { name: "starting altitude", value: startingAltitude, unit: "feet-msl" },
        { name: "target altitude", value: targetAltitude, unit: "feet-msl" },
        { name: "sample count", value: count.value, unit: "unitless" },
      ],
      [
        { name: "total trapezoidal weight", value: totalWeight, unit: "unitless" },
        { name: "average north vector", value: averageVector.north, unit: "knots" },
        { name: "average east vector", value: averageVector.east, unit: "knots" },
        { name: "effective wind from", value: averaged.value.directionFrom, unit: "degrees-true" },
      ],
      { name: "effective wind speed", value: averaged.value.speed, unit: "knots" },
      "UI decides presentation rounding.",
      ["Winds are sampled at inclusive evenly spaced altitude endpoints and vector-averaged with trapezoidal weights."],
    ),
  });
};
