import { coordinate } from "../domain/coordinates";
import type { AircraftProfile, AircraftProfileInput } from "../domain/aircraft";
import type { AirportRoutePoint, CheckpointRoutePoint, PlanDraft, PlanRevision, RoutePoint, UserRouteLeg } from "../domain/route";
import type { AirportLookup } from "../application/airport-lookup";
import {
  applyCruiseTasOverride,
  createPlanDraft,
  createRouteDefinition,
  reopenPlanRevision,
  restoreCruiseTasDefault,
  saveAircraftProfile,
  saveDraftRevision,
  type NavlogPersistence,
  type UseCaseClock,
  type UseCaseIds,
} from "../application/plan-use-cases";

export interface PlannerDependencies {
  readonly airportLookup: AirportLookup;
  readonly persistence: NavlogPersistence;
  readonly ids: UseCaseIds;
  readonly clock: UseCaseClock;
}

interface PlannerState {
  readonly profiles: readonly AircraftProfile[];
  readonly selectedProfileId?: string;
  readonly routeForm: RouteFormValues;
  readonly departure?: AirportRoutePoint;
  readonly destination?: AirportRoutePoint;
  readonly checkpoints: readonly CheckpointRoutePoint[];
  readonly cruiseAltitudes: readonly number[];
  readonly draft?: PlanDraft;
  readonly currentRevision?: PlanRevision;
  readonly unlockedLegId?: string;
  readonly inspectedLegId?: string;
}

interface RouteFormValues {
  readonly title: string;
  readonly departureTime: string;
  readonly taxiFuel: string;
  readonly reserveFuel: string;
  readonly departureIcao: string;
  readonly destinationIcao: string;
}

export function renderPlanner(root: HTMLElement, dependencies: PlannerDependencies): void {
  const planner = new Planner(root, dependencies);
  void planner.initialize();
}

class Planner {
  private state: PlannerState = { profiles: [], checkpoints: [], cruiseAltitudes: [], routeForm: emptyRouteForm() };
  private readonly feedback: HTMLParagraphElement;
  private readonly content: HTMLDivElement;

  public constructor(private readonly root: HTMLElement, private readonly dependencies: PlannerDependencies) {
    const shell = document.createElement("main");
    shell.className = "planner-shell";
    this.feedback = document.createElement("p");
    this.feedback.className = "planner-feedback";
    this.feedback.setAttribute("role", "status");
    this.content = document.createElement("div");
    this.content.className = "planner-content";
    shell.append(this.feedback, this.content);
    this.root.replaceChildren(shell);
  }

  public async initialize(): Promise<void> {
    try {
      this.state = { ...this.state, profiles: await this.dependencies.persistence.listAircraftProfiles() };
      this.render();
    } catch (error) {
      this.reportError(error);
    }
  }

  private render(): void {
    this.content.replaceChildren(
      this.renderProfilePanel(),
      this.renderRoutePanel(),
      this.renderNavlogPanel(),
      this.renderInspector(),
    );
  }

