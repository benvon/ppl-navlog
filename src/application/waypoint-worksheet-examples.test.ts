import { describe, expect, it } from "vitest";
import { coordinate } from "../domain/coordinates";
import { pointAlongGreatCircle } from "../domain/distance-course";
import { nauticalMiles, trueCourse } from "../domain/units";
import { success } from "../domain/errors";
import { wind } from "../domain/wind";
import { calculateWaypointWorksheet } from "./waypoint-worksheet";

const start = coordinate(0, 0);
const east = trueCourse(90);
const calm = wind(0, 0);
if (!start.ok || !east.ok || !calm.ok) throw new Error("Invalid synthetic planning fixture.");

const at = (distance: number) => {
  const checked = nauticalMiles(distance);
  if (!checked.ok) throw new Error(checked.error.message);
  const located = pointAlongGreatCircle(start.value, east.value, checked.value);
  if (!located.ok) throw new Error(located.error.message);
  return located.value;
};

const profile = {
  schemaVersion: 1 as const, id: "synthetic", name: "Synthetic example",
  climbRateFeetPerMinute: 500, climbTasKnots: 60, climbFuelFlowGallonsPerHour: 10,
  cruiseTasKnots: 120, cruiseFuelFlowGallonsPerHour: 8,
  descentRateFeetPerMinute: 500, descentTasKnots: 90, descentFuelFlowGallonsPerHour: 6,
  compassDeviationTable: [{ magneticHeadingDegrees: 0, deviationDegrees: 0 }],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

const route = (distances: readonly number[]) => ({
  id: "synthetic-route",
  points: distances.map((distance, index) => index === 0 || index === distances.length - 1 ? {
    kind: "airport" as const, id: `p${index}`, icao: index === 0 ? "KAAA" : "KBBB",
    name: index === 0 ? "Departure" : "Destination", coordinate: at(distance),
    elevationFeetMsl: index === 0 ? 2000 : 1000,
  } : { kind: "checkpoint" as const, id: `p${index}`, name: `Checkpoint ${index}`, coordinate: at(distance) }),
  legs: distances.slice(1).map((_distance, index) => ({
    id: `leg${index}`, fromPointId: `p${index}`, toPointId: `p${index + 1}`, cruiseAltitudeFeetMsl: 5000,
  })),
});

const calculate = (distances: readonly number[], fuelAboard: number, reserve: number, utc: string) => calculateWaypointWorksheet({
  route: route(distances), profile, departureEstimatedUtc: utc,
  fuelAboardGallons: fuelAboard, taxiRunupFuelGallons: 0.5, reserveFuelGallons: reserve,
  descentTargetAltitudeFeetMsl: 1000, magneticVariationEastPositiveDegrees: 0,
  selectWeather: async () => success({ wind: calm.value, provenance: "synthetic-calm" }),
});

describe("waypoint worksheet contract examples", () => {
  it("rejects weather whose validity does not cover the estimated waypoint UTC", async () => {
    const result = await calculateWaypointWorksheet({
      route: route([0, 60]), profile, departureEstimatedUtc: "2026-06-01T14:00:00Z",
      fuelAboardGallons: 20, taxiRunupFuelGallons: 0.5, reserveFuelGallons: 3,
      descentTargetAltitudeFeetMsl: 1000, magneticVariationEastPositiveDegrees: 0,
      selectWeather: async () => success({ wind: calm.value, provenance: "expired-forecast", validToUtc: "2026-06-01T13:00:00Z" }),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "FORECAST_OUTSIDE_VALIDITY" } });
  });

  it("uses the outbound authored leg override after TOC shares a checkpoint", async () => {
    const authored = route([0, 6, 60]);
    const overridden = {
      ...authored,
      legs: authored.legs.map((leg, index) => index < 2 ? {
        ...leg,
        performanceOverrides: { cruiseTasKnots: {
          computedValue: 120, effectiveValue: index === 0 ? 90 : 100, origin: "pilot-input" as const,
          provenance: { sourceId: `pilot-${index}`, sourceLabel: `Pilot leg ${index + 1} TAS`, recordedAt: "2026-06-01T00:00:00Z" },
        } },
    } : leg),
    };
    const result = await calculateWaypointWorksheet({
      route: overridden, profile, departureEstimatedUtc: "2026-06-01T14:00:00Z",
      fuelAboardGallons: 20, taxiRunupFuelGallons: 0.5, reserveFuelGallons: 3,
      descentTargetAltitudeFeetMsl: 1000, magneticVariationEastPositiveDegrees: 0,
      selectWeather: async () => success({ wind: calm.value, provenance: "synthetic-calm" }),
    });
    if (!result.ok) throw new Error(result.error.message);
    const firstCruise = result.value.rows.find(({ phase }) => phase === "cruise");
    expect(["estimated-toc", "pilot-checkpoint"]).toContain(firstCruise?.startWaypoint.kind);
    expect(firstCruise?.trueAirspeedKnots).toBe(100);
    expect(firstCruise?.provenance.performanceInputs?.trueAirspeed.origin).toBe("pilot-input");
  });

  it("advances the 60 NM route through TOC, two checkpoints, TOD, and destination", async () => {
    const result = await calculate([0, 20, 40, 60], 20, 3, "2026-06-01T14:00:00Z");
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.rows.map(({ phase }) => phase)).toEqual(["climb", "cruise", "cruise", "cruise", "descent"]);
    expect(result.value.waypoints.find(({ kind }) => kind === "estimated-toc")?.routeDistanceNauticalMiles).toBeCloseTo(6, 8);
    expect(result.value.waypoints.find(({ kind }) => kind === "estimated-tod")?.routeDistanceNauticalMiles).toBeCloseTo(48, 8);
    expect(result.value.rows.at(-1)?.cumulativeEstimatedMinutes).toBeCloseTo(35, 8);
    expect(result.value.estimatedArrivalFuelGallons).toBeCloseTo(14.9, 8);
  });

  it("keeps the short positive cruise interval and reports a fuel shortfall", async () => {
    const result = await calculate([0, 9, 24], 3, 1, "2026-06-01T16:00:00Z");
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.waypoints.find(({ kind }) => kind === "estimated-tod")?.routeDistanceNauticalMiles).toBeCloseTo(12, 8);
    expect(result.value.rows.at(-1)?.cumulativeEstimatedMinutes).toBeCloseTo(17, 8);
    expect(result.value.estimatedArrivalFuelGallons).toBeCloseTo(0.3, 8);
    expect(result.value.fuelShortage).toBe(true);
  });

  it("stops when TOC at 6 NM would follow TOD at 2 NM on a 14 NM route", async () => {
    const result = await calculate([0, 14], 20, 3, "2026-06-01T14:00:00Z");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ROUTE_GEOMETRY_ERROR");
    expect(result.error.message).toMatch(/TOC|TOD/);
  });
});
