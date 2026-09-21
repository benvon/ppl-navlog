import { describe, expect, it } from "vitest";

import { coordinate } from "../../domain/coordinates";
import {
  MagneticModelError,
  WMM2025_COEFFICIENT_SHA256,
  WMM2025_MODEL,
  calculateWmm2025Variation,
} from "./wmm2025";

const coordinateValue = (latitude: number, longitude: number) => {
  const result = coordinate(latitude, longitude);
  if (!result.ok) throw new Error("Test coordinate must be valid.");
  return result.value;
};

describe("WMM2025 magnetic variation", () => {
  it("matches NOAA's published WMM2025 reference declinations", () => {
    const at2025 = calculateWmm2025Variation({ coordinate: coordinateValue(80, 0), date: new Date("2025-01-01T00:00:00.000Z"), altitudeFeetMsl: 0 });
    const at2027 = calculateWmm2025Variation({ coordinate: coordinateValue(80, 0), date: new Date("2027-07-02T12:00:00.000Z"), altitudeFeetMsl: 0 });

    expect(at2025.declinationDegrees).toBeCloseTo(1.28, 2);
    expect(at2025.northIntensityNanoTesla).toBeCloseTo(6_521.6, 0);
    expect(at2025.eastIntensityNanoTesla).toBeCloseTo(145.9, 0);
    expect(at2027.declinationDegrees).toBeCloseTo(2.59, 2);
  });

  it("preserves model, data, date, coordinate, and altitude provenance", () => {
    const result = calculateWmm2025Variation({ coordinate: coordinateValue(42.1, -88.7), date: new Date("2026-09-21T12:00:00.000Z"), altitudeFeetMsl: 4_500 });

    expect(result.provenance).toMatchObject({
      model: WMM2025_MODEL,
      coefficientSha256: WMM2025_COEFFICIENT_SHA256,
      calculationDate: "2026-09-21T12:00:00.000Z",
      coordinate: { latitude: 42.1, longitude: -88.7 },
      altitudeFeetMsl: 4_500,
      altitudeTreatment: "msl-treated-as-wgs84-ellipsoid-without-egm96-correction",
    });
  });

  it("fails explicitly outside WMM2025 validity or at a declination singularity", () => {
    expect(() => calculateWmm2025Variation({ coordinate: coordinateValue(42, -88), date: new Date("2030-01-01T00:00:00.000Z"), altitudeFeetMsl: 0 }))
      .toThrow(MagneticModelError);
    expect(() => calculateWmm2025Variation({ coordinate: coordinateValue(90, 0), date: new Date("2026-01-01T00:00:00.000Z"), altitudeFeetMsl: 0 }))
      .toThrow(/undefined/iu);
  });
});
