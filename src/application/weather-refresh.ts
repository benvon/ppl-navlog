import type { PlanFamily, PlanRevision, WeatherReferenceSnapshot, JsonValue } from "../domain/route";
import type { UseCaseClock, UseCaseIds } from "./plan-use-cases";

export interface WeatherRefreshPersistence {
  saveWeatherRefreshRevision(
    family: PlanFamily,
    revision: PlanRevision,
    weatherSnapshots: readonly WeatherReferenceSnapshot[],
  ): Promise<void>;
}

export interface WeatherRefreshMaterial {
  /** New immutable source records. Their IDs must be referenced by the child. */
  readonly weatherSnapshots: readonly WeatherReferenceSnapshot[];
  /** Recalculated plan output based on exactly these source records. */
  readonly calculationSnapshot?: JsonValue;
  readonly warnings: readonly string[];
}

export interface WeatherRefreshComparison {
  readonly schema: "weather-refresh-comparison/v1";
  readonly parentRevisionId: string;
  readonly priorWeatherSnapshotIds: readonly string[];
  readonly refreshedWeatherSnapshotIds: readonly string[];
  readonly snapshotSetChanged: boolean;
}

export interface SavedWeatherRefresh {
  readonly family: PlanFamily;
  readonly revision: PlanRevision;
  readonly comparison: WeatherRefreshComparison;
}

export class WeatherRefreshError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WeatherRefreshError";
  }
}

/**
 * Saves an all-or-nothing immutable weather refresh. Prior weather and its
 * calculation remain attached to the parent; neither is overwritten.
 */
export const refreshPlanWeather = async (
  persistence: WeatherRefreshPersistence,
  parentRevision: PlanRevision,
  material: WeatherRefreshMaterial,
  ids: UseCaseIds,
  clock: UseCaseClock,
): Promise<SavedWeatherRefresh> => {
  if (material.weatherSnapshots.length === 0) throw new WeatherRefreshError("Weather refresh requires at least one new immutable weather snapshot.");
  const refreshedWeatherSnapshotIds = material.weatherSnapshots.map((snapshot) => snapshot.id);
  if (new Set(refreshedWeatherSnapshotIds).size !== refreshedWeatherSnapshotIds.length) {
    throw new WeatherRefreshError("Weather refresh snapshots must have unique IDs.");
  }
  const timestamp = clock.now().toISOString();
  const comparison: WeatherRefreshComparison = {
    schema: "weather-refresh-comparison/v1",
    parentRevisionId: parentRevision.id,
    priorWeatherSnapshotIds: [...parentRevision.weatherSnapshotIds],
    refreshedWeatherSnapshotIds,
    snapshotSetChanged: !sameIdentifierSet(parentRevision.weatherSnapshotIds, refreshedWeatherSnapshotIds),
  };
  const revision: PlanRevision = {
    schemaVersion: 1,
    id: ids.next(),
    planId: parentRevision.planId,
    parentRevisionId: parentRevision.id,
    reason: "weather-refresh",
    createdAt: timestamp,
    draftSnapshot: structuredClone(parentRevision.draftSnapshot),
    aircraftProfileSnapshot: structuredClone(parentRevision.aircraftProfileSnapshot),
    weatherSnapshotIds: refreshedWeatherSnapshotIds,
    calculationSnapshot: refreshCalculationSnapshot(parentRevision.calculationSnapshot, material.calculationSnapshot, comparison),
    warnings: [...material.warnings],
  };
  const family: PlanFamily = {
    schemaVersion: 1,
    id: parentRevision.planId,
    title: parentRevision.draftSnapshot.title,
    createdAt: parentRevision.createdAt,
    latestRevisionId: revision.id,
  };
  await persistence.saveWeatherRefreshRevision(family, revision, material.weatherSnapshots.map((snapshot) => structuredClone(snapshot)));
  return { family, revision, comparison };
};

const refreshCalculationSnapshot = (
  priorCalculationSnapshot: JsonValue | undefined,
  recalculatedSnapshot: JsonValue | undefined,
  comparison: WeatherRefreshComparison,
): JsonValue => ({
  schema: comparison.schema,
  weatherComparison: {
    parentRevisionId: comparison.parentRevisionId,
    priorWeatherSnapshotIds: comparison.priorWeatherSnapshotIds,
    refreshedWeatherSnapshotIds: comparison.refreshedWeatherSnapshotIds,
    snapshotSetChanged: comparison.snapshotSetChanged,
  },
  priorCalculationSnapshot: priorCalculationSnapshot ?? null,
  recalculatedSnapshot: recalculatedSnapshot ?? null,
});

const sameIdentifierSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value) => right.includes(value));
