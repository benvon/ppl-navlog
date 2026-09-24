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
