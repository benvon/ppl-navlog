import { failure, propagateFailure, success, type DomainResult } from "../domain/errors";
import type { AircraftProfile } from "../domain/aircraft";
import { deviationTablePoint } from "../domain/deviation";
import { equalWithinArithmeticRoundoff } from "../domain/arithmetic-roundoff";
import type { RouteDefinition } from "../domain/route";
import { wind, type Wind } from "../domain/wind";
import {
  estimateSingleCourseForwardWaypoint, estimateTopOfDescent, orderPreparedWaypoints, preparePilotRoute,
  type PreparedPilotRoute, type PreparedWaypoint,
} from "./waypoint-preparation";
import { calculateWaypointWorksheetRow, type WaypointWorksheetPhase, type WaypointWorksheetRow } from "./waypoint-worksheet-row";

export interface WaypointWorksheetWeather {
  readonly wind: Wind;
  readonly provenance: string;
  readonly validFromUtc?: string;
  readonly validToUtc?: string;
}

export interface WaypointWorksheetInput {
  readonly route: RouteDefinition | PreparedPilotRoute;
  readonly profile: AircraftProfile;
  readonly departureEstimatedUtc: string;
  readonly fuelAboardGallons: number;
  readonly taxiRunupFuelGallons: number;
  readonly reserveFuelGallons: number;
  /** Retained for old callers; destination airport field elevation is authoritative. */
  readonly descentTargetAltitudeFeetMsl: number;
  readonly magneticVariationEastPositiveDegrees: number;
  readonly departureWeather?: WaypointWorksheetWeather;
  readonly destinationWeather?: WaypointWorksheetWeather;
  readonly magneticVariationAt?: (waypoint: PreparedWaypoint) => number;
  readonly selectWeather: (waypoint: PreparedWaypoint, estimatedUtc: string, altitudeFeetMsl: number) => Promise<DomainResult<WaypointWorksheetWeather>>;
}

export interface WaypointWorksheetResult {
  readonly route: PreparedPilotRoute;
  readonly waypoints: readonly PreparedWaypoint[];
  readonly rows: readonly WaypointWorksheetRow[];
  readonly estimatedArrivalUtc: string;
  readonly estimatedArrivalFuelGallons: number;
  readonly usableFuelGallons?: number;
  readonly fuelShortage: boolean;
  readonly warnings: readonly string[];
}

const isPreparedRoute = (route: WaypointWorksheetInput["route"]): route is PreparedPilotRoute =>
  "pilotPoints" in route && "totalRouteDistanceNauticalMiles" in route;
const resolveRoute = (route: WaypointWorksheetInput["route"]): DomainResult<PreparedPilotRoute> =>
  isPreparedRoute(route) ? success(route) : preparePilotRoute(route);
const validNonnegative = (value: number) => Number.isFinite(value) && value >= 0;
const validPositive = (value: number) => Number.isFinite(value) && value > 0;

const validateFuelAndClock = (input: WaypointWorksheetInput): DomainResult<true> => {
  for (const [name, value] of [["fuel aboard", input.fuelAboardGallons], ["taxi/run-up fuel", input.taxiRunupFuelGallons], ["reserve fuel", input.reserveFuelGallons]] as const) {
    if (!validNonnegative(value)) return failure("INVALID_NUMBER", `${name} must be finite and nonnegative.`, { field: name, value: String(value) });
  }
  if (!Number.isFinite(input.magneticVariationEastPositiveDegrees)) return failure("INVALID_NUMBER", "Magnetic variation must be a finite east-positive signed value.");
  const timestamp = Date.parse(input.departureEstimatedUtc);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input.departureEstimatedUtc) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 19) !== input.departureEstimatedUtc.slice(0, 19)) {
    return failure("INVALID_NUMBER", "Departure estimated UTC must be an ISO UTC instant.", { field: "departureEstimatedUtc" });
  }
  return success(true);
};

