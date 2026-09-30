import { describe, expect, it, vi } from "vitest";
import { coordinate } from "../domain/coordinates";
import { success } from "../domain/errors";
import { pointAlongGreatCircle } from "../domain/distance-course";
import { nauticalMiles, trueCourse } from "../domain/units";
import { wind } from "../domain/wind";
import { calculateWaypointWorksheet } from "./waypoint-worksheet";

const point = (latitude: number, longitude: number) => {
  const result = coordinate(latitude, longitude);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const makeRoute = (middlePosition = 40.3, secondAltitude = 4500, overrideTas?: number) => ({
  id: "route",
  points: [
    { kind: "airport" as const, id: "departure", icao: "KAAA", name: "Departure", coordinate: point(40, -100), elevationFeetMsl: 500 },
    { kind: "checkpoint" as const, id: "middle", name: "Middle", coordinate: point(middlePosition, -100) },
    { kind: "airport" as const, id: "destination", icao: "KBBB", name: "Destination", coordinate: point(40.6, -100), elevationFeetMsl: 600 },
  ],
  legs: [
    { id: "leg-1", fromPointId: "departure", toPointId: "middle", cruiseAltitudeFeetMsl: 4500 },
    { id: "leg-2", fromPointId: "middle", toPointId: "destination", cruiseAltitudeFeetMsl: secondAltitude,
      ...(overrideTas === undefined ? {} : { performanceOverrides: { cruiseTasKnots: { computedValue: 100, effectiveValue: overrideTas, origin: "pilot-input" as const, provenance: { sourceId: "pilot", sourceLabel: "Pilot TAS", recordedAt: "2026-06-01T00:00:00Z" } } } }) },
  ],
});
const routeWithCheckpoints = (checkpoints: readonly { id: string; name: string; latitude: number }[]) => {
  const points = [
    { kind: "airport" as const, id: "departure", icao: "KAAA", name: "Departure", coordinate: point(40, -100), elevationFeetMsl: 500 },
    ...checkpoints.map(({ id, name, latitude }) => ({ kind: "checkpoint" as const, id, name, coordinate: point(latitude, -100) })),
    { kind: "airport" as const, id: "destination", icao: "KBBB", name: "Destination", coordinate: point(40.6, -100), elevationFeetMsl: 600 },
  ];
  return { id: "route", points, legs: points.slice(1).map((to, index) => ({
    id: `leg-${index}`, fromPointId: points[index]!.id, toPointId: to.id, cruiseAltitudeFeetMsl: 4500,
  })) };
};
const profile = {
  schemaVersion: 1 as const, id: "profile", name: "Trainer", cruiseTasKnots: 100, cruiseFuelFlowGallonsPerHour: 8,
  climbRateFeetPerMinute: 500, climbTasKnots: 80, climbFuelFlowGallonsPerHour: 10,
  descentRateFeetPerMinute: 500, descentTasKnots: 90, descentFuelFlowGallonsPerHour: 6,
  usableFuelGallons: 30, compassDeviationTable: [{ magneticHeadingDegrees: 0, deviationDegrees: 0 }],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const calm = wind(0, 0);
const tailwind = wind(180, 20);
if (!calm.ok || !tailwind.ok) throw new Error("Invalid wind fixture.");
const input = (route = makeRoute()) => ({ route, profile, departureEstimatedUtc: "2026-06-01T12:00:00Z",
  fuelAboardGallons: 25, taxiRunupFuelGallons: 1, reserveFuelGallons: 5, descentTargetAltitudeFeetMsl: 1500,
  magneticVariationEastPositiveDegrees: 0, selectWeather: async () => success({ wind: calm.value, provenance: "sample" }) });

describe("calculateWaypointWorksheet", () => {
  it("rejects a checkpoint after TOD before row weather selection", async () => {
    const selector = vi.fn(async () => success({ wind: calm.value, provenance: "sample" }));
    const result = await calculateWaypointWorksheet({ ...input(makeRoute(40.58)), selectWeather: selector });
    expect(result).toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
    if (result.ok) return;
    expect(result.error.message).toContain('checkpoint 1, "Middle" is after estimated TOD');
    expect(result.error.message).toMatch(/remove or move each authored checkpoint between estimated TOC and TOD/i);
    expect(result.error.message).not.toContain("middle");
    expect(selector).toHaveBeenCalledTimes(2);
  });

  it("aggregates checkpoints before TOC and after TOD in route order", async () => {
    const selector = vi.fn(async () => success({ wind: calm.value, provenance: "sample" }));
    const route = routeWithCheckpoints([
      { id: "early", name: "Early checkpoint", latitude: 40.05 },
      { id: "middle", name: "Cruise checkpoint", latitude: 40.3 },
      { id: "late", name: "Late checkpoint", latitude: 40.55 },
    ]);
    const result = await calculateWaypointWorksheet({ ...input(route), selectWeather: selector });
    expect(result).toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
    if (result.ok) return;
    expect(result.error.message).toContain('checkpoint 1, "Early checkpoint" is before estimated TOC');
    expect(result.error.message).toContain('checkpoint 3, "Late checkpoint" is after estimated TOD');
    expect(result.error.message).not.toContain("early");
    expect(result.error.message).not.toContain("late");
    expect(selector).toHaveBeenCalledTimes(2);
  });

  it("allows authored checkpoints at estimated TOC and TOD", async () => {
    const baseline = await calculateWaypointWorksheet(input(makeRoute(40.3)));
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const toc = baseline.value.waypoints.find(({ kind }) => kind === "estimated-toc");
    const tod = baseline.value.waypoints.find(({ kind }) => kind === "estimated-tod");
    if (!toc || !tod) throw new Error("Missing estimated phase boundary fixture.");
    const route = {
      ...makeRoute(40.3),
      points: [
        { kind: "airport" as const, id: "departure", icao: "KAAA", name: "Departure", coordinate: point(40, -100), elevationFeetMsl: 500 },
        { kind: "checkpoint" as const, id: "at-toc", name: "At TOC", coordinate: toc.coordinate },
        { kind: "checkpoint" as const, id: "middle", name: "Middle", coordinate: point(40.3, -100) },
        { kind: "checkpoint" as const, id: "at-tod", name: "At TOD", coordinate: tod.coordinate },
        { kind: "airport" as const, id: "destination", icao: "KBBB", name: "Destination", coordinate: point(40.6, -100), elevationFeetMsl: 600 },
      ],
    };
    const legs = route.points.slice(1).map((to, index) => ({ id: `leg-${index}`, fromPointId: route.points[index]!.id, toPointId: to.id, cruiseAltitudeFeetMsl: 4500 }));
    const result = await calculateWaypointWorksheet(input({ ...route, legs }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.waypoints.map(({ id }) => id)).toEqual(expect.arrayContaining(["at-toc", "at-tod"]));
  });

  it("uses destination field elevation after a valid cruise checkpoint", async () => {
    const result = await calculateWaypointWorksheet(input(makeRoute(40.3)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.waypoints.some(({ id }) => id === "middle")).toBe(true);
    expect(result.value.rows.at(-1)?.plannedAltitudeFeetMsl).toBe(600);
    expect(result.value.waypoints.find(({ kind }) => kind === "estimated-tod")?.placement?.altitudeDifferenceFeet).toBe(3900);
  });

  it("uses explicit departure and destination weather for placement, with cruise altitude above field elevations", async () => {
    const selector = vi.fn(async () => success({ wind: calm.value, provenance: "callback" }));
    const result = await calculateWaypointWorksheet({ ...input(), departureWeather: { wind: calm.value, provenance: "METAR" }, destinationWeather: { wind: tailwind.value, provenance: "destination aloft" }, selectWeather: selector });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tod = result.value.waypoints.find(({ kind }) => kind === "estimated-tod");
    expect(tod?.placement?.planningWind).toEqual(tailwind.value);
    expect(tod?.placement?.estimatedDistanceNauticalMiles).toBeCloseTo((4500 - 600) / 500 * 110 / 60, 5);
    expect(selector).toHaveBeenCalled();
    expect(result.value.rows.every((row) => row.traces.windTriangle.result.name === "groundspeed")).toBe(true);
  });

  it("rejects changing route altitudes and invalid effective overrides before weather selection", async () => {
    const selector = vi.fn(async () => success({ wind: calm.value, provenance: "sample" }));
    const mismatch = await calculateWaypointWorksheet({ ...input(makeRoute(40.3, 6000)), selectWeather: selector });
    expect(mismatch.ok).toBe(false);
    expect(selector).not.toHaveBeenCalled();
    const invalidOverride = makeRoute(40.3, 4500, 0);
    const invalid = await calculateWaypointWorksheet({ ...input(invalidOverride), selectWeather: selector });
    expect(invalid.ok).toBe(false);
    expect(selector).not.toHaveBeenCalled();
  });

  it.each(["departure", "destination"] as const)("rejects a non-finite %s field elevation before weather selection", async (endpoint) => {
    const route = makeRoute();
    const points = route.points.map((point) => point.id === endpoint
      ? { ...point, elevationFeetMsl: Number.NaN }
      : point);
    const selector = vi.fn(async () => success({ wind: calm.value, provenance: "sample" }));
    const result = await calculateWaypointWorksheet({ ...input(), route: { ...route, points }, selectWeather: selector });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_NUMBER" } });
    expect(selector).not.toHaveBeenCalled();
  });

  it("rejects duplicate normalized compass deviation headings before weather selection", async () => {
    const selector = vi.fn(async () => success({ wind: calm.value, provenance: "sample" }));
    const result = await calculateWaypointWorksheet({ ...input(), profile: { ...profile, compassDeviationTable: [
      { magneticHeadingDegrees: 0, deviationDegrees: 1 }, { magneticHeadingDegrees: 360, deviationDegrees: 2 },
    ] }, selectWeather: selector });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_DEVIATION_TABLE" } });
    expect(selector).not.toHaveBeenCalled();
  });

  it("applies a checkpoint outbound performance override to its first positive cruise row", async () => {
    const result = await calculateWaypointWorksheet(input(makeRoute(40.3, 4500, 75)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.find(({ phase, startWaypoint }) => phase === "cruise" && startWaypoint.id === "middle")?.trueAirspeedKnots).toBe(75);
  });

  it("keeps checkpoint weather local to its outgoing row", async () => {
    const checkpointWind = wind(180, 20);
    if (!checkpointWind.ok) throw new Error(checkpointWind.error.message);
    const result = await calculateWaypointWorksheet({ ...input(), selectWeather: async (waypoint) => success({
      wind: waypoint.id === "middle" ? checkpointWind.value : calm.value, provenance: waypoint.id,
    }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prior = result.value.rows.find(({ endWaypoint }) => endWaypoint.id === "middle");
    const outgoing = result.value.rows.find(({ startWaypoint }) => startWaypoint.id === "middle");
    expect(prior?.provenance.weather).not.toBe("middle");
    expect(outgoing?.provenance.weather).toBe("middle");
    expect(outgoing?.wind).toEqual(checkpointWind.value);
  });

  it("preserves exhausted fuel and blocks overfill and unavailable weather cleanly", async () => {
    const selector = vi.fn(async () => success({ wind: calm.value, provenance: "sample" }));
    const empty = await calculateWaypointWorksheet({ ...input(), fuelAboardGallons: 0, taxiRunupFuelGallons: 0, reserveFuelGallons: 0, selectWeather: selector });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value.fuelShortage).toBe(true);
    selector.mockClear();
    const overfill = await calculateWaypointWorksheet({ ...input(), fuelAboardGallons: 31, selectWeather: selector });
    expect(overfill.ok).toBe(false);
    expect(selector).not.toHaveBeenCalled();
    const unavailable = await calculateWaypointWorksheet({ ...input(), selectWeather: async () => ({ ok: false as const, error: { code: "UNSUPPORTED_WIND_ALTITUDE" as const, message: "No forecast." } }) });
    expect(unavailable.ok).toBe(false);
  });

  it("rejects an authored checkpoint before TOC even when the route revisits its coordinate later", async () => {
    const departure = point(40, -100);
    const north = trueCourse(0);
    const d10 = nauticalMiles(10);
    const d30 = nauticalMiles(30);
    if (!north.ok || !d10.ok || !d30.ok) throw new Error("Invalid geometry fixture.");
    const dPrior = nauticalMiles(9.33);
    const repeated = pointAlongGreatCircle(departure, north.value, d10.value);
    if (!dPrior.ok) throw new Error("Invalid prior-visit distance.");
    const prior = pointAlongGreatCircle(departure, north.value, dPrior.value);
    const end = pointAlongGreatCircle(departure, north.value, d30.value);
    if (!repeated.ok || !prior.ok || !end.ok) throw new Error("Invalid route fixture.");
    const route = { id: "repeated", points: [
      { kind: "airport" as const, id: "departure", icao: "KAAA", name: "Departure", coordinate: departure, elevationFeetMsl: 500 },
      { kind: "checkpoint" as const, id: "prior", name: "Prior visit", coordinate: prior.value },
      { kind: "checkpoint" as const, id: "turn", name: "Turn", coordinate: repeated.value },
      { kind: "checkpoint" as const, id: "second", name: "Second visit", coordinate: prior.value },
      { kind: "airport" as const, id: "destination", icao: "KBBB", name: "Destination", coordinate: end.value, elevationFeetMsl: 600 },
    ], legs: ["departure:prior", "prior:turn", "turn:second", "second:destination"].map((pair, index) => { const [fromPointId, toPointId] = pair.split(":"); return { id: `leg-${index}`, fromPointId: fromPointId!, toPointId: toPointId!, cruiseAltitudeFeetMsl: 4500 }; }) };
    const result = await calculateWaypointWorksheet(input(route));
    expect(result).toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
    if (!result.ok) expect(result.error.message).toContain('checkpoint 1, "Prior visit" is before estimated TOC');
  });
});
