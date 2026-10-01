import type { AircraftProfileSnapshot } from "./aircraft";
import type { Coordinate } from "./coordinates";
import type { PlanningValue } from "./planning-value";

export const PLAN_SCHEMA_VERSION = 1 as const;

export interface AirportRoutePoint {
  readonly kind: "airport";
  readonly id: string;
  /** Exact 3–4 character airport identifier: FAA LID or ICAO code. */
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
  /** Optional while inputs are incomplete; required before worksheet calculation. */
  readonly fuelAboardGallons?: number;
  readonly taxiRunupFuelGallons: number;
  readonly reserveFuelGallons: number;
}

/** Current departure METAR alternate, when the airport has no usable source. */
export interface PlanWeatherSelection {
  readonly departureMetarIcao?: string;
}

/** Validated inputs assembled in memory for the current worksheet calculation. */
export interface PlanDraft {
  readonly schemaVersion: typeof PLAN_SCHEMA_VERSION;
  readonly id: string;
  readonly planId: string;
  readonly title: string;
  readonly departureTimeUtc: string;
  readonly route: RouteDefinition;
  readonly selectedAircraftProfileId: string;
  readonly fuelInputs: PlanFuelInputs;
  /** Optional departure METAR source selection. */
  readonly weatherSelection?: PlanWeatherSelection;
  readonly descentTargetAltitudeFeetMsl: PlanningValue<number>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A JSON-safe placeholder for calculated data owned by flight-math/application
 * layers. This layer validates its shape and preserves it verbatim.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Disposable current-session worksheet and its inspection evidence. Never persisted. */
export interface WorksheetResult {
  readonly schemaVersion: typeof PLAN_SCHEMA_VERSION;
  readonly id: string;
  readonly planId: string;
  readonly createdAt: string;
  readonly draftSnapshot: PlanDraft;
  readonly aircraftProfileSnapshot: AircraftProfileSnapshot;
  readonly weatherSnapshotIds: readonly string[];
  readonly calculationSnapshot?: JsonValue;
  readonly warnings: readonly string[];
}
