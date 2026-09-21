import type { JsonValue, PlanDraft, PlanFamily, PlanRevision, WeatherReferenceSnapshot } from "../domain/route";
import type { UseCaseClock, UseCaseIds } from "./plan-use-cases";

export interface WeatherRefreshPersistence {
  saveWeatherRefreshRevision(
    family: PlanFamily,
    revision: PlanRevision,
    weatherSnapshots: readonly WeatherReferenceSnapshot[],
  ): Promise<void>;
}

export interface WeatherRefreshMaterial {
  /** The parent draft with a newly explicit forecast selection. */
  readonly draftSnapshot: PlanDraft;
  /** New immutable source records. Their IDs must be referenced by the child. */
  readonly weatherSnapshots: readonly WeatherReferenceSnapshot[];
  /** A complete recalculation based on exactly these source records. */
  readonly calculationSnapshot: JsonValue;
  readonly warnings: readonly string[];
}

export interface SavedWeatherRefresh {
  readonly family: PlanFamily;
  readonly revision: PlanRevision;
}

export class WeatherRefreshError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WeatherRefreshError";
  }
}

/**
 * Appends an all-or-nothing immutable weather-refresh child. Callers must
 * calculate and compare first; this boundary never writes partial refresh
 * material or changes the parent revision.
 */
export const saveWeatherRefreshRevision = async (
  persistence: WeatherRefreshPersistence,
  parentRevision: PlanRevision,
  material: WeatherRefreshMaterial,
  ids: UseCaseIds,
  clock: UseCaseClock,
): Promise<SavedWeatherRefresh> => {
  if (material.draftSnapshot.planId !== parentRevision.planId) {
    throw new WeatherRefreshError("Weather refresh draft belongs to a different plan family.");
  }
  if (material.draftSnapshot.weatherSelection === undefined) {
    throw new WeatherRefreshError("Weather refresh requires an explicitly selected forecast period.");
  }
  if (material.weatherSnapshots.length === 0) {
    throw new WeatherRefreshError("Weather refresh requires at least one new immutable weather snapshot.");
  }
  const refreshedWeatherSnapshotIds = material.weatherSnapshots.map((snapshot) => snapshot.id);
  if (new Set(refreshedWeatherSnapshotIds).size !== refreshedWeatherSnapshotIds.length) {
    throw new WeatherRefreshError("Weather refresh snapshots must have unique IDs.");
  }
  const timestamp = clock.now().toISOString();
  const revision: PlanRevision = {
    schemaVersion: 1,
    id: ids.next(),
    planId: parentRevision.planId,
    parentRevisionId: parentRevision.id,
    reason: "weather-refresh",
    createdAt: timestamp,
    draftSnapshot: structuredClone(material.draftSnapshot),
    aircraftProfileSnapshot: structuredClone(parentRevision.aircraftProfileSnapshot),
    weatherSnapshotIds: refreshedWeatherSnapshotIds,
    calculationSnapshot: structuredClone(material.calculationSnapshot),
    warnings: [...material.warnings],
  };
  const family: PlanFamily = {
    schemaVersion: 1,
    id: parentRevision.planId,
    title: material.draftSnapshot.title,
    createdAt: parentRevision.createdAt,
    latestRevisionId: revision.id,
  };
  await persistence.saveWeatherRefreshRevision(
    family,
    revision,
    material.weatherSnapshots.map((snapshot) => structuredClone(snapshot)),
  );
  return { family, revision };
};
