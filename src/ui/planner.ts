import { coordinate } from "../domain/coordinates";
import { selectNearestWindsStation } from "../domain/weather-stations";
import { parseCompactCoordinate } from "../domain/coordinate-input";
import type { AircraftProfile, AircraftProfileInput, CompassDeviationEntry } from "../domain/aircraft";
import type { AirportRoutePoint, CheckpointRoutePoint, JsonValue, PlanDraft, PlanFamily, PlanRevision, PlanWeatherSelection, RoutePoint, UserRouteLeg, WeatherReferenceSnapshot } from "../domain/route";
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
import type { WindsForecastAvailability, WindsForecastCycle } from "../../worker/api/contracts";
import type { BrowserPlanCalculator } from "../application/browser-plan-calculator";
import type { BrowserWeatherRefresh } from "../application/browser-weather-refresh";
import { selectForecastValidTime } from "../domain/weather-valid-time";
import { renderCalculatedNavlog } from "./calculated-navlog";
import { renderRevisionHistory } from "./revision-history";
import { renderWorkspaceLayout } from "./workspace-layout";
import { renderCalculationInspector, type NavlogInspectionSelection } from "./calculation-inspector";
import { routeCoordinatesDistanceMidpoint } from "../application/weather-station-reference";

export interface PlannerDependencies {
  readonly airportLookup: AirportLookup;
  readonly persistence: NavlogPersistence;
  readonly ids: UseCaseIds;
  readonly clock: UseCaseClock;
  readonly winds?: WindsTransportClient;
  readonly calculatePlan?: BrowserPlanCalculator;
  readonly refreshWeather?: BrowserWeatherRefresh;
  readonly weatherEvidence?: { getWeatherSnapshot(id: string): Promise<WeatherReferenceSnapshot | undefined> };
}

interface PlannerState {
  readonly profiles: readonly AircraftProfile[];
  /** Undefined defers to an opened draft; null is the user's explicit no-profile choice. */
  readonly selectedProfileId?: string | null;
  /** Raw aircraft form values survive unrelated planner renders until saved or a profile is selected. */
  readonly profileDraft?: Readonly<Record<string, string>>;
  readonly routeForm: RouteFormValues;
  readonly descentTargetIsManual: boolean;
  readonly departure?: AirportRoutePoint;
  readonly destination?: AirportRoutePoint;
  readonly checkpoints: readonly CheckpointRoutePoint[];
  readonly cruiseAltitudes: readonly number[];
  /** Editor validation prevents stale saved altitudes from reaching a new revision or calculation. */
  readonly invalidCruiseAltitudeIndexes: readonly number[];
  readonly draft?: PlanDraft;
  readonly currentRevision?: PlanRevision;
  /** The explicitly chosen saved draft leg being edited; never inferred. */
  readonly selectedTasLegId?: string;
  readonly unlockedLegId?: string;
  readonly inspectedCalculation?: NavlogInspectionSelection;
  readonly availableForecasts: readonly WindsForecastAvailability[];
  readonly unavailableForecastCycles: readonly WindsForecastCycle[];
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
  readonly surfaceWeatherIcao: string;
}

type SaveWeatherDecision =
  | { readonly kind: "replacement"; readonly forecastValidTimeUtc: string; readonly surfaceWeatherIcao?: string }
  | { readonly kind: "inherited"; readonly selection: PlanWeatherSelection }
  | { readonly kind: "no-weather" }
  | { readonly kind: "blocked"; readonly reason: string };

interface SaveWeatherDecisionInput {
  readonly savedDraft?: PlanDraft;
  readonly currentRoutePoints: readonly (RoutePoint | undefined)[];
  readonly departureTimeUtc?: string;
  readonly selectedForecastValidTimeUtc?: string;
  readonly availablePeriods: readonly { readonly id: string; readonly validFromUtc: string; readonly validToUtc: string }[];
  readonly surfaceWeatherIcao?: string;
}

type WorkflowAction = "resolve-airports" | "load-winds" | "save-draft" | "calculate" | "refresh-weather";

export function renderPlanner(root: HTMLElement, dependencies: PlannerDependencies): void {
  const planner = new Planner(root, dependencies);
  void planner.initialize();
}

