import type { AircraftProfile, AircraftProfileInput } from "../domain/aircraft";
import type { AirportLookup } from "../application/airport-lookup";
import { applyCruiseTasOverride, createAircraftProfile, createPlanDraft, createRouteDefinition, type UseCaseClock, type UseCaseIds } from "../application/plan-use-cases";
import { calculateCompletePlan } from "../application/complete-plan";
import { createFullNavlogCalculationEngine } from "../application/full-navlog-engine";
import { routeDistanceMidpoint } from "../application/weather-station-reference";
import { coordinate } from "../domain/coordinates";
import { createWorkerWindsPlanWeatherResolver } from "../application/worker-winds-weather-resolver";
import { parseCompactCoordinate } from "../domain/coordinate-input";
import { renderCalculatedNavlog } from "./calculated-navlog";
import { renderCalculationInspector, type NavlogInspectionSelection } from "./calculation-inspector";
import type { PlanDraft, PlanRevision } from "../domain/route";
import type { WindsTransportClient, MetarTransportClient } from "../services/weather/winds-client";
import { WorkerWindsAdapter } from "../services/weather/winds-adapter";
import { MAX_CHECKPOINTS_PER_PLAN, type PilotInputPlan, type PilotInputRepository } from "../services/storage/pilot-input-repository";

export interface PilotIntentPlannerDependencies {
  readonly repository: PilotInputRepository;
  readonly airportLookup: AirportLookup;
  readonly winds: WindsTransportClient & MetarTransportClient;
  readonly ids: UseCaseIds;
  readonly clock: UseCaseClock;
}

const fieldNames = ["plan-title", "departure-time", "taxi-fuel", "reserve-fuel", "descent-target", "departure-icao", "destination-icao", "departure-metar-icao", "destination-taf-icao"] as const;
type FieldName = typeof fieldNames[number];
const initialFields: Readonly<Record<FieldName, string>> = {
  "plan-title": "New study route", "departure-time": "", "taxi-fuel": "0", "reserve-fuel": "0", "descent-target": "",
  "departure-icao": "", "destination-icao": "", "departure-metar-icao": "", "destination-taf-icao": "",
};

export function renderPilotIntentPlanner(root: HTMLElement, dependencies: PilotIntentPlannerDependencies): void {
  const app = new PilotIntentPlanner(root, dependencies);
  void app.initialize();
}

class PilotIntentPlanner {
  private plans: readonly PilotInputPlan[] = [];
  private profiles: readonly AircraftProfile[] = [];
  private current?: PilotInputPlan;
  private fields: Record<string, string> = { ...initialFields };
  private result?: PlanRevision;
  private inspected?: NavlogInspectionSelection;
  private updateError = "";
  private saveError = "";
  private profileDraftDirty = false;
  private readonly confirmedOverrides = new Set<number>();
  private updating = false;
  private savingProfile = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly status = document.createElement("p");
  private readonly content = document.createElement("div");

  constructor(private readonly root: HTMLElement, private readonly dependencies: PilotIntentPlannerDependencies) {
    this.status.setAttribute("role", "status");
    this.status.className = "planner-feedback";
  }

  async initialize(): Promise<void> {
    try {
      await this.dependencies.repository.initialize();
      [this.plans, this.profiles] = await Promise.all([this.dependencies.repository.listPlans(), this.dependencies.repository.listProfiles()]);
      this.render();
      if (this.plans.length > 0) await this.open(this.plans[0]!.id);
      else this.newPlan();
    } catch (error) { this.fail(error); this.render(); }
  }

