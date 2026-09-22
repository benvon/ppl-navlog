import type { AircraftProfile } from "../../domain/aircraft";
import type { PlanFamily, PlanRevision, WeatherReferenceSnapshot } from "../../domain/route";
import {
  type ImportResult,
  type PlanRecoveryArchive,
  NAVLOG_DATABASE_NAME,
  NAVLOG_DATABASE_VERSION,
  MAX_REVISIONS_PER_PLAN,
  NAVLOG_STORES,
  type NavlogStoreName,
  ImmutableRevisionError,
  StorageUnavailableError,
} from "./contracts";
import { parsePlanRecoveryArchive, serializePlanRecoveryArchive } from "./json-transfer";
import {
  StorageValidationError,
  validateAircraftProfile,
  validatePlanFamily,
  validatePlanRevision,
  validateWeatherReferenceSnapshot,
} from "./validation";

export interface IndexedDbRepositoryOptions {
  readonly databaseName?: string;
  readonly indexedDbFactory?: IDBFactory;
  readonly now?: () => Date;
  readonly nextId?: () => string;
}

/**
 * Browser persistence boundary. Every object is checked on both write and read
 * because older migrations, imported files, and browser tooling can all leave
 * malformed IndexedDB records behind TypeScript's compile-time guarantees.
 */
export class IndexedDbNavlogRepository {
  private readonly databaseName: string;
  private readonly factory: IDBFactory | undefined;
  private readonly now: () => Date;
  private readonly nextId: () => string;
  private databasePromise: Promise<IDBDatabase> | undefined;

  public constructor(options: IndexedDbRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? NAVLOG_DATABASE_NAME;
    this.factory = options.indexedDbFactory ?? globalThis.indexedDB;
    this.now = options.now ?? (() => new Date());
    this.nextId = options.nextId ?? (() => crypto.randomUUID());
  }

  public async close(): Promise<void> {
    if (this.databasePromise === undefined) return;
    const database = await this.databasePromise;
    database.close();
    this.databasePromise = undefined;
  }

  public async saveAircraftProfile(profile: AircraftProfile): Promise<void> {
    validateAircraftProfile(profile, this.now());
    const database = await this.database();
    const transaction = database.transaction(NAVLOG_STORES.aircraftProfiles, "readwrite");
    transaction.objectStore(NAVLOG_STORES.aircraftProfiles).put(clone(profile));
    await transactionDone(transaction);
  }

  public async getAircraftProfile(id: string): Promise<AircraftProfile | undefined> {
    const database = await this.database();
    const transaction = database.transaction(NAVLOG_STORES.aircraftProfiles, "readonly");
    const value = await requestResult<unknown>(transaction.objectStore(NAVLOG_STORES.aircraftProfiles).get(id));
    await transactionDone(transaction);
    if (value == null) return undefined;
    return clone(ensureValid(value, (candidate) => validateAircraftProfile(candidate, this.now())));
  }

  public async listAircraftProfiles(): Promise<readonly AircraftProfile[]> {
    return this.readAll(NAVLOG_STORES.aircraftProfiles, (value) => validateAircraftProfile(value, this.now()));
  }

  public async saveWeatherSnapshot(snapshot: WeatherReferenceSnapshot): Promise<void> {
    validateWeatherReferenceSnapshot(snapshot, this.now());
    const database = await this.database();
    const transaction = database.transaction(NAVLOG_STORES.weatherSnapshots, "readwrite");
    const write = transaction.objectStore(NAVLOG_STORES.weatherSnapshots).add(clone(snapshot));
    try {
      await Promise.all([requestResult(write), transactionDone(transaction)]);
    } catch (error) {
      if (isConstraintError(error)) throw new ImmutableRevisionError(`Weather snapshot ${snapshot.id} already exists and cannot be replaced.`);
      throw error;
    }
  }

