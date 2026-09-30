import type { AircraftProfile, AircraftProfileInput } from "../domain/aircraft";
import type { AirportLookup } from "../application/airport-lookup";
import { applyCruiseTasOverride, createAircraftProfile, createPlanDraft, createRouteDefinition, type UseCaseClock, type UseCaseIds } from "../application/plan-use-cases";
import { calculateCompletePlan, type CompletePlanWeather } from "../application/complete-plan";
import { resolveRouteWeather, validateWorksheetPlanningInputs } from "../application/route-weather-sampling";
import { createFullNavlogCalculationEngine } from "../application/full-navlog-engine";
import { coordinate } from "../domain/coordinates";
import { parseCompactCoordinate } from "../domain/coordinate-input";
import { renderCalculatedNavlog } from "./calculated-navlog";
import { renderCalculationInspector, type NavlogInspectionSelection } from "./calculation-inspector";
import type { PlanDraft, PlanRevision } from "../domain/route";
import { WindsClientError, type WindsTransportClient, type MetarTransportClient, type AloftPointTransportClient } from "../services/weather/winds-client";
import { MAX_CHECKPOINTS_PER_PLAN, type PilotInputPlan, type PilotInputRepository } from "../services/storage/pilot-input-repository";
import { localDateTimeToUtcText, utcTextToLocalDateTime } from "./departure-time";
import { PlannerPlanState, type PlannerPlanView } from "./planner-plan-state";

export interface PilotIntentPlannerDependencies {
  readonly repository: PilotInputRepository;
  readonly airportLookup: AirportLookup;
  readonly winds: WindsTransportClient & MetarTransportClient & AloftPointTransportClient;
  readonly ids: UseCaseIds;
  readonly clock: UseCaseClock;
}

const fieldNames = ["plan-title", "departure-time", "fuel-aboard", "taxi-fuel", "reserve-fuel", "departure-icao", "destination-icao", "departure-metar-icao", "cruise-altitude"] as const;
type FieldName = typeof fieldNames[number];
interface PlanControlAvailability {
  readonly edit: boolean;
  readonly destination: boolean;
  readonly save: boolean;
  readonly update: boolean;
  readonly recovery: boolean;
}
const initialFields: Readonly<Record<FieldName, string>> = {
  "plan-title": "New study route", "departure-time": "", "fuel-aboard": "", "taxi-fuel": "0", "reserve-fuel": "0", "cruise-altitude": "4500",
  "departure-icao": "", "destination-icao": "", "departure-metar-icao": "",
};

export function renderPilotIntentPlanner(root: HTMLElement, dependencies: PilotIntentPlannerDependencies): void {
  const app = new PilotIntentPlanner(root, dependencies);
  void app.initialize();
}

class PilotIntentPlanner {
  private activeStage: "aircraft" | "route" | "calculate" | "navlog" = "aircraft";
  private stageOpen: Record<"aircraft" | "route" | "calculate" | "navlog", boolean> = { aircraft: true, route: false, calculate: false, navlog: false };
  private profiles: readonly AircraftProfile[] = [];
  private readonly planState: PlannerPlanState;
  private renderedDraftId?: string;
  private lastPlanPhase: PlannerPlanView["phase"] = "editing";
  private result?: PlanRevision;
  private inspected?: NavlogInspectionSelection;
  private feedback: { readonly kind: "message" | "error"; readonly text: string } = { kind: "message", text: "" };
  private profileDraftDirty = false;
  private readonly openOverrideEditors = new Set<number>();
  private readonly touchedFields = new Set<string>();
  private updating = false;
  private savingProfile = false;
  private readonly status = document.createElement("p");
  private readonly content = document.createElement("div");
  private clockTimer?: number;
  private profileEditorOpen?: boolean;
  private readonly handleSaveChanges = (): void => { void this.saveChanges(); };

  constructor(private readonly root: HTMLElement, private readonly dependencies: PilotIntentPlannerDependencies) {
    this.planState = new PlannerPlanState(dependencies.repository, { ids: dependencies.ids, clock: dependencies.clock });
    this.status.setAttribute("role", "status");
    this.status.className = "planner-feedback";
    this.planState.subscribe((view) => this.onPlanState(view));
  }

  private get current(): PilotInputPlan | undefined { return this.planState.view.activeDraft; }
  private get plans(): readonly PilotInputPlan[] { return this.planState.view.savedPlans; }
  private get fields(): Record<string, string> { return restorePilotFields(this.current?.rawFields ?? {}, this.current?.cruiseAltitudeTexts ?? []); }

  async initialize(): Promise<void> {
    try {
      await this.planState.initialize();
      this.profiles = await this.dependencies.repository.listProfiles();
      const selected = this.profiles.find((profile) => profile.id === this.current?.selectedProfileId);
      this.profileDraftDirty = profileDraftDiffersFromSaved(this.fields, selected);
      this.activateStage(this.current?.selectedProfileId ? "route" : "aircraft");
      this.showGuidance();
      this.render();
    } catch (error) { this.fail(error); this.render(); }
  }

  private onPlanState(view: PlannerPlanView): void {
    const draftId = view.activeDraft?.id;
    const destinationCompleted = this.lastPlanPhase === "switching" && view.phase === "editing";
    const draftChanged = this.renderedDraftId !== undefined && draftId !== this.renderedDraftId;
    if (draftChanged || (destinationCompleted && !view.error)) {
      this.showActiveDraft(view);
      return;
    }
    this.renderedDraftId = draftId;
    this.lastPlanPhase = view.phase;
    if (view.phase === "editing" && view.error) this.feedback = { kind: "error", text: view.error };
    this.renderFeedback(view);
    this.syncPlanControls(view);
  }

  private showActiveDraft(view: PlannerPlanView): void {
    this.openOverrideEditors.clear();
    this.result = undefined; this.inspected = undefined;
    const selected = this.profiles.find((profile) => profile.id === view.activeDraft?.selectedProfileId);
    this.profileDraftDirty = profileDraftDiffersFromSaved(view.activeDraft?.rawFields ?? {}, selected);
    this.touchedFields.clear();
    this.activateStage(view.activeDraft?.selectedProfileId ? "route" : "aircraft");
    this.renderedDraftId = view.activeDraft?.id;
    this.lastPlanPhase = view.phase;
    this.showGuidance();
    this.render();
    this.content.querySelector<HTMLElement>(`[data-stage="${this.activeStage}"] summary`)?.focus();
  }

  private showGuidance(): void {
    this.setStatus(this.current?.title !== "New study route"
      ? "Saved pilot inputs are ready to edit. Save changes stores edits; Update navlog retrieves current weather and calculates."
      : "Enter pilot inputs. Save changes stores the inputs; Update navlog retrieves current weather and calculates.");
  }

  private renderFeedback(view = this.planState.view): void {
    const planMessage = view.error ? [view.status, view.error].filter(Boolean).join(": ") : view.status;
    this.status.replaceChildren(document.createTextNode(view.phase === "editing" ? this.feedback.text : planMessage));
    if (view.phase === "save-failed") {
      const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "Retry save";
      retry.addEventListener("click", () => void this.retrySave()); this.status.append(" ", retry);
      if (view.acceptedDestination) {
        const discard = document.createElement("button"); discard.type = "button"; discard.textContent = "Discard draft and continue";
        discard.addEventListener("click", () => { if (window.confirm("Discard the unsaved pilot inputs and continue to the requested plan?")) void this.planState.discardPending(); });
        this.status.append(" ", discard);
      }
    }
  }

