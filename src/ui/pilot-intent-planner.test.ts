import { describe, expect, it, vi } from "vitest";
import { createLocalStudyAirportLookup } from "../application/airport-lookup";
import type { AircraftProfile } from "../domain/aircraft";
import type { PilotInputPlan, PilotInputRepository } from "../services/storage/pilot-input-repository";
import type { MetarTransportClient, WindsTransportClient } from "../services/weather/winds-client";
import { aircraftProfile } from "../services/storage/__tests__/fixtures";
import { COMPLETE_FLIGHT_FORECAST_VALID_AT, completeFlightWeatherClient } from "../test/fixtures/complete-flight";
import { renderPilotIntentPlanner } from "./pilot-intent-planner";

class MemoryInputs implements PilotInputRepository {
  readonly plans: PilotInputPlan[] = [];
  readonly submissions: PilotInputPlan[] = [];
  readonly profiles: AircraftProfile[] = [];
  failSave = false;
  failProfileSave = false;
  profileSaveGate?: Promise<void>;
  failSubmit = false;
  failInitialize = false;
  async initialize(): Promise<void> { if (this.failInitialize) throw new Error("storage initialization failed"); }
  async listPlans(): Promise<readonly PilotInputPlan[]> { return this.plans; }
  async getPlan(id: string): Promise<PilotInputPlan | undefined> {
    return this.plans.find((p) => p.id === id);
  }
  async saveWorkingCopy(plan: PilotInputPlan): Promise<void> {
    if (this.failSave) throw new Error("write failed");
    this.replace(this.plans, plan);
  }
  async submitInputs(plan: PilotInputPlan): Promise<void> {
    if (this.failSubmit) throw new Error("submission write failed");
    this.submissions.push(plan);
    this.replace(this.plans, plan);
  }
  async saveProfile(profile: AircraftProfile): Promise<void> {
    if (this.profileSaveGate) await this.profileSaveGate;
    if (this.failProfileSave) throw new Error("profile write failed");
    this.profiles.push(profile);
  }
  async listProfiles(): Promise<readonly AircraftProfile[]> { return this.profiles; }
  private replace(collection: PilotInputPlan[], plan: PilotInputPlan): void {
    const index = collection.findIndex((item) => item.id === plan.id);
    if (index < 0) collection.push(plan);
    else collection[index] = plan;
  }
}

let idNumber = 0;
const ids = { next: () => `planner-id-${++idNumber}` };
const clock = { now: () => new Date("2026-09-21T21:30:00.000Z") };
const profile = aircraftProfile();

