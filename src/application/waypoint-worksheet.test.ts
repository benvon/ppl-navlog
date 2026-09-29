import { describe, expect, it, vi } from "vitest";
import { coordinate } from "../domain/coordinates";
import { success } from "../domain/errors";
import { pointAlongGreatCircle } from "../domain/distance-course";
import { nauticalMiles, trueCourse } from "../domain/units";
import { wind } from "../domain/wind";
import { calculateWaypointWorksheet } from "./waypoint-worksheet";
import { preparePilotRoute } from "./waypoint-preparation";

const point = (latitude: number, longitude: number) => {
  const result = coordinate(latitude, longitude);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const makeRoute = (middlePosition: number | ReturnType<typeof point> = 40.3, finalCruiseAltitude = 4500) => ({
  id: "route",
  points: [
    { kind: "airport" as const, id: "departure", icao: "KAAA", name: "Departure", coordinate: point(40, -100), elevationFeetMsl: 500 },
    { kind: "checkpoint" as const, id: "middle", name: "Middle", coordinate: typeof middlePosition === "number" ? point(middlePosition, -100) : middlePosition },
    { kind: "airport" as const, id: "destination", icao: "KBBB", name: "Destination", coordinate: point(40.6, -100), elevationFeetMsl: 600 },
  ],
  legs: [
    { id: "leg-1", fromPointId: "departure", toPointId: "middle", cruiseAltitudeFeetMsl: 4500 },
    { id: "leg-2", fromPointId: "middle", toPointId: "destination", cruiseAltitudeFeetMsl: finalCruiseAltitude },
  ],
});

const profile = {
  schemaVersion: 1 as const, id: "profile", name: "Trainer", cruiseTasKnots: 100, cruiseFuelFlowGallonsPerHour: 8,
  climbRateFeetPerMinute: 500, climbTasKnots: 80, climbFuelFlowGallonsPerHour: 10,
  descentRateFeetPerMinute: 500, descentTasKnots: 90, descentFuelFlowGallonsPerHour: 6,
  usableFuelGallons: 30, compassDeviationTable: [{ magneticHeadingDegrees: 0, deviationDegrees: 0 }],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

const calmWind = wind(0, 0);
if (!calmWind.ok) throw new Error(calmWind.error.message);

describe("calculateWaypointWorksheet", () => {
  it("selects waypoint weather at carried UTC and uses each sample only for the following row", async () => {
    const selected: string[] = [];
    const result = await calculateWaypointWorksheet({
      route: makeRoute(),
      profile,
      departureEstimatedUtc: "2026-06-01T12:00:00Z",
      fuelAboardGallons: 25,
      taxiRunupFuelGallons: 1,
      reserveFuelGallons: 5,
      descentTargetAltitudeFeetMsl: 1500,
      magneticVariationEastPositiveDegrees: 0,
      selectWeather: async (waypoint, estimatedUtc) => {
        selected.push(`${waypoint.id}:${estimatedUtc}`);
        return success({ wind: calmWind.value, provenance: `sample:${waypoint.id}` });
      },
    });

    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.ok).toBe(true);
    expect(result.value.rows.length).toBeGreaterThan(0);
    expect(result.value.rows[0]?.startWaypoint.id).toBe("departure");
    expect(selected[0]).toBe("departure:2026-06-01T12:00:00Z");
    expect(result.value.rows.every((row) => row.startingEstimatedUtc !== undefined)).toBe(true);
  });

  it("stops at an unavailable required waypoint wind", async () => {
    const selector = vi.fn(async () => ({ ok: false as const, error: { code: "UNSUPPORTED_WIND_ALTITUDE" as const, message: "No forecast wind." } }));
    const result = await calculateWaypointWorksheet({
      route: makeRoute(),
      profile,
      departureEstimatedUtc: "2026-06-01T12:00:00Z",
      fuelAboardGallons: 25,
      taxiRunupFuelGallons: 1,
      reserveFuelGallons: 5,
      descentTargetAltitudeFeetMsl: 1500,
      magneticVariationEastPositiveDegrees: 0,
      selectWeather: selector,
    });

    expect(result.ok).toBe(false);
    expect(selector).toHaveBeenCalledTimes(1);
  });

  it("blocks an unusable wind triangle at the waypoint that selected the wind", async () => {
    const headwind = wind(0, 80);
    if (!headwind.ok) throw new Error(headwind.error.message);
    const selector = vi.fn(async () => success({ wind: headwind.value, provenance: "impossible climb headwind" }));
    const result = await calculateWaypointWorksheet({
      route: makeRoute(), profile, departureEstimatedUtc: "2026-06-01T12:00:00Z",
      fuelAboardGallons: 25, taxiRunupFuelGallons: 1, reserveFuelGallons: 5,
      descentTargetAltitudeFeetMsl: 1500, magneticVariationEastPositiveDegrees: 0, selectWeather: selector,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["NONPOSITIVE_GROUNDSPEED", "INVALID_WIND_TRIANGLE"]).toContain(result.error.code);
    expect(selector).toHaveBeenCalledTimes(1);
  });

  it("keeps an early pilot checkpoint and ignores its outbound altitude selection until TOC", async () => {
    const result = await calculateWaypointWorksheet({
      route: makeRoute(40.02, 6000), profile, departureEstimatedUtc: "2026-06-01T12:00:00Z",
      fuelAboardGallons: 25, taxiRunupFuelGallons: 1, reserveFuelGallons: 5,
      descentTargetAltitudeFeetMsl: 1500, magneticVariationEastPositiveDegrees: 0,
      selectWeather: async () => success({ wind: calmWind.value, provenance: "sample" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.waypoints.some(({ id }) => id === "middle")).toBe(true);
    expect(result.value.warnings.some((warning) => warning.includes("before estimated TOC"))).toBe(true);
    expect(result.value.waypoints.filter(({ kind }) => kind === "estimated-transition-end")).toHaveLength(0);
  });

  it("places an outbound altitude transition at a post-TOC checkpoint and resumes cruise after it", async () => {
    const result = await calculateWaypointWorksheet({
      route: makeRoute(40.3, 6000), profile, departureEstimatedUtc: "2026-06-01T12:00:00Z",
      fuelAboardGallons: 25, taxiRunupFuelGallons: 1, reserveFuelGallons: 5,
      descentTargetAltitudeFeetMsl: 1500, magneticVariationEastPositiveDegrees: 0,
      selectWeather: async () => success({ wind: calmWind.value, provenance: "sample" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const transition = result.value.rows.find((row) => row.phase === "transition-climb");
    expect(transition?.startWaypoint.id).toBe("middle");
    expect(transition?.endWaypoint.kind).toBe("estimated-transition-end");
    expect(result.value.rows.some((row) => row.startWaypoint.kind === "estimated-transition-end" && row.phase === "cruise")).toBe(true);
  });

  it("carries a coincident TOC checkpoint selection across the zero-distance boundary", async () => {
    const start = point(40, -100);
    const north = trueCourse(0);
    const climbDistance = nauticalMiles((4500 - 500) / 500 * 80 / 60);
    if (!north.ok || !climbDistance.ok) throw new Error("Invalid TOC coincidence fixture.");
    const checkpoint = pointAlongGreatCircle(start, north.value, climbDistance.value);
    if (!checkpoint.ok) throw new Error(checkpoint.error.message);
    const selected: string[] = [];
    const result = await calculateWaypointWorksheet({
      route: makeRoute(checkpoint.value, 6000), profile, departureEstimatedUtc: "2026-06-01T12:00:00Z",
      fuelAboardGallons: 25, taxiRunupFuelGallons: 1, reserveFuelGallons: 5,
      descentTargetAltitudeFeetMsl: 1500, magneticVariationEastPositiveDegrees: 0,
      selectWeather: async (waypoint) => {
        selected.push(waypoint.id);
        return success({ wind: calmWind.value, provenance: waypoint.id });
      },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.ok).toBe(true);
    expect(result.value.waypoints.find(({ kind }) => kind === "estimated-toc")?.routeDistanceNauticalMiles).toBeCloseTo(
      result.value.waypoints.find(({ id }) => id === "middle")?.routeDistanceNauticalMiles ?? -100, 3,
    );
    expect(result.value.rows.some((row) => row.phase === "transition-climb")).toBe(true);
    expect(selected.filter((id) => id === "middle")).toHaveLength(1);
  });

  it("applies a checkpoint's outbound selection after a coincident transition-end boundary", async () => {
    const start = point(40, -100);
    const north = trueCourse(0);
    const offsets = [0, 30, 31 + 1 / 3, 60].map((value) => nauticalMiles(value));
    if (!north.ok) throw new Error("Invalid transition-end coincidence course.");
    const positions = offsets.map((offset) => {
      if (!offset.ok) throw new Error("Invalid transition-end coincidence distance.");
      const position = pointAlongGreatCircle(start, north.value, offset.value);
      if (!position.ok) throw new Error(position.error.message);
      return position.value;
    });
    const route = {
      id: "transition-end-coincidence-route",
      points: [
        { kind: "airport" as const, id: "departure", icao: "KAAA", name: "Departure", coordinate: positions[0]!, elevationFeetMsl: 2000 },
        { kind: "checkpoint" as const, id: "first", name: "First", coordinate: positions[1]! },
        { kind: "checkpoint" as const, id: "second", name: "Second", coordinate: positions[2]! },
        { kind: "airport" as const, id: "destination", icao: "KBBB", name: "Destination", coordinate: positions[3]!, elevationFeetMsl: 1000 },
      ],
      legs: [
        { id: "leg-1", fromPointId: "departure", toPointId: "first", cruiseAltitudeFeetMsl: 5000 },
        { id: "leg-2", fromPointId: "first", toPointId: "second", cruiseAltitudeFeetMsl: 5500 },
        { id: "leg-3", fromPointId: "second", toPointId: "destination", cruiseAltitudeFeetMsl: 5500 },
      ],
    };
    const result = await calculateWaypointWorksheet({
      route, profile, departureEstimatedUtc: "2026-06-01T12:00:00Z",
      fuelAboardGallons: 25, taxiRunupFuelGallons: 1, reserveFuelGallons: 5,
      descentTargetAltitudeFeetMsl: 1000, magneticVariationEastPositiveDegrees: 0,
      selectWeather: async () => success({ wind: calmWind.value, provenance: "sample" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const endingAtCheckpoint = result.value.rows.find((row) => row.endWaypoint.id === "second");
    expect(endingAtCheckpoint?.phase).toBe("transition-climb");
    const endingIndex = endingAtCheckpoint === undefined ? -1 : result.value.rows.indexOf(endingAtCheckpoint);
    const nextPositiveRow = result.value.rows[endingIndex + 1];
    expect(nextPositiveRow?.startWaypoint.routeDistanceNauticalMiles).toBeCloseTo(
      result.value.waypoints.find(({ id }) => id === "second")?.routeDistanceNauticalMiles ?? -100, 8,
    );
    expect(nextPositiveRow?.phase).toBe("cruise");
    expect(nextPositiveRow?.plannedAltitudeFeetMsl).toBe(5500);
  });

  it("places final TOD once from the post-transition cruise waypoint's selected wind", async () => {
    const start = point(40, -100);
    const north = trueCourse(0);
    const to30 = nauticalMiles(30);
    const to60 = nauticalMiles(60);
    if (!north.ok || !to30.ok || !to60.ok) throw new Error("Invalid transition fixture geometry.");
    const checkpoint = pointAlongGreatCircle(start, north.value, to30.value);
    const destination = pointAlongGreatCircle(start, north.value, to60.value);
    if (!checkpoint.ok || !destination.ok) throw new Error("Invalid transition fixture positions.");
    const route = {
      id: "transition-route",
      points: [
        { kind: "airport" as const, id: "departure", icao: "KAAA", name: "Departure", coordinate: start, elevationFeetMsl: 2000 },
        { kind: "checkpoint" as const, id: "checkpoint", name: "Checkpoint", coordinate: checkpoint.value },
        { kind: "airport" as const, id: "destination", icao: "KBBB", name: "Destination", coordinate: destination.value, elevationFeetMsl: 1000 },
      ],
      legs: [
        { id: "leg-1", fromPointId: "departure", toPointId: "checkpoint", cruiseAltitudeFeetMsl: 5000 },
        { id: "leg-2", fromPointId: "checkpoint", toPointId: "destination", cruiseAltitudeFeetMsl: 6000 },
      ],
    };
    const prepared = preparePilotRoute(route);
    if (!prepared.ok) throw new Error(prepared.error.message);
    const tailwind = wind(180, 20);
    if (!tailwind.ok) throw new Error(tailwind.error.message);
    const selected: string[] = [];
    const result = await calculateWaypointWorksheet({
      route, profile, departureEstimatedUtc: "2026-06-01T12:00:00Z",
      fuelAboardGallons: 25, taxiRunupFuelGallons: 1, reserveFuelGallons: 5,
      descentTargetAltitudeFeetMsl: 1000, magneticVariationEastPositiveDegrees: 0,
      selectWeather: async (waypoint) => {
        selected.push(waypoint.id);
        return success({ wind: waypoint.kind === "estimated-transition-end" ? tailwind.value : calmWind.value, provenance: waypoint.id });
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tod = result.value.waypoints.find(({ kind }) => kind === "estimated-tod");
    expect(tod?.routeDistanceNauticalMiles).toBeCloseTo(prepared.value.totalRouteDistanceNauticalMiles - (5000 / 500) * 110 / 60, 3);
    expect(selected.filter((id) => id === "transition-end:checkpoint")).toHaveLength(1);
  });

  it("shares one state and weather selection when TOD coincides with a checkpoint", async () => {
    const baseRoute = makeRoute();
    const course = trueCourse(180);
    const offset = nauticalMiles(13.5);
    if (!course.ok || !offset.ok) throw new Error("Invalid generated test geometry.");
    const middle = pointAlongGreatCircle(baseRoute.points.at(-1)!.coordinate, course.value, offset.value);
    if (!middle.ok) throw new Error(middle.error.message);
    const selected: string[] = [];
    const result = await calculateWaypointWorksheet({
      route: makeRoute(middle.value, 6000), profile, departureEstimatedUtc: "2026-06-01T12:00:00Z",
      fuelAboardGallons: 25, taxiRunupFuelGallons: 1, reserveFuelGallons: 5,
      descentTargetAltitudeFeetMsl: 1500, magneticVariationEastPositiveDegrees: 0,
      selectWeather: async (waypoint) => {
        selected.push(waypoint.id);
        return success({ wind: calmWind.value, provenance: `sample:${waypoint.id}` });
      },
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.waypoints.filter(({ kind }) => kind === "estimated-tod")).toHaveLength(1);
    expect(result.value.waypoints.filter(({ kind }) => kind === "estimated-transition-end")).toHaveLength(0);
    expect(result.value.rows.find((row) => row.phase === "descent")?.startWaypoint.kind).toBe("estimated-tod");
    expect(selected.filter((id) => id === "middle")).toHaveLength(1);
  });

  it("places TOD before the last leg and uses TOD weather only for descent", async () => {
    const samples: Array<{ id: string; utc: string }> = [];
    const result = await calculateWaypointWorksheet({
      route: makeRoute(), profile, departureEstimatedUtc: "2026-06-01T12:00:00Z",
      fuelAboardGallons: 25, taxiRunupFuelGallons: 1, reserveFuelGallons: 5,
      descentTargetAltitudeFeetMsl: 1500, magneticVariationEastPositiveDegrees: -8,
      selectWeather: async (waypoint, utc) => {
        samples.push({ id: waypoint.id, utc });
        return success({ wind: calmWind.value, provenance: `sample:${waypoint.id}` });
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const descent = result.value.rows.find((row) => row.phase === "descent");
    expect(descent?.startWaypoint.kind).toBe("estimated-tod");
    expect(descent?.provenance.weather).toBe("sample:estimated-tod");
    expect(result.value.rows.find((row) => row.endWaypoint.kind === "estimated-tod")?.phase).toBe("cruise");
    expect(samples.filter(({ id }) => id === "estimated-tod")).toHaveLength(1);
  });

  it("stops before another row or TOD weather when TOD falls before the final pilot waypoint", async () => {
    const samples: string[] = [];
    const result = await calculateWaypointWorksheet({
      route: makeRoute(40.5), profile, departureEstimatedUtc: "2026-06-01T12:00:00Z",
      fuelAboardGallons: 25, taxiRunupFuelGallons: 1, reserveFuelGallons: 5,
      descentTargetAltitudeFeetMsl: 1500, magneticVariationEastPositiveDegrees: 0,
      selectWeather: async (waypoint) => {
        samples.push(waypoint.id);
        return success({ wind: calmWind.value, provenance: `sample:${waypoint.id}` });
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ROUTE_GEOMETRY_ERROR");
    expect(result.error.message).toContain("before final waypoint Middle");
    expect(samples).not.toContain("estimated-tod");
  });

  it("retains zero fuel as a calculated exhausted balance and blocks capacity overfill before weather", async () => {
    const selector = vi.fn(async (_waypoint: unknown, _utc: string, _altitude: number) => success({ wind: calmWind.value, provenance: "sample" }));
    const exhausted = await calculateWaypointWorksheet({
      route: makeRoute(), profile, departureEstimatedUtc: "2026-06-01T12:00:00Z",
      fuelAboardGallons: 0, taxiRunupFuelGallons: 0, reserveFuelGallons: 0,
      descentTargetAltitudeFeetMsl: 1500, magneticVariationEastPositiveDegrees: 0, selectWeather: selector,
    });
    expect(exhausted.ok).toBe(true);
    if (exhausted.ok) expect(exhausted.value.fuelShortage).toBe(true);
    selector.mockClear();
    const overfilled = await calculateWaypointWorksheet({
      route: makeRoute(), profile, departureEstimatedUtc: "2026-06-01T12:00:00Z",
      fuelAboardGallons: 31, taxiRunupFuelGallons: 0, reserveFuelGallons: 0,
      descentTargetAltitudeFeetMsl: 1500, magneticVariationEastPositiveDegrees: 0, selectWeather: selector,
    });
    expect(overfilled.ok).toBe(false);
    expect(selector).not.toHaveBeenCalled();
  });
});
