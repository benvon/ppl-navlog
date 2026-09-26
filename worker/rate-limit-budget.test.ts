import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_CHECKPOINTS_PER_PLAN } from "../src/services/storage/pilot-input-repository";

describe("development API rate-limit budget", () => {
  it("covers the maximum supported route, airport lookups, and departure METAR fallback", () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8")) as {
      env: { development: { ratelimits: Array<{ name: string; simple: { limit: number; period: number } }> } };
    };
    const limiter = config.env.development.ratelimits.find(({ name }) => name === "API_RATE_LIMITER");
    if (!limiter) throw new Error("Development API_RATE_LIMITER is not configured");

    const maxRouteStartWaypoints = MAX_CHECKPOINTS_PER_PLAN + 1; // Checkpoints and departure; destination starts no segment.
    const generatedWeatherPoints = 2; // Top of climb and top of descent.
    const airportLookups = 2; // Departure and destination.
    const departureMetarCallsWithFallback = 2; // Primary, then pilot-provided alternate only when unavailable.
    const maxRequests = maxRouteStartWaypoints + generatedWeatherPoints + airportLookups + departureMetarCallsWithFallback;

    expect(maxRequests).toBe(32);
    expect(limiter.simple.period).toBe(60);
    expect(limiter.simple.limit).toBeGreaterThanOrEqual(maxRequests);
  });
});
