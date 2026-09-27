import { describe, expect, it } from "vitest";
import { planRevision } from "../services/storage/__tests__/fixtures";
import { renderCalculationInspector } from "./calculation-inspector";

describe("calculation inspector", () => {
  it("describes wind from the right as a leftward push requiring a right correction", () => {
    const revision = teachingRevision();
    const row = revision.calculationSnapshot.navlog.rows[0]!;
    row.subleg.trueCourse = 90;
    row.effectiveWind.wind.effectiveValue.directionFrom = 180;
    row.traces.windTriangle.intermediateValues[0]!.value = 0;
    row.traces.windTriangle.intermediateValues[1]!.value = -10;
    row.traces.windTriangle.intermediateValues[2]!.value = Math.sqrt(110 ** 2 - 10 ** 2);
    row.windCorrectionAngle = 5.216;
    row.trueHeading = 95.216;
    row.groundspeed = Math.sqrt(110 ** 2 - 10 ** 2);
    const walkthrough = renderCalculationInspector(revision, { rowIndex: 0, field: "windCorrectionAngle" }).querySelector(".calculation-walkthrough")?.textContent;
    expect(walkthrough).toContain("10 kt crosswind from the right pushes left; steer 5.216° right into the wind");
  });
  it("teaches the full fuel and compass chains from stored row evidence", () => {
    const revision = teachingRevision();
    const fuel = renderCalculationInspector(revision, { rowIndex: 0, field: "fuel" });
    const walkthrough = fuel.querySelector(".calculation-walkthrough")?.textContent ?? "";
    expect(walkthrough).toMatch(/True course and airspeed[\s\S]*Effective wind[\s\S]*Wind components[\s\S]*Groundspeed[\s\S]*Time enroute[\s\S]*Fuel consumed/);
    expect(walkthrough).toContain("-8.572 kt wind along track + 109.879 kt airspeed along track ≈ 101.307 kt");
    expect(walkthrough).toContain("5.15 kt crosswind from the left pushes right; steer 2.68° left into the wind");
    expect(walkthrough).toContain("10 NM ÷ 101.307 kt");
    expect(walkthrough).toContain("8 gal/hr");
    expect(fuel.querySelector("details")?.open).toBe(false);
    expect(fuel.querySelector("details")?.textContent).toContain("wind-1");
    const compass = renderCalculationInspector(revision, { rowIndex: 0, field: "compassHeading" }).querySelector(".calculation-walkthrough")?.textContent ?? "";
    expect(compass).toMatch(/Wind correction[\s\S]*True heading[\s\S]*Magnetic heading[\s\S]*Compass heading/);
    expect(compass).toContain("5.15 kt crosswind from the left pushes right; steer 2.68° left into the wind");
    expect(compass).toContain("subtract 7° for east variation");
    expect(compass).toContain("add 2° for west deviation");
    const headingDetails = renderCalculationInspector(revision, { rowIndex: 0, field: "compassHeading" }).querySelector("details")?.textContent ?? "";
    expect(headingDetails).toContain("Effective wind source");
    expect(headingDetails).toContain("Formula: point-wind");
    expect(compass).not.toContain("- -2°");
    expect(renderCalculationInspector(revision, { rowIndex: 0, field: "compassHeading" }).textContent).toContain("Result: 23.3° as shown in the navlog. Stored unrounded value: 23.32.");
    expect(renderCalculationInspector(revision, { rowIndex: 0, field: "variation" }).querySelector(".calculation-walkthrough")?.textContent).toContain("east-positive variation input");
    expect(renderCalculationInspector(revision, { rowIndex: 0, field: "compassDeviation" }).querySelector(".calculation-walkthrough")?.textContent).toContain("aircraft deviation table");
  });

  it("limits walkthrough precision while retaining exact selected values and traces", () => {
    const revision = teachingRevisionWithLongDecimals();
    const rendered = renderCalculationInspector(revision, { rowIndex: 0, field: "groundspeed" });
    const walkthrough = rendered.querySelector(".calculation-walkthrough")?.textContent ?? "";
    expect(walkthrough).toContain("Course 31.123° true; true airspeed 110.123 kt");
    expect(walkthrough).toContain("≈");
    expect(walkthrough).not.toContain("31.123456");
    expect(rendered.textContent).toContain("Stored unrounded value: 101.");
    expect(rendered.querySelector("details")?.textContent).toContain("110.123456");
  });

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
    expect(distance.querySelector(".calculation-walkthrough")?.textContent).toContain("distance allocated to this route/phase row");
    expect(distance.textContent).toContain("route or phase allocation");
    expect(distance.textContent).toContain("no detailed trace was stored");
    expect(distance.textContent).not.toContain("phase-boundary evidence in the navlog");
  });
});

