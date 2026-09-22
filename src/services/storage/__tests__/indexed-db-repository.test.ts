import { indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { ImmutableRevisionError } from "../contracts";
import { IndexedDbNavlogRepository } from "../indexed-db-repository";
import { parsePlanRecoveryArchive } from "../json-transfer";
import { aircraftProfile, planFamily, planRecoveryArchive, planRevision, weatherSnapshot } from "./fixtures";

const now = () => new Date("2027-01-01T00:00:00.000Z");
let sequence = 0;
const repositories: IndexedDbNavlogRepository[] = [];
const databaseNames: string[] = [];

function repository(): IndexedDbNavlogRepository {
  const databaseName = `ppl-navlog-test-${sequence += 1}`;
  databaseNames.push(databaseName);
  const created = new IndexedDbNavlogRepository({ databaseName, indexedDbFactory: indexedDB, now, nextId: () => `recovered-${sequence += 1}` });
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

describe("IndexedDbNavlogRepository journal and recovery snapshots", () => {
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

  it("exports only the current revision's route and selected aircraft", async () => {
    const store = repository();
    const archive = planRecoveryArchive();
    const source = planRevision();
    await store.saveAircraftProfile(archive.aircraftProfile);
    await store.saveWeatherSnapshot(weatherSnapshot());
    await store.savePlanRevision(planFamily(), source);
    const anotherProfile = { ...aircraftProfile(), id: "aircraft-2" };
    await store.saveAircraftProfile(anotherProfile);
    const exported = parsePlanRecoveryArchive(await store.exportPlanRecoveryArchive(source.planId, archive.exportedAt), now());

    expect(exported).toEqual(archive);
  });

  it("imports a recovery snapshot as a fresh plan and discards stale weather and calculations", async () => {
    const source = planRecoveryArchive();
    const store = repository();
    const result = await store.importPlanRecoveryArchive(JSON.stringify(source));
    const revision = await store.getPlanRevision((await store.listPlanFamilies())[0]!.latestRevisionId!);

    expect(result).toMatchObject({ aircraftProfiles: 1, planFamilies: 1, planRevisions: 1, weatherSnapshots: 0 });
    expect(revision).toMatchObject({ planId: result.recoveredPlanId, revisionNumber: 1, reason: "import", weatherSnapshotIds: [] });
    expect(revision?.calculationSnapshot).toBeUndefined();
    expect(revision?.draftSnapshot.weatherSelection).toBeUndefined();
    expect(revision?.draftSnapshot.selectedAircraftProfileId).not.toBe(source.aircraftProfile.id);
  });
});
