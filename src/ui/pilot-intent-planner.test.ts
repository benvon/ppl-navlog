import { describe, expect, it, vi } from "vitest";
import { createLocalStudyAirportLookup } from "../application/airport-lookup";
import type { AirportLookup } from "../application/airport-lookup";
import type { AircraftProfile } from "../domain/aircraft";
import type { PilotInputPlan, PilotInputRepository } from "../services/storage/pilot-input-repository";
import type { MetarTransportClient, TafTransportClient, WindsTransportClient } from "../services/weather/winds-client";
import type { AloftPointAnswer, AloftPointQuery } from "../../worker/api/contracts";
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

async function mount(repository: MemoryInputs, client = winds(), airportLookup: AirportLookup = createLocalStudyAirportLookup()): Promise<HTMLElement> {
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
  if (withSurfaceMetar) edit(root, "departure-metar-icao", "KORD");
  const select = root.querySelector<HTMLSelectElement>("[name='selectedProfileId']")!;
  select.value = profile.id;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
}

function assertProgressiveWeatherQueryOrder(callOrder: readonly string[], queries: readonly AloftPointQuery[]): void {
  expect(callOrder).toEqual(["metar", "point", "point", "point"]);
  expect(queries).toHaveLength(3);
  const departure = coordinate(41.9742, -87.9073), destination = coordinate(42.6203, -89.0416);
  if (!departure.ok || !destination.ok) throw new Error("Study airport fixture coordinates were invalid.");
  const routeGeometry = calculateGreatCircleDistanceAndInitialCourse(departure.value, destination.value);
  if (!routeGeometry.ok) throw new Error(routeGeometry.error.message);
  const interiorDistances = queries.slice(1).map((query) => routeDistanceForWeatherQuery(query, departure.value, destination.value, routeGeometry.value.distance));
  expect(queries[0]?.latitudeDeg).toBeCloseTo(departure.value.latitude, 4);
  expect(queries[0]?.longitudeDeg).toBeCloseTo(departure.value.longitude, 4);
  expect(interiorDistances[0]).toBeGreaterThan(0);
  expect(interiorDistances[0]).toBeLessThan(interiorDistances[1]!);
  expect(interiorDistances[1]).toBeLessThan(routeGeometry.value.distance);
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
    expect(button(root, "Update plan").disabled).toBe(true);
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
    expect(button(root, "Update plan").disabled).toBe(true);

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
    button(root, "Update plan").click();
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
    button(root, "Update plan").click();
    await settle();

    expect(repository.submissions).toHaveLength(1);
    expect(fetchMetar).toHaveBeenCalledTimes(1);
    expect(fetchMetar).toHaveBeenCalledWith("KORD");
    expect(fetchTaf).not.toHaveBeenCalled();
    expect(fetchPoint).toHaveBeenCalledTimes(3);
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
    expect(Number(storedMatch[1]).toFixed(1)).toBe(Number(displayedGroundspeed).toFixed(1));
    expect(inspector.textContent).toContain("BRL");
    expect(inspector.textContent).toContain("departure surface-to-aloft blend fraction");
    expect(inspector.textContent).toContain("KORD");
    expect(inspector.textContent).toContain("horizontal weight");

  });

  it("allows input submission without a pilot-selected forecast period and preserves unrelated raw fields", async () => {
    const repository = new MemoryInputs();
    repository.profiles.push(profile);
    const root = await mount(repository);
    await makeLocallyValid(root);
    edit(root, "departure-metar-icao", "KORD", true);
    await settle();

    expect(root.querySelector("[name='selected-forecast-period']")).toBeNull();
    expect(root.querySelector("[name='forecast-choice']")).toBeNull();
    expect([...root.querySelectorAll("button")].some((candidate) => candidate.textContent === "Load published forecast periods")).toBe(false);
    expect(button(root, "Update plan").disabled).toBe(false);
    button(root, "Update plan").click();
    await settle();

    expect(repository.submissions).toHaveLength(1);
    expect(repository.submissions[0]?.rawFields).toMatchObject({
      "plan-title": "Synthetic route",
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
    button(root, "Open First plan").click();
    await settle();
    expect(input(root, "departure-time").value).toBe("2026-09-21T23:15");

    button(root, "Open Second plan").click();
    await settle();
    button(root, "Open First plan").click();
    await settle();
    expect(input(root, "departure-time").value).toBe("2026-09-21T23:15");
    edit(root, "taxi-fuel", "1.2", true);
    await settle();

    expect(repository.plans.find((plan) => plan.id === first.id)?.rawFields).toMatchObject({
      "departure-time": "2026-09-21T23:15",
      "taxi-fuel": "1.2",
    });
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

  it("gates Update plan on required inputs and a profile without requiring a forecast period", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);
    expect(button(root, "Update plan").disabled).toBe(true);
    await makeLocallyValid(root);
    expect(button(root, "Update plan").disabled).toBe(false);
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
    expect(button(root, "Update plan").disabled).toBe(true);
    expect(root.querySelector("[data-local-error]")?.textContent).toContain("exactly 3 or 4 letters or numbers");
    lookupSpy.mockClear();
    button(root, "Update plan").disabled = false;
    button(root, "Update plan").click();
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
    expect(button(root, "Update plan").disabled).toBe(false);
    lookupSpy.mockClear();

    button(root, "Update plan").click();
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
        "plan-title": "Checkpoint limit", "departure-time": "2026-09-21T22:00", "taxi-fuel": "0.8", "reserve-fuel": "3",
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
    expect(button(reopened, "Update plan").disabled).toBe(true);
    expect(reopened.querySelector("[data-local-error]")?.textContent).toContain("no more than 25 checkpoints");
    button(reopened, "Update plan").disabled = false;
    button(reopened, "Update plan").click();
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
    await settle();

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

  it("clears current evidence on edit or failure, retains submitted inputs, and recovers on success", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    let failPoint = false;
    const client = winds({ fetchPoint: async (query) => {
      if (failPoint) throw new Error("point service unavailable");
      return winds().fetchPoint(query);
    } });
    const root = await mount(repository, client);
    await makeLocallyValid(root, true);
    button(root, "Update plan").click();
    await settle();
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
    expect(repository.submissions).toHaveLength(1);

    edit(root, "plan-title", "Changed inputs");
    expect(root.querySelector("[data-current-result]")).toBeNull();
    failPoint = true;
    button(root, "Update plan").click();
    await settle();
    expect(repository.submissions).toHaveLength(2);
    expect(repository.submissions[1]?.rawFields["plan-title"]).toBe("Changed inputs");
    expect(root.querySelector("[data-current-result]")).toBeNull();
    expect(root.querySelector("[role='status']")?.textContent).toContain("point service unavailable");

    failPoint = false;
    button(root, "Update plan").click();
    await settle();
    expect(repository.submissions).toHaveLength(3);
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Plan updated");
  });

  it("preserves but does not use a saved legacy forecast period", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const client = winds();
    const discover = vi.spyOn(client, "discoverStations");
    repository.plans.push({
      id: "legacy-period-plan", title: "Legacy period route", rawFields: {
        "plan-title": "Legacy period route", "departure-time": "2026-09-21T22:00", "taxi-fuel": "0.8", "reserve-fuel": "3",
        "descent-target": "1800", "departure-icao": "KORD", "destination-icao": "KJVL",
        "selected-forecast-period": COMPLETE_FLIGHT_FORECAST_VALID_AT,
      }, selectedProfileId: profile.id, profileSnapshot: profile, checkpoints: [], cruiseAltitudeTexts: ["4500"],
      overrideReasons: {}, updatedAt: "2026-09-21T21:30:00.000Z", submissions: [],
    });
    const root = await mount(repository, client);
    expect(root.querySelector("[name='selected-forecast-period']")).toBeNull();
    button(root, "Update plan").click();
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
    button(root, "Update plan").click();
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

  it("resets transient errors when starting a new plan or reopening a saved plan", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);
    await makeLocallyValid(root, true);
    button(root, "Update plan").click();
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

    button(root, "Open Synthetic route").click();
    await settle();
    expect(input(root, "plan-title").value).toBe("Synthetic route");
    expect(root.querySelector(".calculated-navlog")).toBeNull();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Opened saved pilot inputs");
  });

  it("clears the temporary weather error when a plan is replaced or reopened", async () => {
    const repository = new MemoryInputs(); repository.profiles.push(profile);
    const root = await mount(repository);
    await makeLocallyValid(root);
    button(root, "Update plan").click();
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Plan updated");
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
    button(root, "New plan").click();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Enter pilot inputs");
    button(root, "Open Synthetic route").click();
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Opened saved pilot inputs");
    expect(root.querySelector(".calculated-navlog")).toBeNull();
  });

  it("opens a different saved plan after a route-weather update is unavailable", async () => {
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
    const root = await mount(repository);
    button(root, "Update plan").click();
    await settle();
    expect(root.querySelector("[role='status']")?.textContent).toContain("Plan updated");
    expect(root.querySelector("[data-current-result]")).not.toBeNull();
    button(root, "Open Other plan").click();
    await settle();
    expect(input(root, "plan-title").value).toBe("Other plan");
    expect(root.querySelector(".calculated-navlog")).toBeNull();
  });
});