  private syncPlanControls(view = this.planState.view): void {
    const availability = this.planControlAvailability(view);
    this.syncEditorControls(!availability.edit);
    this.syncDestinationControls(view, availability.destination);
    this.syncActionControls(availability);
    this.status.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = !availability.recovery; });
  }

  private planControlAvailability(view: PlannerPlanView): PlanControlAvailability {
    const ready = !this.updating && !this.savingProfile;
    const editing = view.phase === "editing";
    const savingWithoutDestination = view.phase === "saving" && view.acceptedDestination === undefined;
    const editingOrFailed = editing || view.phase === "save-failed";
    const canNavigate = editing || savingWithoutDestination;
    return {
      edit: ready && editingOrFailed,
      destination: ready && canNavigate,
      save: ready && editingOrFailed,
      update: ready && canNavigate && this.localError() === undefined,
      recovery: ready && view.phase === "save-failed",
    };
  }

  private syncEditorControls(lockEditing: boolean): void {
    this.content.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(".route-form input, .route-form select, .route-form textarea, .route-form button, [data-profile-editor] input, [data-profile-editor] select, [data-profile-editor] button, [name='selectedProfileId']").forEach((control) => {
      if (lockEditing) {
        if (control.dataset.plannerPriorDisabled === undefined) control.dataset.plannerPriorDisabled = String(control.disabled);
        control.disabled = true;
      } else if (control.dataset.plannerPriorDisabled !== undefined) {
        control.disabled = control.dataset.plannerPriorDisabled === "true";
        delete control.dataset.plannerPriorDisabled;
      }
    });
  }

  private syncDestinationControls(view: PlannerPlanView, destinationEnabled: boolean): void {
    const selector = this.content.querySelector<HTMLSelectElement>("select[aria-label='Saved plan']");
    if (selector) {
      const selectedId = this.current?.id ?? "";
      this.syncPlanSelector(selector, view.savedPlans, selectedId);
      selector.disabled = !destinationEnabled;
    }
    const create = [...this.content.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "New plan");
    if (create) create.disabled = !destinationEnabled;
  }

  private syncPlanSelector(selector: HTMLSelectElement, savedPlans: readonly PilotInputPlan[], selectedId: string): void {
    const optionsMatch = selector.options.length === savedPlans.length + 1 && savedPlans.every((plan, index) => selector.options[index + 1]?.value === plan.id && selector.options[index + 1]?.textContent === plan.title);
    if (!optionsMatch) {
      selector.replaceChildren(new Option("Choose saved plan", ""));
      savedPlans.forEach((plan) => selector.append(new Option(plan.title, plan.id, false, plan.id === selectedId)));
    }
    if (selector.value !== selectedId) selector.value = selectedId;
  }

  private syncActionControls(availability: PlanControlAvailability): void {
    const save = this.content.querySelector<HTMLButtonElement>("[data-save-changes]");
    if (save) save.disabled = !availability.save;
    const update = this.content.querySelector<HTMLButtonElement>("[data-update-plan]");
    if (update) update.disabled = !availability.update;
  }

  private render(): void {
    const priorProfileEditor = this.content.querySelector<HTMLDetailsElement>("details[data-profile-editor]");
    if (priorProfileEditor) this.profileEditorOpen = priorProfileEditor.open;
    this.content.querySelectorAll<HTMLDetailsElement>("details[data-stage]").forEach((details) => {
      const stage = details.dataset.stage as keyof typeof this.stageOpen;
      if (stage in this.stageOpen) this.stageOpen[stage] = details.open;
    });
    this.content.replaceChildren();
    const shell = document.createElement("section");
    shell.className = "planner-shell";
    const heading = document.createElement("h2"); heading.textContent = "Flight plan";
    shell.append(heading, this.status);
    const plans = document.createElement("section"); plans.className = "plan-picker"; plans.append(this.el("h3", "Saved pilot inputs"));
    const planSelect = document.createElement("select"); planSelect.setAttribute("aria-label", "Saved plan"); planSelect.append(new Option("Choose saved plan", ""));
    this.plans.forEach((plan) => planSelect.append(new Option(plan.title, plan.id, false, plan.id === this.current?.id)));
    planSelect.addEventListener("change", () => { if (planSelect.value) void this.open(planSelect.value); });
    plans.append(planSelect);
    const create = document.createElement("button"); create.type = "button"; create.textContent = "New plan"; create.addEventListener("click", () => this.newPlan()); plans.append(create); shell.append(plans);
    const form = document.createElement("form"); form.className = "route-form"; form.addEventListener("submit", (event) => event.preventDefault());
    const groups: Record<"identity" | "timing" | "fuel" | "weather", HTMLElement> = {
      identity: document.createElement("fieldset"), timing: document.createElement("fieldset"), fuel: document.createElement("fieldset"), weather: document.createElement("fieldset"),
    };
    for (const [key, title] of [["identity", "Route"], ["timing", "Departure time"], ["fuel", "Starting fuel"], ["weather", "Departure weather source"]] as const) {
      const legend = document.createElement("legend"); legend.textContent = title; groups[key].append(legend);
    }
    fieldNames.forEach((name) => {
      if (name === "cruise-altitude") return;
      const labels: Record<FieldName, string> = { "plan-title": "Plan title", "departure-time": "Planned departure UTC", "fuel-aboard": "Fuel aboard before taxi/run-up (gal; pilot input)", "taxi-fuel": "Taxi/run-up fuel (gal)", "reserve-fuel": "Reserve fuel (gal)", "departure-icao": "Departure airport code (FAA LID or ICAO)", "destination-icao": "Destination airport code (FAA LID or ICAO)", "departure-metar-icao": "Departure METAR ICAO alternate (blank uses airport ICAO)", "cruise-altitude": "Cruise altitude (feet MSL)" };
      const group = routeFieldGroup(name, groups);
      group.append(this.input(name, labels[name], this.fields[name] ?? ""));
    });
    this.appendDepartureTimeControls(groups.timing);
    const profileLabel = document.createElement("label"); profileLabel.append("Aircraft profile ");
    const profile = document.createElement("select"); profile.name = "selectedProfileId"; profile.append(new Option("Choose profile", ""));
    this.profiles.forEach((p) => profile.append(new Option(p.name, p.id, false, p.id === this.current?.selectedProfileId)));
    profile.addEventListener("change", () => {
      this.openOverrideEditors.clear();
      const selected = this.profiles.find((candidate) => candidate.id === profile.value);
      this.activateStage(selected ? "route" : "aircraft");
      if (this.current) {
        const next = {
          ...this.current,
          selectedProfileId: profile.value || undefined,
          ...(selected ? { profileSnapshot: selected } : {}),
        };
        if (!selected) delete next.profileSnapshot;
        this.editDraft(next);
      }
      this.profileDraftDirty = profileDraftDiffersFromSaved(this.fields, selected);
      this.invalidate();
      this.refreshUpdateGate();
      void this.persist();
      this.render();
    });
    profileLabel.append(profile);
    form.append(groups.identity, groups.timing, this.renderRouteCollections(), groups.fuel, groups.weather);
    form.querySelectorAll<HTMLInputElement>("input[type='text']").forEach((input) => {
      input.addEventListener("input", () => { if (this.result) this.activateStage("route"); this.touchedFields.add(input.name); this.setField(input.name, input.value); this.captureStructured(form); this.invalidate(); this.refreshUpdateGate(); });
      input.addEventListener("blur", () => { this.touchedFields.add(input.name); this.captureStructured(form); this.refreshUpdateGate(); void this.persist(); });
    });
    const update = document.createElement("button"); update.type = "button"; update.dataset.updatePlan = "true"; update.textContent = "Update navlog"; update.addEventListener("click", () => void this.update());
    const feedback = document.createElement("p"); feedback.dataset.localError = "true"; feedback.setAttribute("aria-live", "polite"); feedback.textContent = this.localError() ? `Unavailable: ${this.localError()}` : "";
    const aircraftStage = this.stage("aircraft", `Aircraft · ${this.profiles.find((p) => p.id === this.current?.selectedProfileId)?.name ?? "Select a profile"}`, profileLabel, this.renderProfileEditor());
    const routeStage = this.stage("route", "Route information", form);
    const saveChanges = document.createElement("button"); saveChanges.type = "button"; saveChanges.dataset.saveChanges = "true"; saveChanges.textContent = "Save changes"; saveChanges.addEventListener("click", this.handleSaveChanges);
    routeStage.append(saveChanges);
    const continueButton = document.createElement("button"); continueButton.type = "button"; continueButton.textContent = "Continue to Calculate";
    continueButton.addEventListener("click", () => { this.activateStage("calculate"); this.content.querySelector<HTMLElement>('[data-stage="calculate"] summary')?.focus(); });
    routeStage.append(continueButton);
    const calculateStage = this.stage("calculate", "Calculate", update, feedback);
    const navlogStage = this.stage("navlog", "Calculated navlog");
    navlogStage.append(this.renderCurrentResult());
    shell.append(aircraftStage, routeStage, calculateStage, navlogStage);
    this.content.append(shell);
    this.refreshUpdateGate();
    if (this.root.firstChild === null) this.root.append(this.content); else if (!this.root.contains(this.content)) this.root.replaceChildren(this.content);
    this.startClock();
  }

  private appendDepartureTimeControls(group: HTMLElement): void {
    const utcInput = group.querySelector<HTMLInputElement>('[name="departure-time"]')!;
    const hint = document.createElement("p"); hint.dataset.utcFormat = "true"; hint.id = "departure-utc-format";
    hint.textContent = "UTC format: YYYY-MM-DDTHH:mm (24-hour), for example 2026-09-26T18:30.";
    utcInput.setAttribute("aria-describedby", `departure-time-error ${hint.id}`);
    const localLabel = document.createElement("label"); localLabel.textContent = "Choose local departure date and time ";
    const picker = document.createElement("input"); picker.type = "datetime-local"; picker.name = "departure-local";
    picker.value = utcTextToLocalDateTime(this.fields["departure-time"] ?? "") ?? "";
    const localError = document.createElement("span"); localError.className = "field-error"; localError.setAttribute("aria-live", "polite");
    picker.addEventListener("change", () => {
      const converted = localDateTimeToUtcText(picker.value);
      localError.textContent = converted.ok ? "" : converted.reason;
      if (!converted.ok) return;
      utcInput.value = converted.utcText;
      utcInput.dispatchEvent(new Event("input", { bubbles: true }));
      utcInput.dispatchEvent(new Event("blur", { bubbles: true }));
    });
    utcInput.addEventListener("input", () => { picker.value = utcTextToLocalDateTime(utcInput.value) ?? ""; localError.textContent = ""; });
    localLabel.append(picker, localError);
    const clock = document.createElement("div"); clock.dataset.currentClock = "true"; clock.className = "current-clock";
    const useCurrentUtc = document.createElement("button");
    useCurrentUtc.type = "button";
    useCurrentUtc.dataset.useCurrentUtc = "true";
    useCurrentUtc.textContent = "Use current UTC";
    useCurrentUtc.addEventListener("click", () => {
      if (!this.shouldOfferCurrentUtc()) return;
      utcInput.value = this.dependencies.clock.now().toISOString().slice(0, 16);
      utcInput.dispatchEvent(new Event("input", { bubbles: true }));
      utcInput.dispatchEvent(new Event("blur", { bubbles: true }));
    });
    useCurrentUtc.hidden = !this.shouldOfferCurrentUtc();
    group.append(hint, localLabel, useCurrentUtc, clock);
    this.updateClock(clock);
  }

  private updateClock(clock: HTMLElement): void {
    const now = new Date();
    const offsetMinutes = -now.getTimezoneOffset();
    const offset = `${offsetMinutes < 0 ? "−" : "+"}${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0")}:${String(Math.abs(offsetMinutes) % 60).padStart(2, "0")}`;
    const local = utcTextToLocalDateTime(now.toISOString().slice(0, 16))?.replace("T", " ") ?? "—";
    const seconds = `:${String(now.getUTCSeconds()).padStart(2, "0")}`;
    clock.replaceChildren(this.clockLine(`Local UTC${offset}: ${local}${seconds}`), this.clockLine(`UTC: ${now.toISOString().slice(0, 16).replace("T", " ")}${seconds}`));
  }

  private clockLine(value: string): HTMLElement { const line = document.createElement("div"); line.textContent = value; return line; }

  private startClock(): void {
    if (this.clockTimer !== undefined || !this.root.isConnected) return;
    this.clockTimer = window.setInterval(() => {
      if (!this.root.isConnected) { window.clearInterval(this.clockTimer); this.clockTimer = undefined; return; }
      const clock = this.content.querySelector<HTMLElement>("[data-current-clock]");
      if (clock) this.updateClock(clock);
      this.refreshCurrentUtcControl();
    }, 1000);
  }

  private stage(name: keyof typeof this.stageOpen, label: string, ...contents: HTMLElement[]): HTMLDetailsElement {
    const section = document.createElement("details"); section.dataset.stage = name; section.dataset.active = String(this.activeStage === name); section.open = this.stageOpen[name];
    const summary = document.createElement("summary"); summary.textContent = label; summary.tabIndex = 0; section.append(summary, ...contents);
    return section;
  }

  private renderCurrentResult(): Node {
    if (this.result === undefined) return document.createTextNode("Update navlog to retrieve current weather and display a calculated navlog.");
    const output = document.createElement("section"); output.dataset.currentResult = "true";
    const navlog = renderCalculatedNavlog(this.result, { currentWeatherValidated: true, selected: this.inspected, onInspect: (selection) => { this.inspected = selection; this.render(); } });
    if (navlog) output.append(navlog, renderCalculationInspector(this.result, this.inspected));
    return output;
  }

  private activateStage(name: keyof typeof this.stageOpen): void {
    this.activeStage = name;
    for (const stage of Object.keys(this.stageOpen) as (keyof typeof this.stageOpen)[]) this.stageOpen[stage] = stage === name;
    this.content.querySelectorAll<HTMLDetailsElement>("details[data-stage]").forEach((details) => { details.open = details.dataset.stage === name; });
  }

  private input(name: string, labelText: string, value: string): HTMLLabelElement {
    const label = document.createElement("label"); label.append(document.createTextNode(`${labelText} `));
    const input = document.createElement("input"); input.type = "text"; input.name = name; input.value = value;
    const error = document.createElement("span"); error.id = `${name}-error`; error.className = "field-error"; input.setAttribute("aria-describedby", error.id);
    label.append(input, error); return label;
  }
  private renderRouteCollections(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "route-waypoints";
    const checkpoints = this.current?.checkpoints ?? [];
    const route = document.createElement("section");
    route.className = "waypoint-list";
    route.append(this.el("h3", "Route checkpoints"));
    route.append(this.input("cruise-altitude", "Cruise altitude (feet MSL)", this.fields["cruise-altitude"] ?? ""));
    const departureDestination = checkpoints.length > 0 ? "Checkpoint 1" : "Destination";
    route.append(this.renderWaypointGroup("departure", "Departure", departureDestination, 0));
    checkpoints.forEach((point, index) => {
      const destination = index + 1 < checkpoints.length ? `Checkpoint ${index + 2}` : "Destination";
      route.append(this.renderWaypointGroup(`checkpoint-${index}`, `Checkpoint ${index + 1}`, destination, index + 1, index, point));
    });
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Add checkpoint";
    add.disabled = (this.current?.checkpoints.length ?? 0) >= MAX_CHECKPOINTS_PER_PLAN;
    add.addEventListener("click", () => {
      if ((this.current?.checkpoints.length ?? 0) >= MAX_CHECKPOINTS_PER_PLAN) return;
      const hadOverrides = this.clearRouteOverrides();
      const current = this.current ?? this.blankPlan();
      this.editDraft(this.withIdentity({
        ...current,
        checkpoints: [...current.checkpoints, { name: "", coordinateText: "" }],
        overrideReasons: {},
      }));
      this.invalidate();
      this.render();
      void this.persist().then(() => {
        if (hadOverrides) this.setStatus("Route changed; existing TAS overrides and reasons were cleared.");
      });
    });
    route.append(add);
    wrapper.append(route);
    return wrapper;
  }
  private renderWaypointGroup(
    groupId: string,
    sourceLabel: string,
    destinationLabel: string,
    legIndex: number,
    checkpointIndex?: number,
    checkpoint?: PilotInputPlan["checkpoints"][number],
  ): HTMLFieldSetElement {
    const group = document.createElement("fieldset");
    group.className = "waypoint-group";
    group.dataset.waypointGroup = groupId;
    const legend = document.createElement("legend");
    legend.textContent = `${sourceLabel} — outbound to ${destinationLabel}`;
    group.append(legend);
    if (checkpoint !== undefined && checkpointIndex !== undefined) this.appendCheckpointEditor(group, checkpoint, checkpointIndex);
    this.appendTasControls(group, legIndex);
    return group;
  }
  private appendCheckpointEditor(group: HTMLFieldSetElement, checkpoint: PilotInputPlan["checkpoints"][number], index: number): void {
    group.append(
      this.input(`checkpoint-name-${index}`, `Checkpoint ${index + 1} name`, checkpoint.name),
      this.input(`checkpoint-coordinate-${index}`, "SkyVector or decimal latitude, longitude", checkpoint.coordinateText),
    );
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = `Remove checkpoint ${index + 1}`;
    remove.addEventListener("click", () => this.removeCheckpoint(index));
    group.append(remove);
  }
  private removeCheckpoint(index: number): void {
    const hadOverrides = this.clearRouteOverrides();
    const current = this.current;
    if (!current) return;
    const nextCheckpoints = [...current.checkpoints];
    nextCheckpoints.splice(index, 1);
    this.editDraft(this.withIdentity({ ...current, checkpoints: nextCheckpoints, overrideReasons: {} }));
    this.invalidate();
    this.render();
    void this.persist().then(() => {
      if (hadOverrides) this.setStatus("Route changed; existing TAS overrides and reasons were cleared.");
    });
  }
  private appendTasControls(group: HTMLFieldSetElement, legIndex: number): void {
    const override = this.fields[`override-tas-${legIndex}`]?.trim() ?? "";
    const selected = this.profiles.find((profile) => profile.id === this.current?.selectedProfileId);
    const summary = document.createElement("p");
    summary.textContent = override ? `Overridden TAS: ${override} kt; aircraft default: ${selected?.cruiseTasKnots ?? "—"} kt.` : `Aircraft default TAS: ${selected?.cruiseTasKnots ?? "—"} kt.`;
    group.append(summary);
    if (override || this.openOverrideEditors.has(legIndex)) {
      group.append(this.input(`override-tas-${legIndex}`, `Leg ${legIndex + 1} TAS override (kt, optional)`, override), this.input(`override-reason-${legIndex}`, `Leg ${legIndex + 1} override reason`, this.current?.overrideReasons[`tas-${legIndex}`] ?? ""));
      const restore = document.createElement("button"); restore.type = "button"; restore.textContent = `Restore aircraft default for leg ${legIndex + 1}`;
      restore.addEventListener("click", () => {
        const fields = this.fields; delete fields[`override-tas-${legIndex}`]; delete fields[`override-reason-${legIndex}`];
        if (this.current) { const reasons = { ...this.current.overrideReasons }; delete reasons[`tas-${legIndex}`]; this.editDraft({ ...this.current, rawFields: fields, overrideReasons: reasons }); }
        this.openOverrideEditors.delete(legIndex); this.invalidate(); this.render(); void this.persist();
      });
      group.append(restore);
    } else {
      const reveal = document.createElement("button"); reveal.type = "button"; reveal.textContent = `Override TAS for leg ${legIndex + 1}`;
      reveal.addEventListener("click", () => { this.openOverrideEditors.add(legIndex); this.render(); });
      group.append(reveal);
    }
  }
  private renderProfileEditor(): HTMLElement {
    const section = document.createElement("details"); section.dataset.profileEditor = "true"; section.open = this.profileEditorOpen ?? this.profiles.length === 0;
    const summary = document.createElement("summary"); summary.textContent = "Create aircraft profile"; section.append(summary);
    const form = document.createElement("form"); form.className = "profile-form"; form.addEventListener("submit", (event) => { event.preventDefault(); void this.saveProfile(form); });
    const values: readonly [string, string][] = [["profile-name", "Profile name"], ["cruiseTasKnots", "Cruise TAS (kt)"], ["cruiseFuelFlowGallonsPerHour", "Cruise fuel flow (gal/hr)"], ["climbRateFeetPerMinute", "Climb rate (ft/min)"], ["climbTasKnots", "Climb TAS (kt)"], ["climbFuelFlowGallonsPerHour", "Climb fuel flow (gal/hr)"], ["descentRateFeetPerMinute", "Descent rate (ft/min)"], ["descentTasKnots", "Descent TAS (kt)"], ["descentFuelFlowGallonsPerHour", "Descent fuel flow (gal/hr)"], ["usableFuelGallons", "Usable fuel (gal, optional)"], ["compass-deviation-card", "Compass deviation entries (e.g. 000:+1, 090:-1)"]];
    values.forEach(([id, label]) => form.append(this.input(id, label, this.fields[`profile-${id}`] ?? "")));
    form.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
      input.addEventListener("input", () => { if (this.result) this.activateStage("aircraft"); this.setField(`profile-${input.name}`, input.value); this.profileDraftDirty = true; this.invalidate(); this.refreshUpdateGate(); });
      input.addEventListener("blur", () => { this.setField(`profile-${input.name}`, input.value); void this.persist(); });
    });
    const save = document.createElement("button"); save.type = "submit"; save.textContent = "Save aircraft profile"; form.append(save); section.append(form); return section;
  }
  private async saveProfile(form: HTMLFormElement): Promise<void> {
    try {
      const card = form.querySelector<HTMLInputElement>("[name='compass-deviation-card']")?.value ?? "";
      const compassDeviationTable = card
        .split(",")
        .filter((entry) => entry.trim() !== "")
        .map((entry) => {
          const match = /^\s*(\d{1,3})\s*:\s*([+-]?\d+(?:\.\d+)?)\s*$/.exec(entry);
          if (!match) throw new Error("Compass deviation must use entries such as 000:+1, 090:-1.");
          return {
            magneticHeadingDegrees: Number(match[1]),
            deviationDegrees: Number(match[2]),
          };
        });
      if (compassDeviationTable.length === 0) throw new Error("Enter at least one compass deviation card point.");
      const positiveNumber = (key: string): number => {
        const raw = form.querySelector<HTMLInputElement>(`[name='${key}']`)?.value ?? "";
        const value = Number(raw);
        if (raw.trim() === "" || !Number.isFinite(value) || value <= 0) {
          throw new Error(`${key} must be a positive number.`);
        }
        return value;
      };
      const name = form.querySelector<HTMLInputElement>("[name='profile-name']")?.value.trim() ?? "";
      if (!name) throw new Error("Enter a profile name.");
      const usableFuel = form.querySelector<HTMLInputElement>("[name='usableFuelGallons']")?.value.trim();
      const input: AircraftProfileInput = {
        name,
        cruiseTasKnots: positiveNumber("cruiseTasKnots"),
        cruiseFuelFlowGallonsPerHour: positiveNumber("cruiseFuelFlowGallonsPerHour"),
        climbRateFeetPerMinute: positiveNumber("climbRateFeetPerMinute"),
        climbTasKnots: positiveNumber("climbTasKnots"),
        climbFuelFlowGallonsPerHour: positiveNumber("climbFuelFlowGallonsPerHour"),
        descentRateFeetPerMinute: positiveNumber("descentRateFeetPerMinute"),
        descentTasKnots: positiveNumber("descentTasKnots"),
        descentFuelFlowGallonsPerHour: positiveNumber("descentFuelFlowGallonsPerHour"),
        ...(usableFuel ? { usableFuelGallons: positiveNumber("usableFuelGallons") } : {}),
        compassDeviationTable,
      };
      const saved = createAircraftProfile(input, this.dependencies.ids, this.dependencies.clock);
      this.savingProfile = true;
      this.render();
      await this.dependencies.repository.saveProfile(saved);
      this.profiles = [...this.profiles, saved];
      if (this.current) this.editDraft({ ...this.current, selectedProfileId: saved.id, profileSnapshot: saved });
      this.invalidate();
      this.profileDraftDirty = false;
      this.profileEditorOpen = false;
      const profileEditor = this.content.querySelector<HTMLDetailsElement>("details[data-profile-editor]");
      if (profileEditor) profileEditor.open = false;
      await this.persist();
      this.setStatus(`Aircraft profile ${saved.name} saved.`);
      this.savingProfile = false;
      this.activateStage("route");
      this.render();
    } catch (error) {
      this.savingProfile = false;
      this.fail(error);
      this.render();
    }
  }
  private el(tag: "h3", value: string): HTMLElement { const e = document.createElement(tag); e.textContent = value; return e; }
  private blankPlan(): PilotInputPlan { const now = this.dependencies.clock.now().toISOString(); return { id: this.dependencies.ids.next(), title: "New study route", rawFields: { ...initialFields }, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: now, submissions: [] }; }
  private withIdentity(plan: PilotInputPlan): PilotInputPlan { return { ...plan, id: plan.id || this.dependencies.ids.next(), rawFields: { ...plan.rawFields }, title: plan.rawFields["plan-title"] ?? plan.title, updatedAt: this.dependencies.clock.now().toISOString() }; }
  private editDraft(plan: PilotInputPlan): void { this.planState.edit(plan); }
  private setField(name: string, value: string): void {
    const current = this.current;
    if (!current) return;
    this.planState.edit({ ...current, rawFields: { ...current.rawFields, [name]: value }, title: name === "plan-title" ? value : current.title, updatedAt: this.dependencies.clock.now().toISOString() });
  }
  private newPlan(): void {
    if (this.updating || this.savingProfile) return;
    const selectedProfile = this.profiles.find((profile) => profile.id === this.current?.selectedProfileId);
    void this.planState.requestNew(() => ({ ...this.blankPlan(), ...(selectedProfile ? { selectedProfileId: selectedProfile.id, profileSnapshot: selectedProfile } : {}) }));
  }

  private async open(planId: string): Promise<void> { if (this.updating || this.savingProfile) return; await this.planState.requestOpen(planId); }
  private captureStructured(form: HTMLFormElement): void {
    const get = (selector: string) => form.querySelector<HTMLInputElement>(`[name="${selector}"]`)?.value ?? "";
    const checkpoints = (this.current?.checkpoints ?? []).map((_point, i) => ({ name: get(`checkpoint-name-${i}`), coordinateText: get(`checkpoint-coordinate-${i}`) }));
    const cruiseAltitude = get("cruise-altitude");
    const overrideReasons = Object.fromEntries([...form.querySelectorAll<HTMLInputElement>("input[name^='override-reason-']")].map((x) => [`tas-${x.name.slice("override-reason-".length)}`, x.value]));
    const fields = this.fields;
    [...form.querySelectorAll<HTMLInputElement>("input[name^='override-tas-']")].forEach((x) => { fields[x.name] = x.value; });
    this.editDraft(this.withIdentity({ ...(this.current ?? this.blankPlan()), rawFields: { ...fields, ...Object.fromEntries(fieldNames.map((name) => [name, name === "cruise-altitude" ? cruiseAltitude : get(name)])) }, checkpoints, overrideReasons }));
  }
  private invalidate(): void {
    this.result = undefined;
    this.inspected = undefined;
    this.setStatus("Inputs changed. Save changes or Update navlog to use the current inputs.");
    const output = this.content.querySelector("[data-current-result]");
    output?.replaceWith(document.createTextNode("Update navlog to retrieve current weather and display a calculated navlog."));
  }
  private clearRouteOverrides(): boolean {
    const hadOverrides = Object.entries(this.fields).some(([key, value]) =>
      /^override-(?:tas|reason)-\d+$/.test(key) && value.trim() !== "",
    ) || Object.values(this.current?.overrideReasons ?? {}).some((reason) => reason.trim() !== "");
    this.openOverrideEditors.clear();
    const fields = Object.fromEntries(Object.entries(this.fields).filter(([key]) => !/^override-(?:tas|reason)-\d+$/.test(key)));
    if (this.current) this.editDraft({ ...this.current, rawFields: fields, overrideReasons: {} });
    return hadOverrides;
  }
  private async saveChanges(): Promise<void> {
    const form = this.content.querySelector("form.route-form");
    if (form instanceof HTMLFormElement) this.captureStructured(form);
    const result = this.planState.view.phase === "save-failed" ? await this.planState.retry() : await this.planState.save();
    if (result.ok) { this.refreshUpdateGate(); this.setStatus("Changes saved."); }
    else if (result.reason === "failed") this.refreshUpdateGate();
  }
  private async retrySave(): Promise<void> {
    const result = await this.planState.retry();
    if (result.ok) this.setStatus("Pilot inputs saved.");
  }
  private async persist(successMessage = "Pilot inputs saved."): Promise<void> {
    if (!this.current) return;
    // Browser events in the same turn (including blur followed immediately by
    // New/Open) contribute to the same owner snapshot before the write starts.
    await Promise.resolve();
    if (this.planState.view.phase !== "editing") return;
    const result = await this.planState.save();
    if (result.ok) { this.refreshUpdateGate(); this.setStatus(successMessage); }
    else if (result.reason === "failed") this.refreshUpdateGate();
  }
  private localError(): string | undefined {
    return validateLocalInputs(this.fields, this.current, this.profiles, this.profileDraftDirty);
  }

  private async update(): Promise<void> {
    if (this.updating) return;
    const form = this.content.querySelector("form.route-form");
    if (form instanceof HTMLFormElement) this.captureStructured(form);
    this.result = undefined;
    this.inspected = undefined;
    this.updating = true;
    this.render();
    try {
      if (!this.current) throw new Error("Open a plan before updating it.");
      if (this.planState.view.phase === "save-failed") throw new Error(this.planState.view.error ?? "Save the current pilot inputs before updating the navlog.");
      const saveResult = await this.planState.save();
      if (!saveResult.ok) throw new Error(saveResult.error ?? "Pilot inputs could not be saved; update stopped.");
      const invalid = this.localError();
      if (invalid) throw new Error(invalid);
      this.setStatus("Updating navlog…");
      const current = this.current;
      const selectedProfile = this.profiles.find((profile) => profile.id === current.selectedProfileId);
      this.editDraft({ ...current, profileSnapshot: selectedProfile });
      await this.dependencies.repository.submitInputs(this.current!);
      const { draft, profile } = await this.prepareDraft();
      this.result = await this.calculateDraft(draft, profile);
      this.inspected = undefined;
      this.setStatus("Plan updated with current route weather.");
      this.activateStage("navlog");
    } catch (error) {
      this.fail(error);
      this.activateStage("calculate");
    } finally {
      this.updating = false;
      this.render();
      this.content.querySelector<HTMLElement>(`[data-stage="${this.feedback.kind === "error" ? "calculate" : "navlog"}"] summary`)?.focus();
    }
  }
  private async prepareDraft(): Promise<{ readonly draft: PlanDraft; readonly profile: AircraftProfile }> {
    const raw = this.fields;
    const current = this.current;
    if (!current) throw new Error("Open a plan before preparing an update.");
    const profile = this.profiles.find((candidate) => candidate.id === current.selectedProfileId);
    if (!profile) throw new Error("Selected aircraft profile is unavailable.");
    const departureCode = raw["departure-icao"];
    const destinationCode = raw["destination-icao"];
    if (!departureCode || !destinationCode) throw new Error("Enter both departure and destination airport codes.");
    const [departure, destination] = await Promise.all([
      this.dependencies.airportLookup.lookupAirportCode(departureCode.trim().toUpperCase()),
      this.dependencies.airportLookup.lookupAirportCode(destinationCode.trim().toUpperCase()),
    ]);
    const checkpoints = this.buildCheckpoints(current);
    const departureText = raw["departure-time"];
    if (!departureText) throw new Error("Enter a planned departure time in UTC.");
    const departureTimeUtc = localUtcTextToIso(departureText);
    const route = createRouteDefinition({
      departure,
      checkpoints,
      destination,
      cruiseAltitudesFeetMsl: Array(current.checkpoints.length + 1).fill(Number(raw["cruise-altitude"])),
    }, this.dependencies.ids);
    const weatherSelection = weatherSelectionFromInputs(raw, departure.icao);
    const draft = createPlanDraft({
      title: raw["plan-title"] ?? "",
      departureTimeUtc,
      route,
      selectedAircraftProfileId: profile.id,
      fuelAboardGallons: Number(raw["fuel-aboard"]),
      taxiRunupFuelGallons: Number(raw["taxi-fuel"]),
      reserveFuelGallons: Number(raw["reserve-fuel"]),
      descentTargetAltitudeFeetMsl: destination.elevationFeetMsl,
      descentTargetSource: "destination-field-elevation",
      weatherSelection,
    }, this.dependencies.ids, this.dependencies.clock);
    return { draft: this.applyOverrides(draft, profile, route, current), profile };
  }

  private buildCheckpoints(current: PilotInputPlan) {
    return current.checkpoints.map((point, index) => {
      const parsed = parsePlannerCoordinateText(point.coordinateText);
      if (!parsed.ok) throw new Error(`Checkpoint ${index + 1}: ${parsed.error.message}`);
      return {
        kind: "checkpoint" as const,
        id: this.dependencies.ids.next(),
        name: point.name,
        coordinate: parsed.value,
      };
    });
  }

  private applyOverrides(
    initialDraft: PlanDraft,
    profile: AircraftProfile,
    route: PlanDraft["route"],
    current: PilotInputPlan,
  ): PlanDraft {
    let draft = initialDraft;
    for (const [index, leg] of route.legs.entries()) {
      const override = this.fields[`override-tas-${index}`]?.trim();
      if (!override) continue;
      draft = applyCruiseTasOverride(
        draft,
        profile,
        leg.id,
        Number(override),
        current.overrideReasons[`tas-${index}`] ?? "",
        this.dependencies.clock,
      );
    }
    return draft;
  }
  private async fetchEndpointWeather(draft: PlanDraft) {
    const departure = draft.route.points[0];
    if (departure?.kind !== "airport") throw new Error("Route weather requires an airport departure endpoint.");
    const departureMetar = await fetchRequiredMetar(this.dependencies.winds, departure.icao, draft.weatherSelection?.departureMetarIcao);
    return { departureMetar };
  }
  private async calculateDraft(draft: PlanDraft, profile: AircraftProfile): Promise<PlanRevision> {
    validateWorksheetPlanningInputs(draft, profile);
    const { departureMetar } = await this.fetchEndpointWeather(draft);
    const solution = await resolveRouteWeather(draft, profile, {
      fetchPoint: (query) => this.dependencies.winds.fetchPoint(query),
    }, { departureMetar });
    const calc = await calculateCompletePlan(draft, profile, {
      weather: { resolve: async (): Promise<CompletePlanWeather> => solution.weather },
      calculations: createFullNavlogCalculationEngine(),
    });
    if (calc.status === "blocked") throw new Error(calc.message);
    const snapshot = calc.calculationSnapshot as Record<string, unknown>;
    if (snapshot.schema !== "complete-navlog/v1" || snapshot.status !== "calculated") throw new Error("The route cannot produce a complete flyable navlog.");
    const now = this.dependencies.clock.now().toISOString();
    const current = this.current;
    if (!current) throw new Error("The active plan changed during calculation.");
    return {
      schemaVersion: 1, id: this.dependencies.ids.next(), planId: current.id, revisionNumber: 1,
      reason: "initial-save", createdAt: now, draftSnapshot: draft,
      aircraftProfileSnapshot: { profile, snapshottedAt: now }, weatherSnapshotIds: calc.weather.snapshotIds,
      calculationSnapshot: calc.calculationSnapshot, warnings: calc.warnings,
    };
  }
  private fail(error: unknown): void {
    this.result = undefined;
    this.feedback = { kind: "error", text: error instanceof Error ? error.message : "The requested action failed." };
    this.renderFeedback();
  }
  private setStatus(message: string): void {
    this.feedback = { kind: "message", text: message };
    this.renderFeedback();
  }
  private refreshUpdateGate(): void {
    const reason = this.localError();
    const feedback = this.content.querySelector<HTMLElement>("[data-local-error]");
    if (feedback) feedback.textContent = reason ? `Unavailable: ${reason}` : "";
    this.refreshCurrentUtcControl();
    this.content.querySelectorAll<HTMLInputElement>("form.route-form input[type='text']").forEach((input) => {
      const showError = this.touchedFields.has(input.name) || input.value.trim() !== "";
      const fields = { ...this.fields, [input.name]: input.value };
      const message = showError ? fieldErrorFor(input.name, fields, this.current, this.profiles) : undefined;
      input.setAttribute("aria-invalid", String(message !== undefined));
      const helper = this.content.querySelector<HTMLElement>(`#${input.name}-error`);
      if (helper) helper.textContent = message ?? "";
    });
    this.syncPlanControls();
  }

  private refreshCurrentUtcControl(): void {
    const useCurrentUtc = this.content.querySelector<HTMLButtonElement>("button[data-use-current-utc]");
    if (useCurrentUtc) useCurrentUtc.hidden = !this.shouldOfferCurrentUtc();
  }

  private shouldOfferCurrentUtc(): boolean {
    if (!this.current || !this.plans.some((plan) => plan.id === this.current?.id)) return false;
    try {
      const departureMs = Date.parse(localUtcTextToIso(this.fields["departure-time"] ?? ""));
      const nowText = this.dependencies.clock.now().toISOString().slice(0, 16);
      return departureMs < this.dependencies.clock.now().getTime() && this.fields["departure-time"] !== nowText;
    } catch {
      return false;
    }
  }
}