  public async getWeatherSnapshot(id: string): Promise<WeatherReferenceSnapshot | undefined> {
    const database = await this.database();
    const transaction = database.transaction(NAVLOG_STORES.weatherSnapshots, "readonly");
    const value = await requestResult<unknown>(transaction.objectStore(NAVLOG_STORES.weatherSnapshots).get(id));
    await transactionDone(transaction);
    return value === undefined ? undefined : clone(ensureValid(value, (candidate) => validateWeatherReferenceSnapshot(candidate, this.now())));
  }

  public async savePlanRevision(family: PlanFamily, revision: PlanRevision): Promise<void> {
    await this.saveRevisionWithWeatherSnapshots(family, revision, []);
  }

  /**
   * Atomically appends weather evidence and the revision that references it.
   * This prevents an interruption from leaving a revision without its required
   * immutable source snapshots, or a set of refresh snapshots with no plan.
   */
  public async saveWeatherRefreshRevision(
    family: PlanFamily,
    revision: PlanRevision,
    weatherSnapshots: readonly WeatherReferenceSnapshot[],
  ): Promise<void> {
    if (revision.reason !== "weather-refresh") {
      throw new StorageValidationError([{ path: "$.reason", message: "weather refresh persistence requires reason weather-refresh" }]);
    }
    await this.saveRevisionWithWeatherSnapshots(family, revision, weatherSnapshots);
  }

  /** Atomically stores a fully calculated revision with the source evidence it references. */
  public async saveCalculatedPlanRevision(
    family: PlanFamily,
    revision: PlanRevision,
    weatherSnapshots: readonly WeatherReferenceSnapshot[],
  ): Promise<void> {
    if (revision.reason === "weather-refresh" || revision.calculationSnapshot === undefined) {
      throw new StorageValidationError([{ path: "$.reason", message: "calculated plan persistence requires a non-refresh calculated revision" }]);
    }
    await this.saveRevisionWithWeatherSnapshots(family, revision, weatherSnapshots);
  }

  private async saveRevisionWithWeatherSnapshots(
    family: PlanFamily,
    revision: PlanRevision,
    weatherSnapshots: readonly WeatherReferenceSnapshot[],
  ): Promise<void> {
    validateRevisionWriteInput(family, revision, weatherSnapshots, this.now());

    const database = await this.database();
    const transaction = database.transaction([NAVLOG_STORES.planFamilies, NAVLOG_STORES.planRevisions, NAVLOG_STORES.weatherSnapshots], "readwrite");
    const familyStore = transaction.objectStore(NAVLOG_STORES.planFamilies);
    const revisionStore = transaction.objectStore(NAVLOG_STORES.planRevisions);
    const existingFamily = await requestResult<unknown>(familyStore.get(family.id));
    const storedFamily = existingFamily === undefined
      ? undefined
      : ensureValid(existingFamily, (candidate) => validatePlanFamily(candidate, this.now()));
    const existingRevision = await requestResult<unknown>(revisionStore.get(revision.id));
    if (existingRevision !== undefined) {
      transaction.abort();
      throw new ImmutableRevisionError(`Plan revision ${revision.id} already exists and cannot be modified.`);
    }
    validateRevisionHead(transaction, storedFamily, revision);
    const existingRevisions = (await requestResult<unknown[]>(revisionStore.getAll()))
      .map((candidate) => ensureValid(candidate, (value) => validatePlanRevision(value, this.now())));
    const weatherStore = transaction.objectStore(NAVLOG_STORES.weatherSnapshots);
    const newWeatherIds = appendNewWeatherSnapshots(transaction, weatherStore, weatherSnapshots);
    await validateRevisionWeatherReferences(transaction, weatherStore, revision.weatherSnapshotIds, newWeatherIds);
    revisionStore.add(clone(revision));
    prunePlanRevisionHistory(revisionStore, weatherStore, existingRevisions, revision);
    const preservedCreatedAt = storedFamily === undefined ? family.createdAt : storedFamily.createdAt;
    familyStore.put(clone({ ...family, createdAt: preservedCreatedAt }));
    await transactionDone(transaction);
  }

