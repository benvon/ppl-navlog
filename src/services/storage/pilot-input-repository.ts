import type { AircraftProfile } from "../../domain/aircraft";
import { inspectAircraftProfile } from "../../domain/aircraft-profile-validation";
import { StorageValidationError, validateAircraftProfile } from "./validation";

export const PILOT_INPUT_DATABASE_NAME = "ppl-navlog-pilot-input-v2";
export const PILOT_INPUT_DATABASE_VERSION = 1;
export const PILOT_INPUT_PLAN_SCHEMA_VERSION = 1;
export type PilotInputPlanSchemaVersion = typeof PILOT_INPUT_PLAN_SCHEMA_VERSION;
export const MAX_CHECKPOINTS_PER_PLAN = 25;
const MAX_PLAN_BYTES = 1024 * 1024;

export interface PilotInputPlan {
  readonly schemaVersion: PilotInputPlanSchemaVersion;
  readonly id: string;
  readonly title: string;
  /** Literal editor text. Keys are stable field identifiers owned by the planner. */
  readonly rawFields: Readonly<Record<string, string>>;
  readonly selectedProfileId?: string;
  readonly checkpoints: readonly { readonly name: string; readonly coordinateText: string }[];
  readonly cruiseAltitudeTexts: readonly string[];
  readonly overrideReasons: Readonly<Record<string, string>>;
  readonly updatedAt: string;
  /** Profile version copied into the plan so later profile edits cannot invalidate it. */
  readonly profileSnapshot?: AircraftProfile;
}

export interface PilotInputRepository {
  initialize(): Promise<void>;
  listPlans(): Promise<readonly PilotInputPlan[]>;
  getPlan(id: string): Promise<PilotInputPlan | undefined>;
  saveWorkingCopy(plan: PilotInputPlan): Promise<void>;
  saveProfile(profile: AircraftProfile): Promise<void>;
  listProfiles(): Promise<readonly AircraftProfile[]>;
  consumeUnsupportedProfileNotice?(): boolean;
  consumeUnsupportedProfileIds?(): readonly string[];
  consumeUnsupportedPlanNotice?(): boolean;
}

export interface PilotInputRepositoryOptions {
  readonly databaseName?: string;
  readonly indexedDbFactory?: IDBFactory;
  readonly now?: () => Date;
}

const PLAN_STORE = "pilotInputs";
const PROFILE_STORE = "aircraftProfiles";

/** Input-only persistence in a separate database; calculated and external records are excluded. */
export class IndexedDbPilotInputRepository implements PilotInputRepository {
  private readonly databaseName: string;
  private readonly factory: IDBFactory | undefined;
  private readonly now: () => Date;
  private databasePromise: Promise<IDBDatabase> | undefined;
  private unsupportedProfileDiscarded = false;
  private unsupportedPlanDiscarded = false;
  private readonly unsupportedProfileIds = new Set<string>();

  public constructor(options: PilotInputRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? PILOT_INPUT_DATABASE_NAME;
    this.factory = options.indexedDbFactory ?? globalThis.indexedDB;
    this.now = options.now ?? (() => new Date());
  }

  public async initialize(): Promise<void> {
    await this.database();
  }

  public async listPlans(): Promise<readonly PilotInputPlan[]> {
    await this.listProfiles();
    const db = await this.database();
    const tx = db.transaction(PLAN_STORE, "readonly");
    const rows = await req<unknown[]>(tx.objectStore(PLAN_STORE).getAll());
    const plans = rows.map((value) => validatePlan(value));
    await done(tx);
    return plans;
  }

  public async getPlan(id: string): Promise<PilotInputPlan | undefined> {
    await this.listProfiles();
    const db = await this.database();
    const tx = db.transaction(PLAN_STORE, "readwrite");
    const store = tx.objectStore(PLAN_STORE);
    const row = await req<unknown>(store.get(id));
    let plan: PilotInputPlan | undefined;
    if (row !== undefined && isUnsupportedPlan(row)) { store.delete(id); this.unsupportedPlanDiscarded = true; }
    else if (row !== undefined) plan = validatePlan(row);
    await done(tx);
    return plan;
  }

  public async saveWorkingCopy(plan: PilotInputPlan): Promise<void> {
    const valid = validatePlan(plan);
    const db = await this.database();
    const tx = db.transaction([PLAN_STORE, PROFILE_STORE], "readwrite");
    await ensureProfileReference(tx, valid);
    tx.objectStore(PLAN_STORE).put(valid);
    await done(tx);
  }

  public async saveProfile(profile: AircraftProfile): Promise<void> {
    validateProfile(profile, this.now());
    const db = await this.database();
    const tx = db.transaction(PROFILE_STORE, "readwrite");
    tx.objectStore(PROFILE_STORE).put(structuredClone(profile));
    await done(tx);
  }