class Planner {
  private state: PlannerState = { profiles: [], checkpoints: [], cruiseAltitudes: [], invalidCruiseAltitudeIndexes: [], availableForecasts: [], unavailableForecastCycles: [], weatherSnapshots: [], revisions: [], families: [], routeForm: emptyRouteForm(), descentTargetIsManual: false, hasUnsavedChanges: false, hasUnsavedForecastSelection: false };
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
    const fields = profileFields(this.effectiveProfile(), this.state.profileDraft);
    fields.forEach(([id, label, value]) => form.append(labeledInput(id, label, value, id === "profile-name" || id === "compass-deviation-card" ? "text" : "number")));
    form.append(text("p", "Enter card points such as 000:+1, 090:-1. A single point applies a constant deviation at every heading. The default 000: 0 is an explicit study-only zero-deviation assumption; replace it with the aircraft’s compass-deviation card when available."));
    form.append(button(this.selectedProfile() === undefined ? "Save aircraft profile" : "Save new aircraft profile version", "submit"));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.handleSaveProfile(form);
    });
    form.addEventListener("input", (event) => this.syncProfileFormInput(event));
    section.append(form, this.renderProfileSelect(), text("p", "Aircraft profiles are immutable inputs. Saving changes to a selected profile creates a new version; existing plan revisions continue to use their original profile."));
    return section;
  }

  private renderProfileSelect(): HTMLElement {
    const wrapper = document.createElement("label");
    wrapper.textContent = "Selected aircraft profile";
    const select = document.createElement("select");
    select.name = "selected-profile";
    select.append(new Option("Choose a saved profile", ""));
    this.state.profiles.forEach((profile) => select.append(new Option(profileOptionLabel(profile), profile.id, false, profile.id === this.selectedProfileId())));
    select.addEventListener("change", () => {
      this.state = {
        ...this.state,
        selectedProfileId: select.value === "" ? null : select.value,
        profileDraft: undefined,
        inspectedCalculation: undefined,
        hasUnsavedChanges: this.state.draft !== undefined,
        calculationPreview: undefined,
      };
      this.feedback.textContent = select.value === ""
        ? "No aircraft profile selected. New aircraft profile form selected; enter its values, then save it before planning."
        : this.state.draft === undefined
          ? "Selected aircraft profile."
          : "Aircraft profile changed. Save a new revision before calculating; prior per-leg overrides will be cleared.";
      this.render();
    });
    wrapper.append(select);
    return wrapper;
  }

  private renderRoutePanel(): HTMLElement {
    const section = panel("Route draft", "Enter an exact FAA LID or ICAO airport code. Airport coordinates and field elevations come from the configured aviation-data Worker; the app never invents a missing prefix.");
    const form = this.createRouteForm();
    const saveButton = workflowButton("Save new plan revision", "button", "save-draft", this.workflowUnavailableReason("save-draft"));
    saveButton.addEventListener("click", () => void this.handleSaveDraft(form));
    section.append(this.renderSavedPlans(), form, this.renderCheckpointPanel(), this.renderLegAltitudePanel(), this.renderTasEditor(), this.renderForecastPanel(), saveButton, actionStatus("save-draft", this.workflowUnavailableReason("save-draft")));
    if (this.dependencies.calculatePlan !== undefined) {
      const calculateButton = workflowButton("Calculate complete navlog", "button", "calculate", this.workflowUnavailableReason("calculate"));
      calculateButton.addEventListener("click", () => void this.handleCalculatePlan());
      section.append(calculateButton, actionStatus("calculate", this.workflowUnavailableReason("calculate")));
    }
    if (this.dependencies.refreshWeather !== undefined && isCalculatedRevision(this.state.currentRevision)) {
      section.append(text("p", "Weather refresh uses the open saved revision's route, aircraft, and departure time; save any input edits first."));
      const refreshButton = workflowButton("Refresh weather into new revision", "button", "refresh-weather", this.workflowUnavailableReason("refresh-weather"));
      refreshButton.addEventListener("click", () => void this.handleRefreshWeather());
      section.append(refreshButton, actionStatus("refresh-weather", this.workflowUnavailableReason("refresh-weather")));
    }
    this.appendReopenControl(section);
    if (this.state.draft !== undefined) section.append(renderRevisionHistory({
      revisions: this.state.revisions,
      selectedRevisionId: this.state.currentRevision?.id,
      onSelect: (id) => void this.openRevision(id),
    }));
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
    const resolveButton = workflowButton("Resolve airport endpoints", "button", "resolve-airports", this.workflowUnavailableReason("resolve-airports"));
    form.append(...routeBasicFields(this.state.routeForm), ...routeAirportFields(this.state.routeForm), resolveButton, actionStatus("resolve-airports", this.workflowUnavailableReason("resolve-airports")));
    form.append(text("p", "When a selected METAR is fresh and usable, its wind is anchored at the departure field elevation; otherwise the calculation uses winds aloft only. Station proximity is not verified. Entering a destination station here still treats it as a departure source, not an arrival source. The current calculation uses one wind profile across the route. Route-aware weather is planned; check arrival weather separately."));
    form.addEventListener("input", (event) => this.syncRouteFormInput(event));
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
      const input = field.querySelector("input");
      if (input !== null) {
        input.min = "1";
        input.setAttribute("aria-invalid", String(this.state.invalidCruiseAltitudeIndexes.includes(index)));
        input.addEventListener("change", () => this.setCruiseAltitude(index, input.value, input));
      }
      wrapper.append(field);
    });
    if (points.length < 2) wrapper.append(text("p", "Resolve departure and destination before defining leg altitudes."));
    return wrapper;
  }

  private renderTasEditor(): HTMLElement {
    const section = document.createElement("section");
    section.className = "tas-editor";
    section.append(text("h3", "Per-leg cruise TAS"));
    const draft = this.state.draft;
    const profile = this.effectiveProfile();
    if (draft === undefined || profile === undefined) {
      section.append(text("p", "Save a route draft and select an aircraft profile before editing a leg's cruise TAS."));
      return section;
    }
    let selectedLeg = draft.route.legs.find((leg) => leg.id === this.state.selectedTasLegId);
    if (this.state.selectedTasLegId !== undefined && selectedLeg === undefined) {
      this.state = { ...this.state, selectedTasLegId: undefined, unlockedLegId: undefined };
      selectedLeg = undefined;
    }
    if (selectedLeg !== undefined) {
      const labels = navlogLabels(draft.route.points, profile, selectedLeg);
      section.append(text("p", `Selected draft leg: ${labels.from} → ${labels.to}.`));
      const override = selectedLeg.performanceOverrides?.cruiseTasKnots;
      section.append(text("p", `Cruise TAS aircraft default: ${profile.cruiseTasKnots} kt from ${profile.name}.`));
      if (override !== undefined) {
        section.append(text("p", `OVERRIDDEN effective TAS: ${override.effectiveValue} kt. Preserved aircraft default: ${override.computedValue} kt.`));
        const restore = button("Restore aircraft default", "button");
        restore.addEventListener("click", () => {
          this.state = { ...this.state, draft: restoreCruiseTasDefault(draft, selectedLeg.id, this.dependencies.clock), inspectedCalculation: undefined, unlockedLegId: undefined, hasUnsavedChanges: true, calculationPreview: undefined };
          this.feedback.textContent = "Restored the aircraft TAS default for this leg. Save a new revision before calculating.";
          this.render();
        });
        section.append(restore);
      } else if (this.state.unlockedLegId !== selectedLeg.id) {
        const unlock = button("Override TAS for this leg", "button");
        unlock.addEventListener("click", () => {
          this.state = { ...this.state, unlockedLegId: selectedLeg.id };
          this.feedback.textContent = "Opened the deliberate TAS override editor for this leg.";
          this.render();
        });
        section.append(unlock);
      } else {
        section.append(this.renderOverrideForm(draft, profile, selectedLeg.id));
      }
    }
    const list = document.createElement("ul");
    draft.route.legs.forEach((leg) => {
      const labels = navlogLabels(draft.route.points, profile, leg);
      const item = document.createElement("li");
      item.append(`${labels.from} → ${labels.to} `);
      const edit = button("Edit TAS", "button");
      edit.addEventListener("click", () => {
        this.state = { ...this.state, selectedTasLegId: leg.id, unlockedLegId: undefined };
        this.feedback.textContent = `Selected ${labels.from} to ${labels.to} for TAS editing.`;
        this.render();
      });
      item.append(edit);
      list.append(item);
    });
    section.append(list);
    return section;
  }

  private renderForecastPanel(): HTMLElement {
    const section = document.createElement("section");
    section.className = "forecast-selection";
    section.append(text("h3", "Winds forecast period"), text("p", "Load published periods, then choose one explicitly. The nearest reporting station is measured from the route's distance midpoint; V1 does not spatially blend stations."));
    if (this.dependencies.winds === undefined) {
      section.append(text("p", "Live winds selection is unavailable in this environment."));
      return section;
    }
    const load = workflowButton("Load available winds periods", "button", "load-winds", this.workflowUnavailableReason("load-winds"));
    load.addEventListener("click", () => void this.handleLoadForecastPeriods());
    section.append(load, actionStatus("load-winds", this.workflowUnavailableReason("load-winds")));
    if (this.state.unavailableForecastCycles.length > 0) section.append(text("p", `Availability is incomplete because forecast cycles ${this.state.unavailableForecastCycles.join(", ")} could not be checked. Listed periods are confirmed published products; missing periods are unknown.`));
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
        inspectedCalculation: undefined,
        hasUnsavedForecastSelection: weatherSelectionIsDirty(this.state.draft, this.effectiveForecastValidTimeUtc(selectedForecastValidTimeUtc ?? null), this.state.routeForm.surfaceWeatherIcao),
        calculationPreview: undefined,
      };
      this.feedback.textContent = selectedForecastValidTimeUtc === undefined
        ? "No winds period selected. Select a published period before saving it into a plan revision."
        : `Selected winds period ${selectedForecastValidTimeUtc}. Save a new plan revision to attach it to the route.`;
      this.refreshCalculationInspector();
      this.refreshWorkflowAvailability();
    });
    label.append(select);
    section.append(label);
    return section;
  }

  private async handleLoadForecastPeriods(): Promise<void> {
    try {
      const winds = this.dependencies.winds;
      if (winds === undefined) throw new Error("Live winds selection is unavailable.");
      if (this.state.departure === undefined || this.state.destination === undefined) throw new Error("Resolve the route endpoints before loading winds periods.");
      const points = routePointsWithCheckpoints(this.state, this.state.checkpoints);
      if (!this.beginInputTransaction("Loading published winds periods…")) return;
      const discovery = await winds.discoverStations(points.map((point) => point.coordinate));
      const midpoint = routeCoordinatesDistanceMidpoint(points.map((point) => point.coordinate));
      const candidates = discovery.stations.map((station) => {
        const location = coordinate(station.coordinates.latitudeDeg, station.coordinates.longitudeDeg);
        if (!location.ok) throw new Error("A discovered winds station has invalid coordinates.");
        return { id: station.id, coordinate: location.value };
      });
      const selectedStation = selectNearestWindsStation(midpoint, candidates);
      if (!selectedStation.ok) throw new Error(selectedStation.error.message);
      const selectedStationForecasts = discovery.forecasts.filter((forecast) => forecast.stationId === selectedStation.value.station.id);
      this.state = {
        ...this.state,
        pendingOperation: undefined,
        availableForecasts: selectedStationForecasts,
        unavailableForecastCycles: discovery.unavailableForecastCycles,
        selectedForecastValidTimeUtc: undefined,
        hasUnsavedForecastSelection: weatherSelectionIsDirty(this.state.draft, this.effectiveForecastValidTimeUtc(null), this.state.routeForm.surfaceWeatherIcao),
        calculationPreview: undefined,
      };
      this.feedback.textContent = selectedStationForecasts.length === 0
        ? `The nearest verified winds station ${selectedStation.value.station.id} has no published forecast periods, so it cannot be used as a wind source.`
        : `Loaded ${selectedStationForecasts.length} published winds period(s) for nearest station ${selectedStation.value.station.id}; choose one explicitly.`;
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
      if (this.hasUnsavedPlanInputs()) section.append(text("p", "Viewing the saved revision. Route, aircraft, altitude, or forecast edits are unsaved and cannot be calculated until saved."));
      const calculated = renderCalculatedNavlog(this.state.currentRevision, {
        selected: this.state.inspectedCalculation,
        onInspect: (selection) => this.inspectCalculation(selection),
      });
      if (calculated !== undefined) {
        section.append(calculated);
        section.append(this.renderRawWeatherEvidence());
        if (isCalculatedRevision(this.state.currentRevision)) {
          const print = button("Print / Save PDF", "button");
          print.classList.add("print-navlog-action");
          print.addEventListener("click", () => this.printCurrentRevision());
          section.append(print);
        }
        return section;
      }
    }
    const profile = this.effectiveProfile();
    section.append(text("p", "Draft route only. Course, heading, wind, distance, time, and fuel are available after you save the route and choose Calculate complete navlog. A dash means not yet calculated."));
    const table = document.createElement("table");
    table.append(createNavlogHeader());
    const body = document.createElement("tbody");
    const points = routePoints(this.state);
    this.state.draft?.route.legs.forEach((leg) => this.appendNavlogRow(body, points, profile, leg));
    table.append(body);
    const scroll = document.createElement("div");
    scroll.className = "navlog-table-scroll draft-navlog";
    scroll.append(table);
    section.append(scroll);
    if (this.state.draft === undefined) section.append(text("p", "Save a route draft to populate the table."));
    return section;
  }

  private printCurrentRevision(): void {
    const revision = this.state.currentRevision;
    if (revision === undefined) return;
    const completeEvidence = revision.weatherSnapshotIds.length > 0 && revision.weatherSnapshotIds.every(
      (id) => this.state.weatherSnapshots.some((snapshot) => snapshot.id === id),
    );
    const panel = this.content.querySelector<HTMLElement>('[data-region="navlog"]');
    if (!isCalculatedRevision(revision) || !completeEvidence || panel === null) {
      this.feedback.textContent = "Only a complete saved calculated revision with weather evidence can be printed.";
      return;
    }
    this.feedback.textContent = "Opening the browser print dialog. Choose Save as PDF to create a PDF artifact.";
    const cleanup = (): void => {
      document.body.classList.remove("printing-navlog");
      window.removeEventListener("afterprint", cleanup);
    };
    document.body.classList.add("printing-navlog");
    window.addEventListener("afterprint", cleanup, { once: true });
    try {
      window.print();
    } catch (error) {
      cleanup();
      this.reportError(error);
    }
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
    for (let index = 0; index < 8; index += 1) row.append(cell("—"));
    row.append(cell("—"));
    body.append(row);
  }

  private renderInspector(): HTMLElement {
    const section = panel("Calculation Inspector", "Select a calculated worksheet value to inspect its inputs, intermediate results, and source.");
    section.append(renderCalculationInspector(this.state.currentRevision, this.state.inspectedCalculation));
    return section;
  }

  private inspectCalculation(selection: NavlogInspectionSelection): void {
    this.state = { ...this.state, inspectedCalculation: selection };
    this.content.querySelectorAll<HTMLButtonElement>(".navlog-value").forEach((control) => {
      control.setAttribute("aria-pressed", String(control.dataset.rowIndex === String(selection.rowIndex) && control.dataset.inspectField === selection.field));
    });
    const inspector = this.refreshCalculationInspector();
    if (inspector === undefined) return;
    inspector.querySelector<HTMLElement>(".calculation-inspector h3")?.focus();
    inspector.scrollIntoView?.({ block: "nearest" });
  }

  private refreshCalculationInspector(): HTMLElement | undefined {
    const selection = this.state.inspectedCalculation;
    this.content.querySelectorAll<HTMLButtonElement>(".navlog-value").forEach((control) => {
      control.setAttribute("aria-pressed", String(selection !== undefined && control.dataset.rowIndex === String(selection.rowIndex) && control.dataset.inspectField === selection.field));
    });
    const current = this.content.querySelector<HTMLElement>('[data-region="inspector"]');
    if (current === null) return undefined;
    const inspector = this.renderInspector();
    inspector.dataset.region = "inspector";
    current.replaceWith(inspector);
    return inspector;
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
      this.feedback.textContent = "TAS override canceled; no route values changed.";
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
        this.state = { ...this.state, draft: applyCruiseTasOverride(draft, profile, legId, Number(value), reason, this.dependencies.clock), inspectedCalculation: undefined, unlockedLegId: undefined, hasUnsavedChanges: true, calculationPreview: undefined };
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
      const existingProfile = this.selectedProfile();
      if (!this.beginInputTransaction("Saving aircraft profile…")) return;
      const profile = await saveAircraftProfile(this.dependencies.persistence, input, this.dependencies.ids, this.dependencies.clock);
      this.state = {
        ...this.state,
        pendingOperation: undefined,
        profiles: [...this.state.profiles, profile],
        selectedProfileId: profile.id,
        profileDraft: undefined,
        inspectedCalculation: undefined,
        hasUnsavedChanges: this.state.draft !== undefined,
        calculationPreview: undefined,
      };
      this.feedback.textContent = existingProfile === undefined
        ? this.state.draft === undefined
          ? `Saved aircraft profile ${profile.name}.`
          : `Saved and selected aircraft profile ${profile.name}. Save a new journal revision before calculating.`
        : this.state.draft === undefined
          ? `Saved new aircraft profile version ${profile.name}.`
          : `Saved new aircraft profile version ${profile.name}. Save a new journal revision before calculating.`;
      this.render();
    } catch (error) {
      this.reportError(error);
    }
  }

  private async handleResolveAirports(form: HTMLFormElement): Promise<void> {
    try {
      const routeForm = routeFormFromElement(form);
      const departureCode = inputValue(form, "departure-icao");
      const destinationCode = inputValue(form, "destination-icao");
      if (!this.beginInputTransaction("Resolving airport endpoints…")) return;
      const [departure, destination] = await Promise.all([
        this.dependencies.airportLookup.lookupAirportCode(departureCode),
        this.dependencies.airportLookup.lookupAirportCode(destinationCode),
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
        invalidCruiseAltitudeIndexes: [],
        inspectedCalculation: undefined,
        selectedTasLegId: undefined,
        unlockedLegId: undefined,
        availableForecasts: [],
        unavailableForecastCycles: [],
        selectedForecastValidTimeUtc: undefined,
        hasUnsavedChanges: this.state.draft !== undefined,
        hasUnsavedForecastSelection: false,
        calculationPreview: undefined,
      };
      this.feedback.textContent = `Resolved airport endpoints: ${departure.icao} and ${destination.icao}.`;
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
      this.state = { ...this.state, checkpoints: [...this.state.checkpoints, checkpoint], selectedTasLegId: undefined, unlockedLegId: undefined, inspectedCalculation: undefined, cruiseAltitudes: expandAltitudes(this.state.cruiseAltitudes, this.state.checkpoints.length + 2), invalidCruiseAltitudeIndexes: [], availableForecasts: [], unavailableForecastCycles: [], selectedForecastValidTimeUtc: undefined, hasUnsavedChanges: this.state.draft !== undefined, hasUnsavedForecastSelection: false, calculationPreview: undefined };
      this.feedback.textContent = `Added checkpoint ${name}.`;
      this.render();
    } catch (error) {
      this.reportError(error);
    }
  }

  private removeCheckpoint(id: string): void {
    const removed = this.state.checkpoints.find((checkpoint) => checkpoint.id === id);
    const checkpoints = this.state.checkpoints.filter((checkpoint) => checkpoint.id !== id);
    this.state = { ...this.state, checkpoints, selectedTasLegId: undefined, unlockedLegId: undefined, inspectedCalculation: undefined, cruiseAltitudes: reconcileCruiseAltitudes(this.state, checkpoints), invalidCruiseAltitudeIndexes: [], availableForecasts: [], unavailableForecastCycles: [], selectedForecastValidTimeUtc: undefined, hasUnsavedChanges: this.state.draft !== undefined, hasUnsavedForecastSelection: false, calculationPreview: undefined };
    this.feedback.textContent = removed === undefined ? "Checkpoint was already absent." : `Removed checkpoint ${removed.name}.`;
    this.render();
  }

  private setCruiseAltitude(index: number, rawValue: string, input: HTMLInputElement): void {
    const value = Number(rawValue);
    if (rawValue.trim() === "" || !Number.isFinite(value) || value <= 0) {
      input.setAttribute("aria-invalid", "true");
      this.state = {
        ...this.state,
        invalidCruiseAltitudeIndexes: [...new Set([...this.state.invalidCruiseAltitudeIndexes, index])],
        inspectedCalculation: undefined,
        hasUnsavedChanges: this.state.draft !== undefined,
        calculationPreview: undefined,
      };
      this.feedback.textContent = "Cruise altitude must be a positive feet-MSL value.";
      this.refreshCalculationInspector();
      this.refreshWorkflowAvailability();
      return;
    }
    input.setAttribute("aria-invalid", "false");
    const cruiseAltitudes = [...expandAltitudes(this.state.cruiseAltitudes, index + 1)];
    cruiseAltitudes[index] = value;
    this.state = { ...this.state, cruiseAltitudes, invalidCruiseAltitudeIndexes: this.state.invalidCruiseAltitudeIndexes.filter((invalidIndex) => invalidIndex !== index), inspectedCalculation: undefined, hasUnsavedChanges: this.state.draft !== undefined, calculationPreview: undefined };
    this.refreshCalculationInspector();
    this.refreshWorkflowAvailability();
  }

  private async handleSaveDraft(form: HTMLFormElement): Promise<void> {
    try {
      this.requireValidCruiseAltitudes("saving a plan");
      if (this.state.profileDraft !== undefined) throw new Error("Save the aircraft profile version before saving a plan.");
      const profile = this.selectedProfile();
      if (profile === undefined) throw new Error("Save and select an aircraft profile before saving a plan.");
      const { draft, departure, destination } = this.draftForSave(form, profile);
      const weatherDecision = this.saveWeatherDecision(this.state.selectedForecastValidTimeUtc, draft, inputValue(form, "surface-weather-icao"));
      const unavailableReason = this.draftSavingUnavailableReason(weatherDecision);
      if (unavailableReason !== undefined) throw new Error(unavailableReason);
      const selectedDraft = this.draftWithSaveWeatherDecision(draft, weatherDecision);
      const saveTarget = this.journalSaveTarget();
      if (!this.beginInputTransaction("Saving new plan revision…")) return;
      const saved = await saveDraftRevision(this.dependencies.persistence, selectedDraft, profile, this.dependencies.ids, this.dependencies.clock, ...saveTarget);
      this.state = { ...this.state, draft: saved.revision.draftSnapshot, currentRevision: saved.revision, weatherSnapshots: [], calculationPreview: undefined, inspectedCalculation: undefined, selectedTasLegId: undefined, unlockedLegId: undefined, routeForm: routeFormFromDraft(saved.revision.draftSnapshot, departure.icao, destination.icao), hasUnsavedChanges: false, hasUnsavedForecastSelection: false };
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
    if (departure === undefined || destination === undefined) throw new Error("Resolve the departure and destination airport codes first.");
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

  private draftWithSaveWeatherDecision(draft: PlanDraft, decision: SaveWeatherDecision): PlanDraft {
    switch (decision.kind) {
      case "replacement": {
        const selectedAtUtc = this.dependencies.clock.now().toISOString();
        return {
          ...draft,
          updatedAt: selectedAtUtc,
          weatherSelection: {
            forecastValidTimeUtc: decision.forecastValidTimeUtc,
            selectedAtUtc,
            ...(decision.surfaceWeatherIcao === undefined ? {} : { surfaceWeatherIcao: decision.surfaceWeatherIcao }),
          },
        };
      }
      case "inherited": return { ...draft, weatherSelection: decision.selection };
      case "no-weather": return draft;
      case "blocked": throw new Error(decision.reason);
    }
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
      if (calculatePlan === undefined || draft === undefined) throw new Error("Save the route and aircraft profile before calculating.");
      if (this.state.currentRevision !== undefined && this.currentJournalHead(this.state.currentRevision.planId)?.id !== this.state.currentRevision.id) {
        throw new Error("Save this historical revision as a new journal entry before calculating.");
      }
      this.requireValidCruiseAltitudes("calculating");
      if (this.hasUnsavedPlanInputs()) throw new Error("Save the current route, aircraft, altitude, and forecast edits as a new revision before calculating.");
      const profile = this.effectiveProfile();
      if (profile === undefined) throw new Error("Save the route and aircraft profile before calculating.");
      if (!this.beginInputTransaction("Calculating complete navlog…")) return;
      const result = await calculatePlan(draft, profile, this.state.currentRevision);
      if (result.status === "blocked") {
        this.feedback.textContent = `Navlog blocked: ${result.message}`;
        this.state = { ...this.state, pendingOperation: undefined, calculationPreview: result.calculationSnapshot, inspectedCalculation: undefined };
        this.render();
        return;
      }
      const weatherSnapshots = await this.loadWeatherEvidence(result.revision);
      this.state = { ...this.state, draft: result.revision.draftSnapshot, currentRevision: result.revision, weatherSnapshots, calculationPreview: undefined, inspectedCalculation: undefined, selectedTasLegId: undefined, unlockedLegId: undefined, hasUnsavedChanges: false, hasUnsavedForecastSelection: false };
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
      const unavailableReason = this.weatherRefreshUnavailableReason();
      if (unavailableReason !== undefined) throw new Error(unavailableReason);
      const refresh = this.dependencies.refreshWeather;
      const parent = this.state.currentRevision;
      const selectedTime = this.state.selectedForecastValidTimeUtc;
      if (refresh === undefined || parent === undefined) throw new Error("Open a calculated revision before refreshing weather.");
      if (this.currentJournalHead(parent.planId)?.id !== parent.id) throw new Error("Save this historical revision as a new journal entry before refreshing weather.");
      if (this.state.hasUnsavedChanges || this.state.profileDraft !== undefined) throw new Error("Save or discard current route, aircraft, or altitude edits before refreshing weather.");
      if (selectedTime === undefined) throw new Error("Load published winds periods and choose a forecast before refreshing weather.");
      const selectedDraft = selectPlanWeatherForecast(
        parent.draftSnapshot,
        this.availableForecastPeriods(),
        selectedTime,
        this.dependencies.clock,
        emptyToUndefined(this.state.routeForm.surfaceWeatherIcao),
      );
      if (!this.beginInputTransaction("Refreshing weather and recalculating…")) return;
      const result = await refresh(parent, selectedDraft.weatherSelection);
      if (result.status === "blocked") {
        this.feedback.textContent = `Weather refresh blocked: ${result.message}`;
        this.state = { ...this.state, pendingOperation: undefined, calculationPreview: result.calculationSnapshot, inspectedCalculation: undefined };
        this.render();
        return;
      }
      const weatherSnapshots = await this.loadWeatherEvidence(result.revision);
      this.state = { ...this.state, draft: result.revision.draftSnapshot, currentRevision: result.revision, weatherSnapshots, calculationPreview: undefined, inspectedCalculation: undefined, selectedTasLegId: undefined, unlockedLegId: undefined, hasUnsavedChanges: false, hasUnsavedForecastSelection: false };
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

  /** A clean revision renders and calculates from its own immutable profile snapshot. */
  private effectiveProfile(): AircraftProfile | undefined {
    const revision = this.state.currentRevision;
    if (revision !== undefined && !this.state.hasUnsavedChanges && !this.state.hasUnsavedForecastSelection) return revision.aircraftProfileSnapshot.profile;
    return this.selectedProfile();
  }

  private hasUnsavedPlanInputs(): boolean {
    return this.state.hasUnsavedChanges || this.state.hasUnsavedForecastSelection || this.state.profileDraft !== undefined;
  }

  private requireValidCruiseAltitudes(action: "saving a plan" | "calculating"): void {
    if (this.state.invalidCruiseAltitudeIndexes.length > 0) throw new Error(`Correct each highlighted cruise altitude before ${action}.`);
  }

  private selectedProfileId(): string | undefined {
    return this.state.selectedProfileId === undefined ? this.state.draft?.selectedAircraftProfileId : this.state.selectedProfileId ?? undefined;
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
        selectedTasLegId: undefined,
        unlockedLegId: undefined,
        revisions,
        weatherSnapshots,
        calculationPreview: undefined,
        selectedProfileId: reopened.draftSnapshot.selectedAircraftProfileId,
        profileDraft: undefined,
        departure: firstAirport(reopened.draftSnapshot.route.points),
        destination: lastAirport(reopened.draftSnapshot.route.points),
        checkpoints: reopened.draftSnapshot.route.points.filter((point): point is CheckpointRoutePoint => point.kind === "checkpoint"),
        cruiseAltitudes: reopened.draftSnapshot.route.legs.map((leg) => leg.cruiseAltitudeFeetMsl),
        invalidCruiseAltitudeIndexes: [],
        availableForecasts: [],
        unavailableForecastCycles: [],
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

  private workflowUnavailableReason(action: WorkflowAction): string | undefined {
    if (this.state.pendingOperation !== undefined) return `${this.state.pendingOperation} Please wait.`;
    switch (action) {
      case "resolve-airports": return this.airportResolutionUnavailableReason();
      case "load-winds": return this.windsLoadingUnavailableReason();
      case "save-draft": return this.draftSavingUnavailableReason();
      case "calculate": return this.calculationUnavailableReason();
      case "refresh-weather": return this.weatherRefreshUnavailableReason();
    }
  }

  private airportResolutionUnavailableReason(): string | undefined {
    const departure = this.state.routeForm.departureIcao.trim().toUpperCase();
    const destination = this.state.routeForm.destinationIcao.trim().toUpperCase();
    return !isAirportCode(departure) || !isAirportCode(destination)
      ? "Enter both exact three- or four-character FAA LID or ICAO airport codes."
      : undefined;
  }

  private windsLoadingUnavailableReason(): string | undefined {
    if (this.state.departure === undefined || this.state.destination === undefined) return "Resolve both route endpoints before loading winds periods.";
    if (!isLocalUtcDateTime(this.state.routeForm.departureTime)) return "Enter the planned departure UTC time before loading winds periods.";
    return undefined;
  }

  private draftSavingUnavailableReason(weatherDecision: SaveWeatherDecision = this.saveWeatherDecision()): string | undefined {
    if (this.state.profileDraft !== undefined) return "Save the pending aircraft profile version first.";
    if (this.selectedProfile() === undefined) return "Save and select an aircraft profile first.";
    if (this.state.departure === undefined || this.state.destination === undefined) return "Resolve both route endpoints first.";
    if (this.state.invalidCruiseAltitudeIndexes.length > 0) return "Correct the highlighted cruise altitude values first.";
    if (this.state.routeForm.title.trim() === "") return "Enter a plan title first.";
    if (!isLocalUtcDateTime(this.state.routeForm.departureTime)) return "Enter the planned departure UTC time first.";
    return this.draftNumbersUnavailableReason() ?? (weatherDecision.kind === "blocked" ? weatherDecision.reason : undefined);
  }

  private saveWeatherDecision(
    selectedForecastValidTimeUtc: string | null | undefined = this.state.selectedForecastValidTimeUtc,
    candidateDraft?: PlanDraft,
    surfaceWeatherSource = this.state.routeForm.surfaceWeatherIcao,
  ): SaveWeatherDecision {
    return deriveSaveWeatherDecision({
      savedDraft: this.state.draft,
      currentRoutePoints: candidateDraft?.route.points ?? [this.state.departure, ...this.state.checkpoints, this.state.destination],
      departureTimeUtc: candidateDraft?.departureTimeUtc
        ?? (isLocalUtcDateTime(this.state.routeForm.departureTime) ? dateTimeLocalToUtc(this.state.routeForm.departureTime) : undefined),
      selectedForecastValidTimeUtc: selectedForecastValidTimeUtc ?? undefined,
      availablePeriods: this.availableForecastPeriods(),
      surfaceWeatherIcao: normalizedOptionalIcao(surfaceWeatherSource),
    });
  }

  private selectedForecastUnavailableReason(): string | undefined {
    const selectedTime = this.state.selectedForecastValidTimeUtc;
    if (selectedTime === undefined) return "Load and select a published winds period first.";
    if (!isLocalUtcDateTime(this.state.routeForm.departureTime)) return "Enter the planned departure UTC time before selecting a winds period.";
    const selected = selectForecastValidTime(this.availableForecastPeriods(), selectedTime, dateTimeLocalToUtc(this.state.routeForm.departureTime));
    return selected.ok ? undefined : "Select an available published winds period that includes the planned departure time.";
  }

  private availableForecastPeriods(): readonly { readonly id: string; readonly validFromUtc: string; readonly validToUtc: string }[] {
    return this.state.availableForecasts.map((period) => ({ id: period.validAt, validFromUtc: period.useFrom, validToUtc: period.useUntil }));
  }

  private effectiveForecastValidTimeUtc(selectedTime: string | null | undefined = this.state.selectedForecastValidTimeUtc): string | undefined {
    const decision = this.saveWeatherDecision(selectedTime);
    if (decision.kind === "replacement") return decision.forecastValidTimeUtc;
    if (decision.kind === "inherited") return decision.selection.forecastValidTimeUtc;
    return undefined;
  }

  private draftNumbersUnavailableReason(): string | undefined {
    if (!isNonnegativeNumber(this.state.routeForm.taxiFuel) || !isNonnegativeNumber(this.state.routeForm.reserveFuel)) return "Enter nonnegative taxi/run-up and reserve fuel values.";
    if (this.state.descentTargetIsManual && !isFiniteNumber(this.state.routeForm.descentTarget)) return "Enter a finite manual descent target altitude.";
    if (!isOptionalIcao(this.state.routeForm.surfaceWeatherIcao)) return "Surface-weather source must be an exact four-character ICAO code when supplied.";
    return undefined;
  }

  private calculationUnavailableReason(): string | undefined {
    if (this.dependencies.calculatePlan === undefined || this.state.draft === undefined) return "Save a route and aircraft profile first.";
    if (this.currentJournalHead(this.state.draft.planId)?.id !== this.state.currentRevision?.id) return "Open or save the current journal revision first.";
    if (this.state.invalidCruiseAltitudeIndexes.length > 0) return "Correct the highlighted cruise altitude values first.";
    if (this.hasUnsavedPlanInputs()) return "Save the current route, aircraft, altitude, and weather edits as a new revision first.";
    if (this.effectiveProfile() === undefined) return "Select an aircraft profile first.";
    return undefined;
  }

  private weatherRefreshUnavailableReason(): string | undefined {
    if (this.dependencies.refreshWeather === undefined || !isCalculatedRevision(this.state.currentRevision)) return "Open a calculated revision first.";
    if (this.currentRevisionIsHistorical()) return "Save the historical revision as a new current journal entry first.";
    if (this.state.hasUnsavedChanges || this.state.profileDraft !== undefined) return "Save or discard route, aircraft, or altitude edits first.";
    if (this.state.selectedForecastValidTimeUtc === undefined) return "Load and select a published winds period first.";
    const forecastReason = this.selectedForecastUnavailableReason();
    if (forecastReason !== undefined) return forecastReason;
    if (!isOptionalIcao(this.state.routeForm.surfaceWeatherIcao)) return "Surface-weather source must be an exact four-character ICAO code when supplied.";
    return undefined;
  }

  private currentRevisionIsHistorical(): boolean {
    const revision = this.state.currentRevision;
    return revision !== undefined && this.currentJournalHead(revision.planId)?.id !== revision.id;
  }

  /** Keeps disabled controls and their visible reasons synchronized without rerendering a focused form. */
  private refreshWorkflowAvailability(): void {
    this.content.querySelectorAll<HTMLButtonElement>("button[data-workflow-action]").forEach((control) => {
      const action = control.dataset.workflowAction as WorkflowAction | undefined;
      if (action === undefined) return;
      const reason = this.workflowUnavailableReason(action);
      configureWorkflowButton(control, reason);
      this.content.querySelectorAll<HTMLElement>(`[data-workflow-status="${action}"]`).forEach((status) => {
        status.textContent = reason === undefined ? "" : `Unavailable: ${reason}`;
        status.hidden = reason === undefined;
      });
    });
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

  private syncProfileFormInput(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !isProfileField(input.name)) return;
    this.state = { ...this.state, profileDraft: { ...this.state.profileDraft, [input.name]: input.value }, inspectedCalculation: undefined };
    this.refreshCalculationInspector();
    this.refreshWorkflowAvailability();
  }

  private syncRouteFormInput(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const field = routeFormField(input.name);
    if (field === undefined) return;
    this.state = field === "departureTime"
      ? { ...this.state, routeForm: { ...this.state.routeForm, [field]: input.value }, inspectedCalculation: undefined, availableForecasts: [], unavailableForecastCycles: [], selectedForecastValidTimeUtc: undefined, hasUnsavedChanges: this.state.draft !== undefined, hasUnsavedForecastSelection: false, calculationPreview: undefined }
      : field === "descentTarget"
        ? { ...this.state, routeForm: { ...this.state.routeForm, [field]: input.value }, inspectedCalculation: undefined, descentTargetIsManual: input.value.trim() !== "", hasUnsavedChanges: this.state.draft !== undefined, calculationPreview: undefined }
      : field === "departureIcao"
          ? { ...this.state, routeForm: { ...this.state.routeForm, [field]: input.value }, inspectedCalculation: undefined, departure: undefined, availableForecasts: [], unavailableForecastCycles: [], selectedForecastValidTimeUtc: undefined, hasUnsavedChanges: this.state.draft !== undefined, hasUnsavedForecastSelection: false, calculationPreview: undefined }
      : field === "destinationIcao"
            ? { ...this.state, routeForm: { ...this.state.routeForm, [field]: input.value }, inspectedCalculation: undefined, destination: undefined, availableForecasts: [], unavailableForecastCycles: [], selectedForecastValidTimeUtc: undefined, hasUnsavedChanges: this.state.draft !== undefined, hasUnsavedForecastSelection: false, calculationPreview: undefined }
        : field === "surfaceWeatherIcao"
          ? {
            ...this.state,
            routeForm: { ...this.state.routeForm, [field]: input.value },
            inspectedCalculation: undefined,
            hasUnsavedForecastSelection: weatherSelectionIsDirty(this.state.draft, this.effectiveForecastValidTimeUtc(), input.value),
            calculationPreview: undefined,
          }
        : { ...this.state, routeForm: { ...this.state.routeForm, [field]: input.value }, inspectedCalculation: undefined, hasUnsavedChanges: this.state.draft !== undefined, calculationPreview: undefined };
    this.refreshCalculationInspector();
    this.refreshWorkflowAvailability();
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

function workflowButton(label: string, type: "button" | "submit", action: WorkflowAction, unavailableReason: string | undefined): HTMLButtonElement {
  const control = button(label, type);
  control.dataset.workflowAction = action;
  configureWorkflowButton(control, unavailableReason);
  return control;
}

function configureWorkflowButton(control: HTMLButtonElement, unavailableReason: string | undefined): void {
  control.disabled = unavailableReason !== undefined;
  if (unavailableReason === undefined) {
    control.removeAttribute("title");
    control.removeAttribute("aria-describedby");
    return;
  }
  control.title = unavailableReason;
  control.setAttribute("aria-describedby", `workflow-status-${control.dataset.workflowAction ?? "unavailable"}`);
}

function actionStatus(action: WorkflowAction, unavailableReason: string | undefined): HTMLParagraphElement {
  const status = text("p", unavailableReason === undefined ? "" : `Unavailable: ${unavailableReason}`) as HTMLParagraphElement;
  status.className = "action-availability";
  status.id = `workflow-status-${action}`;
  status.dataset.workflowStatus = action;
  status.hidden = unavailableReason === undefined;
  return status;
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
  ["From", "To", "Altitude", "Cruise TAS", "Fuel flow", "Course", "Wind", "WCA°", "Heading", "NM", "GS kt", "ETE min", "Fuel gal", "Explanation"].forEach((label) => {
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
    labeledInput("departure-icao", "Departure airport code (FAA LID or ICAO)", values.departureIcao, "text"),
    labeledInput("destination-icao", "Destination airport code (FAA LID or ICAO)", values.destinationIcao, "text"),
    labeledInput("surface-weather-icao", "Surface METAR source ICAO (optional; if usable, anchors wind at departure field elevation)", values.surfaceWeatherIcao, "text"),
  ];
}

function emptyRouteForm(): RouteFormValues {
  return { title: "New study route", departureTime: "", taxiFuel: "0", reserveFuel: "0", descentTarget: "", departureIcao: "", destinationIcao: "", surfaceWeatherIcao: "" };
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
    surfaceWeatherIcao: draft.weatherSelection?.surfaceWeatherIcao ?? "",
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
    "surface-weather-icao": "surfaceWeatherIcao",
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
    surfaceWeatherIcao: inputValue(form, "surface-weather-icao"),
  };
}

function inputValue(form: HTMLFormElement, name: string): string {
  const element = form.elements.namedItem(name);
  return element instanceof HTMLInputElement ? element.value : "";
}

function isAirportCode(value: string): boolean {
  return /^[A-Z0-9]{3,4}$/.test(value);
}

function isOptionalIcao(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return normalized === "" || /^[A-Z0-9]{4}$/.test(normalized);
}

function normalizedOptionalIcao(value: string): string | undefined {
  return value.trim().toUpperCase() || undefined;
}

function weatherSelectionIsDirty(draft: PlanDraft | undefined, forecastValidTimeUtc: string | undefined, surfaceWeatherIcao: string): boolean {
  return draft !== undefined && (
    forecastValidTimeUtc !== draft.weatherSelection?.forecastValidTimeUtc
    || normalizedOptionalIcao(surfaceWeatherIcao) !== normalizedOptionalIcao(draft.weatherSelection?.surfaceWeatherIcao ?? "")
  );
}

function deriveSaveWeatherDecision(input: SaveWeatherDecisionInput): SaveWeatherDecision {
  if (input.selectedForecastValidTimeUtc !== undefined) {
    return replacementWeatherDecision(input);
  }
  const inherited = inheritedWeatherDecision(input);
  if (inherited !== undefined) return inherited;
  if (input.surfaceWeatherIcao !== undefined) {
    return { kind: "blocked", reason: "Load and select a published winds period before saving this surface-weather source." };
  }
  return { kind: "no-weather" };
}

function replacementWeatherDecision(input: SaveWeatherDecisionInput): SaveWeatherDecision {
  if (input.departureTimeUtc === undefined || input.selectedForecastValidTimeUtc === undefined) {
    return { kind: "blocked", reason: "Enter the planned departure UTC time before selecting a winds period." };
  }
  const selected = selectForecastValidTime(input.availablePeriods, input.selectedForecastValidTimeUtc, input.departureTimeUtc);
  if (!selected.ok) return { kind: "blocked", reason: "Select an available published winds period that includes the planned departure time." };
  return {
    kind: "replacement",
    forecastValidTimeUtc: selected.value.period.id,
    ...(input.surfaceWeatherIcao === undefined ? {} : { surfaceWeatherIcao: input.surfaceWeatherIcao }),
  };
}

function inheritedWeatherDecision(input: SaveWeatherDecisionInput): SaveWeatherDecision | undefined {
  const savedWeather = input.savedDraft?.weatherSelection;
  if (savedWeather === undefined) return undefined;
  const routeMatches = input.currentRoutePoints.length === input.savedDraft?.route.points.length
    && input.currentRoutePoints.every((point, index) => sameWeatherRoutePoint(point, input.savedDraft?.route.points[index]));
  if (input.departureTimeUtc !== input.savedDraft?.departureTimeUtc || !routeMatches) {
    return { kind: "blocked", reason: "Load and select a new published winds period to replace the saved forecast; this editor cannot remove it." };
  }
  const selection = { ...savedWeather };
  delete selection.surfaceWeatherIcao;
  return {
    kind: "inherited",
    selection: {
      ...selection,
      ...(input.surfaceWeatherIcao === undefined ? {} : { surfaceWeatherIcao: input.surfaceWeatherIcao }),
    },
  };
}

function sameWeatherRoutePoint(current: RoutePoint | undefined, saved: RoutePoint | undefined): boolean {
  return current !== undefined
    && saved !== undefined
    && JSON.stringify(weatherRoutePointFields(current)) === JSON.stringify(weatherRoutePointFields(saved));
}

function weatherRoutePointFields(point: RoutePoint): readonly (string | number)[] {
  return point.kind === "airport"
    ? [point.kind, point.icao, point.name, point.elevationFeetMsl, point.coordinate.latitude, point.coordinate.longitude]
    : [point.kind, point.name, point.coordinate.latitude, point.coordinate.longitude];
}

function isLocalUtcDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}:00.000Z`));
}

function isNonnegativeNumber(value: string): boolean {
  const parsed = Number(value);
  return value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;
}

function isFiniteNumber(value: string): boolean {
  const parsed = Number(value);
  return value.trim() !== "" && Number.isFinite(parsed);
}

function emptyToUndefined(value: string): string | undefined {
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

const DEFAULT_PROFILE_FIELDS: ReadonlyArray<readonly [string, string, string]> = [
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

function profileFields(profile: AircraftProfile | undefined, draft: Readonly<Record<string, string>> | undefined): ReadonlyArray<readonly [string, string, string]> {
  const source = profile === undefined ? DEFAULT_PROFILE_FIELDS : [
    ["profile-name", "Profile name", profile.name],
    ["cruise-tas", "Cruise TAS (kt)", String(profile.cruiseTasKnots)],
    ["cruise-fuel", "Cruise fuel flow (gph)", String(profile.cruiseFuelFlowGallonsPerHour)],
    ["climb-rate", "Climb rate (fpm)", String(profile.climbRateFeetPerMinute)],
    ["climb-tas", "Climb TAS (kt)", String(profile.climbTasKnots)],
    ["climb-fuel", "Climb fuel flow (gph)", String(profile.climbFuelFlowGallonsPerHour)],
    ["descent-rate", "Descent rate (fpm)", String(profile.descentRateFeetPerMinute)],
    ["descent-tas", "Descent TAS (kt)", String(profile.descentTasKnots)],
    ["descent-fuel", "Descent fuel flow (gph)", String(profile.descentFuelFlowGallonsPerHour)],
    ["usable-fuel", "Usable fuel (gal, optional)", profile.usableFuelGallons === undefined ? "" : String(profile.usableFuelGallons)],
    ["compass-deviation-card", "Compass deviation card (magnetic heading: signed degrees)", formatCompassDeviationCard(profile.compassDeviationTable)],
  ];
  return source.map(([id, label, value]) => [id, label, draft?.[id] ?? value]);
}

function isProfileField(name: string): boolean {
  return DEFAULT_PROFILE_FIELDS.some(([id]) => id === name);
}

function profileOptionLabel(profile: AircraftProfile): string {
  return `${profile.name} — ${profile.cruiseTasKnots} kt, ${profile.cruiseFuelFlowGallonsPerHour} gph · saved ${profile.createdAt}`;
}

function formatCompassDeviationCard(entries: readonly CompassDeviationEntry[]): string {
  return entries.map(({ magneticHeadingDegrees, deviationDegrees }) => `${String(magneticHeadingDegrees).padStart(3, "0")}: ${deviationDegrees}`).join(", ");
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
