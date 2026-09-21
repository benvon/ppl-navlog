import {
  AIRCRAFT_PROFILE_SCHEMA_VERSION,
  type AircraftProfile,
  type AircraftProfileSnapshot,
  type CompassDeviationEntry,
} from "../../domain/aircraft";
import type { PlanningValue, PlanningValueOrigin } from "../../domain/planning-value";
import {
  PLAN_SCHEMA_VERSION,
  type JsonValue,
  type PlanDraft,
  type PlanFamily,
  type PlanRevision,
  type RouteDefinition,
  type RoutePoint,
  type WeatherReferenceSnapshot,
} from "../../domain/route";

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class StorageValidationError extends Error {
  public constructor(public readonly issues: readonly ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "StorageValidationError";
  }
}

type UnknownRecord = Record<string, unknown>;
const MAX_LABEL_LENGTH = 120;
const MAX_REASON_LENGTH = 500;
const MAX_WARNINGS = 100;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_ITEMS = 20_000;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const icaoPattern = /^[A-Z0-9]{4}$/;
const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function add(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function requiredString(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  maximumLength = MAX_LABEL_LENGTH,
): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    add(issues, path, `must be a non-empty string no longer than ${maximumLength} characters`);
    return false;
  }
  return true;
}

function identifier(value: unknown, path: string, issues: ValidationIssue[]): value is string {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    add(issues, path, "must contain 1-128 letters, digits, underscores, or hyphens and begin with a letter or digit");
    return false;
  }
  return true;
}

function finiteNumber(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  minimum?: number,
  maximum?: number,
): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    add(issues, path, "must be a finite number");
    return false;
  }
  if (minimum !== undefined && value < minimum) add(issues, path, `must be at least ${minimum}`);
  if (maximum !== undefined && value > maximum) add(issues, path, `must be at most ${maximum}`);
  return true;
}

function positiveNumber(value: unknown, path: string, issues: ValidationIssue[]): value is number {
  return finiteNumber(value, path, issues, Number.MIN_VALUE);
}

function nonNegativeNumber(value: unknown, path: string, issues: ValidationIssue[]): value is number {
  return finiteNumber(value, path, issues, 0);
}

function utcInstant(value: unknown, path: string, issues: ValidationIssue[]): value is string {
  if (typeof value !== "string" || !utcPattern.test(value) || Number.isNaN(Date.parse(value))) {
    add(issues, path, "must be an ISO-8601 UTC instant");
    return false;
  }
  return true;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string, issues: ValidationIssue[]): value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    add(issues, path, `must be one of: ${allowed.join(", ")}`);
    return false;
  }
  return true;
}

function schemaVersion(value: unknown, expected: number, path: string, issues: ValidationIssue[]): void {
  if (value !== expected) add(issues, path, `must equal supported schema version ${expected}`);
}

function checkNoFutureTimestamp(value: string, path: string, issues: ValidationIssue[], now: Date): void {
  if (Date.parse(value) > now.getTime()) add(issues, path, "must not be in the future");
}

function validateDeviationEntry(value: unknown, path: string, issues: ValidationIssue[]): value is CompassDeviationEntry {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return false;
  }
  finiteNumber(value.magneticHeadingDegrees, `${path}.magneticHeadingDegrees`, issues, 0, 359.99999999999994);
  finiteNumber(value.deviationDegrees, `${path}.deviationDegrees`, issues, -180, 180);
  return true;
}

