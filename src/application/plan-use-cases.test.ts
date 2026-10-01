import { describe, expect, it } from "vitest";
import { AirportLookupError, createLocalStudyAirportLookup, normalizeAirportCode } from "./airport-lookup";
import {
  applyCruiseTasOverride,
  createAircraftProfile,
  createPlanDraft,
  createRouteDefinition,
  restoreCruiseTasDefault,
  saveAircraftProfile,
  selectPlanWeatherForecast,
  type AircraftProfilePersistence,
  type UseCaseClock,
  type UseCaseIds,
} from "./plan-use-cases";
import type { AircraftProfile, AircraftProfileInput } from "../domain/aircraft";
import type { AirportRoutePoint } from "../domain/route";

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

class MemoryPersistence implements AircraftProfilePersistence {
  public readonly profiles = new Map<string, AircraftProfile>();

  public async saveAircraftProfile(profile: AircraftProfile): Promise<void> { this.profiles.set(profile.id, structuredClone(profile)); }
  public async getAircraftProfile(id: string): Promise<AircraftProfile | undefined> { return this.profiles.get(id); }
  public async listAircraftProfiles(): Promise<readonly AircraftProfile[]> { return [...this.profiles.values()]; }
}

describe("plan draft use cases", () => {
  it("creates ordered user legs from exact airport endpoints and manual checkpoints", async () => {
    const airports = createLocalStudyAirportLookup();
    const departure = await airports.lookupAirportCode("kord");
    const destination = await airports.lookupAirportCode("KJVL");
    const checkpoint = { kind: "checkpoint" as const, id: "checkpoint-1", name: "Study point", coordinate: departure.coordinate };

    const route = createRouteDefinition({ departure, checkpoints: [checkpoint], destination, cruiseAltitudesFeetMsl: [4_500, 5_500] }, ids("leg-1", "leg-2", "route-1"));

    expect(route.legs).toMatchObject([
      { fromPointId: "route-point-1-airport-kord", toPointId: "route-point-2-checkpoint-1", cruiseAltitudeFeetMsl: 4_500 },
      { fromPointId: "route-point-2-checkpoint-1", toPointId: "route-point-3-airport-kjvl", cruiseAltitudeFeetMsl: 5_500 },
    ]);
  });

  it("assigns distinct route-point identities to repeated airport endpoints", async () => {
    const airports = createLocalStudyAirportLookup();
    const departure = await airports.lookupAirportCode("KORD");
    const destination = await airports.lookupAirportCode("KORD");
    const route = createRouteDefinition({ departure, checkpoints: [], destination, cruiseAltitudesFeetMsl: [4_500] }, ids("leg-1", "route-1"));

    expect(route.points.map((point) => point.id)).toEqual(["route-point-1-airport-kord", "route-point-2-airport-kord"]);
    expect(route.legs[0]).toMatchObject({ fromPointId: "route-point-1-airport-kord", toPointId: "route-point-2-airport-kord" });
  });

  it("records destination field elevation as the current worksheet descent endpoint", async () => {
    const airports = createLocalStudyAirportLookup();
    const departure = await airports.lookupAirportCode("KORD");
    const destination = await airports.lookupAirportCode("KJVL");
    const route = createRouteDefinition({ departure, checkpoints: [], destination, cruiseAltitudesFeetMsl: [4_500] }, ids("leg-1", "route-1"));
    const draft = createPlanDraft({
      title: "Study route", departureTimeUtc: "2026-10-01T12:00:00.000Z", route,
      selectedAircraftProfileId: "aircraft-1", taxiRunupFuelGallons: 0, reserveFuelGallons: 3,
      descentTargetAltitudeFeetMsl: destination.elevationFeetMsl, descentTargetSource: "destination-field-elevation",
    }, ids("draft-1", "plan-1"), fixedClock);

    expect(draft.descentTargetAltitudeFeetMsl).toMatchObject({
      computedValue: destination.elevationFeetMsl,
      effectiveValue: destination.elevationFeetMsl,
      origin: "external-data",
      provenance: { sourceId: "destination-field-elevation", sourceLabel: "Destination airport field elevation" },
    });
  });

  it("keeps route-point identities stable when reopening an unchanged route", async () => {
    const airports = createLocalStudyAirportLookup();
    const departure = await airports.lookupAirportCode("KORD");
    const destination = await airports.lookupAirportCode("KJVL");
    const initial = createRouteDefinition({ departure, checkpoints: [], destination, cruiseAltitudesFeetMsl: [4_500] }, ids("leg-1", "route-1"));
    const reopened = createRouteDefinition({
      id: initial.id,
      departure: initial.points[0] as AirportRoutePoint,
      checkpoints: [],
      destination: initial.points[1] as AirportRoutePoint,
      cruiseAltitudesFeetMsl: [4_500],
    }, ids("leg-2"));

    expect(reopened.points.map((point) => point.id)).toEqual(initial.points.map((point) => point.id));
  });

  it("preserves the aircraft default when a per-leg TAS override is restored", async () => {
    const airports = createLocalStudyAirportLookup();
    const departure = await airports.lookupAirportCode("KORD");
    const destination = await airports.lookupAirportCode("KJVL");
    const profile = createAircraftProfile(profileInput(), ids("aircraft-1"), fixedClock);
    const route = createRouteDefinition({ departure, checkpoints: [], destination, cruiseAltitudesFeetMsl: [4_500] }, ids("leg-1", "route-1"));
    const draft = createPlanDraft({ title: "Study route", departureTimeUtc: "2026-10-01T12:00:00.000Z", route, selectedAircraftProfileId: profile.id, taxiRunupFuelGallons: 0, reserveFuelGallons: 3, descentTargetAltitudeFeetMsl: 1_808 }, ids("draft-1", "plan-1"), fixedClock);

    const overridden = applyCruiseTasOverride(draft, profile, "leg-1", 100, "Instructor exercise", fixedClock);
    expect(overridden.route.legs[0]?.performanceOverrides?.cruiseTasKnots).toMatchObject({ computedValue: 95, effectiveValue: 100, override: { value: 100 } });
    expect(restoreCruiseTasDefault(overridden, "leg-1", fixedClock).route.legs[0]?.performanceOverrides).toBeUndefined();
  });

  it("rejects malformed route, draft, override, revision, and airport-lookup inputs", async () => {
    const airports = createLocalStudyAirportLookup();
    const departure = await airports.lookupAirportCode("KORD");
    const destination = await airports.lookupAirportCode("KJVL");
    const profile = createAircraftProfile(profileInput(), ids("aircraft-1"), fixedClock);
    const route = createRouteDefinition({ departure, checkpoints: [], destination, cruiseAltitudesFeetMsl: [4_500] }, ids("leg-1", "route-1"));
    const draft = createPlanDraft({ title: "Study route", departureTimeUtc: "2026-10-01T12:00:00.000Z", route, selectedAircraftProfileId: profile.id, taxiRunupFuelGallons: 0, reserveFuelGallons: 3, descentTargetAltitudeFeetMsl: 1_808 }, ids("draft-1", "plan-1"), fixedClock);

    expect(() => createRouteDefinition({ departure, checkpoints: [], destination, cruiseAltitudesFeetMsl: [] }, ids("route-1"))).toThrow(/each route leg/iu);
    expect(() => createPlanDraft({ title: "", departureTimeUtc: "not-a-date", route, selectedAircraftProfileId: profile.id, taxiRunupFuelGallons: -1, reserveFuelGallons: 0, descentTargetAltitudeFeetMsl: 1_808 }, ids("draft-2", "plan-2"), fixedClock)).toThrow(/fuel/iu);
    expect(() => createPlanDraft({ title: "Study route", departureTimeUtc: "2026-10-01T12:00:00.000Z", route, selectedAircraftProfileId: profile.id, fuelAboardGallons: Number.NaN, taxiRunupFuelGallons: 0, reserveFuelGallons: 3, descentTargetAltitudeFeetMsl: 1_808 }, ids("draft-3", "plan-3"), fixedClock)).toThrow(/aboard/iu);
    expect(() => createPlanDraft({ title: "Study route", departureTimeUtc: "2026-10-01T12:00:00.000Z", route, selectedAircraftProfileId: profile.id, fuelAboardGallons: -1, taxiRunupFuelGallons: 0, reserveFuelGallons: 3, descentTargetAltitudeFeetMsl: 1_808 }, ids("draft-4", "plan-4"), fixedClock)).toThrow(/aboard/iu);
    const incompleteDraft = createPlanDraft({ title: "Study route", departureTimeUtc: "2026-10-01T12:00:00.000Z", route, selectedAircraftProfileId: profile.id, taxiRunupFuelGallons: 0, reserveFuelGallons: 3, descentTargetAltitudeFeetMsl: 1_808 }, ids("draft-5", "plan-5"), fixedClock);
    expect(incompleteDraft.fuelInputs).not.toHaveProperty("fuelAboardGallons");
    expect(() => applyCruiseTasOverride(draft, profile, "missing-leg", 0, undefined, fixedClock)).toThrow(/positive/iu);
    expect(() => normalizeAirportCode("too-long")).toThrow(AirportLookupError);
    expect(normalizeAirportCode("1c8")).toBe("1C8");
    await expect(airports.lookupAirportCode("KAAA")).rejects.toThrow(/local study airport/iu);
  });

  it("persists a newly created profile through the abstraction", async () => {
    const persistence = new MemoryPersistence();
    const profile = await saveAircraftProfile(persistence, profileInput(), ids("aircraft-1"), fixedClock);

    expect(await persistence.getAircraftProfile(profile.id)).toEqual(profile);
  });

  it("creates a new immutable profile identity when saving changed inputs", async () => {
    const persistence = new MemoryPersistence();
    const created = await saveAircraftProfile(persistence, profileInput(), ids("aircraft-1"), fixedClock);
    const updated = await saveAircraftProfile(persistence, { ...profileInput(), cruiseTasKnots: 105 }, ids("aircraft-2"), { now: () => new Date("2026-09-21T13:00:00.000Z") });

    expect(updated).toMatchObject({ id: "aircraft-2", cruiseTasKnots: 105, createdAt: "2026-09-21T13:00:00.000Z", updatedAt: "2026-09-21T13:00:00.000Z" });
    await expect(persistence.listAircraftProfiles()).resolves.toEqual([created, updated]);
  });

  it("omits optional usable fuel from a new profile version when its field is cleared", async () => {
    const persistence = new MemoryPersistence();
    const created = await saveAircraftProfile(persistence, { ...profileInput(), usableFuelGallons: 24 }, ids("aircraft-1"), fixedClock);
    const updated = await saveAircraftProfile(persistence, profileInput(), ids("aircraft-2"), fixedClock);

    expect(updated.usableFuelGallons).toBeUndefined();
    await expect(persistence.getAircraftProfile(updated.id)).resolves.toEqual(expect.not.objectContaining({ usableFuelGallons: expect.anything() }));
    await expect(persistence.getAircraftProfile(created.id)).resolves.toEqual(expect.objectContaining({ usableFuelGallons: 24 }));
  });

  it("persists only an explicitly selected, departure-valid forecast period", async () => {
    const airports = createLocalStudyAirportLookup();
    const departure = await airports.lookupAirportCode("KORD");
    const destination = await airports.lookupAirportCode("KJVL");
    const route = createRouteDefinition({ departure, checkpoints: [], destination, cruiseAltitudesFeetMsl: [4_500] }, ids("leg-1", "route-1"));
    const draft = createPlanDraft({ title: "Study route", departureTimeUtc: "2026-10-01T12:00:00.000Z", route, selectedAircraftProfileId: "aircraft-1", taxiRunupFuelGallons: 0, reserveFuelGallons: 3, descentTargetAltitudeFeetMsl: 1_808 }, ids("draft-1", "plan-1"), fixedClock);
    const periods = [{ id: "2026-10-01T12:00:00.000Z", validFromUtc: "2026-10-01T10:00:00.000Z", validToUtc: "2026-10-01T15:00:00.000Z" }];

    const selected = selectPlanWeatherForecast(draft, periods, periods[0]!.id, fixedClock);
    expect(selected.weatherSelection).toEqual({ forecastValidTimeUtc: periods[0]!.id, selectedAtUtc: "2026-09-21T12:00:00.000Z" });
    expect(() => selectPlanWeatherForecast(draft, periods, "2026-10-01T18:00:00.000Z", fixedClock)).toThrow(/unavailable/iu);
  });
});
