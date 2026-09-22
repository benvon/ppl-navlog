import { trace, type CalculationTrace } from "./calculation-trace";
import { failure, success, type DomainResult } from "./errors";
import type { WindAtAltitude } from "./wind";

export interface SurfaceToAloftWindLevels {
  /** The observed surface wind, anchored at the departure airport's field elevation. */
  readonly surfaceAnchor: WindAtAltitude;
  /** The first published FB level strictly above the field-elevation anchor. */
  readonly firstAloftLevel: WindAtAltitude;
  /** Surface anchor followed by all usable published levels above it. */
  readonly levels: readonly WindAtAltitude[];
  readonly trace: CalculationTrace;
}

/**
 * Adds a surface anchor only when it can be joined to a higher published
 * level. The returned levels are then resolved by the normal vector-linear
 * altitude interpolation, never extrapolated below the airport field.
 */
export const joinSurfaceWindToAloftLevels = (
  surfaceAnchor: WindAtAltitude,
  publishedAloftLevels: readonly WindAtAltitude[],
): DomainResult<SurfaceToAloftWindLevels> => {
  const levelsAboveSurface = publishedAloftLevels
    .filter((level) => level.altitude > surfaceAnchor.altitude)
    .sort((first, second) => first.altitude - second.altitude);
  const firstAloftLevel = levelsAboveSurface[0];
  if (firstAloftLevel === undefined) {
    return failure("UNSUPPORTED_WIND_ALTITUDE", "No published winds-aloft level is available above the departure field elevation.", {
      fieldElevationFeetMsl: surfaceAnchor.altitude,
    });
  }
  return success({
    surfaceAnchor,
    firstAloftLevel,
    levels: [surfaceAnchor, ...levelsAboveSurface],
    trace: trace(
      "metar-field-elevation-to-first-fb-level-vector-interpolation",
      [
        { name: "departure field elevation", value: surfaceAnchor.altitude, unit: "feet-msl" },
        { name: "surface wind from", value: surfaceAnchor.wind.directionFrom, unit: "degrees-true" },
        { name: "surface wind speed", value: surfaceAnchor.wind.speed, unit: "knots" },
        { name: "first available FB level", value: firstAloftLevel.altitude, unit: "feet-msl" },
        { name: "FB wind from", value: firstAloftLevel.wind.directionFrom, unit: "degrees-true" },
        { name: "FB wind speed", value: firstAloftLevel.wind.speed, unit: "knots" },
      ],
      [
        { name: "interpolation lower altitude", value: surfaceAnchor.altitude, unit: "feet-msl" },
        { name: "interpolation upper altitude", value: firstAloftLevel.altitude, unit: "feet-msl" },
      ],
      { name: "surface-to-aloft levels available", value: levelsAboveSurface.length + 1, unit: "unitless" },
      "UI decides presentation rounding.",
      ["Planning assumption: the departure METAR true wind is anchored at airport field elevation and vector-interpolated only to the first available FB winds-aloft level."],
    ),
  });
};
