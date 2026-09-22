import { describe, expect, it, vi } from "vitest";
import { createLocalStudyAirportLookup } from "../application/airport-lookup";
import type { NavlogPersistence, UseCaseClock, UseCaseIds } from "../application/plan-use-cases";
import type { AircraftProfile } from "../domain/aircraft";
import type { PlanFamily, PlanRevision } from "../domain/route";
import type { WindsTransportClient } from "../services/weather/winds-client";
import type { BrowserPlanCalculator } from "../application/browser-plan-calculator";
import { renderPlanner } from "./planner";
import { createCompleteFlightFixture } from "../test/fixtures/complete-flight";

class MemoryPersistence implements NavlogPersistence {
  private readonly profiles = new Map<string, AircraftProfile>();
  private readonly revisions = new Map<string, PlanRevision>();
  private readonly families = new Map<string, PlanFamily>();
  public readonly savedRevisions: PlanRevision[] = [];

  public async saveAircraftProfile(profile: AircraftProfile): Promise<void> { this.profiles.set(profile.id, profile); }
  public async getAircraftProfile(id: string): Promise<AircraftProfile | undefined> { return this.profiles.get(id); }
  public async listAircraftProfiles(): Promise<readonly AircraftProfile[]> { return [...this.profiles.values()]; }
  public async savePlanRevision(family: PlanFamily, revision: PlanRevision): Promise<void> { this.families.set(family.id, family); this.revisions.set(revision.id, revision); this.savedRevisions.push(revision); }
  public async getPlanRevision(id: string): Promise<PlanRevision | undefined> { return this.revisions.get(id); }
  public async listPlanRevisions(planId: string): Promise<readonly PlanRevision[]> { return [...this.revisions.values()].filter((revision) => revision.planId === planId); }
  public async listPlanFamilies(): Promise<readonly PlanFamily[]> { return [...this.families.values()]; }
}

const clock: UseCaseClock = { now: () => new Date("2026-09-21T12:00:00.000Z") };

