import { failure, propagateFailure, success, type DomainResult } from "../domain/errors";
import type { AircraftProfile } from "../domain/aircraft";
import { deviationTablePoint } from "../domain/deviation";
import { equalWithinArithmeticRoundoff } from "../domain/arithmetic-roundoff";
import type { RouteDefinition } from "../domain/route";
import { wind, type Wind } from "../domain/wind";
import {
  estimateForwardVerticalWaypoint,
  estimateTopOfDescent,
  orderPreparedWaypoints,
  preparePilotRoute,
  validateWaypointGeometry,
  type PreparedPilotRoute,
  type PreparedWaypoint,
} from "./waypoint-preparation";
import {
  calculateWaypointWorksheetRow,
  type WaypointWorksheetPhase,
  type WaypointWorksheetRow,
} from "./waypoint-worksheet-row";

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
  readonly descentTargetAltitudeFeetMsl: number;
  readonly magneticVariationEastPositiveDegrees: number;
  readonly selectWeather: (
    waypoint: PreparedWaypoint,
    estimatedUtc: string,
    altitudeFeetMsl: number,
  ) => Promise<DomainResult<WaypointWorksheetWeather>>;
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

type TransitionRecord = { readonly startPointId: string; readonly end: PreparedWaypoint; readonly nextPilotPointId: string };
interface WorksheetContext {
  readonly route: PreparedPilotRoute;
  readonly departureWaypoint: PreparedWaypoint;
  readonly destinationWaypoint: PreparedWaypoint;
  readonly finalLeg: PreparedPilotRoute["legs"][number];
  readonly cruiseAltitude: number;
  readonly toc: PreparedWaypoint;
  readonly initialWaypoints: readonly PreparedWaypoint[];
  readonly departureWeather: WaypointWorksheetWeather;
  readonly departureElevation: number;
  readonly descentTargetAltitude: number;
}
interface WorksheetState {
  waypoints: PreparedWaypoint[];
  readonly rows: WaypointWorksheetRow[];
  readonly warnings: string[];
  readonly seenWeather: Map<number, WaypointWorksheetWeather>;
  readonly transitions: TransitionRecord[];
  readonly transitionTargets: Map<string, number>;
  readonly pendingTransitions: Map<number, { readonly phase: WaypointWorksheetPhase; readonly targetAltitude: number }>;
  estimatedUtc: string;
  fuel: number;
  elapsed: number;
  fuelUsed: number;
  phase: WaypointWorksheetPhase;
  altitude: number;
  index: number;
}

const isPreparedRoute = (route: WaypointWorksheetInput["route"]): route is PreparedPilotRoute =>
  "pilotPoints" in route && "totalRouteDistanceNauticalMiles" in route;

const aircraftDefaultPlanningValue = (value: number, label: string, profile: AircraftProfile) => ({
  computedValue: value,
  effectiveValue: value,
  origin: "aircraft-default" as const,
  provenance: {
    sourceId: `aircraft-profile:${profile.id}`,
    sourceLabel: `${profile.name} ${label}`,
    recordedAt: profile.updatedAt,
  },
});

const validateNonnegativeNumber = (name: string, value: number): DomainResult<true> =>
  !Number.isFinite(value) || value < 0
    ? failure("INVALID_NUMBER", `${name} must be finite and nonnegative.`, { field: name, value: String(value) })
    : success(true);

const validatePositiveNumber = (name: string, value: number): DomainResult<true> =>
  !Number.isFinite(value) || value <= 0
    ? failure("INVALID_NUMBER", `${name} must be finite and greater than zero.`, { field: name, value: String(value) })
    : success(true);