const validateProfile = (input: WaypointWorksheetInput): DomainResult<true> => {
  const p = input.profile;
  for (const [name, value] of [["cruise TAS", p.cruiseTasKnots], ["cruise fuel flow", p.cruiseFuelFlowGallonsPerHour], ["climb rate", p.climbRateFeetPerMinute], ["climb TAS", p.climbTasKnots], ["climb fuel flow", p.climbFuelFlowGallonsPerHour], ["descent rate", p.descentRateFeetPerMinute], ["descent TAS", p.descentTasKnots], ["descent fuel flow", p.descentFuelFlowGallonsPerHour]] as const) {
    if (!validPositive(value)) return failure("INVALID_PHASE_PERFORMANCE", `${name} must be finite and greater than zero.`, { field: name, value: String(value) });
  }
  if (p.usableFuelGallons !== undefined && (!validPositive(p.usableFuelGallons) || input.fuelAboardGallons > p.usableFuelGallons)) return failure("OUT_OF_RANGE", "Fuel aboard exceeds aircraft usable capacity or profile capacity is invalid.");
  if (p.compassDeviationTable.length === 0) return failure("INVALID_DEVIATION_TABLE", "Aircraft compass deviation table requires at least one point.");
  const headings = new Set<number>();
  for (const point of p.compassDeviationTable) {
    const checked = deviationTablePoint(point.magneticHeadingDegrees, point.deviationDegrees);
    if (!checked.ok) return propagateFailure(checked);
    if (headings.has(checked.value.magneticHeading)) return failure("INVALID_DEVIATION_TABLE", "Deviation table has duplicate magnetic-heading points.", { heading: checked.value.magneticHeading });
    headings.add(checked.value.magneticHeading);
  }
  return success(true);
};

const routeCruiseAltitude = (route: PreparedPilotRoute): DomainResult<number> => {
  const first = route.legs[0]?.sourceLeg.cruiseAltitudeFeetMsl;
  if (first === undefined || !validPositive(first) || route.legs.some(({ sourceLeg }) => sourceLeg.cruiseAltitudeFeetMsl !== first)) {
    return failure("INVALID_PHASE_ALTITUDES", "Choose one finite, positive cruise altitude for the whole route.");
  }
  return success(first);
};

const validateEndpointAltitudes = (route: PreparedPilotRoute, cruiseAltitude: number): DomainResult<true> => {
  const departure = route.pilotPoints[0]?.point;
  const destination = route.pilotPoints.at(-1)?.point;
  if (departure?.kind !== "airport" || destination?.kind !== "airport") return failure("ROUTE_GEOMETRY_ERROR", "A waypoint worksheet requires airport departure and destination endpoints.");
  if (!Number.isFinite(departure.elevationFeetMsl) || !Number.isFinite(destination.elevationFeetMsl)) return failure("INVALID_NUMBER", "Departure and destination field elevations must be finite.");
  if (cruiseAltitude <= departure.elevationFeetMsl) return failure("INVALID_PHASE_ALTITUDES", "Cruise altitude must be above departure field elevation.");
  if (cruiseAltitude <= destination.elevationFeetMsl) return failure("INVALID_PHASE_ALTITUDES", "Cruise altitude must be above destination field elevation.");
  return success(true);
};

const validateRouteOverrides = (route: PreparedPilotRoute): DomainResult<true> => {
  for (const { sourceLeg } of route.legs) {
    const overrides = sourceLeg.performanceOverrides;
    for (const [field, value] of [["cruise TAS override", overrides?.cruiseTasKnots?.effectiveValue], ["cruise fuel flow override", overrides?.cruiseFuelFlowGallonsPerHour?.effectiveValue]] as const) {
      if (value !== undefined && !validPositive(value)) return failure("INVALID_PHASE_PERFORMANCE", `${field} must be finite and greater than zero.`, { field, value: String(value) });
    }
  }
  return success(true);
};

