import { MAX_REVISIONS_PER_PLAN, type NavlogArchive, type PlanArchive, type ProfileArchive } from "./contracts";
import {
  StorageValidationError,
  validateAircraftProfile,
  validatePlanFamily,
  validatePlanRevision,
  validateWeatherReferenceSnapshot,
} from "./validation";

/** A single plan archive is always validated and restored atomically. */
export const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024;
export const MAX_PROFILES_PER_ARCHIVE = 500;
const planFormat = "ppl-navlog/plan-archive";
const profileFormat = "ppl-navlog/profile-archive";
const archiveVersion = 1;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utc(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

/** Parses one self-contained archive before a write transaction begins. */
export function parseNavlogArchive(serialized: string, now = new Date()): NavlogArchive {
  enforceByteLimit(serialized, "import");
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new StorageValidationError([{ path: "$", message: "must be valid JSON" }]);
  }
  if (!isRecord(value)) throw new StorageValidationError([{ path: "$", message: "must be an object" }]);
  if (value.format === planFormat) return validatePlanArchive(value, now);
  if (value.format === profileFormat) return validateProfileArchive(value, now);
  throw new StorageValidationError([{ path: "$.format", message: `must equal ${planFormat} or ${profileFormat}` }]);
}

export function serializeNavlogArchive(archive: NavlogArchive, now = new Date()): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(archive);
  } catch {
    throw new StorageValidationError([{ path: "$", message: "must be serializable JSON" }]);
  }
  enforceByteLimit(serialized, "export");
  return JSON.stringify(parseNavlogArchive(serialized, now));
}

function validatePlanArchive(value: UnknownRecord, now: Date): PlanArchive {
  const issues: Array<{ path: string; message: string }> = [];
  validateEnvelope(value, planFormat, issues);
  if (!Array.isArray(value.aircraftProfiles) || value.aircraftProfiles.length > MAX_PROFILES_PER_ARCHIVE) issues.push({ path: "$.aircraftProfiles", message: `must be an array of at most ${MAX_PROFILES_PER_ARCHIVE} records` });
  if (!Array.isArray(value.planRevisions) || value.planRevisions.length === 0 || value.planRevisions.length > MAX_REVISIONS_PER_PLAN) issues.push({ path: "$.planRevisions", message: `must contain 1-${MAX_REVISIONS_PER_PLAN} retained revisions` });
  if (!Array.isArray(value.weatherSnapshots)) issues.push({ path: "$.weatherSnapshots", message: "must be an array" });
  if (!isRecord(value.planFamily)) issues.push({ path: "$.planFamily", message: "must be an object" });
  if (issues.length > 0) throw new StorageValidationError(issues);

  const archive = value as unknown as PlanArchive;
  validateWithPath(() => validatePlanFamily(archive.planFamily, now), "$.planFamily");
  archive.aircraftProfiles.forEach((profile, index) => validateWithPath(() => validateAircraftProfile(profile, now), `$.aircraftProfiles[${index}]`));
  archive.planRevisions.forEach((revision, index) => validateWithPath(() => validatePlanRevision(revision, now), `$.planRevisions[${index}]`));
  archive.weatherSnapshots.forEach((snapshot, index) => validateWithPath(() => validateWeatherReferenceSnapshot(snapshot, now), `$.weatherSnapshots[${index}]`));
  validatePlanArchiveRelationships(archive);
  return structuredClone(archive);
}

function validateProfileArchive(value: UnknownRecord, now: Date): ProfileArchive {
  const issues: Array<{ path: string; message: string }> = [];
  validateEnvelope(value, profileFormat, issues);
  if (!Array.isArray(value.aircraftProfiles) || value.aircraftProfiles.length > MAX_PROFILES_PER_ARCHIVE) issues.push({ path: "$.aircraftProfiles", message: `must be an array of at most ${MAX_PROFILES_PER_ARCHIVE} records` });
  if (issues.length > 0) throw new StorageValidationError(issues);
  const archive = value as unknown as ProfileArchive;
  archive.aircraftProfiles.forEach((profile, index) => validateWithPath(() => validateAircraftProfile(profile, now), `$.aircraftProfiles[${index}]`));
  const profileIssues: Array<{ path: string; message: string }> = [];
  ensureUnique(archive.aircraftProfiles, "$.aircraftProfiles", profileIssues);
  if (profileIssues.length > 0) throw new StorageValidationError(profileIssues);
  return structuredClone(archive);
}

