import type { Coordinate } from "../../domain/coordinates";

/**
 * WMM2025 model adapter.
 *
 * Coefficients are copied without modification from NOAA NCEI's WMM2025
 * `WMM.COF` distribution (released 2024-12-17). The implementation follows
 * the accompanying public-domain NOAA C reference algorithm: geodetic to
 * spherical conversion, Schmidt quasi-normalized Legendre functions, and
 * spherical-harmonic field synthesis through degree/order 12.
 *
 * Source and licensing record: docs/magnetic-model.md.
 */

export const WMM2025_MODEL = "WMM-2025" as const;
export const WMM2025_EPOCH = 2025 as const;
export const WMM2025_VALID_FROM = "2024-11-13T00:00:00.000Z" as const;
export const WMM2025_VALID_THROUGH = "2029-12-31T23:59:59.999Z" as const;
export const WMM2025_COEFFICIENT_SHA256 = "06791cd95faba7bdf4a709808f2715a53fe689b29c23b9886bc2196fa9b3eb13" as const;

const MAX_DEGREE = 12;
const WGS84_SEMI_MAJOR_KILOMETERS = 6378.137;
const WGS84_SEMI_MINOR_KILOMETERS = 6356.7523142;
const WMM_REFERENCE_RADIUS_KILOMETERS = 6371.2;
const WGS84_ECCENTRICITY_SQUARED =
  (WGS84_SEMI_MAJOR_KILOMETERS ** 2 - WGS84_SEMI_MINOR_KILOMETERS ** 2) / WGS84_SEMI_MAJOR_KILOMETERS ** 2;
const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;

type Coefficient = readonly [degree: number, order: number, g: number, h: number, gDot: number, hDot: number];