  private render(): void {
    this.content.replaceChildren();
    const shell = document.createElement("section");
    shell.className = "planner-shell";
    const heading = document.createElement("h2"); heading.textContent = "Flight plan";
    shell.append(heading, this.status);
    const plans = document.createElement("section"); plans.append(this.el("h3", "Saved pilot inputs"));
    this.plans.forEach((plan) => { const b = document.createElement("button"); b.type = "button"; b.textContent = `Open ${plan.title}`; b.disabled = this.savingProfile; b.addEventListener("click", () => { void this.open(plan.id); }); plans.append(b); });
    const create = document.createElement("button"); create.type = "button"; create.textContent = "New plan"; create.disabled = this.savingProfile; create.addEventListener("click", () => this.newPlan()); plans.append(create); shell.append(plans);
    const form = document.createElement("form"); form.className = "route-form"; form.addEventListener("submit", (event) => event.preventDefault());
    fieldNames.forEach((name) => {
      const labels: Record<FieldName, string> = { "plan-title": "Plan title", "departure-time": "Planned departure UTC", "taxi-fuel": "Taxi/run-up fuel (gal)", "reserve-fuel": "Reserve fuel (gal)", "descent-target": "Arrival descent target (ft MSL; leave blank to accept destination field elevation + 1,000 ft)", "departure-icao": "Departure airport code (FAA LID or ICAO)", "destination-icao": "Destination airport code (FAA LID or ICAO)", "departure-metar-icao": "Departure METAR ICAO alternate (blank uses airport ICAO)", "destination-taf-icao": "Destination TAF ICAO alternate (blank uses airport ICAO)" };
      form.append(this.input(name, labels[name], this.fields[name] ?? ""));
    });
    const profileLabel = document.createElement("label"); profileLabel.append("Aircraft profile ");
    const profile = document.createElement("select"); profile.name = "selectedProfileId"; profile.append(new Option("Choose profile", ""));
    this.profiles.forEach((p) => profile.append(new Option(p.name, p.id, false, p.id === this.current?.selectedProfileId)));
    profile.addEventListener("change", () => {
      this.confirmedOverrides.clear();
      const selected = this.profiles.find((candidate) => candidate.id === profile.value);
      if (this.current) {
        const next = {
          ...this.current,
          selectedProfileId: profile.value || undefined,
          ...(selected ? { profileSnapshot: selected } : {}),
        };
        if (!selected) delete next.profileSnapshot;
        this.current = next;
      }
      this.profileDraftDirty = profileDraftDiffersFromSaved(this.fields, selected);
      this.invalidate();
      this.refreshUpdateGate();
      void this.persist();
    });
    profileLabel.append(profile); form.append(profileLabel);
    form.append(this.renderRouteCollections());
    form.querySelectorAll<HTMLInputElement>("input[type='text']").forEach((input) => {
      input.addEventListener("input", () => { this.fields[input.name] = input.value; this.captureStructured(form); if (input.name.startsWith("override-tas-")) { const index = Number(input.name.slice("override-tas-".length)); this.confirmedOverrides.delete(index); const confirmation = form.querySelector<HTMLInputElement>(`[data-override-confirmation="${index}"]`); if (confirmation) confirmation.checked = false; } this.invalidate(); this.refreshUpdateGate(); });
      input.addEventListener("blur", () => { this.captureStructured(form); void this.persist(); });
    });
    const update = document.createElement("button"); update.type = "button"; update.dataset.updatePlan = "true"; update.textContent = "Update plan"; update.disabled = this.updating || this.localError() !== undefined; update.addEventListener("click", () => void this.update()); form.append(update);
    const feedback = document.createElement("p"); feedback.dataset.localError = "true"; feedback.setAttribute("aria-live", "polite"); feedback.textContent = this.localError() ? `Unavailable: ${this.localError()}` : ""; form.append(feedback);
    shell.append(this.renderProfileEditor(), form);
    if (this.result !== undefined) {
      const output = document.createElement("section"); output.dataset.currentResult = "true";
      const navlog = renderCalculatedNavlog(this.result, { selected: this.inspected, onInspect: (selection) => { this.inspected = selection; this.render(); } });
      if (navlog) output.append(navlog, renderCalculationInspector(this.result, this.inspected));
      shell.append(output);
    }
    if (this.profiles.length === 0) shell.append(this.el("h3", "Create an aircraft profile to enable Update plan."));
    this.content.append(shell);
    this.refreshUpdateGate();
    if (this.updating || this.savingProfile) shell.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("input, select, textarea, button").forEach((control) => { control.disabled = true; });
    if (this.root.firstChild === null) this.root.append(this.content); else if (!this.root.contains(this.content)) this.root.replaceChildren(this.content);
  }

