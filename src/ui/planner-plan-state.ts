import type { PilotInputPlan, PilotInputRepository } from "../services/storage/pilot-input-repository";

export type PlannerPlanPhase = "editing" | "saving" | "switching" | "save-failed";
export type PlannerDestination = { readonly kind: "new" } | { readonly kind: "open"; readonly id: string };
export interface PlannerPlanView {
  readonly activeDraft?: PilotInputPlan;
  readonly savedPlans: readonly PilotInputPlan[];
  readonly phase: PlannerPlanPhase;
  readonly status: string;
  readonly acceptedDestination?: PlannerDestination;
  readonly error?: string;
}
export type PlannerCommandResult = { readonly ok: true } | { readonly ok: false; readonly reason: "unavailable" | "failed"; readonly error?: string };
export interface PlannerPlanStateOptions {
  readonly ids: { next(): string };
  readonly clock: { now(): Date };
}

type DestinationRequest = { readonly target: PlannerDestination; readonly createDraft?: () => PilotInputPlan };
const unavailable: PlannerCommandResult = { ok: false, reason: "unavailable" };

/** Owns the editable plan and serializes its persistence and destination reads. */
export class PlannerPlanState {
  private activeDraft?: PilotInputPlan;
  private dirty = false;
  private savedPlans: readonly PilotInputPlan[] = [];
  private phase: PlannerPlanPhase = "editing";
  private accepted?: DestinationRequest;
  private error?: string;
  private operation?: Promise<PlannerCommandResult>;
  private readonly listeners = new Set<(view: PlannerPlanView) => void>();

  public constructor(private readonly repository: PilotInputRepository, private readonly options: PlannerPlanStateOptions) {}

  public get view(): PlannerPlanView {
    return Object.freeze({
      ...(this.activeDraft ? { activeDraft: structuredClone(this.activeDraft) } : {}),
      savedPlans: structuredClone(this.savedPlans), phase: this.phase,
      status: this.phase === "saving" ? "Saving" : this.phase === "switching" ? "Opening" : this.phase === "save-failed" ? "Save failed" : "",
      ...(this.accepted ? { acceptedDestination: { ...this.accepted.target } } : {}),
      ...(this.error ? { error: this.error } : {}),
    });
  }

  public subscribe(listener: (view: PlannerPlanView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view);
    return () => this.listeners.delete(listener);
  }

  public async initialize(): Promise<void> {
    await this.repository.initialize();
    this.savedPlans = structuredClone(await this.repository.listPlans());
    if (this.savedPlans.length > 0) {
      this.activeDraft = structuredClone(this.savedPlans[0]!);
      this.dirty = false;
      this.publish();
      return;
    }
    this.activeDraft = this.blankPlan();
    this.dirty = false;
    this.publish();
  }

  public edit(plan: PilotInputPlan): void {
    if (this.phase !== "editing" && this.phase !== "save-failed") return;
    this.activeDraft = structuredClone(plan);
    this.dirty = true;
    this.publish();
  }

  public save(): Promise<PlannerCommandResult> {
    if (this.phase === "saving") return this.operation ?? Promise.resolve(unavailable);
    if (this.phase !== "editing" || !this.activeDraft) return Promise.resolve(unavailable);
    return this.startSave();
  }

  public requestNew(createDraft: () => PilotInputPlan): Promise<PlannerCommandResult> {
    return this.requestDestination({ target: { kind: "new" }, createDraft });
  }

  public requestOpen(id: string): Promise<PlannerCommandResult> {
    return this.requestDestination({ target: { kind: "open", id } });
  }

  public retry(): Promise<PlannerCommandResult> {
    if (this.phase !== "save-failed" || !this.activeDraft) return Promise.resolve(unavailable);
    this.phase = "editing";
    this.error = undefined;
    this.publish();
    return this.startSave();
  }

  public discardPending(): Promise<PlannerCommandResult> {
    if (this.phase !== "save-failed" || !this.accepted) return Promise.resolve(unavailable);
    const pending = this.accepted;
    this.dirty = false;
    this.phase = "switching";
    this.error = undefined;
    this.publish();
    const operation = this.performDestination(pending);
    this.operation = operation;
    return operation.finally(() => { if (this.operation === operation) this.operation = undefined; });
  }

  private requestDestination(request: DestinationRequest): Promise<PlannerCommandResult> {
    if (this.phase === "saving") {
      if (!this.accepted) {
        this.accepted = request;
        this.publish();
      }
      return this.operation ?? Promise.resolve(unavailable);
    }
    if (this.phase !== "editing") return Promise.resolve(unavailable);
    this.accepted = request;
    this.error = undefined;
    if (this.dirty) return this.startSave();
    this.phase = "switching";
    this.publish();
    const operation = this.performDestination(request);
    this.operation = operation;
    return operation.finally(() => { if (this.operation === operation) this.operation = undefined; });
  }

  private startSave(): Promise<PlannerCommandResult> {
    const snapshot = structuredClone(this.activeDraft!);
    this.phase = "saving";
    this.error = undefined;
    this.publish();
    const operation = this.performSave(snapshot);
    this.operation = operation;
    return operation.finally(() => { if (this.operation === operation) this.operation = undefined; });
  }

  private async performSave(snapshot: PilotInputPlan): Promise<PlannerCommandResult> {
    try {
      await this.repository.saveWorkingCopy(snapshot);
      this.dirty = false;
      const prior = this.savedPlans.find((plan) => plan.id === snapshot.id);
      const savedSnapshot = structuredClone({ ...snapshot, submissions: prior?.submissions ?? snapshot.submissions });
      const index = this.savedPlans.findIndex((plan) => plan.id === snapshot.id);
      this.savedPlans = index < 0
        ? [...this.savedPlans, savedSnapshot]
        : this.savedPlans.map((plan) => plan.id === snapshot.id ? savedSnapshot : plan);
      if (!this.activeDraft || this.activeDraft.id === snapshot.id) this.activeDraft = structuredClone(savedSnapshot);
      const pending = this.accepted;
      if (pending) return await this.performDestination(pending);
      this.phase = "editing";
      this.publish();
      return { ok: true };
    } catch (error) {
      this.phase = "save-failed";
      this.error = message(error);
      this.publish();
      return { ok: false, reason: "failed", error: this.error };
    }
  }

  private async performDestination(request: DestinationRequest): Promise<PlannerCommandResult> {
    this.phase = "switching";
    this.publish();
    try {
      let next: PilotInputPlan | undefined;
      if (request.target.kind === "new") next = request.createDraft?.();
      else next = await this.repository.getPlan(request.target.id);
      if (!next) throw new Error(`Saved plan ${request.target.kind === "open" ? `“${request.target.id}”` : ""} was not found.`);
      this.activeDraft = structuredClone(next);
      this.dirty = false;
      this.accepted = undefined;
      this.error = undefined;
      this.phase = "editing";
      this.publish();
      return { ok: true };
    } catch (error) {
      this.accepted = undefined;
      this.error = message(error);
      this.phase = "editing";
      this.publish();
      return { ok: false, reason: "failed", error: this.error };
    }
  }

  private blankPlan(): PilotInputPlan {
    const now = this.options.clock.now().toISOString();
    return { id: this.options.ids.next(), title: "New study route", rawFields: { "plan-title": "New study route" }, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: now, submissions: [] };
  }

  private publish(): void { const view = this.view; this.listeners.forEach((listener) => listener(view)); }
}

function message(error: unknown): string { return error instanceof Error ? error.message : "Planner operation failed."; }