function ids(): UseCaseIds {
  let count = 0;
  return { next: () => `id-${count += 1}` };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function input(root: HTMLElement, id: string): HTMLInputElement {
  const element = root.querySelector<HTMLInputElement>(`#${id}`);
  if (element === null) throw new Error(`Missing input ${id}`);
  return element;
}

function clickByLabel(root: HTMLElement, label: string): void {
  const control = [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label);
  if (control === undefined) throw new Error(`Missing button ${label}`);
  control.click();
}

describe("planner shell", () => {
  it("offers browser-local PDF printing only for a complete saved revision", async () => {
    const fixture = await createCompleteFlightFixture();
    const persistence = new MemoryPersistence();
    await persistence.saveAircraftProfile(fixture.profile);
    await persistence.savePlanRevision(fixture.family, fixture.revision);
    const root = document.createElement("div");
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    renderPlanner(root, {
      airportLookup: createLocalStudyAirportLookup(), persistence, ids: ids(), clock,
      weatherEvidence: { getWeatherSnapshot: async (id) => fixture.weatherSnapshots.find((snapshot) => snapshot.id === id) },
    });
    await settle();
    expect(root.textContent).not.toContain("Print / Save PDF");
    clickByLabel(root, `Open ${fixture.family.title}`);
    await settle();
    clickByLabel(root, "Print / Save PDF");
    expect(print).toHaveBeenCalledOnce();
    expect(document.querySelector(".print-sheet")?.textContent).toContain("Visual Flight Log");
    window.dispatchEvent(new Event("afterprint"));
    expect(document.querySelector(".print-sheet")).toBeNull();
    print.mockRestore();
  });

  it("walks through local airport resolution, profile saving, draft saving, and a guarded per-leg override", async () => {
    const root = document.createElement("div");
    const persistence = new MemoryPersistence();
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence, ids: ids(), clock });
    await settle();

    expect(root.textContent).toContain("Aircraft profile");
    expect(root.textContent).not.toContain("Global unlock");
    expect(root.querySelectorAll('[data-region="navlog"]')).toHaveLength(1);
    expect(root.querySelector('[aria-label="Planning workspace"]')).not.toBeNull();

    const profileForm = root.querySelector<HTMLFormElement>(".profile-form");
    if (profileForm === null) throw new Error("Profile form was not rendered.");
    input(root, "profile-name").value = "Study aircraft";
    input(root, "usable-fuel").value = "24";
    profileForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(root.textContent).toContain("Saved aircraft profile Study aircraft.");
    await expect(persistence.listAircraftProfiles()).resolves.toEqual([
      expect.objectContaining({ compassDeviationTable: [{ magneticHeadingDegrees: 0, deviationDegrees: 0 }] }),
    ]);

    input(root, "departure-icao").value = "KORD";
    input(root, "destination-icao").value = "KJVL";
    input(root, "plan-title").value = "Preserved study route";
    input(root, "departure-time").value = "2026-10-01T12:00";
    input(root, "taxi-fuel").value = "1.2";
    input(root, "reserve-fuel").value = "3.5";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    expect(root.textContent).toContain("Exact ICAO endpoints resolved from the configured aviation-data source.");
    expect(input(root, "plan-title").value).toBe("Preserved study route");
    expect(input(root, "departure-time").value).toBe("2026-10-01T12:00");
    expect(input(root, "taxi-fuel").value).toBe("1.2");
    expect(input(root, "reserve-fuel").value).toBe("3.5");
    expect(input(root, "descent-target").value).toBe("1808");

    input(root, "destination-icao").value = "KORD";
    input(root, "destination-icao").dispatchEvent(new Event("input", { bubbles: true }));
    clickByLabel(root, "Save new plan revision");
    await settle();
    expect(root.textContent).toContain("Resolve exact ICAO departure and destination first.");
    input(root, "destination-icao").value = "KJVL";
    input(root, "destination-icao").dispatchEvent(new Event("input", { bubbles: true }));
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();

    clickByLabel(root, "Save new plan revision");
    await settle();
    expect(root.textContent).toContain("Saved immutable revision");
    expect(root.textContent).toContain("Cruise TAS aircraft default: 95 kt from Study aircraft.");
    const originalLegId = persistence.savedRevisions.at(-1)?.draftSnapshot.route.legs[0]?.id;
    if (originalLegId === undefined) throw new Error("Initial route leg was not saved.");

    clickByLabel(root, "Override TAS for this leg");
    input(root, "override-tas").value = "100";
    input(root, "override-reason").value = "Instructor exercise";
    const overrideForm = root.querySelector<HTMLFormElement>(".override-form");
    if (overrideForm === null) throw new Error("Override form was not rendered.");
    expect(root.textContent).toContain("cruise groundspeed, heading correction, ETE, fuel, and trip totals will be recalculated");
    overrideForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(root.textContent).toContain("Confirm that you understand the per-leg TAS impact");
    expect(root.textContent).not.toContain("OVERRIDDEN effective TAS");

    input(root, "override-confirmation").checked = true;
    overrideForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(root.textContent).toContain("OVERRIDDEN");
    expect(root.textContent).toContain("Preserved aircraft default: 95 kt.");
    expect(root.textContent).toContain("Restore aircraft default");

    clickByLabel(root, "Save new plan revision");
    await settle();
    const savedOverride = persistence.savedRevisions.at(-1)?.draftSnapshot.route.legs[0];
    expect(savedOverride).toMatchObject({
      id: originalLegId,
      performanceOverrides: { cruiseTasKnots: { computedValue: 95, effectiveValue: 100, override: { value: 100, reason: "Instructor exercise" } } },
    });

    const reopenedRoot = document.createElement("div");
    renderPlanner(reopenedRoot, { airportLookup: createLocalStudyAirportLookup(), persistence, ids: ids(), clock });
    await settle();
    clickByLabel(reopenedRoot, "Open Preserved study route");
    await settle();
    expect(reopenedRoot.textContent).toContain("OVERRIDDEN effective TAS: 100 kt");
    expect(root.textContent).toContain("Saved revision history");
    const revisionButtons = root.querySelectorAll<HTMLButtonElement>(".revision-history button");
    expect(revisionButtons).toHaveLength(2);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    revisionButtons[1]?.click();
    await settle();
    expect(root.textContent).not.toContain("OVERRIDDEN effective TAS");
    expect(root.textContent).toContain("Opened historical revision");
    root.querySelectorAll<HTMLButtonElement>(".revision-history button")[0]?.click();
    await settle();
    expect(root.textContent).toContain("OVERRIDDEN effective TAS");
    confirm.mockRestore();

    clickByLabel(root, "Restore aircraft default");
    await settle();
    expect(root.textContent).not.toContain("OVERRIDDEN effective TAS");
    clickByLabel(root, "Reopen saved revision");
    await settle();
    expect(root.textContent).toContain("Opened current journal revision");

    input(root, "destination-icao").value = "KORD";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    clickByLabel(root, "Save new plan revision");
    await settle();
    expect(persistence.savedRevisions.at(-1)?.draftSnapshot.route.legs[0]?.performanceOverrides).toBeUndefined();
  });

  it("updates an automatic descent target for each newly resolved destination but preserves pilot input", async () => {
    const root = document.createElement("div");
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence: new MemoryPersistence(), ids: ids(), clock });
    await settle();

    input(root, "departure-icao").value = "KJVL";
    input(root, "destination-icao").value = "KORD";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    expect(input(root, "descent-target").value).toBe("1680");

    input(root, "destination-icao").value = "KJVL";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    expect(input(root, "descent-target").value).toBe("1808");

    input(root, "descent-target").value = "2500";
    input(root, "descent-target").dispatchEvent(new Event("input", { bubbles: true }));
    input(root, "destination-icao").value = "KORD";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    expect(input(root, "descent-target").value).toBe("2500");
  });

  it("keeps a reopened automatically calculated descent target automatic", async () => {
    const root = document.createElement("div");
    const persistence = new MemoryPersistence();
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence, ids: ids(), clock });
    await settle();
    const profileForm = root.querySelector<HTMLFormElement>(".profile-form");
    if (profileForm === null) throw new Error("Profile form was not rendered.");
    profileForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    input(root, "departure-icao").value = "KJVL";
    input(root, "destination-icao").value = "KORD";
    input(root, "departure-time").value = "2026-10-01T12:00";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    clickByLabel(root, "Save new plan revision");
    await settle();
    clickByLabel(root, "Reopen saved revision");
    await settle();

    input(root, "destination-icao").value = "KJVL";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    expect(input(root, "descent-target").value).toBe("1808");
  });

  it("derives a cleared automatic descent target from the resolved destination when saving", async () => {
    const root = document.createElement("div");
    const persistence = new MemoryPersistence();
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence, ids: ids(), clock });
    await settle();
    const profileForm = root.querySelector<HTMLFormElement>(".profile-form");
    if (profileForm === null) throw new Error("Profile form was not rendered.");
    profileForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    input(root, "departure-icao").value = "KJVL";
    input(root, "destination-icao").value = "KORD";
    input(root, "departure-time").value = "2026-10-01T12:00";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    input(root, "descent-target").value = "";
    input(root, "descent-target").dispatchEvent(new Event("input", { bubbles: true }));
    clickByLabel(root, "Save new plan revision");
    await settle();

    expect(persistence.savedRevisions.at(-1)?.draftSnapshot.descentTargetAltitudeFeetMsl.effectiveValue).toBe(1_680);
  });

  it("requires a usable compass-deviation card and saves each supplied point", async () => {
    const root = document.createElement("div");
    const persistence = new MemoryPersistence();
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence, ids: ids(), clock });
    await settle();
    const profileForm = root.querySelector<HTMLFormElement>(".profile-form");
    if (profileForm === null) throw new Error("Profile form was not rendered.");

    input(root, "compass-deviation-card").value = "";
    profileForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(root.textContent).toContain("Enter at least one compass-deviation card point");

    input(root, "compass-deviation-card").value = "000: +1, 090: -1";
    profileForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    await expect(persistence.listAircraftProfiles()).resolves.toEqual([
      expect.objectContaining({
        compassDeviationTable: [
          { magneticHeadingDegrees: 0, deviationDegrees: 1 },
          { magneticHeadingDegrees: 90, deviationDegrees: -1 },
        ],
      }),
    ]);
  });

  it("reports malformed airport identifiers without mutating the route", async () => {
    const root = document.createElement("div");
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence: new MemoryPersistence(), ids: ids(), clock });
    await settle();

    input(root, "departure-icao").value = "TOO-LONG";
    input(root, "destination-icao").value = "KJVL";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();

    expect(root.textContent).toContain("exact four-character ICAO");
    expect(root.textContent).toContain("Resolve departure and destination before defining leg altitudes.");
  });

  it("adds and removes a manually entered checkpoint only after coordinate validation", async () => {
    const root = document.createElement("div");
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence: new MemoryPersistence(), ids: ids(), clock });
    await settle();

    input(root, "checkpoint-name").value = "Study point";
    input(root, "checkpoint-latitude").value = "41.8";
    input(root, "checkpoint-longitude").value = "-88.2";
    const checkpointForm = root.querySelector<HTMLFormElement>(".checkpoint-editor form");
    if (checkpointForm === null) throw new Error("Checkpoint form was not rendered.");
    checkpointForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(root.textContent).toContain("Added checkpoint Study point.");
    clickByLabel(root, "Remove Study point");
    expect(root.textContent).not.toContain("Remove Study point");
  });

  it("preserves altitudes on unaffected legs when removing an earlier checkpoint", async () => {
    const root = document.createElement("div");
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence: new MemoryPersistence(), ids: ids(), clock });
    await settle();
    input(root, "departure-icao").value = "KORD";
    input(root, "destination-icao").value = "KJVL";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    const addCheckpoint = async (name: string, latitude: string, longitude: string): Promise<void> => {
      input(root, "checkpoint-name").value = name;
      input(root, "checkpoint-latitude").value = latitude;
      input(root, "checkpoint-longitude").value = longitude;
      const form = root.querySelector<HTMLFormElement>(".checkpoint-editor form");
      if (form === null) throw new Error("Checkpoint form was not rendered.");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle();
    };
    await addCheckpoint("A", "41.8", "-88.2");
    await addCheckpoint("B", "42.0", "-88.5");
    input(root, "leg-altitude-0").value = "4100";
    input(root, "leg-altitude-0").dispatchEvent(new Event("change", { bubbles: true }));
    input(root, "leg-altitude-1").value = "5100";
    input(root, "leg-altitude-1").dispatchEvent(new Event("change", { bubbles: true }));
    input(root, "leg-altitude-2").value = "6100";
    input(root, "leg-altitude-2").dispatchEvent(new Event("change", { bubbles: true }));

    clickByLabel(root, "Remove A");
    expect(input(root, "leg-altitude-0").value).toBe("4500");
    expect(input(root, "leg-altitude-1").value).toBe("6100");
  });

  it("accepts SkyVector compact DMS and rejects ambiguous mixed coordinate inputs", async () => {
    const root = document.createElement("div");
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence: new MemoryPersistence(), ids: ids(), clock });
    await settle();
    const checkpointForm = root.querySelector<HTMLFormElement>(".checkpoint-editor form");
    if (checkpointForm === null) throw new Error("Checkpoint form was not rendered.");
    input(root, "checkpoint-name").value = "DMS point";
    input(root, "checkpoint-compact").value = "420604N0884405W";
    checkpointForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(root.textContent).toContain("Added checkpoint DMS point.");
    expect(root.textContent).toContain("Remove DMS point");

    input(root, "checkpoint-name").value = "Ambiguous point";
    input(root, "checkpoint-compact").value = "421358N0884647W";
    input(root, "checkpoint-latitude").value = "42";
    const nextForm = root.querySelector<HTMLFormElement>(".checkpoint-editor form");
    if (nextForm === null) throw new Error("Checkpoint form was not rendered after adding a point.");
    nextForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(root.textContent).toContain("not both");
    expect(root.textContent).not.toContain("Remove Ambiguous point");
  });

  it("prevents saving a plan until its profile and exact airport endpoints are available", async () => {
    const root = document.createElement("div");
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence: new MemoryPersistence(), ids: ids(), clock });
    await settle();

    clickByLabel(root, "Save new plan revision");
    await settle();
    expect(root.textContent).toContain("Save and select an aircraft profile");
  });

  it("does not silently select the first locally stored aircraft profile", async () => {
    const fixture = await createCompleteFlightFixture();
    const persistence = new MemoryPersistence();
    await persistence.saveAircraftProfile(fixture.profile);
    const root = document.createElement("div");
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence, ids: ids(), clock });
    await settle();
    input(root, "departure-icao").value = "KORD";
    input(root, "destination-icao").value = "KJVL";
    input(root, "departure-time").value = "2026-10-01T12:00";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    clickByLabel(root, "Save new plan revision");
    await settle();
    expect(root.textContent).toContain("Save and select an aircraft profile");
  });

  it("reports invalid checkpoint and incomplete-route errors without changing the editable draft", async () => {
    const root = document.createElement("div");
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence: new MemoryPersistence(), ids: ids(), clock });
    await settle();

    input(root, "checkpoint-name").value = "Outside range";
    input(root, "checkpoint-latitude").value = "91";
    input(root, "checkpoint-longitude").value = "0";
    const checkpointForm = root.querySelector<HTMLFormElement>(".checkpoint-editor form");
    if (checkpointForm === null) throw new Error("Checkpoint form was not rendered.");
    checkpointForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(root.textContent).toContain("latitude must be between");

    input(root, "checkpoint-name").value = "";
    input(root, "checkpoint-latitude").value = "41";
    checkpointForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(root.textContent).toContain("Checkpoint name is required");

    const profileForm = root.querySelector<HTMLFormElement>(".profile-form");
    if (profileForm === null) throw new Error("Profile form was not rendered.");
    profileForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    clickByLabel(root, "Save new plan revision");
    await settle();
    expect(root.textContent).toContain("Resolve exact ICAO departure and destination first");
  });

  it("requires a UTC date/time before creating an immutable revision", async () => {
    const root = document.createElement("div");
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence: new MemoryPersistence(), ids: ids(), clock });
    await settle();
    const profileForm = root.querySelector<HTMLFormElement>(".profile-form");
    if (profileForm === null) throw new Error("Profile form was not rendered.");
    profileForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    input(root, "departure-icao").value = "KORD";
    input(root, "destination-icao").value = "KJVL";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();

    clickByLabel(root, "Save new plan revision");
    await settle();
    expect(root.textContent).toContain("Enter a planned departure UTC date and time");
  });

  it("blocks calculation after an unsaved route edit instead of silently using the prior revision", async () => {
    const root = document.createElement("div");
    const persistence = new MemoryPersistence();
    const calculatePlan = vi.fn();
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence, ids: ids(), clock, calculatePlan });
    await settle();
    const profileForm = root.querySelector<HTMLFormElement>(".profile-form");
    if (profileForm === null) throw new Error("Profile form was not rendered.");
    profileForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    input(root, "departure-icao").value = "KORD";
    input(root, "destination-icao").value = "KJVL";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    input(root, "departure-time").value = "2026-10-01T12:00";
    clickByLabel(root, "Save new plan revision");
    await settle();

    input(root, "leg-altitude-0").value = "6500";
    input(root, "leg-altitude-0").dispatchEvent(new Event("change", { bubbles: true }));
    clickByLabel(root, "Calculate complete navlog");
    await settle();

    expect(calculatePlan).not.toHaveBeenCalled();
    expect(root.textContent).toContain("Save the current route, aircraft, altitude, and forecast edits as a new revision before calculating.");
  });

  it("uses an explicitly selected second profile before the first plan revision", async () => {
    const root = document.createElement("div");
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence: new MemoryPersistence(), ids: ids(), clock });
    await settle();
    const saveNamedProfile = async (name: string): Promise<void> => {
      const form = root.querySelector<HTMLFormElement>(".profile-form");
      if (form === null) throw new Error("Profile form was not rendered.");
      input(root, "profile-name").value = name;
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle();
    };

    await saveNamedProfile("First aircraft");
    await saveNamedProfile("Second aircraft");
    const select = root.querySelector<HTMLSelectElement>("select[name='selected-profile']");
    if (select === null || select.options.length < 3) throw new Error("Expected two selectable profiles.");
    select.value = select.options[2]!.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    input(root, "departure-icao").value = "KORD";
    input(root, "destination-icao").value = "KJVL";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    input(root, "departure-time").value = "2026-10-01T12:00";
    clickByLabel(root, "Save new plan revision");
    await settle();

    expect(root.textContent).toContain("Cruise TAS aircraft default: 95 kt from Second aircraft.");
  });

  it("marks a newly saved profile selection as unsaved when a revision is open", async () => {
    const root = document.createElement("div");
    const persistence = new MemoryPersistence();
    const calculatePlan = vi.fn();
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence, ids: ids(), clock, calculatePlan });
    await settle();
    const profileForm = root.querySelector<HTMLFormElement>(".profile-form");
    if (profileForm === null) throw new Error("Profile form was not rendered.");
    profileForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    input(root, "departure-icao").value = "KORD";
    input(root, "destination-icao").value = "KJVL";
    input(root, "departure-time").value = "2026-10-01T12:00";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    clickByLabel(root, "Save new plan revision");
    await settle();

    input(root, "profile-name").value = "Different aircraft";
    profileForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    clickByLabel(root, "Calculate complete navlog");
    await settle();
    expect(calculatePlan).not.toHaveBeenCalled();
    expect(root.textContent).toContain("Save the current route, aircraft, altitude, and forecast edits as a new revision before calculating.");
  });

  it("clears a per-leg override when saving the same route with a different aircraft profile", async () => {
    const root = document.createElement("div");
    const persistence = new MemoryPersistence();
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence, ids: ids(), clock });
    await settle();
    const firstProfile = root.querySelector<HTMLFormElement>(".profile-form");
    if (firstProfile === null) throw new Error("Profile form was not rendered.");
    input(root, "profile-name").value = "Profile A";
    firstProfile.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    input(root, "departure-icao").value = "KORD";
    input(root, "destination-icao").value = "KJVL";
    input(root, "departure-time").value = "2026-10-01T12:00";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    clickByLabel(root, "Save new plan revision");
    await settle();
    clickByLabel(root, "Override TAS for this leg");
    input(root, "override-tas").value = "100";
    input(root, "override-confirmation").checked = true;
    const overrideForm = root.querySelector<HTMLFormElement>(".override-form");
    if (overrideForm === null) throw new Error("Override form was not rendered.");
    overrideForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    clickByLabel(root, "Save new plan revision");
    await settle();
    expect(persistence.savedRevisions.at(-1)?.draftSnapshot.route.legs[0]?.performanceOverrides).toBeDefined();

    const secondProfile = root.querySelector<HTMLFormElement>(".profile-form");
    if (secondProfile === null) throw new Error("Profile form was not rendered.");
    input(root, "profile-name").value = "Profile B";
    input(root, "cruise-tas").value = "120";
    secondProfile.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    const selector = root.querySelector<HTMLSelectElement>("select[name='selected-profile']");
    if (selector === null) throw new Error("Profile selector was not rendered.");
    selector.value = selector.options[selector.options.length - 1]!.value;
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    clickByLabel(root, "Save new plan revision");
    await settle();

    const saved = persistence.savedRevisions.at(-1);
    expect(saved?.draftSnapshot.selectedAircraftProfileId).toBe(selector.value);
    expect(saved?.draftSnapshot.route.legs[0]?.performanceOverrides).toBeUndefined();
  });

  it("clears the selected aircraft profile when the placeholder is chosen", async () => {
    const root = document.createElement("div");
    const persistence = new MemoryPersistence();
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence, ids: ids(), clock });
    await settle();
    const profileForm = root.querySelector<HTMLFormElement>(".profile-form");
    if (profileForm === null) throw new Error("Profile form was not rendered.");
    profileForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    const selector = root.querySelector<HTMLSelectElement>("select[name='selected-profile']");
    if (selector === null) throw new Error("Profile selector was not rendered.");
    selector.value = "";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(root.textContent).toContain("No aircraft profile selected.");

    input(root, "departure-icao").value = "KORD";
    input(root, "destination-icao").value = "KJVL";
    input(root, "departure-time").value = "2026-10-01T12:00";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    clickByLabel(root, "Save new plan revision");
    await settle();
    expect(root.textContent).toContain("Save and select an aircraft profile before saving a plan.");
  });

  it("requires a deliberate published forecast choice before storing it on a draft", async () => {
    const root = document.createElement("div");
    const persistence = new MemoryPersistence();
    const winds = { discoverStations: async () => ({ forecasts: [{ forecastCycle: "06", issuedAt: "2026-09-21T18:00:00.000Z", validAt: "2026-09-22T00:00:00.000Z", useFrom: "2026-09-21T20:00:00.000Z", useUntil: "2026-09-22T03:00:00.000Z" }] }) } as unknown as WindsTransportClient;
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence, ids: ids(), clock, winds });
    await settle();
    const profileForm = root.querySelector<HTMLFormElement>(".profile-form");
    if (profileForm === null) throw new Error("Profile form was not rendered.");
    profileForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    input(root, "departure-icao").value = "KORD";
    input(root, "destination-icao").value = "KJVL";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    input(root, "departure-time").value = "2026-09-21T22:00";
    input(root, "departure-time").dispatchEvent(new Event("input", { bubbles: true }));
    clickByLabel(root, "Load available winds periods");
    await settle();
    const selector = root.querySelector<HTMLSelectElement>("#selected-forecast-period");
    if (selector === null) throw new Error("Forecast selector was not rendered.");
    expect(selector.value).toBe("");
    selector.value = "2026-09-22T00:00:00.000Z";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    clickByLabel(root, "Save new plan revision");
    await settle();
    expect(persistence.savedRevisions.at(-1)?.draftSnapshot.weatherSelection?.forecastValidTimeUtc).toBe("2026-09-22T00:00:00.000Z");
  });

  it("shows a blocked calculation, then renders a saved complete worksheet and raw weather evidence", async () => {
    const root = document.createElement("div");
    const persistence = new MemoryPersistence();
    const refreshWeather = vi.fn().mockResolvedValue({ status: "blocked", reason: "weather-unavailable", message: "Fresh winds are unavailable.", warnings: [] });
    const winds = { discoverStations: async () => ({ forecasts: [{ forecastCycle: "06", issuedAt: "2026-09-21T18:00:00.000Z", validAt: "2026-09-22T00:00:00.000Z", useFrom: "2026-09-21T20:00:00.000Z", useUntil: "2026-09-22T03:00:00.000Z" }] }) } as unknown as WindsTransportClient;
    let attempt = 0;
    const calculatePlan: BrowserPlanCalculator = async (_draft, _profile, parent) => {
      attempt += 1;
      if (attempt === 1) return { status: "blocked", reason: "weather-unavailable", message: "Selected winds are unavailable.", warnings: [] };
      if (parent === undefined) throw new Error("Expected a saved parent revision.");
      const revision: PlanRevision = { ...parent, id: "calculated-1", revisionNumber: parent.revisionNumber + 1, parentRevisionId: parent.id, reason: "recalculation", weatherSnapshotIds: ["weather-1"], calculationSnapshot: { schema: "complete-navlog/v1", status: "calculated", phaseAllocation: { boundaries: [] }, weather: { source: "fixture" }, navlog: { rows: [{ subleg: { sourceLegId: parent.draftSnapshot.route.legs[0]!.id, phase: "cruise", startingAltitude: 4500, endingAltitude: 4500, trueCourse: 270, distance: 20 }, effectiveWind: { wind: { effectiveValue: { directionFrom: 240, speed: 12 } } }, trueHeading: 274.25, variation: { effectiveValue: -2 }, assumptions: [], appliedOverrides: [], traces: { windTriangle: { formulaId: "wind-triangle", formulaVersion: "1.0.0", inputs: [{ name: "TAS", value: 95, unit: "knots" }], intermediateValues: [], result: { name: "True heading", value: 274.25, unit: "degrees-true" }, rounding: { calculation: "unrounded", display: "nearest degree" }, warnings: [] } } }], fuelSummary: { requiredFuel: 10, enrouteFuel: 6 } } } };
      return { status: "saved", family: { schemaVersion: 1, id: revision.planId, title: revision.draftSnapshot.title, createdAt: revision.createdAt, latestRevisionId: revision.id, latestRevisionNumber: revision.revisionNumber }, revision, calculation: { status: "ready", routeLegs: [], weather: { snapshotIds: ["weather-1"], selectedForecastValidTimeUtc: "2026-09-22T00:00:00.000Z", phaseWindResolver: { resolveEffectiveWind: () => ({ ok: false, error: { code: "UNSUPPORTED_WIND_ALTITUDE", message: "not used", context: {} } }) }, warnings: [], provenance: { source: "fixture" } }, calculationSnapshot: revision.calculationSnapshot!, warnings: [] } };
    };
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence, ids: ids(), clock, winds, calculatePlan, refreshWeather, weatherEvidence: { getWeatherSnapshot: async () => ({ schemaVersion: 1, id: "weather-1", retrievedAt: "2026-09-21T12:00:00.000Z", source: "fixture", payload: { rawProduct: "RAW FB PRODUCT" } }) } });
    await settle();
    const profileForm = root.querySelector<HTMLFormElement>(".profile-form");
    if (profileForm === null) throw new Error("Profile form was not rendered.");
    profileForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    input(root, "departure-icao").value = "KORD";
    input(root, "destination-icao").value = "KJVL";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    input(root, "departure-time").value = "2026-09-21T22:00";
    clickByLabel(root, "Save new plan revision");
    await settle();
    clickByLabel(root, "Calculate complete navlog");
    await settle();
    expect(root.textContent).toContain("Navlog blocked: Selected winds are unavailable.");
    clickByLabel(root, "Calculate complete navlog");
    await settle();
    await settle();
    expect(root.textContent).toContain("Calculated and saved complete navlog revision calculated-1.");
    expect(root.textContent).toContain("Fuel required including taxi/run-up and reserve: 10.0 gal.");
    expect(root.textContent).toContain("RAW FB PRODUCT");
    const navlogTable = root.querySelector(".calculated-navlog table");
    root.querySelector<HTMLButtonElement>('button[aria-label^="Inspect trueHeading"]')?.click();
    expect(root.querySelector(".calculated-navlog table")).toBe(navlogTable);
    expect(root.textContent).toContain("Stored unrounded value: 274.25");
    expect(root.textContent).toContain("Formula: wind-triangle");
    clickByLabel(root, "Refresh weather into new revision");
    await settle();
    expect(root.textContent).toContain("choose a forecast before refreshing weather");
    expect(refreshWeather).not.toHaveBeenCalled();
    clickByLabel(root, "Load available winds periods");
    await settle();
    const selector = root.querySelector<HTMLSelectElement>("#selected-forecast-period");
    if (selector === null) throw new Error("Forecast selector was not rendered.");
    selector.value = "2026-09-22T00:00:00.000Z";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    clickByLabel(root, "Refresh weather into new revision");
    await settle();
    expect(refreshWeather).toHaveBeenCalledWith(expect.objectContaining({ id: "calculated-1" }), expect.objectContaining({ forecastValidTimeUtc: "2026-09-22T00:00:00.000Z" }));
    expect(root.textContent).toContain("Weather refresh blocked: Fresh winds are unavailable.");
  });

  it("freezes controls while a calculation owns the saved draft", async () => {
    const root = document.createElement("div");
    const persistence = new MemoryPersistence();
    let finishCalculation: ((result: Awaited<ReturnType<BrowserPlanCalculator>>) => void) | undefined;
    const calculatePlan: BrowserPlanCalculator = async () => new Promise((resolve) => { finishCalculation = resolve; });
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence, ids: ids(), clock, calculatePlan });
    await settle();
    const profileForm = root.querySelector<HTMLFormElement>(".profile-form");
    if (profileForm === null) throw new Error("Profile form was not rendered.");
    profileForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    input(root, "departure-icao").value = "KORD";
    input(root, "destination-icao").value = "KJVL";
    input(root, "departure-time").value = "2026-09-21T22:00";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    clickByLabel(root, "Save new plan revision");
    await settle();
    clickByLabel(root, "Calculate complete navlog");
    await settle();

    expect(input(root, "plan-title").disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    if (finishCalculation === undefined) throw new Error("Calculation did not start.");
    finishCalculation({ status: "blocked", reason: "weather-unavailable", message: "Selected winds are unavailable.", warnings: [] });
    await settle();
    expect(input(root, "plan-title").disabled).toBe(false);
    expect(root.textContent).toContain("Navlog blocked: Selected winds are unavailable.");
  });

  it("freezes controls through draft persistence and unlocks when history refresh fails", async () => {
    const root = document.createElement("div");
    const persistence = new MemoryPersistence();
    let finishSave: (() => void) | undefined;
    const saveRevision = persistence.savePlanRevision.bind(persistence);
    persistence.savePlanRevision = async (family, revision) => new Promise<void>((resolve) => {
      finishSave = () => { void saveRevision(family, revision).then(resolve); };
    });
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence, ids: ids(), clock });
    await settle();
    const profileForm = root.querySelector<HTMLFormElement>(".profile-form");
    if (profileForm === null) throw new Error("Profile form was not rendered.");
    profileForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    input(root, "departure-icao").value = "KORD";
    input(root, "destination-icao").value = "KJVL";
    input(root, "departure-time").value = "2026-09-21T22:00";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    clickByLabel(root, "Save new plan revision");
    await settle();
    expect(input(root, "plan-title").disabled).toBe(true);
    if (finishSave === undefined) throw new Error("Save did not start.");
    persistence.listPlanRevisions = async () => { throw new Error("History temporarily unavailable."); };
    finishSave();
    await settle();

    expect(input(root, "plan-title").disabled).toBe(false);
    expect(root.textContent).toContain("History temporarily unavailable.");
  });

  it("freezes controls while opening a saved revision", async () => {
    const root = document.createElement("div");
    const persistence = new MemoryPersistence();
    renderPlanner(root, { airportLookup: createLocalStudyAirportLookup(), persistence, ids: ids(), clock });
    await settle();
    const profileForm = root.querySelector<HTMLFormElement>(".profile-form");
    if (profileForm === null) throw new Error("Profile form was not rendered.");
    profileForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    input(root, "departure-icao").value = "KORD";
    input(root, "destination-icao").value = "KJVL";
    input(root, "departure-time").value = "2026-09-21T22:00";
    clickByLabel(root, "Resolve exact ICAO endpoints");
    await settle();
    clickByLabel(root, "Save new plan revision");
    await settle();

    const getRevision = persistence.getPlanRevision.bind(persistence);
    let finishOpen: (() => void) | undefined;
    persistence.getPlanRevision = async (id) => new Promise((resolve) => {
      finishOpen = () => { void getRevision(id).then(resolve); };
    });
    clickByLabel(root, "Reopen saved revision");
    await settle();
    expect(input(root, "plan-title").disabled).toBe(true);
    if (finishOpen === undefined) throw new Error("Revision opening did not start.");
    finishOpen();
    await settle();

    expect(input(root, "plan-title").disabled).toBe(false);
    expect(root.textContent).toContain("Opened current journal revision");
  });
});
