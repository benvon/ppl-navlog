import { describe, expect, it } from "vitest";
import { route } from "../services/storage/__tests__/fixtures";
import { routeDistanceMidpoint } from "./weather-station-reference";

describe("winds-station representative point", () => {
  it("locates the ordered route's distance midpoint without choosing a station", () => {
    const midpoint = routeDistanceMidpoint(route());
    expect(midpoint.latitude).toBeGreaterThan(41.7);
    expect(midpoint.latitude).toBeLessThan(42.7);
    expect(midpoint.longitude).toBeLessThan(-87.9);
    expect(midpoint.longitude).toBeGreaterThan(-89.1);
  });

  it("rejects missing route geometry", () => {
    expect(() => routeDistanceMidpoint({ ...route(), legs: [] })).toThrow(/positive distance/u);
  });
});
