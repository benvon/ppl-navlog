import { trace, type CalculationTrace } from "./calculation-trace";
import { failure, propagateFailure, success, type DomainResult } from "./errors";
import { feetMsl, type FeetMsl } from "./units";
import { interpolateWindAtAltitude, type Wind, type WindAtAltitude } from "./wind";

export interface AltitudeResolvedWind {
  readonly requestedAltitude: FeetMsl;
  readonly wind: Wind;
  readonly sourceLevels: readonly WindAtAltitude[];
  readonly interpolation: "published-level" | "vector-linear";
  readonly trace: CalculationTrace;
}

const levelsSortedByAltitude = (levels: readonly WindAtAltitude[]): readonly WindAtAltitude[] =>
  [...levels].sort((first, second) => first.altitude - second.altitude);

const validateLevels = (levels: readonly WindAtAltitude[]): DomainResult<readonly WindAtAltitude[]> => {
  if (levels.length === 0) {
    return failure("UNSUPPORTED_WIND_ALTITUDE", "No published winds-aloft levels are available.");
  }
  const sorted = levelsSortedByAltitude(levels);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous === undefined || current === undefined) continue;
    if (previous.altitude === current.altitude) {
      return failure("UNSUPPORTED_WIND_ALTITUDE", "Published winds-aloft levels must have unique altitudes.", {
        altitude: current.altitude,
      });
    }
  }
  return success(sorted);
};

/** Resolves a requested altitude only within the published level envelope. */
export const resolveWindAtAltitude = (
  levels: readonly WindAtAltitude[],
  requestedAltitude: FeetMsl,
): DomainResult<AltitudeResolvedWind> => {
  const validatedLevels = validateLevels(levels);
  if (!validatedLevels.ok) return propagateFailure(validatedLevels);
  const sorted = validatedLevels.value;
  const lowest = sorted[0];
  const highest = sorted[sorted.length - 1];
  if (lowest === undefined || highest === undefined) {
    return failure("UNSUPPORTED_WIND_ALTITUDE", "No published winds-aloft levels are available.");
  }
  if (requestedAltitude < lowest.altitude || requestedAltitude > highest.altitude) {
    return failure("UNSUPPORTED_WIND_ALTITUDE", "Requested altitude is outside the published winds-aloft level envelope.", {
      requestedAltitude,
      lowestAvailableAltitude: lowest.altitude,
      highestAvailableAltitude: highest.altitude,
    });
  }
  const exact = sorted.find((level) => level.altitude === requestedAltitude);
  if (exact !== undefined) {
    return success({
      requestedAltitude,
      wind: exact.wind,
      sourceLevels: [exact],
      interpolation: "published-level",
      trace: trace(
        "winds-aloft-published-level-selection",
        [{ name: "requested altitude", value: requestedAltitude, unit: "feet-msl" }],
        [
          { name: "published wind from", value: exact.wind.directionFrom, unit: "degrees-true" },
          { name: "published wind speed", value: exact.wind.speed, unit: "knots" },
        ],
        { name: "resolved wind speed", value: exact.wind.speed, unit: "knots" },
      ),
    });
  }
  const upperIndex = sorted.findIndex((level) => level.altitude > requestedAltitude);
  const lower = sorted[upperIndex - 1];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) {
    return failure("UNSUPPORTED_WIND_ALTITUDE", "Requested altitude cannot be bracketed by published winds-aloft levels.", {
      requestedAltitude,
    });
  }
  const interpolation = interpolateWindAtAltitude(lower, upper, requestedAltitude);
  if (!interpolation.ok) return propagateFailure(interpolation);
  return success({
    requestedAltitude,
    wind: interpolation.value.wind,
    sourceLevels: [lower, upper],
    interpolation: "vector-linear",
    trace: interpolation.value.trace,
  });
};

/** Adapter-friendly boundary for raw altitude values. */
export const resolveWindAtAltitudeFeet = (
  levels: readonly WindAtAltitude[],
  requestedAltitudeFeetMsl: number,
): DomainResult<AltitudeResolvedWind> => {
  const requestedAltitude = feetMsl(requestedAltitudeFeetMsl);
  return requestedAltitude.ok ? resolveWindAtAltitude(levels, requestedAltitude.value) : propagateFailure(requestedAltitude);
};
