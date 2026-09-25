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
