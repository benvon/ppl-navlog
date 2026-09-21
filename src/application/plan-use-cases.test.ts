import { describe, expect, it } from "vitest";
import { AirportLookupError, createLocalStudyAirportLookup, normalizeIcao } from "./airport-lookup";
import {
  applyCruiseTasOverride,
  createAircraftProfile,
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
} from "./plan-use-cases";
import type { AircraftProfile, AircraftProfileInput } from "../domain/aircraft";
import type { PlanFamily, PlanRevision } from "../domain/route";

const fixedClock: UseCaseClock = { now: () => new Date("2026-09-21T12:00:00.000Z") };
const ids = (...values: string[]): UseCaseIds => ({ next: () => values.shift() ?? "unexpected-id" });

const profileInput = (): AircraftProfileInput => ({
  name: "Study Cessna",
  cruiseTasKnots: 95,
  cruiseFuelFlowGallonsPerHour: 6,
  climbRateFeetPerMinute: 500,
  climbTasKnots: 75,
  climbFuelFlowGallonsPerHour: 7,
  descentRateFeetPerMinute: 500,
  descentTasKnots: 100,
  descentFuelFlowGallonsPerHour: 5,
  compassDeviationTable: [],
});

class MemoryPersistence implements NavlogPersistence {
  public readonly profiles = new Map<string, AircraftProfile>();
  public readonly revisions = new Map<string, PlanRevision>();
  public readonly families = new Map<string, PlanFamily>();

  public async saveAircraftProfile(profile: AircraftProfile): Promise<void> { this.profiles.set(profile.id, structuredClone(profile)); }
  public async getAircraftProfile(id: string): Promise<AircraftProfile | undefined> { return this.profiles.get(id); }
  public async listAircraftProfiles(): Promise<readonly AircraftProfile[]> { return [...this.profiles.values()]; }
  public async savePlanRevision(family: PlanFamily, revision: PlanRevision): Promise<void> {
    if (this.revisions.has(revision.id)) throw new Error("duplicate revision");
    this.families.set(family.id, structuredClone(family));
    this.revisions.set(revision.id, structuredClone(revision));
  }
  public async getPlanRevision(id: string): Promise<PlanRevision | undefined> { return this.revisions.get(id); }
  public async listPlanRevisions(planId: string): Promise<readonly PlanRevision[]> {
    return [...this.revisions.values()].filter((revision) => revision.planId === planId);
  }
  public async listPlanFamilies(): Promise<readonly PlanFamily[]> { return [...this.families.values()]; }
}

