import { describe, expect, it } from "vitest";
import { createCompleteFlightFixture } from "./complete-flight";

describe("complete synthetic flight fixture", () => {
  it("calculates and saves a complete flight with immutable weather evidence", async () => {
    const fixture = await createCompleteFlightFixture();
    const snapshot = fixture.revision.calculationSnapshot as Record<string, unknown>;
    expect(snapshot).toMatchObject({ schema: "complete-navlog/v1", status: "calculated" });
    expect(fixture.weatherSnapshots.length).toBeGreaterThan(0);
    expect(fixture.revision.weatherSnapshotIds).toEqual(fixture.weatherSnapshots.map((item) => item.id));
    expect(fixture.draft.route.legs.map((leg) => leg.cruiseAltitudeFeetMsl)).toEqual([4500, 5500]);
    expect(fixture.draft.route.legs[0]?.performanceOverrides?.cruiseTasKnots).toMatchObject({ computedValue: 95, effectiveValue: 102 });
    const allocation = snapshot.phaseAllocation as { boundaries: { kind: string }[]; sublegs: { phase: string; startingAltitude: number; endingAltitude: number; distance: number }[] };
    const navlog = snapshot.navlog as { rows: { subleg: { phase: string }; groundspeed: number; estimatedTimeEnroute: number; fuel: number; cumulative: { routeDistance: number; enrouteFuel: number; requiredFuelWithTaxiRunupAndReserve: number }; appliedOverrides: { input: string; effectiveValue: number }[] }[]; fuelSummary: { enrouteFuel: number; requiredFuel: number; usableFuelDifference: number; sufficientUsableFuel: boolean } };
    expect(allocation.boundaries.map((boundary) => boundary.kind)).toEqual(["top-of-climb", "altitude-transition", "altitude-transition", "top-of-descent"]);
    expect(allocation.sublegs.map((subleg) => subleg.phase)).toEqual(["climb", "cruise", "transition-climb", "cruise", "descent"]);
    expect(allocation.sublegs[0]).toMatchObject({ startingAltitude: 680, endingAltitude: 4500 });
    expect(allocation.sublegs[2]).toMatchObject({ startingAltitude: 4500, endingAltitude: 5500 });
    expect(allocation.sublegs[4]).toMatchObject({ startingAltitude: 5500, endingAltitude: 808 });
    expect(navlog.rows[1]?.appliedOverrides).toEqual([expect.objectContaining({ input: "true-airspeed", effectiveValue: 102 })]);
    expect(navlog.rows[0]?.estimatedTimeEnroute).toBeCloseTo(7.64, 8);
    expect(navlog.rows[2]?.estimatedTimeEnroute).toBeCloseTo(2, 8);
    expect(navlog.rows[4]?.estimatedTimeEnroute).toBeCloseTo(9.384, 8);
    expect(navlog.rows[4]?.cumulative.routeDistance).toBeCloseTo(78.5500826, 6);
    expect(navlog.rows[4]?.cumulative.enrouteFuel).toBeCloseTo(5.9038724474, 6);
    expect(navlog.fuelSummary.requiredFuel).toBeCloseTo(9.7038724474, 6);
    expect(navlog.fuelSummary.requiredFuel).toBeCloseTo(navlog.fuelSummary.enrouteFuel + 0.8 + 3, 10);
    expect(navlog.fuelSummary.usableFuelDifference).toBeCloseTo(24 - navlog.fuelSummary.requiredFuel, 10);
    expect(navlog.fuelSummary.sufficientUsableFuel).toBe(true);
    expect(fixture.weatherSnapshots[0]?.payload).toMatchObject({ surfaceToAloftInterpolation: { status: "applied", fieldElevationFeetMsl: 680, fieldElevationSource: "departure-airport-data" } });
  });
});