  public async getPlanRevision(id: string): Promise<PlanRevision | undefined> {
    const database = await this.database();
    const transaction = database.transaction(NAVLOG_STORES.planRevisions, "readonly");
    const value = await requestResult<unknown>(transaction.objectStore(NAVLOG_STORES.planRevisions).get(id));
    await transactionDone(transaction);
    if (value == null) return undefined;
    return clone(ensureValid(value, (candidate) => validatePlanRevision(candidate, this.now())));
  }

  public async listPlanRevisions(planId: string): Promise<readonly PlanRevision[]> {
    const database = await this.database();
    const transaction = database.transaction(NAVLOG_STORES.planRevisions, "readonly");
    const values = await requestResult<unknown[]>(transaction.objectStore(NAVLOG_STORES.planRevisions).getAll());
    await transactionDone(transaction);
    return values
      .map((value) => clone(ensureValid(value, (candidate) => validatePlanRevision(candidate, this.now()))))
      .filter((revision) => revision.planId === planId)
      .sort((left, right) => left.revisionNumber - right.revisionNumber);
  }

  public async listPlanFamilies(): Promise<readonly PlanFamily[]> {
    return this.readAll(NAVLOG_STORES.planFamilies, (value) => validatePlanFamily(value, this.now()));
  }

  /** Exports only the current editable plan and aircraft data needed to recreate it. */
  public async exportPlanRecoveryArchive(planId: string, exportedAt = this.now().toISOString()): Promise<string> {
    const database = await this.database();
    const transaction = database.transaction([NAVLOG_STORES.planFamilies, NAVLOG_STORES.planRevisions], "readonly");
    const [planFamilies, planRevisions] = await Promise.all([
      requestResult<unknown[]>(transaction.objectStore(NAVLOG_STORES.planFamilies).getAll()),
      requestResult<unknown[]>(transaction.objectStore(NAVLOG_STORES.planRevisions).getAll()),
    ]);
    await transactionDone(transaction);
    const family = planFamilies
      .map((value) => clone(ensureValid(value, (candidate) => validatePlanFamily(candidate, this.now()))))
      .find((candidate) => candidate.id === planId);
    if (family === undefined) throw new StorageValidationError([{ path: "$.planId", message: "does not identify a saved plan" }]);
    const revision = planRevisions
      .map((value) => clone(ensureValid(value, (candidate) => validatePlanRevision(candidate, this.now()))))
      .filter((revision) => revision.planId === planId)
      .find((candidate) => candidate.id === family.latestRevisionId);
    if (revision === undefined) throw new StorageValidationError([{ path: "$.latestRevisionId", message: "does not identify a saved plan revision" }]);
    const archive: PlanRecoveryArchive = {
      format: "ppl-navlog/plan-recovery",
      formatVersion: 1,
      exportedAt,
      draft: revision.draftSnapshot,
      aircraftProfile: revision.aircraftProfileSnapshot.profile,
    };
    return serializePlanRecoveryArchive(archive, this.now());
  }