const validatePlanningInputs = (input: WaypointWorksheetInput): DomainResult<true> => {
  for (const [name, value] of [
    ["fuel aboard", input.fuelAboardGallons], ["taxi/run-up fuel", input.taxiRunupFuelGallons], ["reserve fuel", input.reserveFuelGallons],
  ] as const) {
    const checked = validateNonnegativeNumber(name, value);
    if (!checked.ok) return propagateFailure(checked);
  }
  const altitude = validatePositiveNumber("descent target altitude", input.descentTargetAltitudeFeetMsl);
  if (!altitude.ok) return propagateFailure(altitude);
  if (!Number.isFinite(input.magneticVariationEastPositiveDegrees)) {
    return failure("INVALID_NUMBER", "Magnetic variation must be a finite east-positive signed value.", { field: "magneticVariationEastPositiveDegrees" });
  }
  const timestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(input.departureEstimatedUtc);
  const parsedUtc = Date.parse(input.departureEstimatedUtc);
  if (timestamp === null || !Number.isFinite(parsedUtc) || new Date(parsedUtc).toISOString().slice(0, 19) !== input.departureEstimatedUtc.slice(0, 19)) {
    return failure("INVALID_NUMBER", "Departure estimated UTC must be an ISO UTC instant.", { field: "departureEstimatedUtc" });
  }
  return success(true);
};

const validateAircraftPerformance = (profile: AircraftProfile): DomainResult<true> => {
  const positiveProfileValues: ReadonlyArray<readonly [string, number]> = [
    ["cruise TAS", profile.cruiseTasKnots], ["cruise fuel flow", profile.cruiseFuelFlowGallonsPerHour],
    ["climb rate", profile.climbRateFeetPerMinute], ["climb TAS", profile.climbTasKnots],
    ["climb fuel flow", profile.climbFuelFlowGallonsPerHour], ["descent rate", profile.descentRateFeetPerMinute],
    ["descent TAS", profile.descentTasKnots], ["descent fuel flow", profile.descentFuelFlowGallonsPerHour],
  ];
  for (const [field, value] of positiveProfileValues) {
    if (!Number.isFinite(value) || value <= 0) return failure("INVALID_PHASE_PERFORMANCE", `${field} must be finite and greater than zero.`, { field, value: String(value) });
  }
  if (profile.usableFuelGallons !== undefined && (!Number.isFinite(profile.usableFuelGallons) || profile.usableFuelGallons <= 0)) {
    return failure("INVALID_NUMBER", "Aircraft usable fuel capacity must be finite and greater than zero.", { field: "usableFuelGallons" });
  }
  if (profile.compassDeviationTable.length === 0) return failure("INVALID_DEVIATION_TABLE", "Aircraft compass deviation table requires at least one point.");
  for (const entry of profile.compassDeviationTable) {
    const checked = deviationTablePoint(entry.magneticHeadingDegrees, entry.deviationDegrees);
    if (!checked.ok) return propagateFailure(checked);
  }
  return success(true);
};

const validateInputs = (input: WaypointWorksheetInput): DomainResult<true> => {
  const planning = validatePlanningInputs(input);
  if (!planning.ok) return propagateFailure(planning);
  const performance = validateAircraftPerformance(input.profile);
  if (!performance.ok) return propagateFailure(performance);
  if (input.profile.usableFuelGallons !== undefined && input.fuelAboardGallons > input.profile.usableFuelGallons) {
    return failure("OUT_OF_RANGE", `Fuel aboard (${input.fuelAboardGallons} gal) exceeds aircraft usable capacity (${input.profile.usableFuelGallons} gal).`, {
      fuelAboardGallons: input.fuelAboardGallons, usableFuelGallons: input.profile.usableFuelGallons,
    });
  }
  return success(true);
};

const selectWind = async (
  selector: WaypointWorksheetInput["selectWeather"],
  waypoint: PreparedWaypoint,
  estimatedUtc: string,
  altitudeFeetMsl: number,
): Promise<DomainResult<WaypointWorksheetWeather>> => {
  let selected: DomainResult<WaypointWorksheetWeather>;
  try {
    selected = await selector(waypoint, estimatedUtc, altitudeFeetMsl);
  } catch {
    return failure("INVALID_WIND_SAMPLING", `Weather selection failed at ${waypoint.label}.`, { waypointId: waypoint.id, estimatedUtc });
  }
  if (!selected.ok) return propagateFailure(selected);
  const metadata = validateWeatherMetadata(selected.value, waypoint, estimatedUtc);
  if (!metadata.ok) return propagateFailure(metadata);
  return selected;
};

