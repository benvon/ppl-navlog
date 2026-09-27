import { describe, expect, it, vi } from "vitest";
import { planRevision } from "../services/storage/__tests__/fixtures";
import { renderCalculatedNavlog } from "./calculated-navlog";

const rowLabels = (rendered: HTMLElement | undefined): string[] => {
  if (rendered === undefined) return [];
  return [...rendered.querySelectorAll<HTMLTableRowElement>("tbody tr")].map((row) => row.cells[0]?.textContent ?? "");
};

const tableCellText = (rendered: HTMLElement | undefined, cellIndex: number): string | undefined =>
  rendered?.querySelector<HTMLTableRowElement>("tbody tr")?.cells[cellIndex]?.textContent;

describe("calculated visual flight log generated event timing", () => {
  it("labels generated TOC and TOD in route order and shows cumulative event time and distance", () => {
    const revision = {
      ...planRevision(),
      calculationSnapshot: {
        schema: "complete-navlog/v1", status: "calculated", phaseAllocation: {
          boundaries: [
            { kind: "top-of-climb", routeDistanceNauticalMiles: 8 },
            { kind: "top-of-descent", routeDistanceNauticalMiles: 45 },
          ], navlogEndpoint: { kind: "pattern-altitude-3nm", routeDistanceNauticalMiles: 52 },
        }, navlog: {
          rows: [
            { subleg: { sourceLegId: "leg-1", phaseId: "departure-climb", phase: "climb", startingAltitude: 680, endingAltitude: 4500, distance: 8 }, cumulative: { routeDistance: 8, estimatedTimeEnroute: 10 } },
            { subleg: { sourceLegId: "leg-1", phaseId: "route-cruise-1", phase: "cruise", startingAltitude: 4500, endingAltitude: 4500, distance: 22 }, cumulative: { routeDistance: 30, estimatedTimeEnroute: 24 } },
            { subleg: { sourceLegId: "leg-2", phaseId: "route-cruise-2:to-tod", phase: "cruise", startingAltitude: 4500, endingAltitude: 4500, distance: 15 }, cumulative: { routeDistance: 45, estimatedTimeEnroute: 34 } },
            { subleg: { sourceLegId: "leg-2", phaseId: "arrival-descent", phase: "descent", startingAltitude: 4500, endingAltitude: 1800, distance: 7 }, cumulative: { routeDistance: 52, estimatedTimeEnroute: 41 } },
          ], fuelSummary: { requiredFuel: 10, enrouteFuel: 6 },
        },
      },
    };

    const rendered = renderCalculatedNavlog(revision);
    const labels = rowLabels(rendered);
    expect(labels[0]).toContain("TOC");
    expect(labels[2]).toContain("TOD");
    expect(labels[3]).toContain("3 NM before destination");
    expect(labels[3]).toContain("pattern altitude");
    expect(rendered?.textContent).toContain("Cumulative NM");
    expect(rendered?.textContent).toContain("Cumulative ETE min");
    expect(tableCellText(rendered, 13)).toBe("8.0");
    expect(tableCellText(rendered, 14)).toBe("10.0");
  });
});

describe("direct route generated event labels", () => {
  it("uses phase allocation distances to label TOC and TOD on a direct route with plain cruise phase ids", () => {
    const revision = {
      ...planRevision(),
      calculationSnapshot: {
        schema: "complete-navlog/v1", status: "calculated",
        phaseAllocation: { boundaries: [
          { kind: "top-of-climb", routeDistanceNauticalMiles: 8 },
          { kind: "top-of-descent", routeDistanceNauticalMiles: 45 },
        ], navlogEndpoint: { kind: "pattern-altitude-3nm", routeDistanceNauticalMiles: 52 } },
        navlog: { rows: [
          { subleg: { sourceLegId: "leg-1", phaseId: "departure-climb", phase: "climb", startingAltitude: 680, endingAltitude: 4500, distance: 8 }, cumulative: { routeDistance: 8, estimatedTimeEnroute: 10 } },
          { subleg: { sourceLegId: "leg-1", phaseId: "route-cruise-1", phase: "cruise", startingAltitude: 4500, endingAltitude: 4500, distance: 37 }, cumulative: { routeDistance: 45, estimatedTimeEnroute: 35 } },
          { subleg: { sourceLegId: "leg-1", phaseId: "arrival-descent", phase: "descent", startingAltitude: 4500, endingAltitude: 1800, distance: 7 }, cumulative: { routeDistance: 52, estimatedTimeEnroute: 42 } },
        ], fuelSummary: { requiredFuel: 10, enrouteFuel: 6 } },
      },
    };

    const labels = rowLabels(renderCalculatedNavlog(revision));
    expect(labels[0]).toContain("TOC");
    expect(labels[1]).toContain("TOD");
    expect(labels[2]).toContain("3 NM before destination");
  });
});

