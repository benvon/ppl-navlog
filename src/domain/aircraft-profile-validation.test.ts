import { describe, expect, it } from "vitest";
import { inspectAircraftProfile } from "./aircraft-profile-validation";

const profile = {
  schemaVersion: 1, id: "trainer", name: "Trainer",
  cruiseTasKnots: 100, cruiseFuelFlowGallonsPerHour: 8,
  climbRateFeetPerMinute: 500, climbTasKnots: 80, climbFuelFlowGallonsPerHour: 10,
  descentRateFeetPerMinute: 500, descentTasKnots: 90, descentFuelFlowGallonsPerHour: 6,
  compassDeviationTable: [{ magneticHeadingDegrees: 0, deviationDegrees: 0 }],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const now = new Date("2026-09-30T00:00:00Z");

describe("shared aircraft profile validation", () => {
  it("accepts the supported profile format", () => {
    expect(inspectAircraftProfile(profile, now)).toEqual({ kind: "valid", profile });
  });

  it("classifies explicit unsupported versions separately from malformed data", () => {
    expect(inspectAircraftProfile({ schemaVersion: 99, id: 42 }, now)).toEqual({ kind: "unsupported-schema", schemaVersion: 99 });
    expect(inspectAircraftProfile({ ...profile, schemaVersion: "1" }, now).kind).toBe("malformed");
    expect(inspectAircraftProfile({ ...profile, schemaVersion: undefined }, now).kind).toBe("malformed");
  });

  it.each([
    ["non-object", null],
    ["nonfinite performance", { ...profile, climbTasKnots: Number.NaN }],
    ["nonpositive rate", { ...profile, descentRateFeetPerMinute: 0 }],
    ["empty deviation table", { ...profile, compassDeviationTable: [] }],
    ["wrong table type", { ...profile, compassDeviationTable: "none" }],
    ["duplicate headings", { ...profile, compassDeviationTable: [profile.compassDeviationTable[0], profile.compassDeviationTable[0]] }],
    ["invalid heading", { ...profile, compassDeviationTable: [{ magneticHeadingDegrees: 360, deviationDegrees: 0 }] }],
    ["nonfinite deviation", { ...profile, compassDeviationTable: [{ magneticHeadingDegrees: 0, deviationDegrees: Infinity }] }],
    ["unsupported profile field", { ...profile, extra: true }],
    ["unsupported table field", { ...profile, compassDeviationTable: [{ magneticHeadingDegrees: 0, deviationDegrees: 0, extra: true }] }],
    ["invalid calendar date", { ...profile, createdAt: "2026-02-30T00:00:00Z" }],
    ["future timestamp", { ...profile, updatedAt: "2027-01-01T00:00:00Z" }],
    ["timestamps out of order", { ...profile, updatedAt: "2025-01-01T00:00:00Z" }],
  ])("rejects %s", (_label, candidate) => {
    const result = inspectAircraftProfile(candidate, now);
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") expect(result.issues.length).toBeGreaterThan(0);
  });
});
