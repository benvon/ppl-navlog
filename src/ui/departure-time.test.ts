import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDateTimeToUtcText, utcTextToLocalDateTime } from "./departure-time";

describe("departure time conversion", () => {
  const originalZone = process.env.TZ;
  beforeAll(() => { process.env.TZ = "America/Chicago"; });
  afterAll(() => { process.env.TZ = originalZone; });

  it("converts local evening across the UTC date boundary", () => {
    expect(localDateTimeToUtcText("2026-09-26T20:30")).toEqual({ ok: true, utcText: "2026-09-27T01:30" });
    expect(utcTextToLocalDateTime("2026-09-27T01:30")).toBe("2026-09-26T20:30");
  });

  it("rejects invalid and nonexistent local wall times", () => {
    expect(localDateTimeToUtcText("2026-02-30T12:00").ok).toBe(false);
    expect(localDateTimeToUtcText("2026-03-08T02:30")).toMatchObject({ ok: false });
  });

  it("rejects a repeated fall-back wall time instead of choosing an offset", () => {
    expect(localDateTimeToUtcText("2026-11-01T01:30")).toMatchObject({ ok: false });
  });

  it("does not reinterpret incomplete or invalid UTC text", () => {
    expect(utcTextToLocalDateTime("2026-09-27T01:")).toBeUndefined();
    expect(utcTextToLocalDateTime("2026-02-30T12:00")).toBeUndefined();
  });
});
