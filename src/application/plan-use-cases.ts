import type { AircraftProfile, AircraftProfileInput } from "../domain/aircraft";
import { overridePlanningValue, type PlanningValue } from "../domain/planning-value";
import type {
  AirportRoutePoint,
  CheckpointRoutePoint,
  PlanDraft,
  PlanFamily,
  PlanRevision,
  PlanWeatherSelection,
  RouteDefinition,
  RoutePoint,
  UserRouteLeg,
} from "../domain/route";
import { selectForecastValidTime, type AvailableForecastValidPeriod } from "../domain/weather-valid-time";
import type { IndexedDbNavlogRepository } from "../services/storage/indexed-db-repository";

export interface UseCaseClock {
  now(): Date;
}

export interface UseCaseIds {
  next(): string;
}

export interface NavlogPersistence {
  saveAircraftProfile(profile: AircraftProfile): Promise<void>;
  getAircraftProfile(id: string): Promise<AircraftProfile | undefined>;
  listAircraftProfiles(): Promise<readonly AircraftProfile[]>;
  savePlanRevision(family: PlanFamily, revision: PlanRevision): Promise<void>;
  getPlanRevision(id: string): Promise<PlanRevision | undefined>;
  listPlanRevisions(planId: string): Promise<readonly PlanRevision[]>;
  listPlanFamilies(): Promise<readonly PlanFamily[]>;
}

export interface RouteDraftInput {
  readonly id?: string;
  readonly departure: AirportRoutePoint;
  readonly checkpoints: readonly CheckpointRoutePoint[];
  readonly destination: AirportRoutePoint;
  readonly cruiseAltitudesFeetMsl: readonly number[];
}

export interface PlanDraftInput {
  readonly id?: string;
  readonly planId?: string;
  readonly title: string;
  readonly departureTimeUtc: string;
  readonly route: RouteDefinition;
  readonly selectedAircraftProfileId: string;
  readonly taxiRunupFuelGallons: number;
  readonly reserveFuelGallons: number;
  readonly descentTargetAltitudeFeetMsl: number;
  /** False only for the explicit destination-elevation plus 1,000-ft default. */
  readonly descentTargetIsManual?: boolean;
  readonly weatherSelection?: PlanWeatherSelection;
}

export interface SavedPlan {
  readonly family: PlanFamily;
  readonly revision: PlanRevision;
}

export class DraftUseCaseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DraftUseCaseError";
  }
}

export function createBrowserUseCaseIds(): UseCaseIds {
  return { next: () => crypto.randomUUID() };
}

export function createAircraftProfile(input: AircraftProfileInput, ids: UseCaseIds, clock: UseCaseClock): AircraftProfile {
  const timestamp = clock.now().toISOString();
  return { schemaVersion: 1, id: ids.next(), ...input, createdAt: timestamp, updatedAt: timestamp };
}

export async function saveAircraftProfile(
  persistence: NavlogPersistence,
  input: AircraftProfileInput,
  ids: UseCaseIds,
  clock: UseCaseClock,
): Promise<AircraftProfile> {
  const profile = createAircraftProfile(input, ids, clock);
  await persistence.saveAircraftProfile(profile);
  return profile;
}

export function createRouteDefinition(input: RouteDraftInput, ids: UseCaseIds): RouteDefinition {
  // A route point is an occurrence, not a globally unique airport. This keeps
  // departure and destination distinct for a KXYZ → checkpoint → KXYZ route.
  // Reopened route points already carry an occurrence ID, so route construction
  // must unwrap that source identity before assigning it again.
  const points: readonly RoutePoint[] = [input.departure, ...input.checkpoints, input.destination]
    .map((point, index) => ({ ...point, id: `route-point-${index + 1}-${sourcePointIdentity(point.id)}` }));
  if (input.cruiseAltitudesFeetMsl.length !== points.length - 1) {
    throw new DraftUseCaseError("Each route leg requires one selected cruise altitude.");
  }
  const legs = points.slice(0, -1).map((fromPoint, index): UserRouteLeg => {
    const toPoint = points[index + 1];
    const cruiseAltitudeFeetMsl = input.cruiseAltitudesFeetMsl[index];
    if (toPoint === undefined || cruiseAltitudeFeetMsl === undefined || !Number.isFinite(cruiseAltitudeFeetMsl) || cruiseAltitudeFeetMsl <= 0) {
      throw new DraftUseCaseError("Cruise altitudes must be finite positive feet-MSL values.");
    }
    return { id: ids.next(), fromPointId: fromPoint.id, toPointId: toPoint.id, cruiseAltitudeFeetMsl };
  });
  return { id: input.id ?? ids.next(), points, legs };
}

