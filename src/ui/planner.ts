import { coordinate } from "../domain/coordinates";
import { parseCompactCoordinate } from "../domain/coordinate-input";
import type { AircraftProfile, AircraftProfileInput, CompassDeviationEntry } from "../domain/aircraft";
import type { AirportRoutePoint, CheckpointRoutePoint, JsonValue, PlanDraft, PlanFamily, PlanRevision, RoutePoint, UserRouteLeg, WeatherReferenceSnapshot } from "../domain/route";
import type { AirportLookup } from "../application/airport-lookup";
import {
  applyCruiseTasOverride,
  createPlanDraft,
  createRouteDefinition,
  reopenPlanRevision,
  restoreCruiseTasDefault,
  saveAircraftProfile,
  saveDraftRevision,
  selectPlanWeatherForecast,
  type NavlogPersistence,
  type UseCaseClock,
  type UseCaseIds,
} from "../application/plan-use-cases";
import type { WindsTransportClient } from "../services/weather/winds-client";
import type { WindsForecastAvailability } from "../../worker/api/contracts";
import type { BrowserPlanCalculator } from "../application/browser-plan-calculator";
import type { BrowserWeatherRefresh } from "../application/browser-weather-refresh";
import { renderCalculatedNavlog } from "./calculated-navlog";
import { renderRevisionHistory } from "./revision-history";
import { renderPlanPortability, type PlanPortabilityRepository } from "./plan-portability";
import { renderWorkspaceLayout } from "./workspace-layout";
import { renderCalculationInspector, type NavlogInspectionSelection } from "./calculation-inspector";
import { createPrintableNavlog } from "./printable-navlog";

export interface PlannerDependencies {
  readonly airportLookup: AirportLookup;
  readonly persistence: NavlogPersistence;
  readonly ids: UseCaseIds;
  readonly clock: UseCaseClock;
  readonly winds?: WindsTransportClient;
  readonly calculatePlan?: BrowserPlanCalculator;
  readonly refreshWeather?: BrowserWeatherRefresh;
  readonly weatherEvidence?: { getWeatherSnapshot(id: string): Promise<WeatherReferenceSnapshot | undefined> };
  readonly portability?: PlanPortabilityRepository;
}

interface PlannerState {
  readonly profiles: readonly AircraftProfile[];
  readonly selectedProfileId?: string;
  readonly routeForm: RouteFormValues;
  readonly descentTargetIsManual: boolean;
  readonly departure?: AirportRoutePoint;
  readonly destination?: AirportRoutePoint;
  readonly checkpoints: readonly CheckpointRoutePoint[];
  readonly cruiseAltitudes: readonly number[];
  readonly draft?: PlanDraft;
  readonly currentRevision?: PlanRevision;
  readonly unlockedLegId?: string;
  readonly inspectedLegId?: string;
  readonly inspectedCalculation?: NavlogInspectionSelection;
  readonly availableForecasts: readonly WindsForecastAvailability[];
  readonly selectedForecastValidTimeUtc?: string;
  readonly weatherSnapshots: readonly WeatherReferenceSnapshot[];
  readonly calculationPreview?: JsonValue;
  /** Form/editor state no longer exactly matches the open immutable revision. */
  readonly hasUnsavedChanges: boolean;
  /** A selected forecast differs from the saved draft but is valid for weather refresh. */
  readonly hasUnsavedForecastSelection: boolean;
  readonly revisions: readonly PlanRevision[];
  readonly families: readonly PlanFamily[];
  /** An async operation owns the current form snapshot until it resolves. */
  readonly pendingOperation?: string;
}

interface RouteFormValues {
  readonly title: string;
  readonly departureTime: string;
  readonly taxiFuel: string;
  readonly reserveFuel: string;
  readonly descentTarget: string;
  readonly departureIcao: string;
  readonly destinationIcao: string;
}

export function renderPlanner(root: HTMLElement, dependencies: PlannerDependencies): void {
  const planner = new Planner(root, dependencies);
  void planner.initialize();
}

class Planner {
  private state: PlannerState = { profiles: [], checkpoints: [], cruiseAltitudes: [], availableForecasts: [], weatherSnapshots: [], revisions: [], families: [], routeForm: emptyRouteForm(), descentTargetIsManual: false, hasUnsavedChanges: false, hasUnsavedForecastSelection: false };
  private readonly feedback: HTMLParagraphElement;
  private readonly content: HTMLDivElement;