  private renderProfilePanel(): HTMLElement {
    const section = panel("Aircraft profile", "Pilot-entered values are defaults only; they are not claimed as POH data.");
    const form = document.createElement("form");
    form.className = "profile-form";
    const fields: ReadonlyArray<readonly [string, string, string]> = [
      ["profile-name", "Profile name", "Study aircraft"],
      ["cruise-tas", "Cruise TAS (kt)", "95"],
      ["cruise-fuel", "Cruise fuel flow (gph)", "6"],
      ["climb-rate", "Climb rate (fpm)", "500"],
      ["climb-tas", "Climb TAS (kt)", "75"],
      ["climb-fuel", "Climb fuel flow (gph)", "7"],
      ["descent-rate", "Descent rate (fpm)", "500"],
      ["descent-tas", "Descent TAS (kt)", "100"],
      ["descent-fuel", "Descent fuel flow (gph)", "5"],
      ["usable-fuel", "Usable fuel (gal, optional)", ""],
    ];
    fields.forEach(([id, label, value]) => form.append(labeledInput(id, label, value, id === "profile-name" ? "text" : "number")));
    form.append(button("Save aircraft profile", "submit"));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.handleSaveProfile(form);
    });
    section.append(form, this.renderProfileSelect());
    return section;
  }

  private renderProfileSelect(): HTMLElement {
    const wrapper = document.createElement("label");
    wrapper.textContent = "Selected aircraft profile";
    const select = document.createElement("select");
    select.name = "selected-profile";
    select.append(new Option("Choose a saved profile", ""));
    this.state.profiles.forEach((profile) => select.append(new Option(profile.name, profile.id, false, profile.id === this.selectedProfileId())));
    select.addEventListener("change", () => {
      if (select.value === "") return;
      this.state = {
        ...this.state,
        selectedProfileId: select.value,
        ...(this.state.draft === undefined ? {} : { draft: { ...this.state.draft, selectedAircraftProfileId: select.value } }),
      };
    });
    wrapper.append(select);
    return wrapper;
  }

  private renderRoutePanel(): HTMLElement {
    const section = panel("Route draft", "Enter exact ICAO endpoints. The local study lookup is a temporary shell, not current operational data.");
    const form = this.createRouteForm();
    const saveButton = button("Save new plan revision", "button");
    saveButton.addEventListener("click", () => void this.handleSaveDraft(form));
    section.append(form, this.renderCheckpointPanel(), this.renderLegAltitudePanel(), saveButton);
    this.appendReopenControl(section);
    return section;
  }

  private createRouteForm(): HTMLFormElement {
    const form = document.createElement("form");
    form.className = "route-form";
    form.append(...routeBasicFields(this.state.routeForm), ...routeAirportFields(this.state.routeForm), button("Resolve exact ICAO endpoints", "button"));
    form.addEventListener("input", (event) => this.syncRouteFormInput(event));
    const resolveButton = form.querySelector<HTMLButtonElement>("button[type='button']");
    resolveButton?.addEventListener("click", () => void this.handleResolveAirports(form));
    return form;
  }

  private appendReopenControl(section: HTMLElement): void {
    if (this.state.currentRevision !== undefined) {
      const reopenButton = button("Reopen saved revision", "button");
      reopenButton.addEventListener("click", () => void this.handleReopenRevision());
      section.append(reopenButton);
    }
  }

  private renderCheckpointPanel(): HTMLElement {
    const wrapper = document.createElement("section");
    wrapper.className = "checkpoint-editor";
    wrapper.append(document.createElement("h3"));
    wrapper.querySelector("h3")!.textContent = "Manual checkpoints";
    const form = document.createElement("form");
    form.append(
      labeledInput("checkpoint-name", "Name", ""),
      labeledInput("checkpoint-latitude", "Latitude (decimal degrees)", "", "number"),
      labeledInput("checkpoint-longitude", "Longitude (decimal degrees)", "", "number"),
      button("Add checkpoint", "submit"),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.handleAddCheckpoint(form);
    });
    const list = document.createElement("ol");
    this.state.checkpoints.forEach((checkpoint) => {
      const item = document.createElement("li");
      item.textContent = checkpoint.name;
      const remove = button(`Remove ${checkpoint.name}`, "button");
      remove.addEventListener("click", () => this.removeCheckpoint(checkpoint.id));
      item.append(" ", remove);
      list.append(item);
    });
    wrapper.append(form, list);
    return wrapper;
  }

  private renderLegAltitudePanel(): HTMLElement {
    const wrapper = document.createElement("section");
    wrapper.className = "leg-altitudes";
    const heading = document.createElement("h3");
    heading.textContent = "Per-leg cruise altitudes";
    wrapper.append(heading);
    const points = routePoints(this.state);
    points.slice(0, -1).forEach((point, index) => {
      const next = points[index + 1];
      if (next === undefined) return;
      const field = labeledInput(`leg-altitude-${index}`, `${point.name} to ${next.name} (feet MSL)`, String(this.state.cruiseAltitudes[index] ?? 4_500), "number");
      field.querySelector("input")?.addEventListener("change", (event) => this.setCruiseAltitude(index, inputNumber(event)));
      wrapper.append(field);
    });
    if (points.length < 2) wrapper.append(text("p", "Resolve departure and destination before defining leg altitudes."));
    return wrapper;
  }

  private renderNavlogPanel(): HTMLElement {
    const section = panel("Initial visual flight log", "Route geometry, wind, headings, time, and fuel calculations will be added in later phases.");
    const profile = this.selectedProfile();
    const table = document.createElement("table");
    table.append(createNavlogHeader());
    const body = document.createElement("tbody");
    const points = routePoints(this.state);
    this.state.draft?.route.legs.forEach((leg) => this.appendNavlogRow(body, points, profile, leg));
    table.append(body);
    section.append(table);
    if (this.state.draft === undefined) section.append(text("p", "Save a route draft to populate the table."));
    return section;
  }

  private appendNavlogRow(body: HTMLTableSectionElement, points: readonly RoutePoint[], profile: AircraftProfile | undefined, leg: UserRouteLeg): void {
    const labels = navlogLabels(points, profile, leg);
    const row = document.createElement("tr");
    row.append(cell(labels.from), cell(labels.to), cell(labels.altitude), cell(labels.tas), cell(labels.fuelFlow));
    const inspect = button("Inspect", "button");
    inspect.addEventListener("click", () => {
      this.state = { ...this.state, inspectedLegId: leg.id };
      this.render();
    });
    row.append(cell(inspect));
    body.append(row);
  }

  private renderInspector(): HTMLElement {
    const section = panel("Calculation Inspector", "This panel distinguishes a profile default from a deliberate per-leg effective value.");
    const draft = this.state.draft;
    const profile = this.selectedProfile();
    const leg = draft?.route.legs.find((candidate) => candidate.id === this.state.inspectedLegId) ?? draft?.route.legs[0];
    if (draft === undefined || profile === undefined || leg === undefined) {
      section.append(text("p", "Select an aircraft profile and save a route draft to inspect its performance defaults."));
      return section;
    }
    const override = leg.performanceOverrides?.cruiseTasKnots;
    section.append(text("p", `Cruise TAS default: ${profile.cruiseTasKnots} kt from ${profile.name}.`));
    if (override !== undefined) {
      section.append(text("p", `OVERRIDDEN effective TAS: ${override.effectiveValue} kt. The original default remains ${override.computedValue} kt.`));
      const restore = button("Restore aircraft default", "button");
      restore.addEventListener("click", () => {
        this.state = { ...this.state, draft: restoreCruiseTasDefault(draft, leg.id, this.dependencies.clock), unlockedLegId: undefined };
        this.render();
      });
      section.append(restore);
      return section;
    }
    if (this.state.unlockedLegId !== leg.id) {
      const unlock = button("Override TAS for this leg", "button");
      unlock.addEventListener("click", () => {
        this.state = { ...this.state, unlockedLegId: leg.id };
        this.render();
      });
      section.append(unlock);
      return section;
    }
    section.append(this.renderOverrideForm(draft, profile, leg.id));
    return section;
  }

  private renderOverrideForm(draft: PlanDraft, profile: AircraftProfile, legId: string): HTMLFormElement {
    const form = document.createElement("form");
    form.className = "override-form";
    form.append(text("p", "Override is limited to this leg. Applying it records both the profile default and your effective value."));
    form.append(labeledInput("override-tas", "Effective cruise TAS (kt)", String(profile.cruiseTasKnots), "number"));
    form.append(labeledInput("override-reason", "Reason (optional)", ""));
    form.append(button("Apply deliberate override", "submit"), button("Cancel", "button"));
    form.querySelector<HTMLButtonElement>("button[type='button']")?.addEventListener("click", () => {
      this.state = { ...this.state, unlockedLegId: undefined };
      this.render();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = inputValue(form, "override-tas");
      const reason = inputValue(form, "override-reason");
      try {
        this.state = { ...this.state, draft: applyCruiseTasOverride(draft, profile, legId, Number(value), reason, this.dependencies.clock), unlockedLegId: undefined };
        this.feedback.textContent = "Cruise TAS override applied and flagged in the route table.";
        this.render();
      } catch (error) {
        this.reportError(error);
      }
    });
    return form;
  }

  private async handleSaveProfile(form: HTMLFormElement): Promise<void> {
    try {
      const profile = await saveAircraftProfile(this.dependencies.persistence, profileInputFromForm(form), this.dependencies.ids, this.dependencies.clock);
      this.state = { ...this.state, profiles: [...this.state.profiles, profile], selectedProfileId: profile.id };
      this.feedback.textContent = `Saved aircraft profile ${profile.name}.`;
      this.render();
    } catch (error) {
      this.reportError(error);
    }
  }

  private async handleResolveAirports(form: HTMLFormElement): Promise<void> {
    try {
      const routeForm = routeFormFromElement(form);
      const [departure, destination] = await Promise.all([
        this.dependencies.airportLookup.lookupExactIcao(inputValue(form, "departure-icao")),
        this.dependencies.airportLookup.lookupExactIcao(inputValue(form, "destination-icao")),
      ]);
      this.state = { ...this.state, departure, destination, routeForm, cruiseAltitudes: expandAltitudes(this.state.cruiseAltitudes, this.state.checkpoints.length + 1) };
      this.feedback.textContent = "Exact ICAO endpoints resolved from local study data.";
      this.render();
    } catch (error) {
      this.reportError(error);
    }
  }

  private handleAddCheckpoint(form: HTMLFormElement): void {
    try {
      const checked = coordinate(Number(inputValue(form, "checkpoint-latitude")), Number(inputValue(form, "checkpoint-longitude")));
      if (!checked.ok) throw new Error(checked.error.message);
      const name = inputValue(form, "checkpoint-name").trim();
      if (name.length === 0) throw new Error("Checkpoint name is required.");
      const checkpoint: CheckpointRoutePoint = { kind: "checkpoint", id: this.dependencies.ids.next(), name, coordinate: checked.value };
      this.state = { ...this.state, checkpoints: [...this.state.checkpoints, checkpoint], cruiseAltitudes: expandAltitudes(this.state.cruiseAltitudes, this.state.checkpoints.length + 2) };
      this.feedback.textContent = `Added checkpoint ${name}.`;
      this.render();
    } catch (error) {
      this.reportError(error);
    }
  }

  private removeCheckpoint(id: string): void {
    const checkpoints = this.state.checkpoints.filter((checkpoint) => checkpoint.id !== id);
    this.state = { ...this.state, checkpoints, cruiseAltitudes: expandAltitudes(this.state.cruiseAltitudes, Math.max(0, checkpoints.length + 1)) };
    this.render();
  }

  private setCruiseAltitude(index: number, value: number): void {
    if (!Number.isFinite(value) || value <= 0) {
      this.feedback.textContent = "Cruise altitude must be a positive feet-MSL value.";
      return;
    }
    const cruiseAltitudes = [...expandAltitudes(this.state.cruiseAltitudes, index + 1)];
    cruiseAltitudes[index] = value;
    this.state = { ...this.state, cruiseAltitudes };
  }

  private async handleSaveDraft(form: HTMLFormElement): Promise<void> {
    try {
      const profile = this.selectedProfile();
      if (profile === undefined) throw new Error("Save and select an aircraft profile before saving a plan.");
      const departure = this.state.departure;
      const destination = this.state.destination;
      if (departure === undefined || destination === undefined) throw new Error("Resolve exact ICAO departure and destination first.");
      const route = createRouteDefinition({ id: this.state.draft?.route.id, departure, checkpoints: this.state.checkpoints, destination, cruiseAltitudesFeetMsl: this.state.cruiseAltitudes }, this.dependencies.ids);
      const draft = createPlanDraft({
        id: this.state.draft?.id,
        planId: this.state.draft?.planId,
        title: inputValue(form, "plan-title"),
        departureTimeUtc: dateTimeLocalToUtc(inputValue(form, "departure-time")),
        route,
        selectedAircraftProfileId: profile.id,
        taxiRunupFuelGallons: Number(inputValue(form, "taxi-fuel")),
        reserveFuelGallons: Number(inputValue(form, "reserve-fuel")),
        descentTargetAltitudeFeetMsl: destination.elevationFeetMsl + 1_000,
      }, this.dependencies.ids, this.dependencies.clock);
      const saved = await saveDraftRevision(this.dependencies.persistence, draft, profile, this.dependencies.ids, this.dependencies.clock, this.state.currentRevision);
      this.state = { ...this.state, draft: saved.revision.draftSnapshot, currentRevision: saved.revision, routeForm: routeFormFromDraft(saved.revision.draftSnapshot, departure.icao, destination.icao) };
      this.feedback.textContent = `Saved immutable revision ${saved.revision.id}.`;
      this.render();
    } catch (error) {
      this.reportError(error);
    }
  }

  private selectedProfile(): AircraftProfile | undefined {
    const selectedId = this.selectedProfileId();
    return this.state.profiles.find((profile) => profile.id === selectedId) ?? this.state.profiles[0];
  }

  private selectedProfileId(): string | undefined {
    return this.state.draft?.selectedAircraftProfileId ?? this.state.selectedProfileId;
  }

  private async handleReopenRevision(): Promise<void> {
    const revision = this.state.currentRevision;
    if (revision === undefined) return;
    try {
      const reopened = await reopenPlanRevision(this.dependencies.persistence, revision.id);
      this.state = {
        ...this.state,
        draft: reopened.draftSnapshot,
        currentRevision: reopened,
        selectedProfileId: reopened.draftSnapshot.selectedAircraftProfileId,
        departure: firstAirport(reopened.draftSnapshot.route.points),
        destination: lastAirport(reopened.draftSnapshot.route.points),
        checkpoints: reopened.draftSnapshot.route.points.filter((point): point is CheckpointRoutePoint => point.kind === "checkpoint"),
        cruiseAltitudes: reopened.draftSnapshot.route.legs.map((leg) => leg.cruiseAltitudeFeetMsl),
        routeForm: routeFormFromDraft(reopened.draftSnapshot, firstAirport(reopened.draftSnapshot.route.points)?.icao ?? "", lastAirport(reopened.draftSnapshot.route.points)?.icao ?? ""),
      };
      this.feedback.textContent = `Reopened revision ${reopened.id}; any save will create a child revision.`;
      this.render();
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    this.feedback.textContent = error instanceof Error ? error.message : "The requested action could not be completed.";
  }

  private syncRouteFormInput(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const field = routeFormField(input.name);
    if (field === undefined) return;
    this.state = { ...this.state, routeForm: { ...this.state.routeForm, [field]: input.value } };
  }
}