// Derived directly from the NOAA WMM2025 WMM.COF coefficient file.
const COEFFICIENTS: readonly Coefficient[] = [
  [1, 0, -29351.8, 0, 12, 0], [1, 1, -1410.8, 4545.4, 9.7, -21.5], [2, 0, -2556.6, 0, -11.6, 0],
  [2, 1, 2951.1, -3133.6, -5.2, -27.7], [2, 2, 1649.3, -815.1, -8, -12.1], [3, 0, 1361, 0, -1.3, 0],
  [3, 1, -2404.1, -56.6, -4.2, 4], [3, 2, 1243.8, 237.5, 0.4, -0.3], [3, 3, 453.6, -549.5, -15.6, -4.1],
  [4, 0, 895, 0, -1.6, 0], [4, 1, 799.5, 278.6, -2.4, -1.1], [4, 2, 55.7, -133.9, -6, 4.1],
  [4, 3, -281.1, 212, 5.6, 1.6], [4, 4, 12.1, -375.6, -7, -4.4], [5, 0, -233.2, 0, 0.6, 0],
  [5, 1, 368.9, 45.4, 1.4, -0.5], [5, 2, 187.2, 220.2, 0, 2.2], [5, 3, -138.7, -122.9, 0.6, 0.4],
  [5, 4, -142, 43, 2.2, 1.7], [5, 5, 20.9, 106.1, 0.9, 1.9], [6, 0, 64.4, 0, -0.2, 0],
  [6, 1, 63.8, -18.4, -0.4, 0.3], [6, 2, 76.9, 16.8, 0.9, -1.6], [6, 3, -115.7, 48.8, 1.2, -0.4],
  [6, 4, -40.9, -59.8, -0.9, 0.9], [6, 5, 14.9, 10.9, 0.3, 0.7], [6, 6, -60.7, 72.7, 0.9, 0.9],
  [7, 0, 79.5, 0, 0, 0], [7, 1, -77, -48.9, -0.1, 0.6], [7, 2, -8.8, -14.4, -0.1, 0.5],
  [7, 3, 59.3, -1, 0.5, -0.8], [7, 4, 15.8, 23.4, -0.1, 0], [7, 5, 2.5, -7.4, -0.8, -1],
  [7, 6, -11.1, -25.1, -0.8, 0.6], [7, 7, 14.2, -2.3, 0.8, -0.2], [8, 0, 23.2, 0, -0.1, 0],
  [8, 1, 10.8, 7.1, 0.2, -0.2], [8, 2, -17.5, -12.6, 0, 0.5], [8, 3, 2, 11.4, 0.5, -0.4],
  [8, 4, -21.7, -9.7, -0.1, 0.4], [8, 5, 16.9, 12.7, 0.3, -0.5], [8, 6, 15, 0.7, 0.2, -0.6],
  [8, 7, -16.8, -5.2, 0, 0.3], [8, 8, 0.9, 3.9, 0.2, 0.2], [9, 0, 4.6, 0, 0, 0],
  [9, 1, 7.8, -24.8, -0.1, -0.3], [9, 2, 3, 12.2, 0.1, 0.3], [9, 3, -0.2, 8.3, 0.3, -0.3],
  [9, 4, -2.5, -3.3, -0.3, 0.3], [9, 5, -13.1, -5.2, 0, 0.2], [9, 6, 2.4, 7.2, 0.3, -0.1],
  [9, 7, 8.6, -0.6, -0.1, -0.2], [9, 8, -8.7, 0.8, 0.1, 0.4], [9, 9, -12.9, 10, -0.1, 0.1],
  [10, 0, -1.3, 0, 0.1, 0], [10, 1, -6.4, 3.3, 0, 0], [10, 2, 0.2, 0, 0.1, 0],
  [10, 3, 2, 2.4, 0.1, -0.2], [10, 4, -1, 5.3, 0, 0.1], [10, 5, -0.6, -9.1, -0.3, -0.1],
  [10, 6, -0.9, 0.4, 0, 0.1], [10, 7, 1.5, -4.2, -0.1, 0], [10, 8, 0.9, -3.8, -0.1, -0.1],
  [10, 9, -2.7, 0.9, 0, 0.2], [10, 10, -3.9, -9.1, 0, 0], [11, 0, 2.9, 0, 0, 0],
  [11, 1, -1.5, 0, 0, 0], [11, 2, -2.5, 2.9, 0, 0.1], [11, 3, 2.4, -0.6, 0, 0],
  [11, 4, -0.6, 0.2, 0, 0.1], [11, 5, -0.1, 0.5, -0.1, 0], [11, 6, -0.6, -0.3, 0, 0],
  [11, 7, -0.1, -1.2, 0, 0.1], [11, 8, 1.1, -1.7, -0.1, 0], [11, 9, -1, -2.9, -0.1, 0],
  [11, 10, -0.2, -1.8, -0.1, 0], [11, 11, 2.6, -2.3, -0.1, 0], [12, 0, -2, 0, 0, 0],
  [12, 1, -0.2, -1.3, 0, 0], [12, 2, 0.3, 0.7, 0, 0], [12, 3, 1.2, 1, 0, -0.1],
  [12, 4, -1.3, -1.4, 0, 0.1], [12, 5, 0.6, 0, 0, 0], [12, 6, 0.6, 0.6, 0.1, 0],
  [12, 7, 0.5, -0.1, 0, 0], [12, 8, -0.1, 0.8, 0, 0], [12, 9, -0.4, 0.1, 0, 0],
  [12, 10, -0.2, -1, -0.1, 0], [12, 11, -1.3, 0.1, 0, 0], [12, 12, -0.7, 0.2, -0.1, -0.1],
];

export interface MagneticModelInput {
  readonly coordinate: Coordinate;
  /** Date used for secular variation; WMM2025 is valid only in its published interval. */
  readonly date: Date;
  /** Planning altitude referenced to mean sea level. */
  readonly altitudeFeetMsl: number;
}

export interface MagneticModelProvenance {
  readonly model: typeof WMM2025_MODEL;
  readonly epoch: typeof WMM2025_EPOCH;
  readonly coefficientSha256: typeof WMM2025_COEFFICIENT_SHA256;
  readonly validFrom: typeof WMM2025_VALID_FROM;
  readonly validThrough: typeof WMM2025_VALID_THROUGH;
  readonly calculationDate: string;
  readonly decimalYear: number;
  readonly coordinate: Coordinate;
  readonly altitudeFeetMsl: number;
  /** WMM reference software normally applies EGM96; declination impact is negligible for V1 planning. */
  readonly altitudeTreatment: "msl-treated-as-wgs84-ellipsoid-without-egm96-correction";
  readonly source: "NOAA NCEI WMM2025 WMM.COF";
}

