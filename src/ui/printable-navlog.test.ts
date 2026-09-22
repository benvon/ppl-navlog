import { describe, expect, it } from "vitest";
import { createCompleteFlightFixture } from "../test/fixtures/complete-flight";
import { createPrintableNavlog } from "./printable-navlog";

describe("one-way print/PDF output", () => {
  it("prints only the immutable complete revision with phase, weather, override, and fuel evidence", async () => {
    const fixture = await createCompleteFlightFixture();
    const before = JSON.stringify(fixture.revision);
    const sheet = createPrintableNavlog(fixture.revision, fixture.weatherSnapshots);
    expect(sheet?.querySelectorAll(".print-navlog-table tbody tr")).toHaveLength(5);
    expect(sheet?.textContent).toContain("Synthetic KORD → KJVL teaching flight");
    expect(sheet?.textContent).toContain("transition-climb");
    expect(sheet?.textContent).toContain("top-of-descent");
    expect(sheet?.textContent).toContain("Forecast valid (UTC)");
    expect(sheet?.textContent).toContain("OVERRIDDEN true-airspeed: 95.0 to 102.0");
    expect(sheet?.textContent).toContain("Required total9.70 gal");
    expect(sheet?.textContent).toContain("680 ft");
    expect(JSON.stringify(fixture.revision)).toBe(before);
  });

  it("refuses draft, infeasible, and missing-weather-evidence outputs", async () => {
    const fixture = await createCompleteFlightFixture();
    expect(createPrintableNavlog({ ...fixture.revision, calculationSnapshot: { status: "calculation-pending" } }, fixture.weatherSnapshots)).toBeUndefined();
    expect(createPrintableNavlog({ ...fixture.revision, calculationSnapshot: { schema: "complete-navlog/v1", status: "infeasible-phase-allocation" } }, fixture.weatherSnapshots)).toBeUndefined();
    expect(createPrintableNavlog(fixture.revision, [])).toBeUndefined();
  });

  it("treats imported text as text, not markup", async () => {
    const fixture = await createCompleteFlightFixture();
    const revision = { ...fixture.revision, draftSnapshot: { ...fixture.revision.draftSnapshot, title: "<img src=x onerror=alert(1)>" } };
    const sheet = createPrintableNavlog(revision, fixture.weatherSnapshots);
    expect(sheet?.querySelector("img")).toBeNull();
    expect(sheet?.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("includes saved weather warnings in the one-way output", async () => {
    const fixture = await createCompleteFlightFixture();
    const revision = { ...fixture.revision, warnings: ["Winds forecast was served from stale cache because the upstream refresh failed."] };
    const sheet = createPrintableNavlog(revision, fixture.weatherSnapshots);

    expect(sheet?.textContent).toContain("Planning warnings");
    expect(sheet?.textContent).toContain("stale cache");
  });
});
