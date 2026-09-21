import { describe, expect, it } from "vitest";
import { planRevision } from "../services/storage/__tests__/fixtures";
import { renderCalculatedNavlog } from "./calculated-navlog";

describe("calculated visual flight log", () => {
  it("shows worksheet columns and visible interpolation disclosure without injecting weather markup", () => {
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
    const rendered = renderCalculatedNavlog(revision);
    expect(rendered?.textContent).toContain("TC°");
    expect(rendered?.textContent).toContain("Assumption explained");
    expect(rendered?.textContent).toContain("Fuel required including taxi/run-up and reserve: 10.0 gal");
    expect(rendered?.querySelector("unsafe")).toBeNull();
  });

  it("marks infeasible route phases instead of showing invented rows", () => {
    const revision = { ...planRevision(), calculationSnapshot: { schema: "complete-navlog/v1", status: "infeasible-phase-allocation", phaseAllocation: { violations: [] } } };
    expect(renderCalculatedNavlog(revision)?.textContent).toContain("No flyable navlog was invented");
  });
});