function routeFieldGroup(name: FieldName, groups: Record<"identity" | "timing" | "fuel" | "weather", HTMLElement>): HTMLElement {
  if (name === "departure-time") return groups.timing;
  if (name === "fuel-aboard" || name === "taxi-fuel" || name === "reserve-fuel") return groups.fuel;
  if (name === "departure-metar-icao") return groups.weather;
  return groups.identity;
}

async function fetchRequiredMetar(client: MetarTransportClient, airportIdentifier: string, alternateIcao: string | undefined) {
  return fetchRequiredEndpoint(client.fetchMetar.bind(client), airportIdentifier, alternateIcao, "departure METAR");
}

async function fetchRequiredEndpoint<T>(
  fetch: (icao: string) => Promise<T>,
  airportIdentifier: string,
  alternateIcao: string | undefined,
  productName: string,
): Promise<T> {
  if (!/^[A-Z0-9]{4}$/.test(airportIdentifier)) {
    if (alternateIcao === undefined) throw new Error(`Enter an exact four-character ${productName} ICAO alternate for this airport.`);
    return fetch(alternateIcao);
  }
  try { return await fetch(airportIdentifier); }
  catch (error) {
    if (!(error instanceof WindsClientError) || error.apiCode !== "upstream_no_data" || alternateIcao === undefined) throw error;
    return fetch(alternateIcao);
  }
}

