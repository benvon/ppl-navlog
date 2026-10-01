import { type AircraftProfile, type AircraftProfileSnapshot } from "../../domain/aircraft";
import type { PlanningValue, PlanningValueOrigin } from "../../domain/planning-value";
import {
  PLAN_SCHEMA_VERSION,
  type JsonValue,
  type PlanDraft,
  type RouteDefinition,
  type RoutePoint,
} from "../../domain/route";
import { inspectAircraftProfile } from "../../domain/aircraft-profile-validation";

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
const MAX_JSON_DEPTH = 32;
const MAX_JSON_ITEMS = 20_000;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const airportCodePattern = /^[A-Z0-9]{3,4}$/;
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

function checkNoFutureTimestamp(value: string, path: string, issues: ValidationIssue[], now: Date, toleranceMs = 0): void {
  if (Date.parse(value) > now.getTime() + toleranceMs) add(issues, path, "must not be in the future");
}

export function validateAircraftProfile(value: unknown, now = new Date()): value is AircraftProfile {
  const checked = inspectAircraftProfile(value, now);
  if (checked.kind !== "valid") throw new StorageValidationError(checked.kind === "unsupported-schema"
    ? [{ path: "$.schemaVersion", message: `uses unsupported aircraft profile schema version ${checked.schemaVersion}` }]
    : checked.issues);
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
    if (typeof value.icao !== "string" || !airportCodePattern.test(value.icao)) add(issues, `${path}.icao`, "must be an uppercase three- or four-character FAA LID or ICAO code");
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
  const legIds = new Set<string>();
  legs.forEach((leg, index) => {
    validateRouteLeg(leg, index, points, issues);
    if (isRecord(leg) && typeof leg.id === "string") {
      if (legIds.has(leg.id)) add(issues, `$.legs[${index}].id`, "must be unique");
      legIds.add(leg.id);
    }
  });
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
  if (value.cruiseTasKnots !== undefined) validatePositivePlanningValue(value.cruiseTasKnots, `${path}.cruiseTasKnots`, issues);
  if (value.cruiseFuelFlowGallonsPerHour !== undefined) validatePositivePlanningValue(value.cruiseFuelFlowGallonsPerHour, `${path}.cruiseFuelFlowGallonsPerHour`, issues);
}

function validatePositivePlanningValue(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!validatePlanningValue(value, path, issues) || !isRecord(value)) return;
  if (value.computedValue !== null) positiveNumber(value.computedValue, `${path}.computedValue`, issues);
  positiveNumber(value.effectiveValue, `${path}.effectiveValue`, issues);
  if (isRecord(value.override)) positiveNumber(value.override.value, `${path}.override.value`, issues);
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
    if (value.fuelInputs.fuelAboardGallons !== undefined) nonNegativeNumber(value.fuelInputs.fuelAboardGallons, "$.fuelInputs.fuelAboardGallons", issues);
    nonNegativeNumber(value.fuelInputs.taxiRunupFuelGallons, "$.fuelInputs.taxiRunupFuelGallons", issues);
    nonNegativeNumber(value.fuelInputs.reserveFuelGallons, "$.fuelInputs.reserveFuelGallons", issues);
  }
  validateWeatherSelection(value.weatherSelection, issues);
  validatePlanningValue(value.descentTargetAltitudeFeetMsl, "$.descentTargetAltitudeFeetMsl", issues);
  if (utcInstant(value.createdAt, "$.createdAt", issues)) checkNoFutureTimestamp(value.createdAt, "$.createdAt", issues, now);
  if (utcInstant(value.updatedAt, "$.updatedAt", issues)) {
    checkNoFutureTimestamp(value.updatedAt, "$.updatedAt", issues, now);
    if (typeof value.createdAt === "string" && Date.parse(value.updatedAt) < Date.parse(value.createdAt)) add(issues, "$.updatedAt", "must not be earlier than createdAt");
  }
  if (issues.length > 0) throw new StorageValidationError(issues);
  return true;
}

function validateWeatherSelection(value: unknown, issues: ValidationIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    add(issues, "$.weatherSelection", "must be an object");
    return;
  }
  if (Object.keys(value).some((key) => key !== "departureMetarIcao")) add(issues, "$.weatherSelection", "contains unsupported fields");
  validateOptionalWeatherIcao(value.departureMetarIcao, "$.weatherSelection.departureMetarIcao", issues);
}

function validateOptionalWeatherIcao(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (value !== undefined && (typeof value !== "string" || !/^[A-Z0-9]{4}$/.test(value))) {
    add(issues, path, "must be an uppercase four-character ICAO identifier when present");
  }
}

export function isJsonValue(value: unknown, depth = 0, count = { value: 0 }): value is JsonValue {
  if (depth > MAX_JSON_DEPTH || ++count.value > MAX_JSON_ITEMS) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1, count));
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, item]) => key.length <= MAX_LABEL_LENGTH && isJsonValue(item, depth + 1, count));
}