describe("generated navlog event labels", () => {
  it("shows coincident generated events and preserves a pilot checkpoint name", () => {
    const parent = planRevision();
    const checkpoint = parent.draftSnapshot.route.points.find((point) => point.id === "checkpoint-1")!;
    const revision = {
      ...parent,
      calculationSnapshot: {
        schema: "complete-navlog/v1", status: "calculated",
        phaseAllocation: { boundaries: [
          { kind: "top-of-climb", routeDistanceNauticalMiles: 20, coordinate: { latitude: Number(checkpoint.coordinate.latitude), longitude: Number(checkpoint.coordinate.longitude) } },
          { kind: "top-of-descent", routeDistanceNauticalMiles: 20, coordinate: { latitude: Number(checkpoint.coordinate.latitude), longitude: Number(checkpoint.coordinate.longitude) } },
        ] },
        navlog: { rows: [
          { subleg: { sourceLegId: "leg-1", phaseId: "departure-climb", phase: "climb", distance: 20 }, cumulative: { routeDistance: 20, estimatedTimeEnroute: 20 } },
        ], fuelSummary: { requiredFuel: 10, enrouteFuel: 6 } },
      },
    };

    const label = renderCalculatedNavlog(revision)?.querySelector<HTMLTableRowElement>("tbody tr")?.cells[0]?.textContent;
    expect(label).toContain(`${checkpoint.name} / TOC / TOD`);
  });

  it("keeps legacy calculated snapshots labeled for arrival", () => {
    const revision = {
      ...planRevision(),
      calculationSnapshot: {
        schema: "complete-navlog/v1", status: "calculated", phaseAllocation: { boundaries: [] },
        navlog: { rows: [
          { subleg: { sourceLegId: "leg-1", phaseId: "arrival-descent", phase: "descent", startingAltitude: 4500, endingAltitude: 680, distance: 7 }, cumulative: { routeDistance: 20, estimatedTimeEnroute: 42 } },
        ], fuelSummary: { requiredFuel: 10, enrouteFuel: 6, fuelAboard: 12, taxiRunupFuel: 1, fuelAfterTaxi: 11, estimatedArrivalFuel: 2, reserveFuel: 1, reserveMargin: 1 } },
      },
    };

    const rendered = renderCalculatedNavlog(revision);
    expect(rendered?.querySelector<HTMLTableRowElement>("tbody tr")?.cells[0]?.textContent).not.toContain("3 NM before destination");
    expect(rendered?.textContent).toContain("Fuel required including taxi/run-up and reserve");
    expect(rendered?.textContent).toContain("Estimated balance at arrival: 2.0 gal");
  });
});