  public async listProfiles(): Promise<readonly AircraftProfile[]> {
    const db = await this.database();
    const tx = db.transaction([PROFILE_STORE, PLAN_STORE], "readwrite");
    const profileStore = tx.objectStore(PROFILE_STORE);
    const [rows, keys] = await Promise.all([req<unknown[]>(profileStore.getAll()), req<IDBValidKey[]>(profileStore.getAllKeys())]);
    const planStore = tx.objectStore(PLAN_STORE);
    const [planRows, planKeys] = await Promise.all([req<unknown[]>(planStore.getAll()), req<IDBValidKey[]>(planStore.getAllKeys())]);
    const profiles: AircraftProfile[] = [];
    const unsupportedIds: string[] = [];
    const unsupportedKeys: IDBValidKey[] = [];
    for (const [index, row] of rows.entries()) {
      const checked = inspectAircraftProfile(row, this.now());
      if (checked.kind === "unsupported-schema") {
        const key = keys[index];
        if (key !== undefined) unsupportedKeys.push(key);
        if (isRecord(row) && typeof row.id === "string") unsupportedIds.push(row.id);
      } else if (checked.kind === "malformed") throw new StorageValidationError(checked.issues);
      else profiles.push(checked.profile);
    }
    const sanitizedPlans = planRows.map((value) => sanitizeUnsupportedPlanProfiles(value, unsupportedIds));
    sanitizedPlans.forEach(({ value }) => { if (!isUnsupportedPlan(value)) validatePlan(value); });
    for (const key of unsupportedKeys) profileStore.delete(key);
    let unsupportedPlanFound = false;
    sanitizedPlans.forEach(({ value, changed }, index) => {
      if (isUnsupportedPlan(value)) {
        const key = planKeys[index];
        if (key !== undefined) planStore.delete(key);
        unsupportedPlanFound = true;
      } else if (changed) planStore.put(value);
    });
    await done(tx);
    if (sanitizedPlans.some(({ unsupportedDiscarded }) => unsupportedDiscarded)) this.unsupportedProfileDiscarded = true;
    if (unsupportedPlanFound) this.unsupportedPlanDiscarded = true;
    unsupportedIds.forEach((id) => this.unsupportedProfileIds.add(id));
    if (unsupportedKeys.length > 0) this.unsupportedProfileDiscarded = true;
    return structuredClone(profiles);
  }

  public consumeUnsupportedProfileNotice(): boolean {
    const discarded = this.unsupportedProfileDiscarded;
    this.unsupportedProfileDiscarded = false;
    return discarded;
  }

  public consumeUnsupportedProfileIds(): readonly string[] {
    const ids = [...this.unsupportedProfileIds];
    this.unsupportedProfileIds.clear();
    return ids;
  }

  public consumeUnsupportedPlanNotice(): boolean {
    const discarded = this.unsupportedPlanDiscarded;
    this.unsupportedPlanDiscarded = false;
    return discarded;
  }

  private database(): Promise<IDBDatabase> {
    if (!this.factory) throw new Error("IndexedDB is unavailable in this browser context.");
    this.databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      let wasBlocked = false;
      const request = this.factory!.open(this.databaseName, PILOT_INPUT_DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(PLAN_STORE)) request.result.createObjectStore(PLAN_STORE, { keyPath: "id" });
        if (!request.result.objectStoreNames.contains(PROFILE_STORE)) request.result.createObjectStore(PROFILE_STORE, { keyPath: "id" });
      };
      request.onsuccess = () => {
        const db = request.result;
        if (wasBlocked) { db.close(); return; }
        db.onversionchange = () => { db.close(); this.databasePromise = undefined; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => { wasBlocked = true; reject(new Error("Pilot input database upgrade is blocked by another open tab.")); };
    }).catch((error: unknown) => { this.databasePromise = undefined; throw error; });
    return this.databasePromise!;
  }
}

function validatePlan(value: unknown): PilotInputPlan {
  if (!isRecord(value)) throw invalid("$", "must be an object");
  if (isUnsupportedPlan(value)) throw invalid("$.schemaVersion", "uses an unsupported plan schema version");
  assertOnlyKeys(value, ["schemaVersion", "id", "title", "rawFields", "selectedProfileId", "checkpoints", "cruiseAltitudeTexts", "overrideReasons", "updatedAt", "profileSnapshot"], "$");
  const plan = structuredClone(value) as Record<string, unknown>;
  validatePlanIdentity(plan);
  validatePlanMaps(plan);
  validatePlanCollections(plan);
  validatePlanProfile(plan);
  validateDocumentSize(plan);
  return plan as unknown as PilotInputPlan;
}

function isUnsupportedPlan(value: unknown): boolean {
  return !isRecord(value) || value.schemaVersion !== PILOT_INPUT_PLAN_SCHEMA_VERSION;
}

