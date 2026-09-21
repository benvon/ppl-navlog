import type { AircraftProfileSnapshot } from "./aircraft";
import type { Coordinate } from "./coordinates";
import type { PlanningValue } from "./planning-value";

export const PLAN_SCHEMA_VERSION = 1 as const;

export interface AirportRoutePoint {
  readonly kind: "airport";
  readonly id: string;
  readonly icao: string;
  readonly name: string;
  readonly coordinate: Coordinate;
  readonly elevationFeetMsl: number;
}

export interface CheckpointRoutePoint {
  readonly kind: "checkpoint";
  readonly id: string;
  readonly name: string;
  readonly coordinate: Coordinate;
}

export type RoutePoint = AirportRoutePoint | CheckpointRoutePoint;

/** A user-created route leg. Generated climb/descent legs belong to calculation results. */
export interface UserRouteLeg {
  readonly id: string;
  readonly fromPointId: string;
  readonly toPointId: string;
  /** Pilot-selected cruise altitude; it is not a calculated result. */
  readonly cruiseAltitudeFeetMsl: number;
  /** Deliberate values replacing aircraft defaults for only this leg. */
  readonly performanceOverrides?: {
    readonly cruiseTasKnots?: PlanningValue<number>;
    readonly cruiseFuelFlowGallonsPerHour?: PlanningValue<number>;
  };
}

export interface RouteDefinition {
  readonly id: string;
  readonly points: readonly RoutePoint[];
  readonly legs: readonly UserRouteLeg[];
}

export interface PlanFuelInputs {
  readonly taxiRunupFuelGallons: number;
  readonly reserveFuelGallons: number;
}

/** The editable state. Saving it always creates a distinct immutable revision. */
export interface PlanDraft {
  readonly schemaVersion: typeof PLAN_SCHEMA_VERSION;
  readonly id: string;
  readonly planId: string;
  readonly title: string;
  readonly departureTimeUtc: string;
  readonly route: RouteDefinition;
  readonly selectedAircraftProfileId: string;
  readonly fuelInputs: PlanFuelInputs;
  readonly descentTargetAltitudeFeetMsl: PlanningValue<number>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlanFamily {
  readonly schemaVersion: typeof PLAN_SCHEMA_VERSION;
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly latestRevisionId?: string;
}

export type RevisionReason = "initial-save" | "input-change" | "weather-refresh" | "recalculation" | "import";

/**
 * A JSON-safe placeholder for calculated data owned by flight-math/application
 * layers. This layer validates its shape and preserves it verbatim.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface PlanRevision {
  readonly schemaVersion: typeof PLAN_SCHEMA_VERSION;
  readonly id: string;
  readonly planId: string;
  readonly parentRevisionId?: string;
  readonly reason: RevisionReason;
  readonly createdAt: string;
  readonly draftSnapshot: PlanDraft;
  readonly aircraftProfileSnapshot: AircraftProfileSnapshot;
  readonly weatherSnapshotIds: readonly string[];
  readonly calculationSnapshot?: JsonValue;
  readonly warnings: readonly string[];
}

export interface WeatherReferenceSnapshot {
  readonly schemaVersion: typeof PLAN_SCHEMA_VERSION;
  readonly id: string;
  readonly retrievedAt: string;
  readonly source: string;
  readonly payload: JsonValue;
}
