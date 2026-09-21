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

  it("invites selection when no complete row is selected", () => {
    expect(renderCalculationInspector(undefined, undefined).textContent).toContain("Choose a value");
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
  });
});
