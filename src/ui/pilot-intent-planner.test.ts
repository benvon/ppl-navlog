import { describe, expect, it, vi } from "vitest";
import { createLocalStudyAirportLookup } from "../application/airport-lookup";
import type { AirportLookup } from "../application/airport-lookup";
import type { AircraftProfile } from "../domain/aircraft";
import type { PilotInputPlan, PilotInputRepository } from "../services/storage/pilot-input-repository";
import type { MetarTransportClient, TafTransportClient, WindsTransportClient } from "../services/weather/winds-client";
import type { AloftPointAnswer, AloftPointQuery, MetarSuccessPayload } from "../../worker/api/contracts";
import { coordinate, type Coordinate } from "../domain/coordinates";
import { calculateGreatCircleDistanceAndInitialCourse } from "../domain/distance-course";
import { aircraftProfile } from "../services/storage/__tests__/fixtures";
import { COMPLETE_FLIGHT_FORECAST_VALID_AT, completeFlightWeatherClient } from "../test/fixtures/complete-flight";
import { renderPilotIntentPlanner } from "./pilot-intent-planner";

class MemoryInputs implements PilotInputRepository {
  readonly plans: PilotInputPlan[] = [];
  readonly submissions: PilotInputPlan[] = [];
  readonly profiles: AircraftProfile[] = [];
  failSave = false;
  saveAttempts = 0;
  saveGate?: Promise<void>;
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
    this.saveAttempts += 1;
    if (this.saveGate) await this.saveGate;
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

function winds(overrides: Partial<WindsTransportClient & MetarTransportClient & TafTransportClient & { fetchPoint(query: AloftPointQuery): Promise<AloftPointAnswer> }> = {}): WindsTransportClient & MetarTransportClient & TafTransportClient & { fetchPoint(query: AloftPointQuery): Promise<AloftPointAnswer> } {
  return {
    ...completeFlightWeatherClient,
    fetchMetar: async (icao) => {
      const payload = await completeFlightWeatherClient.fetchMetar(icao);
      return { ...payload, metar: { ...payload.metar, icao }, provenance: { ...payload.provenance, cache: { ...payload.provenance.cache, key: `synthetic-metar:${icao}` } } };
    },
    fetchPoint: async (query) => ({ query, windFromDegTrue: 270, windSpeedKt: 12, temperatureC: 3, issuedAt: "2026-09-21T20:00:00.000Z", useFrom: "2026-09-21T21:00:00.000Z", useUntil: "2026-09-22T03:00:00.000Z", forecastCycle: "06", product: { region: "us", cycle: "06", cache: { status: "upstream_refresh", source: "upstream", ageSeconds: 0, fetchedAt: "2026-09-21T21:30:00.000Z", expiresAt: "2026-09-21T21:50:00.000Z", freshnessRemainingSeconds: 1200, servedAt: "2026-09-21T21:30:00.000Z" } }, sources: [{ stationId: "BRL", latitudeDeg: 40.7832, longitudeDeg: -91.1255, distanceNauticalMiles: 0, horizontalWeight: 1, lowerAltitudeFeet: query.altitudeFeetMsl, upperAltitudeFeet: query.altitudeFeetMsl, verticalWeight: 0, lowerWindFromDegTrue: 270, lowerWindSpeedKt: 12, upperWindFromDegTrue: 270, upperWindSpeedKt: 12, temperatureLowerAltitudeFeet: query.altitudeFeetMsl, temperatureUpperAltitudeFeet: query.altitudeFeetMsl, temperatureVerticalWeight: 0, temperatureLowerC: 3, temperatureUpperC: 3 }], method: "station-level", requestId: "44444444-4444-4444-8444-444444444444" }),
    fetchTaf: async () => ({ stationIcao: "KJVL", issuedAt: "2026-09-21T20:00:00.000Z", validFrom: "2026-09-21T21:00:00.000Z", validUntil: "2026-09-22T03:00:00.000Z", rawTaf: "SYNTHETIC TAF", groups: [{ kind: "prevailing", fromUtc: "2026-09-21T21:00:00.000Z", untilUtc: "2026-09-22T03:00:00.000Z", windDirectionType: "fixed", windFromDegTrue: 270, windSpeedKt: 8, gustKt: null, probabilityPercent: null, raw: "SYNTHETIC prevailing" }], requestId: "55555555-5555-4555-8555-555555555555" }),
    ...overrides,
  };
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

function waypointGroup(root: HTMLElement, id: string): HTMLElement {
  const group = root.querySelector<HTMLElement>(`[data-waypoint-group="${id}"]`);
  if (!group) throw new Error(`Missing waypoint group ${id}`);
  return group;
}

function groupInput(group: HTMLElement, name: string): HTMLInputElement {
  const field = group.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (!field) throw new Error(`Missing grouped input ${name}`);
  return field;
}

function button(root: HTMLElement, text: string): HTMLButtonElement {
  const element = [...root.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === text);
  if (!element) throw new Error(`Missing button ${text}`);
  return element;
}

function planSelector(root: HTMLElement): HTMLSelectElement {
  const select = root.querySelector<HTMLSelectElement>('select[aria-label="Saved plan"]');
  if (!select) throw new Error("Missing saved-plan selector");
  return select;
}

function choosePlan(root: HTMLElement, title: string): void {
  const select = planSelector(root);
  const option = [...select.options].find((candidate) => candidate.textContent === title);
  if (!option) throw new Error(`Missing saved plan ${title}`);
  select.value = option.value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function edit(root: HTMLElement, name: string, value: string, blur = false): void {
  const element = input(root, name);
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  if (blur) element.dispatchEvent(new Event("blur", { bubbles: true }));
}

async function mount(repository: MemoryInputs, client = winds(), airportLookup: AirportLookup = createLocalStudyAirportLookup()): Promise<HTMLElement> {
  const root = document.createElement("div");
  renderPilotIntentPlanner(root, { repository, airportLookup, winds: client, ids, clock });
  await settle();
  return root;
}

async function makeLocallyValid(root: HTMLElement, withSurfaceMetar = false): Promise<void> {
  edit(root, "plan-title", "Synthetic route");
  edit(root, "departure-time", "2026-09-21T22:00");
  edit(root, "fuel-aboard", "20");
  edit(root, "taxi-fuel", "0.8");
  edit(root, "reserve-fuel", "3");
  edit(root, "descent-target", "1800");
  edit(root, "departure-icao", "KORD");
  edit(root, "destination-icao", "KJVL");
  if (withSurfaceMetar) edit(root, "departure-metar-icao", "KORD");
  const select = root.querySelector<HTMLSelectElement>("[name='selectedProfileId']")!;
  select.value = profile.id;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
}

function assertProgressiveWeatherQueryOrder(callOrder: readonly string[], queries: readonly AloftPointQuery[]): void {
  expect(callOrder).toEqual(["metar", ...queries.map(() => "point")]);
  expect(queries).toHaveLength(2);
  const departure = coordinate(41.9742, -87.9073), destination = coordinate(42.6203, -89.0416);
  if (!departure.ok || !destination.ok) throw new Error("Study airport fixture coordinates were invalid.");
  const routeGeometry = calculateGreatCircleDistanceAndInitialCourse(departure.value, destination.value);
  if (!routeGeometry.ok) throw new Error(routeGeometry.error.message);
  const interiorDistances = queries.map((query) => routeDistanceForWeatherQuery(query, departure.value, destination.value, routeGeometry.value.distance));

  interiorDistances.forEach((distance) => {
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThan(routeGeometry.value.distance);
  });
  expect(interiorDistances).toHaveLength(2);
  expect(interiorDistances[1]).toBeGreaterThan(interiorDistances[0]!);
}

function routeDistanceForWeatherQuery(query: AloftPointQuery, departure: Coordinate, destination: Coordinate, routeDistance: number): number {
  const point = coordinate(query.latitudeDeg, query.longitudeDeg);
  if (!point.ok) throw new Error(point.error.message);
  const fromDeparture = calculateGreatCircleDistanceAndInitialCourse(departure, point.value);
  const toDestination = calculateGreatCircleDistanceAndInitialCourse(point.value, destination);
  if (!fromDeparture.ok || !toDestination.ok) throw new Error("A sampled weather event coordinate was invalid.");
  expect(fromDeparture.value.distance + toDestination.value.distance).toBeCloseTo(routeDistance, 1);
  return fromDeparture.value.distance;
}

describe("pilot intent planner", () => {
  it("blocks nominal TOC/TOD overlap before fetching any weather", async () => {
    const repository = new MemoryInputs();
    repository.profiles.push(profile);
    repository.plans.push({ id: "short-profile", title: "Short profile", rawFields: {
      "plan-title": "Short profile", "departure-time": "2026-09-21T22:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
      "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL", "departure-metar-icao": "KORD",
    }, selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [], cruiseAltitudeTexts: ["16000"], overrideReasons: {}, updatedAt: "2026-09-21T20:00:00.000Z", submissions: [] });
    const client = winds();
    const fetchMetar = vi.spyOn(client, "fetchMetar");
    const fetchPoint = vi.spyOn(client, "fetchPoint");
    const root = await mount(repository, client);

    expect(button(root, "Update navlog").disabled).toBe(false);
    button(root, "Update navlog").click();
    await settle();

    expect(root.querySelector("[role='status']")?.textContent).toMatch(/route is too short.*TOC.*TOD/i);
    expect(fetchMetar).not.toHaveBeenCalled();
    expect(fetchPoint).not.toHaveBeenCalled();
  });

  it("recovers a saved past departure from a fetched newer METAR and reuses the same report", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    repository.plans.push({
      id: "past-weather-plan", title: "Past weather route", rawFields: {
        "plan-title": "Past weather route", "departure-time": "2026-09-21T20:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
        "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL",
      }, selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {},
      updatedAt: "2026-09-21T20:00:00.000Z", submissions: [],
    });
    const returnedReports: MetarSuccessPayload[] = [];
    const client = winds({ fetchMetar: async (icao) => {
      const report = await completeFlightWeatherClient.fetchMetar(icao);
      returnedReports.push(report);
      return report;
    } });
    const fetchMetar = vi.spyOn(client, "fetchMetar");
    const fetchPoint = vi.spyOn(client, "fetchPoint");
    const root = await mount(repository, client);

    button(root, "Update navlog").click();
    await settle();
    expect(fetchMetar).toHaveBeenCalledTimes(1);
    expect(fetchMetar).toHaveBeenLastCalledWith("KORD");
    expect(root.querySelector("[role='status']")?.textContent).toContain("observed after the planned departure UTC");
    expect(fetchPoint).not.toHaveBeenCalled();
    expect(root.querySelector("[data-current-result]")).toBeNull();

    button(root, "Use current UTC").click();
    await settle();
    expect(input(root, "departure-time").value).toBe("2026-09-21T21:30");
    expect(repository.plans.find((plan) => plan.id === "past-weather-plan")?.rawFields["departure-time"]).toBe("2026-09-21T21:30");
    expect(root.querySelector("[role='status']")?.textContent).toContain("Pilot inputs saved");
    expect(root.querySelector("[role='status']")?.textContent).not.toContain("observed after the planned departure UTC");
    expect(fetchMetar).toHaveBeenCalledTimes(1);
    expect(fetchPoint).not.toHaveBeenCalled();

    button(root, "Update navlog").click();
    await settle();
    expect(fetchMetar).toHaveBeenCalledTimes(2);
    expect(fetchMetar).toHaveBeenLastCalledWith("KORD");
    expect(returnedReports).toHaveLength(2);
    expect(returnedReports[1]).toEqual(returnedReports[0]);
    expect(returnedReports[1]?.requestId).toBe(returnedReports[0]?.requestId);
    expect(fetchPoint).toHaveBeenCalled();
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
  });

  it("opens aircraft first and groups fuel aboard with plan inputs", async () => {
    const root = await mount(new MemoryInputs());
    expect(root.querySelector<HTMLDetailsElement>('[data-stage="aircraft"]')?.open).toBe(true);
    expect(root.querySelector<HTMLDetailsElement>('[data-stage="route"]')?.open).toBe(false);
    expect(root.querySelector('[data-stage="route"] [name="fuel-aboard"]')).not.toBeNull();
    expect(root.querySelector('[data-stage="aircraft"] [name="selectedProfileId"]')).not.toBeNull();
  });

  it("opens a saved plan at route information and keeps other user-opened stages open on rerender", async () => {
    const repository = new MemoryInputs();
    repository.profiles.push(profile);
    repository.plans.push({ id: "saved", title: "Saved", rawFields: { "plan-title": "Saved" }, selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [] });
    const root = await mount(repository);
    expect(root.querySelector<HTMLDetailsElement>('[data-stage="route"]')?.open).toBe(true);
    expect(root.querySelector('[data-stage="aircraft"] summary')?.textContent).toContain(profile.name);
    const aircraft = root.querySelector<HTMLDetailsElement>('[data-stage="aircraft"]')!;
    aircraft.open = true;
    button(root, "Add checkpoint").click();
    expect(root.querySelector<HTMLDetailsElement>('[data-stage="aircraft"]')?.open).toBe(true);
    expect(root.querySelector<HTMLDetailsElement>('[data-stage="route"]')?.open).toBe(true);
  });

  it("opens the navlog after calculation and reopens route information when an input changes", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);
    await makeLocallyValid(root);
    button(root, "Update navlog").click();
    await settle();
    expect(root.querySelector<HTMLDetailsElement>('[data-stage="navlog"]')?.open).toBe(true);
    edit(root, "fuel-aboard", "19", true);
    expect(root.querySelector<HTMLDetailsElement>('[data-stage="route"]')?.open).toBe(true);
    expect(root.querySelector("[data-current-result]")).toBeNull();
    expect(input(root, "fuel-aboard").value).toBe("19");
  });

  it("opens Calculate after a failed update without dropping route input", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile); repository.failSubmit = true;
    const root = await mount(repository);
    document.body.append(root);
    await makeLocallyValid(root);
    button(root, "Update navlog").click();
    await settle();
    expect(root.querySelector<HTMLDetailsElement>('[data-stage="calculate"]')?.open).toBe(true);
    expect(input(root, "fuel-aboard").value).toBe("20");
    expect(document.activeElement).toBe(root.querySelector('[data-stage="calculate"] summary'));
    root.remove();
  });

  it("uses native disclosure summaries and groups all starting fuel inputs", async () => {
    const root = await mount(new MemoryInputs());
    expect(root.querySelectorAll("details[data-stage] > summary")).toHaveLength(4);
    const fuel = input(root, "fuel-aboard").closest("fieldset");
    expect(fuel?.querySelector('[name="taxi-fuel"]')).not.toBeNull();
    expect(fuel?.querySelector('[name="reserve-fuel"]')).not.toBeNull();
    expect(fuel?.querySelector('[name^="override-tas-"]')).toBeNull();
    expect(root.querySelector("#departure-icao-error")?.textContent).toBe("");
    edit(root, "departure-icao", "A");
    expect(root.querySelector("#departure-icao-error")?.textContent).toContain("three- or four-character");
  });

  it("advances from Aircraft when a saved profile is selected", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);
    const select = root.querySelector<HTMLSelectElement>("[name='selectedProfileId']")!;
    select.value = profile.id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(root.querySelector<HTMLDetailsElement>('[data-stage="route"]')?.open).toBe(true);
    expect(root.querySelector<HTMLDetailsElement>('[data-stage="aircraft"]')?.open).toBe(false);
    button(root, "New plan").click();
    expect(root.querySelector<HTMLDetailsElement>('[data-stage="route"]')?.open).toBe(true);
    expect(root.querySelector<HTMLSelectElement>("[name='selectedProfileId']")?.value).toBe(profile.id);
  });

  it("keeps profile creation collapsed when a saved profile is available", async () => {
    const empty = await mount(new MemoryInputs());
    expect(empty.querySelector<HTMLDetailsElement>("details[data-profile-editor]")?.open).toBe(true);
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const saved = await mount(repository);
    expect(saved.querySelector<HTMLDetailsElement>("details[data-profile-editor]")?.open).toBe(false);
  });

  it("offers a route-to-calculate step without submitting incomplete inputs", async () => {
    const root = await mount(new MemoryInputs());
    button(root, "Continue to Calculate").click();
    expect(root.querySelector<HTMLDetailsElement>('[data-stage="calculate"]')?.open).toBe(true);
    expect(root.querySelector('[data-local-error]')?.textContent).toContain("Unavailable");
  });

  it("constructs UTC from a local picker and keeps a visible format hint", async () => {
    const root = await mount(new MemoryInputs());
    const picker = root.querySelector<HTMLInputElement>('[name="departure-local"]')!;
    expect(picker).not.toBeNull();
    picker.value = "2026-09-26T20:30";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    const expectedUtc = new Date(2026, 8, 26, 20, 30).toISOString().slice(0, 16);
    expect(input(root, "departure-time").value).toBe(expectedUtc);
    expect(root.querySelector('[data-utc-format]')?.textContent).toContain("YYYY-MM-DDTHH:mm");
    const currentClock = root.querySelector<HTMLElement>("[data-current-clock]")!;
    expect(currentClock.children).toHaveLength(2);
    expect(currentClock.children[0]?.textContent).toMatch(/Local UTC[−+]\d{2}:\d{2}: \d{4}-\d\d-\d\d /);
    expect(currentClock.children[1]?.textContent).toMatch(/^UTC: \d{4}-\d\d-\d\d /);
  });

  it("offers Use current UTC when an open plan's future departure becomes past", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    repository.plans.push({
      id: "future-plan", title: "Future route", rawFields: {
        "plan-title": "Future route", "departure-time": "2026-09-21T22:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
        "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL",
      }, selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {},
      updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    });
    let tick: (() => void) | undefined;
    const setInterval = vi.spyOn(window, "setInterval").mockImplementation((handler) => {
      tick = handler as () => void;
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });
    const clockNow = vi.spyOn(clock, "now").mockReturnValue(new Date("2026-09-21T21:59:59.000Z"));
    const root = document.createElement("div");
    document.body.append(root);
    try {
      renderPilotIntentPlanner(root, { repository, airportLookup: createLocalStudyAirportLookup(), winds: winds(), ids, clock });
      await settle();
      const control = root.querySelector<HTMLButtonElement>("button[data-use-current-utc]");
      expect(control?.hidden).toBe(true);

      clockNow.mockReturnValue(new Date("2026-09-21T22:01:01.000Z"));
      expect(control?.hidden).toBe(true);
      tick?.();
      expect(control?.hidden).toBe(false);
    } finally {
      root.remove();
      tick?.();
      setInterval.mockRestore();
      clockNow.mockRestore();
    }
  });

  it("lets a saved past departure explicitly use current UTC and fetches weather only on Update navlog", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    repository.plans.push({
      id: "past-plan", title: "Past route", rawFields: {
        "plan-title": "Past route", "departure-time": "2026-09-21T22:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
        "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL",
      }, selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {},
      updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    });
    const client = winds();
    const fetchMetar = vi.spyOn(client, "fetchMetar");
    const fetchPoint = vi.spyOn(client, "fetchPoint");
    const clockNow = vi.spyOn(clock, "now");
    try {
      const root = await mount(repository, client);
      expect(input(root, "departure-time").value).toBe("2026-09-21T22:00");
      expect(root.querySelector<HTMLButtonElement>("button[data-use-current-utc]")?.hidden).toBe(true);

      button(root, "Update navlog").click();
      await settle();
      expect(root.querySelector("[data-current-result]")).not.toBeNull();

      clockNow.mockReturnValue(new Date("2026-09-21T23:04:50.000Z"));
      button(root, "Override TAS for leg 1").click();
      expect(root.querySelector("button[data-use-current-utc]")?.textContent).toBe("Use current UTC");
      expect(root.querySelector("[data-current-result]")).not.toBeNull();
      const requestCounts = { metar: fetchMetar.mock.calls.length, points: fetchPoint.mock.calls.length };

      button(root, "Use current UTC").click();
      await settle();

      expect(input(root, "departure-time").value).toBe("2026-09-21T23:04");
      expect(repository.plans.find((plan) => plan.id === "past-plan")?.rawFields["departure-time"]).toBe("2026-09-21T23:04");
      expect(repository.submissions).toHaveLength(1);
      expect(fetchMetar).toHaveBeenCalledTimes(requestCounts.metar);
      expect(fetchPoint).toHaveBeenCalledTimes(requestCounts.points);
      expect(root.querySelector("[data-current-result]")).toBeNull();

      button(root, "Update navlog").click();
      await settle();
      expect(fetchMetar).toHaveBeenCalledTimes(requestCounts.metar + 1);
      expect(fetchMetar).toHaveBeenLastCalledWith("KORD");
      expect(fetchPoint.mock.calls.length).toBeGreaterThan(requestCounts.points);
      expect(root.querySelector("[data-current-result]")).not.toBeNull();
    } finally {
      clockNow.mockRestore();
    }
  });

  it("preserves invalid UTC text and leaves the local picker unset", async () => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    edit(root, "departure-time", "2026-09-27T01:", true);
    await settle();
    expect(input(root, "departure-time").value).toBe("2026-09-27T01:");
    expect(root.querySelector<HTMLInputElement>('[name="departure-local"]')?.value).toBe("");
    expect(root.querySelector("#departure-time-error")?.textContent).toContain("YYYY-MM-DDTHH:mm");
    expect(repository.plans.at(-1)?.rawFields["departure-time"]).toBe("2026-09-27T01:");
  });

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
    edit(root, "departure-metar-icao", "KORD", true);
    await settle();
    expect(repository.plans.at(-1)?.rawFields).toMatchObject({ "plan-title": "  literal title text  ", "departure-icao": "1C8", "departure-metar-icao": "KORD" });
    expect(root.querySelector<HTMLInputElement>("[name='departure-metar-icao']")?.value).toBe("KORD");

    repository.failSave = true;
    edit(root, "departure-icao", "1C8", true);
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("write failed");
    expect(button(root, "Update navlog").disabled).toBe(true);
  });

  it("saves an incomplete aboard-fuel working copy but gates Update until a valid value within capacity is entered", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);
    await makeLocallyValid(root);
    edit(root, "fuel-aboard", "", true);
    await settle();
    expect(button(root, "Update navlog").disabled).toBe(true);
    expect(repository.plans.at(-1)?.rawFields["fuel-aboard"]).toBe("");
    expect(repository.submissions).toHaveLength(0);
    expect(root.querySelector("#fuel-aboard-error")?.textContent).toContain("Enter a finite, nonnegative");

    edit(root, "fuel-aboard", "24");
    expect(button(root, "Update navlog").disabled).toBe(false);
    edit(root, "fuel-aboard", "24.01");
    expect(button(root, "Update navlog").disabled).toBe(true);
    expect(root.querySelector("#fuel-aboard-error")?.textContent).toContain("exceeds usable capacity");
    edit(root, "fuel-aboard", "not-a-number");
    expect(button(root, "Update navlog").disabled).toBe(true);
    expect(root.querySelector("#fuel-aboard-error")?.textContent).toContain("finite, nonnegative");
    edit(root, "fuel-aboard", "not-a-number", true);
    await settle();
    expect(repository.plans.at(-1)?.rawFields["fuel-aboard"]).toBe("not-a-number");
    expect(repository.submissions).toHaveLength(0);
    edit(root, "fuel-aboard", "-0.1");
    expect(button(root, "Update navlog").disabled).toBe(true);
    edit(root, "fuel-aboard", "0");
    expect(button(root, "Update navlog").disabled).toBe(false);
  });

  it("restores a legacy plan without fuel aboard as blank and preserves its other literal inputs", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    repository.plans.push({ id: "legacy-fuel", title: "Legacy", rawFields: { "plan-title": "Legacy", "departure-icao": "1C8", "taxi-fuel": "1.25" }, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [] });
    const root = await mount(repository);
    expect(input(root, "fuel-aboard").value).toBe("");
    expect(input(root, "departure-icao").value).toBe("1C8");
    expect(input(root, "taxi-fuel").value).toBe("1.25");
    expect(button(root, "Update navlog").disabled).toBe(true);
  });

  it("allows an entered aboard amount above 24 gallons when the profile has no capacity value", async () => {
    const repository = new MemoryInputs(); repository.profiles.push({ ...profile, usableFuelGallons: undefined });
    const root = await mount(repository);
    await makeLocallyValid(root);
    edit(root, "fuel-aboard", "99");
    expect(button(root, "Update navlog").disabled).toBe(false);
    expect(root.querySelector("#fuel-aboard-error")?.textContent).toBe("");
    button(root, "Update navlog").click();
    await settle();
    expect(repository.submissions).toHaveLength(1);
    expect(root.querySelector(".calculated-navlog")?.textContent).toContain("capacity comparison unavailable");
  });

  it("hides obsolete destination weather choices while preserving saved pilot fields", async () => {
    const repository = new MemoryInputs();
    repository.plans.push({
      id: "legacy-weather", title: "Legacy route", rawFields: {
        "plan-title": "Legacy route", "destination-taf-icao": "KJVL", "destination-metar-icao": "KMSN",
      }, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {},
      updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    });
    const root = await mount(repository);
    expect(root.querySelector("[name='destination-taf-icao']")).toBeNull();
    expect(root.querySelector("[name='destination-metar-icao']")).toBeNull();
    edit(root, "plan-title", "Legacy route edited", true);
    await settle();
    expect(repository.plans[0]?.rawFields).toMatchObject({ "destination-taf-icao": "KJVL", "destination-metar-icao": "KMSN" });
  });

  it("migrates an old surface-weather choice to departure only", async () => {
    const repository = new MemoryInputs();
    repository.plans.push({
      id: "legacy-weather", title: "Legacy route", rawFields: {
        "plan-title": "Legacy route", "surface-weather-icao": "KORD", "departure-icao": "1C8",
      }, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {},
      updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    });

    const root = await mount(repository);

    expect(input(root, "departure-metar-icao").value).toBe("KORD");
    expect(root.querySelector("[name='destination-taf-icao']")).toBeNull();
    expect(input(root, "departure-icao").value).toBe("1C8");

    edit(root, "plan-title", "Legacy route edited", true);
    await settle();
    expect(repository.plans[0]?.rawFields).toMatchObject({
      "surface-weather-icao": "KORD",
      "departure-metar-icao": "KORD",
      "departure-icao": "1C8",
    });
  });

  it("validates explicit endpoint alternates as exact four-character ICAO codes", async () => {
    const root = await mount(new MemoryInputs());

    edit(root, "departure-metar-icao", "KOR");
    expect(input(root, "departure-metar-icao").getAttribute("aria-invalid")).toBe("true");
    expect(root.querySelector("#departure-metar-icao-error")?.textContent).toContain("four-character ICAO");
    expect(button(root, "Update navlog").disabled).toBe(true);

    edit(root, "departure-metar-icao", "kord");
    expect(input(root, "departure-metar-icao").getAttribute("aria-invalid")).toBe("false");
    expect(input(root, "departure-metar-icao").value).toBe("kord");
  });

  it("requires an explicit source alternate when a resolved airport has only a three-character identifier", async () => {
    const repository = new MemoryInputs();
    repository.profiles.push(profile);
    const studyAirports = createLocalStudyAirportLookup();
    const airportLookup = {
      lookupAirportCode: async (code: string) => {
        const airport = await studyAirports.lookupAirportCode(code === "1C8" ? "KORD" : code);
        return code === "1C8" ? { ...airport, icao: "1C8" } : airport;
      },
    };
    const root = await mount(repository, winds(), airportLookup);
    await makeLocallyValid(root);
    edit(root, "departure-icao", "1C8");
    button(root, "Update navlog").click();
    await settle();

    expect(repository.submissions).toHaveLength(1);
    expect(root.querySelector("[role='status']")?.textContent).toContain("exact four-character departure METAR ICAO alternate");
    expect(root.querySelector(".calculated-navlog")).toBeNull();
  });

  it("updates from bounded point answers and endpoint weather without legacy discovery", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const callOrder: string[] = [];
    const pointQueries: AloftPointQuery[] = [];
    const client = winds({
      fetchPoint: async (query) => { callOrder.push("point"); pointQueries.push(query); return winds().fetchPoint(query); },
      fetchMetar: async (icao) => { callOrder.push("metar"); return completeFlightWeatherClient.fetchMetar(icao); },
    });
    const discovery = vi.spyOn(client, "discoverStations").mockRejectedValue(new Error("oversized legacy discovery response (651267 bytes)"));
    const fetchPoint = vi.spyOn(client, "fetchPoint");
    const fetchMetar = vi.spyOn(client, "fetchMetar");
    const fetchTaf = vi.spyOn(client, "fetchTaf");
    const root = await mount(repository, client);
    await makeLocallyValid(root, true);
    button(root, "Update navlog").click();
    await settle();

    expect(repository.submissions).toHaveLength(1);
    expect(fetchMetar).toHaveBeenCalledTimes(1);
    expect(fetchMetar).toHaveBeenCalledWith("KORD");
    expect(fetchTaf).not.toHaveBeenCalled();
    expect(fetchPoint).toHaveBeenCalledTimes(pointQueries.length);
    assertProgressiveWeatherQueryOrder(callOrder, pointQueries);
    expect(discovery).not.toHaveBeenCalled();
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
    expect(root.querySelector(".calculated-navlog")?.textContent).toContain("Current weather validated");
    expect(root.querySelector(".calculated-navlog")?.textContent).not.toContain("BRL");
    expect(root.querySelector(".calculated-navlog")?.textContent).not.toContain("SYNTHETIC TAF");
    const groundspeed = root.querySelector<HTMLButtonElement>('button[data-inspect-field="groundspeed"]');
    if (!groundspeed) throw new Error("Missing groundspeed inspection control.");
    const displayedGroundspeed = groundspeed.textContent ?? "";
    groundspeed.click();
    await settle();
    const inspector = root.querySelector(".calculation-inspector");
    if (!inspector) throw new Error("Missing current calculation inspector.");
    const storedMatch = /Stored unrounded value: ([0-9]+\.[0-9]+)\./.exec(inspector.textContent);
    if (!storedMatch) throw new Error("Inspector did not include the stored groundspeed value.");
    expect(Math.round(Number(storedMatch[1]))).toBe(Number.parseInt(displayedGroundspeed, 10));
    expect(inspector.textContent).toContain("departure METAR wind speed");
    expect(inspector.textContent).toContain("KORD");
    expect(inspector.textContent).not.toContain("horizontal weight");
    expect(inspector.querySelector(".calculation-walkthrough")?.textContent).toMatch(/True course and airspeed[\s\S]*Effective wind[\s\S]*Wind components[\s\S]*Wind correction and true heading[\s\S]*Groundspeed/);
    expect(inspector.querySelector("details")?.open).toBe(false);

  });

  it("displays a descent-rate warning from TOD weather", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    let requestNumber = 0;
    const client = winds({ fetchPoint: async (query) => {
      requestNumber += 1;
      const answer = await winds().fetchPoint(query);
      return { ...answer, windFromDegTrue: requestNumber === 2 ? 135 : 315, windSpeedKt: 70 };
    } });
    const root = await mount(repository, client);
    await makeLocallyValid(root, true);
    button(root, "Update navlog").click();
    await settle();

    expect(requestNumber).toBe(2);
    expect(repository.submissions).toHaveLength(1);
    expect(root.querySelector(".navlog-warnings")?.textContent).toContain("150%");
  });

  it("allows input submission without a pilot-selected forecast period and preserves unrelated raw fields", async () => {
    const repository = new MemoryInputs();
    repository.profiles.push(profile);
    const root = await mount(repository);
    await makeLocallyValid(root);
    edit(root, "fuel-aboard", "020.00");
    edit(root, "departure-metar-icao", "KORD", true);
    await settle();

    expect(root.querySelector("[name='selected-forecast-period']")).toBeNull();
    expect(root.querySelector("[name='forecast-choice']")).toBeNull();
    expect([...root.querySelectorAll("button")].some((candidate) => candidate.textContent === "Load published forecast periods")).toBe(false);
    expect(button(root, "Update navlog").disabled).toBe(false);
    button(root, "Update navlog").click();
    await settle();

    expect(repository.submissions).toHaveLength(1);
    expect(repository.submissions[0]?.rawFields).toMatchObject({
      "plan-title": "Synthetic route",
      "fuel-aboard": "020.00",
      "departure-metar-icao": "KORD",
      "taxi-fuel": "0.8",
    });
    expect(root.querySelector(".calculated-navlog")?.textContent).toContain("Current weather validated");
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
  });

  it("reopens the latest plan snapshot after blur autosave without losing fields on a later save", async () => {
    const repository = new MemoryInputs();
    const first: PilotInputPlan = {
      id: "first-plan", title: "First plan", rawFields: { "plan-title": "First plan", "departure-time": "2026-09-21T22:00" },
      checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    };
    const second: PilotInputPlan = {
      id: "second-plan", title: "Second plan", rawFields: { "plan-title": "Second plan" },
      checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    };
    repository.plans.push(first, second);
    const root = await mount(repository);

    edit(root, "departure-time", "2026-09-21T23:15", true);
    await settle();
    choosePlan(root, "First plan");
    await settle();
    expect(input(root, "departure-time").value).toBe("2026-09-21T23:15");

    choosePlan(root, "Second plan");
    await settle();
    choosePlan(root, "First plan");
    await settle();
    expect(input(root, "departure-time").value).toBe("2026-09-21T23:15");
    edit(root, "taxi-fuel", "1.2", true);
    await settle();

    expect(repository.plans.find((plan) => plan.id === first.id)?.rawFields).toMatchObject({
      "departure-time": "2026-09-21T23:15",
      "taxi-fuel": "1.2",
    });
  });

  it("saves incomplete literal and structured inputs without submitting or requesting weather", async () => {
    const repository = new MemoryInputs();
    const fetchMetar = vi.fn(winds().fetchMetar);
    const fetchPoint = vi.fn(winds().fetchPoint);
    const root = await mount(repository, winds({ fetchMetar, fetchPoint }));
    button(root, "Add checkpoint").click();
    await settle();
    edit(root, "plan-title", " Saved draft ");
    edit(root, "checkpoint-name-0", "Farm strip");
    edit(root, "checkpoint-coordinate-0", "N4145 W08730");
    edit(root, "altitude-0", "not decided");
    button(root, "Save changes").click();
    await settle();

    const saved = repository.plans.at(-1)!;
    expect(saved.rawFields["plan-title"]).toBe(" Saved draft ");
    expect(saved.checkpoints).toEqual([{ name: "Farm strip", coordinateText: "N4145 W08730" }]);
    expect(saved.cruiseAltitudeTexts).toEqual(["not decided", "4500"]);
    expect(repository.submissions).toHaveLength(0);
    expect(fetchMetar).not.toHaveBeenCalled();
    expect(fetchPoint).not.toHaveBeenCalled();
    expect(root.querySelector("[data-current-result]")).toBeNull();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Changes saved");
  });

  it("groups each outbound altitude and TAS control with its source waypoint", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);
    edit(root, "departure-icao", "KORD");
    edit(root, "destination-icao", "KJVL");
    button(root, "Add checkpoint").click();
    await settle();
    edit(root, "checkpoint-name-0", "Farm strip");
    edit(root, "checkpoint-coordinate-0", "N4145 W08730");
    await settle();

    const departure = waypointGroup(root, "departure");
    const checkpoint = waypointGroup(root, "checkpoint-0");
    expect(departure.tagName).toBe("FIELDSET");
    expect(departure.querySelector("legend")?.textContent).toContain("Departure");
    expect(groupInput(departure, "altitude-0")).toBeTruthy();
    expect(departure.querySelector("legend")?.textContent).toContain("Checkpoint 1");
    expect(departure.textContent).toContain("Override TAS for leg 1");

    expect(checkpoint.tagName).toBe("FIELDSET");
    expect(checkpoint.querySelector("legend")?.textContent).toContain("Checkpoint 1");
    expect(groupInput(checkpoint, "checkpoint-name-0").value).toBe("Farm strip");
    expect(groupInput(checkpoint, "checkpoint-coordinate-0")).toBeTruthy();
    expect(groupInput(checkpoint, "altitude-1")).toBeTruthy();
    expect(checkpoint.textContent).toContain("Destination");
    expect(checkpoint.textContent).toContain("Override TAS for leg 2");
  });

  it("inserts a new checkpoint altitude before the final target on a direct plan", async () => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    edit(root, "altitude-0", "6200");

    button(root, "Add checkpoint").click();
    await settle();

    expect(input(root, "altitude-0").value).toBe("4500");
    expect(input(root, "altitude-1").value).toBe("6200");
    expect(repository.plans.at(-1)?.cruiseAltitudeTexts).toEqual(["4500", "6200"]);
  });

  it.each([
    { index: 0, expected: ["6200", "7300", "8400"] },
    { index: 1, expected: ["5100", "7300", "8400"] },
    { index: 2, expected: ["5100", "6200", "8400"] },
  ])("removing checkpoint $index preserves the other altitude targets and final target", async ({ index, expected }) => {
    const repository = new MemoryInputs();
    repository.plans.push({
      id: `remove-checkpoint-${index}`, title: "Altitude preservation", rawFields: { "plan-title": "Altitude preservation" },
      checkpoints: [
        { name: "First", coordinateText: "414500N0873000W" },
        { name: "Middle", coordinateText: "414600N0873100W" },
        { name: "Last", coordinateText: "414700N0873200W" },
      ], cruiseAltitudeTexts: ["5100", "6200", "7300", "8400"], overrideReasons: {},
      updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    });
    const root = await mount(repository);

    button(root, `Remove checkpoint ${index + 1}`).click();
    await settle();

    expect(repository.plans[0]?.cruiseAltitudeTexts).toEqual(expected);
    expected.forEach((altitude, altitudeIndex) => expect(input(root, `altitude-${altitudeIndex}`).value).toBe(altitude));
  });

  it("labels checkpoint altitude requirements and the final cruise target when route details change", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    repository.plans.push({
      id: "stable-waypoint-labels", title: "Stable waypoint labels", rawFields: {
        "plan-title": "Stable waypoint labels", "departure-icao": "KORD", "destination-icao": "KJVL",
      }, selectedProfileId: profile.id, profileSnapshot: profile,
      checkpoints: [{ name: "Farm strip", coordinateText: "414500N0873000W" }], cruiseAltitudeTexts: ["4500", "6200"],
      overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    });
    const root = await mount(repository);

    edit(root, "checkpoint-name-0", "Renamed strip");
    edit(root, "destination-icao", "KMSN");
    button(root, "Override TAS for leg 1").click();

    const departure = waypointGroup(root, "departure");
    const checkpoint = waypointGroup(root, "checkpoint-0");
    expect(departure.querySelector("legend")?.textContent).toBe("Departure — outbound to Checkpoint 1");
    expect(groupInput(departure, "altitude-0").parentElement?.textContent).toContain("Altitude required at Checkpoint 1 (feet MSL)");
    expect(checkpoint.querySelector("legend")?.textContent).toBe("Checkpoint 1 — outbound to Destination");
    expect(groupInput(checkpoint, "altitude-1").parentElement?.textContent).toContain("Final cruise target before top of descent (feet MSL)");
    expect(root.querySelector(".waypoint-list h3")?.textContent).toBe("Waypoint altitudes and final cruise target");
  });

  it("labels the direct-route altitude as the final cruise target before top of descent", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);

    expect(input(root, "altitude-0").parentElement?.textContent).toContain("Final cruise target before top of descent (feet MSL)");
  });

  it("does not mark valid structured waypoint inputs invalid when opening a saved plan", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    repository.plans.push({
      id: "valid-waypoint-plan", title: "Valid waypoint plan", rawFields: {
        "plan-title": "Valid waypoint plan", "departure-time": "2026-09-21T22:00", "departure-icao": "KORD", "destination-icao": "KJVL",
        "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3", "descent-target": "1800",
      }, selectedProfileId: profile.id, profileSnapshot: profile,
      checkpoints: [{ name: "Farm strip", coordinateText: "414500N0873000W" }], cruiseAltitudeTexts: ["4500", "6200"],
      overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    });
    const root = await mount(repository);

    expect(input(root, "altitude-0").value).toBe("4500");
    expect(input(root, "altitude-0").getAttribute("aria-invalid")).toBe("false");
    expect(root.querySelector("#altitude-0-error")?.textContent).toBe("");
    expect(input(root, "checkpoint-name-0").getAttribute("aria-invalid")).toBe("false");
    expect(root.querySelector("#checkpoint-name-0-error")?.textContent).toBe("");
    expect(input(root, "checkpoint-coordinate-0").getAttribute("aria-invalid")).toBe("false");
    expect(root.querySelector("#checkpoint-coordinate-0-error")?.textContent).toBe("");
  });

  it("preserves outbound altitude indexing and clears TAS overrides when adding or removing a checkpoint", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    repository.plans.push({
      id: "waypoint-altitudes", title: "Waypoint altitudes", rawFields: {
        "plan-title": "Waypoint altitudes", "departure-icao": "KORD", "destination-icao": "KJVL",
        "override-tas-0": "102", "override-reason-0": "Training comparison",
      }, selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [], cruiseAltitudeTexts: ["4100"],
      overrideReasons: { "tas-0": "Training comparison" }, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    });
    const root = await mount(repository);
    button(root, "Add checkpoint").click();
    await settle();
    expect(repository.plans[0]?.cruiseAltitudeTexts).toEqual(["4500", "4100"]);
    expect(repository.plans[0]?.overrideReasons).toEqual({});
    expect(repository.plans[0]?.rawFields).not.toHaveProperty("override-tas-0");

    edit(root, "altitude-1", "6200", true);
    await settle();
    button(root, "Remove checkpoint 1").click();
    await settle();
    expect(repository.plans[0]?.cruiseAltitudeTexts).toEqual(["6200"]);
    expect(repository.plans[0]?.overrideReasons).toEqual({});
    expect(input(root, "altitude-0").value).toBe("6200");
  });

  it("waits for queued autosaves and keeps the editor text after a failed explicit save and retry", async () => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    edit(root, "plan-title", "typed without blur");
    let release!: () => void;
    repository.saveGate = new Promise<void>((resolve) => { release = resolve; });
    edit(root, "taxi-fuel", "1.25", true);
    button(root, "Save changes").click();
    await Promise.resolve();
    expect(repository.plans).toHaveLength(0);
    release();
    repository.saveGate = undefined;
    await settle();
    expect(repository.plans.at(-1)?.rawFields).toMatchObject({ "plan-title": "typed without blur", "taxi-fuel": "1.25" });
    expect(button(root, "Save changes").disabled).toBe(false);

    repository.failSave = true;
    edit(root, "plan-title", "retained after failure");
    const attemptsBeforeFailure = repository.saveAttempts;
    button(root, "Save changes").click();
    await settle();
    expect(repository.saveAttempts).toBeGreaterThan(attemptsBeforeFailure);
    expect(root.querySelector("[role='status']")?.textContent).toContain("write failed");
    expect(input(root, "plan-title").value).toBe("retained after failure");
    repository.failSave = false;
    button(root, "Save changes").click();
    await settle();
    expect(repository.plans.at(-1)?.rawFields["plan-title"]).toBe("retained after failure");
    expect(root.querySelector("[role='status']")?.textContent).toContain("Changes saved");
  });

  it("opens saved pilot inputs with editing and save guidance, separately from navlog calculation", async () => {
    const repository = new MemoryInputs();
    repository.plans.push({ id: "saved", title: "Saved route", rawFields: { "plan-title": "Saved route" }, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [] });
    const root = await mount(repository);
    expect(root.querySelector("[role='status']")?.textContent).toContain("ready to edit");
    expect(root.querySelector("[role='status']")?.textContent).toContain("Save changes");
    expect(button(root, "Update navlog")).toBeTruthy();
    expect(repository.submissions).toHaveLength(0);
    expect(root.querySelector("[data-current-result]")).toBeNull();
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

    choosePlan(root, "Other saved plan");
    await settle();
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

  it("gates Update navlog on required inputs and a profile without requiring a forecast period", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);
    expect(button(root, "Update navlog").disabled).toBe(true);
    await makeLocallyValid(root);
    expect(button(root, "Update navlog").disabled).toBe(false);
  });

  it("autosaves malformed airport codes but blocks submission before airport lookup", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const lookup = createLocalStudyAirportLookup();
    const lookupSpy = vi.spyOn(lookup, "lookupAirportCode");
    const root = await mount(repository, winds(), lookup);
    await makeLocallyValid(root, true);
    edit(root, "departure-icao", "K-ORD", true);
    await settle();

    expect(repository.plans.at(-1)?.rawFields["departure-icao"]).toBe("K-ORD");
    expect(button(root, "Update navlog").disabled).toBe(true);
    expect(root.querySelector("[data-local-error]")?.textContent).toContain("exactly 3 or 4 letters or numbers");
    lookupSpy.mockClear();
    button(root, "Update navlog").disabled = false;
    button(root, "Update navlog").click();
    await settle();
    expect(repository.submissions).toHaveLength(0);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it("accepts surrounding whitespace and lowercase airport codes using the normalized lookup codes", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const lookup = createLocalStudyAirportLookup();
    const lookupSpy = vi.spyOn(lookup, "lookupAirportCode");
    const root = await mount(repository, winds(), lookup);
    await makeLocallyValid(root, true);
    edit(root, "departure-icao", " kord ");
    edit(root, "destination-icao", "kjvl");
    expect(root.querySelector("[data-local-error]")?.textContent).toBe("");
    expect(button(root, "Update navlog").disabled).toBe(false);
    lookupSpy.mockClear();

    button(root, "Update navlog").click();
    await settle();
    expect(repository.submissions).toHaveLength(1);
    expect(lookupSpy).toHaveBeenCalledWith("KORD");
    expect(lookupSpy).toHaveBeenCalledWith("KJVL");
  });

  it("limits checkpoint creation to 25 and blocks a stored plan with 26", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const now = "2026-09-21T21:30:00.000Z";
    const initial: PilotInputPlan = {
      id: "checkpoint-limit", title: "Checkpoint limit", rawFields: {
        "plan-title": "Checkpoint limit", "departure-time": "2026-09-21T22:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
        "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL", "surface-weather-icao": "", "selected-forecast-period": COMPLETE_FLIGHT_FORECAST_VALID_AT,
      }, selectedProfileId: profile.id, profileSnapshot: profile,
      checkpoints: Array.from({ length: 24 }, (_, index) => ({ name: `Point ${index + 1}`, coordinateText: "N4145 W08730" })),
      cruiseAltitudeTexts: Array(25).fill("4500"), overrideReasons: {}, updatedAt: now, submissions: [],
    };
    repository.plans.push(initial);
    const root = await mount(repository);
    button(root, "Add checkpoint").click();
    await settle();
    expect(root.querySelectorAll("[name^='checkpoint-name-']")).toHaveLength(25);
    expect(button(root, "Add checkpoint").disabled).toBe(true);
    button(root, "Add checkpoint").disabled = false;
    button(root, "Add checkpoint").click();
    expect(root.querySelectorAll("[name^='checkpoint-name-']")).toHaveLength(25);

    const corrupt = { ...repository.plans[0]!, checkpoints: Array.from({ length: 26 }, (_, index) => ({ name: `Point ${index + 1}`, coordinateText: "N4145 W08730" })), cruiseAltitudeTexts: Array(27).fill("4500"), overrideReasons: {} };
    repository.plans[0] = corrupt;
    const reopened = await mount(repository);
    expect(button(reopened, "Update navlog").disabled).toBe(true);
    expect(reopened.querySelector("[data-local-error]")?.textContent).toContain("no more than 25 checkpoints");
    button(reopened, "Update navlog").disabled = false;
    button(reopened, "Update navlog").click();
    await settle();
    expect(repository.submissions).toHaveLength(0);
  });

  it("rejects titles over 120 trimmed characters before submission and accepts 120", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const weather = winds();
    const fetchForecast = vi.spyOn(weather, "fetchForecast");
    const fetchMetar = vi.spyOn(weather, "fetchMetar");
    const root = await mount(repository, weather);
    await makeLocallyValid(root);

    edit(root, "plan-title", `  ${"a".repeat(121)}  `);
    const title = input(root, "plan-title");
    expect(title.getAttribute("aria-invalid")).toBe("true");
    expect(root.querySelector(`#${title.name}-error`)?.textContent).toBe("Plan title must be 120 characters or fewer.");
    expect(button(root, "Update navlog").disabled).toBe(true);
    button(root, "Update navlog").click();
    await settle();
    expect(repository.submissions).toHaveLength(0);
    expect(fetchForecast).not.toHaveBeenCalled();
    expect(fetchMetar).not.toHaveBeenCalled();

    edit(root, "plan-title", `  ${"a".repeat(120)}  `);
    expect(title.getAttribute("aria-invalid")).toBe("false");
    expect(button(root, "Update navlog").disabled).toBe(false);
    button(root, "Update navlog").click();
    await settle();
    expect(repository.submissions).toHaveLength(1);
    expect(fetchForecast).not.toHaveBeenCalled();
    expect(fetchMetar).toHaveBeenCalledWith("KORD");
    expect(root.querySelector("[role='status']")?.textContent).toContain("Plan updated");
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
      "plan-title": "Profile draft route", "departure-time": "2026-09-21T22:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
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
    expect(button(root, "Update navlog").disabled).toBe(true);
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
    expect(button(root, "Update navlog").disabled).toBe(false);
  });

  it("recomputes the restored profile draft gate when another matching saved profile is selected", async () => {
    const repository = new MemoryInputs();
    const alternateProfile: AircraftProfile = { ...profile, id: "aircraft-2", name: "Alternate Cessna", cruiseTasKnots: 102 };
    repository.profiles.push(profile, alternateProfile);
    const rawFields = {
      "plan-title": "Profile choice route", "departure-time": "2026-09-21T22:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
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
    expect(button(root, "Update navlog").disabled).toBe(true);
    expect(root.querySelector("[data-local-error]")?.textContent).toContain("Save the edited aircraft profile first.");

    const selection = root.querySelector<HTMLSelectElement>("[name='selectedProfileId']")!;
    selection.value = alternateProfile.id;
    selection.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(input(root, "cruiseTasKnots").value).toBe("102");
    expect(button(root, "Update navlog").disabled).toBe(false);
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
    choosePlan(root, "First plan");
    await settle();

    const values: Record<string, string> = {
      "profile-name": "Pending Cessna", cruiseTasKnots: "95", cruiseFuelFlowGallonsPerHour: "6",
      climbRateFeetPerMinute: "500", climbTasKnots: "75", climbFuelFlowGallonsPerHour: "7",
      descentRateFeetPerMinute: "500", descentTasKnots: "100", descentFuelFlowGallonsPerHour: "5",
      "compass-deviation-card": "000:+1",
    };
    Object.entries(values).forEach(([name, value]) => { input(root, name).value = value; });
    root.querySelector("form:not(.route-form)")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(planSelector(root).disabled).toBe(true);
    expect(input(root, "profile-name").disabled).toBe(true);
    expect(input(root, "plan-title").disabled).toBe(true);
    choosePlan(root, "Second plan");
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
    expect(planSelector(root).disabled).toBe(false);
    expect(input(root, "profile-name").disabled).toBe(false);
  });

  it("blocks a nonpositive TAS override before submitting pilot inputs", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);
    await makeLocallyValid(root);
    button(root, "Override TAS for leg 1").click();
    edit(root, "override-tas-0", "-5");
    expect(button(root, "Update navlog").disabled).toBe(true);
    expect(root.textContent).toContain("Leg 1 TAS override must be a positive number of knots.");
    button(root, "Update navlog").click();
    await settle();
    expect(repository.submissions).toHaveLength(0);
  });

  it("reveals TAS editing only on request, retains a reason, and restores the aircraft default", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const fields = {
      "plan-title": "First plan", "departure-time": "2026-09-21T22:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
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
    expect(root.querySelector("[name='override-tas-0']")).toBeNull();
    expect(root.querySelector("input[type='checkbox']")).toBeNull();
    button(root, "Override TAS for leg 1").click();
    edit(root, "override-tas-0", "100", true);
    expect(button(root, "Update navlog").disabled).toBe(true);
    edit(root, "override-reason-0", "Training comparison", true);
    await settle();
    expect(button(root, "Update navlog").disabled).toBe(false);
    choosePlan(root, "Second plan");
    await settle();
    expect(input(root, "plan-title").value).toBe("Second plan");
    expect(input(root, "override-tas-0").value).toBe("102");
    expect(root.textContent).toContain("Overridden TAS");
    button(root, "Restore aircraft default for leg 1").click();
    await settle();
    expect(root.querySelector("[name='override-tas-0']")).toBeNull();
    expect(repository.plans.at(-1)?.rawFields["override-tas-0"]).toBeUndefined();
  });

  it("clears current evidence on edit or failure, retains submitted inputs, and recovers on success", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    let failPoint = false;
    const client = winds({ fetchPoint: async (query) => {
      if (failPoint) throw new Error("point service unavailable");
      return winds().fetchPoint(query);
    } });
    const root = await mount(repository, client);
    await makeLocallyValid(root, true);
    button(root, "Update navlog").click();
    await settle();
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
    expect(repository.submissions).toHaveLength(1);

    edit(root, "plan-title", "Changed inputs");
    expect(root.querySelector("[data-current-result]")).toBeNull();
    expect(root.querySelector('[data-stage="navlog"]')?.textContent).toContain("Update navlog to retrieve current weather and display a calculated navlog.");
    expect(root.querySelector("[role='status']")?.textContent).toContain("Inputs changed");
    expect(root.querySelector("[role='status']")?.textContent).not.toContain("Plan updated");
    failPoint = true;
    button(root, "Update navlog").click();
    await settle();
    expect(repository.submissions).toHaveLength(2);
    expect(repository.submissions[1]?.rawFields["plan-title"]).toBe("Changed inputs");
    expect(root.querySelector("[data-current-result]")).toBeNull();
    expect(root.querySelector("[role='status']")?.textContent).toContain("point service unavailable");

    edit(root, "departure-time", "2026-09-21T22:15");
    expect(root.querySelector("[role='status']")?.textContent).toContain("Inputs changed");
    expect(root.querySelector("[role='status']")?.textContent).not.toContain("point service unavailable");
    failPoint = false;
    button(root, "Update navlog").click();
    await settle();
    expect(repository.submissions).toHaveLength(3);
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Plan updated");
  });

  it("shows Save changes success after an update failure even when the inputs were not edited", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository, winds({ fetchPoint: async () => { throw new Error("point service unavailable"); } }));
    await makeLocallyValid(root, true);
    button(root, "Update navlog").click();
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("point service unavailable");

    button(root, "Save changes").click();
    await settle();
    expect(repository.submissions).toHaveLength(1);
    expect(root.querySelector("[role='status']")?.textContent).toContain("Changes saved");
    expect(root.querySelector("[role='status']")?.textContent).not.toContain("point service unavailable");
  });

  it("preserves but does not use a saved legacy forecast period", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const client = winds();
    const discover = vi.spyOn(client, "discoverStations");
    repository.plans.push({
      id: "legacy-period-plan", title: "Legacy period route", rawFields: {
        "plan-title": "Legacy period route", "departure-time": "2026-09-21T22:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
        "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL",
        "selected-forecast-period": COMPLETE_FLIGHT_FORECAST_VALID_AT,
      }, selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [], cruiseAltitudeTexts: ["4500"],
      overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    });
    const root = await mount(repository, client);
    expect(root.querySelector("[name='selected-forecast-period']")).toBeNull();
    button(root, "Update navlog").click();
    await settle();
    expect(repository.submissions).toHaveLength(1);
    expect(root.querySelector("[role='status']")?.textContent).toContain("Plan updated");
    expect(repository.submissions[0]?.rawFields["selected-forecast-period"]).toBe(COMPLETE_FLIGHT_FORECAST_VALID_AT);
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
    expect(discover).not.toHaveBeenCalled();
  });

  it("does not consult the legacy weather transport for a new endpoint selection", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const client = winds();
    const fetchForecast = vi.spyOn(client, "fetchForecast");
    const fetchMetar = vi.spyOn(client, "fetchMetar");
    const root = await mount(repository, client);
    await makeLocallyValid(root, true);
    button(root, "Update navlog").click();
    await settle();
    expect(repository.submissions).toHaveLength(1);
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Plan updated");
    expect(fetchForecast).not.toHaveBeenCalled();
    expect(fetchMetar).toHaveBeenCalledWith("KORD");
  });

  it("removes an override with a deleted checkpoint leg so the route can be updated", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const fields = {
      "plan-title": "Checkpoint route", "departure-time": "2026-09-21T22:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
      "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL", "surface-weather-icao": "KORD",
      "selected-forecast-period": COMPLETE_FLIGHT_FORECAST_VALID_AT, "override-tas-1": "102", "override-reason-1": "Leg 2 test",
    };
    repository.plans.push({
      id: "checkpoint-plan", title: "Checkpoint route", rawFields: fields, selectedProfileId: profile.id, profileSnapshot: profile,
      checkpoints: [{ name: "Farm strip", coordinateText: "414500N0873000W" }], cruiseAltitudeTexts: ["4500", "4500"],
      overrideReasons: { "tas-1": "Leg 2 test" }, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    });
    const root = await mount(repository);
    button(root, "Remove checkpoint 1").click();
    await settle();
    expect(root.querySelector("[name='override-tas-1']")).toBeNull();
    expect(root.querySelector("[name='override-reason-1']")).toBeNull();
    expect(root.querySelector("[data-local-error]")?.textContent).toBe("");
    expect(button(root, "Update navlog").disabled).toBe(false);
  });

  it("keeps the second leg override reason when another route field changes", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    repository.plans.push({
      id: "second-leg-plan", title: "Second leg", rawFields: {
        "plan-title": "Second leg", "override-tas-1": "102", "override-reason-1": "Training comparison",
      }, selectedProfileId: profile.id, profileSnapshot: profile,
      checkpoints: [{ name: "Farm strip", coordinateText: "414500N0873000W" }], cruiseAltitudeTexts: ["4500", "4500"],
      overrideReasons: { "tas-1": "Training comparison" }, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    });
    const root = await mount(repository);
    edit(root, "plan-title", "Second leg revised", true);
    await settle();
    expect(repository.plans[0]?.overrideReasons).toEqual({ "tas-1": "Training comparison" });
  });

  it("clears TAS overrides and reasons with a visible notice when adding a checkpoint", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const fields = {
      "plan-title": "Override route", "departure-time": "2026-09-21T22:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
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
    expect(root.querySelector("[name='override-tas-0']")).toBeNull();
    expect(root.querySelector("[name='override-reason-0']")).toBeNull();
    expect(root.querySelector("[name='override-tas-1']")).toBeNull();
    expect(root.querySelector("[name='override-reason-1']")).toBeNull();
    expect(repository.plans.at(-1)?.overrideReasons).toEqual({});
    expect(repository.plans.at(-1)?.rawFields).not.toHaveProperty("override-tas-0");
    expect(root.querySelector("[role='status']")?.textContent).toContain("overrides and reasons were cleared");
  });

  it("resets transient errors when starting a new plan or reopening a saved plan", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);
    await makeLocallyValid(root, true);
    button(root, "Update navlog").click();
    await settle();
    expect(repository.submissions).toHaveLength(1);
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Plan updated");

    button(root, "New plan").click();
    await settle();
    expect(input(root, "plan-title").value).toBe("New study route");
    expect(input(root, "departure-icao").value).toBe("");
    expect(input(root, "departure-metar-icao").value).toBe("");
    expect(root.querySelector(".calculated-navlog")).toBeNull();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Enter pilot inputs");

    choosePlan(root, "Synthetic route");
    await settle();
    expect(input(root, "plan-title").value).toBe("Synthetic route");
    expect(root.querySelector(".calculated-navlog")).toBeNull();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Saved pilot inputs are ready to edit");
  });

  it("clears the temporary weather error when a plan is replaced or reopened", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);
    await makeLocallyValid(root);
    button(root, "Update navlog").click();
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Plan updated");
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
    button(root, "New plan").click();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Enter pilot inputs");
    choosePlan(root, "Synthetic route");
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Saved pilot inputs are ready to edit");
    expect(root.querySelector(".calculated-navlog")).toBeNull();
  });

  it("opens a different saved plan after a route-weather update is unavailable", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const firstPlan: PilotInputPlan = {
      id: "first-plan", title: "First plan", rawFields: {
        "plan-title": "First plan", "departure-time": "2026-09-21T22:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
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
    const root = await mount(repository);
    button(root, "Update navlog").click();
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Plan updated");
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
    choosePlan(root, "Other plan");
    await settle();
    expect(input(root, "plan-title").value).toBe("Other plan");
    expect(root.querySelector(".calculated-navlog")).toBeNull();
  });
});
