import type { AircraftProfile } from "../../domain/aircraft";
import type { PlanFamily, PlanRevision, WeatherReferenceSnapshot } from "../../domain/route";

export const NAVLOG_DATABASE_NAME = "ppl-navlog";
export const NAVLOG_DATABASE_VERSION = 1;
/** Each plan retains the latest 20 immutable revisions, including weather refreshes. */
export const MAX_REVISIONS_PER_PLAN = 20;

export const NAVLOG_STORES = {
  aircraftProfiles: "aircraftProfiles",
  planFamilies: "planFamilies",
  planRevisions: "planRevisions",
  weatherSnapshots: "weatherSnapshots",
} as const;

export type NavlogStoreName = (typeof NAVLOG_STORES)[keyof typeof NAVLOG_STORES];

export interface NavlogExportBundle {
  readonly format: "ppl-navlog/export";
  readonly formatVersion: 1;
  readonly exportedAt: string;
  readonly aircraftProfiles: readonly AircraftProfile[];
  readonly planFamilies: readonly PlanFamily[];
  readonly planRevisions: readonly PlanRevision[];
  readonly weatherSnapshots: readonly WeatherReferenceSnapshot[];
}

export type ImportMode = "merge" | "replace";

export interface ImportResult {
  readonly aircraftProfiles: number;
  readonly planFamilies: number;
  readonly planRevisions: number;
  readonly weatherSnapshots: number;
}

export class StorageUnavailableError extends Error {
  public constructor(message = "IndexedDB is unavailable in this browser context.") {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

export class ImmutableRevisionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ImmutableRevisionError";
  }
}

export class ImportConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ImportConflictError";
  }
}