const validateWeatherMetadata = (
  weather: WaypointWorksheetWeather,
  waypoint: PreparedWaypoint,
  estimatedUtc: string,
): DomainResult<true> => {
  const validWind = weather.wind === undefined ? undefined : wind(weather.wind.directionFrom, weather.wind.speed);
  if (validWind === undefined || !validWind.ok) return failure("INVALID_WIND_SAMPLING", `Weather at ${waypoint.label} did not provide a valid wind.`, { waypointId: waypoint.id });
  if (!weather.provenance) return failure("INVALID_WIND_SAMPLING", `Weather at ${waypoint.label} is missing provenance.`, { waypointId: waypoint.id });
  return validateWeatherTimeCoverage(weather, waypoint, estimatedUtc);
};

const validateWeatherTimeCoverage = (
  weather: WaypointWorksheetWeather,
  waypoint: PreparedWaypoint,
  estimatedUtc: string,
): DomainResult<true> => {
  const start = weather.validFromUtc === undefined ? undefined : Date.parse(weather.validFromUtc);
  const end = weather.validToUtc === undefined ? undefined : Date.parse(weather.validToUtc);
  const instant = Date.parse(estimatedUtc);
  if ((start !== undefined && (!Number.isFinite(start) || instant < start)) || (end !== undefined && (!Number.isFinite(end) || instant > end))) {
    return failure("FORECAST_OUTSIDE_VALIDITY", `Weather selected at ${waypoint.label} does not cover its estimated UTC.`, { waypointId: waypoint.id, estimatedUtc });
  }
  return success(true);
};

const resolveRoute = (routeInput: WaypointWorksheetInput["route"]): DomainResult<PreparedPilotRoute> =>
  isPreparedRoute(routeInput) ? success(routeInput) : preparePilotRoute(routeInput);

const routeEndpoints = (route: PreparedPilotRoute): DomainResult<{
  readonly departure: PreparedPilotRoute["pilotPoints"][number];
  readonly destination: PreparedPilotRoute["pilotPoints"][number];
  readonly firstLeg: PreparedPilotRoute["legs"][number];
  readonly finalLeg: PreparedPilotRoute["legs"][number];
}> => {
  const departure = route.pilotPoints[0];
  const destination = route.pilotPoints.at(-1);
  const firstLeg = route.legs[0];
  const finalLeg = route.legs.at(-1);
  if (departure === undefined || destination === undefined || firstLeg === undefined || finalLeg === undefined) {
    return failure("ROUTE_GEOMETRY_ERROR", "A departure, destination, and connecting route legs are required.");
  }
  if (departure.point.kind !== "airport" || destination.point.kind !== "airport") {
    return failure("ROUTE_GEOMETRY_ERROR", "A waypoint worksheet requires airport departure and destination endpoints.");
  }
  return success({ departure, destination, firstLeg, finalLeg });
};

const asWaypoint = (point: PreparedPilotRoute["pilotPoints"][number], kind: "departure" | "destination"): PreparedWaypoint => ({
  id: point.point.id,
  kind,
  label: point.point.name,
  coordinate: point.point.coordinate,
  routeDistanceNauticalMiles: point.routeDistanceNauticalMiles,
  sourcePointId: point.point.id,
});

