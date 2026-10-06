import { describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbPilotInputRepository } from "../services/storage/pilot-input-repository";
import { createLocalStudyAirportLookup } from "../application/airport-lookup";
import type { AirportLookup } from "../application/airport-lookup";
import type { AircraftProfile } from "../domain/aircraft";
import type { PilotInputPlan, PilotInputRepository } from "../services/storage/pilot-input-repository";
import type { MetarTransportClient } from "../services/weather/winds-client";
import type { AloftPointAnswer, AloftPointQuery, MetarSuccessPayload } from "../../worker/api/contracts";
import { coordinate } from "../domain/coordinates";
import { calculateGreatCircleDistanceAndInitialCourse } from "../domain/distance-course";
import { aircraftProfile } from "../services/storage/__tests__/fixtures";
import { COMPLETE_FLIGHT_FORECAST_VALID_AT, completeFlightWeatherClient } from "../test/fixtures/complete-flight";
import { renderPilotIntentPlanner } from "./pilot-intent-planner";

class MemoryInputs implements PilotInputRepository {
  readonly plans: PilotInputPlan[] = [];
  readonly profiles: AircraftProfile[] = [];
  failSave = false;
  saveAttempts = 0;
  saveGate?: Promise<void>;
  failProfileSave = false;
  profileSaveGate?: Promise<void>;
  unsupportedProfileNotice = false;
  unsupportedPlanNotice = false;
  failInitialize = false;
  failOpen = false;
  async initialize(): Promise<void> { if (this.failInitialize) throw new Error("storage initialization failed"); }
  async listPlans(): Promise<readonly PilotInputPlan[]> { return this.plans; }
  async getPlan(id: string): Promise<PilotInputPlan | undefined> {
    if (this.failOpen) throw new Error("read failed");
    return this.plans.find((p) => p.id === id);
  }
  async saveWorkingCopy(plan: PilotInputPlan): Promise<void> {
    this.saveAttempts += 1;
    if (this.saveGate) await this.saveGate;
    if (this.failSave) throw new Error("write failed");
    this.replace(this.plans, plan);
  }
  async saveProfile(profile: AircraftProfile): Promise<void> {
    if (this.profileSaveGate) await this.profileSaveGate;
    if (this.failProfileSave) throw new Error("profile write failed");
    this.profiles.push(profile);
  }
  async listProfiles(): Promise<readonly AircraftProfile[]> { return this.profiles; }
  consumeUnsupportedPlanNotice(): boolean { const value = this.unsupportedPlanNotice; this.unsupportedPlanNotice = false; return value; }
  consumeUnsupportedProfileNotice(): boolean { const value = this.unsupportedProfileNotice; this.unsupportedProfileNotice = false; return value; }
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
const testWeatherCache = (kind: "winds" | "catalog") => {
  const now = Date.now(), ttlSeconds = kind === "winds" ? 3600 : 86400;
  const checkedAt = new Date(now).toISOString(), refreshAfter = new Date(now + ttlSeconds * 1000).toISOString();
  return { status: "upstream_refresh" as const, source: "upstream" as const, ageSeconds: 0,
    fetchedAt: checkedAt, checkedAt, refreshAfter, staleUntil: new Date(now + (ttlSeconds + 120) * 1000).toISOString(),
    expiresAt: refreshAfter, freshnessRemainingSeconds: ttlSeconds, servedAt: checkedAt, ttlSeconds,
    maxPayloadAgeSeconds: ttlSeconds + 120,
    key: kind === "winds" ? "winds:us:06" : "station-catalog:v1", resource: kind === "winds" ? "winds-temps" : "station-catalog" };
};

function winds(overrides: Partial<MetarTransportClient & { fetchPoint(query: AloftPointQuery): Promise<AloftPointAnswer> }> = {}): MetarTransportClient & { fetchPoint(query: AloftPointQuery): Promise<AloftPointAnswer> } {
  return {
    ...completeFlightWeatherClient,
    fetchMetar: async (icao) => {
      const payload = await completeFlightWeatherClient.fetchMetar(icao);
      return { ...payload, metar: { ...payload.metar, icao }, provenance: { ...payload.provenance, cache: { ...payload.provenance.cache, key: `synthetic-metar:${icao}` } } };
    },
    fetchPoint: async (query) => ({ query, windFromDegTrue: 270, windSpeedKt: 12, temperatureC: 3, issuedAt: "2026-09-21T20:00:00.000Z", useFrom: "2026-09-21T21:00:00.000Z", useUntil: "2026-09-22T03:00:00.000Z", forecastCycle: "06", product: { region: "us", cycle: "06", cache: testWeatherCache("winds") }, catalog: { cache: testWeatherCache("catalog") }, sources: [{ stationId: "BRL", latitudeDeg: 40.7832, longitudeDeg: -91.1255, distanceNauticalMiles: 0, horizontalWeight: 1, lowerAltitudeFeet: query.altitudeFeetMsl, upperAltitudeFeet: query.altitudeFeetMsl, verticalWeight: 0, lowerWindFromDegTrue: 270, lowerWindSpeedKt: 12, upperWindFromDegTrue: 270, upperWindSpeedKt: 12, temperatureLowerAltitudeFeet: query.altitudeFeetMsl, temperatureUpperAltitudeFeet: query.altitudeFeetMsl, temperatureVerticalWeight: 0, temperatureLowerC: 3, temperatureUpperC: 3 }], method: "station-level", requestId: "44444444-4444-4444-8444-444444444444" }),
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

function edit(root: HTMLElement, name: string, value: string): void {
  const element = input(root, name);
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function mount(repository: PilotInputRepository, client = winds(), airportLookup: AirportLookup = createLocalStudyAirportLookup()): Promise<HTMLElement> {
  const root = document.createElement("div");
  renderPilotIntentPlanner(root, { repository, airportLookup, winds: client, ids, clock });
  await settle();
  if (repository instanceof IndexedDbPilotInputRepository) await vi.waitFor(() => expect(root.querySelector("[name='plan-title']")).not.toBeNull());
  return root;
}

async function makeLocallyValid(root: HTMLElement, withSurfaceMetar = false): Promise<void> {
  edit(root, "plan-title", "Synthetic route");
  edit(root, "departure-time", "2026-09-21T22:00");
  edit(root, "fuel-aboard", "20");
  edit(root, "taxi-fuel", "0.8");
  edit(root, "reserve-fuel", "3");
  edit(root, "departure-icao", "KORD");
  edit(root, "destination-icao", "KJVL");
  if (withSurfaceMetar) edit(root, "departure-metar-icao", "KORD");
  const select = root.querySelector<HTMLSelectElement>("[name='selectedProfileId']")!;
  select.value = profile.id;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
}

async function assertCompactNavlogInspector(root: HTMLElement, inspector: Element): Promise<void> {
  const displayedNavlog = root.querySelector<HTMLElement>(".calculated-navlog");
  expect(displayedNavlog?.nextElementSibling).toBe(inspector);
  expect(displayedNavlog?.querySelectorAll("tbody tr").length).toBeGreaterThan(0);
  expect(displayedNavlog?.textContent).not.toContain("Wind components");
  const fuel = root.querySelector<HTMLButtonElement>('button[data-inspect-field="fuel"]');
  if (!fuel) throw new Error("Missing fuel inspection control.");
  fuel.click();
  await settle();
  const fuelInspector = root.querySelector(".calculation-inspector");
  expect(fuelInspector?.querySelector(".calculation-walkthrough")?.textContent).toMatch(/Groundspeed[\s\S]*Time enroute[\s\S]*Fuel consumed/);
  expect(root.querySelector(".calculated-navlog")?.nextElementSibling).toBe(fuelInspector);
  const compass = root.querySelector<HTMLButtonElement>('button[data-inspect-field="compassHeading"]');
  if (!compass) throw new Error("Missing compass-heading inspection control.");
  compass.click();
  await settle();
  expect(root.querySelector(".calculation-inspector .calculation-walkthrough")?.textContent).toMatch(/Wind correction[\s\S]*True heading[\s\S]*Magnetic heading[\s\S]*Compass heading/);
}

function assertProgressiveWeatherQueryOrder(callOrder: readonly string[], queries: readonly AloftPointQuery[]): void {
  expect(callOrder).toEqual(["metar", "point", "point"]);
  expect(queries).toHaveLength(2);
  const departure = coordinate(41.9742, -87.9073), destination = coordinate(42.6203, -89.0416);
  if (!departure.ok || !destination.ok) throw new Error("Study airport fixture coordinates were invalid.");
  const route = calculateGreatCircleDistanceAndInitialCourse(departure.value, destination.value);
  if (!route.ok) throw new Error(route.error.message);
  const destinationForecast = queries[0]!;
  expect(destinationForecast).toMatchObject({ latitudeDeg: destination.value.latitude, longitudeDeg: destination.value.longitude, altitudeFeetMsl: 4500 });
  const estimatedArrival = new Date(Date.parse("2026-09-21T22:00:00.000Z") + route.value.distance / profile.cruiseTasKnots * 3_600_000);
  expect(destinationForecast.plannedUtc).toBe(estimatedArrival.toISOString());
  const tocForecast = queries[1]!;
  expect(tocForecast.altitudeFeetMsl).toBe(4500);
  expect(Date.parse(tocForecast.plannedUtc)).toBeLessThan(Date.parse(destinationForecast.plannedUtc));
  const toc = coordinate(tocForecast.latitudeDeg, tocForecast.longitudeDeg);
  if (!toc.ok) throw new Error(`${toc.error.message}: ${JSON.stringify(tocForecast)}`);
  const toToc = calculateGreatCircleDistanceAndInitialCourse(departure.value, toc.value);
  const toDestination = calculateGreatCircleDistanceAndInitialCourse(toc.value, destination.value);
  if (!toToc.ok || !toDestination.ok) throw new Error("TOC forecast coordinate was invalid.");
  expect(toToc.value.distance).toBeGreaterThan(0);
  expect(toToc.value.distance + toDestination.value.distance).toBeCloseTo(route.value.distance, 1);
}

describe("pilot intent planner", () => {
  it("guides pilots to add recognizable visual checkpoints along the route", async () => {
    const root = await mount(new MemoryInputs());
    const route = root.querySelector('[data-stage="route"]');
    expect(route?.textContent).toMatch(/visual checkpoints from estimated TOC through estimated TOD/i);
  });

  it("shows the recreate notice for unsupported stored profile schemas", async () => {
    const repository = new MemoryInputs();
    repository.unsupportedProfileNotice = true;
    const root = await mount(repository);
    expect(root.querySelector("[role='status']")?.textContent).toContain("uses an unsupported format and was removed");
    expect(root.querySelector("[role='status']")?.textContent).toContain("Recreate the profile");
  });
  it("blocks a nominal TOC/TOD overlap after the placement weather is available", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    repository.plans.push({ schemaVersion: 1, id: "short-profile", title: "Short profile", rawFields: { "cruise-altitude": "16000",
      "plan-title": "Short profile", "departure-time": "2026-09-21T22:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
      "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL", "departure-metar-icao": "KORD",
    }, selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [], cruiseAltitudeTexts: ["16000"], overrideReasons: {}, updatedAt: "2026-09-21T20:00:00.000Z" });
    const client = winds();
    const fetchMetar = vi.spyOn(client, "fetchMetar");
    const fetchPoint = vi.spyOn(client, "fetchPoint");
    const root = await mount(repository, client);

    expect(button(root, "Update navlog").disabled).toBe(false);
    button(root, "Update navlog").click();
    await settle();

    expect(root.querySelector("[role='status']")?.textContent).toMatch(/Estimated TOC .* TOD .* overlap/i);
    expect(fetchMetar).toHaveBeenCalledTimes(1);
    expect(fetchPoint).toHaveBeenCalledTimes(1);
  });

  it("recovers a saved past departure from a fetched newer METAR and reuses the same report", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    repository.plans.push({ schemaVersion: 1,
      id: "past-weather-plan", title: "Past weather route", rawFields: { "cruise-altitude": "4500",
        "plan-title": "Past weather route", "departure-time": "2026-09-21T20:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
        "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL",
      }, selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {},
      updatedAt: "2026-09-21T20:00:00.000Z",
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
    expect(input(root, "departure-time").dataset.unsaved).toBe("true");
    button(root, "Save changes").click();
    await settle();
    expect(repository.plans.find((plan) => plan.id === "past-weather-plan")?.rawFields["departure-time"]).toBe("2026-09-21T21:30");
    expect(root.querySelector("[role='status']")?.textContent).toContain("Changes saved");
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
    repository.plans.push({ schemaVersion: 1, id: "saved", title: "Saved", rawFields: { "cruise-altitude": "4500", "plan-title": "Saved" }, selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z" });
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
    edit(root, "fuel-aboard", "19");
    expect(root.querySelector<HTMLDetailsElement>('[data-stage="route"]')?.open).toBe(true);
    expect(root.querySelector("[data-current-result]")).toBeNull();
    expect(input(root, "fuel-aboard").value).toBe("19");
  });

  it("saves the latest inputs and selected profile snapshot before requesting weather", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    let planAtWeatherRequest: PilotInputPlan | undefined;
    const client = winds({ fetchMetar: async (icao) => {
      planAtWeatherRequest = structuredClone(repository.plans.at(-1));
      return winds().fetchMetar(icao);
    } });
    const root = await mount(repository, client);
    await makeLocallyValid(root);
    edit(root, "plan-title", "Latest route inputs");
    await settle();

    button(root, "Update navlog").click();
    await settle();

    expect(planAtWeatherRequest?.rawFields["plan-title"]).toBe("Latest route inputs");
    expect(planAtWeatherRequest?.selectedProfileId).toBe(profile.id);
    expect(planAtWeatherRequest?.profileSnapshot).toEqual(profile);
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
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
    repository.plans.push({ schemaVersion: 1,
      id: "future-plan", title: "Future route", rawFields: { "cruise-altitude": "4500",
        "plan-title": "Future route", "departure-time": "2026-09-21T22:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
        "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL",
      }, selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {},
      updatedAt: "2026-09-21T21:30:00.000Z",
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
    repository.plans.push({ schemaVersion: 1,
      id: "past-plan", title: "Past route", rawFields: { "cruise-altitude": "4500",
        "plan-title": "Past route", "departure-time": "2026-09-21T22:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
        "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL",
      }, selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {},
      updatedAt: "2026-09-21T21:30:00.000Z",
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
    edit(root, "departure-time", "2026-09-27T01:");
    await settle();
    expect(input(root, "departure-time").value).toBe("2026-09-27T01:");
    expect(root.querySelector<HTMLInputElement>('[name="departure-local"]')?.value).toBe("");
    expect(root.querySelector("#departure-time-error")?.textContent).toContain("YYYY-MM-DDTHH:mm");
    button(root, "Save changes").click();
    await settle();
    expect(repository.plans.at(-1)?.rawFields["departure-time"]).toBe("2026-09-27T01:");
  });

  it("shows repository initialization failure in the planner", async () => {
    const repository = new MemoryInputs(); repository.failInitialize = true;
    const root = await mount(repository);
    expect(root.querySelector("[role='status']")?.textContent).toContain("storage initialization failed");
  });

  it("keeps ordinary blur out of persistence and tracks literal textbox changes", async () => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    const title = input(root, "plan-title");
    title.dispatchEvent(new Event("blur", { bubbles: true }));
    await settle();
    expect(repository.saveAttempts).toBe(0);
    expect(title.hasAttribute("data-unsaved")).toBe(false);

    edit(root, "plan-title", "New study route ");
    expect(title.dataset.unsaved).toBe("true");
    expect(title.getAttribute("aria-describedby")).toContain("textbox-unsaved-description");
    expect(root.querySelector("#textbox-unsaved-description")?.textContent).toBe("Unsaved changes.");
    expect(root.querySelector("#textbox-unsaved-description")?.hasAttribute("hidden")).toBe(true);
    expect(title.getAttribute("aria-invalid")).not.toBe("true");
    title.dispatchEvent(new Event("blur", { bubbles: true }));
    await settle();
    expect(repository.saveAttempts).toBe(0);

    edit(root, "plan-title", "New study route");
    expect(title.hasAttribute("data-unsaved")).toBe(false);
    expect(title.getAttribute("aria-describedby")).not.toContain("textbox-unsaved-description");
    edit(root, "plan-title", "");
    expect(title.dataset.unsaved).toBe("true");
    edit(root, "plan-title", "New study route");
    expect(title.hasAttribute("data-unsaved")).toBe(false);
    edit(root, "taxi-fuel", "1");
    button(root, "Save changes").click();
    await settle();
    const attemptsBeforeProfileBlur = repository.saveAttempts;
    edit(root, "taxi-fuel", "1.0");
    expect(input(root, "taxi-fuel").dataset.unsaved).toBe("true");
    edit(root, "taxi-fuel", "1");
    expect(input(root, "taxi-fuel").hasAttribute("data-unsaved")).toBe(false);

    const profileName = input(root, "profile-name");
    edit(root, "profile-name", "Uncommitted profile text");
    expect(profileName.dataset.unsaved).toBe("true");
    profileName.dispatchEvent(new Event("blur", { bubbles: true }));
    await settle();
    expect(repository.saveAttempts).toBe(attemptsBeforeProfileBlur);
    edit(root, "profile-name", "");
    expect(profileName.hasAttribute("data-unsaved")).toBe(false);
  });

  it("preserves changed markers through a failed structural rerender and advances them after retry", async () => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    repository.failSave = true;
    edit(root, "plan-title", "Retained across rerender");
    button(root, "Add checkpoint").click();
    await settle();

    expect(input(root, "plan-title").value).toBe("Retained across rerender");
    expect(input(root, "plan-title").dataset.unsaved).toBe("true");
    expect(input(root, "checkpoint-name-0").hasAttribute("data-unsaved")).toBe(false);
    expect(root.querySelector("[role='status']")?.textContent).toContain("write failed");

    repository.failSave = false;
    button(root, "Retry save").click();
    await settle();
    expect(input(root, "plan-title").hasAttribute("data-unsaved")).toBe(false);
    expect(input(root, "plan-title").getAttribute("aria-describedby")).not.toContain("textbox-unsaved-description");
    edit(root, "plan-title", "Changed after acknowledgement");
    expect(input(root, "plan-title").dataset.unsaved).toBe("true");
    edit(root, "plan-title", "Retained across rerender");
    expect(input(root, "plan-title").hasAttribute("data-unsaved")).toBe(false);
  });

  it("starts a newly added checkpoint textbox clean when its field name is reused", async () => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    button(root, "Add checkpoint").click();
    await settle();
    edit(root, "checkpoint-name-0", "Removed checkpoint");
    edit(root, "checkpoint-coordinate-0", "N4145 W08730");
    button(root, "Save changes").click();
    await settle();

    button(root, "Remove checkpoint 1").click();
    await settle();
    button(root, "Add checkpoint").click();
    await settle();
    expect(input(root, "checkpoint-name-0").value).toBe("");
    expect(input(root, "checkpoint-name-0").hasAttribute("data-unsaved")).toBe(false);
    expect(input(root, "checkpoint-coordinate-0").hasAttribute("data-unsaved")).toBe(false);
  });

  it("marks the derived local departure control against its matching baseline", async () => {
    const originalZone = process.env.TZ;
    process.env.TZ = "America/Chicago";
    try {
      const repository = new MemoryInputs();
      const root = await mount(repository);
      const local = root.querySelector<HTMLInputElement>("[name='departure-local']")!;
      local.value = "2026-09-21T17:30";
      local.dispatchEvent(new Event("change", { bubbles: true }));
      expect(local.dataset.unsaved).toBe("true");
      expect(input(root, "departure-time").value).toBe("2026-09-21T22:30");
      expect(input(root, "departure-time").dataset.unsaved).toBe("true");
      button(root, "Save changes").click();
      await settle();
      expect(local.hasAttribute("data-unsaved")).toBe(false);
      expect(input(root, "departure-time").hasAttribute("data-unsaved")).toBe(false);
    } finally {
      if (originalZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalZone;
    }
  });

  it("acknowledges a saved draft when the following Open read fails", async () => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    edit(root, "plan-title", "First");
    button(root, "Save changes").click();
    await settle();
    button(root, "New plan").click();
    await settle();
    edit(root, "plan-title", "Second");
    button(root, "Save changes").click();
    await settle();

    edit(root, "plan-title", "Saved before failed open");
    repository.failOpen = true;
    choosePlan(root, "First");
    await settle();

    expect(repository.plans.some((plan) => plan.rawFields["plan-title"] === "Saved before failed open")).toBe(true);
    expect(input(root, "plan-title").hasAttribute("data-unsaved")).toBe(false);
  });

  it("starts restored TAS and reason textboxes clean when the editor is revealed again", async () => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    button(root, "Override TAS for leg 1").click();
    await settle();
    edit(root, "override-tas-0", "100");
    edit(root, "override-reason-0", "Training");
    button(root, "Save changes").click();
    await settle();

    button(root, "Restore aircraft default for leg 1").click();
    await settle();
    repository.failSave = true;
    button(root, "Override TAS for leg 1").click();
    await settle();

    expect(input(root, "override-tas-0").value).toBe("");
    expect(input(root, "override-tas-0").hasAttribute("data-unsaved")).toBe(false);
    expect(input(root, "override-reason-0").value).toBe("");
    expect(input(root, "override-reason-0").hasAttribute("data-unsaved")).toBe(false);
  });

  it("retains the UTC unsaved description after a failed structural rerender", async () => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    edit(root, "departure-time", "2026-09-21T22:30");
    repository.failSave = true;
    button(root, "Add checkpoint").click();
    await settle();

    expect(input(root, "departure-time").dataset.unsaved).toBe("true");
    expect(input(root, "departure-time").getAttribute("aria-describedby")).toContain("departure-time-error");
    expect(input(root, "departure-time").getAttribute("aria-describedby")).toContain("departure-utc-format");
    expect(input(root, "departure-time").getAttribute("aria-describedby")).toContain("textbox-unsaved-description");
    expect(root.querySelector("#textbox-unsaved-description")?.hasAttribute("hidden")).toBe(true);
  });

  it("preserves literal TAS text and a clean outline across another override rerender", async () => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    button(root, "Add checkpoint").click();
    await settle();
    button(root, "Override TAS for leg 1").click();
    await settle();
    edit(root, "override-tas-0", " 100 ");
    edit(root, "override-reason-0", "Training");
    button(root, "Save changes").click();
    await settle();
    expect(input(root, "override-tas-0").hasAttribute("data-unsaved")).toBe(false);

    repository.failSave = true;
    button(root, "Override TAS for leg 2").click();
    await settle();

    expect(input(root, "override-tas-0").value).toBe(" 100 ");
    expect(input(root, "override-tas-0").hasAttribute("data-unsaved")).toBe(false);
  });

  it("persists literal invalid field text only on explicit save and reports failed writes", async () => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    edit(root, "plan-title", "  literal title text  ");
    edit(root, "departure-icao", "1C8");
    edit(root, "departure-metar-icao", "KORD");
    expect(repository.saveAttempts).toBe(0);
    button(root, "Save changes").click();
    await settle();
    expect(repository.plans.at(-1)?.rawFields).toMatchObject({ "plan-title": "  literal title text  ", "departure-icao": "1C8", "departure-metar-icao": "KORD" });
    expect(root.querySelector<HTMLInputElement>("[name='departure-metar-icao']")?.value).toBe("KORD");

    repository.failSave = true;
    edit(root, "departure-icao", "1C8X");
    button(root, "Save changes").click();
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("write failed");
    expect(button(root, "Update navlog").disabled).toBe(true);
  });

  it("saves an incomplete aboard-fuel working copy but gates Update until a valid value within capacity is entered", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);
    await makeLocallyValid(root);
    edit(root, "fuel-aboard", "");
    button(root, "Save changes").click();
    await settle();
    expect(button(root, "Update navlog").disabled).toBe(true);
    expect(repository.plans.at(-1)?.rawFields["fuel-aboard"]).toBe("");
    expect(root.querySelector("#fuel-aboard-error")?.textContent).toContain("Enter a finite, nonnegative");

    edit(root, "fuel-aboard", "24");
    expect(button(root, "Update navlog").disabled).toBe(false);
    edit(root, "fuel-aboard", "24.01");
    expect(button(root, "Update navlog").disabled).toBe(true);
    expect(root.querySelector("#fuel-aboard-error")?.textContent).toContain("exceeds usable capacity");
    edit(root, "fuel-aboard", "not-a-number");
    expect(button(root, "Update navlog").disabled).toBe(true);
    expect(root.querySelector("#fuel-aboard-error")?.textContent).toContain("finite, nonnegative");
    edit(root, "fuel-aboard", "not-a-number");
    button(root, "Save changes").click();
    await settle();
    expect(repository.plans.at(-1)?.rawFields["fuel-aboard"]).toBe("not-a-number");
    edit(root, "fuel-aboard", "-0.1");
    expect(button(root, "Update navlog").disabled).toBe(true);
    edit(root, "fuel-aboard", "0");
    expect(button(root, "Update navlog").disabled).toBe(false);
  });

  it("opens an incomplete current plan without fuel aboard as blank", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    repository.plans.push({ schemaVersion: 1, id: "legacy-fuel", title: "Legacy", rawFields: { "cruise-altitude": "4500", "plan-title": "Legacy", "departure-icao": "1C8", "taxi-fuel": "1.25" }, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z" });
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
    expect(root.querySelector(".calculated-navlog")?.textContent).toContain("capacity comparison unavailable");
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
    const fetchPoint = vi.spyOn(client, "fetchPoint");
    const fetchMetar = vi.spyOn(client, "fetchMetar");
    const root = await mount(repository, client);
    await makeLocallyValid(root, true);
    button(root, "Update navlog").click();
    await settle();

    expect(fetchMetar).toHaveBeenCalledTimes(1);
    expect(fetchMetar).toHaveBeenCalledWith("KORD");
    expect(fetchPoint).toHaveBeenCalledTimes(pointQueries.length);
    assertProgressiveWeatherQueryOrder(callOrder, pointQueries);
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
    expect(root.querySelector(".calculated-navlog")?.textContent).toContain("Selected weather inputs were checked");
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
    expect(inspector.textContent).toContain("TOC placement uses departure METAR wind as an initial climb approximation.");
    expect(inspector.textContent).toContain("KORD");
    expect(inspector.textContent).not.toContain("horizontal weight");
    expect(inspector.querySelector(".calculation-walkthrough")?.textContent).toMatch(/True course and airspeed[\s\S]*Effective wind[\s\S]*Wind components[\s\S]*Wind correction and true heading[\s\S]*Groundspeed/);
    expect(inspector.querySelector("details")?.open).toBe(false);
    await assertCompactNavlogInspector(root, inspector);

  });

  it("asks the pilot to move or remove a pre-TOC checkpoint without deleting it", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const client = winds();
    const fetchPoint = vi.spyOn(client, "fetchPoint");
    const root = await mount(repository, client);
    await makeLocallyValid(root, true);
    button(root, "Add checkpoint").click();
    await settle();
    edit(root, "checkpoint-name-0", "Departure landmark");
    edit(root, "checkpoint-coordinate-0", "41.983333, -87.916667");
    expect(root.querySelector("[data-local-error]")?.textContent).toBe("");
    button(root, "Update navlog").click();
    await settle();

    expect(root.querySelector("[role='status']")?.textContent).toContain("Departure landmark");
    expect(root.querySelector("[role='status']")?.textContent).toContain("before estimated TOC");
    expect(root.querySelector("[role='status']")?.textContent).toMatch(/remove|move/iu);
    expect(fetchPoint).toHaveBeenCalledTimes(1);
    expect(root.querySelector(".calculated-navlog")).toBeNull();
    expect(input(root, "checkpoint-name-0").value).toBe("Departure landmark");
    expect(input(root, "checkpoint-coordinate-0").value).toBe("41.983333, -87.916667");
  });

  it("keeps the profile descent rate fixed when destination winds affect the estimate", async () => {
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
    expect(root.querySelector(".navlog-warnings")?.textContent ?? "").not.toContain("150%");
  });

  it("saves current inputs without a pilot-selected forecast period before weather calculation", async () => {
    const repository = new MemoryInputs();
    repository.profiles.push(profile);
    const root = await mount(repository);
    await makeLocallyValid(root);
    edit(root, "fuel-aboard", "020.00");
    edit(root, "departure-metar-icao", "KORD");
    await settle();

    expect(root.querySelector("[name='selected-forecast-period']")).toBeNull();
    expect(root.querySelector("[name='forecast-choice']")).toBeNull();
    expect([...root.querySelectorAll("button")].some((candidate) => candidate.textContent === "Load published forecast periods")).toBe(false);
    expect(button(root, "Update navlog").disabled).toBe(false);
    button(root, "Update navlog").click();
    await settle();

    expect(repository.plans.at(-1)?.rawFields).toMatchObject({
      "plan-title": "Synthetic route",
      "fuel-aboard": "020.00",
      "departure-metar-icao": "KORD",
      "taxi-fuel": "0.8",
    });
    expect(root.querySelector(".calculated-navlog")?.textContent).toContain("Selected weather inputs were checked");
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
  });

  it("reopens the latest plan snapshot across explicit save-before-open", async () => {
    const repository = new MemoryInputs();
    const first: PilotInputPlan = { schemaVersion: 1,
      id: "first-plan", title: "First plan", rawFields: { "cruise-altitude": "4500", "plan-title": "First plan", "departure-time": "2026-09-21T22:00" },
      checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z",
    };
    const second: PilotInputPlan = { schemaVersion: 1,
      id: "second-plan", title: "Second plan", rawFields: { "cruise-altitude": "4500", "plan-title": "Second plan" },
      checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z",
    };
    repository.plans.push(first, second);
    const root = await mount(repository);

    edit(root, "departure-time", "2026-09-21T23:15");
    await settle();
    choosePlan(root, "First plan");
    await settle();
    expect(input(root, "departure-time").value).toBe("2026-09-21T23:15");

    choosePlan(root, "Second plan");
    await settle();
    choosePlan(root, "First plan");
    await settle();
    expect(input(root, "departure-time").value).toBe("2026-09-21T23:15");
    edit(root, "taxi-fuel", "1.2");
    button(root, "Save changes").click();
    await settle();

    expect(repository.plans.find((plan) => plan.id === first.id)?.rawFields).toMatchObject({
      "departure-time": "2026-09-21T23:15",
      "taxi-fuel": "1.2",
    });
  });

  it("saves incomplete literal and structured inputs without requesting weather", async () => {
    const repository = new MemoryInputs();
    const fetchMetar = vi.fn(winds().fetchMetar);
    const fetchPoint = vi.fn(winds().fetchPoint);
    const root = await mount(repository, winds({ fetchMetar, fetchPoint }));
    button(root, "Add checkpoint").click();
    await settle();
    edit(root, "plan-title", " Saved draft ");
    edit(root, "checkpoint-name-0", "Farm strip");
    edit(root, "checkpoint-coordinate-0", "N4145 W08730");
    edit(root, "cruise-altitude", "not decided");
    button(root, "Save changes").click();
    await settle();

    const saved = repository.plans.at(-1)!;
    expect(saved.rawFields["plan-title"]).toBe(" Saved draft ");
    expect(saved.checkpoints).toEqual([{ name: "Farm strip", coordinateText: "N4145 W08730" }]);
    expect(saved.cruiseAltitudeTexts).toEqual(["4500"]);
    expect(saved.rawFields["cruise-altitude"]).toBe("not decided");
    expect(fetchMetar).not.toHaveBeenCalled();
    expect(fetchPoint).not.toHaveBeenCalled();
    expect(root.querySelector("[data-current-result]")).toBeNull();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Changes saved");
  });

  it("shows one cruise altitude outside the checkpoint groups and keeps per-leg TAS controls", async () => {
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
    expect(input(root, "cruise-altitude").parentElement?.textContent).toContain("Cruise altitude (feet MSL)");
    expect(departure.querySelector("input[name^='altitude-']")).toBeNull();
    expect(departure.querySelector("legend")?.textContent).toContain("Checkpoint 1");
    expect(departure.textContent).toContain("Override TAS for leg 1");

    expect(checkpoint.tagName).toBe("FIELDSET");
    expect(checkpoint.querySelector("legend")?.textContent).toContain("Checkpoint 1");
    expect(groupInput(checkpoint, "checkpoint-name-0").value).toBe("Farm strip");
    expect(groupInput(checkpoint, "checkpoint-coordinate-0")).toBeTruthy();
    expect(checkpoint.querySelector("input[name^='altitude-']")).toBeNull();
    expect(checkpoint.textContent).toContain("Destination");
    expect(checkpoint.textContent).toContain("Override TAS for leg 2");
  });

  it("keeps the chosen cruise altitude stable when checkpoints are added", async () => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    edit(root, "cruise-altitude", "6200");

    button(root, "Add checkpoint").click();
    await settle();

    expect(input(root, "cruise-altitude").value).toBe("6200");
    expect(repository.plans.at(-1)?.cruiseAltitudeTexts).toEqual(["4500"]);
    expect(repository.plans.at(-1)?.rawFields["cruise-altitude"]).toBe("6200");
  });