function teachingRevision() {
  return {
    ...planRevision(),
    calculationSnapshot: {
      schema: "complete-navlog/v1", status: "calculated",
      weather: { endpointSources: { departureMetar: { stationIcao: "KORD", requestId: "dep-1", cache: { status: "kv_hit" } } } },
      navlog: { rows: [{
        subleg: { sourceLegId: "leg-1", phase: "cruise", trueCourse: 31, distance: 10 },
        effectiveWind: { wind: { effectiveValue: { directionFrom: 360, speed: 10 } }, trace: { formulaId: "point-wind", inputs: [{ name: "point request id", value: "wind-1" }], intermediateValues: [], result: { name: "wind", value: 10 } } },
        trueAirspeed: { effectiveValue: 110 }, fuelFlow: { effectiveValue: 8 },
        windCorrectionAngle: -2.68, trueHeading: 28.32, groundspeed: 101.307, estimatedTimeEnroute: 10 / 101.307 * 60, fuel: (10 / 101.307 * 60) / 60 * 8,
        variation: { effectiveValue: 7 }, magneticHeading: 21.32, compassDeviation: -2, compassHeading: 23.32,
        traces: {
          windTriangle: { formulaId: "wind-triangle-vector-solution", inputs: [], intermediateValues: [{ name: "wind along-track component", value: -8.572, unit: "knots" }, { name: "wind right-of-track component", value: 5.15, unit: "knots" }, { name: "airspeed along-track component", value: 109.879, unit: "knots" }], result: { name: "groundspeed", value: 101.307, unit: "knots" } },
          estimatedTimeEnroute: { formulaId: "estimated-time-enroute", inputs: [], intermediateValues: [], result: { name: "estimated time enroute", value: 10 / 101.307 * 60, unit: "minutes" } },
          fuel: { formulaId: "fuel-for-duration", inputs: [], intermediateValues: [], result: { name: "fuel", value: (10 / 101.307 * 60) / 60 * 8, unit: "gallons" } },
        },
        assumptions: [], appliedOverrides: [],
      }] },
    },
  };
}

function teachingRevisionWithLongDecimals() {
  const revision = teachingRevision();
  const calculationSnapshot = revision.calculationSnapshot as unknown as { navlog: { rows: Array<Record<string, unknown>> } };
  const row = calculationSnapshot.navlog.rows[0]!;
  const subleg = row.subleg as Record<string, unknown>;
  const course = 31.123456;
  const tas = 110.123456;
  const windRadians = course * Math.PI / 180;
  const along = -10 * Math.cos(windRadians);
  const cross = 10 * Math.sin(windRadians);
  const airAlong = Math.sqrt(tas ** 2 - cross ** 2);
  const groundspeed = along + airAlong;
  const correction = -Math.asin(cross / tas) * 180 / Math.PI;
  subleg.trueCourse = course;
  row.trueAirspeed = { effectiveValue: tas };
  row.windCorrectionAngle = correction;
  row.trueHeading = course + correction;
  row.groundspeed = groundspeed;
  row.estimatedTimeEnroute = 10 / groundspeed * 60;
  row.fuel = (row.estimatedTimeEnroute as number) / 60 * 8;
  const traces = row.traces as Record<string, unknown>;
  traces.windTriangle = {
    formulaId: "wind-triangle-vector-solution",
    inputs: [{ name: "true airspeed", value: tas, unit: "knots" }],
    intermediateValues: [
      { name: "wind along-track component", value: along, unit: "knots" },
      { name: "wind right-of-track component", value: cross, unit: "knots" },
      { name: "airspeed along-track component", value: airAlong, unit: "knots" },
    ],
    result: { name: "groundspeed", value: groundspeed, unit: "knots" },
  };
  return revision;
}