const prepareWorksheetContext = async (input: WaypointWorksheetInput): Promise<DomainResult<WorksheetContext>> => {
  const preparedRoute = resolveRoute(input.route);
  if (!preparedRoute.ok) return propagateFailure(preparedRoute);
  const route = preparedRoute.value;
  const endpoints = routeEndpoints(route);
  if (!endpoints.ok) return propagateFailure(endpoints);
  const departureWaypoint = asWaypoint(endpoints.value.departure, "departure");
  const destinationWaypoint = asWaypoint(endpoints.value.destination, "destination");
  const cruiseAltitude = endpoints.value.firstLeg.sourceLeg.cruiseAltitudeFeetMsl;
  const departureWeather = await selectWind(input.selectWeather, departureWaypoint, input.departureEstimatedUtc, cruiseAltitude);
  if (!departureWeather.ok) return propagateFailure(departureWeather);
  const departureElevation = endpoints.value.departure.point.kind === "airport"
    ? endpoints.value.departure.point.elevationFeetMsl
    : 0;
  const toc = estimateForwardVerticalWaypoint({
    route, kind: "estimated-toc", id: "estimated-toc", label: "TOC",
    startRouteDistanceNauticalMiles: 0, startingAltitudeFeetMsl: departureElevation,
    targetAltitudeFeetMsl: cruiseAltitude, verticalRateFeetPerMinute: input.profile.climbRateFeetPerMinute,
    trueAirspeedKnots: input.profile.climbTasKnots, fuelFlowGallonsPerHour: input.profile.climbFuelFlowGallonsPerHour,
    planningWind: departureWeather.value.wind,
  });
  if (!toc.ok) return propagateFailure(toc);
  const ordered = orderPreparedWaypoints(route, [toc.value]);
  if (!ordered.ok) return propagateFailure(ordered);
  return success({
    route, departureWaypoint, destinationWaypoint, finalLeg: endpoints.value.finalLeg, cruiseAltitude, toc: toc.value,
    initialWaypoints: ordered.value.waypoints, departureWeather: departureWeather.value, departureElevation,
    descentTargetAltitude: input.descentTargetAltitudeFeetMsl,
  });
};

const createWorksheetState = (input: WaypointWorksheetInput, context: WorksheetContext): WorksheetState => ({
  waypoints: [...context.initialWaypoints],
  rows: [],
  warnings: [],
  seenWeather: new Map([[context.departureWaypoint.routeDistanceNauticalMiles, context.departureWeather]]),
  transitions: [],
  transitionTargets: new Map(),
  pendingTransitions: new Map(),
  estimatedUtc: input.departureEstimatedUtc,
  fuel: input.fuelAboardGallons - input.taxiRunupFuelGallons,
  elapsed: 0,
  fuelUsed: input.taxiRunupFuelGallons,
  phase: "climb",
  altitude: context.departureElevation,
  index: 0,
});

const applyStartBoundary = (context: WorksheetContext, state: WorksheetState, start: PreparedWaypoint): void => {
  if (start.kind === "estimated-toc" || (start.kind === "pilot-checkpoint" && equalWithinArithmeticRoundoff(start.routeDistanceNauticalMiles, context.toc.routeDistanceNauticalMiles))) {
    state.phase = "cruise";
    state.altitude = context.cruiseAltitude;
  }
  if (start.kind === "estimated-transition-end") {
    state.phase = "cruise";
    state.altitude = state.transitionTargets.get(start.id) ?? state.altitude;
  }
  if (start.kind === "estimated-tod") {
    state.phase = "descent";
    state.altitude = context.descentTargetAltitude;
  }
  if (start.kind === "pilot-checkpoint") {
    const completed = state.transitions.find(({ end }) => equalWithinArithmeticRoundoff(end.routeDistanceNauticalMiles, start.routeDistanceNauticalMiles));
    if (completed !== undefined) {
      state.phase = "cruise";
      state.altitude = state.transitionTargets.get(completed.end.id) ?? state.altitude;
    }
  }
  const pending = [...state.pendingTransitions].find(([distance]) => equalWithinArithmeticRoundoff(distance, start.routeDistanceNauticalMiles))?.[1];
  if (pending !== undefined) {
    state.phase = pending.phase;
    state.altitude = pending.targetAltitude;
  }
};

const pilotOutboundLeg = (route: PreparedPilotRoute, waypoint: PreparedWaypoint) => {
  const pilotPoint = route.pilotPoints.find(({ point }) => point.id === waypoint.sourcePointId);
  return pilotPoint === undefined ? undefined : route.legs.find(({ sourceLeg }) => sourceLeg.fromPointId === pilotPoint.point.id);
};

const weatherAtStart = async (
  input: WaypointWorksheetInput,
  state: WorksheetState,
  waypoint: PreparedWaypoint,
): Promise<DomainResult<WaypointWorksheetWeather>> => {
  const cached = state.seenWeather.get(waypoint.routeDistanceNauticalMiles);
  if (cached !== undefined) return success(cached);
  const selected = await selectWind(input.selectWeather, waypoint, state.estimatedUtc, state.altitude);
  if (!selected.ok) return propagateFailure(selected);
  state.seenWeather.set(waypoint.routeDistanceNauticalMiles, selected.value);
  return selected;
};