export interface MagneticVariation {
  /** East-positive declination, conventionally called magnetic variation. */
  readonly declinationDegrees: number;
  readonly northIntensityNanoTesla: number;
  readonly eastIntensityNanoTesla: number;
  readonly horizontalIntensityNanoTesla: number;
  readonly provenance: MagneticModelProvenance;
}

export class MagneticModelError extends Error {
  public constructor(readonly code: "INVALID_DATE" | "DATE_OUTSIDE_MODEL_VALIDITY" | "INVALID_ALTITUDE" | "DECLINATION_UNDEFINED", message: string) {
    super(message);
    this.name = "MagneticModelError";
  }
}

const coefficientIndex = (degree: number, order: number): number => degree * (degree + 1) / 2 + order;

const decimalYear = (date: Date): number => {
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const nextStart = Date.UTC(year + 1, 0, 1);
  return year + (date.getTime() - start) / (nextStart - start);
};

const validateInput = (input: MagneticModelInput): void => {
  if (Number.isNaN(input.date.getTime())) throw new MagneticModelError("INVALID_DATE", "Magnetic-model calculation requires a valid date.");
  if (input.date < new Date(WMM2025_VALID_FROM) || input.date > new Date(WMM2025_VALID_THROUGH)) {
    throw new MagneticModelError("DATE_OUTSIDE_MODEL_VALIDITY", `WMM2025 is valid only from ${WMM2025_VALID_FROM.slice(0, 10)} through ${WMM2025_VALID_THROUGH.slice(0, 10)}.`);
  }
  if (!Number.isFinite(input.altitudeFeetMsl) || input.altitudeFeetMsl < -3_280.84 || input.altitudeFeetMsl > 2_788_713) {
    throw new MagneticModelError("INVALID_ALTITUDE", "Magnetic-model altitude must be finite and within the WMM supported -1 to 850 km range.");
  }
};

/** Calculate WMM2025 declination with raw, unrounded numeric output. */
export const calculateWmm2025Variation = (input: MagneticModelInput): MagneticVariation => {
  validateInput(input);
  // WMM’s exact-pole special case only yields field intensity; declination is not useful there.
  if (Math.abs(input.coordinate.latitude) >= 89.999999) {
    throw new MagneticModelError("DECLINATION_UNDEFINED", "Magnetic declination is undefined at or immediately adjacent to a geographic pole.");
  }

  const geodeticLatitude = input.coordinate.latitude * DEGREES_TO_RADIANS;
  const longitude = input.coordinate.longitude * DEGREES_TO_RADIANS;
  const altitudeKilometers = input.altitudeFeetMsl * 0.0003048;
  const sineLatitude = Math.sin(geodeticLatitude);
  const cosineLatitude = Math.cos(geodeticLatitude);
  const radiusOfCurvature = WGS84_SEMI_MAJOR_KILOMETERS / Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * sineLatitude ** 2);
  const xp = (radiusOfCurvature + altitudeKilometers) * cosineLatitude;
  const zp = (radiusOfCurvature * (1 - WGS84_ECCENTRICITY_SQUARED) + altitudeKilometers) * sineLatitude;
  const sphericalRadius = Math.hypot(xp, zp);
  const geocentricLatitude = Math.asin(zp / sphericalRadius);
  const sinGeocentricLatitude = Math.sin(geocentricLatitude);
  const legendre = legendreFunctions(sinGeocentricLatitude);
  const radiusPowers = relativeRadiusPowers(sphericalRadius);
  const trigonometry = longitudeTerms(longitude);
  const timedCoefficients = timeAdjustedCoefficients(decimalYear(input.date));

  const sphericalField = synthesizeSphericalField(legendre, radiusPowers, trigonometry, timedCoefficients, geocentricLatitude);
  const latitudeRotation = geocentricLatitude - geodeticLatitude;
  const north = sphericalField.north * Math.cos(latitudeRotation) - sphericalField.down * Math.sin(latitudeRotation);
  const east = sphericalField.east;
  const horizontal = Math.hypot(north, east);
  if (horizontal < 1e-9 || !Number.isFinite(horizontal)) {
    throw new MagneticModelError("DECLINATION_UNDEFINED", "Magnetic declination is undefined because horizontal magnetic intensity is too small.");
  }
  return {
    declinationDegrees: Math.atan2(east, north) * RADIANS_TO_DEGREES,
    northIntensityNanoTesla: north,
    eastIntensityNanoTesla: east,
    horizontalIntensityNanoTesla: horizontal,
    provenance: {
      model: WMM2025_MODEL,
      epoch: WMM2025_EPOCH,
      coefficientSha256: WMM2025_COEFFICIENT_SHA256,
      validFrom: WMM2025_VALID_FROM,
      validThrough: WMM2025_VALID_THROUGH,
      calculationDate: input.date.toISOString(),
      decimalYear: decimalYear(input.date),
      coordinate: input.coordinate,
      altitudeFeetMsl: input.altitudeFeetMsl,
      altitudeTreatment: "msl-treated-as-wgs84-ellipsoid-without-egm96-correction",
      source: "NOAA NCEI WMM2025 WMM.COF",
    },
  };
};