function localUtcTextToIso(value: string): string {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) throw new Error("Enter planned departure as a date and time in UTC.");
  const parsed = new Date(`${value}:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 16) !== value) throw new Error("Enter a real planned departure date and time in UTC.");
  return parsed.toISOString();
}
function buildWeatherSelection(departureMetarIcao: string | undefined) {
  return {
    ...(departureMetarIcao === undefined ? {} : { departureMetarIcao }),
  };
}
function restorePilotFields(rawFields: Readonly<Record<string, string>>, legacyCruiseAltitudes: readonly string[]): Record<string, string> {
  const fields = {
    ...initialFields,
    ...rawFields,
    "departure-metar-icao": Object.hasOwn(rawFields, "departure-metar-icao")
      ? rawFields["departure-metar-icao"] ?? ""
      : rawFields["surface-weather-icao"] ?? "",
  };
  if (!Object.hasOwn(rawFields, "cruise-altitude")) {
    const sharedAltitude = legacyCruiseAltitudes[0];
    fields["cruise-altitude"] = sharedAltitude !== undefined && sharedAltitude.trim() !== ""
      && legacyCruiseAltitudes.every((text) => text.trim() === sharedAltitude.trim()) ? sharedAltitude : "";
  }
  return fields;
}
function weatherSelectionFromInputs(
  raw: Readonly<Record<string, string>>,
  departureIdentifier: string,
) {
  resolveEndpointWeatherIcao(raw["departure-metar-icao"] ?? "", departureIdentifier, "departure METAR");
  return buildWeatherSelection(optionalEndpointAlternate(raw["departure-metar-icao"]));
}
function optionalEndpointAlternate(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized ? normalized : undefined;
}
function resolveEndpointWeatherIcao(explicitText: string, airportIdentifier: string, reportName: string): string {
  const explicit = explicitText.trim().toUpperCase();
  if (explicit !== "") {
    const error = metarError(explicit);
    if (error) throw new Error(error);
    return explicit;
  }
  const airportIcao = airportIdentifier.trim().toUpperCase();
  if (/^[A-Z0-9]{4}$/.test(airportIcao)) return airportIcao;
  throw new Error(`Enter an exact four-character ${reportName} ICAO alternate for this airport.`);
}
function profileDraftDiffersFromSaved(
  fields: Readonly<Record<string, string>>,
  profile: AircraftProfile | undefined,
): boolean {
  const keys = [
    "profile-profile-name",
    "profile-cruiseTasKnots",
    "profile-cruiseFuelFlowGallonsPerHour",
    "profile-climbRateFeetPerMinute",
    "profile-climbTasKnots",
    "profile-climbFuelFlowGallonsPerHour",
    "profile-descentRateFeetPerMinute",
    "profile-descentTasKnots",
    "profile-descentFuelFlowGallonsPerHour",
    "profile-usableFuelGallons",
    "profile-compass-deviation-card",
  ];
  const hasDraft = keys.some((key) => Object.hasOwn(fields, key));
  if (!hasDraft) return false;
  if (!profile) return true;

  if ((fields["profile-profile-name"] ?? "").trim() !== profile.name) return true;
  const expectedNumbers: Readonly<Record<string, number | undefined>> = {
    "profile-cruiseTasKnots": profile.cruiseTasKnots,
    "profile-cruiseFuelFlowGallonsPerHour": profile.cruiseFuelFlowGallonsPerHour,
    "profile-climbRateFeetPerMinute": profile.climbRateFeetPerMinute,
    "profile-climbTasKnots": profile.climbTasKnots,
    "profile-climbFuelFlowGallonsPerHour": profile.climbFuelFlowGallonsPerHour,
    "profile-descentRateFeetPerMinute": profile.descentRateFeetPerMinute,
    "profile-descentTasKnots": profile.descentTasKnots,
    "profile-descentFuelFlowGallonsPerHour": profile.descentFuelFlowGallonsPerHour,
    "profile-usableFuelGallons": profile.usableFuelGallons,
  };
  const valuesDiffer = Object.entries(expectedNumbers).some(([key, expectedValue]) => {
    const rawValue = (fields[key] ?? "").trim();
    if (expectedValue === undefined) return rawValue !== "";
    return rawValue === "" || !Number.isFinite(Number(rawValue)) || Number(rawValue) !== expectedValue;
  });
  return valuesDiffer || !profileDeviationCardMatches(
    fields["profile-compass-deviation-card"] ?? "",
    profile.compassDeviationTable,
  );
}

function profileDeviationCardMatches(
  rawCard: string,
  expected: AircraftProfile["compassDeviationTable"],
): boolean {
  const entries = rawCard.split(",").filter((entry) => entry.trim() !== "");
  if (entries.length !== expected.length) return false;
  return entries.every((entry, index) => {
    const match = /^\s*(\d{1,3})\s*:\s*([+-]?\d+(?:\.\d+)?)\s*$/.exec(entry);
    return Boolean(match)
      && Number(match?.[1]) === expected[index]?.magneticHeadingDegrees
      && Number(match?.[2]) === expected[index]?.deviationDegrees;
  });
}
function parsePlannerCoordinateText(value: string) {
  const compact = parseCompactCoordinate(value);
  if (compact.ok) return compact;
  const decimal = /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*,\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*$/.exec(value);
  if (!decimal) return compact;
  return coordinate(Number(decimal[1]), Number(decimal[2]));
}
function requiredFieldsError(fields: Readonly<Record<string, string>>): string | undefined {
  if ((fields["plan-title"] ?? "").trim().length > 120) return "Plan title must be 120 characters or fewer.";
  return ["plan-title", "departure-time", "departure-icao", "destination-icao"]
    .some((key) => (fields[key] ?? "").trim() === "") ? "Enter a title, departure time, and both airports." : undefined;
}
function validateLocalInputs(fields: Readonly<Record<string, string>>, plan: PilotInputPlan | undefined, profiles: readonly AircraftProfile[], profileDraftDirty: boolean): string | undefined {
  const checks = [
    profileDraftDirty ? "Save the edited aircraft profile first." : undefined,
    requiredFieldsError(fields), airportCodeError(fields["departure-icao"] ?? "", fields["destination-icao"] ?? ""),
    profileError(plan, profiles), departureTimeError(fields["departure-time"] ?? ""),
    fuelError(fields), fuelAboardError(fields, plan, profiles), altitudeError(fields, plan), checkpointError(plan),
    metarError(fields["departure-metar-icao"] ?? "", "Departure METAR"), tasOverrideError(plan, fields),
    overrideReasonError(plan, fields),
  ];
  return checks.find((message) => message !== undefined);
}
function profileError(plan: PilotInputPlan | undefined, profiles: readonly AircraftProfile[]): string | undefined {
  return !plan?.selectedProfileId || !profiles.some((profile) => profile.id === plan.selectedProfileId) ? "Select a saved aircraft profile." : undefined;
}
function departureTimeError(value: string): string | undefined {
  try { localUtcTextToIso(value); return undefined; } catch { return "Enter a valid UTC time as YYYY-MM-DDTHH:mm, for example 2026-09-26T18:30."; }
}
function fuelError(fields: Readonly<Record<string, string>>): string | undefined {
  return (["taxi-fuel", "reserve-fuel"] as const).some((key) => { const value = fields[key] ?? ""; return value.trim() === "" || !Number.isFinite(Number(value)) || Number(value) < 0; })
    ? "Enter nonnegative taxi/run-up and reserve fuel values." : undefined;
}
function fuelAboardError(fields: Readonly<Record<string, string>>, plan: PilotInputPlan | undefined, profiles: readonly AircraftProfile[]): string | undefined {
  const raw = fields["fuel-aboard"] ?? "";
  const aboard = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(aboard) || aboard < 0) return "Enter a finite, nonnegative fuel-aboard amount in gallons.";
  const profile = profiles.find((candidate) => candidate.id === plan?.selectedProfileId);
  if (profile?.usableFuelGallons !== undefined && aboard > profile.usableFuelGallons) return `Fuel aboard exceeds usable capacity of ${profile.usableFuelGallons} gal.`;
  return undefined;
}
function altitudeError(fields: Readonly<Record<string, string>>, plan: PilotInputPlan | undefined): string | undefined {
  if (!plan) return "Open a plan first.";
  const value = fields["cruise-altitude"] ?? "";
  return value.trim() === "" || !Number.isFinite(Number(value)) || Number(value) <= 0 ? "Choose a cruise altitude in feet MSL before calculating." : undefined;
}
function checkpointError(plan: PilotInputPlan | undefined): string | undefined {
  if ((plan?.checkpoints.length ?? 0) > MAX_CHECKPOINTS_PER_PLAN) return `A plan can have no more than ${MAX_CHECKPOINTS_PER_PLAN} checkpoints.`;
  return plan?.checkpoints.some((point) => point.name.trim() === "" || !parsePlannerCoordinateText(point.coordinateText).ok) ? "Enter a name and valid coordinate for every checkpoint." : undefined;
}
function airportCodeError(departure: string, destination: string): string | undefined {
  return [departure, destination].some((code) => !/^[A-Z0-9]{3,4}$/i.test(code.trim()))
    ? "Enter departure and destination airport codes using exactly 3 or 4 letters or numbers." : undefined;
}
function metarError(value: string, reportName = "METAR"): string | undefined {
  return value.trim() !== "" && !/^[A-Z0-9]{4}$/.test(value.trim().toUpperCase()) ? `${reportName} must be an exact four-character ICAO code.` : undefined;
}
function tasOverrideError(plan: PilotInputPlan | undefined, fields: Readonly<Record<string, string>>): string | undefined {
  if (!plan) return undefined;
  for (const [key, text] of Object.entries(fields)) {
    const match = /^override-tas-(\d+)$/.exec(key);
    if (!match || text.trim() === "") continue;
    const index = Number(match[1]);
    if (index >= plan.checkpoints.length + 1) return "Remove the TAS override for a leg that no longer exists.";
    if (!Number.isFinite(Number(text)) || Number(text) <= 0) return `Leg ${index + 1} TAS override must be a positive number of knots.`;
  }
  return undefined;
}
function overrideReasonError(plan: PilotInputPlan | undefined, fields: Readonly<Record<string, string>>): string | undefined {
  if (!plan) return undefined;
  for (const [key, value] of Object.entries(fields)) {
    const match = /^override-tas-(\d+)$/.exec(key);
    if (match && value.trim() !== "" && !(plan.overrideReasons[`tas-${match[1]}`] ?? "").trim()) return `Enter a reason for the TAS override on leg ${Number(match[1]) + 1}.`;
  }
  return undefined;
}
function fieldErrorFor(name: string, fields: Readonly<Record<string, string>>, plan: PilotInputPlan | undefined, profiles: readonly AircraftProfile[]): string | undefined {
  return simpleFieldError(name, fields) ?? (name === "fuel-aboard" ? fuelAboardError(fields, plan, profiles) : undefined) ?? (name === "cruise-altitude" ? altitudeError(fields, plan) : undefined) ?? checkpointFieldError(name, fields) ?? legFieldError(name, fields);
}
function simpleFieldError(name: string, fields: Readonly<Record<string, string>>): string | undefined {
  const value = fields[name] ?? "";
  return titleFieldError(name, value) ?? departureTimeFieldError(name, value) ?? fuelFieldError(name, value)
    ?? airportFieldError(name, value)
    ?? (name === "departure-metar-icao" ? metarError(value, "Departure METAR") : undefined);
}
function titleFieldError(name: string, value: string): string | undefined {
  if (name !== "plan-title") return undefined;
  if (!value.trim()) return "Enter a plan title.";
  return value.trim().length > 120 ? "Plan title must be 120 characters or fewer." : undefined;
}
function departureTimeFieldError(name: string, value: string): string | undefined { return name === "departure-time" ? departureTimeError(value) : undefined; }
function fuelFieldError(name: string, value: string): string | undefined { return (name === "taxi-fuel" || name === "reserve-fuel") && (value.trim() === "" || !Number.isFinite(Number(value)) || Number(value) < 0) ? "Enter a nonnegative number." : undefined; }
function airportFieldError(name: string, value: string): string | undefined { return (name === "departure-icao" || name === "destination-icao") && !/^[A-Z0-9]{3,4}$/.test(value.trim().toUpperCase()) ? "Enter an exact three- or four-character airport code." : undefined; }
function checkpointFieldError(name: string, fields: Readonly<Record<string, string>>): string | undefined {
  const value = fields[name] ?? "";
  const checkpoint = /^checkpoint-(name|coordinate)-(\d+)$/.exec(name);
  if (checkpoint) {
    if (checkpoint[1] === "name") return value.trim() ? undefined : "Enter a checkpoint name.";
    return parsePlannerCoordinateText(value).ok ? undefined : "Enter a valid SkyVector or decimal coordinate.";
  }
  return undefined;
}
function legFieldError(name: string, fields: Readonly<Record<string, string>>): string | undefined {
  const value = fields[name] ?? "";
  return overrideValueFieldError(name, value) ?? overrideReasonFieldError(name, fields);
}
function overrideValueFieldError(name: string, value: string): string | undefined {
  const override = /^override-tas-(\d+)$/.exec(name);
  if (override && value.trim()) {
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) return "Cruise TAS override must be a positive number of knots.";
  }
  return undefined;
}
function overrideReasonFieldError(name: string, fields: Readonly<Record<string, string>>): string | undefined {
  const reason = /^override-reason-(\d+)$/.exec(name);
  return reason && (fields[`override-tas-${reason[1]}`] ?? "").trim() && !(fields[name] ?? "").trim() ? "Enter a reason for the manual TAS override." : undefined;
}
