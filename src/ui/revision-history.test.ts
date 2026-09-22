import { describe, expect, it, vi } from "vitest";
import type { PlanRevision } from "../domain/route";
import { renderRevisionHistory } from "./revision-history";

const revision = (id: string, parentRevisionId?: string): PlanRevision => ({
  schemaVersion: 1,
  id,
  planId: "plan",
  revisionNumber: parentRevisionId === undefined ? 1 : 2,
  ...(parentRevisionId === undefined ? {} : { parentRevisionId }),
  reason: parentRevisionId === undefined ? "initial-save" : "weather-refresh",
  createdAt: parentRevisionId === undefined ? "2026-09-21T12:00:00.000Z" : "2026-09-21T13:00:00.000Z",
  draftSnapshot: {
    schemaVersion: 1, id: "draft", planId: "plan", title: "Trip", departureTimeUtc: "2026-09-21T14:00:00.000Z",
    route: { id: "route", points: [], legs: [] }, selectedAircraftProfileId: "aircraft",
    fuelInputs: { taxiRunupFuelGallons: 0, reserveFuelGallons: 0 },
    descentTargetAltitudeFeetMsl: { computedValue: null, effectiveValue: 0, origin: "pilot-input", provenance: { sourceId: "test", sourceLabel: "test", recordedAt: "2026-09-21T12:00:00.000Z" } },
    createdAt: "2026-09-21T12:00:00.000Z", updatedAt: "2026-09-21T12:00:00.000Z",
  },
  aircraftProfileSnapshot: { profile: { schemaVersion: 1, id: "aircraft", name: "C152", cruiseTasKnots: 90, cruiseFuelFlowGallonsPerHour: 6, climbRateFeetPerMinute: 500, climbTasKnots: 70, climbFuelFlowGallonsPerHour: 7, descentRateFeetPerMinute: 500, descentTasKnots: 90, descentFuelFlowGallonsPerHour: 5, compassDeviationTable: [], createdAt: "2026-09-21T12:00:00.000Z", updatedAt: "2026-09-21T12:00:00.000Z" }, snapshottedAt: "2026-09-21T12:00:00.000Z" },
  weatherSnapshotIds: parentRevisionId === undefined ? [] : ["weather-2"],
  calculationSnapshot: { status: "calculated" }, warnings: [],
});

describe("revision history", () => {
  it("orders revisions and opens a chosen immutable revision", () => {
    const select = vi.fn();
    const history = renderRevisionHistory({ revisions: [revision("first"), revision("second", "first")], selectedRevisionId: "second", onSelect: select });
    const buttons = history.querySelectorAll("button");
    expect(buttons[0]?.textContent).toContain("Revision 2");
    expect(buttons[0]?.getAttribute("aria-current")).toBe("true");
    expect(history.textContent).toContain("latest 20 immutable revisions");
    expect(history.textContent).toContain("Weather evidence IDs: none → weather-2");
    buttons[1]?.click();
    expect(select).toHaveBeenCalledWith("first");
  });

  it("handles no revisions", () => {
    expect(renderRevisionHistory({ revisions: [], onSelect: vi.fn() }).textContent).toContain("No saved revisions");
  });
});
