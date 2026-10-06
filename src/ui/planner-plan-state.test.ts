import { describe, expect, it, vi } from "vitest";
import type { PilotInputPlan, PilotInputRepository } from "../services/storage/pilot-input-repository";
import { PlannerPlanState } from "./planner-plan-state";

class MemoryPlans implements PilotInputRepository {
  plans: PilotInputPlan[] = [];
  writes: PilotInputPlan[] = [];
  failWrite = false;
  failList = false;
  failRead = false;
  unsupportedPlanNotice = false;
  readGate?: Promise<void>;
  writeGate?: Promise<void>;
  async initialize(): Promise<void> {}
  async listPlans(): Promise<readonly PilotInputPlan[]> {
    if (this.failList) throw new Error("list failed");
    return this.plans;
  }
  async getPlan(id: string): Promise<PilotInputPlan | undefined> {
    if (this.readGate) await this.readGate;
    if (this.failRead) throw new Error("read failed");
    return this.plans.find((plan) => plan.id === id);
  }
  async saveWorkingCopy(plan: PilotInputPlan): Promise<void> {
    this.writes.push(plan);
    if (this.writeGate) await this.writeGate;
    if (this.failWrite) throw new Error("write failed");
    const index = this.plans.findIndex((item) => item.id === plan.id);
    if (index < 0) this.plans.push(plan);
    else this.plans[index] = plan;
  }
  consumeUnsupportedPlanNotice(): boolean { const value = this.unsupportedPlanNotice; this.unsupportedPlanNotice = false; return value; }
  async saveProfile(): Promise<void> {}
  async listProfiles() { return []; }
}

const makePlan = (id: string, title = id): PilotInputPlan => ({ schemaVersion: 1,
  id, title, rawFields: { "cruise-altitude": "4500", title }, checkpoints: [], cruiseAltitudeTexts: ["4500"],
  overrideReasons: {}, updatedAt: "2026-09-29T00:00:00.000Z",
});

function owner(repository = new MemoryPlans()) {
  let nextId = 0;
  const state = new PlannerPlanState(repository, { ids: { next: () => `new-${++nextId}` }, clock: { now: () => new Date("2026-09-29T00:00:00.000Z") } });
  return { state, repository };
}

