import { describe, expect, it } from "vitest";

import type { PlanFamily, PlanRevision, WeatherReferenceSnapshot } from "../domain/route";
import { planRevision, weatherSnapshot } from "../services/storage/__tests__/fixtures";
import { saveWeatherRefreshRevision, type WeatherRefreshPersistence } from "./weather-refresh";

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
  it("creates a child revision with immutable source evidence and the explicit refreshed selection", async () => {
    const parent = {
      ...planRevision(),
      draftSnapshot: {
        ...planRevision().draftSnapshot,
        weatherSelection: { forecastValidTimeUtc: "2026-09-21T12:00:00.000Z", selectedAtUtc: "2026-09-21T12:00:00.000Z" },
      },
    };
    const persistence = new InMemoryRefreshPersistence();
    const nextSnapshot = { ...weatherSnapshot(), id: "weather-2", retrievedAt: "2026-09-21T13:00:00.000Z", payload: { raw: "METAR KORD 211300Z" } };
    const refreshedDraft = {
      ...parent.draftSnapshot,
      weatherSelection: { forecastValidTimeUtc: "2026-09-21T18:00:00.000Z", selectedAtUtc: "2026-09-21T13:00:00.000Z" },
    };

    const saved = await saveWeatherRefreshRevision(persistence, parent, {
      draftSnapshot: refreshedDraft,
      weatherSnapshots: [nextSnapshot],
      calculationSnapshot: { schema: "complete-navlog/v1", status: "calculated", fuelGallons: 10.2 },
      warnings: ["Weather refreshed."],
    }, ids, clock);

    expect(saved.revision).toMatchObject({
      id: "revision-weather-refresh-2",
      parentRevisionId: "revision-1",
      reason: "weather-refresh",
      weatherSnapshotIds: ["weather-2"],
      draftSnapshot: refreshedDraft,
      calculationSnapshot: { schema: "complete-navlog/v1", status: "calculated" },
    });
    expect(persistence.snapshots).toEqual([nextSnapshot]);
    expect(parent.weatherSnapshotIds).toEqual(["weather-1"]);
    expect(parent.draftSnapshot.weatherSelection?.forecastValidTimeUtc).toBe("2026-09-21T12:00:00.000Z");
  });

  it("rejects a refresh with duplicate snapshot identity before any write", async () => {
    const snapshot = weatherSnapshot();
    const persistence = new InMemoryRefreshPersistence();
    const parent = {
      ...planRevision(),
      draftSnapshot: {
        ...planRevision().draftSnapshot,
        weatherSelection: { forecastValidTimeUtc: "2026-09-21T12:00:00.000Z", selectedAtUtc: "2026-09-21T12:00:00.000Z" },
      },
    };
    await expect(saveWeatherRefreshRevision(persistence, parent, {
      draftSnapshot: parent.draftSnapshot,
      weatherSnapshots: [snapshot, snapshot],
      calculationSnapshot: { schema: "complete-navlog/v1", status: "calculated" },
      warnings: [],
    }, ids, clock)).rejects.toThrow(/unique IDs/iu);
    expect(persistence.revision).toBeUndefined();
  });
});
