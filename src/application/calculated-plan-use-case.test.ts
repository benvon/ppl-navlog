import { describe, expect, it } from "vitest";
import type { JsonValue, PlanFamily, PlanRevision, WeatherReferenceSnapshot } from "../domain/route";
import { aircraftProfile, planDraft, weatherSnapshot } from "../services/storage/__tests__/fixtures";
import type { CompletePlanDependencies } from "./complete-plan";
import { calculateAndSavePlan, type CalculatedPlanPersistence } from "./calculated-plan-use-case";

const clock = { now: () => new Date("2026-09-21T12:00:00.000Z") };
const ids = { next: () => "revision-new" };
const draft = () => { const base = planDraft(); return { ...base, departureTimeUtc: "2026-09-21T18:00:00.000Z", fuelInputs: { ...base.fuelInputs, fuelAboardGallons: 20 } }; };
const evidence = () => ({ ...weatherSnapshot(), retrievedAt: "2026-09-21T11:00:00.000Z" });
const completeSnapshot: JsonValue = { schema: "complete-navlog/v1", status: "calculated", rows: [] };
const partialSnapshot: JsonValue = { schema: "vertical-profile/v1", status: "partial" };

class Persistence implements CalculatedPlanPersistence {
  public calls: { family: PlanFamily; revision: PlanRevision; snapshots: readonly WeatherReferenceSnapshot[] }[] = [];
  public async saveCalculatedPlanRevision(family: PlanFamily, revision: PlanRevision, snapshots: readonly WeatherReferenceSnapshot[]): Promise<void> {
    this.calls.push({ family, revision, snapshots });
  }
}

const dependencies = (complete = true, sourceMatch = true, infeasible = false): CompletePlanDependencies => ({
  weather: { resolve: async () => ({
    snapshotIds: [sourceMatch ? evidence().id : "wrong-id"],
    referenceSnapshots: [evidence()],
    selectedForecastValidTimeUtc: "2026-09-21T18:00:00.000Z",
    phaseWindResolver: { resolveEffectiveWind: () => ({ ok: false, error: { code: "UNSUPPORTED_WIND_ALTITUDE", message: "not used", context: {} } }) },
    warnings: [], provenance: { source: "test" },
  }) },
  calculations: { calculate: async () => ({ calculationSnapshot: infeasible ? { schema: "complete-navlog/v1", status: "infeasible-phase-allocation", phaseAllocation: { violations: [] } } : complete ? completeSnapshot : partialSnapshot, warnings: [] }) },
});

describe("calculated plan save boundary", () => {
  it("saves a complete calculation and matching immutable source evidence atomically", async () => {
    const persistence = new Persistence();
    const result = await calculateAndSavePlan(persistence, draft(), aircraftProfile(), dependencies(), ids, clock);
    expect(result.status).toBe("saved");
    expect(persistence.calls).toHaveLength(1);
    expect(persistence.calls[0]?.revision).toMatchObject({ id: "revision-new", weatherSnapshotIds: ["weather-1"], calculationSnapshot: { schema: "complete-navlog/v1" } });
    expect(persistence.calls[0]?.snapshots).toEqual([evidence()]);
  });

  it("does not write partial output or mismatched weather evidence", async () => {
    const persistence = new Persistence();
    expect((await calculateAndSavePlan(persistence, draft(), aircraftProfile(), dependencies(false), ids, clock)).status).toBe("blocked");
    expect((await calculateAndSavePlan(persistence, draft(), aircraftProfile(), dependencies(true, false), ids, clock)).status).toBe("blocked");
    expect(await calculateAndSavePlan(persistence, draft(), aircraftProfile(), dependencies(true, true, true), ids, clock)).toMatchObject({ status: "blocked", reason: "infeasible-profile", calculationSnapshot: { status: "infeasible-phase-allocation" } });
    expect(persistence.calls).toHaveLength(0);
  });
});