function panel(title: string, description: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "planner-panel";
  section.append(text("h2", title), text("p", description));
  return section;
}

function labeledInput(id: string, label: string, value: string, type = "text"): HTMLLabelElement {
  const wrapper = document.createElement("label");
  wrapper.htmlFor = id;
  wrapper.append(document.createTextNode(label));
  const input = document.createElement("input");
  input.id = id;
  input.name = id;
  input.type = type;
  input.value = value;
  if (type === "number") input.step = "any";
  wrapper.append(input);
  return wrapper;
}

function button(label: string, type: "button" | "submit"): HTMLButtonElement {
  const control = document.createElement("button");
  control.type = type;
  control.textContent = label;
  return control;
}

function cell(content: string | HTMLElement): HTMLTableCellElement {
  const tableCell = document.createElement("td");
  if (typeof content === "string") tableCell.textContent = content;
  else tableCell.append(content);
  return tableCell;
}

function text(tag: "h2" | "h3" | "p", content: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = content;
  return element;
}

function routePoints(state: PlannerState): readonly RoutePoint[] {
  const endpoints = state.departure === undefined || state.destination === undefined ? [] : [state.departure, ...state.checkpoints, state.destination];
  return state.draft?.route.points ?? endpoints;
}

function navlogLabels(points: readonly RoutePoint[], profile: AircraftProfile | undefined, leg: UserRouteLeg): Record<"from" | "to" | "altitude" | "tas" | "fuelFlow", string> {
  const from = points.find((point) => point.id === leg.fromPointId);
  const to = points.find((point) => point.id === leg.toPointId);
  const override = leg.performanceOverrides?.cruiseTasKnots;
  const tas = override?.effectiveValue ?? profile?.cruiseTasKnots;
  return {
    from: from?.name ?? "Unknown",
    to: to?.name ?? "Unknown",
    altitude: `${leg.cruiseAltitudeFeetMsl} ft`,
    tas: `${tas ?? "—"} kt${override === undefined ? " (default)" : " (OVERRIDDEN)"}`,
    fuelFlow: formatFuelFlow(profile),
  };
}

