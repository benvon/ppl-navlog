import type { AircraftProfile } from "../../domain/aircraft";
import { StorageValidationError, validateAircraftProfile } from "./validation";

export const PILOT_INPUT_DATABASE_NAME = "ppl-navlog-pilot-input-v2";
export const PILOT_INPUT_DATABASE_VERSION = 1;
export const MAX_SUBMISSIONS_PER_PLAN = 20;
const MAX_PLAN_BYTES = 1024 * 1024;

export interface PilotInputPlan {
  readonly id: string;
  readonly title: string;
  /** Literal editor text. Keys are stable field identifiers owned by the planner. */
  readonly rawFields: Readonly<Record<string, string>>;
  readonly selectedProfileId?: string;
  readonly checkpoints: readonly { readonly name: string; readonly coordinateText: string }[];
  readonly cruiseAltitudeTexts: readonly string[];
  readonly overrideReasons: Readonly<Record<string, string>>;
  readonly updatedAt: string;
  readonly submissions: readonly {
    readonly submittedAt: string;
    readonly rawFields: Readonly<Record<string, string>>;
    readonly inputs: PilotInputSnapshot;
  }[];
  /** Profile version copied into the plan so later profile edits cannot invalidate it. */
  readonly profileSnapshot?: AircraftProfile;
}

export interface PilotInputSnapshot {
  readonly title: string;
  readonly rawFields: Readonly<Record<string, string>>;
  readonly selectedProfileId?: string;
  readonly checkpoints: readonly { readonly name: string; readonly coordinateText: string }[];
  readonly cruiseAltitudeTexts: readonly string[];
  readonly overrideReasons: Readonly<Record<string, string>>;
  readonly profileSnapshot?: AircraftProfile;
}

export interface PilotInputRepository {
  initialize(): Promise<void>;
  listPlans(): Promise<readonly PilotInputPlan[]>;
  getPlan(id: string): Promise<PilotInputPlan | undefined>;
  saveWorkingCopy(plan: PilotInputPlan): Promise<void>;
  submitInputs(plan: PilotInputPlan): Promise<void>;
  saveProfile(profile: AircraftProfile): Promise<void>;
  listProfiles(): Promise<readonly AircraftProfile[]>;
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

  public constructor(options: PilotInputRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? PILOT_INPUT_DATABASE_NAME;
    this.factory = options.indexedDbFactory ?? globalThis.indexedDB;
    this.now = options.now ?? (() => new Date());
  }

  public async initialize(): Promise<void> {
    await this.database();
  }

  public async listPlans(): Promise<readonly PilotInputPlan[]> {
    const db = await this.database();
    const tx = db.transaction(PLAN_STORE, "readonly");
    const rows = await req<unknown[]>(tx.objectStore(PLAN_STORE).getAll());
    await done(tx);
    return rows.map((value) => validatePlan(value));
  }

  public async getPlan(id: string): Promise<PilotInputPlan | undefined> {
    const db = await this.database();
    const tx = db.transaction(PLAN_STORE, "readonly");
    const row = await req<unknown>(tx.objectStore(PLAN_STORE).get(id));
    await done(tx);
    return row === undefined ? undefined : validatePlan(row);
  }

  public async saveWorkingCopy(plan: PilotInputPlan): Promise<void> {
    const valid = validatePlan(plan);
    const db = await this.database();
    const tx = db.transaction([PLAN_STORE, PROFILE_STORE], "readwrite");
    const existingValue = await req<unknown>(tx.objectStore(PLAN_STORE).get(valid.id));
    const existing = existingValue === undefined ? undefined : validatePlan(existingValue);
    // A working-copy write is not a submission and must not let a stale editor
    // snapshot roll back the submitted-input history.
    const stored = validatePlan({ ...valid, submissions: existing?.submissions ?? valid.submissions });
    await ensureProfileReference(tx, stored);
    tx.objectStore(PLAN_STORE).put(stored);
    await done(tx);
  }