function winds(overrides: Partial<WindsTransportClient & MetarTransportClient> = {}): WindsTransportClient & MetarTransportClient {
  return { ...completeFlightWeatherClient, ...overrides };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function input(root: HTMLElement, name: string): HTMLInputElement {
  const element = root.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (!element) throw new Error(`Missing input ${name}`);
  return element;
}

function button(root: HTMLElement, text: string): HTMLButtonElement {
  const element = [...root.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === text);
  if (!element) throw new Error(`Missing button ${text}`);
  return element;
}

function edit(root: HTMLElement, name: string, value: string, blur = false): void {
  const element = input(root, name);
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  if (blur) element.dispatchEvent(new Event("blur", { bubbles: true }));
}

async function mount(repository: MemoryInputs, client = winds(), airportLookup = createLocalStudyAirportLookup()): Promise<HTMLElement> {
  const root = document.createElement("div");
  renderPilotIntentPlanner(root, { repository, airportLookup, winds: client, ids, clock });
  await settle();
  return root;
}

async function makeLocallyValid(root: HTMLElement, withSurfaceMetar = false): Promise<void> {
  edit(root, "plan-title", "Synthetic route");
  edit(root, "departure-time", "2026-09-21T22:00");
  edit(root, "taxi-fuel", "0.8");
  edit(root, "reserve-fuel", "3");
  edit(root, "descent-target", "1800");
  edit(root, "departure-icao", "KORD");
  edit(root, "destination-icao", "KJVL");
  if (withSurfaceMetar) edit(root, "surface-weather-icao", "KORD");
  const select = root.querySelector<HTMLSelectElement>("[name='selectedProfileId']")!;
  select.value = profile.id;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
}

async function choosePublishedPeriod(root: HTMLElement): Promise<void> {
  button(root, "Load published forecast periods").click();
  await settle();
  const select = root.querySelector<HTMLSelectElement>("[name='forecast-choice']")!;
  select.value = COMPLETE_FLIGHT_FORECAST_VALID_AT;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
}

describe("pilot intent planner", () => {
  it("shows repository initialization failure in the planner", async () => {
    const repository = new MemoryInputs(); repository.failInitialize = true;
    const root = await mount(repository);
    expect(root.querySelector("[role='status']")?.textContent).toContain("storage initialization failed");
  });

  it("persists literal invalid field text on blur, including distinct departure LID and METAR ICAO, and reports failed writes", async () => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    edit(root, "plan-title", "  literal title text  ", true);
    edit(root, "departure-icao", "1C8", true);
    edit(root, "surface-weather-icao", "KORD", true);
    await settle();
    expect(repository.plans.at(-1)?.rawFields).toMatchObject({ "plan-title": "  literal title text  ", "departure-icao": "1C8", "surface-weather-icao": "KORD" });
    expect(root.querySelector<HTMLInputElement>("[name='surface-weather-icao']")?.value).toBe("KORD");

    repository.failSave = true;
    edit(root, "departure-icao", "1C8", true);
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("write failed");
    expect(button(root, "Update plan").disabled).toBe(true);
  });

  it("keeps an autosave failure visible across Open and New until a later write succeeds", async () => {
    const repository = new MemoryInputs();
    const other: PilotInputPlan = {
      id: "other-saved-plan", title: "Other saved plan", rawFields: { "plan-title": "Other saved plan" },
      checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    };
    repository.plans.push(other);
    const root = await mount(repository);
    repository.failSave = true;
    edit(root, "plan-title", "Failed write", true);
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("write failed");

    button(root, "Open Other saved plan").click();
    expect(input(root, "plan-title").value).toBe("Other saved plan");
    expect(root.querySelector("[role='status']")?.textContent).toContain("write failed");
    button(root, "New plan").click();
    expect(input(root, "plan-title").value).toBe("New study route");
    expect(root.querySelector("[role='status']")?.textContent).toContain("write failed");

    repository.failSave = false;
    edit(root, "plan-title", "Write recovered", true);
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toBe("Pilot inputs saved.");
  });

  it("restores incomplete profile text and ordered checkpoint text after reopening a saved plan", async () => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    edit(root, "cruiseTasKnots", "not a number yet", true);
    await settle();
    button(root, "Add checkpoint").click();
    await settle();
    edit(root, "checkpoint-name-0", "Farm strip", true);
    edit(root, "checkpoint-coordinate-0", "N4145 W08730", true);
    await settle();
    const stored = repository.plans.at(-1)!;
    expect(stored.rawFields["profile-cruiseTasKnots"]).toBe("not a number yet");
    expect(stored.checkpoints).toEqual([{ name: "Farm strip", coordinateText: "N4145 W08730" }]);

    const reopened = await mount(repository);
    expect(input(reopened, "cruiseTasKnots").value).toBe("not a number yet");
    expect(input(reopened, "checkpoint-name-0").value).toBe("Farm strip");
    expect(input(reopened, "checkpoint-coordinate-0").value).toBe("N4145 W08730");
    expect(reopened.querySelector(".calculated-navlog")).toBeNull();
  });

  it("keeps Update plan locally gated until required fields, a profile, and a published period are present", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);
    expect(button(root, "Update plan").disabled).toBe(true);
    await makeLocallyValid(root);
    expect(button(root, "Update plan").disabled).toBe(true);
    await choosePublishedPeriod(root);
    expect(button(root, "Update plan").disabled).toBe(false);
  });

  it("rejects titles over 120 trimmed characters before submission and accepts 120", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const weather = winds();
    const fetchForecast = vi.spyOn(weather, "fetchForecast");
    const fetchMetar = vi.spyOn(weather, "fetchMetar");
    const root = await mount(repository, weather);
    await makeLocallyValid(root);
    await choosePublishedPeriod(root);

    edit(root, "plan-title", `  ${"a".repeat(121)}  `);
    const title = input(root, "plan-title");
    expect(title.getAttribute("aria-invalid")).toBe("true");
    expect(root.querySelector(`#${title.name}-error`)?.textContent).toBe("Plan title must be 120 characters or fewer.");
    expect(button(root, "Update plan").disabled).toBe(true);
    button(root, "Update plan").click();
    await settle();
    expect(repository.submissions).toHaveLength(0);
    expect(fetchForecast).not.toHaveBeenCalled();
    expect(fetchMetar).not.toHaveBeenCalled();

    edit(root, "plan-title", `  ${"a".repeat(120)}  `);
    expect(title.getAttribute("aria-invalid")).toBe("false");
    expect(button(root, "Update plan").disabled).toBe(false);
    button(root, "Update plan").click();
    await settle();
    expect(repository.submissions).toHaveLength(1);
    expect(fetchForecast).toHaveBeenCalled();
    expect(repository.submissions[0]?.rawFields["plan-title"]).toBe(`  ${"a".repeat(120)}  `);
  });

  it("persists an intentionally cleared aircraft profile selection", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);
    const select = root.querySelector<HTMLSelectElement>("[name='selectedProfileId']")!;
    select.value = profile.id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(repository.plans.at(-1)?.selectedProfileId).toBe(profile.id);
    const current = root.querySelector<HTMLSelectElement>("[name='selectedProfileId']")!;
    current.value = "";
    current.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(repository.plans.at(-1)?.selectedProfileId).toBeUndefined();
    expect(root.querySelector<HTMLSelectElement>("[name='selectedProfileId']")?.value).toBe("");
  });

  it("treats restored profile text that differs from the selected profile as an unsaved draft", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const rawFields = {
      "plan-title": "Profile draft route", "departure-time": "2026-09-21T22:00", "taxi-fuel": "0.8", "reserve-fuel": "3",
      "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL", "surface-weather-icao": "KORD",
      "selected-forecast-period": COMPLETE_FLIGHT_FORECAST_VALID_AT, "profile-cruiseTasKnots": "102",
    };
    repository.plans.push({
      id: "profile-draft-plan", title: "Profile draft route", rawFields, selectedProfileId: profile.id, profileSnapshot: profile,
      checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    });
    const root = await mount(repository);
    expect(root.querySelector<HTMLSelectElement>("[name='selectedProfileId']")?.value).toBe(profile.id);
    expect(input(root, "cruiseTasKnots").value).toBe("102");
    expect(String(profile.cruiseTasKnots)).toBe("95");
    expect(button(root, "Update plan").disabled).toBe(true);
    expect(root.querySelector("[data-local-error]")?.textContent).toContain("Save the edited aircraft profile first.");

    const draftValues: Record<string, string> = {
      "profile-name": "Saved draft aircraft", cruiseTasKnots: "102", cruiseFuelFlowGallonsPerHour: "6",
      climbRateFeetPerMinute: "500", climbTasKnots: "75", climbFuelFlowGallonsPerHour: "7",
      descentRateFeetPerMinute: "500", descentTasKnots: "100", descentFuelFlowGallonsPerHour: "5",
      usableFuelGallons: "24", "compass-deviation-card": "000:+1, 090:-1",
    };
    Object.entries(draftValues).forEach(([name, value]) => { input(root, name).value = value; });
    root.querySelector("form:not(.route-form)")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(repository.profiles.at(-1)?.cruiseTasKnots).toBe(102);
    expect(root.querySelector<HTMLSelectElement>("[name='selectedProfileId']")?.value).toBe(repository.profiles.at(-1)?.id);
    expect(button(root, "Update plan").disabled).toBe(false);
  });

  it("recomputes the restored profile draft gate when another matching saved profile is selected", async () => {
    const repository = new MemoryInputs();
    const alternateProfile: AircraftProfile = { ...profile, id: "aircraft-2", name: "Alternate Cessna", cruiseTasKnots: 102 };
    repository.profiles.push(profile, alternateProfile);
    const rawFields = {
      "plan-title": "Profile choice route", "departure-time": "2026-09-21T22:00", "taxi-fuel": "0.8", "reserve-fuel": "3",
      "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL", "surface-weather-icao": "KORD",
      "selected-forecast-period": COMPLETE_FLIGHT_FORECAST_VALID_AT, "profile-profile-name": alternateProfile.name,
      "profile-cruiseTasKnots": "102", "profile-cruiseFuelFlowGallonsPerHour": "6",
      "profile-climbRateFeetPerMinute": "500", "profile-climbTasKnots": "75", "profile-climbFuelFlowGallonsPerHour": "7",
      "profile-descentRateFeetPerMinute": "500", "profile-descentTasKnots": "100", "profile-descentFuelFlowGallonsPerHour": "5",
      "profile-usableFuelGallons": "24", "profile-compass-deviation-card": "090:+1",
    };
    repository.plans.push({
      id: "profile-choice-plan", title: "Profile choice route", rawFields, selectedProfileId: profile.id, profileSnapshot: profile,
      checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    });
    const root = await mount(repository);
    expect(input(root, "cruiseTasKnots").value).toBe("102");
    expect(button(root, "Update plan").disabled).toBe(true);
    expect(root.querySelector("[data-local-error]")?.textContent).toContain("Save the edited aircraft profile first.");

    const selection = root.querySelector<HTMLSelectElement>("[name='selectedProfileId']")!;
    selection.value = alternateProfile.id;
    selection.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(input(root, "cruiseTasKnots").value).toBe("102");
    expect(button(root, "Update plan").disabled).toBe(false);
    expect(root.querySelector("[data-local-error]")?.textContent).toBe("");
    expect(repository.plans.find((plan) => plan.id === "profile-choice-plan")?.selectedProfileId).toBe(alternateProfile.id);
  });

  it("rejects an empty compass card and saves a complete aircraft profile", async () => {
    const invalidRepository = new MemoryInputs();
    const invalidRoot = await mount(invalidRepository);
    invalidRoot.querySelector("form:not(.route-form)")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(invalidRoot.querySelector("[role='status']")?.textContent).toContain("Enter at least one compass deviation card point.");
    expect(invalidRepository.profiles).toHaveLength(0);

    const repository = new MemoryInputs();
    const root = await mount(repository);
    const values: Record<string, string> = {
      "profile-name": "Test Cessna", cruiseTasKnots: "95", cruiseFuelFlowGallonsPerHour: "6",
      climbRateFeetPerMinute: "500", climbTasKnots: "75", climbFuelFlowGallonsPerHour: "7",
      descentRateFeetPerMinute: "500", descentTasKnots: "100", descentFuelFlowGallonsPerHour: "5",
      usableFuelGallons: "24", "compass-deviation-card": "000:+1, 090:-1",
    };
    Object.entries(values).forEach(([name, value]) => { input(root, name).value = value; });
    root.querySelector("form:not(.route-form)")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(repository.profiles).toHaveLength(1);
    expect(repository.profiles[0]).toMatchObject({ name: "Test Cessna", cruiseTasKnots: 95, usableFuelGallons: 24, compassDeviationTable: [{ magneticHeadingDegrees: 0, deviationDegrees: 1 }, { magneticHeadingDegrees: 90, deviationDegrees: -1 }] });
    expect(root.querySelector("[role='status']")?.textContent).toContain("Aircraft profile Test Cessna saved.");
    expect(root.querySelector<HTMLSelectElement>("[name='selectedProfileId']")?.value).toBe(repository.profiles[0]?.id);
  });

  it("keeps plan navigation locked during profile save and unlocks it after failure", async () => {
    const repository = new MemoryInputs();
    const first: PilotInputPlan = {
      id: "first-plan", title: "First plan", rawFields: { "plan-title": "First plan" },
      checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    };
    const second: PilotInputPlan = {
      id: "second-plan", title: "Second plan", rawFields: { "plan-title": "Second plan" },
      checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    };
    repository.plans.push(first, second);
    let releaseSave!: () => void;
    repository.profileSaveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    const root = await mount(repository);
    button(root, "Open First plan").click();

    const values: Record<string, string> = {
      "profile-name": "Pending Cessna", cruiseTasKnots: "95", cruiseFuelFlowGallonsPerHour: "6",
      climbRateFeetPerMinute: "500", climbTasKnots: "75", climbFuelFlowGallonsPerHour: "7",
      descentRateFeetPerMinute: "500", descentTasKnots: "100", descentFuelFlowGallonsPerHour: "5",
      "compass-deviation-card": "000:+1",
    };
    Object.entries(values).forEach(([name, value]) => { input(root, name).value = value; });
    root.querySelector("form:not(.route-form)")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(button(root, "Open Second plan").disabled).toBe(true);
    expect(input(root, "profile-name").disabled).toBe(true);
    expect(input(root, "plan-title").disabled).toBe(true);
    button(root, "Open Second plan").click();
    button(root, "New plan").click();
    expect(input(root, "plan-title").value).toBe("First plan");
    expect(repository.plans.find((plan) => plan.id === second.id)).toEqual(second);

    releaseSave();
    await settle();
    expect(repository.plans.find((plan) => plan.id === first.id)?.selectedProfileId).toBe(repository.profiles[0]?.id);
    expect(repository.plans.find((plan) => plan.id === second.id)).toEqual(second);
    expect(input(root, "profile-name").disabled).toBe(false);
    expect(input(root, "plan-title").disabled).toBe(false);

    repository.profileSaveGate = undefined;
    repository.failProfileSave = true;
    Object.entries(values).forEach(([name, value]) => { input(root, name).value = value; });
    root.querySelector("form:not(.route-form)")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("profile write failed");
    expect(button(root, "Open Second plan").disabled).toBe(false);
    expect(input(root, "profile-name").disabled).toBe(false);
  });

  it("blocks a nonpositive TAS override before submitting pilot inputs", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);
    await makeLocallyValid(root);
    await choosePublishedPeriod(root);
    edit(root, "override-tas-0", "-5");
    expect(button(root, "Update plan").disabled).toBe(true);
    expect(root.textContent).toContain("Leg 1 TAS override must be a positive number of knots.");
    button(root, "Update plan").click();
    await settle();
    expect(repository.submissions).toHaveLength(0);
  });

  it("requires override acknowledgement per plan and clears it when the override changes", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const fields = {
      "plan-title": "First plan", "departure-time": "2026-09-21T22:00", "taxi-fuel": "0.8", "reserve-fuel": "3",
      "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL", "surface-weather-icao": "KORD",
      "selected-forecast-period": COMPLETE_FLIGHT_FORECAST_VALID_AT,
    };
    repository.plans.push({
      id: "first-override-plan", title: "First plan", rawFields: fields, selectedProfileId: profile.id, profileSnapshot: profile,
      checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    }, {
      id: "second-override-plan", title: "Second plan", rawFields: { ...fields, "plan-title": "Second plan", "override-tas-0": "102", "override-reason-0": "Training comparison" },
      selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: { "tas-0": "Training comparison" },
      updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    });
    const root = await mount(repository);
    await choosePublishedPeriod(root);
    edit(root, "override-tas-0", "100", true);
    edit(root, "override-reason-0", "Training comparison", true);
    await settle();
    const acknowledgement = root.querySelector<HTMLInputElement>("input[type='checkbox']");
    expect(acknowledgement).not.toBeNull();
    expect(button(root, "Update plan").disabled).toBe(true);
    expect(root.textContent).toContain("Confirm the effect of the TAS override for leg 1.");
    acknowledgement!.checked = true;
    acknowledgement!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(button(root, "Update plan").disabled).toBe(false);

    edit(root, "override-tas-0", "104", true);
    await settle();
    expect(root.querySelector<HTMLInputElement>("input[type='checkbox']")?.checked).toBe(false);
    expect(button(root, "Update plan").disabled).toBe(true);
    root.querySelector<HTMLInputElement>("input[type='checkbox']")!.checked = true;
    root.querySelector<HTMLInputElement>("input[type='checkbox']")!.dispatchEvent(new Event("change", { bubbles: true }));
    button(root, "Open Second plan").click();
    await settle();
    expect(input(root, "plan-title").value).toBe("Second plan");
    expect(root.querySelector<HTMLInputElement>("input[type='checkbox']")?.checked).toBe(false);
    expect(button(root, "Update plan").disabled).toBe(true);
  });

  it("submits pilot inputs before a fetch failure and keeps the failure through edits and retry start", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const client = winds({ fetchForecast: async () => { throw new Error("forecast fetch failed"); } });
    const root = await mount(repository, client);
    await makeLocallyValid(root, true);
    await choosePublishedPeriod(root);
    button(root, "Update plan").click();
    await settle();
    expect(repository.submissions).toHaveLength(1);
    expect(repository.submissions[0]?.rawFields["departure-icao"]).toBe("KORD");
    expect(root.querySelector(".calculated-navlog")).toBeNull();
    expect(root.querySelector("[role='status']")?.textContent).toContain("forecast fetch failed");

    edit(root, "plan-title", "Edited after failure");
    expect(root.querySelector("[role='status']")?.textContent).toContain("forecast fetch failed");
    button(root, "Update plan").click();
    expect(root.querySelector("[role='status']")?.textContent).toContain("forecast fetch failed");
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("forecast fetch failed");
    expect(repository.submissions).toHaveLength(2);
  });

  it("blocks a saved forecast period absent from current availability without substituting another", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const alternate = "2026-09-22T03:00:00.000Z";
    const client = winds({ discoverStations: async () => {
      const payload = await completeFlightWeatherClient.discoverStations([] as never);
      return { ...payload, forecasts: payload.forecasts.map((period) => ({ ...period, validAt: alternate })) };
    } });
    const root = await mount(repository, client);
    await makeLocallyValid(root);
    edit(root, "selected-forecast-period", COMPLETE_FLIGHT_FORECAST_VALID_AT);
    const update = button(root, "Update plan");
    expect(update.disabled).toBe(false);
    update.click();
    await settle();
    expect(repository.submissions).toHaveLength(1);
    expect(root.querySelector("[role='status']")?.textContent).toContain("selected forecast period is unavailable");
    expect(repository.submissions[0]?.rawFields["selected-forecast-period"]).toBe(COMPLETE_FLIGHT_FORECAST_VALID_AT);
    expect(root.querySelector(".calculated-navlog")).toBeNull();
  });

  it("blocks stale-on-error winds and does not render a successful plan", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const stale = winds({ fetchForecast: async (...args) => {
      const payload = await completeFlightWeatherClient.fetchForecast(...args);
      return { ...payload, provenance: { ...payload.provenance, cache: { ...payload.provenance.cache, status: "stale_on_error", source: "stale", freshnessRemainingSeconds: 0 } } };
    } });
    const root = await mount(repository, stale);
    await makeLocallyValid(root, true);
    await choosePublishedPeriod(root);
    button(root, "Update plan").click();
    await settle();
    expect(repository.submissions).toHaveLength(1);
    expect(root.querySelector(".calculated-navlog")).toBeNull();
    expect(root.querySelector("[role='status']")?.textContent).toContain("The selected winds forecast is stale; no updated plan was produced.");
  });

  it("removes an override with a deleted checkpoint leg so the route can be updated", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const fields = {
      "plan-title": "Checkpoint route", "departure-time": "2026-09-21T22:00", "taxi-fuel": "0.8", "reserve-fuel": "3",
      "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL", "surface-weather-icao": "KORD",
      "selected-forecast-period": COMPLETE_FLIGHT_FORECAST_VALID_AT, "override-tas-1": "102", "override-reason-1": "Leg 2 test",
    };
    repository.plans.push({
      id: "checkpoint-plan", title: "Checkpoint route", rawFields: fields, selectedProfileId: profile.id, profileSnapshot: profile,
      checkpoints: [{ name: "Farm strip", coordinateText: "414500N0873000W" }], cruiseAltitudeTexts: ["4500", "4500"],
      overrideReasons: { "tas-1": "Leg 2 test" }, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    });
    const root = await mount(repository);
    await choosePublishedPeriod(root);
    button(root, "Remove checkpoint 1").click();
    await settle();
    expect(root.querySelector("[name='override-tas-1']")).toBeNull();
    expect(root.querySelector("[name='override-reason-1']")).toBeNull();
    expect(root.querySelector("[data-local-error]")?.textContent).toBe("");
    expect(button(root, "Update plan").disabled).toBe(false);
  });

  it("clears TAS overrides and reasons with a visible notice when adding a checkpoint", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const fields = {
      "plan-title": "Override route", "departure-time": "2026-09-21T22:00", "taxi-fuel": "0.8", "reserve-fuel": "3",
      "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL", "surface-weather-icao": "KORD",
      "selected-forecast-period": COMPLETE_FLIGHT_FORECAST_VALID_AT, "override-tas-0": "102", "override-reason-0": "Study comparison",
    };
    repository.plans.push({
      id: "override-route", title: "Override route", rawFields: fields, selectedProfileId: profile.id, profileSnapshot: profile,
      checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: { "tas-0": "Study comparison" },
      updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    });
    const root = await mount(repository);
    button(root, "Add checkpoint").click();
    await settle();
    expect(input(root, "override-tas-0").value).toBe("");
    expect(input(root, "override-reason-0").value).toBe("");
    expect(input(root, "override-tas-1").value).toBe("");
    expect(input(root, "override-reason-1").value).toBe("");
    expect(repository.plans.at(-1)?.overrideReasons).toEqual({});
    expect(repository.plans.at(-1)?.rawFields).not.toHaveProperty("override-tas-0");
    expect(root.querySelector("[role='status']")?.textContent).toContain("overrides and reasons were cleared");
  });

  it("resets forecast choices and transient results when starting a new plan or reopening a saved plan", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);
    await makeLocallyValid(root, true);
    await choosePublishedPeriod(root);
    button(root, "Update plan").click();
    await settle();
    expect(root.querySelector(".calculated-navlog")).not.toBeNull();

    button(root, "New plan").click();
    await settle();
    expect(input(root, "plan-title").value).toBe("New study route");
    expect(input(root, "departure-icao").value).toBe("");
    expect(input(root, "surface-weather-icao").value).toBe("");
    expect(root.querySelector(".calculated-navlog")).toBeNull();
    expect(root.querySelectorAll("[name='forecast-choice'] option")).toHaveLength(1);

    button(root, "Open Synthetic route").click();
    await settle();
    expect(input(root, "plan-title").value).toBe("Synthetic route");
    expect(root.querySelector(".calculated-navlog")).toBeNull();
    expect(root.querySelectorAll("[name='forecast-choice'] option")).toHaveLength(1);
  });

  it("clears a previous result after a failed later update, then clears the error only after a successful update", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    let fail = false;
    const client = winds({ fetchForecast: async (...args) => {
      if (fail) throw new Error("temporary forecast failure");
      return completeFlightWeatherClient.fetchForecast(...args);
    } });
    const root = await mount(repository, client);
    await makeLocallyValid(root, true);
    await choosePublishedPeriod(root);
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    button(root, "Update plan").click();
    await settle();
    expect(root.querySelector(".calculated-navlog")).not.toBeNull();
    const inspected = root.querySelector<HTMLButtonElement>(".calculated-navlog button[data-inspect-field='trueHeading']");
    expect(inspected).not.toBeNull();
    inspected!.click();
    expect(root.querySelector(".calculation-inspector h3")?.textContent).toContain("True heading");
    button(root, "Print current plan").click();
    expect(print).toHaveBeenCalledOnce();

    fail = true;
    button(root, "Update plan").click();
    await settle();
    expect(root.querySelector(".calculated-navlog")).toBeNull();
    expect(root.querySelector(".calculation-inspector")).toBeNull();
    expect([...root.querySelectorAll<HTMLButtonElement>("button")].some((item) => item.textContent === "Print current plan")).toBe(false);
    expect(root.querySelector("[role='status']")?.textContent).toContain("temporary forecast failure");
    edit(root, "plan-title", "retrying");
    expect(root.querySelector("[role='status']")?.textContent).toContain("temporary forecast failure");

    fail = false;
    button(root, "Update plan").click();
    await settle();
    expect(root.querySelector(".calculated-navlog")).not.toBeNull();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Plan updated using current airport and weather context.");
    print.mockRestore();
  });

  it("disables plan navigation during an update and clears the result when another plan is opened", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const firstPlan: PilotInputPlan = {
      id: "first-plan", title: "First plan", rawFields: {
        "plan-title": "First plan", "departure-time": "2026-09-21T22:00", "taxi-fuel": "0.8", "reserve-fuel": "3",
        "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL", "surface-weather-icao": "KORD",
        "selected-forecast-period": COMPLETE_FLIGHT_FORECAST_VALID_AT,
      }, selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [], cruiseAltitudeTexts: ["4500"],
      overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    };
    const otherPlan: PilotInputPlan = {
      id: "other-plan", title: "Other plan", rawFields: { "plan-title": "Other plan" }, checkpoints: [], cruiseAltitudeTexts: ["4500"],
      overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    };
    repository.plans.push(firstPlan, otherPlan);
    let release!: (value: Awaited<ReturnType<typeof completeFlightWeatherClient.fetchForecast>>) => void;
    let shouldWait = false;
    const client = winds({ fetchForecast: (...args) => shouldWait
      ? new Promise((resolve) => { release = resolve; })
      : completeFlightWeatherClient.fetchForecast(...args) });
    const root = await mount(repository, client);
    await choosePublishedPeriod(root);
    shouldWait = true;
    button(root, "Update plan").click();
    await settle();
    expect(button(root, "Open Other plan").disabled).toBe(true);
    button(root, "Open Other plan").click();
    await settle();
    expect(input(root, "plan-title").value).toBe("First plan");
    release(await completeFlightWeatherClient.fetchForecast("BRL", COMPLETE_FLIGHT_FORECAST_VALID_AT, "us"));
    await settle();
    expect(root.querySelector(".calculated-navlog")).not.toBeNull();
    button(root, "Open Other plan").click();
    await settle();
    expect(input(root, "plan-title").value).toBe("Other plan");
    expect(root.querySelector(".calculated-navlog")).toBeNull();
  });
});
