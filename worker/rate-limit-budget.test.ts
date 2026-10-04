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

describe("production deployment configuration", () => {
  it("serves both production hostnames from one Worker with the required bindings", () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8")) as {
      env: {
        development: { ratelimits: Array<{ namespace_id: string }> };
        production: {
          workers_dev: boolean;
          routes: Array<{ pattern: string; custom_domain: boolean }>;
          assets: { binding: string; directory: string };
          services: Array<{ binding: string; service: string }>;
          ratelimits: Array<{ name: string; namespace_id: string; simple: { limit: number; period: number } }>;
          vars: { APP_ENV: string };
        };
      };
    };
    const production = config.env.production;
    expect(production.workers_dev).toBe(false);
    expect(production.routes).toEqual([
      { pattern: "navlog.benvon.net", custom_domain: true },
      { pattern: "navlog.pplstudyguide.com", custom_domain: true },
    ]);
    expect(production.assets).toMatchObject({ binding: "ASSETS", directory: "./dist" });
    expect(production.services).toContainEqual({ binding: "RUNWAY_PICKER_API", service: "runway-picker-metar-api" });
    expect(production.vars.APP_ENV).toBe("production");
    expect(production.ratelimits).toEqual([{
      name: "API_RATE_LIMITER",
      namespace_id: "90221002",
      simple: { limit: 60, period: 60 },
    }]);
    expect(production.ratelimits[0]?.namespace_id).not.toBe(config.env.development.ratelimits[0]?.namespace_id);
  });
});


describe("API environment configuration", () => {
  it("cannot enable the local bypass in a default deploy and opts into it only for local dev", () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8")) as {
      vars?: { APP_ENV?: string };
      env: Record<string, { vars: { APP_ENV: string }; ratelimits: Array<{ name: string }> }>;
    };
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(config.vars?.APP_ENV).not.toBe("local");
    expect(pkg.scripts.dev).toContain("wrangler dev --local --var APP_ENV:local");
    expect(pkg.scripts["dev:worker"]).toContain("wrangler dev --local --var APP_ENV:local");
    for (const name of ["development", "production"]) {
      const deployed = config.env[name]!;
      expect(deployed.vars.APP_ENV).toBe(name);
      expect(deployed.ratelimits.some(({ name }) => name === "API_RATE_LIMITER")).toBe(true);
    }
  });
});