  /**
   * Restores a recovery snapshot as a new local plan. Fresh IDs deliberately
   * prevent this feature from becoming a merge or synchronization protocol.
   */
  public async importPlanRecoveryArchive(serialized: string): Promise<ImportResult> {
    const archive = parsePlanRecoveryArchive(serialized, this.now());
    const timestamp = this.now().toISOString();
    const recoveredPlanId = this.nextId();
    const profile = { ...archive.aircraftProfile, id: this.nextId(), createdAt: timestamp, updatedAt: timestamp };
    const draft = {
      ...archive.draft,
      id: this.nextId(),
      planId: recoveredPlanId,
      selectedAircraftProfileId: profile.id,
      weatherSelection: undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const revision = {
      schemaVersion: 1 as const,
      id: this.nextId(),
      planId: recoveredPlanId,
      revisionNumber: 1,
      reason: "import" as const,
      createdAt: timestamp,
      draftSnapshot: draft,
      aircraftProfileSnapshot: { profile, snapshottedAt: timestamp },
      weatherSnapshotIds: [],
      warnings: ["Recovered from a local JSON snapshot. Select current weather and recalculate before use."],
    };
    const family = { schemaVersion: 1 as const, id: recoveredPlanId, title: draft.title, createdAt: timestamp, latestRevisionId: revision.id, latestRevisionNumber: 1 };
    validateAircraftProfile(profile, this.now());
    validatePlanFamily(family, this.now());
    validatePlanRevision(revision, this.now());
    const database = await this.database();
    const transaction = database.transaction([NAVLOG_STORES.aircraftProfiles, NAVLOG_STORES.planFamilies, NAVLOG_STORES.planRevisions], "readwrite");
    transaction.objectStore(NAVLOG_STORES.aircraftProfiles).add(clone(profile));
    transaction.objectStore(NAVLOG_STORES.planFamilies).add(clone(family));
    transaction.objectStore(NAVLOG_STORES.planRevisions).add(clone(revision));
    await transactionDone(transaction);
    return {
      aircraftProfiles: 1,
      planFamilies: 1,
      planRevisions: 1,
      weatherSnapshots: 0,
      recoveredPlanId,
    };
  }

  private async readAll<T>(storeName: NavlogStoreName, validate: (value: unknown) => value is T): Promise<readonly T[]> {
    const database = await this.database();
    const transaction = database.transaction(storeName, "readonly");
    const values = await requestResult<unknown[]>(transaction.objectStore(storeName).getAll());
    await transactionDone(transaction);
    return values.map((value) => clone(ensureValid(value, validate)));
  }

  private database(): Promise<IDBDatabase> {
    if (this.factory === undefined) throw new StorageUnavailableError();
    this.databasePromise ??= openDatabase(this.factory, this.databaseName);
    return this.databasePromise;
  }
}

/**
 * Prunes only the oldest revisions of this plan after the new immutable child
 * is queued. Weather evidence is removed only when no retained revision from
 * any plan references it. Journal order is assigned by the save transaction;
 * timestamps remain display metadata and cannot influence retention.
 */
function prunePlanRevisionHistory(
  revisionStore: IDBObjectStore,
  weatherStore: IDBObjectStore,
  existingRevisions: readonly PlanRevision[],
  appendedRevision: PlanRevision,
): void {
  const allRetained = [...existingRevisions, appendedRevision];
  const planHistory = allRetained
    .filter((candidate) => candidate.planId === appendedRevision.planId)
    .sort((left, right) => left.revisionNumber - right.revisionNumber);
  const pruned = planHistory.slice(0, Math.max(0, planHistory.length - MAX_REVISIONS_PER_PLAN));
  if (pruned.length === 0) return;
  const prunedIds = new Set(pruned.map((revision) => revision.id));
  const retainedWeatherIds = new Set(
    allRetained
      .filter((candidate) => !prunedIds.has(candidate.id))
      .flatMap((candidate) => candidate.weatherSnapshotIds),
  );
  const obsoleteWeatherIds = new Set(pruned.flatMap((revision) => revision.weatherSnapshotIds));
  for (const revision of pruned) revisionStore.delete(revision.id);
  for (const weatherSnapshotId of obsoleteWeatherIds) {
    if (!retainedWeatherIds.has(weatherSnapshotId)) weatherStore.delete(weatherSnapshotId);
  }
}

function validateRevisionWriteInput(
  family: PlanFamily,
  revision: PlanRevision,
  weatherSnapshots: readonly WeatherReferenceSnapshot[],
  now: Date,
): void {
  validatePlanFamily(family, now);
  validatePlanRevision(revision, now);
  weatherSnapshots.forEach((snapshot) => validateWeatherReferenceSnapshot(snapshot, now));
  if (family.id !== revision.planId) throw new StorageValidationError([{ path: "$.planId", message: "revision.planId must equal family.id" }]);
  if (family.latestRevisionId !== revision.id) throw new StorageValidationError([{ path: "$.latestRevisionId", message: "must identify the revision being saved" }]);
  if (family.latestRevisionNumber !== revision.revisionNumber) throw new StorageValidationError([{ path: "$.latestRevisionNumber", message: "must identify the revision number being saved" }]);
  if (revision.draftSnapshot.selectedAircraftProfileId !== revision.aircraftProfileSnapshot.profile.id) {
    throw new StorageValidationError([{ path: "$.aircraftProfileSnapshot.profile.id", message: "must match draftSnapshot.selectedAircraftProfileId" }]);
  }
}

/**
 * A plan is a linear journal. The caller must append to the current head so a
 * stale tab or reopened historical entry cannot silently create a branch.
 */
function validateRevisionHead(
  transaction: IDBTransaction,
  storedFamily: PlanFamily | undefined,
  revision: PlanRevision,
): void {
  if (storedFamily === undefined) {
    if (revision.parentRevisionId !== undefined || revision.revisionNumber !== 1) {
      transaction.abort();
      throw new ImmutableRevisionError("The first journal revision must be number 1 with no current head.");
    }
    return;
  }
  if (revision.parentRevisionId !== storedFamily.latestRevisionId) {
    transaction.abort();
    throw new ImmutableRevisionError("The plan changed in another tab or this historical revision must be restored before it can be saved.");
  }
  if (revision.revisionNumber !== (storedFamily.latestRevisionNumber ?? 0) + 1) {
    transaction.abort();
    throw new ImmutableRevisionError("The next revision number must immediately follow the current plan head.");
  }
}

function appendNewWeatherSnapshots(
  transaction: IDBTransaction,
  weatherStore: IDBObjectStore,
  weatherSnapshots: readonly WeatherReferenceSnapshot[],
): ReadonlySet<string> {
  const identifiers = new Set<string>();
  for (const snapshot of weatherSnapshots) {
    if (identifiers.has(snapshot.id)) {
      transaction.abort();
      throw new ImmutableRevisionError(`Weather refresh contains duplicate snapshot ${snapshot.id}.`);
    }
    identifiers.add(snapshot.id);
    weatherStore.add(clone(snapshot));
  }
  return identifiers;
}

async function validateRevisionWeatherReferences(
  transaction: IDBTransaction,
  weatherStore: IDBObjectStore,
  weatherSnapshotIds: readonly string[],
  newWeatherIds: ReadonlySet<string>,
): Promise<void> {
  for (const weatherSnapshotId of weatherSnapshotIds) {
    if (newWeatherIds.has(weatherSnapshotId)) continue;
    if ((await requestResult<unknown>(weatherStore.get(weatherSnapshotId))) === undefined) {
      transaction.abort();
      throw new ImmutableRevisionError(`Weather snapshot ${weatherSnapshotId} does not exist.`);
    }
  }
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, NAVLOG_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(NAVLOG_STORES.aircraftProfiles)) database.createObjectStore(NAVLOG_STORES.aircraftProfiles, { keyPath: "id" });
      if (!database.objectStoreNames.contains(NAVLOG_STORES.planFamilies)) database.createObjectStore(NAVLOG_STORES.planFamilies, { keyPath: "id" });
      if (!database.objectStoreNames.contains(NAVLOG_STORES.planRevisions)) database.createObjectStore(NAVLOG_STORES.planRevisions, { keyPath: "id" });
      if (!database.objectStoreNames.contains(NAVLOG_STORES.weatherSnapshots)) database.createObjectStore(NAVLOG_STORES.weatherSnapshots, { keyPath: "id" });
    };
    request.onerror = () => reject(request.error ?? new StorageUnavailableError("Unable to open IndexedDB."));
    request.onblocked = () => reject(new StorageUnavailableError("IndexedDB upgrade is blocked by another open tab."));
    request.onsuccess = () => resolve(request.result);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isConstraintError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "ConstraintError";
}

function ensureValid<T>(value: unknown, validate: (candidate: unknown) => candidate is T): T {
  if (!validate(value)) {
    throw new StorageValidationError([{ path: "$", message: "record did not satisfy its schema" }]);
  }
  return value;
}
