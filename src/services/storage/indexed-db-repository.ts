import type { AircraftProfile } from "../../domain/aircraft";
import type { PlanFamily, PlanRevision, WeatherReferenceSnapshot } from "../../domain/route";
import {
  type ImportMode,
  type ImportResult,
  type NavlogExportBundle,
  NAVLOG_DATABASE_NAME,
  NAVLOG_DATABASE_VERSION,
  NAVLOG_STORES,
  type NavlogStoreName,
  ImmutableRevisionError,
  ImportConflictError,
  StorageUnavailableError,
} from "./contracts";
import { parseNavlogExport, serializeNavlogExport } from "./json-transfer";
import {
  StorageValidationError,
  validateAircraftProfile,
  validatePlanFamily,
  validatePlanRevision,
  validateWeatherReferenceSnapshot,
} from "./validation";

const allStoreNames = Object.values(NAVLOG_STORES) as NavlogStoreName[];

export interface IndexedDbRepositoryOptions {
  readonly databaseName?: string;
  readonly indexedDbFactory?: IDBFactory;
  readonly now?: () => Date;
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
  private databasePromise: Promise<IDBDatabase> | undefined;

  public constructor(options: IndexedDbRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? NAVLOG_DATABASE_NAME;
    this.factory = options.indexedDbFactory ?? globalThis.indexedDB;
    this.now = options.now ?? (() => new Date());
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
    const existingRevision = await requestResult<unknown>(revisionStore.get(revision.id));
    if (existingRevision !== undefined) {
      transaction.abort();
      throw new ImmutableRevisionError(`Plan revision ${revision.id} already exists and cannot be modified.`);
    }
    await validateRevisionParent(transaction, revisionStore, revision, this.now());
    const weatherStore = transaction.objectStore(NAVLOG_STORES.weatherSnapshots);
    const newWeatherIds = appendNewWeatherSnapshots(transaction, weatherStore, weatherSnapshots);
    await validateRevisionWeatherReferences(transaction, weatherStore, revision.weatherSnapshotIds, newWeatherIds);
    revisionStore.add(clone(revision));
    const preservedCreatedAt = existingFamily === undefined ? family.createdAt : ensureValid(existingFamily, (candidate) => validatePlanFamily(candidate, this.now())).createdAt;
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
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public async listPlanFamilies(): Promise<readonly PlanFamily[]> {
    return this.readAll(NAVLOG_STORES.planFamilies, (value) => validatePlanFamily(value, this.now()));
  }

  public async exportJson(exportedAt = this.now().toISOString()): Promise<string> {
    const database = await this.database();
    const transaction = database.transaction(allStoreNames, "readonly");
    const [aircraftProfiles, planFamilies, planRevisions, weatherSnapshots] = await Promise.all([
      requestResult<unknown[]>(transaction.objectStore(NAVLOG_STORES.aircraftProfiles).getAll()),
      requestResult<unknown[]>(transaction.objectStore(NAVLOG_STORES.planFamilies).getAll()),
      requestResult<unknown[]>(transaction.objectStore(NAVLOG_STORES.planRevisions).getAll()),
      requestResult<unknown[]>(transaction.objectStore(NAVLOG_STORES.weatherSnapshots).getAll()),
    ]);
    await transactionDone(transaction);
    const bundle: NavlogExportBundle = {
      format: "ppl-navlog/export",
      formatVersion: 1,
      exportedAt,
      aircraftProfiles: aircraftProfiles.map((value) => clone(ensureValid(value, (candidate) => validateAircraftProfile(candidate, this.now())))),
      planFamilies: planFamilies.map((value) => clone(ensureValid(value, (candidate) => validatePlanFamily(candidate, this.now())))),
      planRevisions: planRevisions.map((value) => clone(ensureValid(value, (candidate) => validatePlanRevision(candidate, this.now())))),
      weatherSnapshots: weatherSnapshots.map((value) => clone(ensureValid(value, (candidate) => validateWeatherReferenceSnapshot(candidate, this.now())))),
    };
    return serializeNavlogExport(bundle);
  }

  /** Validation occurs before the write transaction. Any conflict or failure aborts all writes. */
  public async importJson(serialized: string, mode: ImportMode = "merge"): Promise<ImportResult> {
    const bundle = parseNavlogExport(serialized, this.now());
    const database = await this.database();
    const transaction = database.transaction(allStoreNames, "readwrite");
    let requestFailure: unknown;
    transaction.addEventListener("error", (event) => {
      requestFailure ??= (event.target as IDBRequest | null)?.error;
    });
    if (mode === "replace") {
      await Promise.all(allStoreNames.map((name) => requestResult(transaction.objectStore(name).clear())));
    }
    addAll(transaction.objectStore(NAVLOG_STORES.aircraftProfiles), bundle.aircraftProfiles);
    addAll(transaction.objectStore(NAVLOG_STORES.planFamilies), bundle.planFamilies);
    addAll(transaction.objectStore(NAVLOG_STORES.weatherSnapshots), bundle.weatherSnapshots);
    addAll(transaction.objectStore(NAVLOG_STORES.planRevisions), bundle.planRevisions);
    try {
      await transactionDone(transaction);
    } catch (error) {
      if (isConstraintError(requestFailure) || isConstraintError(error)) {
        throw new ImportConflictError("Import conflicts with existing records. No records were written.");
      }
      throw error;
    }
    return {
      aircraftProfiles: bundle.aircraftProfiles.length,
      planFamilies: bundle.planFamilies.length,
      planRevisions: bundle.planRevisions.length,
      weatherSnapshots: bundle.weatherSnapshots.length,
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
  if (revision.draftSnapshot.selectedAircraftProfileId !== revision.aircraftProfileSnapshot.profile.id) {
    throw new StorageValidationError([{ path: "$.aircraftProfileSnapshot.profile.id", message: "must match draftSnapshot.selectedAircraftProfileId" }]);
  }
}

async function validateRevisionParent(
  transaction: IDBTransaction,
  revisionStore: IDBObjectStore,
  revision: PlanRevision,
  now: Date,
): Promise<void> {
  if (revision.parentRevisionId === undefined) return;
  const parent = await requestResult<unknown>(revisionStore.get(revision.parentRevisionId));
  if (parent === undefined) {
    transaction.abort();
    throw new ImmutableRevisionError(`Parent revision ${revision.parentRevisionId} does not exist.`);
  }
  const validatedParent = ensureValid(parent, (candidate) => validatePlanRevision(candidate, now));
  if (validatedParent.planId !== revision.planId) {
    transaction.abort();
    throw new ImmutableRevisionError("A revision parent must belong to the same plan family.");
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

function addAll<T>(store: IDBObjectStore, records: readonly T[]): void {
  records.forEach((record) => store.add(clone(record)));
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
