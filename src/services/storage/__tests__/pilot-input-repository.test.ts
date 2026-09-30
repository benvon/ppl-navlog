import { indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { IndexedDbPilotInputRepository, MAX_CHECKPOINTS_PER_PLAN, MAX_SUBMISSIONS_PER_PLAN } from "../pilot-input-repository";
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
    updatedAt: timestamp, submissions: [],
  };
}

function largeFields(length: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`field-${index}`, "x".repeat(length)]));
}

function planWithHistory(submissions: PilotInputPlan["submissions"]): PilotInputPlan {
  return { ...plan(), selectedProfileId: undefined, profileSnapshot: undefined, submissions };
}

function historyRecord(rawFields: Readonly<Record<string, string>>): PilotInputPlan["submissions"][number] {
  return {
    submittedAt: timestamp,
    rawFields,
    inputs: {
      title: "Raw draft", rawFields, checkpoints: [], cruiseAltitudeTexts: [], overrideReasons: {},
    },
  };
}

function historyNearSizeLimit(): PilotInputPlan {
  let fields = largeFields(1_000);
  let submissions = Array.from({ length: 10 }, () => historyRecord(fields));
  while (new TextEncoder().encode(JSON.stringify(planWithHistory(submissions))).byteLength > 1024 * 1024 - 100) {
    const length = Object.values(fields)[0]?.length ?? 0;
    if (length === 0) throw new Error("Could not create a valid near-limit history fixture");
    fields = largeFields(length - 1);
    submissions = Array.from({ length: 10 }, () => historyRecord(fields));
  }
  while (new TextEncoder().encode(JSON.stringify(planWithHistory(submissions))).byteLength < 1024 * 1024 - 100) {
    const length = Object.values(fields)[0]?.length ?? 0;
    fields = largeFields(length + 1);
    submissions = Array.from({ length: 10 }, () => historyRecord(fields));
    if (new TextEncoder().encode(JSON.stringify(planWithHistory(submissions))).byteLength > 1024 * 1024 - 100) {
      fields = largeFields(length);
      submissions = Array.from({ length: 10 }, () => historyRecord(fields));
      break;
    }
  }
  return planWithHistory(submissions);
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

  it("rejects an over-limit plan when reading from storage", async () => {
    const store = repo(); await store.initialize();
    const db = await (store as unknown as { database(): Promise<IDBDatabase> }).database();
    const tx = db.transaction("pilotInputs", "readwrite");
    tx.objectStore("pilotInputs").put({ ...plan(), checkpoints: Array.from({ length: MAX_CHECKPOINTS_PER_PLAN + 1 }, (_, index) => ({ name: `stop-${index}`, coordinateText: "41.0" })) });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

    await expect(store.getPlan("plan-one")).rejects.toThrow("at most 25 checkpoints");
  });

  it("rejects 26 checkpoints in a submission snapshot without changing stored data", async () => {
    const store = repo(); await store.initialize();
    await store.saveWorkingCopy({ ...plan(), selectedProfileId: undefined, profileSnapshot: undefined });
    const snapshot = { ...plan(), selectedProfileId: undefined, profileSnapshot: undefined, checkpoints: Array.from({ length: MAX_CHECKPOINTS_PER_PLAN + 1 }, (_, index) => ({ name: `stop-${index}`, coordinateText: "41.0" })) };
    const invalid = { ...planWithHistory([historyRecord({})]), submissions: [{ submittedAt: timestamp, rawFields: {}, inputs: {
      title: snapshot.title, rawFields: snapshot.rawFields, checkpoints: snapshot.checkpoints, cruiseAltitudeTexts: [], overrideReasons: {},
    } }] };

    await expect(store.saveWorkingCopy(invalid)).rejects.toThrow("at most 25 checkpoints");
    expect(await store.getPlan("plan-one")).toEqual({ ...plan(), selectedProfileId: undefined, profileSnapshot: undefined });
  });

  it("round trips incomplete literal editor text without creating a submission", async () => {
    const store = repo(); await store.initialize();
    await store.saveWorkingCopy(plan());
    expect(await store.getPlan("plan-one")).toEqual(plan());
    expect((await store.listPlans())[0]?.submissions).toEqual([]);
    expect(await store.listProfiles()).toEqual([aircraftProfile()]);
  });

  it("removes unsupported profile attachments while preserving saved route inputs and history", async () => {
    const store = repo(); await store.initialize();
    const db = await (store as unknown as { database(): Promise<IDBDatabase> }).database();
    const unsupported = { ...aircraftProfile(), schemaVersion: 99 };
    const saved = { ...planWithHistory([historyRecord({})]), profileSnapshot: unsupported, selectedProfileId: unsupported.id };
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
    expect(cleaned).toMatchObject({ rawFields: saved.rawFields, checkpoints: saved.checkpoints, submissions: saved.submissions });
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

  it("retains only the latest bounded explicit submissions", async () => {
    const store = repo(); await store.initialize();
    for (let i = 0; i < MAX_SUBMISSIONS_PER_PLAN + 3; i += 1) {
      const p = plan();
      await store.submitInputs({ ...p, rawFields: { ...p.rawFields, "plan-title": `submission-${i}` } });
    }
    const submissions = (await store.getPlan("plan-one"))?.submissions ?? [];
    expect(submissions).toHaveLength(MAX_SUBMISSIONS_PER_PLAN);
    expect(submissions.at(-1)?.rawFields["plan-title"]).toBe("submission-22");
  });

  it("preserves submitted history when a stale working copy is saved", async () => {
    const store = repo(); await store.initialize();
    await store.submitInputs(plan());
    await store.saveWorkingCopy({ ...plan(), rawFields: { ...plan().rawFields, "taxi-fuel": "12" }, submissions: [] });
    expect((await store.getPlan("plan-one"))?.submissions).toHaveLength(1);
    expect((await store.getPlan("plan-one"))?.rawFields["taxi-fuel"]).toBe("12");
  });

  it("does not write a plan when its selected profile reference is unavailable", async () => {
    const store = repo(); await store.initialize();
    const invalid = { ...plan(), profileSnapshot: undefined };
    await expect(store.saveWorkingCopy(invalid)).rejects.toThrow("unavailable aircraft profile");
    expect(await store.getPlan("plan-one")).toBeUndefined();
  });

  it("rejects a submission whose merged history exceeds the document limit without writing it", async () => {
    const store = repo(); await store.initialize();
    const oversizedOnAppend = { ...plan(), rawFields: Object.fromEntries(Array.from({ length: 90 }, (_, index) => [`field-${index}`, "x".repeat(10_000)])), selectedProfileId: undefined, profileSnapshot: undefined };
    await expect(store.submitInputs(oversizedOnAppend)).rejects.toThrow("plan exceeds size limit");
    expect(await store.getPlan("plan-one")).toBeUndefined();
    expect(await store.listPlans()).toEqual([]);
    expect(await store.listProfiles()).toEqual([]);
  });

  it("rejects a working copy when retained submissions would make the stored document unreadable", async () => {
    const store = repo(); await store.initialize();
    const existing = historyNearSizeLimit();
    await store.saveWorkingCopy(existing);
    const oversizedMerged = { ...plan(), title: "x".repeat(10_000), selectedProfileId: undefined, profileSnapshot: undefined, submissions: [] };
    await expect(store.saveWorkingCopy(oversizedMerged)).rejects.toThrow("plan exceeds size limit");
    expect(await store.getPlan("plan-one")).toEqual(existing);
    expect(await store.listPlans()).toEqual([existing]);
  });

});