describe("PlannerPlanState", () => {
  it("loads saved plans and starts with the first saved plan", async () => {
    const { state, repository } = owner();
    repository.plans = [makePlan("first"), makePlan("second")];
    await state.initialize();
    expect(state.view.activeDraft?.id).toBe("first");
    expect(state.view.savedPlans.map((plan) => plan.id)).toEqual(["first", "second"]);
  });

  it("saves a cloned edited snapshot and refreshes the saved list", async () => {
    const { state, repository } = owner();
    await state.initialize();
    const changed = { ...state.view.activeDraft!, title: "Updated", rawFields: { title: "Updated" } };
    state.edit(changed);
    await state.save();
    expect(repository.writes).toHaveLength(1);
    expect(repository.writes[0]).toEqual(changed);
    expect(repository.writes[0]).not.toBe(changed);
    expect(state.view.savedPlans[0]?.title).toBe("Updated");
    expect(state.view.phase).toBe("editing");
  });

  it("keeps one write in flight and rejects edits while writing", async () => {
    const { state, repository } = owner();
    await state.initialize();
    let release!: () => void;
    repository.writeGate = new Promise<void>((resolve) => { release = resolve; });
    const saving = state.save();
    expect(state.view.phase).toBe("saving");
    state.edit(makePlan("tampered"));
    const repeatedSave = state.save();
    expect(repository.writes).toHaveLength(1);
    expect(state.view.activeDraft?.id).toBe("new-1");
    release();
    await saving;
    await repeatedSave;
  });

  it("accepts only the first destination during a save", async () => {
    const { state, repository } = owner();
    await state.initialize();
    repository.plans.push(makePlan("open-me"));
    let release!: () => void;
    repository.writeGate = new Promise<void>((resolve) => { release = resolve; });
    const saving = state.save();
    state.requestOpen("open-me");
    state.requestNew(() => makePlan("later-new"));
    expect(state.view.acceptedDestination).toEqual({ kind: "open", id: "open-me" });
    release();
    await saving;
    expect(state.view.activeDraft?.id).toBe("open-me");
  });

  it("retains latest draft and destination after write failure, and retry completes them", async () => {
    const { state, repository } = owner();
    await state.initialize();
    repository.plans.push(makePlan("open-me"));
    repository.failWrite = true;
    const latest = { ...state.view.activeDraft!, title: "Latest" };
    state.edit(latest);
    let release!: () => void;
    repository.writeGate = new Promise<void>((resolve) => { release = resolve; });
    const saving = state.save();
    state.requestOpen("open-me");
    release();
    await saving;
    expect(state.view.phase).toBe("save-failed");
    expect(state.view.activeDraft?.title).toBe("Latest");
    expect(state.view.acceptedDestination).toEqual({ kind: "open", id: "open-me" });
    repository.failWrite = false;
    await state.retry();
    expect(state.view.activeDraft?.id).toBe("open-me");
    expect(state.view.phase).toBe("editing");
  });

  it("does not auto retry on edit or blur-like save after failure and rejects discard without a destination", async () => {
    const { state, repository } = owner();
    await state.initialize();
    repository.failWrite = true;
    await state.save();
    const attempts = repository.writes.length;
    state.edit({ ...state.view.activeDraft!, title: "Kept draft" });
    await state.save();
    expect(repository.writes).toHaveLength(attempts);
    const result = await state.discardPending();
    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(state.view.phase).toBe("save-failed");
    expect(state.view.activeDraft?.title).toBe("Kept draft");
    expect(state.view.acceptedDestination).toBeUndefined();
    expect(state.view.error).toBe("write failed");
  });

  it("retries the latest edited draft after a failed save without a destination", async () => {
    const { state, repository } = owner();
    await state.initialize();
    repository.failWrite = true;
    await state.save();
    state.edit({ ...state.view.activeDraft!, title: "Latest draft" });
    repository.failWrite = false;
    await state.retry();
    expect(repository.writes.at(-1)?.title).toBe("Latest draft");
    expect(state.view.savedPlans[0]?.title).toBe("Latest draft");
    expect(state.view.phase).toBe("editing");
  });

  it("retains the active draft when Open is missing or its read fails", async () => {
    const { state, repository } = owner();
    await state.initialize();
    const draft = { ...state.view.activeDraft!, title: "Unsaved" };
    state.edit(draft);
    await state.requestOpen("missing");
    expect(state.view.activeDraft).toEqual(draft);
    expect(state.view.error).toMatch(/missing/i);
    repository.plans.push(makePlan("unreadable"));
    repository.failRead = true;
    await state.requestOpen("unreadable");
    expect(state.view.activeDraft).toEqual(draft);
    expect(state.view.error).toMatch(/read failed/i);
  });

  it("asks to create a new plan when Open discards an unsupported plan", async () => {
    const { state, repository } = owner();
    await state.initialize();
    const draft = state.view.activeDraft;
    repository.unsupportedPlanNotice = true;
    const result = await state.requestOpen("unsupported");
    expect(result.ok).toBe(false);
    expect(state.view.error).toContain("unsupported saved plan was discarded");
    expect(state.view.error).toContain("Create a new plan");
    expect(state.view.activeDraft).toEqual(draft);
  });

  it("ignores a second Open while the first destination read is pending", async () => {
    const { state, repository } = owner();
    repository.plans = [makePlan("a"), makePlan("b")];
    await state.initialize();
    let release!: () => void;
    repository.readGate = new Promise<void>((resolve) => { release = resolve; });
    const opening = state.requestOpen("b");
    state.requestOpen("a");
    expect(state.view.phase).toBe("switching");
    release();
    await opening;
    expect(state.view.activeDraft?.id).toBe("b");
  });

  it("updates the saved list when an existing plan is renamed", async () => {
    const { state, repository } = owner();
    repository.plans = [makePlan("named", "Before")];
    await state.initialize();
    state.edit({ ...state.view.activeDraft!, title: "After" });
    await state.save();
    expect(state.view.savedPlans).toHaveLength(1);
    expect(state.view.savedPlans[0]?.title).toBe("After");
  });

  it("keeps a successful write successful when a later saved-list read fails", async () => {
    const { state, repository } = owner();
    repository.plans = [makePlan("existing", "Before")];
    await state.initialize();
    repository.failList = true;
    state.edit({ ...state.view.activeDraft!, title: "After" });
    const result = await state.save();
    expect(result).toEqual({ ok: true });
    expect(state.view.phase).toBe("editing");
    expect(state.view.savedPlans[0]?.title).toBe("After");
    expect(repository.plans[0]?.title).toBe("After");
  });

  it("saves an edited draft before opening a destination", async () => {
    const { state, repository } = owner();
    repository.plans = [makePlan("current"), makePlan("target")];
    await state.initialize();
    state.edit({ ...state.view.activeDraft!, title: "Preserved edits" });
    await state.requestOpen("target");
    expect(repository.writes).toHaveLength(1);
    expect(repository.plans[0]?.title).toBe("Preserved edits");
    expect(state.view.activeDraft?.id).toBe("target");
  });

  it("discards a failed draft only when resolving its accepted destination", async () => {
    const { state, repository } = owner();
    repository.plans = [makePlan("current"), makePlan("target")];
    await state.initialize();
    repository.failWrite = true;
    state.edit({ ...state.view.activeDraft!, title: "Unsaved edits" });
    const saving = state.save();
    state.requestOpen("target");
    await saving;
    repository.failWrite = false;
    await state.discardPending();
    expect(state.view.activeDraft?.id).toBe("target");
    expect(state.view.phase).toBe("editing");
  });
});


