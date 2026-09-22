import { failure, propagateFailure, success, type DomainResult } from "./errors";

declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type Latitude = Brand<number, "Latitude">;
export type Longitude = Brand<number, "Longitude">;
export type TrueCourse = Brand<number, "TrueCourse">;
export type TrueHeading = Brand<number, "TrueHeading">;
export type MagneticHeading = Brand<number, "MagneticHeading">;
export type CompassHeading = Brand<number, "CompassHeading">;
export type SignedDegrees = Brand<number, "SignedDegrees">;
export type Knots = Brand<number, "Knots">;
export type NauticalMiles = Brand<number, "NauticalMiles">;
export type FeetMsl = Brand<number, "FeetMsl">;
export type Minutes = Brand<number, "Minutes">;
export type Gallons = Brand<number, "Gallons">;
export type SignedGallons = Brand<number, "SignedGallons">;
export type GallonsPerHour = Brand<number, "GallonsPerHour">;

const finite = (value: number, field: string): DomainResult<number> =>
  Number.isFinite(value)
    ? success(value)
    : failure("INVALID_NUMBER", `${field} must be a finite number.`, { field, value: String(value) });

const range = <T extends number>(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): DomainResult<T> => {
  const finiteValue = finite(value, field);
  if (!finiteValue.ok) return propagateFailure(finiteValue);
  if (value < minimum || value > maximum) {
    return failure("OUT_OF_RANGE", `${field} must be between ${minimum} and ${maximum}.`, {
      field,
      value,
      minimum,
      maximum,
    });
  }
  return success(value as T);
};

export const latitude = (value: number): DomainResult<Latitude> => range<Latitude>(value, "latitude", -90, 90);
export const longitude = (value: number): DomainResult<Longitude> => range<Longitude>(value, "longitude", -180, 180);

/** Returns a normalized angle in [0, 360). */
export const normalizeDegrees = (value: number): DomainResult<number> => {
  const finiteValue = finite(value, "degrees");
  if (!finiteValue.ok) return finiteValue;
  return success(((value % 360) + 360) % 360);
};

const normalizedHeading = <T>(value: number): DomainResult<T> => {
  const normalized = normalizeDegrees(value);
  return normalized.ok ? success(normalized.value as T) : propagateFailure(normalized);
};

export const trueCourse = (value: number): DomainResult<TrueCourse> => normalizedHeading<TrueCourse>(value);
export const trueHeading = (value: number): DomainResult<TrueHeading> => normalizedHeading<TrueHeading>(value);
export const magneticHeading = (value: number): DomainResult<MagneticHeading> => normalizedHeading<MagneticHeading>(value);
export const compassHeading = (value: number): DomainResult<CompassHeading> => normalizedHeading<CompassHeading>(value);

export const signedDegrees = (value: number): DomainResult<SignedDegrees> => {
  const checked = finite(value, "signed degrees");
  return checked.ok ? success(value as SignedDegrees) : propagateFailure(checked);
};

const nonNegative = <T extends number>(value: number, field: string): DomainResult<T> => {
  const checked = range<T>(value, field, 0, Number.POSITIVE_INFINITY);
  return checked;
};

const positive = <T extends number>(value: number, field: string): DomainResult<T> => {
  const checked = finite(value, field);
  if (!checked.ok) return propagateFailure(checked);
  return value > 0
    ? success(value as T)
    : failure("OUT_OF_RANGE", `${field} must be greater than zero.`, { field, value });
};

export const knots = (value: number): DomainResult<Knots> => nonNegative<Knots>(value, "knots");
export const nauticalMiles = (value: number): DomainResult<NauticalMiles> => nonNegative<NauticalMiles>(value, "nautical miles");
export const feetMsl = (value: number): DomainResult<FeetMsl> => finite(value, "feet MSL") as DomainResult<FeetMsl>;
export const minutes = (value: number): DomainResult<Minutes> => nonNegative<Minutes>(value, "minutes");
export const gallons = (value: number): DomainResult<Gallons> => nonNegative<Gallons>(value, "gallons");
export const signedGallons = (value: number): DomainResult<SignedGallons> => {
  const checked = finite(value, "signed gallons");
  return checked.ok ? success(value as SignedGallons) : propagateFailure(checked);
};
export const gallonsPerHour = (value: number): DomainResult<GallonsPerHour> => positive<GallonsPerHour>(value, "gallons per hour");
export const positiveKnots = (value: number): DomainResult<Knots> => positive<Knots>(value, "knots");

export const degreesToRadians = (degrees: number): number => (degrees * Math.PI) / 180;
export const radiansToDegrees = (radians: number): number => (radians * 180) / Math.PI;