const needsTransition = (
  context: WorksheetContext,
  state: WorksheetState,
  start: PreparedWaypoint,
  outgoing: PreparedPilotRoute["legs"][number] | undefined,
): boolean => start.kind === "pilot-checkpoint" &&
  start.routeDistanceNauticalMiles >= context.toc.routeDistanceNauticalMiles &&
  outgoing !== undefined && outgoing.sourceLeg.cruiseAltitudeFeetMsl !== state.altitude;

const estimateTodAtFinalCruiseBoundary = (
  input: WaypointWorksheetInput,
  context: WorksheetContext,
  state: WorksheetState,
  start: PreparedWaypoint,
  end: PreparedWaypoint,
  weather: WaypointWorksheetWeather,
  transitionNeededAtStart: boolean,
  outgoing: PreparedPilotRoute["legs"][number] | undefined,
): DomainResult<{ readonly end: PreparedWaypoint; readonly todAtStart: boolean }> => {
  if (end.id !== context.destinationWaypoint.id || state.phase !== "cruise") return success({ end, todAtStart: false });
  const tod = estimateTopOfDescent({
    route: context.route,
    currentWaypoint: start,
    cruiseAltitudeFeetMsl: context.finalLeg.sourceLeg.cruiseAltitudeFeetMsl,
    patternAltitudeFeetMsl: input.descentTargetAltitudeFeetMsl,
    descentRateFeetPerMinute: input.profile.descentRateFeetPerMinute,
    descentTrueAirspeedKnots: input.profile.descentTasKnots,
    descentFuelFlowGallonsPerHour: input.profile.descentFuelFlowGallonsPerHour,
    planningWind: weather.wind,
  });
  if (!tod.ok) return propagateFailure(tod);
  const todAtStart = equalWithinArithmeticRoundoff(tod.value.routeDistanceNauticalMiles, start.routeDistanceNauticalMiles);
  if (todAtStart && outgoing !== undefined && outgoing.sourceLeg.cruiseAltitudeFeetMsl !== state.altitude) {
    state.warnings.push(`TOD coincides with ${start.label}; its outbound altitude selection (${outgoing.sourceLeg.cruiseAltitudeFeetMsl} ft MSL) is retained as pilot input, while descent inputs apply to the next leg.`);
  }
  if (transitionNeededAtStart && !todAtStart) return success({ end, todAtStart });
  const ordered = orderPreparedWaypoints(context.route, [...state.transitions.map(({ end: transitionEnd }) => transitionEnd), context.toc, tod.value]);
  if (!ordered.ok) return propagateFailure(ordered);
  const geometry = validateWaypointGeometry({ route: context.route, toc: context.toc, tod: tod.value, transitions: state.transitions });
  if (!geometry.ok) return propagateFailure(geometry);
  state.waypoints.splice(0, state.waypoints.length, ...ordered.value.waypoints);
  state.index = state.waypoints.findIndex(({ id }) => id === start.id);
  const next = state.waypoints[state.index + 1];
  return next === undefined
    ? failure("ROUTE_GEOMETRY_ERROR", "Estimated TOD could not be ordered after its starting waypoint.")
    : success({ end: next, todAtStart });
};

const followingPilotWaypoint = (waypoints: readonly PreparedWaypoint[], index: number): PreparedWaypoint | undefined =>
  waypoints.slice(index + 1).find(({ kind }) => kind === "pilot-checkpoint" || kind === "destination");

const transitionPhaseFor = (startAltitude: number, targetAltitude: number): WaypointWorksheetPhase =>
  targetAltitude > startAltitude ? "transition-climb" : "transition-descent";

