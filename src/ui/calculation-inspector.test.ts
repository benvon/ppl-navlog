import { describe, expect, it } from "vitest";
import { planRevision } from "../services/storage/__tests__/fixtures";
import { renderCalculationInspector } from "./calculation-inspector";

describe("calculation inspector", () => {
  it("renders structured formula steps, unrounded values, assumptions, and overrides as safe text", () => {
    const revision = {
      ...planRevision(),
      calculationSnapshot: {
        schema: "complete-navlog/v1", status: "calculated",
        navlog: { rows: [{
          subleg: { sourceLegId: "leg-1", phase: "cruise", startingAltitude: 4500, endingAltitude: 4500 },
          trueHeading: 275.423,
          traces: { windTriangle: { formulaId: "wind-triangle", formulaVersion: "1.0.0", inputs: [{ name: "TAS", value: 95, unit: "knots" }], intermediateValues: [{ name: "Crosswind", value: 8.2, unit: "knots" }], result: { name: "True heading", value: 275.423, unit: "degrees-true" }, rounding: { calculation: "unrounded", display: "nearest degree" }, warnings: [] } },
          assumptions: ["Sampled wind <script>alert(1)</script>"],
          appliedOverrides: [{ input: "true-airspeed", computedValue: 90, effectiveValue: 95, reason: "Practice" }],
        }] },
      },
    };
    const rendered = renderCalculationInspector(revision, { rowIndex: 0, field: "trueHeading" });
    expect(rendered.textContent).toContain("Stored unrounded value: 275.423");
    expect(rendered.textContent).toContain("Formula: wind-triangle");
    expect(rendered.textContent).toContain("Crosswind");
    expect(rendered.textContent).toContain("90 → 95");
    expect(rendered.querySelector("script")).toBeNull();
  });

  it("shows the point-weather station, period, weights, and wind triangle for groundspeed", () => {
    const revision = {
      ...planRevision(),
      calculationSnapshot: { schema: "complete-navlog/v1", status: "calculated", navlog: { rows: [{
        subleg: { sourceLegId: "leg-1", phase: "cruise", startingAltitude: 4500, endingAltitude: 4500 },
        effectiveWind: { wind: { effectiveValue: { directionFrom: 270, speed: 12 }, origin: "sampled", provenance: { sourceLabel: "KORD point wind" } }, trace: { formulaId: "point-wind-vector", formulaVersion: "1", inputs: [{ name: "Station", value: "BRL" }, { name: "Use until", value: "2026-09-22T03:00:00.000Z" }, { name: "Horizontal weight", value: 1 }, { name: "Wind lower altitude", value: 3000 }, { name: "Wind upper altitude", value: 6000 }, { name: "Vertical weight", value: 0.5 }, { name: "destination TAF candidate 1 raw", value: "TEMPO 27010KT" }, { name: "destination TAF candidate 1 selected", value: true }, { name: "destination terminal assumption", value: "TAF surface wind is a planning proxy" }], intermediateValues: [], result: { name: "Wind", value: 12 }, rounding: { calculation: "unrounded", display: "one decimal" }, warnings: [] } },
        groundspeed: 92, traces: {
          windTriangle: { formulaId: "wind-triangle", formulaVersion: "1", inputs: [], intermediateValues: [], result: { name: "Groundspeed", value: 92 }, rounding: { calculation: "unrounded", display: "one decimal" }, warnings: [] },
          estimatedTimeEnroute: { formulaId: "distance-over-groundspeed", formulaVersion: "1", inputs: [], intermediateValues: [], result: { name: "ETE", value: 13 }, rounding: { calculation: "unrounded", display: "one decimal" }, warnings: [] },
          fuel: { formulaId: "fuel-flow-times-time", formulaVersion: "1", inputs: [], intermediateValues: [], result: { name: "Fuel", value: 2 }, rounding: { calculation: "unrounded", display: "one decimal" }, warnings: [] },
        }, assumptions: [], appliedOverrides: [],
      }] } },
    };
    const rendered = renderCalculationInspector(revision, { rowIndex: 0, field: "groundspeed" });
    expect(rendered.textContent).toContain("92");
    expect(rendered.textContent).toContain("BRL");
    expect(rendered.textContent).toContain("2026-09-22T03:00:00.000Z");
    expect(rendered.textContent).toContain("Formula: point-wind-vector");
    expect(rendered.textContent).toContain("Wind lower altitude");
    expect(rendered.textContent).toContain("destination TAF candidate 1 raw");
    expect(rendered.textContent).toContain("destination terminal assumption");
    expect(rendered.textContent).toContain("Formula: wind-triangle");
  });

  it("invites selection when no complete row is selected", () => {
    expect(renderCalculationInspector(undefined, undefined).textContent).toContain("Choose a value");
  });

  it("shows endpoint weather request and cache provenance with a selected result", () => {
    const revision = {
      ...planRevision(),
      calculationSnapshot: { schema: "complete-navlog/v1", status: "calculated", weather: { endpointSources: {
        departureMetar: { stationIcao: "KORD", requestId: "dep-1", fetchedAt: "2026-09-22T12:00:00Z", observedAt: "2026-09-22T11:45:00Z", selectedForTerminalWind: false, cache: { status: "kv_hit", source: "kv", fetchedAt: "2026-09-22T12:00:00Z", expiresAt: "2026-09-22T12:05:00Z", freshnessRemainingSeconds: 300 } },
        destinationTaf: { stationIcao: "KJVL", requestId: "taf-1", issuedAt: "2026-09-22T10:00:00Z", validFrom: "2026-09-22T12:00:00Z", validUntil: "2026-09-23T12:00:00Z", selectedForTerminalWind: true },
        destinationMetar: { stationIcao: "KJVL", requestId: "metar-1", fetchedAt: "2026-09-22T12:00:00Z", observedAt: "2026-09-22T11:00:00Z", selectedForTerminalWind: false, cache: { status: "stale_on_error", source: "stale", fetchedAt: "2026-09-22T12:00:00Z", expiresAt: "2026-09-22T11:00:00Z", freshnessRemainingSeconds: 0 } },
      } }, navlog: { rows: [{ subleg: { sourceLegId: "leg-1", phase: "cruise" }, assumptions: [], appliedOverrides: [] }] } },
    };
    const rendered = renderCalculationInspector(revision, { rowIndex: 0, field: "distance" });
    expect(rendered.textContent).toContain("Endpoint weather sources");
    expect(rendered.textContent).toContain("KORD; request dep-1");
    expect(rendered.textContent).toContain("cache kv_hit");
    expect(rendered.textContent).toContain("from kv; fetched 2026-09-22T12:00:00Z; expires 2026-09-22T12:05:00Z; freshness 300 seconds");
    expect(rendered.textContent).toContain("KJVL; request taf-1");
    expect(rendered.textContent).toContain("valid 2026-09-22T12:00:00Z to 2026-09-23T12:00:00Z");
    expect(rendered.textContent).toContain("Destination TAF (Selected for terminal wind)");
    expect(rendered.textContent).toContain("Destination METAR (Fetched source; not selected for terminal wind)");
  });

  it("shows wind provenance and a phase-allocation explanation when no calculation trace applies", () => {
    const revision = {
      ...planRevision(),
      calculationSnapshot: {
        schema: "complete-navlog/v1", status: "calculated",
        navlog: { rows: [{
          subleg: { sourceLegId: "leg-1", phase: "climb", startingAltitude: 680, endingAltitude: 4500, distance: 12 },
          effectiveWind: { wind: { effectiveValue: { directionFrom: 270, speed: 12 }, origin: "interpolated", provenance: { sourceLabel: "METAR-to-FB bridge" } }, trace: { formulaId: "vector-average", formulaVersion: "1.0.0", inputs: [], intermediateValues: [], result: { name: "Wind", value: 12, unit: "knots" }, rounding: { calculation: "unrounded", display: "one decimal" }, warnings: ["Surface anchor applied"] } },
          assumptions: ["METAR wind anchored at field elevation."], appliedOverrides: [], traces: {},
        }] },
      },
    };
    const wind = renderCalculationInspector(revision, { rowIndex: 0, field: "wind" });
    expect(wind.textContent).toContain("270° from at 12 kt");
    expect(wind.textContent).toContain("Origin: interpolated. Source: METAR-to-FB bridge");
    expect(wind.textContent).toContain("Surface anchor applied");
    const distance = renderCalculationInspector(revision, { rowIndex: 0, field: "distance" });
    expect(distance.textContent).toContain("route or phase allocation");
    expect(distance.textContent).toContain("no detailed trace was stored");
    expect(distance.textContent).not.toContain("phase-boundary evidence in the navlog");
  });
});