describe("plan draft use cases", () => {
  it("creates ordered user legs from exact airport endpoints and manual checkpoints", async () => {
    const airports = createLocalStudyAirportLookup();
    const departure = await airports.lookupExactIcao("kord");
    const destination = await airports.lookupExactIcao("KJVL");
    const checkpoint = { kind: "checkpoint" as const, id: "checkpoint-1", name: "Study point", coordinate: departure.coordinate };

    const route = createRouteDefinition({ departure, checkpoints: [checkpoint], destination, cruiseAltitudesFeetMsl: [4_500, 5_500] }, ids("leg-1", "leg-2", "route-1"));

    expect(route.legs).toMatchObject([
      { fromPointId: departure.id, toPointId: checkpoint.id, cruiseAltitudeFeetMsl: 4_500 },
      { fromPointId: checkpoint.id, toPointId: destination.id, cruiseAltitudeFeetMsl: 5_500 },
    ]);
  });

  it("preserves the aircraft default when a per-leg TAS override is restored", async () => {
    const airports = createLocalStudyAirportLookup();
    const departure = await airports.lookupExactIcao("KORD");
    const destination = await airports.lookupExactIcao("KJVL");
    const profile = createAircraftProfile(profileInput(), ids("aircraft-1"), fixedClock);
    const route = createRouteDefinition({ departure, checkpoints: [], destination, cruiseAltitudesFeetMsl: [4_500] }, ids("leg-1", "route-1"));
    const draft = createPlanDraft({ title: "Study route", departureTimeUtc: "2026-10-01T12:00:00.000Z", route, selectedAircraftProfileId: profile.id, taxiRunupFuelGallons: 0, reserveFuelGallons: 3, descentTargetAltitudeFeetMsl: 1_808 }, ids("draft-1", "plan-1"), fixedClock);

    const overridden = applyCruiseTasOverride(draft, profile, "leg-1", 100, "Instructor exercise", fixedClock);
    expect(overridden.route.legs[0]?.performanceOverrides?.cruiseTasKnots).toMatchObject({ computedValue: 95, effectiveValue: 100, override: { value: 100 } });
    expect(restoreCruiseTasDefault(overridden, "leg-1", fixedClock).route.legs[0]?.performanceOverrides).toBeUndefined();
  });

  it("saves an initial revision, then appends a revised immutable child and reopens it", async () => {
    const airports = createLocalStudyAirportLookup();
    const departure = await airports.lookupExactIcao("KORD");
    const destination = await airports.lookupExactIcao("KJVL");
    const profile = createAircraftProfile(profileInput(), ids("aircraft-1"), fixedClock);
    const route = createRouteDefinition({ departure, checkpoints: [], destination, cruiseAltitudesFeetMsl: [4_500] }, ids("leg-1", "route-1"));
    const draft = createPlanDraft({ title: "Study route", departureTimeUtc: "2026-10-01T12:00:00.000Z", route, selectedAircraftProfileId: profile.id, taxiRunupFuelGallons: 0, reserveFuelGallons: 3, descentTargetAltitudeFeetMsl: 1_808 }, ids("draft-1", "plan-1"), fixedClock);
    const persistence = new MemoryPersistence();

    const first = await saveDraftRevision(persistence, draft, profile, ids("revision-1"), fixedClock);
    const revised = { ...draft, title: "Updated study route", updatedAt: "2026-09-21T13:00:00.000Z" };
    const second = await saveDraftRevision(persistence, revised, profile, ids("revision-2"), fixedClock, first.revision);

    expect(second.revision.parentRevisionId).toBe(first.revision.id);
    await expect(reopenPlanRevision(persistence, second.revision.id)).resolves.toMatchObject({ id: "revision-2", draftSnapshot: { title: "Updated study route" } });
  });

  it("rejects malformed route, draft, override, revision, and airport-lookup inputs", async () => {
    const airports = createLocalStudyAirportLookup();
    const departure = await airports.lookupExactIcao("KORD");
    const destination = await airports.lookupExactIcao("KJVL");
    const profile = createAircraftProfile(profileInput(), ids("aircraft-1"), fixedClock);
    const route = createRouteDefinition({ departure, checkpoints: [], destination, cruiseAltitudesFeetMsl: [4_500] }, ids("leg-1", "route-1"));
    const draft = createPlanDraft({ title: "Study route", departureTimeUtc: "2026-10-01T12:00:00.000Z", route, selectedAircraftProfileId: profile.id, taxiRunupFuelGallons: 0, reserveFuelGallons: 3, descentTargetAltitudeFeetMsl: 1_808 }, ids("draft-1", "plan-1"), fixedClock);

    expect(() => createRouteDefinition({ departure, checkpoints: [], destination, cruiseAltitudesFeetMsl: [] }, ids("route-1"))).toThrow(/each route leg/iu);
    expect(() => createPlanDraft({ title: "", departureTimeUtc: "not-a-date", route, selectedAircraftProfileId: profile.id, taxiRunupFuelGallons: -1, reserveFuelGallons: 0, descentTargetAltitudeFeetMsl: 1_808 }, ids("draft-2", "plan-2"), fixedClock)).toThrow(/fuel/iu);
    expect(() => applyCruiseTasOverride(draft, profile, "missing-leg", 0, undefined, fixedClock)).toThrow(/positive/iu);
    await expect(saveDraftRevision(new MemoryPersistence(), draft, { ...profile, id: "wrong-aircraft" }, ids("revision-1"), fixedClock)).rejects.toThrow(/does not match/iu);
    await expect(reopenPlanRevision(new MemoryPersistence(), "missing-revision")).rejects.toThrow(/no longer available/iu);
    expect(() => normalizeIcao("too-long")).toThrow(AirportLookupError);
    await expect(airports.lookupExactIcao("KAAA")).rejects.toThrow(/local study airport/iu);
  });

  it("persists a newly created profile through the abstraction", async () => {
    const persistence = new MemoryPersistence();
    const profile = await saveAircraftProfile(persistence, profileInput(), ids("aircraft-1"), fixedClock);

    expect(await persistence.getAircraftProfile(profile.id)).toEqual(profile);
  });

  it("persists only an explicitly selected, departure-valid forecast period", async () => {
    const airports = createLocalStudyAirportLookup();
    const departure = await airports.lookupExactIcao("KORD");
    const destination = await airports.lookupExactIcao("KJVL");
    const route = createRouteDefinition({ departure, checkpoints: [], destination, cruiseAltitudesFeetMsl: [4_500] }, ids("leg-1", "route-1"));
    const draft = createPlanDraft({ title: "Study route", departureTimeUtc: "2026-10-01T12:00:00.000Z", route, selectedAircraftProfileId: "aircraft-1", taxiRunupFuelGallons: 0, reserveFuelGallons: 3, descentTargetAltitudeFeetMsl: 1_808 }, ids("draft-1", "plan-1"), fixedClock);
    const periods = [{ id: "2026-10-01T12:00:00.000Z", validFromUtc: "2026-10-01T10:00:00.000Z", validToUtc: "2026-10-01T15:00:00.000Z" }];

    const selected = selectPlanWeatherForecast(draft, periods, periods[0]!.id, fixedClock);
    expect(selected.weatherSelection).toEqual({ forecastValidTimeUtc: periods[0]!.id, selectedAtUtc: "2026-09-21T12:00:00.000Z" });
    expect(() => selectPlanWeatherForecast(draft, periods, "2026-10-01T18:00:00.000Z", fixedClock)).toThrow(/unavailable/iu);
  });
});