describe("calculated visual flight log", () => {
  it("shows navlog values without exposing source weather evidence", () => {
    const revision = {
      ...planRevision(),
      calculationSnapshot: {
        schema: "complete-navlog/v1", status: "calculated", weather: { selectedForecastValidTimeUtc: "2026-09-21T18:00:00.000Z" }, phaseAllocation: { boundaries: [], navlogEndpoint: { kind: "pattern-altitude-3nm", routeDistanceNauticalMiles: 12 } },
        navlog: {
          rows: [{
            subleg: { sourceLegId: "leg-1", phase: "climb", startingAltitude: 680, endingAltitude: 4500, trueCourse: 280, distance: 12 },
            effectiveWind: { wind: { effectiveValue: { directionFrom: 270, speed: 12 } } },
            windCorrectionAngle: 2, trueHeading: 282, variation: { effectiveValue: -3 }, magneticHeading: 285,
            compassDeviation: 1, compassHeading: 286, groundspeed: 95, estimatedTimeEnroute: 8, fuel: 1,
            assumptions: ["METAR at field elevation vector-interpolated to first FB level. <unsafe>"], traces: { windTriangle: { formulaId: "wind-triangle" } },
            cumulative: { routeDistance: 12 }, appliedOverrides: [],
          }], fuelSummary: { requiredFuel: 10, enrouteFuel: 6 },
        },
      },
    };
    const rendered = renderCalculatedNavlog(revision, { currentWeatherValidated: true });
    expect(rendered?.textContent).toContain("TC°");
    expect(rendered?.textContent).toContain("Current weather validated for this calculation.");
    expect(rendered?.textContent).not.toContain("Explanation");
    expect(rendered?.textContent).not.toContain("Assumption explained");
    expect(rendered?.textContent).not.toContain("METAR at field elevation");
    expect(rendered?.textContent).not.toContain("Raw row evidence");
    expect(rendered?.textContent).not.toContain("Phase boundaries and weather selection");
    expect(rendered?.textContent).toContain("Fuel required through 3 NM point, including taxi/run-up and reserve: 10.0 gal");
    expect(rendered?.querySelector("unsafe")).toBeNull();
  });

  it("marks infeasible route phases instead of showing invented rows", () => {
    const revision = { ...planRevision(), calculationSnapshot: { schema: "complete-navlog/v1", status: "infeasible-phase-allocation", phaseAllocation: { violations: [] } } };
    expect(renderCalculatedNavlog(revision)?.textContent).toContain("No flyable navlog was invented");
  });

  it("prominently reports insufficient usable fuel and saved stale-weather warnings", () => {
    const revision = {
      ...planRevision(),
      warnings: ["Winds forecast was served from stale cache because the upstream refresh failed."],
      calculationSnapshot: {
        schema: "complete-navlog/v1", status: "calculated", phaseAllocation: { boundaries: [] }, weather: {},
        navlog: { rows: [], fuelSummary: { requiredFuel: 13.5, enrouteFuel: 9.5, usableFuel: 12, usableFuelDifference: -1.5, sufficientUsableFuel: false } },
      },
    };
    const rendered = renderCalculatedNavlog(revision);

    expect(rendered?.querySelector(".navlog-fuel-warning")?.textContent).toContain("short 1.5 gal");
    expect(rendered?.querySelector(".navlog-warnings")?.textContent).toContain("stale cache");
  });

  it("shows the aboard-fuel running balance and exact-zero exhaustion prominently", () => {
    const revision = {
      ...planRevision(),
      calculationSnapshot: {
        schema: "complete-navlog/v1", status: "calculated", phaseAllocation: { boundaries: [], navlogEndpoint: { kind: "pattern-altitude-3nm", routeDistanceNauticalMiles: 20 } }, weather: {},
        navlog: { rows: [{ subleg: { sourceLegId: "leg-1", phase: "cruise", startingAltitude: 4500, endingAltitude: 4500, trueCourse: 270, distance: 20 }, fuel: 9, cumulative: { routeDistance: 20, fuelRemaining: 0 } }], fuelSummary: {
          fuelAboard: 10, taxiRunupFuel: 1, fuelAfterTaxi: 9, estimatedArrivalFuel: 0, enrouteFuel: 9, reserveFuel: 0,
          reserveMargin: 0, reserveShortfall: 0, fuelExhaustionDeficit: 0, fuelExhausted: true, sufficientAboardFuel: false,
        } },
      },
    };
    const rendered = renderCalculatedNavlog(revision);
    expect(rendered?.textContent).toContain("Fuel aboard (pilot input): 10.0 gal");
    expect(rendered?.textContent).toContain("Taxi/run-up (pilot input): 1.0 gal");
    expect(rendered?.textContent).toContain("post-taxi balance (calculated): 9.0 gal");
    expect(rendered?.textContent).toContain("Estimated balance at 3 NM point: 0.0 gal");
    expect(rendered?.textContent).toContain("Fuel exhausted at arrival");
    expect(rendered?.querySelector(".navlog-fuel-warning")?.textContent).toContain("Fuel exhausted at arrival");
    expect(rendered?.textContent).toContain("Balance after row");
  });

  it("labels signed negative balances as deficits and reports missing capacity comparison", () => {
    const revision = {
      ...planRevision(),
      calculationSnapshot: {
        schema: "complete-navlog/v1", status: "calculated", phaseAllocation: { boundaries: [], navlogEndpoint: { kind: "pattern-altitude-3nm", routeDistanceNauticalMiles: 20 } }, weather: {},
        navlog: { rows: [{ subleg: { sourceLegId: "leg-1", phase: "cruise", startingAltitude: 4500, endingAltitude: 4500, trueCourse: 270, distance: 20 }, fuel: 11.25, cumulative: { fuelRemaining: -2.25 } }], fuelSummary: {
          fuelAboard: 10, taxiRunupFuel: 1, fuelAfterTaxi: 9, estimatedArrivalFuel: -2.25, enrouteFuel: 11.25, reserveFuel: 1,
          reserveMargin: -3.25, reserveShortfall: 3.25, fuelExhaustionDeficit: 2.25, fuelExhausted: true, sufficientAboardFuel: false,
        } },
      },
    };
    const rendered = renderCalculatedNavlog(revision);
    expect(rendered?.textContent).toContain("capacity comparison unavailable");
    expect(rendered?.textContent).toContain("Estimated deficit at 3 NM point: 2.3 gal");
    expect(rendered?.textContent).toContain("Deficit: 2.3 gal");
    expect(rendered?.textContent).not.toContain("-2.3 gal available");
    expect(rendered?.querySelector(".navlog-fuel-warning")?.textContent).toContain("Fuel exhaustion deficit");
  });

  it("does not round small positive fuel into an exhaustion warning", () => {
    const revision = {
      ...planRevision(),
      calculationSnapshot: { schema: "complete-navlog/v1", status: "calculated", phaseAllocation: { boundaries: [], navlogEndpoint: { kind: "pattern-altitude-3nm", routeDistanceNauticalMiles: 0 } }, weather: {}, navlog: { rows: [], fuelSummary: {
        fuelAboard: 1, taxiRunupFuel: 0, fuelAfterTaxi: 1, estimatedArrivalFuel: 0.04, enrouteFuel: 0.96, reserveFuel: 0,
        reserveMargin: 0.04, reserveShortfall: 0, fuelExhaustionDeficit: 0, fuelExhausted: false, sufficientAboardFuel: true,
      } } },
    };
    const rendered = renderCalculatedNavlog(revision);
    expect(rendered?.textContent).toContain("Estimated balance at 3 NM point: <0.1 gal");
    expect(rendered?.querySelector(".navlog-fuel-warning")).toBeNull();
  });

  it("exposes calculated cells as keyboard-operable inspector controls when wired", () => {
    const revision = {
      ...planRevision(),
      calculationSnapshot: { schema: "complete-navlog/v1", status: "calculated", navlog: { rows: [{ subleg: { sourceLegId: "leg-1", phase: "cruise", startingAltitude: 4500, endingAltitude: 4500, trueCourse: 270, distance: 20 }, effectiveWind: { wind: { effectiveValue: { directionFrom: 250, speed: 15 } } }, trueHeading: 275, variation: { effectiveValue: -2 }, assumptions: [], traces: {}, cumulative: {}, appliedOverrides: [] }], fuelSummary: { requiredFuel: 8, enrouteFuel: 5 } } },
    };
    const onInspect = vi.fn();
    const rendered = renderCalculatedNavlog(revision, { onInspect, selected: { rowIndex: 0, field: "trueHeading" } });
    const control = rendered?.querySelector<HTMLButtonElement>('button[aria-label^="Inspect trueHeading"]');
    expect(control?.getAttribute("aria-pressed")).toBe("true");
    control?.click();
    expect(onInspect).toHaveBeenCalledWith({ rowIndex: 0, field: "trueHeading" });
  });
});
