import { indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { ImportConflictError, ImmutableRevisionError } from "../contracts";
import { IndexedDbNavlogRepository } from "../indexed-db-repository";
import { parseNavlogExport } from "../json-transfer";
import { aircraftProfile, exportBundle, planFamily, planRevision, weatherSnapshot } from "./fixtures";

const now = () => new Date("2027-01-01T00:00:00.000Z");
let sequence = 0;
const repositories: IndexedDbNavlogRepository[] = [];
const databaseNames: string[] = [];

function repository(): IndexedDbNavlogRepository {
  const databaseName = `ppl-navlog-test-${sequence += 1}`;
  databaseNames.push(databaseName);
  const created = new IndexedDbNavlogRepository({ databaseName, indexedDbFactory: indexedDB, now });
  repositories.push(created);
  return created;
}

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((item) => item.close()));
  await Promise.all(databaseNames.splice(0).map((name) => deleteDatabase(name)));
});

describe("IndexedDbNavlogRepository", () => {
  it("can be closed before it has opened a browser database", async () => {
    await expect(repository().close()).resolves.toBeUndefined();
  });

  it("validates and returns defensive copies of aircraft profiles", async () => {
    const store = repository();
    const profile = aircraftProfile();

    await store.saveAircraftProfile(profile);
    const loaded = await store.getAircraftProfile(profile.id);
    expect(loaded).toEqual(profile);
    if (loaded === undefined) throw new Error("Expected profile to be present.");
    const changed = { ...loaded, name: "Mutated local value" };
    expect(changed.name).toBe("Mutated local value");
    expect((await store.getAircraftProfile(profile.id))?.name).toBe(profile.name);
  });

  it("creates an append-only revision lineage and rejects mutation of a revision id", async () => {
    const store = repository();
    const initialFamily = planFamily();
    const initialRevision = planRevision();
    await store.saveWeatherSnapshot(weatherSnapshot());
    await store.savePlanRevision(initialFamily, initialRevision);

    const nextRevision = {
      ...initialRevision,
      id: "revision-2",
      parentRevisionId: initialRevision.id,
      reason: "input-change" as const,
    };
    const nextFamily = { ...initialFamily, latestRevisionId: nextRevision.id };
    await store.savePlanRevision(nextFamily, nextRevision);

    expect((await store.listPlanRevisions(initialFamily.id)).map((revision) => revision.id)).toEqual(["revision-1", "revision-2"]);
    await expect(store.savePlanRevision(nextFamily, nextRevision)).rejects.toBeInstanceOf(ImmutableRevisionError);
  });

  it("rejects a revision whose parent is not stored in the same plan family", async () => {
    const store = repository();
    const family = planFamily();
    const revision = { ...planRevision(), parentRevisionId: "missing-parent", id: "revision-child" };
    const updatedFamily = { ...family, latestRevisionId: revision.id };

    await expect(store.savePlanRevision(updatedFamily, revision)).rejects.toThrow(/Parent revision/);
    expect(await store.getPlanRevision(revision.id)).toBeUndefined();
  });

  it("rejects revisions that reference an absent weather snapshot or a different aircraft snapshot", async () => {
    const store = repository();
    const revision = planRevision();
    const family = planFamily();

    await expect(store.savePlanRevision(family, revision)).rejects.toThrow(/Weather snapshot/);
    const wrongAircraft = { ...revision, aircraftProfileSnapshot: { ...revision.aircraftProfileSnapshot, profile: { ...revision.aircraftProfileSnapshot.profile, id: "different-aircraft" } } };
    await expect(store.savePlanRevision(family, wrongAircraft)).rejects.toThrow(/selectedAircraftProfileId/);
  });

  it("rejects mismatched family identifiers and stale latest-revision pointers before writing", async () => {
    const store = repository();
    const family = planFamily();
    const revision = planRevision();

    await expect(store.savePlanRevision({ ...family, id: "other-plan" }, revision)).rejects.toThrow(/must equal family.id/);
    await expect(store.savePlanRevision({ ...family, latestRevisionId: "other-revision" }, revision)).rejects.toThrow(/must identify/);
    expect(await store.getPlanRevision(revision.id)).toBeUndefined();
  });

  it("imports a complete export atomically and exposes all imported records", async () => {
    const store = repository();
    const bundle = exportBundle();

    await expect(store.importJson(JSON.stringify(bundle))).resolves.toEqual({
      aircraftProfiles: 1,
      planFamilies: 1,
      planRevisions: 1,
      weatherSnapshots: 1,
    });
    expect(await store.getAircraftProfile(bundle.aircraftProfiles[0]?.id ?? "missing")).toEqual(bundle.aircraftProfiles[0]);
    expect(await store.getPlanRevision(bundle.planRevisions[0]?.id ?? "missing")).toEqual(bundle.planRevisions[0]);
  });

  it("rolls back all records when a merge import conflicts", async () => {
    const store = repository();
    const bundle = exportBundle();
    await store.saveAircraftProfile(bundle.aircraftProfiles[0]!);

    await expect(store.importJson(JSON.stringify(bundle))).rejects.toBeInstanceOf(ImportConflictError);
    expect(await store.getPlanRevision(bundle.planRevisions[0]!.id)).toBeUndefined();
    expect(await store.listAircraftProfiles()).toEqual([bundle.aircraftProfiles[0]]);
  });

  it("replaces existing data only after the complete import passes validation", async () => {
    const store = repository();
    const existing = { ...aircraftProfile(), id: "aircraft-existing" };
    await store.saveAircraftProfile(existing);
    const bundle = exportBundle();

    await store.importJson(JSON.stringify(bundle), "replace");

    expect(await store.getAircraftProfile(existing.id)).toBeUndefined();
    expect(await store.getAircraftProfile(bundle.aircraftProfiles[0]!.id)).toEqual(bundle.aircraftProfiles[0]);
  });

  it("leaves existing data intact when import validation fails before its transaction", async () => {
    const store = repository();
    const existing = aircraftProfile();
    await store.saveAircraftProfile(existing);
    const malformed = { ...exportBundle(), formatVersion: 2 };

    await expect(store.importJson(JSON.stringify(malformed), "replace")).rejects.toThrow(/formatVersion/);
    expect(await store.getAircraftProfile(existing.id)).toEqual(existing);
  });

  it("exports only records that still pass runtime validation", async () => {
    const store = repository();
    const bundle = exportBundle();
    await store.importJson(JSON.stringify(bundle));

    const exported = parseNavlogExport(await store.exportJson("2026-09-21T12:00:00.000Z"), now());
    expect(exported).toEqual(bundle);
  });

  it("does not allow a weather snapshot id to be overwritten", async () => {
    const store = repository();
    const snapshot = weatherSnapshot();
    await store.saveWeatherSnapshot(snapshot);

    await expect(store.saveWeatherSnapshot(snapshot)).rejects.toBeInstanceOf(ImmutableRevisionError);
  });

  it("atomically appends refresh evidence with its immutable weather-refresh child revision", async () => {
    const store = repository();
    const initialSnapshot = weatherSnapshot();
    const initialRevision = planRevision();
    await store.saveWeatherSnapshot(initialSnapshot);
    await store.savePlanRevision(planFamily(), initialRevision);
    const refreshedSnapshot = { ...initialSnapshot, id: "weather-2", retrievedAt: "2027-01-01T00:00:00.000Z" };
    const refreshRevision = {
      ...initialRevision,
      id: "revision-2",
      parentRevisionId: initialRevision.id,
      reason: "weather-refresh" as const,
      createdAt: "2027-01-01T00:00:00.000Z",
      weatherSnapshotIds: [refreshedSnapshot.id],
    };
    const family = { ...planFamily(), latestRevisionId: refreshRevision.id };

    await store.saveWeatherRefreshRevision(family, refreshRevision, [refreshedSnapshot]);
    expect(await store.getPlanRevision(refreshRevision.id)).toEqual(refreshRevision);

    const duplicateRefresh = { ...refreshRevision, id: "revision-3", parentRevisionId: refreshRevision.id };
    await expect(store.saveWeatherRefreshRevision({ ...family, latestRevisionId: duplicateRefresh.id }, duplicateRefresh, [refreshedSnapshot])).rejects.toBeTruthy();
    expect(await store.getPlanRevision(duplicateRefresh.id)).toBeUndefined();
  });
});