function createNavlogHeader(): HTMLTableSectionElement {
  const header = document.createElement("thead");
  const row = document.createElement("tr");
  ["From", "To", "Altitude", "Cruise TAS", "Fuel flow", "Explanation"].forEach((label) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    row.append(cell);
  });
  header.append(row);
  return header;
}

function firstAirport(points: readonly RoutePoint[]): AirportRoutePoint | undefined {
  const first = points[0];
  return first?.kind === "airport" ? first : undefined;
}

function lastAirport(points: readonly RoutePoint[]): AirportRoutePoint | undefined {
  const last = points[points.length - 1];
  return last?.kind === "airport" ? last : undefined;
}

function formatFuelFlow(profile: AircraftProfile | undefined): string {
  return profile === undefined ? "— gph" : `${profile.cruiseFuelFlowGallonsPerHour} gph`;
}

function expandAltitudes(values: readonly number[], requiredLength: number): readonly number[] {
  return Array.from({ length: requiredLength }, (_, index) => values[index] ?? 4_500);
}

function routeBasicFields(values: RouteFormValues): readonly HTMLLabelElement[] {
  return [
    labeledInput("plan-title", "Plan title", values.title),
    labeledInput("departure-time", "Planned departure UTC", values.departureTime, "datetime-local"),
    labeledInput("taxi-fuel", "Taxi/run-up fuel (gal)", values.taxiFuel, "number"),
    labeledInput("reserve-fuel", "Reserve fuel (gal)", values.reserveFuel, "number"),
  ];
}

