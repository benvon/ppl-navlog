import type { AircraftProfile } from "../../domain/aircraft";
import type { PlanFamily, PlanRevision, WeatherReferenceSnapshot } from "../../domain/route";

/** Pre-1.0 journal store; intentionally separate from discarded graph-era data. */
export const NAVLOG_DATABASE_NAME = "ppl-navlog-journal-v1";
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

/** A portable, self-contained archive for exactly one bounded plan journal. */
export interface PlanArchive {
  readonly format: "ppl-navlog/plan-archive";
  readonly formatVersion: 1;
  readonly exportedAt: string;
  readonly planFamily: PlanFamily;
  readonly planRevisions: readonly PlanRevision[];
  readonly aircraftProfiles: readonly AircraftProfile[];
  readonly weatherSnapshots: readonly WeatherReferenceSnapshot[];
}

/** A separate small archive for reusable editable aircraft profiles. */
export interface ProfileArchive {
  readonly format: "ppl-navlog/profile-archive";
  readonly formatVersion: 1;
  readonly exportedAt: string;
  readonly aircraftProfiles: readonly AircraftProfile[];
}

export type NavlogArchive = PlanArchive | ProfileArchive;

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
