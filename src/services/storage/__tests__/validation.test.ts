import { describe, expect, it } from "vitest";
import { isOverridden, overridePlanningValue, restoreComputedValue } from "../../../domain/planning-value";
import {
  isJsonValue,
  validateAircraftProfile,
  validateAircraftProfileSnapshot,
  validatePlanDraft,
  validatePlanFamily,
  validatePlanRevision,
  validateRouteDefinition,
  validateWeatherReferenceSnapshot,
} from "../validation";
import { aircraftDefaultValue, aircraftProfile, planDraft, planFamily, planRevision, route, timestamp, weatherSnapshot } from "./fixtures";

describe("storage model validation", () => {
  it("preserves original defaults while applying and restoring a deliberate override", () => {
    const original = aircraftDefaultValue(100);
    const overridden = overridePlanningValue(original, { value: 105, reason: "Instructor exercise", createdAt: timestamp });

    expect(overridden.effectiveValue).toBe(105);
    expect(overridden.computedValue).toBe(100);
    expect(isOverridden(original)).toBe(false);
    expect(isOverridden(overridden)).toBe(true);
    expect(restoreComputedValue(overridden)).toMatchObject({ effectiveValue: 100, computedValue: 100 });
  });

  it("does not let pilot-input or value-less data enter the override flow", () => {
    const pilotInput = { ...aircraftDefaultValue(100), computedValue: null, origin: "pilot-input" as const };

    expect(() => overridePlanningValue(pilotInput, { value: 90, createdAt: timestamp })).toThrow(/Only calculated/);
    expect(() => restoreComputedValue(pilotInput)).toThrow(/cannot be restored/);
  });

  it("rejects duplicate compass headings in an aircraft profile", () => {
    const profile = aircraftProfile();
    const malformed = { ...profile, compassDeviationTable: [...profile.compassDeviationTable, { magneticHeadingDegrees: 90, deviationDegrees: -1 }] };

    expect(() => validateAircraftProfile(malformed, new Date("2027-01-01T00:00:00.000Z"))).toThrow(/must be unique/);
  });

  it("rejects an empty compass-deviation table at the storage boundary", () => {
    expect(() => validateAircraftProfile({ ...aircraftProfile(), compassDeviationTable: [] }, new Date("2027-01-01T00:00:00.000Z"))).toThrow(/between 1 and 360/u);
  });

  it("uses the shared [0, 360) canonical heading range for compass-deviation entries", () => {
    const profile = aircraftProfile();
    expect(validateAircraftProfile({ ...profile, compassDeviationTable: [{ magneticHeadingDegrees: 0, deviationDegrees: 0 }] }, new Date("2027-01-01T00:00:00.000Z"))).toBe(true);
    expect(() => validateAircraftProfile({ ...profile, compassDeviationTable: [{ magneticHeadingDegrees: 360, deviationDegrees: 0 }] }, new Date("2027-01-01T00:00:00.000Z"))).toThrow(/at most/);
  });

  it("rejects a route leg that skips the next user-defined point", () => {
    const definition = route();
    const malformed = { ...definition, legs: [{ ...definition.legs[0], toPointId: "destination-1" }, definition.legs[1]] };

    expect(() => validateRouteDefinition(malformed)).toThrow(/following route point/);
  });

  it("allows a future planned departure while keeping revision timestamps bounded", () => {
    expect(validatePlanDraft(planDraft(), new Date("2027-01-01T00:00:00.000Z"))).toBe(true);
  });

  it("validates an optional explicitly selected forecast period on persisted drafts", () => {
    const fixedNow = new Date("2027-01-01T00:00:00.000Z");
    const weatherSelection = { forecastValidTimeUtc: "2026-10-01T12:00:00.000Z", selectedAtUtc: timestamp };
    expect(validatePlanDraft({ ...planDraft(), weatherSelection }, fixedNow)).toBe(true);
    expect(() => validatePlanDraft({ ...planDraft(), weatherSelection: { ...weatherSelection, forecastValidTimeUtc: "not-utc" } }, fixedNow)).toThrow(/forecastValidTimeUtc/u);
    expect(() => validatePlanDraft({ ...planDraft(), weatherSelection: { ...weatherSelection, selectedAtUtc: "2030-01-01T00:00:00.000Z" } }, fixedNow)).toThrow(/future/u);
  });

  it("rejects malformed per-leg overrides and invalid checkpoint route structures", () => {
    const definition = route();
    const invalidOverride = {
      ...definition,
      legs: [{ ...definition.legs[0], performanceOverrides: { cruiseTasKnots: { ...aircraftDefaultValue(100), effectiveValue: 101 } } }, definition.legs[1]],
    };
    const nonAirportEndpoints = { ...definition, points: [{ ...definition.points[0], kind: "checkpoint" }, ...definition.points.slice(1)] };

    expect(() => validateRouteDefinition(invalidOverride)).toThrow(/effectiveValue/);
    expect(() => validateRouteDefinition(nonAirportEndpoints)).toThrow(/departure airport/);
  });

  it("validates snapshot, family, weather, and revision relationships at persistence boundaries", () => {
    const fixedNow = new Date("2027-01-01T00:00:00.000Z");
    expect(validateAircraftProfileSnapshot({ profile: aircraftProfile(), snapshottedAt: timestamp }, fixedNow)).toBe(true);
    expect(validatePlanFamily(planFamily(), fixedNow)).toBe(true);
    expect(validateWeatherReferenceSnapshot(weatherSnapshot(), fixedNow)).toBe(true);
    expect(validatePlanRevision(planRevision(), fixedNow)).toBe(true);

    const mismatched = { ...planRevision(), planId: "other-plan" };
    expect(() => validatePlanRevision(mismatched, fixedNow)).toThrow(/draftSnapshot.planId/);
    expect(() => validateWeatherReferenceSnapshot({ ...weatherSnapshot(), payload: Number.NaN }, fixedNow)).toThrow(/payload/);
    expect(() => validatePlanFamily({ ...planFamily(), latestRevisionId: "" }, fixedNow)).toThrow(/latestRevisionId/);
  });

  it("accepts a documented override while preserving its original calculated value", () => {
    const target = aircraftDefaultValue(1_808);
    const overridden = {
      ...target,
      effectiveValue: 2_000,
      provenance: { ...target.provenance, sourceVersion: "1" },
      override: { value: 2_000, reason: "Instructor exercise", createdAt: timestamp },
    };
    expect(validatePlanDraft({ ...planDraft(), descentTargetAltitudeFeetMsl: overridden }, new Date("2027-01-01T00:00:00.000Z"))).toBe(true);
  });

  it("rejects non-JSON values and accepts bounded nested JSON snapshots", () => {
    expect(isJsonValue({ nested: [null, "text", true, 1] })).toBe(true);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue({ ["x".repeat(121)]: "value" })).toBe(false);
  });

  it("rejects invalid persisted objects at each public storage boundary", () => {
    const fixedNow = new Date("2027-01-01T00:00:00.000Z");

    expect(() => validateAircraftProfile({}, fixedNow)).toThrow(/schemaVersion/);
    expect(() => validateAircraftProfileSnapshot({}, fixedNow)).toThrow(/profile/);
    expect(() => validateRouteDefinition({})).toThrow(/points/);
    expect(() => validatePlanDraft({}, fixedNow)).toThrow(/route/);
    expect(() => validatePlanFamily({}, fixedNow)).toThrow(/schemaVersion/);
    expect(() => validateWeatherReferenceSnapshot({}, fixedNow)).toThrow(/payload/);
    expect(() => validatePlanRevision({}, fixedNow)).toThrow(/draftSnapshot/);
  });

  it("rejects timestamps, ranges, and collection structures outside persistence limits", () => {
    const fixedNow = new Date("2027-01-01T00:00:00.000Z");
    const profile = aircraftProfile();
    expect(() => validateAircraftProfile({ ...profile, usableFuelGallons: -1 }, fixedNow)).toThrow(/at least 0/);
    expect(() => validateAircraftProfile({ ...profile, createdAt: "2030-01-01T00:00:00.000Z" }, fixedNow)).toThrow(/future/);
    expect(() => validatePlanDraft({ ...planDraft(), fuelInputs: "not-an-object" }, fixedNow)).toThrow(/fuelInputs/);
    expect(() => validatePlanRevision({ ...planRevision(), weatherSnapshotIds: "not-an-array" }, fixedNow)).toThrow(/weatherSnapshotIds/);
    expect(() => validatePlanRevision({ ...planRevision(), warnings: [123] }, fixedNow)).toThrow(/warnings/);
  });
});
