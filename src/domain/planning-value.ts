/**
 * Provenance for a value displayed in a plan. The UI renders this structure;
 * domain code deliberately does not create preformatted explanation strings.
 */
export type PlanningValueOrigin =
  | "pilot-input"
  | "aircraft-default"
  | "external-data"
  | "calculated"
  | "interpolated";

export interface ValueProvenance {
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly recordedAt: string;
  readonly sourceVersion?: string;
}

export interface CalculationTraceReference {
  readonly formulaId: string;
  readonly formulaVersion: string;
  readonly traceId?: string;
}

export interface PlanningOverride<T> {
  readonly value: T;
  readonly reason?: string;
  readonly createdAt: string;
}

/**
 * `computedValue` remains visible after an override. The effective value is
 * what downstream calculations use. An override may only replace an existing
 * derived/default value, never hide a pilot-entered value.
 */
export interface PlanningValue<T> {
  readonly computedValue: T | null;
  readonly effectiveValue: T;
  readonly origin: PlanningValueOrigin;
  readonly provenance: ValueProvenance;
  readonly explanation?: CalculationTraceReference;
  readonly override?: PlanningOverride<T>;
}

export function isOverridden<T>(value: PlanningValue<T>): boolean {
  return value.override !== undefined;
}

export function restoreComputedValue<T>(value: PlanningValue<T>): PlanningValue<T> {
  if (value.computedValue === null) {
    throw new Error("A planning value without a computed/default value cannot be restored.");
  }

  return {
    computedValue: value.computedValue,
    effectiveValue: value.computedValue,
    origin: value.origin,
    provenance: value.provenance,
    ...(value.explanation === undefined ? {} : { explanation: value.explanation }),
  };
}

export function overridePlanningValue<T>(
  value: PlanningValue<T>,
  override: PlanningOverride<T>,
): PlanningValue<T> {
  if (value.computedValue === null || value.origin === "pilot-input") {
    throw new Error("Only calculated, interpolated, external, or aircraft-default values may be overridden.");
  }

  return {
    ...value,
    effectiveValue: override.value,
    override,
  };
}