const validateRouteInputs = (input: WaypointWorksheetInput): DomainResult<PreparedPilotRoute> => {
  const route = resolveRoute(input.route);
  if (!route.ok) return propagateFailure(route);
  const altitude = routeCruiseAltitude(route.value);
  if (!altitude.ok) return propagateFailure(altitude);
  const endpoints = validateEndpointAltitudes(route.value, altitude.value);
  if (!endpoints.ok) return propagateFailure(endpoints);
  const overrides = validateRouteOverrides(route.value);
  if (!overrides.ok) return propagateFailure(overrides);
  return route;
};

const validateInput = (input: WaypointWorksheetInput): DomainResult<PreparedPilotRoute> => {
  const fuelAndClock = validateFuelAndClock(input);
  if (!fuelAndClock.ok) return propagateFailure(fuelAndClock);
  const profile = validateProfile(input);
  if (!profile.ok) return propagateFailure(profile);
  return validateRouteInputs(input);
};

const asWaypoint = (point: PreparedPilotRoute["pilotPoints"][number], kind: "departure" | "destination"): PreparedWaypoint => ({
  id: point.point.id, kind, label: point.point.name, coordinate: point.point.coordinate,
  routeDistanceNauticalMiles: point.routeDistanceNauticalMiles, sourcePointId: point.point.id,
});

const validateWeather = (value: WaypointWorksheetWeather, waypoint: PreparedWaypoint, utc: string): DomainResult<WaypointWorksheetWeather> => {
  const checkedWind = wind(value.wind?.directionFrom, value.wind?.speed);
  if (!checkedWind.ok || !value.provenance) return failure("INVALID_WIND_SAMPLING", `Weather at ${waypoint.label} must include valid wind and provenance.`, { waypointId: waypoint.id });
  const instant = Date.parse(utc);
  if ((value.validFromUtc !== undefined && (!Number.isFinite(Date.parse(value.validFromUtc)) || instant < Date.parse(value.validFromUtc))) ||
      (value.validToUtc !== undefined && (!Number.isFinite(Date.parse(value.validToUtc)) || instant > Date.parse(value.validToUtc)))) return failure("FORECAST_OUTSIDE_VALIDITY", `Weather selected at ${waypoint.label} does not cover its estimated UTC.`, { waypointId: waypoint.id, estimatedUtc: utc });
  return success(value);
};

const selectWeather = async (input: WaypointWorksheetInput, point: PreparedWaypoint, utc: string, altitude: number, explicit?: WaypointWorksheetWeather): Promise<DomainResult<WaypointWorksheetWeather>> => {
  if (explicit !== undefined) return validateWeather(explicit, point, utc);
  try {
    const selected = await input.selectWeather(point, utc, altitude);
    return selected.ok ? validateWeather(selected.value, point, utc) : propagateFailure(selected);
  } catch {
    return failure("INVALID_WIND_SAMPLING", `Weather selection failed at ${point.label}.`, { waypointId: point.id, estimatedUtc: utc });
  }
};

const addMinutes = (utc: string, minutes: number): DomainResult<string> => {
  const millis = Date.parse(utc) + minutes * 60_000;
  if (!Number.isFinite(millis) || Math.abs(millis) > 8.64e15) return failure("OUT_OF_RANGE", "Preliminary destination forecast UTC is outside the supported date range.");
  return success(new Date(millis).toISOString());
};
const aircraftValue = (value: number, label: string, profile: AircraftProfile) => ({ computedValue: value, effectiveValue: value, origin: "aircraft-default" as const, provenance: { sourceId: `aircraft-profile:${profile.id}`, sourceLabel: `${profile.name} ${label}`, recordedAt: profile.updatedAt } });