function routeAirportFields(values: RouteFormValues): readonly HTMLLabelElement[] {
  return [
    labeledInput("departure-icao", "Departure ICAO", values.departureIcao, "text"),
    labeledInput("destination-icao", "Destination ICAO", values.destinationIcao, "text"),
  ];
}

function emptyRouteForm(): RouteFormValues {
  return { title: "New study route", departureTime: "", taxiFuel: "0", reserveFuel: "0", departureIcao: "", destinationIcao: "" };
}

function routeFormFromDraft(draft: PlanDraft, departureIcao: string, destinationIcao: string): RouteFormValues {
  return {
    title: draft.title,
    departureTime: draft.departureTimeUtc.slice(0, 16),
    taxiFuel: String(draft.fuelInputs.taxiRunupFuelGallons),
    reserveFuel: String(draft.fuelInputs.reserveFuelGallons),
    departureIcao,
    destinationIcao,
  };
}

function routeFormField(name: string): keyof RouteFormValues | undefined {
  const fields: Readonly<Record<string, keyof RouteFormValues>> = {
    "plan-title": "title",
    "departure-time": "departureTime",
    "taxi-fuel": "taxiFuel",
    "reserve-fuel": "reserveFuel",
    "departure-icao": "departureIcao",
    "destination-icao": "destinationIcao",
  };
  return fields[name];
}