export function validateAircraftProfile(value: unknown, now = new Date()): value is AircraftProfile {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) throw new StorageValidationError([{ path: "$", message: "must be an object" }]);
  schemaVersion(value.schemaVersion, AIRCRAFT_PROFILE_SCHEMA_VERSION, "$.schemaVersion", issues);
  identifier(value.id, "$.id", issues);
  requiredString(value.name, "$.name", issues);
  positiveNumber(value.cruiseTasKnots, "$.cruiseTasKnots", issues);
  positiveNumber(value.cruiseFuelFlowGallonsPerHour, "$.cruiseFuelFlowGallonsPerHour", issues);
  positiveNumber(value.climbRateFeetPerMinute, "$.climbRateFeetPerMinute", issues);
  positiveNumber(value.climbTasKnots, "$.climbTasKnots", issues);
  positiveNumber(value.climbFuelFlowGallonsPerHour, "$.climbFuelFlowGallonsPerHour", issues);
  positiveNumber(value.descentRateFeetPerMinute, "$.descentRateFeetPerMinute", issues);
  positiveNumber(value.descentTasKnots, "$.descentTasKnots", issues);
  positiveNumber(value.descentFuelFlowGallonsPerHour, "$.descentFuelFlowGallonsPerHour", issues);
  if (value.usableFuelGallons !== undefined) nonNegativeNumber(value.usableFuelGallons, "$.usableFuelGallons", issues);
  if (!Array.isArray(value.compassDeviationTable) || value.compassDeviationTable.length > 360) {
    add(issues, "$.compassDeviationTable", "must be an array with at most 360 entries");
  } else {
    const headings = new Set<number>();
    value.compassDeviationTable.forEach((entry, index) => {
      if (validateDeviationEntry(entry, `$.compassDeviationTable[${index}]`, issues) && isRecord(entry)) {
        const heading = entry.magneticHeadingDegrees;
        if (typeof heading === "number" && headings.has(heading)) add(issues, `$.compassDeviationTable[${index}].magneticHeadingDegrees`, "must be unique");
        if (typeof heading === "number") headings.add(heading);
      }
    });
  }
  if (utcInstant(value.createdAt, "$.createdAt", issues)) checkNoFutureTimestamp(value.createdAt, "$.createdAt", issues, now);
  if (utcInstant(value.updatedAt, "$.updatedAt", issues)) {
    checkNoFutureTimestamp(value.updatedAt, "$.updatedAt", issues, now);
    if (typeof value.createdAt === "string" && Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
      add(issues, "$.updatedAt", "must not be earlier than createdAt");
    }
  }
  if (issues.length > 0) throw new StorageValidationError(issues);
  return true;
}

export function validateAircraftProfileSnapshot(value: unknown, now = new Date()): value is AircraftProfileSnapshot {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) throw new StorageValidationError([{ path: "$", message: "must be an object" }]);
  try {
    validateAircraftProfile(value.profile, now);
  } catch (error) {
    if (error instanceof StorageValidationError) error.issues.forEach((issue) => add(issues, `$.profile${issue.path.slice(1)}`, issue.message));
    else throw error;
  }
  if (utcInstant(value.snapshottedAt, "$.snapshottedAt", issues)) checkNoFutureTimestamp(value.snapshottedAt, "$.snapshottedAt", issues, now);
  if (issues.length > 0) throw new StorageValidationError(issues);
  return true;
}

function validatePlanningValue(value: unknown, path: string, issues: ValidationIssue[]): value is PlanningValue<number> {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return false;
  }
  const originValues: readonly PlanningValueOrigin[] = ["pilot-input", "aircraft-default", "external-data", "calculated", "interpolated"];
  const validOrigin = oneOf(value.origin, originValues, `${path}.origin`, issues);
  const computedIsNull = value.computedValue === null;
  if (!computedIsNull) finiteNumber(value.computedValue, `${path}.computedValue`, issues);
  finiteNumber(value.effectiveValue, `${path}.effectiveValue`, issues);
  validateValueProvenance(value.provenance, `${path}.provenance`, issues);
  validateValueOverride(value, path, issues, computedIsNull, validOrigin);
  return true;
}

function validateValueProvenance(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return;
  }
  identifier(value.sourceId, `${path}.sourceId`, issues);
  requiredString(value.sourceLabel, `${path}.sourceLabel`, issues);
  utcInstant(value.recordedAt, `${path}.recordedAt`, issues);
  if (value.sourceVersion !== undefined) requiredString(value.sourceVersion, `${path}.sourceVersion`, issues);
}

function validateValueOverride(
  value: UnknownRecord,
  path: string,
  issues: ValidationIssue[],
  computedIsNull: boolean,
  validOrigin: boolean,
): void {
  if (value.override === undefined) {
    validateUnmodifiedEffectiveValue(value, path, issues, computedIsNull);
    return;
  }
  if (!isRecord(value.override)) {
    add(issues, `${path}.override`, "must be an object");
    return;
  }
  validateOverrideFields(value.override, path, issues);
  if (computedIsNull) add(issues, `${path}.override`, "requires a computed/default value");
  if (validOrigin && value.origin === "pilot-input") add(issues, `${path}.override`, "cannot override a pilot-input value");
  if (typeof value.effectiveValue === "number" && typeof value.override.value === "number" && value.effectiveValue !== value.override.value) {
    add(issues, `${path}.effectiveValue`, "must equal override.value when an override exists");
  }
}