interface WorksheetSetup {
  readonly route: PreparedPilotRoute;
  readonly departure: PreparedWaypoint;
  readonly destination: PreparedWaypoint;
  readonly cruiseAltitude: number;
  readonly destinationElevation: number;
  readonly toc: PreparedWaypoint;
  readonly tod: PreparedWaypoint;
  readonly waypoints: readonly PreparedWaypoint[];
  readonly departureWeather: WaypointWorksheetWeather;
  readonly destinationWeather: WaypointWorksheetWeather;
}

interface WorksheetProgress {
  readonly rows: WaypointWorksheetRow[];
  readonly warnings: string[];
  readonly weatherAt: Map<number, WaypointWorksheetWeather>;
  utc: string;
  fuel: number;
  elapsed: number;
  fuelUsed: number;
  phase: WaypointWorksheetPhase;
}

const prepareWorksheet = async (input: WaypointWorksheetInput, route: PreparedPilotRoute): Promise<DomainResult<WorksheetSetup>> => {
  const departurePoint = route.pilotPoints[0]!;
  const destinationPoint = route.pilotPoints.at(-1)!;
  if (departurePoint.point.kind !== "airport" || destinationPoint.point.kind !== "airport") return failure("ROUTE_GEOMETRY_ERROR", "A waypoint worksheet requires airport departure and destination endpoints.");
  const departure = asWaypoint(departurePoint, "departure");
  const destination = asWaypoint(destinationPoint, "destination");
  const cruiseAltitude = route.legs[0]!.sourceLeg.cruiseAltitudeFeetMsl;
  const departureWeather = await selectWeather(input, departure, input.departureEstimatedUtc, cruiseAltitude, input.departureWeather);
  if (!departureWeather.ok) return propagateFailure(departureWeather);
  const toc = estimateSingleCourseForwardWaypoint({ route, kind: "estimated-toc", id: "estimated-toc", label: "TOC", startRouteDistanceNauticalMiles: 0,
    startingAltitudeFeetMsl: departurePoint.point.elevationFeetMsl, targetAltitudeFeetMsl: cruiseAltitude,
    verticalRateFeetPerMinute: input.profile.climbRateFeetPerMinute, trueAirspeedKnots: input.profile.climbTasKnots,
    fuelFlowGallonsPerHour: input.profile.climbFuelFlowGallonsPerHour, planningWind: departureWeather.value.wind });
  if (!toc.ok) return propagateFailure(toc);
  const preliminaryArrival = addMinutes(input.departureEstimatedUtc, route.totalRouteDistanceNauticalMiles / input.profile.cruiseTasKnots * 60);
  if (!preliminaryArrival.ok) return propagateFailure(preliminaryArrival);
  const destinationWeather = await selectWeather(input, destination, preliminaryArrival.value, cruiseAltitude, input.destinationWeather);
  if (!destinationWeather.ok) return propagateFailure(destinationWeather);
  const tod = estimateTopOfDescent({ route, currentWaypoint: toc.value, cruiseAltitudeFeetMsl: cruiseAltitude,
    patternAltitudeFeetMsl: destinationPoint.point.elevationFeetMsl, descentRateFeetPerMinute: input.profile.descentRateFeetPerMinute,
    descentTrueAirspeedKnots: input.profile.descentTasKnots, descentFuelFlowGallonsPerHour: input.profile.descentFuelFlowGallonsPerHour,
    planningWind: destinationWeather.value.wind });
  if (!tod.ok) return propagateFailure(tod);
  if (toc.value.routeDistanceNauticalMiles >= tod.value.routeDistanceNauticalMiles) return failure("ROUTE_GEOMETRY_ERROR", "Estimated TOC is at or after estimated TOD, leaving no positive cruise distance.");
  const ordered = orderPreparedWaypoints(route, [toc.value, tod.value]);
  if (!ordered.ok) return propagateFailure(ordered);
  return success({ route, departure, destination, cruiseAltitude, destinationElevation: destinationPoint.point.elevationFeetMsl,
    toc: toc.value, tod: tod.value, waypoints: ordered.value.waypoints,
    departureWeather: departureWeather.value, destinationWeather: destinationWeather.value });
};