function routeFormFromElement(form: HTMLFormElement): RouteFormValues {
  return {
    title: inputValue(form, "plan-title"),
    departureTime: inputValue(form, "departure-time"),
    taxiFuel: inputValue(form, "taxi-fuel"),
    reserveFuel: inputValue(form, "reserve-fuel"),
    departureIcao: inputValue(form, "departure-icao"),
    destinationIcao: inputValue(form, "destination-icao"),
  };
}

function inputValue(form: HTMLFormElement, name: string): string {
  const element = form.elements.namedItem(name);
  return element instanceof HTMLInputElement ? element.value : "";
}

function inputNumber(event: Event): number {
  const input = event.currentTarget;
  return input instanceof HTMLInputElement ? Number(input.value) : Number.NaN;
}

function dateTimeLocalToUtc(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error("Enter a planned departure UTC date and time.");
  return new Date(`${value}:00.000Z`).toISOString();
}

function profileInputFromForm(form: HTMLFormElement): AircraftProfileInput {
  const usableFuel = inputValue(form, "usable-fuel").trim();
  return {
    name: inputValue(form, "profile-name").trim(),
    cruiseTasKnots: Number(inputValue(form, "cruise-tas")),
    cruiseFuelFlowGallonsPerHour: Number(inputValue(form, "cruise-fuel")),
    climbRateFeetPerMinute: Number(inputValue(form, "climb-rate")),
    climbTasKnots: Number(inputValue(form, "climb-tas")),
    climbFuelFlowGallonsPerHour: Number(inputValue(form, "climb-fuel")),
    descentRateFeetPerMinute: Number(inputValue(form, "descent-rate")),
    descentTasKnots: Number(inputValue(form, "descent-tas")),
    descentFuelFlowGallonsPerHour: Number(inputValue(form, "descent-fuel")),
    ...(usableFuel === "" ? {} : { usableFuelGallons: Number(usableFuel) }),
    compassDeviationTable: [],
  };
}
