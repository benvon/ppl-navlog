import { describe, expect, it } from "vitest";
import { MAX_RECOVERY_ARCHIVE_BYTES, parsePlanRecoveryArchive, serializePlanRecoveryArchive } from "../json-transfer";
import { planRecoveryArchive } from "./fixtures";

describe("plan recovery snapshots", () => {
  const now = new Date("2027-01-01T00:00:00.000Z");

  it("round-trips one route and its selected aircraft profile", () => {
    const archive = planRecoveryArchive();

    expect(parsePlanRecoveryArchive(serializePlanRecoveryArchive(archive, now), now)).toEqual(archive);
  });

  it("rejects invalid envelopes, mismatched profiles, and oversized files", () => {
    const archive = planRecoveryArchive();
    expect(() => parsePlanRecoveryArchive("{", now)).toThrow(/valid JSON/);
    expect(() => parsePlanRecoveryArchive(JSON.stringify({ ...archive, format: "unsupported" }), now)).toThrow(/plan-recovery/);
    expect(() => parsePlanRecoveryArchive(JSON.stringify({ ...archive, formatVersion: 2 }), now)).toThrow(/formatVersion/);
    expect(() => parsePlanRecoveryArchive(JSON.stringify({ ...archive, draft: { ...archive.draft, selectedAircraftProfileId: "other-aircraft" } }), now)).toThrow(/must match aircraftProfile.id/);
    expect(() => parsePlanRecoveryArchive(" ".repeat(MAX_RECOVERY_ARCHIVE_BYTES + 1), now)).toThrow(/recovery archive limit/);
  });

  it("rejects non-object and incomplete recovery content before storage is reached", () => {
    const archive = planRecoveryArchive();

    expect(() => parsePlanRecoveryArchive("[]", now)).toThrow(/must be an object/);
    expect(() => parsePlanRecoveryArchive(JSON.stringify({ ...archive, exportedAt: "not-a-date" }), now)).toThrow(/ISO-8601/);
    expect(() => parsePlanRecoveryArchive(JSON.stringify({ ...archive, draft: undefined }), now)).toThrow(/draft.*must be an object/);
    expect(() => parsePlanRecoveryArchive(JSON.stringify({ ...archive, aircraftProfile: undefined }), now)).toThrow(/aircraftProfile.*must be an object/);
  });

  it("rejects non-serializable recovery snapshots before export", () => {
    const circular = planRecoveryArchive() as unknown as { self?: unknown };
    circular.self = circular;

    expect(() => serializePlanRecoveryArchive(circular as never, now)).toThrow(/serializable JSON/);
  });
});
