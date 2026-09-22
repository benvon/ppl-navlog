import { coordinate, type Coordinate } from "./coordinates";
import { failure, propagateFailure, success, type DomainResult } from "./errors";

export const COMPACT_COORDINATE_FORMAT = "DDMMSSNDDDMMSSW";

interface CoordinateComponent {
  readonly degrees: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly hemisphere: string;
}

const compactCoordinatePattern = /^(\d{2})(\d{2})(\d{2})([NS])(\d{3})(\d{2})(\d{2})([EW])$/;

const coordinateFormatFailure = (input: string, reason: string): DomainResult<never> =>
  failure("INVALID_COORDINATE_FORMAT", "Coordinate must use SkyVector compact DMS format.", {
    input,
    expectedFormat: COMPACT_COORDINATE_FORMAT,
    reason,
  });

const parseInteger = (value: string): number => Number.parseInt(value, 10);

const parseComponent = (
  degreesText: string,
  minutesText: string,
  secondsText: string,
  hemisphere: string,
): CoordinateComponent => ({
  degrees: parseInteger(degreesText),
  minutes: parseInteger(minutesText),
  seconds: parseInteger(secondsText),
  hemisphere,
});

const validateComponent = (
  input: string,
  component: CoordinateComponent,
  maximumDegrees: number,
  axis: "latitude" | "longitude",
): DomainResult<void> => {
  if (component.minutes > 59 || component.seconds > 59) {
    return coordinateFormatFailure(input, `${axis} minutes and seconds must each be between 00 and 59.`);
  }
  if (component.degrees > maximumDegrees) {
    return coordinateFormatFailure(input, `${axis} degrees must not exceed ${maximumDegrees}.`);
  }
  if (component.degrees === maximumDegrees && (component.minutes !== 0 || component.seconds !== 0)) {
    return coordinateFormatFailure(input, `${axis} at ${maximumDegrees} degrees must have 00 minutes and 00 seconds.`);
  }
  return success(undefined);
};

const componentToDecimalDegrees = (component: CoordinateComponent): number => {
  const magnitude = component.degrees + component.minutes / 60 + component.seconds / 3600;
  return component.hemisphere === "S" || component.hemisphere === "W" ? -magnitude : magnitude;
};

/**
 * Parses SkyVector-style compact DMS input such as 420604N0884405W.
 * Leading/trailing whitespace and lowercase hemisphere letters are normalized;
 * all other deviations from the fixed-width format are rejected.
 */
export const parseCompactCoordinate = (input: string): DomainResult<Coordinate> => {
  const normalized = input.trim().toUpperCase();
  const matched = compactCoordinatePattern.exec(normalized);
  if (matched === null) {
    return coordinateFormatFailure(input, "Input must contain exactly 15 compact DMS characters after trimming.");
  }
  const [
    ,
    latitudeDegrees,
    latitudeMinutes,
    latitudeSeconds,
    latitudeHemisphere,
    longitudeDegrees,
    longitudeMinutes,
    longitudeSeconds,
    longitudeHemisphere,
  ] = matched;
  if (
    latitudeDegrees === undefined ||
    latitudeMinutes === undefined ||
    latitudeSeconds === undefined ||
    latitudeHemisphere === undefined ||
    longitudeDegrees === undefined ||
    longitudeMinutes === undefined ||
    longitudeSeconds === undefined ||
    longitudeHemisphere === undefined
  ) {
    return coordinateFormatFailure(input, "Input did not contain all required coordinate components.");
  }
  const latitudeComponent = parseComponent(latitudeDegrees, latitudeMinutes, latitudeSeconds, latitudeHemisphere);
  const longitudeComponent = parseComponent(longitudeDegrees, longitudeMinutes, longitudeSeconds, longitudeHemisphere);
  const latitudeValid = validateComponent(input, latitudeComponent, 90, "latitude");
  if (!latitudeValid.ok) return propagateFailure(latitudeValid);
  const longitudeValid = validateComponent(input, longitudeComponent, 180, "longitude");
  if (!longitudeValid.ok) return propagateFailure(longitudeValid);
  return coordinate(componentToDecimalDegrees(latitudeComponent), componentToDecimalDegrees(longitudeComponent));
};