const estimateTransitionEnd = (
  input: WaypointWorksheetInput,
  context: WorksheetContext,
  state: WorksheetState,
  start: PreparedWaypoint,
  targetAltitude: number,
  weather: WaypointWorksheetWeather,
): DomainResult<PreparedWaypoint> => {
  const climbing = targetAltitude > state.altitude;
  return estimateForwardVerticalWaypoint({
    route: context.route,
    kind: "estimated-transition-end",
    id: `transition-end:${start.id}`,
    label: `Transition end after ${start.label}`,
    startRouteDistanceNauticalMiles: start.routeDistanceNauticalMiles,
    startingAltitudeFeetMsl: state.altitude,
    targetAltitudeFeetMsl: targetAltitude,
    verticalRateFeetPerMinute: climbing ? input.profile.climbRateFeetPerMinute : input.profile.descentRateFeetPerMinute,
    trueAirspeedKnots: climbing ? input.profile.climbTasKnots : input.profile.descentTasKnots,
    fuelFlowGallonsPerHour: climbing ? input.profile.climbFuelFlowGallonsPerHour : input.profile.descentFuelFlowGallonsPerHour,
    planningWind: weather.wind,
  });
};

const insertTransitionEnd = (
  context: WorksheetContext,
  state: WorksheetState,
  start: PreparedWaypoint,
  nextPilot: PreparedWaypoint,
  transitionEnd: PreparedWaypoint,
  targetAltitude: number,
  transitionPhase: WaypointWorksheetPhase,
): DomainResult<PreparedWaypoint> => {
  if (transitionEnd.routeDistanceNauticalMiles > nextPilot.routeDistanceNauticalMiles) {
    return failure("ROUTE_GEOMETRY_ERROR", `Transition end at NM ${transitionEnd.routeDistanceNauticalMiles.toFixed(2)} extends beyond next pilot waypoint ${nextPilot.label} at NM ${nextPilot.routeDistanceNauticalMiles.toFixed(2)}. Choose a lower or more reachable altitude, revise performance assumptions, move the checkpoint, or revise the route.`, {
      startPointId: start.id, nextPilotPointId: nextPilot.id,
      transitionEndDistanceNauticalMiles: transitionEnd.routeDistanceNauticalMiles,
      nextPilotDistanceNauticalMiles: nextPilot.routeDistanceNauticalMiles,
    });
  }
  const generated = state.waypoints.filter(({ kind }) => kind.startsWith("estimated-") && kind !== "estimated-tod");
  const ordered = orderPreparedWaypoints(context.route, [...generated, transitionEnd]);
  if (!ordered.ok) return propagateFailure(ordered);
  state.waypoints.splice(0, state.waypoints.length, ...ordered.value.waypoints);
  state.index = state.waypoints.findIndex(({ id }) => id === start.id);
  const next = state.waypoints[state.index + 1];
  if (next === undefined) return failure("ROUTE_GEOMETRY_ERROR", `Transition from ${start.label} could not be ordered on the route.`);
  state.phase = transitionPhase;
  state.altitude = targetAltitude;
  state.transitionTargets.set(transitionEnd.id, targetAltitude);
  state.pendingTransitions.set(start.routeDistanceNauticalMiles, { phase: transitionPhase, targetAltitude });
  state.transitions.push({ startPointId: start.id, end: transitionEnd, nextPilotPointId: nextPilot.id });
  return success(next);
};

const addTransitionAtCheckpoint = (
  input: WaypointWorksheetInput,
  context: WorksheetContext,
  state: WorksheetState,
  start: PreparedWaypoint,
  outgoing: PreparedPilotRoute["legs"][number] | undefined,
  weather: WaypointWorksheetWeather,
): DomainResult<PreparedWaypoint | undefined> => {
  if (outgoing === undefined) return success(undefined);
  const targetAltitude = outgoing.sourceLeg.cruiseAltitudeFeetMsl;
  if (targetAltitude === state.altitude) return success(undefined);
  const nextPilot = followingPilotWaypoint(state.waypoints, state.index);
  if (nextPilot === undefined) return failure("ROUTE_GEOMETRY_ERROR", `Transition from ${start.label} has no following pilot waypoint.`);
  const transitionPhase = transitionPhaseFor(state.altitude, targetAltitude);
  const estimatedEnd = estimateTransitionEnd(input, context, state, start, targetAltitude, weather);
  if (!estimatedEnd.ok) return propagateFailure(estimatedEnd);
  const inserted = insertTransitionEnd(context, state, start, nextPilot, estimatedEnd.value, targetAltitude, transitionPhase);
  return inserted.ok ? inserted : propagateFailure(inserted);
};

