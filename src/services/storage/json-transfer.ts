import type { PlanRecoveryArchive } from "./contracts";
import {
  StorageValidationError,
  validateAircraftProfile,
  validatePlanDraft,
} from "./validation";

/** Recovery snapshots intentionally exclude unbounded journals and raw weather. */
export const MAX_RECOVERY_ARCHIVE_BYTES = 1024 * 1024;
const recoveryFormat = "ppl-navlog/plan-recovery";
const archiveVersion = 1;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utc(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) && !Number.isNaN(Date.parse(value));
}

/** Parses one recovery snapshot before the local write transaction begins. */
export function parsePlanRecoveryArchive(serialized: string, now = new Date()): PlanRecoveryArchive {
  enforceByteLimit(serialized, "import");
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new StorageValidationError([{ path: "$", message: "must be valid JSON" }]);
  }
  if (!isRecord(value)) throw new StorageValidationError([{ path: "$", message: "must be an object" }]);
  if (value.format !== recoveryFormat) throw new StorageValidationError([{ path: "$.format", message: `must equal ${recoveryFormat}` }]);
  if (value.formatVersion !== archiveVersion) throw new StorageValidationError([{ path: "$.formatVersion", message: `must equal supported format version ${archiveVersion}` }]);
  if (!utc(value.exportedAt)) throw new StorageValidationError([{ path: "$.exportedAt", message: "must be an ISO-8601 UTC instant" }]);
  if (!isRecord(value.draft)) throw new StorageValidationError([{ path: "$.draft", message: "must be an object" }]);
  if (!isRecord(value.aircraftProfile)) throw new StorageValidationError([{ path: "$.aircraftProfile", message: "must be an object" }]);

  const archive = value as unknown as PlanRecoveryArchive;
  validateWithPath(() => validatePlanDraft(archive.draft, now), "$.draft");
  validateWithPath(() => validateAircraftProfile(archive.aircraftProfile, now), "$.aircraftProfile");
  if (archive.draft.selectedAircraftProfileId !== archive.aircraftProfile.id) {
    throw new StorageValidationError([{ path: "$.draft.selectedAircraftProfileId", message: "must match aircraftProfile.id" }]);
  }
  return structuredClone(archive);
}

export function serializePlanRecoveryArchive(archive: PlanRecoveryArchive, now = new Date()): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(archive);
  } catch {
    throw new StorageValidationError([{ path: "$", message: "must be serializable JSON" }]);
  }
  enforceByteLimit(serialized, "export");
  return JSON.stringify(parsePlanRecoveryArchive(serialized, now));
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
  if (new TextEncoder().encode(serialized).byteLength > MAX_RECOVERY_ARCHIVE_BYTES) {
    throw new StorageValidationError([{ path: "$", message: `${operation} exceeds the ${MAX_RECOVERY_ARCHIVE_BYTES} byte recovery archive limit` }]);
  }
}
