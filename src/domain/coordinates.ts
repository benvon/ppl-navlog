import { failure, propagateFailure, success, type DomainResult } from "./errors";
import { latitude, longitude, type Latitude, type Longitude } from "./units";

export interface Coordinate {
  readonly latitude: Latitude;
  readonly longitude: Longitude;
}

export const coordinate = (latitudeDegrees: number, longitudeDegrees: number): DomainResult<Coordinate> => {
  const checkedLatitude = latitude(latitudeDegrees);
  if (!checkedLatitude.ok) return propagateFailure(checkedLatitude);
  const checkedLongitude = longitude(longitudeDegrees);
  if (!checkedLongitude.ok) return propagateFailure(checkedLongitude);
  return success({ latitude: checkedLatitude.value, longitude: checkedLongitude.value });
};

export const sameCoordinate = (first: Coordinate, second: Coordinate, tolerance = 1e-12): boolean =>
  Math.abs(first.latitude - second.latitude) <= tolerance && Math.abs(first.longitude - second.longitude) <= tolerance;

export const requireDistinctCoordinates = (first: Coordinate, second: Coordinate): DomainResult<void> =>
  sameCoordinate(first, second)
    ? failure("IDENTICAL_COORDINATES", "Route endpoints must not have identical coordinates.")
    : success(undefined);

/** Canonical precision accepted by the bounded winds point endpoint. */
export const canonicalPointCoordinateDegrees = (value: number): number => {
  const formatted = value.toFixed(10).replace(/(?:\.0+|(?:(\.\d*?[1-9]))0+)$/, "$1");
  const normalized = Number(formatted);
  return Object.is(normalized, -0) ? 0 : normalized;
};