const timeAdjustedCoefficients = (targetDecimalYear: number): { readonly g: readonly number[]; readonly h: readonly number[] } => {
  const g = Array<number>(91).fill(0);
  const h = Array<number>(91).fill(0);
  for (const [degree, order, mainG, mainH, secularG, secularH] of COEFFICIENTS) {
    const index = coefficientIndex(degree, order);
    g[index] = mainG + (targetDecimalYear - WMM2025_EPOCH) * secularG;
    h[index] = mainH + (targetDecimalYear - WMM2025_EPOCH) * secularH;
  }
  return { g, h };
};

const numberAt = (values: readonly number[], index: number): number => values[index] ?? 0;

const synthesizeSphericalField = (
  legendre: { readonly values: readonly number[]; readonly derivatives: readonly number[] },
  radiusPowers: readonly number[],
  trigonometry: { readonly cosine: readonly number[]; readonly sine: readonly number[] },
  timedCoefficients: { readonly g: readonly number[]; readonly h: readonly number[] },
  geocentricLatitude: number,
): { readonly north: number; readonly east: number; readonly down: number } => {
  let north = 0;
  let east = 0;
  let down = 0;
  for (let degree = 1; degree <= MAX_DEGREE; degree += 1) {
    for (let order = 0; order <= degree; order += 1) {
      const index = coefficientIndex(degree, order);
      const g = numberAt(timedCoefficients.g, index);
      const h = numberAt(timedCoefficients.h, index);
      const cosine = numberAt(trigonometry.cosine, order);
      const sine = numberAt(trigonometry.sine, order);
      const fieldTerm = g * cosine + h * sine;
      const radiusPower = numberAt(radiusPowers, degree);
      down -= radiusPower * fieldTerm * (degree + 1) * numberAt(legendre.values, index);
      east += radiusPower * (g * sine - h * cosine) * order * numberAt(legendre.values, index);
      north -= radiusPower * fieldTerm * numberAt(legendre.derivatives, index);
    }
  }
  return { north, east: east / Math.cos(geocentricLatitude), down };
};

const relativeRadiusPowers = (radiusKilometers: number): readonly number[] => {
  const values = Array<number>(MAX_DEGREE + 1).fill(0);
  const ratio = WMM_REFERENCE_RADIUS_KILOMETERS / radiusKilometers;
  values[0] = ratio ** 2;
  for (let degree = 1; degree <= MAX_DEGREE; degree += 1) values[degree] = (values[degree - 1] ?? 0) * ratio;
  return values;
};