function validateOverrideFields(value: UnknownRecord, path: string, issues: ValidationIssue[]): void {
  finiteNumber(value.value, `${path}.override.value`, issues);
  if (value.reason !== undefined) requiredString(value.reason, `${path}.override.reason`, issues, MAX_REASON_LENGTH);
  utcInstant(value.createdAt, `${path}.override.createdAt`, issues);
}

function validateUnmodifiedEffectiveValue(value: UnknownRecord, path: string, issues: ValidationIssue[], computedIsNull: boolean): void {
  if (!computedIsNull && typeof value.computedValue === "number" && value.effectiveValue !== value.computedValue) {
    add(issues, `${path}.effectiveValue`, "must equal computedValue when no override exists");
  }
}

function validateCoordinate(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return;
  }
  finiteNumber(value.latitude, `${path}.latitude`, issues, -90, 90);
  finiteNumber(value.longitude, `${path}.longitude`, issues, -180, 180);
}

function validateRoutePoint(value: unknown, path: string, issues: ValidationIssue[]): value is RoutePoint {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return false;
  }
  const kind = oneOf(value.kind, ["airport", "checkpoint"] as const, `${path}.kind`, issues);
  identifier(value.id, `${path}.id`, issues);
  requiredString(value.name, `${path}.name`, issues);
  validateCoordinate(value.coordinate, `${path}.coordinate`, issues);
  if (kind && value.kind === "airport") {
    if (typeof value.icao !== "string" || !icaoPattern.test(value.icao)) add(issues, `${path}.icao`, "must be an uppercase four-character ICAO identifier");
    finiteNumber(value.elevationFeetMsl, `${path}.elevationFeetMsl`, issues, -2_000, 50_000);
  }
  return true;
}

export function validateRouteDefinition(value: unknown): value is RouteDefinition {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) throw new StorageValidationError([{ path: "$", message: "must be an object" }]);
  identifier(value.id, "$.id", issues);
  validateRoutePoints(value.points, issues);
  validateRouteLegs(value.points, value.legs, issues);
  if (issues.length > 0) throw new StorageValidationError(issues);
  return true;
}

function validateRoutePoints(value: unknown, issues: ValidationIssue[]): void {
  if (!Array.isArray(value) || value.length < 2 || value.length > 100) {
    add(issues, "$.points", "must contain 2-100 route points");
    return;
  }
  const pointIds = new Set<string>();
  value.forEach((point, index) => {
    if (validateRoutePoint(point, `$.points[${index}]`, issues) && isRecord(point) && typeof point.id === "string") {
      if (pointIds.has(point.id)) add(issues, `$.points[${index}].id`, "must be unique");
      pointIds.add(point.id);
    }
  });
  if (!isRecord(value[0]) || value[0].kind !== "airport") add(issues, "$.points[0]", "must be a departure airport");
  const last = value[value.length - 1];
  if (!isRecord(last) || last.kind !== "airport") add(issues, "$.points[last]", "must be a destination airport");
}

function validateRouteLegs(points: unknown, legs: unknown, issues: ValidationIssue[]): void {
  if (!Array.isArray(legs) || !Array.isArray(points) || legs.length !== points.length - 1) {
    add(issues, "$.legs", "must contain exactly one ordered leg between each adjacent route point");
    return;
  }
  legs.forEach((leg, index) => validateRouteLeg(leg, index, points, issues));
}

