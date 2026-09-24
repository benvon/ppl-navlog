import { indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { IndexedDbPilotInputRepository, MAX_SUBMISSIONS_PER_PLAN } from "../pilot-input-repository";
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

afterEach(async () => {
  await Promise.all(repos.splice(0).map(async (item) => { const db = await (item as unknown as { database(): Promise<IDBDatabase> }).database(); db.close(); }));
  await Promise.all(names.splice(0).map((name) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  })));
});

describe("input-only pilot repository", () => {
  it("round trips incomplete literal editor text without creating a submission", async () => {
    const store = repo(); await store.initialize();
    await store.saveWorkingCopy(plan());
    expect(await store.getPlan("plan-one")).toEqual(plan());
    expect((await store.listPlans())[0]?.submissions).toEqual([]);
    expect(await store.listProfiles()).toEqual([aircraftProfile()]);
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

});
