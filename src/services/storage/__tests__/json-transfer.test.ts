import { describe, expect, it } from "vitest";
import { parseNavlogExport, serializeNavlogExport } from "../json-transfer";
import { exportBundle } from "./fixtures";

describe("JSON import and export", () => {
  it("round-trips a validated export without changing supported data", () => {
    const original = exportBundle();
    const serialized = serializeNavlogExport(original);
    const imported = parseNavlogExport(serialized, new Date("2027-01-01T00:00:00.000Z"));

    expect(imported).toEqual(original);
  });

  it("rejects a dangling weather-snapshot reference before a storage write", () => {
    const bundle = exportBundle();
    const malformed = { ...bundle, planRevisions: [{ ...bundle.planRevisions[0], weatherSnapshotIds: ["missing-weather"] }] };

    expect(() => parseNavlogExport(JSON.stringify(malformed), new Date("2027-01-01T00:00:00.000Z"))).toThrow(/weather snapshot/);
  });

  it("fails closed on an unsupported future format", () => {
    const malformed = { ...exportBundle(), formatVersion: 2 };

    expect(() => parseNavlogExport(JSON.stringify(malformed), new Date("2027-01-01T00:00:00.000Z"))).toThrow(/formatVersion/);
  });

  it("rejects malformed syntax, envelope metadata, collections, and relationship references", () => {
    const now = new Date("2027-01-01T00:00:00.000Z");
    expect(() => parseNavlogExport("{", now)).toThrow(/valid JSON/);
    expect(() => parseNavlogExport("[]", now)).toThrow(/must be an object/);
    expect(() => parseNavlogExport(JSON.stringify({ ...exportBundle(), format: "other", exportedAt: "not-a-date" }), now)).toThrow(/format/);
    expect(() => parseNavlogExport(JSON.stringify({ ...exportBundle(), aircraftProfiles: "not-an-array" }), now)).toThrow(/aircraftProfiles/);

    const bundle = exportBundle();
    const danglingParent = { ...bundle, planRevisions: [{ ...bundle.planRevisions[0], parentRevisionId: "missing-parent" }] };
    expect(() => parseNavlogExport(JSON.stringify(danglingParent), now)).toThrow(/parentRevisionId/);
    const danglingFamily = { ...bundle, planRevisions: [{ ...bundle.planRevisions[0], planId: "missing-family" }] };
    expect(() => parseNavlogExport(JSON.stringify(danglingFamily), now)).toThrow(/planId/);
    const danglingLatest = { ...bundle, planFamilies: [{ ...bundle.planFamilies[0], latestRevisionId: "missing-revision" }] };
    expect(() => parseNavlogExport(JSON.stringify(danglingLatest), now)).toThrow(/latestRevisionId/);

    const otherRevision = { ...bundle.planRevisions[0], id: "revision-2", planId: "plan-2", draftSnapshot: { ...bundle.planRevisions[0]!.draftSnapshot, planId: "plan-2" } };
    const otherFamily = { ...bundle.planFamilies[0], id: "plan-2", latestRevisionId: otherRevision.id };
    const crossFamilyLatest = { ...bundle, planFamilies: [{ ...bundle.planFamilies[0], latestRevisionId: otherRevision.id }, otherFamily], planRevisions: [bundle.planRevisions[0], otherRevision] };
    expect(() => parseNavlogExport(JSON.stringify(crossFamilyLatest), now)).toThrow(/same plan family/);

    const crossFamilyParent = { ...bundle, planFamilies: [bundle.planFamilies[0], otherFamily], planRevisions: [{ ...bundle.planRevisions[0], parentRevisionId: otherRevision.id }, otherRevision] };
    expect(() => parseNavlogExport(JSON.stringify(crossFamilyParent), now)).toThrow(/same plan family/);
  });

  it("rejects duplicate ids and oversized serialized input", () => {
    const now = new Date("2027-01-01T00:00:00.000Z");
    const bundle = exportBundle();
    const duplicate = { ...bundle, aircraftProfiles: [bundle.aircraftProfiles[0], bundle.aircraftProfiles[0]] };
    expect(() => parseNavlogExport(JSON.stringify(duplicate), now)).toThrow(/unique/);
    expect(() => parseNavlogExport(" ".repeat(1_000_001), now)).toThrow(/byte limit/);
  });

  it("rejects duplicate route leg ids at the import boundary", () => {
    const bundle = exportBundle();
    const draft = bundle.planRevisions[0]!.draftSnapshot;
    const route = {
      ...draft.route,
      legs: [draft.route.legs[0]!, { ...draft.route.legs[1]!, id: draft.route.legs[0]!.id }],
    };
    const malformed = {
      ...bundle,
      planRevisions: [{ ...bundle.planRevisions[0]!, draftSnapshot: { ...draft, route } }],
    };

    expect(() => parseNavlogExport(JSON.stringify(malformed), new Date("2027-01-01T00:00:00.000Z"))).toThrow(/legs\[1\]\.id.*unique/u);
  });

  it("exports valid immutable local history larger than the bounded import size", () => {
    const bundle = exportBundle();
    const oversizedButValid = {
      ...bundle,
      weatherSnapshots: [{ ...bundle.weatherSnapshots[0]!, payload: { rawProduct: "x".repeat(1_000_001) } }],
    };

    const serialized = serializeNavlogExport(oversizedButValid);
    expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(1_000_000);
    expect(() => parseNavlogExport(serialized, new Date("2027-01-01T00:00:00.000Z"))).toThrow(/byte limit/u);
  });
});
