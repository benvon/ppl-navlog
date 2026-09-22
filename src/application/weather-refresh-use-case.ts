import type { JsonValue, PlanDraft, PlanRevision, PlanWeatherSelection, WeatherReferenceSnapshot } from "../domain/route";
import { calculateCompletePlan, type CompletePlanDependencies, type CompletePlanResult } from "./complete-plan";
import type { UseCaseClock, UseCaseIds } from "./plan-use-cases";
import { attachWeatherRefreshComparison, compareWeatherRefresh, type WeatherRefreshComparison } from "./weather-refresh-comparison";
import { saveWeatherRefreshRevision, type SavedWeatherRefresh, type WeatherRefreshPersistence } from "./weather-refresh";

export interface WeatherRefreshEvidenceReader {
  getWeatherSnapshot(id: string): Promise<WeatherReferenceSnapshot | undefined>;
}

export type CalculatedWeatherRefreshResult =
  | {
    readonly status: "saved";
    readonly family: SavedWeatherRefresh["family"];
    readonly revision: PlanRevision;
    readonly comparison: WeatherRefreshComparison;
    readonly calculation: Extract<CompletePlanResult, { readonly status: "ready" }>;
  }
  | {
    readonly status: "blocked";
    readonly reason: "forecast-not-selected" | "prior-calculation-unavailable" | "prior-weather-evidence-missing" | "weather-unavailable" | "magnetic-unavailable" | "invalid-route" | "unsupported-plan-input" | "calculation-failed" | "infeasible-profile" | "incomplete-calculation" | "missing-weather-evidence";
    readonly message: string;
    readonly warnings: readonly string[];
    readonly calculationSnapshot?: JsonValue;
  };

/**
 * Recalculates a saved plan from a newly explicit forecast selection. It
 * reads prior evidence only to build review data, performs every fallible step
 * before writing, and then atomically appends the child revision and its new
 * source records.
 */
export const refreshCalculatedPlanWeather = async (
  persistence: WeatherRefreshPersistence & WeatherRefreshEvidenceReader,
  parentRevision: PlanRevision,
  weatherSelection: PlanWeatherSelection | undefined,
  dependencies: CompletePlanDependencies,
  ids: UseCaseIds,
  clock: UseCaseClock,
): Promise<CalculatedWeatherRefreshResult> => {
  if (weatherSelection === undefined) {
    return blocked("forecast-not-selected", "Choose a published winds forecast period before refreshing the navlog.");
  }
  if (!isCompleteNavlogSnapshot(parentRevision.calculationSnapshot)) {
    return blocked("prior-calculation-unavailable", "Weather can be refreshed only from a saved complete navlog revision.");
  }
  const priorSnapshots = await loadPriorSnapshots(persistence, parentRevision.weatherSnapshotIds);
  if (priorSnapshots === undefined) {
    return blocked("prior-weather-evidence-missing", "The prior revision's immutable weather evidence is unavailable, so no comparison can be created.");
  }
  const draft = refreshedDraft(parentRevision.draftSnapshot, weatherSelection, clock);
  const result = await calculateCompletePlan(draft, parentRevision.aircraftProfileSnapshot.profile, dependencies);
  if (result.status === "blocked") return result;
  if (isInfeasibleNavlogSnapshot(result.calculationSnapshot)) {
    return blocked("infeasible-profile", "The required vertical phases do not fit this route. No refreshed navlog was saved.", result.warnings, result.calculationSnapshot);
  }
  if (!isCompleteNavlogSnapshot(result.calculationSnapshot)) {
    return blocked("incomplete-calculation", "Only a complete calculated navlog can be saved as a refreshed revision.", result.warnings);
  }
  const snapshots = result.weather.referenceSnapshots ?? [];
  if (!sameIdentifiers(result.weather.snapshotIds, snapshots.map((snapshot) => snapshot.id))) {
    return blocked("missing-weather-evidence", "The refreshed calculation's weather references do not match its immutable source snapshots.", result.warnings);
  }
  const comparison = compareWeatherRefresh(
    parentRevision.id,
    priorSnapshots,
    snapshots,
    parentRevision.calculationSnapshot,
    result.calculationSnapshot,
  );
  const saved = await saveWeatherRefreshRevision(persistence, parentRevision, {
    draftSnapshot: draft,
    weatherSnapshots: snapshots,
    calculationSnapshot: attachWeatherRefreshComparison(result.calculationSnapshot, comparison),
    warnings: result.warnings,
  }, ids, clock);
  return { status: "saved", ...saved, comparison, calculation: result };
};

const loadPriorSnapshots = async (
  persistence: WeatherRefreshEvidenceReader,
  ids: readonly string[],
): Promise<readonly WeatherReferenceSnapshot[] | undefined> => {
  if (ids.length === 0) return undefined;
  const snapshots = await Promise.all(ids.map((id) => persistence.getWeatherSnapshot(id)));
  return snapshots.every((snapshot): snapshot is WeatherReferenceSnapshot => snapshot !== undefined) ? snapshots : undefined;
};

const refreshedDraft = (parentDraft: PlanDraft, weatherSelection: PlanWeatherSelection, clock: UseCaseClock): PlanDraft => ({
  ...structuredClone(parentDraft),
  weatherSelection: structuredClone(weatherSelection),
  updatedAt: clock.now().toISOString(),
});

const isCompleteNavlogSnapshot = (value: unknown): value is { readonly schema: "complete-navlog/v1"; readonly status: "calculated" } =>
  typeof value === "object" && value !== null && "schema" in value && value.schema === "complete-navlog/v1" && "status" in value && value.status === "calculated";

const isInfeasibleNavlogSnapshot = (value: unknown): value is { readonly schema: "complete-navlog/v1"; readonly status: "infeasible-phase-allocation" } =>
  typeof value === "object" && value !== null && "schema" in value && value.schema === "complete-navlog/v1" && "status" in value && value.status === "infeasible-phase-allocation";

const sameIdentifiers = (references: readonly string[], snapshots: readonly string[]): boolean =>
  references.length > 0 && references.length === snapshots.length && new Set(references).size === references.length && references.every((id) => snapshots.includes(id));

const blocked = (
  reason: Extract<CalculatedWeatherRefreshResult, { readonly status: "blocked" }>["reason"],
  message: string,
  warnings: readonly string[] = [],
  calculationSnapshot?: JsonValue,
): Extract<CalculatedWeatherRefreshResult, { readonly status: "blocked" }> => ({
  status: "blocked",
  reason,
  message,
  warnings,
  ...(calculationSnapshot === undefined ? {} : { calculationSnapshot }),
});
