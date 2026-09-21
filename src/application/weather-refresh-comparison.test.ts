import { describe, expect, it } from "vitest";
import type { WeatherReferenceSnapshot } from "../domain/route";
import { compareWeatherRefresh } from "./weather-refresh-comparison";

describe("weather refresh comparison", () => {
  it("does not call a retrieval timestamp or immutable ID change a change in weather content", () => {
    const prior: WeatherReferenceSnapshot = { schemaVersion: 1, id: "old", source: "AWC", retrievedAt: "2026-09-21T12:00:00.000Z", payload: { wind: 10 } };
    const next: WeatherReferenceSnapshot = { ...prior, id: "new", retrievedAt: "2026-09-21T13:00:00.000Z" };
    const comparison = compareWeatherRefresh("parent", [prior], [next], { status: "calculated" }, { status: "calculated" });
    expect(comparison.weather.snapshotSetChanged).toBe(true);
    expect(comparison.weather.contentChanged).toBe(false);
    expect(comparison.calculation.changed).toBe(false);
  });
});
