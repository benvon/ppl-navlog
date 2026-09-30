import { AIRCRAFT_PROFILE_SCHEMA_VERSION, type AircraftProfile } from "./aircraft";

export interface AircraftProfileValidationIssue { readonly path: string; readonly message: string }
export type AircraftProfileValidation =
  | { readonly kind: "valid"; readonly profile: AircraftProfile }
  | { readonly kind: "malformed"; readonly issues: readonly AircraftProfileValidationIssue[] }
  | { readonly kind: "unsupported-schema"; readonly schemaVersion: number };

export function describeAircraftProfileValidation(result: Exclude<AircraftProfileValidation, { readonly kind: "valid" }>): string {
  if (result.kind === "unsupported-schema") return `Aircraft profile schema version ${result.schemaVersion} is unsupported.`;
  const describePath = (path: string): string => path === "$.compassDeviationTable" ? "Compass deviation table" : path
    .replace(/^\$\.compassDeviationTable\[\d+\]\./u, "Compass deviation table ")
    .replace(/^\$\./u, "").replaceAll(/([A-Z])/gu, (letter, offset: number) => offset === 0 ? letter : ` ${letter.toLowerCase()}`).replace(/^./u, (first) => first.toUpperCase());
  return `Aircraft profile is malformed: ${result.issues.map(({ path, message }) => `${describePath(path).trim()} ${message}`).join("; ")}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) && Number.isFinite(Date.parse(value));

/** Structural aircraft profile validation shared by persistence and calculation entry points. */
export function inspectAircraftProfile(value: unknown, now = new Date()): AircraftProfileValidation {
  if (isRecord(value) && typeof value.schemaVersion === "number" && Number.isInteger(value.schemaVersion) && value.schemaVersion > 0 && value.schemaVersion !== AIRCRAFT_PROFILE_SCHEMA_VERSION) {
    return { kind: "unsupported-schema", schemaVersion: value.schemaVersion };
  }
  const issues: AircraftProfileValidationIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  if (!isRecord(value)) return { kind: "malformed", issues: [{ path: "$", message: "must be an object" }] };
  validateProfileKeys(value, add);
  validateProfileValues(value, add);
  validateDeviationTable(value.compassDeviationTable, add);
  validateProfileTimestamps(value, now, add);
  return issues.length ? { kind: "malformed", issues } : { kind: "valid", profile: value as unknown as AircraftProfile };
}

type AddIssue = (path: string, message: string) => void;
const profileKeys = ["schemaVersion", "id", "name", "cruiseTasKnots", "cruiseFuelFlowGallonsPerHour", "climbRateFeetPerMinute", "climbTasKnots", "climbFuelFlowGallonsPerHour", "descentRateFeetPerMinute", "descentTasKnots", "descentFuelFlowGallonsPerHour", "usableFuelGallons", "compassDeviationTable", "createdAt", "updatedAt"];
const performanceFields = ["cruiseTasKnots", "cruiseFuelFlowGallonsPerHour", "climbRateFeetPerMinute", "climbTasKnots", "climbFuelFlowGallonsPerHour", "descentRateFeetPerMinute", "descentTasKnots", "descentFuelFlowGallonsPerHour"] as const;

function validateProfileKeys(value: Record<string, unknown>, add: AddIssue): void {
  if (Object.keys(value).some((key) => !profileKeys.includes(key))) add("$", "contains unsupported fields");
}

function validateProfileValues(value: Record<string, unknown>, add: AddIssue): void {
  validateProfileIdentity(value, add);
  validatePerformanceValues(value, add);
  validateFuelCapacity(value, add);
}

function validateProfileIdentity(value: Record<string, unknown>, add: AddIssue): void {
  if (value.schemaVersion !== AIRCRAFT_PROFILE_SCHEMA_VERSION) add("$.schemaVersion", `must equal supported schema version ${AIRCRAFT_PROFILE_SCHEMA_VERSION}`);
  if (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value.id)) add("$.id", "must be a valid profile identifier");
  if (typeof value.name !== "string" || !value.name.length || value.name.length > 120) add("$.name", "must be a non-empty string no longer than 120 characters");
}

function validatePerformanceValues(value: Record<string, unknown>, add: AddIssue): void {
  for (const key of performanceFields) {
    const item = value[key];
    if (typeof item !== "number" || !Number.isFinite(item) || item <= 0) add(`$.${key}`, "must be a finite positive number");
  }
}

function validateFuelCapacity(value: Record<string, unknown>, add: AddIssue): void {
  const capacity = value.usableFuelGallons;
  if (capacity !== undefined && (typeof capacity !== "number" || !Number.isFinite(capacity) || capacity < 0)) add("$.usableFuelGallons", "must be finite and nonnegative");
}

function validateDeviationTable(value: unknown, add: AddIssue): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 360) {
    add("$.compassDeviationTable", "must be an array with between 1 and 360 entries");
    return;
  }
  const seen = new Set<number>();
  value.forEach((entry, index) => validateDeviationEntry(entry, index, seen, add));
}

function validateDeviationEntry(entry: unknown, index: number, seen: Set<number>, add: AddIssue): void {
  const path = `$.compassDeviationTable[${index}]`;
  if (!isRecord(entry)) { add(path, "must be an object"); return; }
  if (Object.keys(entry).some((key) => key !== "magneticHeadingDegrees" && key !== "deviationDegrees")) add(path, "contains unsupported fields");
  const heading = entry.magneticHeadingDegrees, deviation = entry.deviationDegrees;
  if (typeof heading !== "number" || !Number.isFinite(heading) || heading < 0 || heading >= 360) add(`${path}.magneticHeadingDegrees`, "must be a finite number from 0 through less than 360");
  else if (seen.has(heading)) add(`${path}.magneticHeadingDegrees`, "must be unique");
  else seen.add(heading);
  if (typeof deviation !== "number" || !Number.isFinite(deviation) || deviation < -180 || deviation > 180) add(`${path}.deviationDegrees`, "must be a finite number from -180 through 180");
}

function validateProfileTimestamps(value: Record<string, unknown>, now: Date, add: AddIssue): void {
  for (const key of ["createdAt", "updatedAt"] as const) {
    if (!timestamp(value[key]) || new Date(Date.parse(value[key])).toISOString().slice(0, 19) !== value[key].slice(0, 19)) add(`$.${key}`, "must be a valid ISO-8601 UTC instant");
    else if (Date.parse(value[key]) > now.getTime()) add(`$.${key}`, "must not be in the future");
  }
  if (timestamp(value.createdAt) && timestamp(value.updatedAt) && Date.parse(value.updatedAt) < Date.parse(value.createdAt)) add("$.updatedAt", "must not be earlier than createdAt");
}
