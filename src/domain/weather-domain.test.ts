import { describe, expect, it } from "vitest";

import { parseCompactCoordinate } from "./coordinate-input";
import { coordinate } from "./coordinates";
import { feetMsl } from "./units";
import { windAtAltitude } from "./wind";
import { resolveWindAtAltitude } from "./weather-altitude";
import { sampleEffectivePhaseWind } from "./weather-effective-wind";
import { selectNearestWindsStation } from "./weather-stations";
import { selectForecastValidTime } from "./weather-valid-time";

const value = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!result.ok) throw new Error("Expected successful domain result.");
  return result.value;
};

describe("SkyVector compact coordinate input", () => {
  it("normalizes whitespace and hemisphere case into canonical decimal coordinates", () => {
    const first = value(parseCompactCoordinate(" 420604n0884405w "));
    expect(first.latitude).toBeCloseTo(42.101111111, 8);
    expect(first.longitude).toBeCloseTo(-88.734722222, 8);
    const second = value(parseCompactCoordinate("421358N0884647W"));
    expect(second.latitude).toBeCloseTo(42.232777778, 8);
    expect(second.longitude).toBeCloseTo(-88.779722222, 8);
  });

  it("rejects malformed input with the original input and expected format", () => {
    expect(parseCompactCoordinate("420604N0884405")).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_COORDINATE_FORMAT",
        details: { input: "420604N0884405", expectedFormat: "DDMMSSNDDDMMSSW" },
      },
    });
    expect(parseCompactCoordinate("420660N0884405W")).toMatchObject({
      ok: false,
      error: { code: "INVALID_COORDINATE_FORMAT", details: { reason: expect.stringContaining("minutes") } },
    });
  });

  it("only permits zero minutes and seconds at latitude 90 or longitude 180", () => {
    expect(parseCompactCoordinate("900000N1800000E")).toMatchObject({ ok: true });
    expect(parseCompactCoordinate("900001N1800000E")).toMatchObject({
      ok: false,
      error: { code: "INVALID_COORDINATE_FORMAT", details: { reason: expect.stringContaining("90 degrees") } },
    });
    expect(parseCompactCoordinate("900000N1800001E")).toMatchObject({
      ok: false,
      error: { code: "INVALID_COORDINATE_FORMAT", details: { reason: expect.stringContaining("180 degrees") } },
    });
  });
});

describe("winds-station selection", () => {
  it("uses great-circle distance and a stable station-id tie break", () => {
    const route = value(coordinate(42, -88));
    const selected = value(
      selectNearestWindsStation(route, [
        { id: "ZZZ", coordinate: value(coordinate(42, -89)) },
        { id: "AAA", coordinate: value(coordinate(42, -87)) },
        { id: "ORD", coordinate: route },
      ]),
    );
    expect(selected.station.id).toBe("ORD");
    expect(selected.distance).toBe(0);
    expect(selected.selectionMethod).toBe("nearest-great-circle-distance-then-station-id");
    expect(selected.trace.formulaId).toBe("nearest-winds-station-selection");
  });

  it("breaks an equal-distance tie by station ID", () => {
    const route = value(coordinate(0, 0));
    const selected = value(
      selectNearestWindsStation(route, [
        { id: "ZZZ", coordinate: value(coordinate(0, -1)) },
        { id: "AAA", coordinate: value(coordinate(0, 1)) },
      ]),
    );
    expect(selected.station.id).toBe("AAA");
  });

  it("rejects missing and malformed station inventories", () => {
    const route = value(coordinate(42, -88));
    expect(selectNearestWindsStation(route, [])).toMatchObject({ ok: false, error: { code: "NO_WIND_STATIONS" } });
    expect(selectNearestWindsStation(route, [{ id: " ", coordinate: route }])).toMatchObject({
      ok: false,
      error: { code: "INVALID_WIND_STATION" },
    });
  });
});

