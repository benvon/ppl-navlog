import { indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { IndexedDbPilotInputRepository, MAX_CHECKPOINTS_PER_PLAN } from "../pilot-input-repository";
import type { PilotInputPlan } from "../pilot-input-repository";
import { aircraftProfile, timestamp } from "./fixtures";

let serial = 0;
const repos: IndexedDbPilotInputRepository[] = [];
const names: string[] = [];
const now = () => new Date("2026-09-24T12:00:00.000Z");
function repo(): IndexedDbPilotInputRepository {
  const databaseName = `pilot-input-test-${serial += 1}`;
  names.push(databaseName);
  const result = new IndexedDbPilotInputRepository({ databaseName, indexedDbFactory: indexedDB, now });
  repos.push(result);
  return result;
}
function plan(): PilotInputPlan {
  const profile = aircraftProfile();
  return {
    id: "plan-one", title: "Raw draft", rawFields: { "departure-icao": "1C8", "surface-weather-icao": "KORD", "selected-forecast-period": "", "taxi-fuel": "-", "plan-title": "" },
    selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [{ name: "", coordinateText: "41." }], cruiseAltitudeTexts: ["4500", ""], overrideReasons: { "leg-1-cruise-tas": "pilot choice" },
    updatedAt: timestamp,
  };
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map(async (item) => { const db = await (item as unknown as { database(): Promise<IDBDatabase> }).database(); db.close(); }));
  await Promise.all(names.splice(0).map((name) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  })));
});

