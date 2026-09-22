import { describe, expect, it } from "vitest";
import { MAX_ARCHIVE_BYTES, MAX_PROFILES_PER_ARCHIVE, parseNavlogArchive, serializeNavlogArchive } from "../json-transfer";
import { aircraftProfile, planArchive } from "./fixtures";

describe("bounded plan archives", () => {
  it("round-trips a self-contained plan archive", () => {
    const archive = planArchive();

    expect(parseNavlogArchive(serializeNavlogArchive(archive), new Date("2027-01-01T00:00:00.000Z"))).toEqual(archive);
  });

  it("round-trips a separate profile archive", () => {
    const archive = { format: "ppl-navlog/profile-archive" as const, formatVersion: 1 as const, exportedAt: "2026-09-21T12:00:00.000Z", aircraftProfiles: [aircraftProfile()] };

    expect(parseNavlogArchive(serializeNavlogArchive(archive), new Date("2027-01-01T00:00:00.000Z"))).toEqual(archive);
  });

  it("requires each plan snapshot's editable profile and weather evidence", () => {
    const archive = planArchive();
    const missingProfile = { ...archive, aircraftProfiles: [] };
    const missingWeather = { ...archive, weatherSnapshots: [] };

    expect(() => parseNavlogArchive(JSON.stringify(missingProfile), new Date("2027-01-01T00:00:00.000Z"))).toThrow(/archived aircraft profile/);
    expect(() => parseNavlogArchive(JSON.stringify(missingWeather), new Date("2027-01-01T00:00:00.000Z"))).toThrow(/weather snapshot/);
  });

  it("does not require pruned legacy parent identifiers to be present", () => {
    const archive = planArchive();
    const withProvenance = { ...archive, planRevisions: [{ ...archive.planRevisions[0]!, parentRevisionId: "pruned-history" }] };

    expect(() => parseNavlogArchive(JSON.stringify(withProvenance), new Date("2027-01-01T00:00:00.000Z"))).not.toThrow();
  });

  it("rejects malformed envelopes and archive limits before any storage write", () => {
    const now = new Date("2027-01-01T00:00:00.000Z");
    expect(() => parseNavlogArchive("{", now)).toThrow(/valid JSON/);
    expect(() => parseNavlogArchive(JSON.stringify({ format: "unsupported", formatVersion: 1, exportedAt: "2026-09-21T12:00:00.000Z" }), now)).toThrow(/plan-archive/);
    expect(() => parseNavlogArchive(" ".repeat(MAX_ARCHIVE_BYTES + 1), now)).toThrow(/archive limit/);
    expect(() => parseNavlogArchive(JSON.stringify({ ...planArchive(), formatVersion: 2 }), now)).toThrow(/formatVersion/);
    const tooManyProfiles = { format: "ppl-navlog/profile-archive", formatVersion: 1, exportedAt: "2026-09-21T12:00:00.000Z", aircraftProfiles: Array.from({ length: MAX_PROFILES_PER_ARCHIVE + 1 }, aircraftProfile) };
    expect(() => parseNavlogArchive(JSON.stringify(tooManyProfiles), now)).toThrow(/at most/);
  });

  it("rejects non-serializable archive objects before export", () => {
    const circular = planArchive() as unknown as { self?: unknown };
    circular.self = circular;

    expect(() => serializeNavlogArchive(circular as never)).toThrow(/serializable JSON/);
  });
});