  it("keeps the cruise altitude independent of checkpoint edits", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    repository.plans.push({ schemaVersion: 1,
      id: "waypoint-altitudes", title: "Waypoint altitudes", rawFields: { "cruise-altitude": "4100",
        "plan-title": "Waypoint altitudes", "departure-icao": "KORD", "destination-icao": "KJVL",
        "override-tas-0": "102", "override-reason-0": "Training comparison",
      }, selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [], cruiseAltitudeTexts: ["4100"],
      overrideReasons: { "tas-0": "Training comparison" }, updatedAt: "2026-09-21T21:30:00.000Z",
    });
    const root = await mount(repository);
    button(root, "Add checkpoint").click();
    await settle();
    expect(repository.plans[0]?.cruiseAltitudeTexts).toEqual(["4100"]);
    expect(repository.plans[0]?.overrideReasons).toEqual({});
    expect(repository.plans[0]?.rawFields).not.toHaveProperty("override-tas-0");

    edit(root, "cruise-altitude", "6200");
    await settle();
    button(root, "Remove checkpoint 1").click();
    await settle();
    expect(repository.plans[0]?.cruiseAltitudeTexts).toEqual(["4100"]);
    expect(repository.plans[0]?.overrideReasons).toEqual({});
    expect(input(root, "cruise-altitude").value).toBe("6200");
  });


  it("waits for queued autosaves and keeps the editor text after a failed explicit save and retry", async () => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    edit(root, "plan-title", "typed without blur");
    let release!: () => void;
    repository.saveGate = new Promise<void>((resolve) => { release = resolve; });
    edit(root, "taxi-fuel", "1.25");
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
    repository.plans.push({ schemaVersion: 1, id: "saved", title: "Saved route", rawFields: { "cruise-altitude": "4500", "plan-title": "Saved route" }, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z" });
    const root = await mount(repository);
    expect(root.querySelector("[role='status']")?.textContent).toContain("ready to edit");
    expect(root.querySelector("[role='status']")?.textContent).toContain("Save changes");
    expect(button(root, "Update navlog")).toBeTruthy();
    expect(root.querySelector("[data-current-result]")).toBeNull();
  });

  it("keeps the active draft visible when opening another saved plan fails", async () => {
    const repository = new MemoryInputs();
    repository.plans.push(
      { schemaVersion: 1, id: "active", title: "Active route", rawFields: { "cruise-altitude": "4500", "plan-title": "Active route" }, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z" },
      { schemaVersion: 1, id: "other", title: "Other route", rawFields: { "cruise-altitude": "4500", "plan-title": "Other route" }, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z" },
    );
    const root = await mount(repository);
    repository.failOpen = true;
    choosePlan(root, "Other route");
    await settle();
    expect(input(root, "plan-title").value).toBe("Active route");
    expect(root.querySelector("[role='status']")?.textContent).toContain("read failed");
  });

  it("keeps the failed draft and accepted destination until confirmed discard", async () => {
    const repository = new MemoryInputs();
    const other: PilotInputPlan = { schemaVersion: 1,
      id: "other-saved-plan", title: "Other saved plan", rawFields: { "cruise-altitude": "4500", "plan-title": "Other saved plan" },
      checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z",
    };
    repository.plans.push(other);
    const root = await mount(repository);
    repository.failSave = true;
    let release!: () => void;
    repository.saveGate = new Promise<void>((resolve) => { release = resolve; });
    edit(root, "plan-title", "Failed write");
    button(root, "New plan").click();
    release();
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("write failed");
    expect(root.querySelector("[role='status']")?.textContent).toContain("Discard draft and continue");
    expect(planSelector(root).disabled).toBe(true);
    expect(button(root, "New plan").disabled).toBe(true);
    edit(root, "departure-icao", "KORD");
    expect(input(root, "departure-icao").value).toBe("KORD");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const discard = [...root.querySelectorAll<HTMLButtonElement>("[role='status'] button")].find((candidate) => candidate.textContent === "Discard draft and continue");
    expect(discard?.textContent).toBe("Discard draft and continue");
    discard?.click();
    await settle();
    expect(input(root, "plan-title").value).toBe("New study route");
  });

  it("restores incomplete profile text and ordered checkpoint text after reopening a saved plan", async () => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    edit(root, "cruiseTasKnots", "not a number yet");
    await settle();
    button(root, "Add checkpoint").click();
    await settle();
    edit(root, "checkpoint-name-0", "Farm strip");
    edit(root, "checkpoint-coordinate-0", "N4145 W08730");
    button(root, "Save changes").click();
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

  it("keeps malformed airport codes in the draft and blocks update before airport lookup", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const lookup = createLocalStudyAirportLookup();
    const lookupSpy = vi.spyOn(lookup, "lookupAirportCode");
    const root = await mount(repository, winds(), lookup);
    await makeLocallyValid(root, true);
    edit(root, "departure-icao", "K-ORD");
    button(root, "Save changes").click();
    await settle();

    expect(repository.plans.at(-1)?.rawFields["departure-icao"]).toBe("K-ORD");
    expect(button(root, "Update navlog").disabled).toBe(true);
    expect(root.querySelector("[data-local-error]")?.textContent).toContain("exactly 3 or 4 letters or numbers");
    lookupSpy.mockClear();
    button(root, "Update navlog").disabled = false;
    button(root, "Update navlog").click();
    await settle();
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
    expect(lookupSpy).toHaveBeenCalledWith("KORD");
    expect(lookupSpy).toHaveBeenCalledWith("KJVL");
  });

  it("saves and reopens every supported editor field through IndexedDB", async () => {
    const repository = new IndexedDbPilotInputRepository({ indexedDbFactory: new IDBFactory(), now: () => clock.now() });
    await repository.saveProfile(profile);
    // Seed only the route shape; every checkpoint, TAS and reason is edited below.
    // Repeated add/reveal actions each render and save, obscuring this persistence test.
    await repository.saveWorkingCopy({
      schemaVersion: 1, id: "boundary-draft", title: "Boundary draft",
      rawFields: { "plan-title": "Boundary draft", ...Object.fromEntries(Array.from({ length: 26 }, (_, index) => [`override-tas-${index}`, "90"])) },
      selectedProfileId: profile.id, profileSnapshot: profile,
      checkpoints: Array.from({ length: 25 }, () => ({ name: "", coordinateText: "" })),
      cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: clock.now().toISOString(),
    });
    const fetchMetar = winds().fetchMetar;
    const client = winds({ fetchMetar: async (icao) => {
      const stored = (await repository.listPlans())[0]!;
      expect(stored.checkpoints).toHaveLength(25);
      expect(stored.overrideReasons["tas-25"]).toBe(" Reason 25 ");
      expect(stored.rawFields["override-tas-25"]).toBe(" 95 ");
      expect(Object.keys(stored.rawFields)).toHaveLength(35);
      return fetchMetar(icao);
    } });
    const root = await mount(repository, client);
    await makeLocallyValid(root);
    await vi.waitFor(() => expect(root.querySelector("[role='status']")?.textContent).toContain("Pilot inputs saved."), { interval: 5 });
    for (let index = 0; index < 25; index++) {
      edit(root, `checkpoint-name-${index}`, ` Point ${index} `);
      edit(root, `checkpoint-coordinate-${index}`, ` ${41.99 + index * 0.02}, -88.1 `);
    }
    for (let index = 0; index < 26; index++) {
      edit(root, `override-tas-${index}`, " 95 ");
      edit(root, `override-reason-${index}`, ` Reason ${index} `);
    }
    button(root, "Update navlog").click();
    await vi.waitFor(() => expect(root.querySelector(".calculated-navlog")).not.toBeNull(), { timeout: 5000 });

    const profileFields = [...root.querySelectorAll<HTMLInputElement>(".profile-form input")].map((field) => field.name);
    for (const name of profileFields) edit(root, name, ` unfinished ${name} `);
    button(root, "Save changes").click();
    await vi.waitFor(() => expect(root.querySelector("[role='status']")?.textContent).toContain("Changes saved."));
    const saved = (await repository.listPlans())[0]!;
    expect(Object.keys(saved.rawFields)).toHaveLength(46);
    expect(saved.checkpoints).toHaveLength(25);
    expect(Object.keys(saved.overrideReasons)).toHaveLength(26);

    const reopened = await mount(repository);
    for (let index = 0; index < 25; index++) {
      expect(input(reopened, `checkpoint-name-${index}`).value).toBe(` Point ${index} `);
      expect(input(reopened, `checkpoint-coordinate-${index}`).value).toBe(` ${41.99 + index * 0.02}, -88.1 `);
    }
    for (let index = 0; index < 26; index++) {
      expect(input(reopened, `override-tas-${index}`).value).toBe(" 95 ");
      expect(input(reopened, `override-reason-${index}`).value).toBe(` Reason ${index} `);
    }
    for (const name of profileFields) expect(input(reopened, name).value).toBe(` unfinished ${name} `);
    edit(reopened, "plan-title", "Boundary draft");
    button(reopened, "New plan").click();
    await vi.waitFor(() => expect(input(reopened, "plan-title").value).toBe("New study route"));
    choosePlan(reopened, "Boundary draft");
    await vi.waitFor(() => expect(input(reopened, "plan-title").value).toBe("Boundary draft"));
    expect(input(reopened, "override-reason-25").value).toBe(" Reason 25 ");
  }, 15_000);

  it("removes obsolete raw copies while retaining current checkpoint text and unrelated fields", async () => {
    const repository = new MemoryInputs();
    repository.plans.push({ schemaVersion: 1, id: "legacy-copies", title: "Legacy draft",
      rawFields: { "plan-title": "Legacy draft", "checkpoint-name-0": "old name", "checkpoint-coordinate-0": "old coordinate",
        "checkpoint-name-24": "removed", "override-reason-0": "old reason", "override-tas-0": " 95 ", "custom-field": " keep " },
      checkpoints: [{ name: " First ", coordinateText: "41." }, { name: " Second ", coordinateText: "42." }],
      cruiseAltitudeTexts: ["4500"], overrideReasons: { "tas-0": " current reason " }, updatedAt: clock.now().toISOString() });
    const root = await mount(repository);
    expect(input(root, "checkpoint-name-0").value).toBe(" First ");
    expect(input(root, "override-reason-0").value).toBe(" current reason ");
    button(root, "Remove checkpoint 1").click();
    await settle();
    edit(root, "checkpoint-coordinate-0", " incomplete ");
    button(root, "Save changes").click();
    await settle();
    const saved = repository.plans[0]!;
    expect(saved.checkpoints).toEqual([{ name: " Second ", coordinateText: " incomplete " }]);
    expect(saved.rawFields["custom-field"]).toBe(" keep ");
    expect(Object.keys(saved.rawFields).filter((key) => /^(checkpoint-|override-)/.test(key))).toEqual([]);
    expect(saved.overrideReasons).toEqual({});
    const reopened = await mount(repository);
    expect(input(reopened, "checkpoint-coordinate-0").value).toBe(" incomplete ");
  });

  it("limits checkpoint creation to 25 and blocks a stored plan with 26", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const now = "2026-09-21T21:30:00.000Z";
    const initial: PilotInputPlan = { schemaVersion: 1,
      id: "checkpoint-limit", title: "Checkpoint limit", rawFields: { "cruise-altitude": "4500",
        "plan-title": "Checkpoint limit", "departure-time": "2026-09-21T22:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
        "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL", "surface-weather-icao": "", "selected-forecast-period": COMPLETE_FLIGHT_FORECAST_VALID_AT,
      }, selectedProfileId: profile.id, profileSnapshot: profile,
      checkpoints: Array.from({ length: 24 }, (_, index) => ({ name: `Point ${index + 1}`, coordinateText: "N4145 W08730" })),
      cruiseAltitudeTexts: Array(25).fill("4500"), overrideReasons: {}, updatedAt: now,
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
  });

  it("rejects titles over 120 trimmed characters before update and accepts 120", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const weather = winds();
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
    expect(fetchMetar).not.toHaveBeenCalled();

    edit(root, "plan-title", `  ${"a".repeat(120)}  `);
    expect(title.getAttribute("aria-invalid")).toBe("false");
    expect(button(root, "Update navlog").disabled).toBe(false);
    button(root, "Update navlog").click();
    await settle();
    expect(fetchMetar).toHaveBeenCalledWith("KORD");
    expect(root.querySelector("[role='status']")?.textContent).toContain("Plan updated");
    expect(repository.plans.at(-1)?.rawFields["plan-title"]).toBe(`  ${"a".repeat(120)}  `);
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
    repository.plans.push({ schemaVersion: 1,
      id: "profile-draft-plan", title: "Profile draft route", rawFields, selectedProfileId: profile.id, profileSnapshot: profile,
      checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z",
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
    repository.plans.push({ schemaVersion: 1,
      id: "profile-choice-plan", title: "Profile choice route", rawFields, selectedProfileId: profile.id, profileSnapshot: profile,
      checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z",
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
    const first: PilotInputPlan = { schemaVersion: 1,
      id: "first-plan", title: "First plan", rawFields: { "cruise-altitude": "4500", "plan-title": "First plan" },
      checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z",
    };
    const second: PilotInputPlan = { schemaVersion: 1,
      id: "second-plan", title: "Second plan", rawFields: { "cruise-altitude": "4500", "plan-title": "Second plan" },
      checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z",
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
  });

  it("reveals TAS editing only on request, retains a reason, and restores the aircraft default", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const fields = {
      "plan-title": "First plan", "departure-time": "2026-09-21T22:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
      "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL", "surface-weather-icao": "KORD",
      "selected-forecast-period": COMPLETE_FLIGHT_FORECAST_VALID_AT,
    };
    repository.plans.push({ schemaVersion: 1,
      id: "first-override-plan", title: "First plan", rawFields: fields, selectedProfileId: profile.id, profileSnapshot: profile,
      checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z",
    }, { schemaVersion: 1,
      id: "second-override-plan", title: "Second plan", rawFields: { "cruise-altitude": "4500", ...fields, "plan-title": "Second plan", "override-tas-0": "102", "override-reason-0": "Training comparison" },
      selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: { "tas-0": "Training comparison" },
      updatedAt: "2026-09-21T21:30:00.000Z",
    });
    const root = await mount(repository);
    expect(root.querySelector("[name='override-tas-0']")).toBeNull();
    expect(root.querySelector("input[type='checkbox']")).toBeNull();
    button(root, "Override TAS for leg 1").click();
    edit(root, "override-tas-0", "100");
    expect(button(root, "Update navlog").disabled).toBe(true);
    edit(root, "override-reason-0", "Training comparison");
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

  it("clears current evidence on edit or failure, retains saved inputs, and recovers on success", async () => {
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

    edit(root, "plan-title", "Changed inputs");
    expect(root.querySelector("[data-current-result]")).toBeNull();
    expect(root.querySelector('[data-stage="navlog"]')?.textContent).toContain("Update navlog to retrieve current weather and display a calculated navlog.");
    expect(root.querySelector("[role='status']")?.textContent).toContain("Inputs changed");
    expect(root.querySelector("[role='status']")?.textContent).not.toContain("Plan updated");
    failPoint = true;
    button(root, "Update navlog").click();
    await settle();
    expect(repository.plans.at(-1)?.rawFields["plan-title"]).toBe("Changed inputs");
    expect(root.querySelector("[data-current-result]")).toBeNull();
    expect(root.querySelector("[role='status']")?.textContent).toContain("point service unavailable");

    edit(root, "departure-time", "2026-09-21T22:15");
    expect(root.querySelector("[role='status']")?.textContent).toContain("Inputs changed");
    expect(root.querySelector("[role='status']")?.textContent).not.toContain("point service unavailable");
    failPoint = false;
    button(root, "Update navlog").click();
    await settle();
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
    expect(root.querySelector("[role='status']")?.textContent).toContain("Changes saved");
    expect(root.querySelector("[role='status']")?.textContent).not.toContain("point service unavailable");
  });


  it("does not consult the legacy weather transport for a new endpoint selection", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const client = winds();
    const fetchMetar = vi.spyOn(client, "fetchMetar");
    const root = await mount(repository, client);
    await makeLocallyValid(root, true);
    button(root, "Update navlog").click();
    await settle();
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Plan updated");
    expect(fetchMetar).toHaveBeenCalledWith("KORD");
  });

  it("removes an override with a deleted checkpoint leg so the route can be updated", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const fields = {
      "plan-title": "Checkpoint route", "departure-time": "2026-09-21T22:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
      "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL", "surface-weather-icao": "KORD",
      "selected-forecast-period": COMPLETE_FLIGHT_FORECAST_VALID_AT, "override-tas-1": "102", "override-reason-1": "Leg 2 test",
    };
    repository.plans.push({ schemaVersion: 1,
      id: "checkpoint-plan", title: "Checkpoint route", rawFields: fields, selectedProfileId: profile.id, profileSnapshot: profile,
      checkpoints: [{ name: "Farm strip", coordinateText: "414500N0873000W" }], cruiseAltitudeTexts: ["4500", "4500"],
      overrideReasons: { "tas-1": "Leg 2 test" }, updatedAt: "2026-09-21T21:30:00.000Z",
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
    repository.plans.push({ schemaVersion: 1,
      id: "second-leg-plan", title: "Second leg", rawFields: { "cruise-altitude": "4500",
        "plan-title": "Second leg", "override-tas-1": "102", "override-reason-1": "Training comparison",
      }, selectedProfileId: profile.id, profileSnapshot: profile,
      checkpoints: [{ name: "Farm strip", coordinateText: "414500N0873000W" }], cruiseAltitudeTexts: ["4500", "4500"],
      overrideReasons: { "tas-1": "Training comparison" }, updatedAt: "2026-09-21T21:30:00.000Z",
    });
    const root = await mount(repository);
    edit(root, "plan-title", "Second leg revised");
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
    repository.plans.push({ schemaVersion: 1,
      id: "override-route", title: "Override route", rawFields: fields, selectedProfileId: profile.id, profileSnapshot: profile,
      checkpoints: [], cruiseAltitudeTexts: ["4500"], overrideReasons: { "tas-0": "Study comparison" },
      updatedAt: "2026-09-21T21:30:00.000Z",
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
    await settle();
    expect(input(root, "plan-title").value).toBe("New study route");
    expect(root.querySelector("[role='status']")?.textContent).toContain("Enter pilot inputs");
    choosePlan(root, "Synthetic route");
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Saved pilot inputs are ready to edit");
    expect(root.querySelector(".calculated-navlog")).toBeNull();
  });

  it("opens a different saved plan after a route-weather update is unavailable", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const firstPlan: PilotInputPlan = { schemaVersion: 1,
      id: "first-plan", title: "First plan", rawFields: { "cruise-altitude": "4500",
        "plan-title": "First plan", "departure-time": "2026-09-21T22:00", "fuel-aboard": "20", "taxi-fuel": "0.8", "reserve-fuel": "3",
        "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL", "surface-weather-icao": "KORD",
        "selected-forecast-period": COMPLETE_FLIGHT_FORECAST_VALID_AT,
      }, selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [], cruiseAltitudeTexts: ["4500"],
      overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z",
    };
    const otherPlan: PilotInputPlan = { schemaVersion: 1,
      id: "other-plan", title: "Other plan", rawFields: { "cruise-altitude": "4500", "plan-title": "Other plan" }, checkpoints: [], cruiseAltitudeTexts: ["4500"],
      overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z",
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

  it("captures an immediate New action after typing and locks editing until the destination opens", async () => {
    const repository = new MemoryInputs();
    let release!: () => void;
    repository.saveGate = new Promise<void>((resolve) => { release = resolve; });
    const root = await mount(repository);
    const title = input(root, "plan-title");
    title.value = "Pending draft";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    button(root, "New plan").click();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Saving");
    expect(button(root, "New plan").disabled).toBe(true);
    expect(planSelector(root).disabled).toBe(true);
    expect(input(root, "departure-icao").disabled).toBe(true);
    release();
    await settle();
    expect(input(root, "plan-title").value).toBe("New study route");
    expect(repository.plans[0]?.rawFields["plan-title"]).toBe("Pending draft");
  });

  it.each(["edited title", "untouched input", "edited checkpoint"] as const)("opens a checkpoint on the first pointer click after focusing an input: %s", async (scenario) => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    if (scenario === "edited checkpoint") {
      button(root, "Add checkpoint").click();
      await settle();
      edit(root, "checkpoint-name-0", "Visual checkpoint");
      edit(root, "checkpoint-coordinate-0", "N4145 W08730");
    } else if (scenario === "edited title") {
      edit(root, "plan-title", "Unsaved route title");
    }
    let release!: () => void;
    repository.saveGate = new Promise<void>((resolve) => { release = resolve; });
    const focusedField = scenario === "edited checkpoint" ? "checkpoint-coordinate-0" : scenario === "edited title" ? "plan-title" : "cruise-altitude";
    const add = button(root, "Add checkpoint");
    // Model the browser default: pointer press blurs the input unless canceled,
    // then microtasks run before the later pointer release and click.
    const press = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
    add.dispatchEvent(press);
    if (!press.defaultPrevented) input(root, focusedField).dispatchEvent(new Event("blur"));
    await Promise.resolve();
    add.click();
    const expectedCount = scenario === "edited checkpoint" ? 2 : 1;
    const openedCount = root.querySelectorAll('[name^="checkpoint-name-"]').length;
    await Promise.resolve();
    const lockedDuringSave = button(root, "Add checkpoint").disabled;
    button(root, "Add checkpoint").click();
    const countDuringSave = root.querySelectorAll('[name^="checkpoint-name-"]').length;
    release();
    await settle();
    expect(openedCount).toBe(expectedCount);
    expect(lockedDuringSave).toBe(true);
    expect(countDuringSave).toBe(expectedCount);
    expect(button(root, "Add checkpoint").disabled).toBe(false);
    expect(repository.plans[0]?.rawFields["plan-title"]).toBe(scenario === "edited title" ? "Unsaved route title" : "New study route");
    expect(repository.plans[0]?.checkpoints).toEqual(scenario === "edited checkpoint"
      ? [{ name: "Visual checkpoint", coordinateText: "N4145 W08730" }, { name: "", coordinateText: "" }]
      : [{ name: "", coordinateText: "" }]);
  });

  it.each(["Override TAS for leg 1", "Remove checkpoint 1", "Restore aircraft default for leg 1", "Save changes", "Continue to Calculate", "Update navlog", "Save aircraft profile"])("accepts the first pointer click after input focus: %s", async (action) => {
    const repository = new MemoryInputs();
    repository.profiles.push(profile);
    const root = await mount(repository);
    document.body.append(root);
    if (action === "Update navlog") await makeLocallyValid(root);
    if (action === "Save aircraft profile") {
      const values = { "profile-name": "Pointer test aircraft", cruiseTasKnots: "95", cruiseFuelFlowGallonsPerHour: "6", climbRateFeetPerMinute: "500", climbTasKnots: "70", climbFuelFlowGallonsPerHour: "8", descentRateFeetPerMinute: "500", descentTasKnots: "90", descentFuelFlowGallonsPerHour: "4" };
      for (const [name, value] of Object.entries(values)) edit(root, name, value);
      edit(root, "compass-deviation-card", "000:+1, 090:-1");
    }
    if (action === "Remove checkpoint 1") {
      button(root, "Add checkpoint").click();
      await settle();
    }
    if (action === "Restore aircraft default for leg 1") {
      button(root, "Override TAS for leg 1").click();
      await settle();
      edit(root, "override-tas-0", "105");
      edit(root, "override-reason-0", "Study override");
    }
    edit(root, "plan-title", "Preserved pointer edits");
    let release!: () => void;
    repository.saveGate = new Promise<void>((resolve) => { release = resolve; });
    const target = button(root, action);
    const press = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
    target.dispatchEvent(press);
    const focusedField = action === "Save aircraft profile" ? "compass-deviation-card" : "plan-title";
    // Some browsers deliver blur synchronously while a focused editor is
    // removed. Model that event during the production content replacement.
    const content = root.firstElementChild!;
    const replaceChildren = content.replaceChildren.bind(content);
    vi.spyOn(content, "replaceChildren").mockImplementation((...nodes) => {
      input(root, focusedField).dispatchEvent(new Event("blur"));
      replaceChildren(...nodes);
    });
    if (!press.defaultPrevented) input(root, focusedField).dispatchEvent(new Event("blur"));
    await Promise.resolve();
    target.click();
    release();
    await settle();
    root.remove();
    expect(repository.plans[0]?.rawFields["plan-title"]).toBe("Preserved pointer edits");
    const outcomes: Record<string, () => void> = {
      "Override TAS for leg 1": () => expect(root.querySelector('[name="override-tas-0"]')).not.toBeNull(),
      "Remove checkpoint 1": () => expect(repository.plans[0]?.checkpoints).toEqual([]),
      "Restore aircraft default for leg 1": () => expect(repository.plans[0]?.rawFields["override-tas-0"]).toBeUndefined(),
      "Save changes": () => expect(root.querySelector('[role="status"]')?.textContent).toContain("Changes saved."),
      "Continue to Calculate": () => expect(root.querySelector<HTMLDetailsElement>('[data-stage="calculate"]')?.open).toBe(true),
      "Update navlog": () => expect(root.querySelector(".calculated-navlog")).not.toBeNull(),
      "Save aircraft profile": () => expect(repository.profiles.some(({ name }) => name === "Pointer test aircraft")).toBe(true),
    };
    outcomes[action]!();
  });

  it.each([false, true])("preserves pointer button focus after saving without overriding later user focus: %s", async (moveFocus) => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    document.body.append(root);
    edit(root, "plan-title", "Focused save");
    input(root, "plan-title").focus();
    let release!: () => void;
    repository.saveGate = new Promise<void>((resolve) => { release = resolve; });
    const save = button(root, "Save changes");
    let focusedAtActivation: Element | null = null;
    save.addEventListener("click", () => { focusedAtActivation = document.activeElement; }, { capture: true });
    save.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    await Promise.resolve();
    const enabledBeforeClick = !save.disabled;
    save.click();
    // Browsers can drop focus when the focused button becomes disabled.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const other = button(root, "New plan");
    if (moveFocus) other.focus();
    release();
    await settle();
    const focusedAfterSave = document.activeElement;
    root.remove();
    expect(focusedAtActivation).toBe(save);
    expect(enabledBeforeClick).toBe(true);
    expect(focusedAfterSave).toBe(moveFocus ? other : save);
    expect(repository.plans[0]?.rawFields["plan-title"]).toBe("Focused save");
  });

  it("keeps a draft unchanged when a pointer press is canceled without a click", async () => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    document.body.append(root);
    edit(root, "plan-title", "Canceled button press");
    const title = input(root, "plan-title");
    title.focus();
    button(root, "Save changes").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    const focusedAfterPress = document.activeElement;
    // No click is delivered; the user subsequently focuses another input.
    input(root, "departure-icao").focus();
    await settle();
    root.remove();
    expect(focusedAfterPress).toBe(title);
    expect(repository.plans).toHaveLength(0);
    expect(title.dataset.unsaved).toBe("true");
  });

  it("keeps rapid focus movement write-free and saves the latest literal fields on command", async () => {
    const repository = new MemoryInputs();
    const root = await mount(repository);
    edit(root, "plan-title", "First title");
    edit(root, "departure-icao", "KORD");
    edit(root, "destination-icao", "KJVL");
    await settle();
    expect(repository.saveAttempts).toBe(0);
    expect(button(root, "Save changes").disabled).toBe(false);
    let release!: () => void;
    repository.saveGate = new Promise<void>((resolve) => { release = resolve; });
    button(root, "Save changes").click();
    await Promise.resolve();
    expect(repository.saveAttempts).toBe(1);
    expect(input(root, "plan-title").disabled).toBe(true);
    release();
    await settle();
    expect(repository.plans[0]?.rawFields).toMatchObject({ "plan-title": "First title", "departure-icao": "KORD", "destination-icao": "KJVL" });
    expect(input(root, "plan-title").hasAttribute("data-unsaved")).toBe(false);
  });

  it("moves keyboard focus to the new editor after the accepted switch", async () => {
    const repository = new MemoryInputs();
    let release!: () => void;
    repository.saveGate = new Promise<void>((resolve) => { release = resolve; });
    const root = await mount(repository);
    document.body.append(root);
    const title = input(root, "plan-title");
    title.focus();
    title.value = "Focused draft";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    const create = button(root, "New plan");
    create.focus();
    create.click();
    expect(create.disabled).toBe(true);
    release();
    await settle();
    expect(document.activeElement).toBe(root.querySelector('[data-stage="aircraft"] summary'));
    root.remove();
  });

  it("disables Update navlog during an explicit save and keeps it blocked after failure", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const client = winds();
    const fetchMetar = vi.spyOn(client, "fetchMetar");
    const fetchPoint = vi.spyOn(client, "fetchPoint");
    const root = await mount(repository, client);
    await makeLocallyValid(root);
    repository.failSave = true;
    let release!: () => void;
    repository.saveGate = new Promise<void>((resolve) => { release = resolve; });
    edit(root, "plan-title", "Pending update draft");
    button(root, "Save changes").click();
    await Promise.resolve();
    expect(button(root, "Update navlog").disabled).toBe(true);
    button(root, "Update navlog").click();
    release();
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("write failed");
    expect(input(root, "plan-title").value).toBe("Pending update draft");
    expect(fetchMetar).not.toHaveBeenCalled();
    expect(fetchPoint).not.toHaveBeenCalled();
    expect(button(root, "New plan").disabled).toBe(true);
    expect(planSelector(root).disabled).toBe(true);
  });

  it("asks for a new plan when unsupported saved plans were discarded", async () => {
    const repository = new MemoryInputs();
    repository.unsupportedPlanNotice = true;
    const root = await mount(repository);
    expect(root.querySelector("[role='status']")?.textContent).toContain("unsupported saved plan was discarded");
    expect(root.querySelector("[role='status']")?.textContent).toContain("Create a new plan");
    expect(button(root, "New plan").disabled).toBe(false);
  });

  it("blocks Update during an explicit save, then persists the profile before weather", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const client = winds();
    const fetchMetar = vi.spyOn(client, "fetchMetar");
    const root = await mount(repository, client);
    await makeLocallyValid(root);
    let release!: () => void;
    repository.saveGate = new Promise<void>((resolve) => { release = resolve; });
    edit(root, "plan-title", "Pending profile snapshot");
    button(root, "Save changes").click();
    await Promise.resolve();
    const update = button(root, "Update navlog");
    expect(update.disabled).toBe(true);
    // Command readiness must hold even if an obsolete DOM event is delivered.
    update.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(fetchMetar).not.toHaveBeenCalled();
    release();
    await settle();
    expect(fetchMetar).not.toHaveBeenCalled();
    expect(button(root, "Update navlog").disabled).toBe(false);
    fetchMetar.mockImplementation(async (icao) => {
      expect(repository.plans[0]?.profileSnapshot).toEqual(profile);
      return winds().fetchMetar(icao);
    });
    button(root, "Update navlog").click();
    await settle();
    expect(fetchMetar).toHaveBeenCalled();
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
  });

  it("replaces a failed update message after Retry save succeeds", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);
    await makeLocallyValid(root);
    repository.failSave = true;
    button(root, "Update navlog").click();
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("write failed");
    repository.failSave = false;
    button(root, "Retry save").click();
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Pilot inputs saved.");
    expect(root.querySelector("[role='status']")?.textContent).not.toContain("write failed");
  });

  it("locks Update navlog once a destination is accepted during an explicit save", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);
    await makeLocallyValid(root);
    let release!: () => void;
    repository.saveGate = new Promise<void>((resolve) => { release = resolve; });
    edit(root, "plan-title", "Switching draft");
    button(root, "Save changes").click();
    await Promise.resolve();
    expect(button(root, "Update navlog").disabled).toBe(true);
    button(root, "New plan").click();
    expect(button(root, "Update navlog").disabled).toBe(true);
    expect(button(root, "New plan").disabled).toBe(true);
    release();
    await settle();
    expect(input(root, "plan-title").value).toBe("New study route");
  });

  it("offers retry after failed explicit save and does not retry on another blur", async () => {
    const repository = new MemoryInputs(); repository.failSave = true;
    const root = await mount(repository);
    edit(root, "plan-title", "Failed draft");
    button(root, "Save changes").click();
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("write failed");
    expect(button(root, "Retry save")).toBeTruthy();
    const attempts = repository.saveAttempts;
    edit(root, "departure-icao", "KORD");
    await settle();
    expect(repository.saveAttempts).toBe(attempts);
    expect(input(root, "departure-icao").value).toBe("KORD");
    expect(input(root, "plan-title").dataset.unsaved).toBe("true");
  });
});
