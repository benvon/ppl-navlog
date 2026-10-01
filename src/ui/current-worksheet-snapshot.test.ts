import { describe, expect, it } from "vitest";
import { isCurrentWorksheetSnapshot } from "./current-worksheet-snapshot";

const currentSnapshot = () => ({
  schema: "complete-navlog/v1",
  status: "calculated",
  phaseAllocation: {
    transitionPolicy: "stable-cruise-altitude",
    navlogEndpoint: { kind: "field-elevation-airport", routeDistanceNauticalMiles: 20 },
    boundaries: [
      { kind: "top-of-climb", routeDistanceNauticalMiles: 8 },
      { kind: "top-of-descent", routeDistanceNauticalMiles: 12 },
    ],
  },
  navlog: { rows: [{ subleg: { altitudePresentation: "cruise-assumption", selectedCruiseAltitude: 4500 } }] },
});

describe("current worksheet snapshots", () => {
  it("accepts the finalized worksheet snapshot contract", () => {
    expect(isCurrentWorksheetSnapshot(currentSnapshot())).toBe(true);
  });

  it.each<{ readonly label: string; readonly override: { readonly phaseAllocation?: object; readonly navlog?: object } }>([
    { label: "legacy transition policy", override: { phaseAllocation: { transitionPolicy: "legacy" } } },
    { label: "legacy endpoint", override: { phaseAllocation: { navlogEndpoint: { kind: "pattern-altitude-3nm", routeDistanceNauticalMiles: 20 } } } },
    { label: "missing generated boundary source", override: { phaseAllocation: { boundaries: [] } } },
    { label: "missing row presentation marker", override: { navlog: { rows: [{ subleg: { phase: "cruise" } }] } } },
  ])("rejects $label", ({ override }) => {
    const base = currentSnapshot();
    const value = {
      ...base,
      ...override,
      phaseAllocation: { ...base.phaseAllocation, ...("phaseAllocation" in override ? override.phaseAllocation : {}) },
      navlog: { ...base.navlog, ...("navlog" in override ? override.navlog : {}) },
    };
    expect(isCurrentWorksheetSnapshot(value)).toBe(false);
  });

  it("rejects malformed and non-calculated snapshots", () => {
    expect(isCurrentWorksheetSnapshot(null)).toBe(false);
    expect(isCurrentWorksheetSnapshot({ ...currentSnapshot(), status: "infeasible-phase-allocation" })).toBe(false);
  });
});