/** Drops only snapshots proven to use a different schema; malformed current data remains visible as an error. */
function sanitizeUnsupportedPlanProfiles(value: unknown, unsupportedIds: readonly string[] = []): { readonly value: unknown; readonly changed: boolean; readonly unsupportedDiscarded: boolean } {
  if (!isRecord(value)) return { value, changed: false, unsupportedDiscarded: false };
  let changed = false;
  let unsupportedDiscarded = false;
  const plan = structuredClone(value) as Record<string, unknown>;
  if (plan.profileSnapshot !== undefined && isUnsupportedProfile(plan.profileSnapshot)) {
    delete plan.profileSnapshot;
    delete plan.selectedProfileId;
    changed = true;
    unsupportedDiscarded = true;
  }
  if (typeof plan.selectedProfileId === "string" && unsupportedIds.includes(plan.selectedProfileId) && plan.profileSnapshot === undefined) {
    delete plan.selectedProfileId;
    changed = true;
  }
  return { value: plan, changed, unsupportedDiscarded };
}

function isUnsupportedProfile(value: unknown): boolean {
  return inspectAircraftProfile(value).kind === "unsupported-schema";
}

function validatePlanIdentity(value: Record<string, unknown>): void {
  assertText(value.id, "$.id");
  if (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value.id)) throw invalid("$.id", "must be a valid plan identifier");
  assertText(value.title, "$.title");
  assertText(value.updatedAt, "$.updatedAt");
  if (typeof value.updatedAt !== "string" || !validUtc(value.updatedAt)) throw invalid("$.updatedAt", "must be an ISO UTC instant");
  assertText(value.selectedProfileId, "$.selectedProfileId", true);
}

function validatePlanMaps(value: Record<string, unknown>): void {
  validateTextMap(value.rawFields, "$.rawFields");
  validateTextMap(value.overrideReasons, "$.overrideReasons");
}

function validateTextMap(value: unknown, path: string): void {
  if (!isRecord(value) || Object.keys(value).length > 100) throw invalid(path, "must be an object with at most 100 entries");
  for (const [key, text] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(key)) throw invalid(`${path}.${key}`, "has an invalid key");
    assertText(text, `${path}.${key}`);
  }
}

function validatePlanCollections(value: Record<string, unknown>): void {
  validateCheckpoints(value.checkpoints);
  validateAltitudes(value.cruiseAltitudeTexts);
}

function validateCheckpoints(value: unknown): void {
  if (!Array.isArray(value) || value.length > MAX_CHECKPOINTS_PER_PLAN) throw invalid("$.checkpoints", `must be an array of at most ${MAX_CHECKPOINTS_PER_PLAN} checkpoints`);
  value.forEach((point, index) => {
    const path = `$.checkpoints[${index}]`;
    if (!isRecord(point)) throw invalid(path, "must be an object");
    assertOnlyKeys(point, ["name", "coordinateText"], path);
    assertText(point.name, `${path}.name`);
    assertText(point.coordinateText, `${path}.coordinateText`);
  });
}

function validateAltitudes(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 1) throw invalid("$.cruiseAltitudeTexts", "must contain exactly one altitude text");
  value.forEach((item, index) => assertText(item, `$.cruiseAltitudeTexts[${index}]`));
}

function validatePlanProfile(value: Record<string, unknown>): void {
  if (value.profileSnapshot === undefined) return;
  validateProfile(value.profileSnapshot, new Date());
  if (!isRecord(value.profileSnapshot) || value.selectedProfileId !== value.profileSnapshot.id) throw invalid("$.profileSnapshot.id", "must match selectedProfileId");
}

function validateDocumentSize(value: Record<string, unknown>): void {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_PLAN_BYTES) throw invalid("$", "plan exceeds size limit");
  } catch (error) {
    if (error instanceof StorageValidationError) throw error;
    throw invalid("$", "must be serializable JSON");
  }
}

function assertText(value: unknown, path: string, optional = false): void {
  if (optional && value === undefined) return;
  if (typeof value !== "string" || value.length > 10_000) throw invalid(path, "must be a string within size limit");
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalid(path, "contains unsupported fields");
}

function validateProfile(value: unknown, now: Date): asserts value is AircraftProfile {
  validateAircraftProfile(value, now);
}

function invalid(path: string, message: string): StorageValidationError { return new StorageValidationError([{ path, message }]); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validUtc(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) && !Number.isNaN(Date.parse(value)); }
function req<T>(request: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function done(tx: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted")); tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed")); }); }
async function ensureProfileReference(tx: IDBTransaction, plan: PilotInputPlan): Promise<void> {
  if (!plan.selectedProfileId) return;
  const profile = plan.profileSnapshot;
  if (profile && profile.id === plan.selectedProfileId) tx.objectStore(PROFILE_STORE).put(profile);
  else if (await req<unknown>(tx.objectStore(PROFILE_STORE).get(plan.selectedProfileId)) === undefined) throw invalid("$.selectedProfileId", "references an unavailable aircraft profile");
}
