import type { AircraftProfile } from "../domain/aircraft";
import type { JsonValue, PlanDraft, PlanFamily, PlanRevision, WeatherReferenceSnapshot } from "../domain/route";
import { calculateCompletePlan, type CompletePlanDependencies, type CompletePlanResult } from "./complete-plan";
import type { UseCaseClock, UseCaseIds } from "./plan-use-cases";

export interface CalculatedPlanPersistence {
  saveCalculatedPlanRevision(family: PlanFamily, revision: PlanRevision, weatherSnapshots: readonly WeatherReferenceSnapshot[]): Promise<void>;
}

export type CalculatedPlanSaveResult =
  | { readonly status: "saved"; readonly family: PlanFamily; readonly revision: PlanRevision; readonly calculation: Extract<CompletePlanResult, { readonly status: "ready" }> }
  | { readonly status: "blocked"; readonly reason: string; readonly message: string; readonly warnings: readonly string[]; readonly calculationSnapshot?: JsonValue };

/** Calculates first; commits the complete result and exactly its weather evidence in one transaction. */
export const calculateAndSavePlan = async (
  persistence: CalculatedPlanPersistence,
  draft: PlanDraft,
  profile: AircraftProfile,
  dependencies: CompletePlanDependencies,
  ids: UseCaseIds,
  clock: UseCaseClock,
  parentRevision?: PlanRevision,
): Promise<CalculatedPlanSaveResult> => {
  if (parentRevision !== undefined && parentRevision.planId !== draft.planId) {
    return { status: "blocked", reason: "invalid-parent", message: "The parent revision belongs to a different plan.", warnings: [] };
  }
  const result = await calculateCompletePlan(draft, profile, dependencies);
  if (result.status === "blocked") return { status: "blocked", reason: result.reason, message: result.message, warnings: result.warnings };
  if (isInfeasibleNavlogSnapshot(result.calculationSnapshot)) {
    return { status: "blocked", reason: "infeasible-profile", message: "The required vertical phases do not fit this route. Review the phase-allocation evidence; no flyable navlog was saved.", warnings: result.warnings, calculationSnapshot: result.calculationSnapshot };
  }
  if (!isCompleteNavlogSnapshot(result.calculationSnapshot)) {
    return { status: "blocked", reason: "incomplete-calculation", message: "Only a complete calculated navlog can be saved as a calculated revision.", warnings: result.warnings };
  }
  const snapshots = result.weather.referenceSnapshots ?? [];
  if (!sameIdentifiers(result.weather.snapshotIds, snapshots.map((snapshot) => snapshot.id))) {
    return { status: "blocked", reason: "missing-weather-evidence", message: "The calculation's weather references do not match its immutable source snapshots.", warnings: result.warnings };
  }
  const timestamp = clock.now().toISOString();
  const revision: PlanRevision = {
    schemaVersion: 1,
    id: ids.next(),
    planId: draft.planId,
    ...(parentRevision === undefined ? {} : { parentRevisionId: parentRevision.id }),
    reason: parentRevision === undefined ? "initial-save" : "recalculation",
    createdAt: timestamp,
    draftSnapshot: structuredClone(draft),
    aircraftProfileSnapshot: { profile: structuredClone(profile), snapshottedAt: timestamp },
    weatherSnapshotIds: [...result.weather.snapshotIds],
    calculationSnapshot: structuredClone(result.calculationSnapshot),
    warnings: [...result.warnings],
  };
  const family: PlanFamily = {
    schemaVersion: 1,
    id: draft.planId,
    title: draft.title,
    createdAt: draft.createdAt,
    latestRevisionId: revision.id,
  };
  await persistence.saveCalculatedPlanRevision(family, revision, snapshots.map((snapshot) => structuredClone(snapshot)));
  return { status: "saved", family, revision, calculation: result };
};

const isCompleteNavlogSnapshot = (value: unknown): value is { readonly schema: "complete-navlog/v1"; readonly status: "calculated" } =>
  typeof value === "object" && value !== null && "schema" in value && value.schema === "complete-navlog/v1" && "status" in value && value.status === "calculated";

const isInfeasibleNavlogSnapshot = (value: unknown): value is { readonly schema: "complete-navlog/v1"; readonly status: "infeasible-phase-allocation" } =>
  typeof value === "object" && value !== null && "schema" in value && value.schema === "complete-navlog/v1" && "status" in value && value.status === "infeasible-phase-allocation";

const sameIdentifiers = (references: readonly string[], snapshots: readonly string[]): boolean =>
  references.length > 0 && references.length === snapshots.length && new Set(references).size === references.length && references.every((id) => snapshots.includes(id));