const addPreTocCheckpointWarning = (
  state: WorksheetState,
  context: WorksheetContext,
  start: PreparedWaypoint,
  outgoing: PreparedPilotRoute["legs"][number] | undefined,
): void => {
  if (start.kind === "pilot-checkpoint" && start.routeDistanceNauticalMiles < context.toc.routeDistanceNauticalMiles && outgoing !== undefined) {
    state.warnings.push(`Ignored outbound altitude selection at ${start.label}; the checkpoint is before estimated TOC, so climb inputs continue.`);
  }
};

const activePhaseForRow = (state: WorksheetState, start: PreparedWaypoint): WaypointWorksheetPhase =>
  start.kind === "estimated-tod" ? "descent" : state.phase;

const routeLegForCruiseRow = (
  context: WorksheetContext,
  start: PreparedWaypoint,
  outgoing: PreparedPilotRoute["legs"][number] | undefined,
): PreparedPilotRoute["legs"][number] | undefined =>
  (start.sourceLegId === undefined ? undefined : context.route.legs.find(({ sourceLeg }) => sourceLeg.id === start.sourceLegId)) ?? outgoing;

const rowPerformance = (
  input: WaypointWorksheetInput,
  context: WorksheetContext,
  state: WorksheetState,
  start: PreparedWaypoint,
  outgoing: PreparedPilotRoute["legs"][number] | undefined,
) => {
  const activePhase = activePhaseForRow(state, start);
  const routeLeg = activePhase === "cruise" ? routeLegForCruiseRow(context, start, outgoing) : undefined;
  const tasOverride = routeLeg?.sourceLeg.performanceOverrides?.cruiseTasKnots;
  const flowOverride = routeLeg?.sourceLeg.performanceOverrides?.cruiseFuelFlowGallonsPerHour;
  const phaseValues: Readonly<Record<WaypointWorksheetPhase, readonly [number, number]>> = {
    climb: [input.profile.climbTasKnots, input.profile.climbFuelFlowGallonsPerHour],
    "transition-climb": [input.profile.climbTasKnots, input.profile.climbFuelFlowGallonsPerHour],
    cruise: [input.profile.cruiseTasKnots, input.profile.cruiseFuelFlowGallonsPerHour],
    "transition-descent": [input.profile.descentTasKnots, input.profile.descentFuelFlowGallonsPerHour],
    descent: [input.profile.descentTasKnots, input.profile.descentFuelFlowGallonsPerHour],
  };
  const [tas, fuelFlow] = phaseValues[activePhase];
  return { activePhase, tas: tasOverride?.effectiveValue ?? tas, fuelFlow: flowOverride?.effectiveValue ?? fuelFlow, tasOverride, flowOverride };
};

const advanceOneWaypoint = async (
  input: WaypointWorksheetInput,
  context: WorksheetContext,
  state: WorksheetState,
): Promise<DomainResult<true>> => {
  const start = state.waypoints[state.index];
  const initialEnd = state.waypoints[state.index + 1];
  if (start === undefined || initialEnd === undefined) return success(true);
  applyStartBoundary(context, state, start);
  const outgoing = pilotOutboundLeg(context.route, start);
  const transitionNeededAtStart = needsTransition(context, state, start, outgoing);
  addPreTocCheckpointWarning(state, context, start, outgoing);
  const weather = await weatherAtStart(input, state, start);
  if (!weather.ok) return propagateFailure(weather);
  const tod = estimateTodAtFinalCruiseBoundary(input, context, state, start, initialEnd, weather.value, transitionNeededAtStart, outgoing);
  if (!tod.ok) return propagateFailure(tod);
  let end = tod.value.end;
  if (transitionNeededAtStart && !tod.value.todAtStart) {
    const transitionEnd = addTransitionAtCheckpoint(input, context, state, start, outgoing, weather.value);
    if (!transitionEnd.ok) return propagateFailure(transitionEnd);
    end = state.waypoints[state.index + 1] ?? end;
  }
  if (end.routeDistanceNauticalMiles === start.routeDistanceNauticalMiles) {
    state.index += 1;
    return success(true);
  }
  return appendWaypointRow(input, context, state, start, end, outgoing, weather.value);
};