  public async submitInputs(plan: PilotInputPlan): Promise<void> {
    const valid = validatePlan(plan);
    const timestamp = this.now().toISOString();
    const db = await this.database();
    const tx = db.transaction([PLAN_STORE, PROFILE_STORE], "readwrite");
    const priorValue = await req<unknown>(tx.objectStore(PLAN_STORE).get(valid.id));
    const prior = priorValue === undefined ? undefined : validatePlan(priorValue);
    const inputs: PilotInputSnapshot = {
      title: valid.title, rawFields: structuredClone(valid.rawFields), selectedProfileId: valid.selectedProfileId,
      checkpoints: structuredClone(valid.checkpoints), cruiseAltitudeTexts: structuredClone(valid.cruiseAltitudeTexts),
      overrideReasons: structuredClone(valid.overrideReasons), profileSnapshot: valid.profileSnapshot && structuredClone(valid.profileSnapshot),
    };
    const submitted: PilotInputPlan = {
      ...valid, updatedAt: timestamp,
      submissions: [...(prior?.submissions ?? valid.submissions), { submittedAt: timestamp, rawFields: { ...valid.rawFields }, inputs }].slice(-MAX_SUBMISSIONS_PER_PLAN),
    };
    const stored = validatePlan(submitted);
    await ensureProfileReference(tx, stored);
    tx.objectStore(PLAN_STORE).put(stored);
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
    const tx = db.transaction(PROFILE_STORE, "readonly");
    const rows = await req<unknown[]>(tx.objectStore(PROFILE_STORE).getAll());
    await done(tx);
    rows.forEach((row) => validateProfile(row, this.now()));
    return structuredClone(rows as AircraftProfile[]);
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
  assertOnlyKeys(value, ["id", "title", "rawFields", "selectedProfileId", "checkpoints", "cruiseAltitudeTexts", "overrideReasons", "updatedAt", "submissions", "profileSnapshot"], "$");
  validatePlanIdentity(value);
  validatePlanMaps(value);
  validatePlanCollections(value);
  validatePlanProfile(value);
  validateDocumentSize(value);
  return structuredClone(value) as unknown as PilotInputPlan;
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
  validateSubmissions(value.submissions);
}

function validateCheckpoints(value: unknown): void {
  if (!Array.isArray(value) || value.length > 100) throw invalid("$.checkpoints", "must be an array of at most 100 checkpoints");
  value.forEach((point, index) => {
    const path = `$.checkpoints[${index}]`;
    if (!isRecord(point)) throw invalid(path, "must be an object");
    assertOnlyKeys(point, ["name", "coordinateText"], path);
    assertText(point.name, `${path}.name`);
    assertText(point.coordinateText, `${path}.coordinateText`);
  });
}

function validateAltitudes(value: unknown): void {
  if (!Array.isArray(value) || value.length > 100) throw invalid("$.cruiseAltitudeTexts", "must be an array of at most 100 strings");
  value.forEach((item, index) => assertText(item, `$.cruiseAltitudeTexts[${index}]`));
}

function validateSubmissions(value: unknown): void {
  if (!Array.isArray(value) || value.length > MAX_SUBMISSIONS_PER_PLAN) throw invalid("$.submissions", "must contain at most 20 submissions");
  value.forEach((item, index) => validateSubmission(item, index));
}

function validateSubmission(value: unknown, index: number): void {
  const path = `$.submissions[${index}]`;
  if (!isRecord(value)) throw invalid(path, "must be an object");
  assertText(value.submittedAt, `${path}.submittedAt`);
  if (typeof value.submittedAt !== "string" || !validUtc(value.submittedAt)) throw invalid(`${path}.submittedAt`, "must be an ISO UTC instant");
  validateTextMap(value.rawFields, `${path}.rawFields`);
  validateSnapshot(value.inputs);
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
  if (!isRecord(value)) throw invalid("$.profile", "must be an object");
  assertOnlyKeys(value, ["schemaVersion", "id", "name", "cruiseTasKnots", "cruiseFuelFlowGallonsPerHour", "climbRateFeetPerMinute", "climbTasKnots", "climbFuelFlowGallonsPerHour", "descentRateFeetPerMinute", "descentTasKnots", "descentFuelFlowGallonsPerHour", "usableFuelGallons", "compassDeviationTable", "createdAt", "updatedAt"], "$.profile");
  if (!Array.isArray(value.compassDeviationTable)) throw invalid("$.profile.compassDeviationTable", "must be an array");
  value.compassDeviationTable.forEach((entry, index) => {
    if (!isRecord(entry)) throw invalid(`$.profile.compassDeviationTable[${index}]`, "must be an object");
    assertOnlyKeys(entry, ["magneticHeadingDegrees", "deviationDegrees"], `$.profile.compassDeviationTable[${index}]`);
  });
  validateAircraftProfile(value, now);
}

function validateSnapshot(value: unknown): void {
  if (!isRecord(value)) throw invalid("$", "must be an object");
  assertOnlyKeys(value, ["title", "rawFields", "selectedProfileId", "checkpoints", "cruiseAltitudeTexts", "overrideReasons", "profileSnapshot"], "$");
  validatePlan({ ...value, id: "snapshot", updatedAt: "2026-01-01T00:00:00.000Z", submissions: [] });
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