const initialProgress = (input: WaypointWorksheetInput, setup: WorksheetSetup): WorksheetProgress => ({
  rows: [], warnings: [],
  weatherAt: new Map([[setup.departure.routeDistanceNauticalMiles, setup.departureWeather], [setup.tod.routeDistanceNauticalMiles, setup.destinationWeather]]),
  utc: input.departureEstimatedUtc, fuel: input.fuelAboardGallons - input.taxiRunupFuelGallons,
  elapsed: 0, fuelUsed: input.taxiRunupFuelGallons, phase: "climb",
});

const advancePhaseAtStart = (state: WorksheetProgress, setup: WorksheetSetup, start: PreparedWaypoint): void => {
  if (equalWithinArithmeticRoundoff(start.routeDistanceNauticalMiles, setup.toc.routeDistanceNauticalMiles)) state.phase = "cruise";
  if (equalWithinArithmeticRoundoff(start.routeDistanceNauticalMiles, setup.tod.routeDistanceNauticalMiles)) state.phase = "descent";
};

const weatherForStart = async (input: WaypointWorksheetInput, setup: WorksheetSetup, state: WorksheetProgress, start: PreparedWaypoint): Promise<DomainResult<WaypointWorksheetWeather>> => {
  const cached = state.weatherAt.get(start.routeDistanceNauticalMiles);
  if (cached !== undefined) return success(cached);
  const selected = await selectWeather(input, start, state.utc, setup.cruiseAltitude);
  if (!selected.ok) return propagateFailure(selected);
  state.weatherAt.set(start.routeDistanceNauticalMiles, selected.value);
  return selected;
};

const cruiseOverridesForRow = (setup: WorksheetSetup, start: PreparedWaypoint, end: PreparedWaypoint, phase: WaypointWorksheetPhase) => {
  if (phase !== "cruise") return undefined;
  const leg = setup.route.legs.find(({ routeStartDistanceNauticalMiles, routeEndDistanceNauticalMiles }) =>
    start.routeDistanceNauticalMiles >= routeStartDistanceNauticalMiles && end.routeDistanceNauticalMiles <= routeEndDistanceNauticalMiles);
  return leg?.sourceLeg.performanceOverrides;
};

const performanceForRow = (input: WaypointWorksheetInput, phase: WaypointWorksheetPhase, overrides: ReturnType<typeof cruiseOverridesForRow>) => {
  const tas = phase === "climb" ? input.profile.climbTasKnots : phase === "descent" ? input.profile.descentTasKnots : input.profile.cruiseTasKnots;
  const flow = phase === "climb" ? input.profile.climbFuelFlowGallonsPerHour : phase === "descent" ? input.profile.descentFuelFlowGallonsPerHour : input.profile.cruiseFuelFlowGallonsPerHour;
  return { tas: overrides?.cruiseTasKnots?.effectiveValue ?? tas, flow: overrides?.cruiseFuelFlowGallonsPerHour?.effectiveValue ?? flow };
};