describe("explicit forecast valid-time selection", () => {
  const periods = [
    { id: "1200Z", validFromUtc: "2026-09-21T12:00:00Z", validToUtc: "2026-09-21T18:00:00Z" },
    { id: "1800Z", validFromUtc: "2026-09-21T18:00:00Z", validToUtc: "2026-09-22T00:00:00Z" },
  ] as const;

  it("accepts a selected period only when departure is inside its interval", () => {
    const selected = value(selectForecastValidTime(periods, "1200Z", "2026-09-21T14:30:00Z"));
    expect(selected.period.id).toBe("1200Z");
    expect(selected.selectionMethod).toBe("explicit-period-id");
    expect(selected.trace.formulaId).toBe("explicit-forecast-valid-time-selection");
  });

  it("does not silently substitute a different period", () => {
    expect(selectForecastValidTime(periods, "1200Z", "2026-09-21T18:00:00Z")).toMatchObject({
      ok: false,
      error: { code: "FORECAST_OUTSIDE_VALIDITY" },
    });
    expect(selectForecastValidTime(periods, "missing", "2026-09-21T14:30:00Z")).toMatchObject({
      ok: false,
      error: { code: "INVALID_FORECAST_PERIOD" },
    });
    expect(selectForecastValidTime(periods, "1200Z", "2026-02-30T14:30:00Z")).toMatchObject({
      ok: false,
      error: { code: "INVALID_FORECAST_PERIOD" },
    });
  });
});

describe("altitude interpolation and effective phase wind", () => {
  const levels = [value(windAtAltitude(3000, 350, 20)), value(windAtAltitude(9000, 10, 20))];

  it("resolves exact levels and vector-interpolates only within the published envelope", () => {
    const exact = value(resolveWindAtAltitude(levels, value(feetMsl(3000))));
    expect(exact.interpolation).toBe("published-level");
    const interpolated = value(resolveWindAtAltitude(levels, value(feetMsl(6000))));
    expect(interpolated.interpolation).toBe("vector-linear");
    expect(interpolated.wind.directionFrom).toBeCloseTo(0, 8);
    expect(resolveWindAtAltitude(levels, value(feetMsl(12000)))).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_WIND_ALTITUDE" },
    });
  });

  it("samples inclusive altitude endpoints with deterministic trapezoidal vector averaging", () => {
    const result = value(sampleEffectivePhaseWind(levels, value(feetMsl(3000)), value(feetMsl(9000))));
    expect(result.samples).toHaveLength(5);
    expect(result.samples.map((sample) => sample.altitude)).toEqual([3000, 4500, 6000, 7500, 9000]);
    expect(result.samples.map((sample) => sample.weight)).toEqual([0.5, 1, 1, 1, 0.5]);
    expect(result.wind.directionFrom).toBeCloseTo(0, 8);
    expect(result.wind.speed).toBeCloseTo(19.696, 3);
    expect(result.trace.warnings[0]).toContain("vector-averaged");
  });

  it("uses the same altitude samples for descent and rejects invalid sampling", () => {
    const climb = value(sampleEffectivePhaseWind(levels, value(feetMsl(3000)), value(feetMsl(9000)), { sampleCount: 3 }));
    const descent = value(sampleEffectivePhaseWind(levels, value(feetMsl(9000)), value(feetMsl(3000)), { sampleCount: 3 }));
    expect(descent.samples.map((sample) => sample.altitude)).toEqual(climb.samples.map((sample) => sample.altitude));
    expect(descent.wind).toEqual(climb.wind);
    expect(sampleEffectivePhaseWind(levels, value(feetMsl(3000)), value(feetMsl(3000)))).toMatchObject({
      ok: false,
      error: { code: "INVALID_WIND_SAMPLING" },
    });
    expect(sampleEffectivePhaseWind(levels, value(feetMsl(3000)), value(feetMsl(9000)), { sampleCount: 1 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_WIND_SAMPLING" },
    });
  });
});