const appendWaypointRow = (
  input: WaypointWorksheetInput,
  context: WorksheetContext,
  state: WorksheetState,
  start: PreparedWaypoint,
  end: PreparedWaypoint,
  outgoing: PreparedPilotRoute["legs"][number] | undefined,
  weather: WaypointWorksheetWeather,
): DomainResult<true> => {
  const performance = rowPerformance(input, context, state, start, outgoing);
  const row = calculateWaypointWorksheetRow({
    startWaypoint: start,
    endWaypoint: end,
    phase: performance.activePhase,
    plannedAltitudeFeetMsl: performance.activePhase === "climb" ? context.cruiseAltitude : state.altitude,
    trueAirspeedKnots: performance.tas,
    fuelFlowGallonsPerHour: performance.fuelFlow,
    ...(performance.activePhase !== "cruise" ? {} : { performanceInputs: {
      trueAirspeed: performance.tasOverride ?? aircraftDefaultPlanningValue(input.profile.cruiseTasKnots, "cruise TAS", input.profile),
      fuelFlow: performance.flowOverride ?? aircraftDefaultPlanningValue(input.profile.cruiseFuelFlowGallonsPerHour, "cruise fuel flow", input.profile),
    } }),
    wind: weather.wind,
    magneticVariationEastPositiveDegrees: input.magneticVariationEastPositiveDegrees,
    deviationTable: input.profile.compassDeviationTable.map(({ magneticHeadingDegrees, deviationDegrees }) =>
      deviationTablePoint(magneticHeadingDegrees, deviationDegrees)).flatMap((entry) => entry.ok ? [entry.value] : []),
    startingEstimatedUtc: state.estimatedUtc,
    startingFuelGallons: state.fuel,
    cumulativeEstimatedMinutes: state.elapsed,
    cumulativeFuelUsedGallons: state.fuelUsed,
    weatherProvenance: weather.provenance,
  });
  if (!row.ok) return propagateFailure(row);
  state.rows.push(row.value);
  state.estimatedUtc = row.value.endingEstimatedUtc;
  state.fuel = row.value.endingFuelGallons;
  state.elapsed = row.value.cumulativeEstimatedMinutes;
  state.fuelUsed = row.value.cumulativeFuelUsedGallons;
  if (state.fuel <= 0) state.warnings.push("Estimated fuel is exhausted before or at this waypoint.");
  state.index += 1;
  return success(true);
};

const finishWorksheet = (input: WaypointWorksheetInput, context: WorksheetContext, state: WorksheetState): DomainResult<WaypointWorksheetResult> => {
  if (state.fuel <= 0) state.warnings.push("Estimated arrival fuel is exhausted, including when the selected reserve is zero.");
  else if (state.fuel < input.reserveFuelGallons) state.warnings.push(`Estimated arrival fuel (${state.fuel.toFixed(1)} gal) is below the selected reserve (${input.reserveFuelGallons} gal).`);
  return success({
    route: context.route,
    waypoints: state.waypoints,
    rows: state.rows,
    estimatedArrivalUtc: state.estimatedUtc,
    estimatedArrivalFuelGallons: state.fuel,
    ...(input.profile.usableFuelGallons === undefined ? {} : { usableFuelGallons: input.profile.usableFuelGallons }),
    fuelShortage: state.fuel <= 0 || state.fuel < input.reserveFuelGallons,
    warnings: [...new Set(state.warnings)],
  });
};

/** Calculates one waypoint row at a time. Each selected wind is used only by the row leaving that waypoint. */
export const calculateWaypointWorksheet = async (
  input: WaypointWorksheetInput,
): Promise<DomainResult<WaypointWorksheetResult>> => {
  const validInput = validateInputs(input);
  if (!validInput.ok) return propagateFailure(validInput);
  const prepared = await prepareWorksheetContext(input);
  if (!prepared.ok) return propagateFailure(prepared);
  const context = prepared.value;
  const state = createWorksheetState(input, context);
  while (state.index < state.waypoints.length - 1) {
    const advanced = await advanceOneWaypoint(input, context, state);
    if (!advanced.ok) return propagateFailure(advanced);
  }
  return finishWorksheet(input, context, state);
};
