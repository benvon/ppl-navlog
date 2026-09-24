import { indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { ImmutableRevisionError } from "../contracts";
import { IndexedDbNavlogRepository } from "../indexed-db-repository";
import { aircraftProfile, planFamily, planRevision, weatherSnapshot } from "./fixtures";

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

describe("IndexedDbNavlogRepository journal", () => {
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

});