function validateRouteLeg(leg: unknown, index: number, points: unknown[], issues: ValidationIssue[]): void {
  const path = `$.legs[${index}]`;
  if (!isRecord(leg)) {
    add(issues, path, "must be an object");
    return;
  }
  identifier(leg.id, `${path}.id`, issues);
  identifier(leg.fromPointId, `${path}.fromPointId`, issues);
  identifier(leg.toPointId, `${path}.toPointId`, issues);
  positiveNumber(leg.cruiseAltitudeFeetMsl, `${path}.cruiseAltitudeFeetMsl`, issues);
  const fromPoint = points[index];
  const toPoint = points[index + 1];
  if (isRecord(fromPoint) && leg.fromPointId !== fromPoint.id) add(issues, `${path}.fromPointId`, "must match the preceding route point");
  if (isRecord(toPoint) && leg.toPointId !== toPoint.id) add(issues, `${path}.toPointId`, "must match the following route point");
  validatePerformanceOverrides(leg.performanceOverrides, `${path}.performanceOverrides`, issues);
}

function validatePerformanceOverrides(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return;
  }
  if (value.cruiseTasKnots !== undefined) validatePlanningValue(value.cruiseTasKnots, `${path}.cruiseTasKnots`, issues);
  if (value.cruiseFuelFlowGallonsPerHour !== undefined) validatePlanningValue(value.cruiseFuelFlowGallonsPerHour, `${path}.cruiseFuelFlowGallonsPerHour`, issues);
}

export function validatePlanDraft(value: unknown, now = new Date()): value is PlanDraft {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) throw new StorageValidationError([{ path: "$", message: "must be an object" }]);
  schemaVersion(value.schemaVersion, PLAN_SCHEMA_VERSION, "$.schemaVersion", issues);
  identifier(value.id, "$.id", issues);
  identifier(value.planId, "$.planId", issues);
  requiredString(value.title, "$.title", issues);
  utcInstant(value.departureTimeUtc, "$.departureTimeUtc", issues);
  try { validateRouteDefinition(value.route); } catch (error) { if (error instanceof StorageValidationError) error.issues.forEach((issue) => add(issues, `$.route${issue.path.slice(1)}`, issue.message)); else throw error; }
  identifier(value.selectedAircraftProfileId, "$.selectedAircraftProfileId", issues);
  if (!isRecord(value.fuelInputs)) add(issues, "$.fuelInputs", "must be an object");
  else {
    nonNegativeNumber(value.fuelInputs.taxiRunupFuelGallons, "$.fuelInputs.taxiRunupFuelGallons", issues);
    nonNegativeNumber(value.fuelInputs.reserveFuelGallons, "$.fuelInputs.reserveFuelGallons", issues);
  }
  validateWeatherSelection(value.weatherSelection, issues, now);
  validatePlanningValue(value.descentTargetAltitudeFeetMsl, "$.descentTargetAltitudeFeetMsl", issues);
  if (utcInstant(value.createdAt, "$.createdAt", issues)) checkNoFutureTimestamp(value.createdAt, "$.createdAt", issues, now);
  if (utcInstant(value.updatedAt, "$.updatedAt", issues)) {
    checkNoFutureTimestamp(value.updatedAt, "$.updatedAt", issues, now);
    if (typeof value.createdAt === "string" && Date.parse(value.updatedAt) < Date.parse(value.createdAt)) add(issues, "$.updatedAt", "must not be earlier than createdAt");
  }
  if (issues.length > 0) throw new StorageValidationError(issues);
  return true;
}

function validateWeatherSelection(value: unknown, issues: ValidationIssue[], now: Date): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    add(issues, "$.weatherSelection", "must be an object");
    return;
  }
  utcInstant(value.forecastValidTimeUtc, "$.weatherSelection.forecastValidTimeUtc", issues);
  if (utcInstant(value.selectedAtUtc, "$.weatherSelection.selectedAtUtc", issues)) {
    checkNoFutureTimestamp(value.selectedAtUtc, "$.weatherSelection.selectedAtUtc", issues, now);
  }
}

export function validatePlanFamily(value: unknown, now = new Date()): value is PlanFamily {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) throw new StorageValidationError([{ path: "$", message: "must be an object" }]);
  schemaVersion(value.schemaVersion, PLAN_SCHEMA_VERSION, "$.schemaVersion", issues);
  identifier(value.id, "$.id", issues);
  requiredString(value.title, "$.title", issues);
  if (value.latestRevisionId !== undefined) identifier(value.latestRevisionId, "$.latestRevisionId", issues);
  if (utcInstant(value.createdAt, "$.createdAt", issues)) checkNoFutureTimestamp(value.createdAt, "$.createdAt", issues, now);
  if (issues.length > 0) throw new StorageValidationError(issues);
  return true;
}