function validateEnvelope(value: UnknownRecord, format: string, issues: Array<{ path: string; message: string }>): void {
  if (value.format !== format) issues.push({ path: "$.format", message: `must equal ${format}` });
  if (value.formatVersion !== archiveVersion) issues.push({ path: "$.formatVersion", message: `must equal supported format version ${archiveVersion}` });
  if (!utc(value.exportedAt)) issues.push({ path: "$.exportedAt", message: "must be an ISO-8601 UTC instant" });
}

function validatePlanArchiveRelationships(archive: PlanArchive): void {
  const issues: Array<{ path: string; message: string }> = [];
  const profileIds = ensureUnique(archive.aircraftProfiles, "$.aircraftProfiles", issues);
  const revisionIds = ensureUnique(archive.planRevisions, "$.planRevisions", issues);
  const weatherIds = ensureUnique(archive.weatherSnapshots, "$.weatherSnapshots", issues);
  const numbers = new Set<number>();
  archive.planRevisions.forEach((revision, index) => {
    if (revision.planId !== archive.planFamily.id) issues.push({ path: `$.planRevisions[${index}].planId`, message: "must equal planFamily.id" });
    if (!profileIds.has(revision.draftSnapshot.selectedAircraftProfileId)) issues.push({ path: `$.planRevisions[${index}].draftSnapshot.selectedAircraftProfileId`, message: "must reference an archived aircraft profile" });
    if (numbers.has(revision.revisionNumber)) issues.push({ path: `$.planRevisions[${index}].revisionNumber`, message: "must be unique within the plan journal" });
    numbers.add(revision.revisionNumber);
    revision.weatherSnapshotIds.forEach((id, weatherIndex) => {
      if (!weatherIds.has(id)) issues.push({ path: `$.planRevisions[${index}].weatherSnapshotIds[${weatherIndex}]`, message: "must reference an archived weather snapshot" });
    });
  });
  const latest = archive.planRevisions.find((revision) => revision.id === archive.planFamily.latestRevisionId);
  if (latest === undefined || !revisionIds.has(archive.planFamily.latestRevisionId ?? "")) issues.push({ path: "$.planFamily.latestRevisionId", message: "must reference a retained journal revision" });
  if (latest !== undefined && latest.revisionNumber !== archive.planFamily.latestRevisionNumber) issues.push({ path: "$.planFamily.latestRevisionNumber", message: "must match the retained journal head" });
  if (issues.length > 0) throw new StorageValidationError(issues);
}

function ensureUnique(records: readonly { readonly id: string }[], path: string, issues: Array<{ path: string; message: string }>): Set<string> {
  const ids = new Set<string>();
  records.forEach((record, index) => {
    if (ids.has(record.id)) issues.push({ path: `${path}[${index}].id`, message: "must be unique within the archive" });
    ids.add(record.id);
  });
  return ids;
}

function validateWithPath(validate: () => void, prefix: string): void {
  try {
    validate();
  } catch (error) {
    if (error instanceof StorageValidationError) {
      throw new StorageValidationError(error.issues.map((issue) => ({ path: `${prefix}${issue.path.slice(1)}`, message: issue.message })));
    }
    throw error;
  }
}

function enforceByteLimit(serialized: string, operation: "import" | "export"): void {
  if (new TextEncoder().encode(serialized).byteLength > MAX_ARCHIVE_BYTES) {
    throw new StorageValidationError([{ path: "$", message: `${operation} exceeds the ${MAX_ARCHIVE_BYTES} byte plan-archive limit` }]);
  }
}