const longitudeTerms = (longitude: number): { readonly cosine: readonly number[]; readonly sine: readonly number[] } => {
  const cosine = Array<number>(MAX_DEGREE + 1).fill(0);
  const sine = Array<number>(MAX_DEGREE + 1).fill(0);
  cosine[0] = 1;
  cosine[1] = Math.cos(longitude);
  sine[1] = Math.sin(longitude);
  for (let order = 2; order <= MAX_DEGREE; order += 1) {
    cosine[order] = (cosine[order - 1] ?? 0) * cosine[1] - (sine[order - 1] ?? 0) * sine[1];
    sine[order] = (cosine[order - 1] ?? 0) * sine[1] + (sine[order - 1] ?? 0) * cosine[1];
  }
  return { cosine, sine };
};

const legendreFunctions = (sineLatitude: number): { readonly values: readonly number[]; readonly derivatives: readonly number[] } => {
  const length = (MAX_DEGREE + 1) * (MAX_DEGREE + 2) / 2;
  const values = Array<number>(length).fill(0);
  const derivatives = Array<number>(length).fill(0);
  const normalization = Array<number>(length).fill(0);
  values[0] = 1;
  normalization[0] = 1;
  const z = Math.sqrt((1 - sineLatitude) * (1 + sineLatitude));
  populateRawLegendre(values, derivatives, sineLatitude, z);
  for (let degree = 1; degree <= MAX_DEGREE; degree += 1) {
    normalization[coefficientIndex(degree, 0)] = numberAt(normalization, coefficientIndex(degree - 1, 0)) * (2 * degree - 1) / degree;
    for (let order = 1; order <= degree; order += 1) {
      normalization[coefficientIndex(degree, order)] = numberAt(normalization, coefficientIndex(degree, order - 1)) * Math.sqrt((degree - order + 1) * (order === 1 ? 2 : 1) / (degree + order));
    }
  }
  for (let degree = 1; degree <= MAX_DEGREE; degree += 1) {
    for (let order = 0; order <= degree; order += 1) {
      const index = coefficientIndex(degree, order);
      values[index] = numberAt(values, index) * numberAt(normalization, index);
      derivatives[index] = -numberAt(derivatives, index) * numberAt(normalization, index);
    }
  }
  return { values, derivatives };
};

const populateRawLegendre = (values: number[], derivatives: number[], sineLatitude: number, z: number): void => {
  for (let degree = 1; degree <= MAX_DEGREE; degree += 1) {
    for (let order = 0; order <= degree; order += 1) populateRawLegendreTerm(values, derivatives, degree, order, sineLatitude, z);
  }
};

const populateRawLegendreTerm = (
  values: number[],
  derivatives: number[],
  degree: number,
  order: number,
  sineLatitude: number,
  z: number,
): void => {
  const index = coefficientIndex(degree, order);
  if (degree === order) {
    const prior = coefficientIndex(degree - 1, order - 1);
    values[index] = z * numberAt(values, prior);
    derivatives[index] = z * numberAt(derivatives, prior) + sineLatitude * numberAt(values, prior);
    return;
  }
  if (degree === 1 && order === 0) {
    values[index] = sineLatitude * numberAt(values, 0);
    derivatives[index] = sineLatitude * numberAt(derivatives, 0) - z * numberAt(values, 0);
    return;
  }
  if (degree <= 1) return;
  const priorDegree = coefficientIndex(degree - 1, order);
  if (order > degree - 2) {
    values[index] = sineLatitude * numberAt(values, priorDegree);
    derivatives[index] = sineLatitude * numberAt(derivatives, priorDegree) - z * numberAt(values, priorDegree);
    return;
  }
  const priorTwoDegrees = coefficientIndex(degree - 2, order);
  const factor = ((degree - 1) ** 2 - order ** 2) / ((2 * degree - 1) * (2 * degree - 3));
  values[index] = sineLatitude * numberAt(values, priorDegree) - factor * numberAt(values, priorTwoDegrees);
  derivatives[index] = sineLatitude * numberAt(derivatives, priorDegree) - z * numberAt(values, priorDegree) - factor * numberAt(derivatives, priorTwoDegrees);
};
