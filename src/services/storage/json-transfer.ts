import { MAX_REVISIONS_PER_PLAN, type NavlogExportBundle } from "./contracts";
import {
  StorageValidationError,
  validateAircraftProfile,
  validatePlanFamily,
  validatePlanRevision,
  validateWeatherReferenceSnapshot,
} from "./validation";

/** Bounded to cover one complete retained plan history: 20 upstream products, each capped at 512 KiB. */
export const MAX_IMPORT_BYTES = 12 * 1024 * 1024;
/** Bounds validation work while permitting a backup of many 20-revision plan histories. */
export const MAX_RECORDS_PER_COLLECTION = 5_000;
const exportFormat = "ppl-navlog/export";
const exportVersion = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateExportedAt(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Parses and validates an entire export before any IndexedDB transaction opens.
 * Callers can therefore guarantee invalid JSON never writes partial state.
 */
export function parseNavlogExport(serialized: string, now = new Date()): NavlogExportBundle {
  if (new TextEncoder().encode(serialized).byteLength > MAX_IMPORT_BYTES) {
    throw new StorageValidationError([{ path: "$", message: `import exceeds the ${MAX_IMPORT_BYTES} byte limit` }]);
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new StorageValidationError([{ path: "$", message: "must be valid JSON" }]);
  }
  return validateNavlogExportBundle(value, now);
}

/**
 * Validates the export envelope before either export or import persistence.
 */
function validateNavlogExportBundle(value: unknown, now: Date, maximumRecordsPerCollection = MAX_RECORDS_PER_COLLECTION): NavlogExportBundle {
  if (!isRecord(value)) throw new StorageValidationError([{ path: "$", message: "must be an object" }]);

  const issues: Array<{ path: string; message: string }> = [];
  if (value.format !== exportFormat) issues.push({ path: "$.format", message: `must equal ${exportFormat}` });
  if (value.formatVersion !== exportVersion) issues.push({ path: "$.formatVersion", message: `must equal supported format version ${exportVersion}` });
  if (!validateExportedAt(value.exportedAt)) issues.push({ path: "$.exportedAt", message: "must be an ISO-8601 UTC instant" });

  const collections = ["aircraftProfiles", "planFamilies", "planRevisions", "weatherSnapshots"] as const;
  for (const key of collections) {
    if (!Array.isArray(value[key]) || value[key].length > maximumRecordsPerCollection) {
      issues.push({ path: `$.${key}`, message: `must be an array of at most ${maximumRecordsPerCollection.toLocaleString()} records` });
    }
  }
  if (issues.length > 0) throw new StorageValidationError(issues);

  const bundle = value as unknown as NavlogExportBundle;
  bundle.aircraftProfiles.forEach((profile, index) => validateWithPath(() => validateAircraftProfile(profile, now), `$.aircraftProfiles[${index}]`));
  bundle.planFamilies.forEach((family, index) => validateWithPath(() => validatePlanFamily(family, now), `$.planFamilies[${index}]`));
  bundle.weatherSnapshots.forEach((snapshot, index) => validateWithPath(() => validateWeatherReferenceSnapshot(snapshot, now), `$.weatherSnapshots[${index}]`));
  bundle.planRevisions.forEach((revision, index) => validateWithPath(() => validatePlanRevision(revision, now), `$.planRevisions[${index}]`));
  validateBundleRelationships(bundle);
  return deepClone(bundle);
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

function validateBundleRelationships(bundle: NavlogExportBundle): void {
  const issues: Array<{ path: string; message: string }> = [];
  const ensureUnique = (records: readonly { readonly id: string }[], path: string): Set<string> => {
    const ids = new Set<string>();
    records.forEach((record, index) => {
      if (ids.has(record.id)) issues.push({ path: `${path}[${index}].id`, message: "must be unique within the export" });
      ids.add(record.id);
    });
    return ids;
  };
  const familyIds = ensureUnique(bundle.planFamilies, "$.planFamilies");
  const revisionIds = ensureUnique(bundle.planRevisions, "$.planRevisions");
  const revisionsById = new Map(bundle.planRevisions.map((revision) => [revision.id, revision]));
  const weatherIds = ensureUnique(bundle.weatherSnapshots, "$.weatherSnapshots");
  ensureUnique(bundle.aircraftProfiles, "$.aircraftProfiles");
  bundle.planRevisions.forEach((revision, index) => {
    if (!familyIds.has(revision.planId)) issues.push({ path: `$.planRevisions[${index}].planId`, message: "must reference an exported plan family" });
    if (revision.parentRevisionId !== undefined && !revisionIds.has(revision.parentRevisionId) && !isTruncatedHistoryRoot(revision, bundle.planRevisions)) {
      issues.push({ path: `$.planRevisions[${index}].parentRevisionId`, message: "must reference an exported revision unless this is the oldest retained revision" });
    }
    const parentRevision = revision.parentRevisionId === undefined ? undefined : revisionsById.get(revision.parentRevisionId);
    if (parentRevision !== undefined && parentRevision.planId !== revision.planId) {
      issues.push({ path: `$.planRevisions[${index}].parentRevisionId`, message: "must reference a revision from the same plan family" });
    }
    revision.weatherSnapshotIds.forEach((id, weatherIndex) => {
      if (!weatherIds.has(id)) issues.push({ path: `$.planRevisions[${index}].weatherSnapshotIds[${weatherIndex}]`, message: "must reference an exported weather snapshot" });
    });
  });
  for (const [planId, revisions] of revisionsByPlan(bundle.planRevisions)) {
    if (revisions.length > MAX_REVISIONS_PER_PLAN) {
      issues.push({ path: "$.planRevisions", message: `must retain at most ${MAX_REVISIONS_PER_PLAN} revisions for plan ${planId}` });
    }
  }
  bundle.planFamilies.forEach((family, index) => {
    if (family.latestRevisionId !== undefined && !revisionIds.has(family.latestRevisionId)) issues.push({ path: `$.planFamilies[${index}].latestRevisionId`, message: "must reference an exported revision" });
    const latestRevision = family.latestRevisionId === undefined ? undefined : revisionsById.get(family.latestRevisionId);
    if (latestRevision !== undefined && latestRevision.planId !== family.id) {
      issues.push({ path: `$.planFamilies[${index}].latestRevisionId`, message: "must reference a revision from the same plan family" });
    }
  });
  if (issues.length > 0) throw new StorageValidationError(issues);
}

function revisionsByPlan(revisions: readonly NavlogExportBundle["planRevisions"][number][]): Map<string, readonly NavlogExportBundle["planRevisions"][number][]> {
  const grouped = new Map<string, NavlogExportBundle["planRevisions"][number][]>();
  for (const revision of revisions) grouped.set(revision.planId, [...(grouped.get(revision.planId) ?? []), revision]);
  return grouped;
}

function isTruncatedHistoryRoot(revision: NavlogExportBundle["planRevisions"][number], allRevisions: readonly NavlogExportBundle["planRevisions"][number][]): boolean {
  const history = allRevisions.filter((candidate) => candidate.planId === revision.planId);
  return history.length === MAX_REVISIONS_PER_PLAN && history
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0]?.id === revision.id;
}

export function serializeNavlogExport(bundle: NavlogExportBundle): string {
  // Validate the exact JSON representation before export too; corrupted
  // IndexedDB data must not propagate. The same bounded collection policy is
  // used for export and import so every generated backup remains restorable.
  const serialized = JSON.stringify(bundle);
  if (new TextEncoder().encode(serialized).byteLength > MAX_IMPORT_BYTES) {
    throw new StorageValidationError([{ path: "$", message: `export exceeds the ${MAX_IMPORT_BYTES} byte restore limit` }]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new StorageValidationError([{ path: "$", message: "must be serializable JSON" }]);
  }
  return JSON.stringify(validateNavlogExportBundle(parsed, new Date()));
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}
