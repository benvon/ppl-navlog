import { describe, expect, it } from "vitest";

import type { PlanFamily, PlanRevision, WeatherReferenceSnapshot } from "../domain/route";
import { planRevision, weatherSnapshot } from "../services/storage/__tests__/fixtures";
import { refreshPlanWeather, type WeatherRefreshPersistence } from "./weather-refresh";

const clock = { now: () => new Date("2026-09-21T13:00:00.000Z") };
const ids = { next: () => "revision-weather-refresh-2" };

class InMemoryRefreshPersistence implements WeatherRefreshPersistence {
  public family: PlanFamily | undefined;
  public revision: PlanRevision | undefined;
  public snapshots: readonly WeatherReferenceSnapshot[] = [];

  public async saveWeatherRefreshRevision(family: PlanFamily, revision: PlanRevision, snapshots: readonly WeatherReferenceSnapshot[]): Promise<void> {
    this.family = structuredClone(family);
    this.revision = structuredClone(revision);
    this.snapshots = structuredClone(snapshots);
  }
}

describe("weather refresh revisions", () => {
  it("creates a child revision with immutable source evidence and comparison metadata", async () => {
    const parent = planRevision();
    const persistence = new InMemoryRefreshPersistence();
    const nextSnapshot = { ...weatherSnapshot(), id: "weather-2", retrievedAt: "2026-09-21T13:00:00.000Z", payload: { raw: "METAR KORD 211300Z" } };

    const saved = await refreshPlanWeather(persistence, parent, {
      weatherSnapshots: [nextSnapshot],
      calculationSnapshot: { fuelGallons: 10.2 },
      warnings: ["Weather refreshed."],
    }, ids, clock);

    expect(saved.revision).toMatchObject({
      id: "revision-weather-refresh-2",
      parentRevisionId: "revision-1",
      reason: "weather-refresh",
      weatherSnapshotIds: ["weather-2"],
      draftSnapshot: parent.draftSnapshot,
    });
    expect(saved.comparison).toEqual({
      schema: "weather-refresh-comparison/v1",
      parentRevisionId: "revision-1",
      priorWeatherSnapshotIds: ["weather-1"],
      refreshedWeatherSnapshotIds: ["weather-2"],
      snapshotSetChanged: true,
    });
    expect(saved.revision.calculationSnapshot).toMatchObject({
      schema: "weather-refresh-comparison/v1",
      weatherComparison: {
        parentRevisionId: "revision-1",
        priorWeatherSnapshotIds: ["weather-1"],
        refreshedWeatherSnapshotIds: ["weather-2"],
        snapshotSetChanged: true,
      },
    });
    expect(persistence.snapshots).toEqual([nextSnapshot]);
    expect(parent.weatherSnapshotIds).toEqual(["weather-1"]);
  });

  it("rejects a refresh with duplicate snapshot identity before any write", async () => {
    const snapshot = weatherSnapshot();
    const persistence = new InMemoryRefreshPersistence();
    await expect(refreshPlanWeather(persistence, planRevision(), {
      weatherSnapshots: [snapshot, snapshot],
      warnings: [],
    }, ids, clock)).rejects.toThrow(/unique IDs/iu);
    expect(persistence.revision).toBeUndefined();
  });
});
