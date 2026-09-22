import { indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { ImmutableRevisionError, ImportConflictError } from "../contracts";
import { IndexedDbNavlogRepository } from "../indexed-db-repository";
import { parseNavlogArchive } from "../json-transfer";
import { aircraftProfile, planArchive, planFamily, planRevision, weatherSnapshot } from "./fixtures";

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

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((item) => item.close()));
  await Promise.all(databaseNames.splice(0).map((name) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  })));
});

describe("IndexedDbNavlogRepository journal and archives", () => {
  it("stores defensive profile copies", async () => {
    const store = repository();
    const profile = aircraftProfile();
    await store.saveAircraftProfile(profile);
    const loaded = await store.getAircraftProfile(profile.id);
    expect(loaded).toEqual(profile);
    if (loaded === undefined) throw new Error("Expected profile.");
    const localCopy = { ...loaded, name: "local mutation" };
    expect(localCopy.name).toBe("local mutation");
    expect((await store.getAircraftProfile(profile.id))?.name).toBe(profile.name);
  });

  it("appends only to the current journal head", async () => {
    const store = repository();
    const first = planRevision();
    const family = planFamily();
    await store.saveWeatherSnapshot(weatherSnapshot());
    await store.savePlanRevision(family, first);
    const second = { ...first, id: "revision-2", revisionNumber: 2, parentRevisionId: first.id, reason: "input-change" as const };
    const secondFamily = { ...family, latestRevisionId: second.id, latestRevisionNumber: second.revisionNumber };
    await store.savePlanRevision(secondFamily, second);
    const stale = { ...second, id: "revision-stale", revisionNumber: 2, parentRevisionId: first.id };

    await expect(store.savePlanRevision({ ...family, latestRevisionId: stale.id, latestRevisionNumber: stale.revisionNumber }, stale)).rejects.toBeInstanceOf(ImmutableRevisionError);
    expect((await store.listPlanRevisions(family.id)).map((revision) => revision.id)).toEqual([first.id, second.id]);
  });

  it("retains the latest twenty sequence entries even when every save has the same timestamp", async () => {
    const store = repository();
    const first = planRevision();
    const family = planFamily();
    await store.saveWeatherSnapshot(weatherSnapshot());
    await store.savePlanRevision(family, first);
    let parent = first;
    for (let number = 2; number <= 21; number += 1) {
      const revision = { ...first, id: `revision-${number}`, revisionNumber: number, parentRevisionId: parent.id, reason: "input-change" as const, weatherSnapshotIds: [] };
      await store.savePlanRevision({ ...family, latestRevisionId: revision.id, latestRevisionNumber: number }, revision);
      parent = revision;
    }

    const retained = await store.listPlanRevisions(family.id);
    expect(retained.map((revision) => revision.revisionNumber)).toEqual(Array.from({ length: 20 }, (_, index) => index + 2));
    expect(await store.getPlanRevision(first.id)).toBeUndefined();
    expect(await store.getWeatherSnapshot("weather-1")).toBeUndefined();
  });

  it("exports one self-contained plan archive, not the whole local library", async () => {
    const store = repository();
    const archive = planArchive();
    await store.importArchive(JSON.stringify(archive));
    const anotherProfile = { ...aircraftProfile(), id: "aircraft-2" };
    await store.saveAircraftProfile(anotherProfile);
    const exported = parseNavlogArchive(await store.exportPlanArchive(archive.planFamily.id, archive.exportedAt), now());

    expect(exported.format).toBe("ppl-navlog/plan-archive");
    if (exported.format !== "ppl-navlog/plan-archive") throw new Error("Expected plan archive.");
    expect(exported.planFamily).toEqual(archive.planFamily);
    expect(exported.aircraftProfiles).toEqual(archive.aircraftProfiles);
  });

  it("imports a self-contained plan archive atomically and restores its editable profile", async () => {
    const source = planArchive();
    const store = repository();
    await expect(store.importArchive(JSON.stringify(source))).resolves.toEqual({ aircraftProfiles: 1, planFamilies: 1, planRevisions: 1, weatherSnapshots: 1 });
    expect(await store.getAircraftProfile(source.aircraftProfiles[0]!.id)).toEqual(source.aircraftProfiles[0]);
    expect(await store.getPlanRevision(source.planRevisions[0]!.id)).toEqual(source.planRevisions[0]);
  });

  it("does not write partial data when a merge archive conflicts", async () => {
    const store = repository();
    const archive = planArchive();
    await store.saveAircraftProfile(archive.aircraftProfiles[0]!);

    await expect(store.importArchive(JSON.stringify(archive))).rejects.toBeInstanceOf(ImportConflictError);
    expect(await store.getPlanRevision(archive.planRevisions[0]!.id)).toBeUndefined();
  });

  it("exports and imports a separate profiles archive", async () => {
    const store = repository();
    await store.saveAircraftProfile(aircraftProfile());
    const serialized = await store.exportProfileArchive("2026-09-21T12:00:00.000Z");
    const imported = repository();
    await imported.importArchive(serialized);

    expect(await imported.listAircraftProfiles()).toEqual([aircraftProfile()]);
  });
});
