import { describe, expect, it } from "vitest";
import { coordinate } from "../domain/coordinates";
import { deviationTablePoint } from "../domain/deviation";
import { wind } from "../domain/wind";
import type { PreparedWaypoint } from "./waypoint-preparation";
import { calculateWaypointWorksheetRow, type WaypointWorksheetRowInput } from "./waypoint-worksheet-row";

const point = (id: string, latitude: number, longitude: number): PreparedWaypoint => {
  const checked = coordinate(latitude, longitude);
  if (!checked.ok) throw new Error(checked.error.message);
  return {
    id,
    kind: id === "start" ? "departure" : "destination",
    label: id,
    coordinate: checked.value,
    routeDistanceNauticalMiles: id === "start" ? 0 : 60.0405,
  };
};

const baseInput = (): WaypointWorksheetRowInput => {
  const selectedWind = wind(0, 0);
  if (!selectedWind.ok) throw new Error(selectedWind.error.message);
  const deviationAtNorth = deviationTablePoint(0, 0);
  const deviationAtSouth = deviationTablePoint(180, 18);
  if (!deviationAtNorth.ok || !deviationAtSouth.ok) throw new Error("Test deviation table is invalid.");
  return {
    startWaypoint: point("start", 0, 0),
    endWaypoint: point("end", 0, 1),
    phase: "cruise",
    plannedAltitudeFeetMsl: 5000,
    trueAirspeedKnots: 120,
    fuelFlowGallonsPerHour: 12,
    wind: selectedWind.value,
    magneticVariationEastPositiveDegrees: 10,
    deviationTable: [deviationAtNorth.value, deviationAtSouth.value],
    startingEstimatedUtc: "2026-09-29T23:45:00.000Z",
    startingFuelGallons: 10,
    cumulativeEstimatedMinutes: 90,
    cumulativeFuelUsedGallons: 2,
    weatherProvenance: "selected forecast at start waypoint",
  };
};

describe("calculateWaypointWorksheetRow", () => {
  it("calculates one endpoint-based row and carries unrounded totals across midnight", () => {
    const result = calculateWaypointWorksheetRow(baseInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.distanceNauticalMiles).toBe(60.0405);
    expect(result.value.trueCourseDegrees).toBeCloseTo(90, 8);
    expect(result.value.windCorrectionAngleDegrees).toBeCloseTo(0, 8);
    expect(result.value.groundspeedKnots).toBeCloseTo(120, 8);
    expect(result.value.estimatedTimeEnrouteMinutes).toBeCloseTo(30.02025, 3);
    expect(result.value.estimatedFuelGallons).toBeCloseTo(6.00405, 3);
    expect(result.value.trueHeadingDegrees).toBeCloseTo(90, 8);
    expect(result.value.magneticHeadingDegrees).toBeCloseTo(80, 8);
    expect(result.value.compassHeadingDegrees).toBeCloseTo(72, 8);
    expect(result.value.endingEstimatedUtc).toBe("2026-09-30T00:15:01.215Z");
    expect(result.value.endingFuelGallons).toBeCloseTo(3.99595, 3);
    expect(result.value.cumulativeEstimatedMinutes).toBeCloseTo(120.02025, 3);
    expect(result.value.cumulativeFuelUsedGallons).toBeCloseTo(8.00405, 3);
    expect(result.value.provenance.compassDeviationEastPositiveDegrees).toBeCloseTo(8, 8);
    expect(result.value.provenance.weather).toBe("selected forecast at start waypoint");
  });

  it("preserves a wind-triangle failure instead of inventing a usable row", () => {
    const input = baseInput();
    const impossibleWind = wind(0, 121);
    if (!impossibleWind.ok) throw new Error(impossibleWind.error.message);

    const result = calculateWaypointWorksheetRow({ ...input, wind: impossibleWind.value });

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_WIND_TRIANGLE" } });
  });

  it("rejects invalid UTC and zero route distance", () => {
    const input = baseInput();
    expect(calculateWaypointWorksheetRow({ ...input, startingEstimatedUtc: "2026-02-30T12:00:00.000Z" }))
      .toMatchObject({ ok: false, error: { code: "INVALID_NUMBER" } });
    expect(calculateWaypointWorksheetRow({
      ...input,
      endWaypoint: { ...input.endWaypoint, routeDistanceNauticalMiles: input.startWaypoint.routeDistanceNauticalMiles },
    })).toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
  });

  it("keeps a negative estimated fuel balance visible as a valid row result", () => {
    const result = calculateWaypointWorksheetRow({ ...baseInput(), startingFuelGallons: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.endingFuelGallons).toBeLessThan(0);
  });
});
