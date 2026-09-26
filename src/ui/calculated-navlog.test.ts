import { describe, expect, it, vi } from "vitest";
import { planRevision } from "../services/storage/__tests__/fixtures";
import { renderCalculatedNavlog } from "./calculated-navlog";

describe("calculated visual flight log", () => {
  it("shows navlog values without exposing source weather evidence", () => {
    const revision = {
      ...planRevision(),
      calculationSnapshot: {
        schema: "complete-navlog/v1", status: "calculated", weather: { selectedForecastValidTimeUtc: "2026-09-21T18:00:00.000Z" }, phaseAllocation: { boundaries: [] },
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
    expect(rendered?.textContent).toContain("Fuel required including taxi/run-up and reserve: 10.0 gal");
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
        schema: "complete-navlog/v1", status: "calculated", phaseAllocation: { boundaries: [] }, weather: {},
        navlog: { rows: [{ subleg: { sourceLegId: "leg-1", phase: "cruise", startingAltitude: 4500, endingAltitude: 4500, trueCourse: 270, distance: 20 }, fuel: 9, cumulative: { fuelRemaining: 0 } }], fuelSummary: {
          fuelAboard: 10, taxiRunupFuel: 1, fuelAfterTaxi: 9, estimatedArrivalFuel: 0, enrouteFuel: 9, reserveFuel: 0,
          reserveMargin: 0, reserveShortfall: 0, fuelExhaustionDeficit: 0, fuelExhausted: true, sufficientAboardFuel: false,
        } },
      },
    };
    const rendered = renderCalculatedNavlog(revision);
    expect(rendered?.textContent).toContain("Fuel aboard (pilot input): 10.0 gal");
    expect(rendered?.textContent).toContain("Taxi/run-up (pilot input): 1.0 gal");
    expect(rendered?.textContent).toContain("post-taxi balance (calculated): 9.0 gal");
    expect(rendered?.textContent).toContain("Estimated arrival balance: 0.0 gal");
    expect(rendered?.textContent).toContain("Fuel exhausted at arrival");
    expect(rendered?.querySelector(".navlog-fuel-warning")?.textContent).toContain("Fuel exhausted at arrival");
    expect(rendered?.textContent).toContain("Balance after row");
  });

  it("labels signed negative balances as deficits and reports missing capacity comparison", () => {
    const revision = {
      ...planRevision(),
      calculationSnapshot: {
        schema: "complete-navlog/v1", status: "calculated", phaseAllocation: { boundaries: [] }, weather: {},
        navlog: { rows: [{ subleg: { sourceLegId: "leg-1", phase: "cruise", startingAltitude: 4500, endingAltitude: 4500, trueCourse: 270, distance: 20 }, fuel: 11.25, cumulative: { fuelRemaining: -2.25 } }], fuelSummary: {
          fuelAboard: 10, taxiRunupFuel: 1, fuelAfterTaxi: 9, estimatedArrivalFuel: -2.25, enrouteFuel: 11.25, reserveFuel: 1,
          reserveMargin: -3.25, reserveShortfall: 3.25, fuelExhaustionDeficit: 2.25, fuelExhausted: true, sufficientAboardFuel: false,
        } },
      },
    };
    const rendered = renderCalculatedNavlog(revision);
    expect(rendered?.textContent).toContain("capacity comparison unavailable");
    expect(rendered?.textContent).toContain("Estimated arrival deficit: 2.3 gal");
    expect(rendered?.textContent).toContain("Deficit: 2.3 gal");
    expect(rendered?.textContent).not.toContain("-2.3 gal available");
    expect(rendered?.querySelector(".navlog-fuel-warning")?.textContent).toContain("Fuel exhaustion deficit");
  });

  it("does not round small positive fuel into an exhaustion warning", () => {
    const revision = {
      ...planRevision(),
      calculationSnapshot: { schema: "complete-navlog/v1", status: "calculated", phaseAllocation: { boundaries: [] }, weather: {}, navlog: { rows: [], fuelSummary: {
        fuelAboard: 1, taxiRunupFuel: 0, fuelAfterTaxi: 1, estimatedArrivalFuel: 0.04, enrouteFuel: 0.96, reserveFuel: 0,
        reserveMargin: 0.04, reserveShortfall: 0, fuelExhaustionDeficit: 0, fuelExhausted: false, sufficientAboardFuel: true,
      } } },
    };
    const rendered = renderCalculatedNavlog(revision);
    expect(rendered?.textContent).toContain("Estimated arrival balance: <0.1 gal");
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