  public constructor(private readonly root: HTMLElement, private readonly dependencies: PlannerDependencies) {
    const shell = document.createElement("section");
    shell.className = "planner-shell";
    shell.setAttribute("aria-label", "Planning workspace");
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
      const [profiles, families] = await Promise.all([this.dependencies.persistence.listAircraftProfiles(), this.dependencies.persistence.listPlanFamilies()]);
      this.state = { ...this.state, profiles, families };
      this.render();
    } catch (error) {
      this.reportError(error);
    }
  }

  private render(): void {
    this.content.replaceChildren(renderWorkspaceLayout({
      aircraft: this.renderProfilePanel(),
      route: this.renderRoutePanel(),
      navlog: this.renderNavlogPanel(),
      inspector: this.renderInspector(),
    }));
    if (this.state.pendingOperation !== undefined) {
      this.content.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("input, select, textarea, button").forEach((control) => {
        control.disabled = true;
      });
    }
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
      ["compass-deviation-card", "Compass deviation card (magnetic heading: signed degrees)", "000: 0"],
    ];
    fields.forEach(([id, label, value]) => form.append(labeledInput(id, label, value, id === "profile-name" || id === "compass-deviation-card" ? "text" : "number")));
    form.append(text("p", "Enter card points such as 000:+1, 090:-1. A single point applies a constant deviation at every heading. The default 000: 0 is an explicit study-only zero-deviation assumption; replace it with the aircraft’s compass-deviation card when available."));
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
      this.state = {
        ...this.state,
        selectedProfileId: select.value === "" ? undefined : select.value,
        hasUnsavedChanges: this.state.draft !== undefined,
        calculationPreview: undefined,
      };
      this.feedback.textContent = select.value === ""
        ? "No aircraft profile selected. Select one before saving or calculating."
        : this.state.draft === undefined
          ? "Selected aircraft profile."
          : "Aircraft profile changed. Save a new revision before calculating; prior per-leg overrides will be cleared.";
      this.render();
    });
    wrapper.append(select);
    return wrapper;
  }

  private renderRoutePanel(): HTMLElement {
    const section = panel("Route draft", "Enter exact ICAO endpoints. Airport coordinates and field elevations come from the configured aviation-data Worker.");
    const form = this.createRouteForm();
    const saveButton = button("Save new plan revision", "button");
    saveButton.addEventListener("click", () => void this.handleSaveDraft(form));
    section.append(this.renderSavedPlans(), form, this.renderCheckpointPanel(), this.renderLegAltitudePanel(), this.renderForecastPanel(), saveButton);
    if (this.dependencies.calculatePlan !== undefined) {
      const calculateButton = button("Calculate complete navlog", "button");
      calculateButton.addEventListener("click", () => void this.handleCalculatePlan());
      section.append(calculateButton);
    }
    if (this.dependencies.refreshWeather !== undefined && isCalculatedRevision(this.state.currentRevision)) {
      section.append(text("p", "Weather refresh uses the open saved revision's route, aircraft, and departure time; save any input edits first."));
      const refreshButton = button("Refresh weather into new revision", "button");
      refreshButton.addEventListener("click", () => void this.handleRefreshWeather());
      section.append(refreshButton);
    }
    this.appendReopenControl(section);
    if (this.state.draft !== undefined) section.append(renderRevisionHistory({
      revisions: this.state.revisions,
      selectedRevisionId: this.state.currentRevision?.id,
      onSelect: (id) => void this.openRevision(id),
    }));
    if (this.dependencies.portability !== undefined) section.append(renderPlanPortability(
      this.dependencies.portability,
      this.state.currentRevision?.planId,
      (message) => { this.feedback.textContent = message; },
      async () => {
        const [profiles, families] = await Promise.all([this.dependencies.persistence.listAircraftProfiles(), this.dependencies.persistence.listPlanFamilies()]);
        this.state = { ...this.state, profiles, families };
        if (this.state.draft !== undefined) await this.refreshRevisionHistory(this.state.draft.planId);
        this.render();
      },
    ));
    return section;
  }

  private renderSavedPlans(): HTMLElement {
    const section = document.createElement("section");
    section.className = "saved-plans";
    section.append(text("h3", "Saved local plans"));
    if (this.state.families.length === 0) {
      section.append(text("p", "No saved plans in this browser yet."));
      return section;
    }
    const list = document.createElement("ul");
    this.state.families.forEach((family) => {
      const item = document.createElement("li");
      const open = button(`Open ${family.title}`, "button");
      open.disabled = family.latestRevisionId === undefined;
      open.addEventListener("click", () => {
        if (family.latestRevisionId !== undefined) void this.openRevision(family.latestRevisionId);
      });
      item.append(open);
      list.append(item);
    });
    section.append(list);
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
      labeledInput("checkpoint-compact", "SkyVector coordinate (e.g. 420604N0884405W)", ""),
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

  private renderForecastPanel(): HTMLElement {
    const section = document.createElement("section");
    section.className = "forecast-selection";
    section.append(text("h3", "Winds forecast period"), text("p", "Load published periods, then choose one explicitly. The nearest reporting station is measured from the route's distance midpoint; V1 does not spatially blend stations."));
    if (this.dependencies.winds === undefined) {
      section.append(text("p", "Live winds selection is unavailable in this environment."));
      return section;
    }
    const load = button("Load available winds periods", "button");
    load.addEventListener("click", () => void this.handleLoadForecastPeriods());
    section.append(load);
    if (this.state.availableForecasts.length === 0) return section;
    const label = document.createElement("label");
    label.htmlFor = "selected-forecast-period";
    label.append("Selected forecast valid time (UTC)");
    const select = document.createElement("select");
    select.id = "selected-forecast-period";
    select.append(new Option("Choose a published period", ""));
    this.state.availableForecasts.forEach((period) => {
      const labelText = `${period.validAt} (usable ${period.useFrom}–${period.useUntil})`;
      select.append(new Option(labelText, period.validAt, false, period.validAt === this.state.selectedForecastValidTimeUtc));
    });
    select.addEventListener("change", () => {
      const selectedForecastValidTimeUtc = select.value || undefined;
      this.state = {
        ...this.state,
        selectedForecastValidTimeUtc,
        hasUnsavedForecastSelection: this.state.draft !== undefined && selectedForecastValidTimeUtc !== this.state.draft.weatherSelection?.forecastValidTimeUtc,
        calculationPreview: undefined,
      };
    });
    label.append(select);
    section.append(label);
    return section;
  }

  private async handleLoadForecastPeriods(): Promise<void> {
    try {
      const winds = this.dependencies.winds;
      if (winds === undefined) throw new Error("Live winds selection is unavailable.");
      const points = routePoints(this.state);
      if (points.length < 2) throw new Error("Resolve the route endpoints before loading winds periods.");
      if (!this.beginInputTransaction("Loading published winds periods…")) return;
      const discovery = await winds.discoverStations(points.map((point) => point.coordinate));
      this.state = { ...this.state, pendingOperation: undefined, availableForecasts: discovery.forecasts, selectedForecastValidTimeUtc: undefined, hasUnsavedForecastSelection: false, calculationPreview: undefined };
      this.feedback.textContent = `Loaded ${discovery.forecasts.length} published winds period(s); choose one explicitly.`;
      this.render();
    } catch (error) {
      this.reportError(error);
    }
  }

  private renderNavlogPanel(): HTMLElement {
    const section = panel("Visual flight log", "Calculated sublegs retain unrounded values and per-row explanations. This teaching plan is not a complete preflight briefing.");
    if (this.state.calculationPreview !== undefined && this.state.currentRevision !== undefined) {
      const preview = renderCalculatedNavlog({ ...this.state.currentRevision, calculationSnapshot: this.state.calculationPreview });
      if (preview !== undefined) {
        section.append(preview);
        return section;
      }
    }
    if (this.state.currentRevision !== undefined) {
      if (this.state.hasUnsavedChanges || this.state.hasUnsavedForecastSelection) section.append(text("p", "Viewing the saved revision. Route, aircraft, altitude, or forecast edits are unsaved and cannot be calculated until saved."));
      const calculated = renderCalculatedNavlog(this.state.currentRevision, {
        selected: this.state.inspectedCalculation,
        onInspect: (selection) => this.inspectCalculation(selection),
      });
      if (calculated !== undefined) {
        section.append(calculated);
        section.append(this.renderRawWeatherEvidence());
        if (isCalculatedRevision(this.state.currentRevision)) {
          const print = button("Print / Save PDF", "button");
          print.addEventListener("click", () => this.printCurrentRevision());
          section.append(print);
        }
        return section;
      }
    }
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

  private printCurrentRevision(): void {
    const revision = this.state.currentRevision;
    if (revision === undefined) return;
    const sheet = createPrintableNavlog(revision, this.state.weatherSnapshots);
    if (sheet === undefined) {
      this.feedback.textContent = "Only a complete saved calculated revision can be printed as a navlog PDF.";
      return;
    }
    document.querySelector(".print-sheet")?.remove();
    document.body.append(sheet);
    window.addEventListener("afterprint", () => sheet.remove(), { once: true });
    window.print();
  }

  private renderRawWeatherEvidence(): HTMLElement {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Raw weather source data and provenance";
    const pre = document.createElement("pre");
    pre.textContent = this.state.weatherSnapshots.length > 0 ? JSON.stringify(this.state.weatherSnapshots, null, 2) : "Raw source snapshots are unavailable in this view.";
    details.append(summary, pre);
    return details;
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
    const section = panel("Calculation Inspector", "Select a calculated worksheet value to inspect its inputs, intermediate results, and source. Per-leg aircraft defaults and overrides are controlled separately below.");
    section.append(renderCalculationInspector(this.state.currentRevision, this.state.inspectedCalculation));
    const draft = this.state.draft;
    const profile = this.selectedProfile();
    const leg = draft?.route.legs.find((candidate) => candidate.id === this.state.inspectedLegId) ?? draft?.route.legs[0];
    if (draft === undefined || profile === undefined || leg === undefined) {
      section.append(text("p", "Select an aircraft profile and save a route draft to inspect its performance defaults."));
      return section;
    }
    const override = leg.performanceOverrides?.cruiseTasKnots;
    section.append(text("p", `Cruise TAS aircraft default: ${profile.cruiseTasKnots} kt from ${profile.name}.`));
    if (override !== undefined) {
      section.append(text("p", `OVERRIDDEN effective TAS: ${override.effectiveValue} kt. Preserved aircraft default: ${override.computedValue} kt.`));
      const restore = button("Restore aircraft default", "button");
      restore.addEventListener("click", () => {
        this.state = { ...this.state, draft: restoreCruiseTasDefault(draft, leg.id, this.dependencies.clock), unlockedLegId: undefined, hasUnsavedChanges: true, calculationPreview: undefined };
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

  private inspectCalculation(selection: NavlogInspectionSelection): void {
    this.state = { ...this.state, inspectedCalculation: selection };
    this.content.querySelectorAll<HTMLButtonElement>(".navlog-value").forEach((control) => {
      control.setAttribute("aria-pressed", String(control.dataset.rowIndex === String(selection.rowIndex) && control.dataset.inspectField === selection.field));
    });
    const current = this.content.querySelector<HTMLElement>('[data-region="inspector"]');
    if (current === null) return;
    const inspector = this.renderInspector();
    inspector.dataset.region = "inspector";
    current.replaceWith(inspector);
    inspector.querySelector<HTMLElement>(".calculation-inspector h3")?.focus();
  }

  private renderOverrideForm(draft: PlanDraft, profile: AircraftProfile, legId: string): HTMLFormElement {
    const form = document.createElement("form");
    form.className = "override-form";
    form.append(text("p", "This changes only this leg’s effective cruise TAS. Its cruise groundspeed, heading correction, ETE, fuel, and trip totals will be recalculated; the aircraft profile and other legs are unchanged."));
    form.append(text("p", "Applying the override preserves the aircraft default alongside the effective value in the saved revision."));
    form.append(labeledInput("override-tas", "Effective cruise TAS (kt)", String(profile.cruiseTasKnots), "number"));
    form.append(labeledInput("override-reason", "Reason (optional)", ""));
    form.append(overrideConfirmation());
    form.append(button("Apply deliberate override", "submit"), button("Cancel", "button"));
    form.querySelector<HTMLButtonElement>("button[type='button']")?.addEventListener("click", () => {
      this.state = { ...this.state, unlockedLegId: undefined };
      this.render();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const confirmation = form.querySelector<HTMLInputElement>("#override-confirmation");
      if (confirmation?.checked !== true) {
        this.feedback.textContent = "Confirm that you understand the per-leg TAS impact before applying an override.";
        return;
      }
      const value = inputValue(form, "override-tas");
      const reason = inputValue(form, "override-reason");
      try {
        this.state = { ...this.state, draft: applyCruiseTasOverride(draft, profile, legId, Number(value), reason, this.dependencies.clock), unlockedLegId: undefined, hasUnsavedChanges: true, calculationPreview: undefined };
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
      const input = profileInputFromForm(form);
      if (!this.beginInputTransaction("Saving aircraft profile…")) return;
      const profile = await saveAircraftProfile(this.dependencies.persistence, input, this.dependencies.ids, this.dependencies.clock);
      this.state = { ...this.state, pendingOperation: undefined, profiles: [...this.state.profiles, profile], selectedProfileId: profile.id, hasUnsavedChanges: this.state.draft !== undefined, calculationPreview: undefined };
      this.feedback.textContent = this.state.draft === undefined
        ? `Saved aircraft profile ${profile.name}.`
        : `Saved and selected aircraft profile ${profile.name}. Save a new journal revision before calculating.`;
      this.render();
    } catch (error) {
      this.reportError(error);
    }
  }

  private async handleResolveAirports(form: HTMLFormElement): Promise<void> {
    try {
      const routeForm = routeFormFromElement(form);
      const departureIcao = inputValue(form, "departure-icao");
      const destinationIcao = inputValue(form, "destination-icao");
      if (!this.beginInputTransaction("Resolving exact ICAO endpoints…")) return;
      const [departure, destination] = await Promise.all([
        this.dependencies.airportLookup.lookupExactIcao(departureIcao),
        this.dependencies.airportLookup.lookupExactIcao(destinationIcao),
      ]);
      this.state = {
        ...this.state,
        pendingOperation: undefined,
        departure,
        destination,
        routeForm: {
          ...routeForm,
          descentTarget: this.state.descentTargetIsManual ? routeForm.descentTarget : String(destination.elevationFeetMsl + 1_000),
        },
        cruiseAltitudes: expandAltitudes(this.state.cruiseAltitudes, this.state.checkpoints.length + 1),
        availableForecasts: [],
        selectedForecastValidTimeUtc: undefined,
        hasUnsavedChanges: this.state.draft !== undefined,
        hasUnsavedForecastSelection: false,
        calculationPreview: undefined,
      };
      this.feedback.textContent = "Exact ICAO endpoints resolved from the configured aviation-data source.";
      this.render();
    } catch (error) {
      this.reportError(error);
    }
  }

  private handleAddCheckpoint(form: HTMLFormElement): void {
    try {
      const compact = inputValue(form, "checkpoint-compact").trim();
      const latitude = inputValue(form, "checkpoint-latitude").trim();
      const longitude = inputValue(form, "checkpoint-longitude").trim();
      if (compact !== "" && (latitude !== "" || longitude !== "")) throw new Error("Enter either one SkyVector coordinate or decimal latitude/longitude, not both.");
      if (compact === "" && (latitude === "" || longitude === "")) throw new Error("Enter a SkyVector coordinate or both decimal latitude and longitude.");
      const checked = compact === "" ? coordinate(Number(latitude), Number(longitude)) : parseCompactCoordinate(compact);
      if (!checked.ok) throw new Error(checked.error.message);
      const name = inputValue(form, "checkpoint-name").trim();
      if (name.length === 0) throw new Error("Checkpoint name is required.");
      const checkpoint: CheckpointRoutePoint = { kind: "checkpoint", id: this.dependencies.ids.next(), name, coordinate: checked.value };
      this.state = { ...this.state, checkpoints: [...this.state.checkpoints, checkpoint], cruiseAltitudes: expandAltitudes(this.state.cruiseAltitudes, this.state.checkpoints.length + 2), availableForecasts: [], selectedForecastValidTimeUtc: undefined, hasUnsavedChanges: this.state.draft !== undefined, hasUnsavedForecastSelection: false, calculationPreview: undefined };
      this.feedback.textContent = `Added checkpoint ${name}.`;
      this.render();
    } catch (error) {
      this.reportError(error);
    }
  }

  private removeCheckpoint(id: string): void {
    const checkpoints = this.state.checkpoints.filter((checkpoint) => checkpoint.id !== id);
    this.state = { ...this.state, checkpoints, cruiseAltitudes: reconcileCruiseAltitudes(this.state, checkpoints), availableForecasts: [], selectedForecastValidTimeUtc: undefined, hasUnsavedChanges: this.state.draft !== undefined, hasUnsavedForecastSelection: false, calculationPreview: undefined };
    this.render();
  }

  private setCruiseAltitude(index: number, value: number): void {
    if (!Number.isFinite(value) || value <= 0) {
      this.feedback.textContent = "Cruise altitude must be a positive feet-MSL value.";
      return;
    }
    const cruiseAltitudes = [...expandAltitudes(this.state.cruiseAltitudes, index + 1)];
    cruiseAltitudes[index] = value;
    this.state = { ...this.state, cruiseAltitudes, hasUnsavedChanges: this.state.draft !== undefined, calculationPreview: undefined };
  }

  private async handleSaveDraft(form: HTMLFormElement): Promise<void> {
    try {
      const profile = this.selectedProfile();
      if (profile === undefined) throw new Error("Save and select an aircraft profile before saving a plan.");
      const { draft, departure, destination } = this.draftForSave(form, profile);
      const selectedDraft = this.draftWithSelectedForecast(draft);
      const saveTarget = this.journalSaveTarget();
      if (!this.beginInputTransaction("Saving new plan revision…")) return;
      const saved = await saveDraftRevision(this.dependencies.persistence, selectedDraft, profile, this.dependencies.ids, this.dependencies.clock, ...saveTarget);
      this.state = { ...this.state, draft: saved.revision.draftSnapshot, currentRevision: saved.revision, weatherSnapshots: [], calculationPreview: undefined, inspectedCalculation: undefined, routeForm: routeFormFromDraft(saved.revision.draftSnapshot, departure.icao, destination.icao), hasUnsavedChanges: false, hasUnsavedForecastSelection: false };
      await this.refreshRevisionHistory(saved.revision.planId);
      await this.refreshSavedPlans();
      this.state = { ...this.state, pendingOperation: undefined };
      this.feedback.textContent = `Saved immutable revision ${saved.revision.id}.`;
      this.render();
    } catch (error) {
      this.reportError(error);
    }
  }

  private draftForSave(form: HTMLFormElement, profile: AircraftProfile): { readonly draft: PlanDraft; readonly departure: AirportRoutePoint; readonly destination: AirportRoutePoint } {
    const departure = this.state.departure;
    const destination = this.state.destination;
    if (departure === undefined || destination === undefined) throw new Error("Resolve exact ICAO departure and destination first.");
    const descentTargetAltitudeFeetMsl = this.state.descentTargetIsManual
      ? Number(inputValue(form, "descent-target"))
      : destination.elevationFeetMsl + 1_000;
    const rebuiltRoute = createRouteDefinition({ id: this.state.draft?.route.id, departure, checkpoints: this.state.checkpoints, destination, cruiseAltitudesFeetMsl: this.state.cruiseAltitudes }, this.dependencies.ids);
    const route = preserveMatchingLegs(rebuiltRoute, this.state.draft?.route, this.state.draft?.selectedAircraftProfileId === profile.id);
    return {
      departure,
      destination,
      draft: createPlanDraft({
        id: this.state.draft?.id,
        planId: this.state.draft?.planId,
        title: inputValue(form, "plan-title"),
        departureTimeUtc: dateTimeLocalToUtc(inputValue(form, "departure-time")),
        route,
        selectedAircraftProfileId: profile.id,
        taxiRunupFuelGallons: Number(inputValue(form, "taxi-fuel")),
        reserveFuelGallons: Number(inputValue(form, "reserve-fuel")),
        descentTargetAltitudeFeetMsl,
        descentTargetIsManual: this.state.descentTargetIsManual,
      }, this.dependencies.ids, this.dependencies.clock),
    };
  }

  private draftWithSelectedForecast(draft: PlanDraft): PlanDraft {
    const selectedTime = this.state.selectedForecastValidTimeUtc;
    if (selectedTime === undefined) return draft;
    return selectPlanWeatherForecast(
      draft,
      this.state.availableForecasts.map((period) => ({ id: period.validAt, validFromUtc: period.useFrom, validToUtc: period.useUntil })),
      selectedTime,
      this.dependencies.clock,
    );
  }

  private journalSaveTarget(): [PlanRevision | undefined, string | undefined] {
    const openedRevision = this.state.currentRevision;
    const journalHead = openedRevision === undefined ? undefined : this.currentJournalHead(openedRevision.planId);
    return [journalHead ?? openedRevision, openedRevision !== undefined && journalHead !== undefined && openedRevision.id !== journalHead.id ? openedRevision.id : undefined];
  }

  private async handleCalculatePlan(): Promise<void> {
    try {
      const calculatePlan = this.dependencies.calculatePlan;
      const draft = this.state.draft;
      const profile = this.selectedProfile();
      if (calculatePlan === undefined || draft === undefined || profile === undefined) throw new Error("Save the route and aircraft profile before calculating.");
      if (this.state.currentRevision !== undefined && this.currentJournalHead(this.state.currentRevision.planId)?.id !== this.state.currentRevision.id) {
        throw new Error("Save this historical revision as a new journal entry before calculating.");
      }
      if (this.state.hasUnsavedChanges || this.state.hasUnsavedForecastSelection) throw new Error("Save the current route, aircraft, altitude, and forecast edits as a new revision before calculating.");
      if (!this.beginInputTransaction("Calculating complete navlog…")) return;
      const result = await calculatePlan(draft, profile, this.state.currentRevision);
      if (result.status === "blocked") {
        this.feedback.textContent = `Navlog blocked: ${result.message}`;
        this.state = { ...this.state, pendingOperation: undefined, calculationPreview: result.calculationSnapshot };
        this.render();
        return;
      }
      const weatherSnapshots = await this.loadWeatherEvidence(result.revision);
      this.state = { ...this.state, draft: result.revision.draftSnapshot, currentRevision: result.revision, weatherSnapshots, calculationPreview: undefined, inspectedCalculation: undefined, hasUnsavedChanges: false, hasUnsavedForecastSelection: false };
      await this.refreshRevisionHistory(result.revision.planId);
      await this.refreshSavedPlans();
      this.state = { ...this.state, pendingOperation: undefined };
      this.feedback.textContent = `Calculated and saved complete navlog revision ${result.revision.id}.`;
      this.render();
    } catch (error) {
      this.reportError(error);
    }
  }

  private async handleRefreshWeather(): Promise<void> {
    try {
      const refresh = this.dependencies.refreshWeather;
      const parent = this.state.currentRevision;
      const selectedTime = this.state.selectedForecastValidTimeUtc;
      if (refresh === undefined || parent === undefined) throw new Error("Open a calculated revision before refreshing weather.");
      if (this.currentJournalHead(parent.planId)?.id !== parent.id) throw new Error("Save this historical revision as a new journal entry before refreshing weather.");
      if (this.state.hasUnsavedChanges) throw new Error("Save or discard current route, aircraft, or altitude edits before refreshing weather.");
      if (selectedTime === undefined) throw new Error("Load published winds periods and choose a forecast before refreshing weather.");
      const selectedDraft = selectPlanWeatherForecast(
        parent.draftSnapshot,
        this.state.availableForecasts.map((period) => ({ id: period.validAt, validFromUtc: period.useFrom, validToUtc: period.useUntil })),
        selectedTime,
        this.dependencies.clock,
      );
      if (!this.beginInputTransaction("Refreshing weather and recalculating…")) return;
      const result = await refresh(parent, selectedDraft.weatherSelection);
      if (result.status === "blocked") {
        this.feedback.textContent = `Weather refresh blocked: ${result.message}`;
        this.state = { ...this.state, pendingOperation: undefined, calculationPreview: result.calculationSnapshot };
        this.render();
        return;
      }
      const weatherSnapshots = await this.loadWeatherEvidence(result.revision);
      this.state = { ...this.state, draft: result.revision.draftSnapshot, currentRevision: result.revision, weatherSnapshots, calculationPreview: undefined, inspectedCalculation: undefined, hasUnsavedChanges: false, hasUnsavedForecastSelection: false };
      await this.refreshRevisionHistory(result.revision.planId);
      await this.refreshSavedPlans();
      this.state = { ...this.state, pendingOperation: undefined };
      this.feedback.textContent = `Weather refreshed in immutable revision ${result.revision.id}; compare it with its parent in Saved revision history.`;
      this.render();
    } catch (error) {
      this.reportError(error);
    }
  }

  private async loadWeatherEvidence(revision: PlanRevision): Promise<readonly WeatherReferenceSnapshot[]> {
    if (this.dependencies.weatherEvidence === undefined) return [];
    const snapshots = await Promise.all(revision.weatherSnapshotIds.map((id) => this.dependencies.weatherEvidence!.getWeatherSnapshot(id)));
    return snapshots.filter((snapshot): snapshot is WeatherReferenceSnapshot => snapshot !== undefined);
  }

  private selectedProfile(): AircraftProfile | undefined {
    const selectedId = this.selectedProfileId();
    return selectedId === undefined ? undefined : this.state.profiles.find((profile) => profile.id === selectedId);
  }

  private selectedProfileId(): string | undefined {
    return this.state.selectedProfileId ?? this.state.draft?.selectedAircraftProfileId;
  }

  private async handleReopenRevision(): Promise<void> {
    const revision = this.state.currentRevision;
    if (revision === undefined) return;
    await this.openRevision(revision.id);
  }

  private async openRevision(revisionId: string): Promise<void> {
    try {
      if (this.state.currentRevision !== undefined && this.state.currentRevision.id !== revisionId) {
        if (!window.confirm("Opening another saved revision may discard unsaved form and draft edits. Continue?")) return;
      }
      if (!this.beginInputTransaction("Opening saved revision…")) return;
      const reopened = await reopenPlanRevision(this.dependencies.persistence, revisionId);
      const revisions = await this.dependencies.persistence.listPlanRevisions(reopened.planId);
      const weatherSnapshots = await this.loadWeatherEvidence(reopened);
      this.state = {
        ...this.state,
        draft: reopened.draftSnapshot,
        currentRevision: reopened,
        inspectedCalculation: undefined,
        revisions,
        weatherSnapshots,
        calculationPreview: undefined,
        selectedProfileId: reopened.draftSnapshot.selectedAircraftProfileId,
        departure: firstAirport(reopened.draftSnapshot.route.points),
        destination: lastAirport(reopened.draftSnapshot.route.points),
        checkpoints: reopened.draftSnapshot.route.points.filter((point): point is CheckpointRoutePoint => point.kind === "checkpoint"),
        cruiseAltitudes: reopened.draftSnapshot.route.legs.map((leg) => leg.cruiseAltitudeFeetMsl),
        availableForecasts: [],
        selectedForecastValidTimeUtc: undefined,
        descentTargetIsManual: reopened.draftSnapshot.descentTargetAltitudeFeetMsl.origin === "pilot-input",
        hasUnsavedChanges: false,
        hasUnsavedForecastSelection: false,
        routeForm: routeFormFromDraft(reopened.draftSnapshot, firstAirport(reopened.draftSnapshot.route.points)?.icao ?? "", lastAirport(reopened.draftSnapshot.route.points)?.icao ?? ""),
      };
      this.state = { ...this.state, pendingOperation: undefined };
      this.feedback.textContent = this.currentJournalHead(reopened.planId)?.id === reopened.id
        ? `Opened current journal revision ${reopened.revisionNumber}.`
        : `Opened historical revision ${reopened.revisionNumber}; saving restores it as a new current journal entry.`;
      this.render();
    } catch (error) {
      this.reportError(error);
    }
  }

  private async refreshRevisionHistory(planId: string): Promise<void> {
    this.state = { ...this.state, revisions: await this.dependencies.persistence.listPlanRevisions(planId) };
  }

  private async refreshSavedPlans(): Promise<void> {
    this.state = { ...this.state, families: await this.dependencies.persistence.listPlanFamilies() };
  }

  private currentJournalHead(planId: string): PlanRevision | undefined {
    const latestId = this.state.families.find((family) => family.id === planId)?.latestRevisionId;
    const persistedHead = latestId === undefined ? undefined : this.state.revisions.find((revision) => revision.id === latestId);
    if (persistedHead !== undefined && (this.state.currentRevision?.planId !== planId || this.state.currentRevision.revisionNumber <= persistedHead.revisionNumber)) return persistedHead;
    // A calculator owns its persistence write. Keep hermetic browser adapters
    // and their immediate result usable until the next storage refresh.
    return this.state.currentRevision?.planId === planId && !this.state.revisions.some((revision) => revision.id === this.state.currentRevision?.id)
      ? this.state.currentRevision
      : undefined;
  }

  private reportError(error: unknown): void {
    const hadPendingOperation = this.state.pendingOperation !== undefined;
    if (hadPendingOperation) this.state = { ...this.state, pendingOperation: undefined };
    this.feedback.textContent = error instanceof Error ? error.message : "The requested action could not be completed.";
    if (hadPendingOperation) this.render();
  }

  /** Locks all controls so an asynchronous result cannot overwrite a newer edit. */
  private beginInputTransaction(message: string): boolean {
    if (this.state.pendingOperation !== undefined) return false;
    this.state = { ...this.state, pendingOperation: message };
    this.feedback.textContent = message;
    this.render();
    return true;
  }

  private syncRouteFormInput(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const field = routeFormField(input.name);
    if (field === undefined) return;
    this.state = field === "departureTime"
      ? { ...this.state, routeForm: { ...this.state.routeForm, [field]: input.value }, availableForecasts: [], selectedForecastValidTimeUtc: undefined, hasUnsavedChanges: this.state.draft !== undefined, hasUnsavedForecastSelection: false, calculationPreview: undefined }
      : field === "descentTarget"
        ? { ...this.state, routeForm: { ...this.state.routeForm, [field]: input.value }, descentTargetIsManual: input.value.trim() !== "", hasUnsavedChanges: this.state.draft !== undefined, calculationPreview: undefined }
      : field === "departureIcao"
          ? { ...this.state, routeForm: { ...this.state.routeForm, [field]: input.value }, departure: undefined, availableForecasts: [], selectedForecastValidTimeUtc: undefined, hasUnsavedChanges: this.state.draft !== undefined, hasUnsavedForecastSelection: false, calculationPreview: undefined }
      : field === "destinationIcao"
            ? { ...this.state, routeForm: { ...this.state.routeForm, [field]: input.value }, destination: undefined, availableForecasts: [], selectedForecastValidTimeUtc: undefined, hasUnsavedChanges: this.state.draft !== undefined, hasUnsavedForecastSelection: false, calculationPreview: undefined }
        : { ...this.state, routeForm: { ...this.state.routeForm, [field]: input.value }, hasUnsavedChanges: this.state.draft !== undefined, calculationPreview: undefined };
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

function overrideConfirmation(): HTMLLabelElement {
  const wrapper = document.createElement("label");
  wrapper.htmlFor = "override-confirmation";
  const input = document.createElement("input");
  input.id = "override-confirmation";
  input.type = "checkbox";
  input.required = true;
  wrapper.append(input, document.createTextNode(" I understand that this deliberately replaces the aircraft default for this leg only."));
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
  const endpoints = routePointsWithCheckpoints(state, state.checkpoints);
  return endpoints.length > 0 ? endpoints : (state.draft?.route.points ?? []);
}

function routePointsWithCheckpoints(state: PlannerState, checkpoints: readonly CheckpointRoutePoint[]): readonly RoutePoint[] {
  return state.departure === undefined || state.destination === undefined ? [] : [state.departure, ...checkpoints, state.destination];
}

function reconcileCruiseAltitudes(state: PlannerState, nextCheckpoints: readonly CheckpointRoutePoint[]): readonly number[] {
  const previousPoints = routePoints(state);
  const previousAltitudes = expandAltitudes(state.cruiseAltitudes, Math.max(0, previousPoints.length - 1));
  const altitudeByEndpoints = new Map<string, number>();
  previousAltitudes.forEach((altitude, index) => {
    const from = previousPoints[index];
    const to = previousPoints[index + 1];
    if (from !== undefined && to !== undefined) altitudeByEndpoints.set(`${from.id}->${to.id}`, altitude);
  });
  const nextPoints = routePointsWithCheckpoints(state, nextCheckpoints);
  return Array.from({ length: Math.max(0, nextPoints.length - 1) }, (_, index) => {
    const from = nextPoints[index];
    const to = nextPoints[index + 1];
    return from === undefined || to === undefined ? 4_500 : altitudeByEndpoints.get(`${from.id}->${to.id}`) ?? 4_500;
  });
}

/**
 * A per-leg override is meaningful only while the route keeps the same ordered
 * endpoints. Retaining it across an endpoint or checkpoint change could apply
 * a pilot decision to a different leg, so those route edits intentionally get
 * newly generated legs instead.
 */
function preserveMatchingLegs(route: ReturnType<typeof createRouteDefinition>, existing: PlanDraft["route"] | undefined, preservePerformanceOverrides: boolean): ReturnType<typeof createRouteDefinition> {
  if (existing === undefined || route.legs.length !== existing.legs.length) return route;
  const hasMatchingEndpoints = route.legs.every((leg, index) => {
    const previous = existing.legs[index];
    return previous !== undefined && leg.fromPointId === previous.fromPointId && leg.toPointId === previous.toPointId;
  });
  if (!hasMatchingEndpoints) return route;
  return {
    ...route,
    legs: route.legs.map((leg, index) => {
      const previous = existing.legs[index];
      if (previous === undefined) return leg;
      return {
        ...leg,
        id: previous.id,
        ...(!preservePerformanceOverrides || previous.performanceOverrides === undefined ? {} : { performanceOverrides: previous.performanceOverrides }),
      };
    }),
  };
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
    tas: `${tas ?? "—"} kt${override === undefined ? " (aircraft default)" : " (OVERRIDDEN)"}`,
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

function isCalculatedRevision(revision: PlanRevision | undefined): boolean {
  const snapshot = revision?.calculationSnapshot;
  return typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot) && "schema" in snapshot && snapshot.schema === "complete-navlog/v1" && "status" in snapshot && snapshot.status === "calculated";
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
    labeledInput("descent-target", "Arrival descent target (ft MSL; defaults to destination field elevation + 1,000 ft)", values.descentTarget, "number"),
  ];
}

function routeAirportFields(values: RouteFormValues): readonly HTMLLabelElement[] {
  return [
    labeledInput("departure-icao", "Departure ICAO", values.departureIcao, "text"),
    labeledInput("destination-icao", "Destination ICAO", values.destinationIcao, "text"),
  ];
}

function emptyRouteForm(): RouteFormValues {
  return { title: "New study route", departureTime: "", taxiFuel: "0", reserveFuel: "0", descentTarget: "", departureIcao: "", destinationIcao: "" };
}

function routeFormFromDraft(draft: PlanDraft, departureIcao: string, destinationIcao: string): RouteFormValues {
  return {
    title: draft.title,
    departureTime: draft.departureTimeUtc.slice(0, 16),
    taxiFuel: String(draft.fuelInputs.taxiRunupFuelGallons),
    reserveFuel: String(draft.fuelInputs.reserveFuelGallons),
    descentTarget: String(draft.descentTargetAltitudeFeetMsl.effectiveValue),
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
    "descent-target": "descentTarget",
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
    descentTarget: inputValue(form, "descent-target"),
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
    compassDeviationTable: parseCompassDeviationCard(inputValue(form, "compass-deviation-card")),
  };
}

function parseCompassDeviationCard(value: string): readonly CompassDeviationEntry[] {
  const entries = value.trim().split(/[;,\n]+/).map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error("Enter at least one compass-deviation card point, for example 000: 0.");
  if (entries.length > 360) throw new Error("Compass-deviation card supports at most 360 points.");
  const headings = new Set<number>();
  return entries.map((entry) => {
    const match = /^(\d+(?:\.\d+)?)\s*:\s*([+-]?\d+(?:\.\d+)?)$/.exec(entry);
    if (match === null) throw new Error(`Compass-deviation entry "${entry}" must use magnetic-heading: signed-degrees, for example 090: -2.`);
    const magneticHeadingDegrees = Number(match[1]);
    const deviationDegrees = Number(match[2]);
    if (!Number.isFinite(magneticHeadingDegrees) || magneticHeadingDegrees < 0 || magneticHeadingDegrees >= 360) {
      throw new Error("Compass-deviation magnetic headings must be at least 0 and less than 360 degrees.");
    }
    if (!Number.isFinite(deviationDegrees) || deviationDegrees < -180 || deviationDegrees > 180) {
      throw new Error("Compass-deviation values must be between -180 and 180 degrees.");
    }
    if (headings.has(magneticHeadingDegrees)) throw new Error(`Compass-deviation card has duplicate magnetic heading ${magneticHeadingDegrees}.`);
    headings.add(magneticHeadingDegrees);
    return { magneticHeadingDegrees, deviationDegrees };
  });
}