export function isJsonValue(value: unknown, depth = 0, count = { value: 0 }): value is JsonValue {
  if (depth > MAX_JSON_DEPTH || ++count.value > MAX_JSON_ITEMS) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1, count));
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, item]) => key.length <= MAX_LABEL_LENGTH && isJsonValue(item, depth + 1, count));
}

export function validateWeatherReferenceSnapshot(value: unknown, now = new Date()): value is WeatherReferenceSnapshot {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) throw new StorageValidationError([{ path: "$", message: "must be an object" }]);
  schemaVersion(value.schemaVersion, PLAN_SCHEMA_VERSION, "$.schemaVersion", issues);
  identifier(value.id, "$.id", issues);
  requiredString(value.source, "$.source", issues);
  if (utcInstant(value.retrievedAt, "$.retrievedAt", issues)) checkNoFutureTimestamp(value.retrievedAt, "$.retrievedAt", issues, now);
  if (!isJsonValue(value.payload)) add(issues, "$.payload", "must be finite JSON data within supported depth and collection limits");
  if (issues.length > 0) throw new StorageValidationError(issues);
  return true;
}

export function validatePlanRevision(value: unknown, now = new Date()): value is PlanRevision {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) throw new StorageValidationError([{ path: "$", message: "must be an object" }]);
  schemaVersion(value.schemaVersion, PLAN_SCHEMA_VERSION, "$.schemaVersion", issues);
  identifier(value.id, "$.id", issues);
  identifier(value.planId, "$.planId", issues);
  if (value.parentRevisionId !== undefined) identifier(value.parentRevisionId, "$.parentRevisionId", issues);
  validateRevisionMetadata(value, issues, now);
  validateRevisionSnapshots(value, issues, now);
  validateRevisionReferences(value, issues);
  if (isRecord(value.draftSnapshot) && value.planId !== value.draftSnapshot.planId) add(issues, "$.planId", "must equal draftSnapshot.planId");
  if (issues.length > 0) throw new StorageValidationError(issues);
  return true;
}

function validateRevisionMetadata(value: UnknownRecord, issues: ValidationIssue[], now: Date): void {
  oneOf(value.reason, ["initial-save", "input-change", "weather-refresh", "recalculation", "import"] as const, "$.reason", issues);
  if (utcInstant(value.createdAt, "$.createdAt", issues)) checkNoFutureTimestamp(value.createdAt, "$.createdAt", issues, now);
}

function validateRevisionSnapshots(value: UnknownRecord, issues: ValidationIssue[], now: Date): void {
  try { validatePlanDraft(value.draftSnapshot, now); } catch (error) { if (error instanceof StorageValidationError) error.issues.forEach((issue) => add(issues, `$.draftSnapshot${issue.path.slice(1)}`, issue.message)); else throw error; }
  try { validateAircraftProfileSnapshot(value.aircraftProfileSnapshot, now); } catch (error) { if (error instanceof StorageValidationError) error.issues.forEach((issue) => add(issues, `$.aircraftProfileSnapshot${issue.path.slice(1)}`, issue.message)); else throw error; }
}

function validateRevisionReferences(value: UnknownRecord, issues: ValidationIssue[]): void {
  if (!Array.isArray(value.weatherSnapshotIds) || value.weatherSnapshotIds.length > 100) add(issues, "$.weatherSnapshotIds", "must be an array of at most 100 identifiers");
  else value.weatherSnapshotIds.forEach((id, index) => identifier(id, `$.weatherSnapshotIds[${index}]`, issues));
  if (value.calculationSnapshot !== undefined && !isJsonValue(value.calculationSnapshot)) add(issues, "$.calculationSnapshot", "must be finite JSON data within supported depth and collection limits");
  if (!Array.isArray(value.warnings) || value.warnings.length > MAX_WARNINGS || !value.warnings.every((warning) => typeof warning === "string" && warning.length <= MAX_LABEL_LENGTH)) add(issues, "$.warnings", `must be an array of at most ${MAX_WARNINGS} short strings`);
}