  private input(name: string, labelText: string, value: string): HTMLLabelElement {
    const label = document.createElement("label"); label.append(document.createTextNode(`${labelText} `));
    const input = document.createElement("input"); input.type = "text"; input.name = name; input.value = value;
    const error = document.createElement("span"); error.id = `${name}-error`; error.className = "field-error"; input.setAttribute("aria-describedby", error.id);
    label.append(input, error); return label;
  }
  private renderRouteCollections(): HTMLElement {
    const wrapper = document.createElement("div");
    const checkpoints = document.createElement("section"); checkpoints.append(this.el("h3", "Checkpoints (order is preserved)"));
    (this.current?.checkpoints ?? []).forEach((point, index) => { checkpoints.append(this.input(`checkpoint-name-${index}`, `Checkpoint ${index + 1} name`, point.name), this.input(`checkpoint-coordinate-${index}`, "SkyVector or decimal latitude, longitude", point.coordinateText)); });
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Add checkpoint";
    add.disabled = (this.current?.checkpoints.length ?? 0) >= MAX_CHECKPOINTS_PER_PLAN;
    add.addEventListener("click", () => {
      if ((this.current?.checkpoints.length ?? 0) >= MAX_CHECKPOINTS_PER_PLAN) return;
      const hadOverrides = this.clearRouteOverrides();
      const current = this.current ?? this.blankPlan();
      this.current = this.withIdentity({
        ...current,
        checkpoints: [...current.checkpoints, { name: "", coordinateText: "" }],
        cruiseAltitudeTexts: [...current.cruiseAltitudeTexts, "4500"],
        overrideReasons: {},
      });
      this.invalidate();
      this.render();
      void this.persist().then(() => {
        if (hadOverrides) this.setStatus("Route changed; existing TAS overrides and reasons were cleared.");
      });
    });
    checkpoints.append(add);
    (this.current?.checkpoints ?? []).forEach((_point, index) => {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = `Remove checkpoint ${index + 1}`;
      remove.addEventListener("click", () => {
        const hadOverrides = this.clearRouteOverrides();
        const current = this.current;
        if (!current) return;
        const nextCheckpoints = [...current.checkpoints];
        nextCheckpoints.splice(index, 1);
        const altitudes = [...current.cruiseAltitudeTexts];
        if (altitudes.length > nextCheckpoints.length + 1) altitudes.splice(index + 1, 1);
        this.current = this.withIdentity({
          ...current,
          checkpoints: nextCheckpoints,
          cruiseAltitudeTexts: altitudes,
          overrideReasons: {},
        });
        this.invalidate();
        this.render();
        void this.persist().then(() => {
          if (hadOverrides) this.setStatus("Route changed; existing TAS overrides and reasons were cleared.");
        });
      });
      checkpoints.append(remove);
    });
    const altitudeSection = document.createElement("section"); altitudeSection.append(this.el("h3", "Cruise altitude per leg (feet MSL)"));
    (this.current?.cruiseAltitudeTexts ?? ["4500"]).forEach((alt, index) => {
      altitudeSection.append(this.input(`altitude-${index}`, `Leg ${index + 1} cruise altitude`, alt), this.input(`override-tas-${index}`, `Leg ${index + 1} TAS override (kt, optional)`, this.fields[`override-tas-${index}`] ?? ""), this.input(`override-reason-${index}`, `Leg ${index + 1} override reason`, this.current?.overrideReasons[`tas-${index}`] ?? ""));
      const explanation = document.createElement("p"); explanation.textContent = "A TAS override replaces aircraft cruise TAS for this leg and changes groundspeed, time, and fuel estimates. Review the calculated impact before using the plan."; altitudeSection.append(explanation);
      const label = document.createElement("label"); const confirmation = document.createElement("input"); confirmation.type = "checkbox"; confirmation.dataset.overrideConfirmation = String(index); confirmation.checked = this.confirmedOverrides.has(index);
      confirmation.addEventListener("change", () => { if (confirmation.checked) this.confirmedOverrides.add(index); else this.confirmedOverrides.delete(index); this.refreshUpdateGate(); });
      label.append(confirmation, ` I understand the effect of a TAS override on leg ${index + 1}.`); altitudeSection.append(label);
    });
    wrapper.append(checkpoints, altitudeSection); return wrapper;
  }
  private renderProfileEditor(): HTMLElement {
    const section = document.createElement("section"); section.append(this.el("h3", "Aircraft profile"));
    const form = document.createElement("form"); form.addEventListener("submit", (event) => { event.preventDefault(); void this.saveProfile(form); });
    const values: readonly [string, string][] = [["profile-name", "Profile name"], ["cruiseTasKnots", "Cruise TAS (kt)"], ["cruiseFuelFlowGallonsPerHour", "Cruise fuel flow (gal/hr)"], ["climbRateFeetPerMinute", "Climb rate (ft/min)"], ["climbTasKnots", "Climb TAS (kt)"], ["climbFuelFlowGallonsPerHour", "Climb fuel flow (gal/hr)"], ["descentRateFeetPerMinute", "Descent rate (ft/min)"], ["descentTasKnots", "Descent TAS (kt)"], ["descentFuelFlowGallonsPerHour", "Descent fuel flow (gal/hr)"], ["usableFuelGallons", "Usable fuel (gal, optional)"], ["compass-deviation-card", "Compass deviation entries (e.g. 000:+1, 090:-1)"]];
    values.forEach(([id, label]) => form.append(this.input(id, label, this.fields[`profile-${id}`] ?? "")));
    form.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
      input.addEventListener("input", () => { this.fields[`profile-${input.name}`] = input.value; this.profileDraftDirty = true; this.invalidate(); this.refreshUpdateGate(); });
      input.addEventListener("blur", () => { this.fields[`profile-${input.name}`] = input.value; void this.persist(); });
    });
    const save = document.createElement("button"); save.type = "submit"; save.textContent = "Save aircraft profile"; save.disabled = this.savingProfile; form.append(save); section.append(form); return section;
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
      if (this.current) this.current = { ...this.current, selectedProfileId: saved.id, profileSnapshot: saved };
      this.profileDraftDirty = false;
      await this.persist();
      this.setStatus(`Aircraft profile ${saved.name} saved.`);
      this.savingProfile = false;
      this.render();
    } catch (error) {
      this.savingProfile = false;
      this.fail(error);
      this.render();
    }
  }
  private el(tag: "h3", value: string): HTMLElement { const e = document.createElement(tag); e.textContent = value; return e; }
  private blankPlan(): PilotInputPlan { const now = this.dependencies.clock.now().toISOString(); return { id: this.dependencies.ids.next(), title: this.fields["plan-title"] ?? "New study route", rawFields: { ...this.fields }, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: now, submissions: [] }; }
  private withIdentity(plan: PilotInputPlan): PilotInputPlan { return { ...plan, id: plan.id || this.dependencies.ids.next(), rawFields: { ...this.fields }, title: this.fields["plan-title"] ?? plan.title, updatedAt: this.dependencies.clock.now().toISOString() }; }
  private newPlan(): void {
    if (this.updating || this.savingProfile) return;
    this.confirmedOverrides.clear();
    this.fields = { ...initialFields };
    this.current = this.blankPlan();
    this.result = undefined;
    this.inspected = undefined;
    this.updateError = "";
    this.profileDraftDirty = false;
    this.setStatus("Enter pilot inputs, then Update plan to retrieve current context and calculate.");
    this.render();
  }

  private async open(planId: string): Promise<void> {
    if (this.updating || this.savingProfile) return;
    await this.saveQueue.catch(() => undefined);
    if (this.updating || this.savingProfile) return;
    const plan = this.plans.find((candidate) => candidate.id === planId);
    if (!plan) {
      this.fail(new Error("Saved plan no longer exists."));
      return;
    }
    this.confirmedOverrides.clear();
    this.current = plan;
    const departureSource = Object.hasOwn(plan.rawFields, "departure-metar-icao")
      ? plan.rawFields["departure-metar-icao"] ?? ""
      : plan.rawFields["surface-weather-icao"] ?? "";
    this.fields = {
      ...initialFields,
      ...plan.rawFields,
      "departure-metar-icao": departureSource,
      "destination-taf-icao": Object.hasOwn(plan.rawFields, "destination-taf-icao") ? plan.rawFields["destination-taf-icao"] ?? "" : "",
    };
    this.result = undefined;
    this.inspected = undefined;
    this.updateError = "";
    const selectedProfile = this.profiles.find((profile) => profile.id === plan.selectedProfileId);
    this.profileDraftDirty = profileDraftDiffersFromSaved(this.fields, selectedProfile);
    this.setStatus("Opened saved pilot inputs. Update plan to fetch current context and calculate.");
    this.render();
  }
  private captureStructured(form: HTMLFormElement): void {
    const get = (selector: string) => form.querySelector<HTMLInputElement>(`[name="${selector}"]`)?.value ?? "";
    const checkpoints = (this.current?.checkpoints ?? []).map((_point, i) => ({ name: get(`checkpoint-name-${i}`), coordinateText: get(`checkpoint-coordinate-${i}`) }));
    const cruiseAltitudeTexts = [...form.querySelectorAll<HTMLInputElement>("input[name^='altitude-']")].map((x) => x.value);
    const overrideReasons = Object.fromEntries([...form.querySelectorAll<HTMLInputElement>("input[name^='override-reason-']")].map((x, i) => [`tas-${i}`, x.value]));
    [...form.querySelectorAll<HTMLInputElement>("input[name^='override-tas-']")].forEach((x) => { this.fields[x.name] = x.value; });
    this.fields = { ...this.fields, ...Object.fromEntries(fieldNames.map((name) => [name, get(name)])) };
    this.current = this.withIdentity({ ...(this.current ?? this.blankPlan()), checkpoints, cruiseAltitudeTexts, overrideReasons });
  }
  private invalidate(): void { this.result = undefined; this.content.querySelector("[data-current-result]")?.remove(); }
  private clearRouteOverrides(): boolean {
    const hadOverrides = Object.entries(this.fields).some(([key, value]) =>
      /^override-(?:tas|reason)-\d+$/.test(key) && value.trim() !== "",
    ) || Object.values(this.current?.overrideReasons ?? {}).some((reason) => reason.trim() !== "");
    this.confirmedOverrides.clear();
    this.fields = Object.fromEntries(Object.entries(this.fields).filter(([key]) => !/^override-(?:tas|reason)-\d+$/.test(key)));
    if (this.current) this.current = { ...this.current, overrideReasons: {} };
    return hadOverrides;
  }
  private async persist(): Promise<void> {
    if (!this.current) return;
    const snapshot = this.withIdentity({ ...this.current, rawFields: { ...this.fields } });
    this.current = snapshot;
    const operation = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        await this.dependencies.repository.saveWorkingCopy(snapshot);
        this.plans = [...this.plans.filter((plan) => plan.id !== snapshot.id), snapshot];
        this.saveError = "";
        this.setStatus("Pilot inputs saved.");
      });
    this.saveQueue = operation;
    try {
      await operation;
    } catch (error) {
      this.fail(error, "save");
    }
    // Do not replace the editor while focus leaves a field.
  }
  private localError(): string | undefined {
    return validateLocalInputs(this.fields, this.current, this.profiles, this.profileDraftDirty, this.confirmedOverrides);
  }

  private async update(): Promise<void> {
    if (this.updating) return;
    const form = this.content.querySelector("form.route-form");
    if (form instanceof HTMLFormElement) this.captureStructured(form);
    this.result = undefined;
    this.updating = true;
    this.render();
    try {
      if (!this.current) throw new Error("Open a plan before updating it.");
      await this.saveQueue.catch(() => undefined);
      const invalid = this.localError();
      if (invalid) throw new Error(invalid);
      this.setStatus("Updating plan…");
      const current = this.current;
      const selectedProfile = this.profiles.find((profile) => profile.id === current.selectedProfileId);
      this.current = { ...current, profileSnapshot: selectedProfile };
      await this.dependencies.repository.submitInputs(this.current);
      this.saveError = "";
      const { draft, profile } = await this.prepareDraft();
      this.result = await this.calculateDraft(draft, profile);
      this.inspected = undefined;
      this.updateError = "";
      this.setStatus("Plan updated using current airport and weather context.");
    } catch (error) {
      this.fail(error, "update");
    } finally {
      this.updating = false;
      this.render();
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
      cruiseAltitudesFeetMsl: current.cruiseAltitudeTexts.map(Number),
    }, this.dependencies.ids);
    const departureMetarIcao = resolveEndpointWeatherIcao(raw["departure-metar-icao"] ?? "", departure.icao, "departure METAR");
    const destinationTafIcao = resolveEndpointWeatherIcao(raw["destination-taf-icao"] ?? "", destination.icao, "destination TAF");
    const weatherSelection = buildWeatherSelection(departureMetarIcao, destinationTafIcao);
    const draft = createPlanDraft({
      title: raw["plan-title"] ?? "",
      departureTimeUtc,
      route,
      selectedAircraftProfileId: profile.id,
      taxiRunupFuelGallons: Number(raw["taxi-fuel"]),
      reserveFuelGallons: Number(raw["reserve-fuel"]),
      descentTargetAltitudeFeetMsl: raw["descent-target"]?.trim()
        ? Number(raw["descent-target"])
        : destination.elevationFeetMsl + 1000,
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
  private async calculateDraft(draft: PlanDraft, profile: AircraftProfile): Promise<PlanRevision> {
    const forecastId = draft.weatherSelection?.forecastValidTimeUtc;
    if (!forecastId) throw new Error("Route weather calculation is not available for this plan yet.");
    const weatherResolver = createWorkerWindsPlanWeatherResolver(
      new WorkerWindsAdapter(this.dependencies.winds),
      {
        stationSelectionCoordinate: routeDistanceMidpoint(draft.route),
        weatherSnapshotId: this.dependencies.ids.next(),
      },
      this.dependencies.winds,
    );
    const calc = await calculateCompletePlan(draft, profile, {
      weather: weatherResolver,
      calculations: createFullNavlogCalculationEngine(),
    });
    if (calc.status === "blocked") throw new Error(calc.message);
    requireFreshCurrentWeather(calc.weather.loadedWindsData?.provenance.forecast.cache);
    if (calc.weather.warnings.some((warning) =>
      warning.includes("could not be loaded") || warning.includes("was not usable"))) {
      throw new Error("The selected METAR source is unavailable, stale, or unusable.");
    }
    const snapshot = calc.calculationSnapshot as Record<string, unknown>;
    if (snapshot.schema !== "complete-navlog/v1" || snapshot.status !== "calculated") {
      throw new Error("The route cannot produce a complete flyable navlog.");
    }
    const now = this.dependencies.clock.now().toISOString();
    const current = this.current;
    if (!current) throw new Error("The active plan changed during calculation.");
    return {
      schemaVersion: 1,
      id: this.dependencies.ids.next(),
      planId: current.id,
      revisionNumber: 1,
      reason: "initial-save",
      createdAt: now,
      draftSnapshot: draft,
      aircraftProfileSnapshot: { profile, snapshottedAt: now },
      weatherSnapshotIds: calc.weather.snapshotIds,
      calculationSnapshot: calc.calculationSnapshot,
      warnings: calc.warnings,
    };
  }
  private fail(error: unknown, kind: "update" | "save" = "update"): void { this.result = undefined; const message = error instanceof Error ? error.message : "The requested action failed."; if (kind === "save") this.saveError = message; else this.updateError = message; this.setStatus(""); }
  private setStatus(message: string): void { this.status.textContent = this.saveError || this.updateError || message; }
  private refreshUpdateGate(): void {
    const update = this.content.querySelector<HTMLButtonElement>("button[data-update-plan]");
    const reason = this.localError();
    if (update) update.disabled = this.updating || reason !== undefined;
    const feedback = this.content.querySelector<HTMLElement>("[data-local-error]");
    if (feedback) feedback.textContent = reason ? `Unavailable: ${reason}` : "";
    this.content.querySelectorAll<HTMLInputElement>("form.route-form input[type='text']").forEach((input) => {
      const message = fieldErrorFor(input.name, this.fields, this.confirmedOverrides);
      input.setAttribute("aria-invalid", String(message !== undefined));
      const helper = this.content.querySelector<HTMLElement>(`#${input.name}-error`);
      if (helper) helper.textContent = message ?? "";
    });
  }
}

function localUtcTextToIso(value: string): string {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) throw new Error("Enter planned departure as a date and time in UTC.");
  const parsed = new Date(`${value}:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 16) !== value) throw new Error("Enter a real planned departure date and time in UTC.");
  return parsed.toISOString();
}
function buildWeatherSelection(departureMetarIcao: string, destinationTafIcao: string) {
  return { departureMetarIcao, destinationTafIcao };
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
function requireFreshCurrentWeather(cache: { readonly status: string; readonly freshnessRemainingSeconds: number } | undefined): void {
  if (cache?.status === "stale_on_error" || (cache && cache.freshnessRemainingSeconds <= 0)) throw new Error("The selected winds forecast is stale; no updated plan was produced.");
}

function requiredFieldsError(fields: Readonly<Record<string, string>>): string | undefined {
  if ((fields["plan-title"] ?? "").trim().length > 120) return "Plan title must be 120 characters or fewer.";
  return ["plan-title", "departure-time", "departure-icao", "destination-icao"]
    .some((key) => (fields[key] ?? "").trim() === "") ? "Enter a title, departure time, and both airports." : undefined;
}
function validateLocalInputs(fields: Readonly<Record<string, string>>, plan: PilotInputPlan | undefined, profiles: readonly AircraftProfile[], profileDraftDirty: boolean, confirmedOverrides: ReadonlySet<number>): string | undefined {
  const checks = [
    profileDraftDirty ? "Save the edited aircraft profile first." : undefined,
    requiredFieldsError(fields), airportCodeError(fields["departure-icao"] ?? "", fields["destination-icao"] ?? ""),
    profileError(plan, profiles), departureTimeError(fields["departure-time"] ?? ""),
    fuelError(fields), descentTargetError(fields["descent-target"] ?? ""), altitudeError(plan), checkpointError(plan),
    metarError(fields["departure-metar-icao"] ?? "", "Departure METAR"), metarError(fields["destination-taf-icao"] ?? "", "Destination TAF"), tasOverrideError(plan, fields),
    overrideReasonError(plan, fields), overrideConfirmationError(fields, confirmedOverrides),
  ];
  return checks.find((message) => message !== undefined);
}
function profileError(plan: PilotInputPlan | undefined, profiles: readonly AircraftProfile[]): string | undefined {
  return !plan?.selectedProfileId || !profiles.some((profile) => profile.id === plan.selectedProfileId) ? "Select a saved aircraft profile." : undefined;
}
function departureTimeError(value: string): string | undefined {
  try { localUtcTextToIso(value); return undefined; } catch { return "Enter a valid planned departure time in UTC."; }
}
function fuelError(fields: Readonly<Record<string, string>>): string | undefined {
  return (["taxi-fuel", "reserve-fuel"] as const).some((key) => { const value = fields[key] ?? ""; return value.trim() === "" || !Number.isFinite(Number(value)) || Number(value) < 0; })
    ? "Enter nonnegative taxi/run-up and reserve fuel values." : undefined;
}
function descentTargetError(value: string): string | undefined { return value.trim() && !Number.isFinite(Number(value)) ? "Descent target must be a finite altitude." : undefined; }
function altitudeError(plan: PilotInputPlan | undefined): string | undefined {
  if (!plan) return "Open a plan first.";
  if (plan.cruiseAltitudeTexts.length !== plan.checkpoints.length + 1) return "Enter exactly one cruise altitude for every route leg.";
  return plan.cruiseAltitudeTexts.some((value) => value.trim() === "" || !Number.isFinite(Number(value)) || Number(value) <= 0) ? "Enter a positive cruise altitude for every leg." : undefined;
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
    if (index >= plan.cruiseAltitudeTexts.length) return "Remove the TAS override for a leg that no longer exists.";
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
function overrideConfirmationError(fields: Readonly<Record<string, string>>, confirmed: ReadonlySet<number>): string | undefined {
  for (const [key, value] of Object.entries(fields)) {
    const match = /^override-tas-(\d+)$/.exec(key);
    if (match && value.trim() !== "" && !confirmed.has(Number(match[1]))) return `Confirm the effect of the TAS override for leg ${Number(match[1]) + 1}.`;
  }
  return undefined;
}
function fieldErrorFor(name: string, fields: Readonly<Record<string, string>>, confirmed: ReadonlySet<number>): string | undefined {
  return simpleFieldError(name, fields) ?? checkpointFieldError(name, fields) ?? legFieldError(name, fields, confirmed);
}
function simpleFieldError(name: string, fields: Readonly<Record<string, string>>): string | undefined {
  const value = fields[name] ?? "";
  return titleFieldError(name, value) ?? departureTimeFieldError(name, value) ?? fuelFieldError(name, value)
    ?? descentTargetFieldError(name, value) ?? airportFieldError(name, value)
    ?? (name === "departure-metar-icao" ? metarError(value, "Departure METAR") : undefined)
    ?? (name === "destination-taf-icao" ? metarError(value, "Destination TAF") : undefined);
}
function titleFieldError(name: string, value: string): string | undefined {
  if (name !== "plan-title") return undefined;
  if (!value.trim()) return "Enter a plan title.";
  return value.trim().length > 120 ? "Plan title must be 120 characters or fewer." : undefined;
}
function departureTimeFieldError(name: string, value: string): string | undefined { return name === "departure-time" ? departureTimeError(value) : undefined; }
function fuelFieldError(name: string, value: string): string | undefined { return (name === "taxi-fuel" || name === "reserve-fuel") && (value.trim() === "" || !Number.isFinite(Number(value)) || Number(value) < 0) ? "Enter a nonnegative number." : undefined; }
function descentTargetFieldError(name: string, value: string): string | undefined { return name === "descent-target" ? descentTargetError(value) : undefined; }
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
function legFieldError(name: string, fields: Readonly<Record<string, string>>, confirmed: ReadonlySet<number>): string | undefined {
  const value = fields[name] ?? "";
  return altitudeFieldError(name, value) ?? overrideValueFieldError(name, value, confirmed) ?? overrideReasonFieldError(name, fields);
}
function altitudeFieldError(name: string, value: string): string | undefined {
  const altitude = /^altitude-(\d+)$/.exec(name);
  return altitude && !(value.trim() && Number.isFinite(Number(value)) && Number(value) > 0) ? "Enter a positive feet-MSL altitude." : undefined;
}
function overrideValueFieldError(name: string, value: string, confirmed: ReadonlySet<number>): string | undefined {
  const override = /^override-tas-(\d+)$/.exec(name);
  if (override && value.trim()) {
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) return "Cruise TAS override must be a positive number of knots.";
    return confirmed.has(Number(override[1])) ? undefined : `Confirm the effect of the TAS override for leg ${Number(override[1]) + 1}.`;
  }
  return undefined;
}
function overrideReasonFieldError(name: string, fields: Readonly<Record<string, string>>): string | undefined {
  const reason = /^override-reason-(\d+)$/.exec(name);
  return reason && (fields[`override-tas-${reason[1]}`] ?? "").trim() && !(fields[name] ?? "").trim() ? "Enter a reason for the manual TAS override." : undefined;
}