const calculateRow = (input: WaypointWorksheetInput, setup: WorksheetSetup, state: WorksheetProgress, start: PreparedWaypoint, end: PreparedWaypoint, weather: WaypointWorksheetWeather): DomainResult<WaypointWorksheetRow> => {
  const overrides = cruiseOverridesForRow(setup, start, end, state.phase);
  const performance = performanceForRow(input, state.phase, overrides);
  return calculateWaypointWorksheetRow({ startWaypoint: start, endWaypoint: end, phase: state.phase,
    plannedAltitudeFeetMsl: state.phase === "descent" ? setup.destinationElevation : setup.cruiseAltitude,
    trueAirspeedKnots: performance.tas, fuelFlowGallonsPerHour: performance.flow, wind: weather.wind,
    magneticVariationEastPositiveDegrees: input.magneticVariationAt?.(start) ?? input.magneticVariationEastPositiveDegrees,
    deviationTable: input.profile.compassDeviationTable.map(({ magneticHeadingDegrees, deviationDegrees }) => deviationTablePoint(magneticHeadingDegrees, deviationDegrees)).flatMap((point) => point.ok ? [point.value] : []),
    startingEstimatedUtc: state.utc, startingFuelGallons: state.fuel, cumulativeEstimatedMinutes: state.elapsed, cumulativeFuelUsedGallons: state.fuelUsed,
    ...(state.phase === "cruise" ? { performanceInputs: {
      trueAirspeed: overrides?.cruiseTasKnots ?? aircraftValue(input.profile.cruiseTasKnots, "cruise TAS", input.profile),
      fuelFlow: overrides?.cruiseFuelFlowGallonsPerHour ?? aircraftValue(input.profile.cruiseFuelFlowGallonsPerHour, "cruise fuel flow", input.profile),
    } } : {}), weatherProvenance: weather.provenance });
};

const carryRow = (state: WorksheetProgress, row: WaypointWorksheetRow): void => {
  state.rows.push(row);
  state.utc = row.endingEstimatedUtc;
  state.fuel = row.endingFuelGallons;
  state.elapsed = row.cumulativeEstimatedMinutes;
  state.fuelUsed = row.cumulativeFuelUsedGallons;
  if (state.fuel <= 0) state.warnings.push("Estimated fuel is exhausted before or at this waypoint.");
};

const calculateRows = async (input: WaypointWorksheetInput, setup: WorksheetSetup): Promise<DomainResult<WorksheetProgress>> => {
  const state = initialProgress(input, setup);
  for (let index = 0; index < setup.waypoints.length - 1; index += 1) {
    const start = setup.waypoints[index]!;
    const end = setup.waypoints[index + 1]!;
    advancePhaseAtStart(state, setup, start);
    if (start.routeDistanceNauticalMiles === end.routeDistanceNauticalMiles) continue;
    const weather = await weatherForStart(input, setup, state, start);
    if (!weather.ok) return propagateFailure(weather);
    const row = calculateRow(input, setup, state, start, end, weather.value);
    if (!row.ok) return propagateFailure(row);
    carryRow(state, row.value);
  }
  return success(state);
};

const finishWorksheet = (input: WaypointWorksheetInput, setup: WorksheetSetup, state: WorksheetProgress): WaypointWorksheetResult => {
  if (state.fuel <= 0) state.warnings.push("Estimated arrival fuel is exhausted, including when the selected reserve is zero.");
  else if (state.fuel < input.reserveFuelGallons) state.warnings.push(`Estimated arrival fuel (${state.fuel.toFixed(1)} gal) is below the selected reserve (${input.reserveFuelGallons} gal).`);
  return { route: setup.route, waypoints: setup.waypoints, rows: state.rows, estimatedArrivalUtc: state.utc, estimatedArrivalFuelGallons: state.fuel,
    ...(input.profile.usableFuelGallons === undefined ? {} : { usableFuelGallons: input.profile.usableFuelGallons }),
    fuelShortage: state.fuel <= 0 || state.fuel < input.reserveFuelGallons, warnings: [...new Set(state.warnings)] };
};

/** Calculates a stable-altitude waypoint worksheet. Generated TOC/TOD are fixed before row progression. */
export const calculateWaypointWorksheet = async (input: WaypointWorksheetInput): Promise<DomainResult<WaypointWorksheetResult>> => {
  const route = validateInput(input);
  if (!route.ok) return propagateFailure(route);
  const setup = await prepareWorksheet(input, route.value);
  if (!setup.ok) return propagateFailure(setup);
  const rows = await calculateRows(input, setup.value);
  if (!rows.ok) return propagateFailure(rows);
  return success(finishWorksheet(input, setup.value, rows.value));
};