describe("saved-history ownership", () => {
  it("exposes only selector metadata and preserves saved labels until a successful save", async () => {
    const { state, repository } = owner();
    repository.plans = [makePlan("first"), makePlan("second")];
    await state.initialize();
    expect(state.view.savedPlans).toEqual([{ id: "first", title: "first" }, { id: "second", title: "second" }]);
    state.edit({ ...state.view.activeDraft!, title: " Unsaved " });
    expect(state.view.savedPlans[0]?.title).toBe("first");
    repository.failWrite = true;
    await state.save();
    expect(state.view.savedPlans[0]?.title).toBe("first");
    repository.failWrite = false;
    await state.retry();
    expect(state.view.savedPlans[0]?.title).toBe(" Unsaved ");
  });

  it("keeps full saved payloads out of edit reads and subscriber publications", async () => {
    const { state, repository } = owner();
    repository.plans = [makePlan("active"), { ...makePlan("saved"), rawFields: { notes: "private-saved-payload" } }];
    await state.initialize();
    const clone = globalThis.structuredClone;
    const guard = vi.spyOn(globalThis, "structuredClone").mockImplementation((value) => {
      if (JSON.stringify(value).includes("private-saved-payload")) throw new Error("Saved document cloned during editing");
      return clone(value);
    });
    try {
      let publishedTitle: string | undefined;
      const unsubscribe = state.subscribe((view) => { publishedTitle = view.activeDraft?.title; });
      state.edit({ ...state.view.activeDraft!, title: " literal incomplete - " });
      expect(state.view.activeDraft?.title).toBe(" literal incomplete - ");
      expect(publishedTitle).toBe(" literal incomplete - ");
      unsubscribe();
    } finally { guard.mockRestore(); }
  });

  it("prevents callers and subscribers from changing owned drafts or summary metadata", async () => {
    const { state, repository } = owner();
    repository.plans = [makePlan("active"), makePlan("saved")];
    await state.initialize();
    const exposed = state.view;
    (exposed.activeDraft!.rawFields as Record<string, string>).title = "caller changed";
    try { (exposed.savedPlans as { id: string; title: string }[])[1]!.title = "caller changed"; } catch { /* Frozen metadata may reject mutation. */ }
    try { (exposed.savedPlans as { id: string; title: string }[]).pop(); } catch { /* Frozen arrays may reject mutation. */ }
    const unsubscribe = state.subscribe((view) => {
      (view.activeDraft!.checkpoints as { name: string; coordinateText: string }[]).push({ name: "subscriber changed", coordinateText: "" });
      try { (view.savedPlans as { id: string; title: string }[])[0]!.id = "subscriber changed"; } catch { /* Frozen metadata may reject mutation. */ }
    });
    expect(state.view.activeDraft?.rawFields.title).toBe("active");
    expect(state.view.activeDraft?.checkpoints).toEqual([]);
    expect(state.view.savedPlans).toEqual([{ id: "active", title: "active" }, { id: "saved", title: "saved" }]);
    unsubscribe();
    await state.requestOpen("saved");
    expect(state.view.activeDraft?.title).toBe("saved");
  });
});
