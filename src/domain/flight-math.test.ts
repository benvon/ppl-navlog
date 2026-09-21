import { describe, expect, it } from "vitest";

import { coordinate } from "./coordinates";
import { deviationTablePoint, interpolateCompassDeviation } from "./deviation";
import { calculateGreatCircleDistanceAndInitialCourse, pointAlongGreatCircle } from "./distance-course";
import { convertMagneticToCompassHeading, convertTrueToMagneticHeading } from "./heading-conversion";
import { calculateEstimatedTimeEnroute, calculateFuelForDuration } from "./time-fuel";
import {
  compassHeading,
  feetMsl,
  gallonsPerHour,
  knots,
  magneticHeading,
  minutes,
  nauticalMiles,
  signedDegrees,
  trueCourse,
  trueHeading,
} from "./units";
import { averageWindSamples, interpolateWindAtAltitude, wind, windAtAltitude, windToVector } from "./wind";
import { solveWindTriangle } from "./wind-triangle";

const value = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!result.ok) throw new Error("Expected a successful domain result.");
  return result.value;
};

describe("coordinate, distance, and course", () => {
  it("validates coordinate boundaries", () => {
    expect(coordinate(90, 180).ok).toBe(true);
    expect(coordinate(-90, -180).ok).toBe(true);
    expect(coordinate(90.001, 0)).toMatchObject({ ok: false, error: { code: "OUT_OF_RANGE" } });
    expect(coordinate(0, Number.NaN)).toMatchObject({ ok: false, error: { code: "INVALID_NUMBER" } });
  });

  it("calculates a known equatorial great-circle distance and course", () => {
    const start = value(coordinate(0, 0));
    const end = value(coordinate(0, 1));
    const result = value(calculateGreatCircleDistanceAndInitialCourse(start, end));
    expect(result.distance).toBeCloseTo(60.04046, 5);
    expect(result.initialTrueCourse).toBeCloseTo(90, 10);
    expect(result.trace.formulaId).toBe("great-circle-distance-and-initial-true-course");
  });

  it("rejects identical and antipodal endpoints", () => {
    const origin = value(coordinate(0, 0));
    expect(calculateGreatCircleDistanceAndInitialCourse(origin, origin)).toMatchObject({
      ok: false,
      error: { code: "IDENTICAL_COORDINATES" },
    });
    expect(calculateGreatCircleDistanceAndInitialCourse(origin, value(coordinate(0, 180)))).toMatchObject({
      ok: false,
      error: { code: "ANTIPODAL_COORDINATES" },
    });
  });

  it("finds a point along a great-circle course", () => {
    const result = value(pointAlongGreatCircle(value(coordinate(0, 0)), value(trueCourse(90)), value(nauticalMiles(60.041))));
    expect(result.latitude).toBeCloseTo(0, 5);
    expect(result.longitude).toBeCloseTo(1, 3);
  });
});

describe("wind vectors and wind triangle", () => {
  it("uses a north/east toward-vector convention for meteorological winds", () => {
    const vector = windToVector(value(wind(270, 20)));
    expect(vector.north).toBeCloseTo(0, 10);
    expect(vector.east).toBeCloseTo(20, 10);
  });

  it("interpolates directions crossing north through vector components", () => {
    const lower = value(windAtAltitude(3000, 350, 20));
    const upper = value(windAtAltitude(9000, 10, 20));
    const result = value(interpolateWindAtAltitude(lower, upper, value(feetMsl(6000))));
    expect(result.wind.directionFrom).toBeCloseTo(0, 8);
    expect(result.wind.speed).toBeCloseTo(19.696, 3);
    expect(result.trace.intermediateValues).toHaveLength(7);
  });

  it("vector-averages samples across north", () => {
    const result = value(
      averageWindSamples([
        { wind: value(wind(350, 20)), weight: 1 },
        { wind: value(wind(10, 20)), weight: 1 },
      ]),
    );
    expect(result.directionFrom).toBeCloseTo(0, 8);
    expect(result.speed).toBeCloseTo(19.696, 3);
  });

  it("solves all wind-triangle outputs together", () => {
    const result = value(solveWindTriangle(value(trueCourse(0)), value(knots(100)), value(wind(270, 20))));
    expect(result.windCorrectionAngle).toBeCloseTo(-11.537, 3);
    expect(result.trueHeading).toBeCloseTo(348.463, 3);
    expect(result.groundspeed).toBeCloseTo(97.98, 2);
    expect(result.trace.result.value).toBe(result.groundspeed);
  });

  it("rejects an impossible crosswind and nonpositive groundspeed", () => {
    expect(solveWindTriangle(value(trueCourse(0)), value(knots(50)), value(wind(270, 51)))).toMatchObject({
      ok: false,
      error: { code: "INVALID_WIND_TRIANGLE" },
    });
    expect(solveWindTriangle(value(trueCourse(0)), value(knots(50)), value(wind(0, 60)))).toMatchObject({
      ok: false,
      error: { code: "NONPOSITIVE_GROUNDSPEED" },
    });
  });
});

describe("heading conversion and compass deviation", () => {
  it("uses an east-positive convention for variation and deviation", () => {
    const magnetic = value(convertTrueToMagneticHeading(value(trueHeading(10)), value(signedDegrees(15))));
    expect(magnetic.heading).toBe(355);
    const compass = value(convertMagneticToCompassHeading(magnetic.heading, value(signedDegrees(-5))));
    expect(compass.heading).toBe(0);
  });

  it("interpolates a deviation table across 360/000", () => {
    const table = [value(deviationTablePoint(350, -2)), value(deviationTablePoint(10, 2))];
    const result = value(interpolateCompassDeviation(table, value(magneticHeading(0))));
    expect(result.deviation).toBeCloseTo(0, 10);
  });

  it("rejects duplicate normalized deviation table headings", () => {
    const table = [value(deviationTablePoint(0, 1)), value(deviationTablePoint(360, 2))];
    expect(interpolateCompassDeviation(table, value(magneticHeading(0)))).toMatchObject({
      ok: false,
      error: { code: "INVALID_DEVIATION_TABLE" },
    });
  });
});

describe("time and fuel", () => {
  it("retains unrounded calculation values in the trace", () => {
    const time = value(calculateEstimatedTimeEnroute(value(nauticalMiles(12.5)), value(knots(100))));
    expect(time.duration).toBe(7.5);
    expect(time.trace.rounding.calculation).toBe("unrounded");
    const fuel = value(calculateFuelForDuration(time.duration, value(gallonsPerHour(8.4))));
    expect(fuel.fuel).toBeCloseTo(1.05, 10);
  });

  it("rejects impossible groundspeed and invalid base units", () => {
    expect(calculateEstimatedTimeEnroute(value(nauticalMiles(10)), value(knots(0)))).toMatchObject({
      ok: false,
      error: { code: "NONPOSITIVE_GROUNDSPEED" },
    });
    expect(minutes(-1)).toMatchObject({ ok: false, error: { code: "OUT_OF_RANGE" } });
    expect(compassHeading(Number.POSITIVE_INFINITY)).toMatchObject({ ok: false, error: { code: "INVALID_NUMBER" } });
  });
});