describe("input-only pilot repository", () => {
  it("accepts 25 checkpoints and preserves their literal text", async () => {
    const store = repo(); await store.initialize();
    const checkpoints = Array.from({ length: MAX_CHECKPOINTS_PER_PLAN }, (_, index) => ({ name: ` stop ${index} `, coordinateText: `41.${index} ` }));
    const valid = { ...plan(), checkpoints };

    await store.saveWorkingCopy(valid);

    expect((await store.getPlan("plan-one"))?.checkpoints).toEqual(checkpoints);
  });

  it("preserves independent endpoint source text and unrelated raw fields across reload", async () => {
    const store = repo(); await store.initialize();
    const rawFields = {
      ...plan().rawFields,
      "departure-metar-icao": " kord ",
      "destination-taf-icao": "KJ",
      "taxi-fuel": "1.2",
    };

    await store.saveWorkingCopy({ ...plan(), rawFields });
    const reopened = await store.getPlan("plan-one");

    expect(reopened?.rawFields).toEqual(rawFields);
  });

  it("rejects 26 checkpoints without partially writing a working copy or profile", async () => {
    const store = repo(); await store.initialize();
    const invalid = { ...plan(), checkpoints: Array.from({ length: MAX_CHECKPOINTS_PER_PLAN + 1 }, (_, index) => ({ name: `stop-${index}`, coordinateText: "41.0" })) };

    await expect(store.saveWorkingCopy(invalid)).rejects.toThrow("at most 25 checkpoints");
    expect(await store.getPlan("plan-one")).toBeUndefined();
    expect(await store.listPlans()).toEqual([]);
    expect(await store.listProfiles()).toEqual([]);
  });

  it("continues to reject calculated and external weather fields", async () => {
    const store = repo(); await store.initialize();
    const invalid = { ...plan(), calculated: { groundspeed: 100 }, weather: { metar: "KORD" } };

    await expect(store.saveWorkingCopy(invalid as unknown as PilotInputPlan)).rejects.toThrow("contains unsupported fields");
    expect(await store.listPlans()).toEqual([]);
    expect(await store.listProfiles()).toEqual([]);
  });

  it("rejects an over-limit plan when reading from storage", async () => {
    const store = repo(); await store.initialize();
    const db = await (store as unknown as { database(): Promise<IDBDatabase> }).database();
    const tx = db.transaction("pilotInputs", "readwrite");
    tx.objectStore("pilotInputs").put({ ...plan(), checkpoints: Array.from({ length: MAX_CHECKPOINTS_PER_PLAN + 1 }, (_, index) => ({ name: `stop-${index}`, coordinateText: "41.0" })) });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

    await expect(store.getPlan("plan-one")).rejects.toThrow("at most 25 checkpoints");
  });

  it("round trips incomplete literal editor text without creating a submission", async () => {
    const store = repo(); await store.initialize();
    await store.saveWorkingCopy(plan());
    expect(await store.getPlan("plan-one")).toEqual(plan());
    expect(await store.listProfiles()).toEqual([aircraftProfile()]);
  });

  it("removes unsupported profile attachments while preserving the latest saved route inputs", async () => {
    const store = repo(); await store.initialize();
    const db = await (store as unknown as { database(): Promise<IDBDatabase> }).database();
    const unsupported = { ...aircraftProfile(), schemaVersion: 99 };
    const saved = { ...plan(), profileSnapshot: unsupported, selectedProfileId: unsupported.id };
    const idOnly = { ...plan(), id: "plan-id-only", profileSnapshot: undefined, selectedProfileId: unsupported.id };
    const snapshotRecovery = { ...plan(), id: "plan-snapshot", profileSnapshot: aircraftProfile(), selectedProfileId: unsupported.id };
    const tx = db.transaction(["pilotInputs", "aircraftProfiles"], "readwrite");
    tx.objectStore("pilotInputs").put(saved);
    tx.objectStore("pilotInputs").put(idOnly);
    tx.objectStore("pilotInputs").put(snapshotRecovery);
    tx.objectStore("aircraftProfiles").put(unsupported);
    tx.objectStore("aircraftProfiles").put({ ...unsupported, id: 77 });
    tx.objectStore("aircraftProfiles").put({ ...aircraftProfile(), id: "profile-supported" });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

    await store.listPlans();
    expect(await store.listProfiles()).toEqual([{ ...aircraftProfile(), id: "profile-supported" }]);
    const plans = await store.listPlans();
    const cleaned = plans.find(({ id }) => id === saved.id);
    expect(cleaned).toMatchObject({ rawFields: saved.rawFields, checkpoints: saved.checkpoints });
    expect(cleaned).not.toHaveProperty("submissions");
    expect(cleaned).not.toHaveProperty("selectedProfileId");
    expect(cleaned).not.toHaveProperty("profileSnapshot");
    expect(plans.find(({ id }) => id === idOnly.id)).not.toHaveProperty("selectedProfileId");
    expect(plans.find(({ id }) => id === snapshotRecovery.id)).toMatchObject({ selectedProfileId: unsupported.id, profileSnapshot: aircraftProfile() });
    expect(store.consumeUnsupportedProfileNotice()).toBe(true);
  });

  it("does not discard a malformed current profile while loading", async () => {
    const store = repo(); await store.initialize();
    const db = await (store as unknown as { database(): Promise<IDBDatabase> }).database();
    const malformed = { ...aircraftProfile(), compassDeviationTable: [] };
    const tx = db.transaction("aircraftProfiles", "readwrite");
    tx.objectStore("aircraftProfiles").put(malformed);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

    await expect(store.listProfiles()).rejects.toThrow(/compassDeviationTable/u);
    const read = db.transaction("aircraftProfiles", "readonly");
    const retained = await new Promise<unknown>((resolve, reject) => { const request = read.objectStore("aircraftProfiles").get(malformed.id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    expect(retained).toEqual(malformed);
  });

  it("keeps unsupported embedded attachments intact when another current profile is malformed", async () => {
    const store = repo(); await store.initialize();
    const db = await (store as unknown as { database(): Promise<IDBDatabase> }).database();
    const unsupported = { ...aircraftProfile(), schemaVersion: 99 };
    const malformed = { ...aircraftProfile(), id: "malformed-current", compassDeviationTable: [] };
    const saved = { ...plan(), profileSnapshot: unsupported, selectedProfileId: unsupported.id };
    const tx = db.transaction(["pilotInputs", "aircraftProfiles"], "readwrite");
    tx.objectStore("pilotInputs").put(saved);
    tx.objectStore("aircraftProfiles").put(unsupported);
    tx.objectStore("aircraftProfiles").put(malformed);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

    await expect(store.listPlans()).rejects.toThrow(/compassDeviationTable/u);
    const read = db.transaction(["pilotInputs", "aircraftProfiles"], "readonly");
    const [storedPlan, storedUnsupported, storedMalformed] = await Promise.all([
      new Promise<unknown>((resolve, reject) => { const request = read.objectStore("pilotInputs").get(saved.id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }),
      new Promise<unknown>((resolve, reject) => { const request = read.objectStore("aircraftProfiles").get(unsupported.id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }),
      new Promise<unknown>((resolve, reject) => { const request = read.objectStore("aircraftProfiles").get(malformed.id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }),
    ]);
    expect(storedPlan).toEqual(saved);
    expect(storedUnsupported).toEqual(unsupported);
    expect(storedMalformed).toEqual(malformed);
    expect(store.consumeUnsupportedProfileNotice()).toBe(false);
  });

  it("drops persisted historical submissions and preserves the latest current input set", async () => {
    const databaseName = `pilot-input-test-${serial += 1}`;
    names.push(databaseName);
    const store = new IndexedDbPilotInputRepository({ databaseName, indexedDbFactory: indexedDB, now });
    repos.push(store);
    await store.initialize();
    const db = await (store as unknown as { database(): Promise<IDBDatabase> }).database();
    const current = { ...plan(), rawFields: { ...plan().rawFields, "taxi-fuel": "12" } };
    const tx = db.transaction("pilotInputs", "readwrite");
    tx.objectStore("pilotInputs").put({ ...current, submissions: [{ garbage: true }] });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

    db.close();
    const reopenedStore = new IndexedDbPilotInputRepository({ databaseName, indexedDbFactory: indexedDB, now });
    repos.push(reopenedStore);
    const reopened = await reopenedStore.getPlan(current.id);
    expect(reopened).toEqual(current);
    expect(reopened).not.toHaveProperty("submissions");
  });

  it("overwrites legacy history without reading or merging it during a save", async () => {
    const store = repo(); await store.initialize();
    const db = await (store as unknown as { database(): Promise<IDBDatabase> }).database();
    const tx = db.transaction("pilotInputs", "readwrite");
    tx.objectStore("pilotInputs").put({ ...plan(), submissions: [{ arbitrary: "large legacy payload" }] });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });
    const updated = { ...plan(), rawFields: { ...plan().rawFields, "taxi-fuel": "17" } };
    const objectStore = db.transaction("pilotInputs", "readonly").objectStore("pilotInputs");
    const prototype = Object.getPrototypeOf(objectStore) as IDBObjectStore;
    const originalGet = prototype.get;
    Object.defineProperty(prototype, "get", {
      configurable: true,
      value(this: IDBObjectStore, ...args: Parameters<IDBObjectStore["get"]>) {
        if (this.name === "pilotInputs") throw new Error("save must not read the existing plan");
        return originalGet.apply(this, args);
      },
    });
    try {
      await store.saveWorkingCopy(updated);
    } finally {
      Object.defineProperty(prototype, "get", { configurable: true, writable: true, value: originalGet });
    }

    const read = db.transaction("pilotInputs", "readonly");
    const saved = await new Promise<unknown>((resolve, reject) => { const request = read.objectStore("pilotInputs").get(updated.id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    expect(saved).toEqual(updated);
    expect(saved).not.toHaveProperty("submissions");
  });

  it("does not write a plan when its selected profile reference is unavailable", async () => {
    const store = repo(); await store.initialize();
    const invalid = { ...plan(), profileSnapshot: undefined };
    await expect(store.saveWorkingCopy(invalid)).rejects.toThrow("unavailable aircraft profile");
    expect(await store.getPlan("plan-one")).toBeUndefined();
  });

});
