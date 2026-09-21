import { describe, expect, it } from "vitest";

import type { JsonValue, PlanFamily, PlanRevision, WeatherReferenceSnapshot } from "../domain/route";
import { planRevision, weatherSnapshot } from "../services/storage/__tests__/fixtures";
import type { CompletePlanDependencies } from "./complete-plan";
import {
  refreshCalculatedPlanWeather,
  type WeatherRefreshEvidenceReader,
} from "./weather-refresh-use-case";
import type { WeatherRefreshPersistence } from "./weather-refresh";

const now = "2026-09-21T13:00:00.000Z";
const clock = { now: () => new Date(now) };
const ids = { next: () => "weather-refresh-revision-2" };
const selection = { forecastValidTimeUtc: "2026-09-21T18:00:00.000Z", selectedAtUtc: now };
const priorCalculation: JsonValue = {
  schema: "complete-navlog/v1", status: "calculated", weather: { selectedForecastValidTimeUtc: "2026-09-21T12:00:00.000Z" }, navlog: { fuel: 10 },
};
const refreshedCalculation: JsonValue = {
  schema: "complete-navlog/v1", status: "calculated", weather: { selectedForecastValidTimeUtc: selection.forecastValidTimeUtc }, navlog: { fuel: 11 },
};

class Persistence implements WeatherRefreshPersistence, WeatherRefreshEvidenceReader {
  public writes: { family: PlanFamily; revision: PlanRevision; snapshots: readonly WeatherReferenceSnapshot[] }[] = [];
  public readonly weather = new Map<string, WeatherReferenceSnapshot>();

  public async getWeatherSnapshot(id: string): Promise<WeatherReferenceSnapshot | undefined> {
    return this.weather.get(id);
  }

  public async saveWeatherRefreshRevision(family: PlanFamily, revision: PlanRevision, snapshots: readonly WeatherReferenceSnapshot[]): Promise<void> {
    this.writes.push({ family: structuredClone(family), revision: structuredClone(revision), snapshots: structuredClone(snapshots) });
  }
}

const parent = (): PlanRevision => ({
  ...planRevision(),
  calculationSnapshot: priorCalculation,
  draftSnapshot: {
    ...planRevision().draftSnapshot,
    departureTimeUtc: "2026-09-21T18:00:00.000Z",
    weatherSelection: { forecastValidTimeUtc: "2026-09-21T12:00:00.000Z", selectedAtUtc: "2026-09-21T12:00:00.000Z" },
  },
});

const dependencies = (snapshot: WeatherReferenceSnapshot = { ...weatherSnapshot(), id: "weather-2", retrievedAt: now, payload: { wind: 18 } }): CompletePlanDependencies => ({
  weather: {
    resolve: async () => ({
      snapshotIds: [snapshot.id], referenceSnapshots: [snapshot], selectedForecastValidTimeUtc: selection.forecastValidTimeUtc,
      phaseWindResolver: { resolveEffectiveWind: () => ({ ok: false, error: { code: "UNSUPPORTED_WIND_ALTITUDE", message: "not used", context: {} } }) },
      warnings: [], provenance: { source: "test" },
    }),
  },
  calculations: { calculate: async () => ({ calculationSnapshot: refreshedCalculation, warnings: ["Refreshed source."] }) },
});

describe("calculated weather refresh", () => {
  it("calculates from a newly explicit selection, appends a child, and retains weather/calculation deltas", async () => {
    const persistence = new Persistence();
    persistence.weather.set("weather-1", weatherSnapshot());
    const revision = parent();

    const result = await refreshCalculatedPlanWeather(persistence, revision, selection, dependencies(), ids, clock);

    expect(result).toMatchObject({ status: "saved", revision: { reason: "weather-refresh", parentRevisionId: "revision-1", weatherSnapshotIds: ["weather-2"] } });
    if (result.status !== "saved") throw new Error("expected saved refresh");
    expect(result.revision.draftSnapshot.weatherSelection).toEqual(selection);
    expect(result.comparison).toMatchObject({
      weather: { snapshotSetChanged: true, contentChanged: true, changes: expect.arrayContaining([expect.objectContaining({ path: "$[0].payload.raw" })]) },
      calculation: { changed: true, changes: expect.arrayContaining([expect.objectContaining({ path: "$.navlog.fuel" })]) },
    });
    expect(result.revision.calculationSnapshot).toMatchObject({
      schema: "complete-navlog/v1",
      weatherRefreshComparison: { schema: "weather-refresh-comparison/v1", calculation: { changed: true } },
    });
    expect(revision).toEqual(parent());
    expect(persistence.writes).toHaveLength(1);
  });

  it("does not write or alter the parent when selection is absent, prior evidence is missing, or recalculation fails", async () => {
    const noSelection = new Persistence();
    const missingEvidence = new Persistence();
    const unavailable = new Persistence();
    unavailable.weather.set("weather-1", weatherSnapshot());
    const revision = parent();

    expect(await refreshCalculatedPlanWeather(noSelection, revision, undefined, dependencies(), ids, clock)).toMatchObject({ status: "blocked", reason: "forecast-not-selected" });
    expect(await refreshCalculatedPlanWeather(missingEvidence, revision, selection, dependencies(), ids, clock)).toMatchObject({ status: "blocked", reason: "prior-weather-evidence-missing" });
    const failingDependencies: CompletePlanDependencies = {
      ...dependencies(),
      weather: { resolve: async () => { throw new Error("Winds source unavailable."); } },
    };
    expect(await refreshCalculatedPlanWeather(unavailable, revision, selection, failingDependencies, ids, clock)).toMatchObject({ status: "blocked", reason: "weather-unavailable" });
    expect(noSelection.writes).toHaveLength(0);
    expect(missingEvidence.writes).toHaveLength(0);
    expect(unavailable.writes).toHaveLength(0);
    expect(revision).toEqual(parent());
  });
});