const sourcePointIdentity = (id: string): string => {
  let sourceIdentity = id;
  let match = /^route-point-\d+-(.+)$/u.exec(sourceIdentity);
  while (match !== null) {
    sourceIdentity = match[1] ?? sourceIdentity;
    match = /^route-point-\d+-(.+)$/u.exec(sourceIdentity);
  }
  return sourceIdentity;
};

export function createPlanDraft(input: PlanDraftInput, ids: UseCaseIds, clock: UseCaseClock): PlanDraft {
  const createdAt = clock.now().toISOString();
  if (!Number.isFinite(input.taxiRunupFuelGallons) || input.taxiRunupFuelGallons < 0 || !Number.isFinite(input.reserveFuelGallons) || input.reserveFuelGallons < 0) {
    throw new DraftUseCaseError("Taxi/run-up and reserve fuel must be nonnegative values.");
  }
  if (!Number.isFinite(input.descentTargetAltitudeFeetMsl)) throw new DraftUseCaseError("The descent target altitude must be a finite value.");
  return {
    schemaVersion: 1,
    id: input.id ?? ids.next(),
    planId: input.planId ?? ids.next(),
    title: requiredTitle(input.title),
    departureTimeUtc: requiredUtcInstant(input.departureTimeUtc),
    route: input.route,
    selectedAircraftProfileId: input.selectedAircraftProfileId,
    fuelInputs: { taxiRunupFuelGallons: input.taxiRunupFuelGallons, reserveFuelGallons: input.reserveFuelGallons },
    ...(input.weatherSelection === undefined ? {} : { weatherSelection: input.weatherSelection }),
    descentTargetAltitudeFeetMsl: input.descentTargetIsManual === false
      ? automaticDescentTargetValue(input.descentTargetAltitudeFeetMsl, createdAt)
      : pilotInputValue(input.descentTargetAltitudeFeetMsl, "descent-target", "Pilot-entered descent target", createdAt),
    createdAt,
    updatedAt: createdAt,
  };
}

/** Records only a period the pilot chose from the provider's advertised periods. */
export function selectPlanWeatherForecast(
  draft: PlanDraft,
  availablePeriods: readonly AvailableForecastValidPeriod[],
  selectedForecastValidTimeUtc: string,
  clock: UseCaseClock,
): PlanDraft {
  const selection = selectForecastValidTime(availablePeriods, selectedForecastValidTimeUtc, draft.departureTimeUtc);
  if (!selection.ok) throw new DraftUseCaseError(selection.error.message);
  const timestamp = clock.now().toISOString();
  return {
    ...draft,
    weatherSelection: { forecastValidTimeUtc: selection.value.period.id, selectedAtUtc: timestamp },
    updatedAt: timestamp,
  };
}

export function applyCruiseTasOverride(
  draft: PlanDraft,
  profile: AircraftProfile,
  legId: string,
  overrideKnots: number,
  reason: string | undefined,
  clock: UseCaseClock,
): PlanDraft {
  if (!Number.isFinite(overrideKnots) || overrideKnots <= 0) throw new DraftUseCaseError("Cruise TAS override must be a positive number of knots.");
  const updatedLegs = draft.route.legs.map((leg) => leg.id === legId ? {
    ...leg,
    performanceOverrides: {
      ...leg.performanceOverrides,
      cruiseTasKnots: overridePlanningValue(defaultFromProfile(profile.cruiseTasKnots, profile, "cruise-tas", "Cruise TAS"), {
        value: overrideKnots,
        ...(reason === undefined || reason.trim() === "" ? {} : { reason: reason.trim() }),
        createdAt: clock.now().toISOString(),
      }),
    },
  } : leg);
  if (updatedLegs.every((leg) => leg.id !== legId)) throw new DraftUseCaseError("The selected route leg does not exist.");
  return { ...draft, route: { ...draft.route, legs: updatedLegs }, updatedAt: clock.now().toISOString() };
}

export function restoreCruiseTasDefault(draft: PlanDraft, legId: string, clock: UseCaseClock): PlanDraft {
  const updatedLegs = draft.route.legs.map((leg) => {
    if (leg.id !== legId) return leg;
    const { performanceOverrides, ...legFields } = leg;
    const remaining = performanceOverrides?.cruiseFuelFlowGallonsPerHour === undefined
      ? {}
      : { cruiseFuelFlowGallonsPerHour: performanceOverrides.cruiseFuelFlowGallonsPerHour };
    return { ...legFields, ...(Object.keys(remaining).length === 0 ? {} : { performanceOverrides: remaining }) };
  });
  if (updatedLegs.every((leg) => leg.id !== legId)) throw new DraftUseCaseError("The selected route leg does not exist.");
  return { ...draft, route: { ...draft.route, legs: updatedLegs }, updatedAt: clock.now().toISOString() };
}

export async function saveDraftRevision(
  persistence: NavlogPersistence,
  draft: PlanDraft,
  profile: AircraftProfile,
  ids: UseCaseIds,
  clock: UseCaseClock,
  parentRevision?: PlanRevision,
  restoredFromRevisionId?: string,
): Promise<SavedPlan> {
  if (profile.id !== draft.selectedAircraftProfileId) throw new DraftUseCaseError("The selected aircraft profile does not match this draft.");
  if (parentRevision !== undefined && parentRevision.planId !== draft.planId) throw new DraftUseCaseError("A revised draft must keep its original plan family.");
  const timestamp = clock.now().toISOString();
  const revision: PlanRevision = {
    schemaVersion: 1,
    id: ids.next(),
    planId: draft.planId,
    revisionNumber: (parentRevision?.revisionNumber ?? 0) + 1,
    ...(parentRevision === undefined ? {} : { parentRevisionId: parentRevision.id }),
    ...(restoredFromRevisionId === undefined ? {} : { restoredFromRevisionId }),
    reason: parentRevision === undefined ? "initial-save" : "input-change",
    createdAt: timestamp,
    draftSnapshot: { ...draft, updatedAt: timestamp },
    aircraftProfileSnapshot: { profile: structuredClone(profile), snapshottedAt: timestamp },
    weatherSnapshotIds: [],
    calculationSnapshot: { status: "calculation-pending", version: "draft/v1" },
    warnings: ["This is an input-only draft revision; calculate the navlog separately before using its planning results."],
  };
  const family: PlanFamily = {
    schemaVersion: 1,
    id: draft.planId,
    title: draft.title,
    createdAt: parentRevision?.createdAt ?? timestamp,
    latestRevisionId: revision.id,
    latestRevisionNumber: revision.revisionNumber,
  };
  await persistence.savePlanRevision(family, revision);
  return { family, revision };
}

export async function reopenPlanRevision(persistence: NavlogPersistence, revisionId: string): Promise<PlanRevision> {
  const revision = await persistence.getPlanRevision(revisionId);
  if (revision === undefined) throw new DraftUseCaseError("The selected saved revision is no longer available.");
  return revision;
}

function pilotInputValue(value: number, sourceId: string, sourceLabel: string, recordedAt: string): PlanningValue<number> {
  return { computedValue: null, effectiveValue: value, origin: "pilot-input", provenance: { sourceId, sourceLabel, recordedAt } };
}

function automaticDescentTargetValue(value: number, recordedAt: string): PlanningValue<number> {
  return {
    computedValue: value,
    effectiveValue: value,
    origin: "calculated",
    provenance: {
      sourceId: "destination-field-elevation-plus-1000",
      sourceLabel: "Destination field elevation plus 1,000 ft",
      recordedAt,
    },
  };
}

function defaultFromProfile(value: number, profile: AircraftProfile, sourceId: string, sourceLabel: string): PlanningValue<number> {
  return {
    computedValue: value,
    effectiveValue: value,
    origin: "aircraft-default",
    provenance: { sourceId: `${profile.id}:${sourceId}`, sourceLabel: `${profile.name}: ${sourceLabel}`, recordedAt: profile.updatedAt },
  };
}

function requiredTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0 || title.length > 120) throw new DraftUseCaseError("Plan title must contain 1-120 characters.");
  return title;
}

function requiredUtcInstant(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new DraftUseCaseError("Departure time must be an ISO-8601 UTC instant.");
  }
  return value;
}

export function createSystemClock(): UseCaseClock {
  return { now: () => new Date() };
}

export type IndexedDbPersistence = Pick<IndexedDbNavlogRepository, keyof NavlogPersistence>;
