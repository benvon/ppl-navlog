import type { AloftPointAnswer, AloftPointQuery, MetarSuccessPayload, TafAnswer } from "../../worker/api/contracts";
import { calculateGreatCircleDistanceAndInitialCourse, pointAlongGreatCircle, MEAN_EARTH_RADIUS_NAUTICAL_MILES } from "../domain/distance-course";
import { failure, success } from "../domain/errors";
import { vectorToWind, wind, windToVector, type Wind } from "../domain/wind";
import { nauticalMiles, knots, degreesToRadians, feetMsl, type Knots } from "../domain/units";
import { solveWindTriangle } from "../domain/wind-triangle";
import type { EffectiveWindResolver } from "../domain/phase-planning";
import type { PlanDraft, JsonValue } from "../domain/route";
import type { AircraftProfile } from "../domain/aircraft";
import { canonicalPointCoordinateDegrees, type Coordinate } from "../domain/coordinates";
import { trace } from "../domain/calculation-trace";
import { MAX_CHECKPOINTS_PER_PLAN } from "../services/storage/pilot-input-repository";
import { arrivalTafWindSelectionChanged, selectArrivalMetarWind, selectArrivalTafWind, type SelectedArrivalWind } from "./arrival-taf-wind";
import { calculatePlanningMagneticVariation } from "./magnetic-variation";
import type { CompletePlanRouteLeg, CompletePlanWeather, RouteWeatherSample } from "./complete-plan";
import { calculateNavlogRow, createNavlogCalculationSession, createNavlogCalculationState, finalizeNavlog, type AllocatedNavlogSubleg, type NavlogWindResolver } from "./navlog-calculation";

const MAX_ROUTE_WAYPOINTS = MAX_CHECKPOINTS_PER_PLAN + 2;
const TERMINAL_PATTERN_DISTANCE_NM = 5;
const MAX_METAR_AGE_MS = 2 * 60 * 60 * 1_000;

export interface RouteWeatherPointClient {
  fetchPoint(query: AloftPointQuery): Promise<AloftPointAnswer>;
}

export interface RouteWeatherSolution {
  readonly weather: CompletePlanWeather;
  readonly sampledPoints: readonly AloftPointAnswer[];
  readonly iterations: 1;
}

interface RouteLine {
  readonly leg: CompletePlanRouteLeg;
  readonly startDistance: number;
  readonly endDistance: number;
}
interface WaypointTarget {
  readonly routeDistance: number;
  readonly coordinate: Coordinate;
  readonly altitudeFeetMsl: number;
}
type ProgressiveRouteMode = "climb" | "cruise" | "transition-climb" | "transition-descent" | "descent";
interface PreTodVerticalPhase {
  readonly currentAltitude: number;
  readonly targetAltitude: number;
  readonly tasKnots: number;
  readonly rateFeetPerMinute: number;
}
const isClimbOrTransition = (mode: ProgressiveRouteMode): boolean => mode === "climb" || mode === "transition-climb" || mode === "transition-descent";
const isClimbingMode = (mode: ProgressiveRouteMode): boolean => mode === "climb" || mode === "transition-climb";
const isVerticalMode = (mode: ProgressiveRouteMode): boolean => mode !== "cruise";
const assertNotAtUnfetchedTod = (requested: boolean, cursor: number, tod: number): void => {
  if (!requested && Math.abs(cursor - tod) < 1e-7) throw new RouteWeatherSamplingError("A climb or altitude transition is still active at the fixed top-of-descent point.");
};
const assertVerticalTargetReached = (reachesTarget: boolean, calculated: number, target: number): void => {
  if (reachesTarget && Math.abs(calculated - target) > 0.1) throw new RouteWeatherSamplingError("Calculated row time does not reach the planned vertical phase target at its generated boundary.");
};
const nextCruiseEventDistance = (cursor: number, waypoint: number, tod: number, todRequested: boolean, total: number, hasTaf: boolean): number => Math.min(
  waypoint,
  !todRequested && tod > cursor + 1e-8 ? tod : Number.POSITIVE_INFINITY,
  hasTaf && cursor < total - TERMINAL_PATTERN_DISTANCE_NM - 1e-8 ? total - TERMINAL_PATTERN_DISTANCE_NM : Number.POSITIVE_INFINITY,
);

/**
 * Fetches point weather in route order and finalizes each interval once from
 * the latest event's weather. Completed row time and fuel carry forward.
 */
export const resolveRouteWeather = async (
  draft: PlanDraft,
  profile: AircraftProfile,
  pointClient: RouteWeatherPointClient,
  endpoints: { readonly departureMetar: MetarSuccessPayload; readonly destinationTaf: TafAnswer; readonly destinationMetar?: MetarSuccessPayload },
): Promise<RouteWeatherSolution> => {
  const prepared = prepareRouteWeatherInputs(draft, endpoints);
  const progressive = await calculateProgressiveRoute(draft, profile, pointClient, prepared, endpoints);
  const arrivalWind = progressive.arrivalWind;
  const weather = {
    ...weatherFor(prepared.routeLegs, progressive.samples, endpoints.departureMetar, endpoints.destinationTaf, arrivalWind, prepared.totalDistance),
    progressiveCalculationSnapshot: progressive.snapshot,
  };
  return { weather, sampledPoints: progressive.samples.map((sample) => sample.answer), iterations: 1 };
};

interface PreparedRouteWeatherInputs {
  readonly routeLegs: readonly CompletePlanRouteLeg[];
  readonly lines: readonly RouteLine[];
  readonly totalDistance: number;
  readonly targets: readonly WaypointTarget[];
}
const prepareRouteWeatherInputs = (
  draft: PlanDraft, endpoints: { readonly departureMetar: MetarSuccessPayload; readonly destinationTaf: TafAnswer },
): PreparedRouteWeatherInputs => {
  if (draft.route.points.length > MAX_ROUTE_WAYPOINTS) throw new RouteWeatherSamplingError(`Route exceeds the ${MAX_ROUTE_WAYPOINTS}-waypoint weather limit.`);
  if (draft.route.points.length < 2 || draft.route.legs.length !== draft.route.points.length - 1) throw new RouteWeatherSamplingError("Route weather requires one leg between every adjacent waypoint.");
  const routeLegs = buildRouteLegs(draft), lines = routeLines(routeLegs), totalDistance = lines.at(-1)?.endDistance;
  if (totalDistance === undefined || totalDistance <= 0) throw new RouteWeatherSamplingError("A complete route is required for route weather sampling.");
  const departure = routeLegs[0]!.start, destination = routeLegs.at(-1)!.end;
  if (departure.kind !== "airport" || destination.kind !== "airport") throw new RouteWeatherSamplingError("Route weather requires airport departure and destination endpoints.");
  validateDepartureMetar(draft, departure, endpoints.departureMetar);
  const allowedDestinationTafIcaos = new Set([destination.icao, draft.weatherSelection?.destinationTafIcao].filter((icao): icao is string => icao !== undefined));
  if (!allowedDestinationTafIcaos.has(endpoints.destinationTaf.stationIcao)) throw new RouteWeatherSamplingError("Destination TAF station does not match the destination or selected alternate source.");
  const targets = buildWaypointTargets(draft, lines);
  return { routeLegs, lines, totalDistance, targets };
};

interface ProgressiveWeatherResult {
  readonly samples: readonly RouteWeatherSample[];
  readonly snapshot: JsonValue;
  readonly arrivalWind: SelectedArrivalWind;
}

/** Each interval is calculated from the last fetched event and finalized once. */
const calculateProgressiveRoute = async (
  draft: PlanDraft,
  profile: AircraftProfile,
  client: RouteWeatherPointClient,
  prepared: PreparedRouteWeatherInputs,
  endpoints: { readonly departureMetar: MetarSuccessPayload; readonly destinationTaf: TafAnswer; readonly destinationMetar?: MetarSuccessPayload },
): Promise<ProgressiveWeatherResult> => {
  const { routeLegs, lines, totalDistance } = prepared;
  const departure = routeLegs[0]!.start;
  const departureElevation = departure.kind === "airport" ? departure.elevationFeetMsl : 0;
  const firstTargetAltitude = routeLegs[0]!.sourceLeg.cruiseAltitudeFeetMsl;
  const finalTargetAltitude = draft.descentTargetAltitudeFeetMsl.effectiveValue;
  const finalCruiseAltitude = routeLegs.at(-1)!.sourceLeg.cruiseAltitudeFeetMsl;
  const descentPlan = createFixedAirspeedDescentPlan(finalCruiseAltitude, finalTargetAltitude, totalDistance, profile);
  const { descentTas, descentMinutes, todDistance } = descentPlan;

  const session = createNavlogCalculationSession({
    routeLegs: routeLegs.map((leg) => ({
      sourceLeg: leg.sourceLeg,
      magneticVariation: leg.magneticVariation,
      resolveMagneticVariation: (subleg) => segmentMagneticVariation(
        leg,
        subleg,
        new Date(Date.parse(draft.departureTimeUtc) + state.cumulativeMinutes * 60_000),
      ),
    })),
    aircraftProfile: profile,
    fuelInputs: draft.fuelInputs,
    windResolver: { resolveEffectiveWind: () => failure("INVALID_WIND_SAMPLING", "A progressive event resolver is required for every row.") },
  });
  if (!session.ok) throw new RouteWeatherSamplingError(session.error.message);
  let state = createNavlogCalculationState();
  const samples: RouteWeatherSample[] = [];
  const initialTarget = { ...prepared.targets[0]!, altitudeFeetMsl: Math.max(3_000, departureElevation + 1) };
  const initialQuery = queryAt(initialTarget, draft.departureTimeUtc);
  let currentAnswer = await fetchOnePointAnswer(client, initialQuery);
  samples.push(sampleFromAnswer(initialTarget, initialQuery, currentAnswer));
  let cursorDistance = 0;
  let currentAltitude = departureElevation;
  let mode: ProgressiveRouteMode =
    firstTargetAltitude > departureElevation ? "climb" : "cruise";
  let phaseTarget = firstTargetAltitude;
  let phaseId = mode === "climb" ? "departure-climb" : "route-cruise-1";
  let projectedArrivalWind: SelectedArrivalWind | undefined;
  const terminalBoundaryDistance = totalDistance - TERMINAL_PATTERN_DISTANCE_NM;
  const todInsideTerminalRing = todDistance >= terminalBoundaryDistance - 1e-8;
  let tocRequested = mode === "cruise";
  let todRequested = descentMinutes === 0;
  let rowSequence = 0;
  const generatedBoundaries: GeneratedRouteBoundary[] = [];

  const finalArrivalMs = (): number => Date.parse(draft.departureTimeUtc) + state.cumulativeMinutes * 60_000;
  const fetchAt = async (target: WaypointTarget, label: string): Promise<void> => {
    const plannedUtc = new Date(finalArrivalMs()).toISOString();
    const query = queryAt(target, plannedUtc);
    currentAnswer = await fetchOnePointAnswer(client, query);
    samples.push(sampleFromAnswer(target, query, currentAnswer));
    if (!answerCovers(currentAnswer, finalArrivalMs())) throw new RouteWeatherSamplingError(`Winds-aloft period does not cover the completed arrival at ${label}.`);
  };

  const calculateInterval = (line: RouteLine, endDistance: number, phase: AllocatedNavlogSubleg["phase"], startAltitude: number, endAltitude: number, phaseId: string, windOverride?: Wind): number => {
    const distance = endDistance - cursorDistance;
    if (distance <= 1e-8) return 0;
    const terminal = cursorDistance >= totalDistance - TERMINAL_PATTERN_DISTANCE_NM;
    const selectedWind = windOverride ?? intervalWind(phase, startAltitude, endAltitude, terminal);
    const subleg = makeProgressiveSubleg(line, cursorDistance, endDistance, phase, startAltitude, endAltitude, `subleg-${++rowSequence}`, phaseId, distance);
    const blendEvidence = departureBlendEvidence(phase, startAltitude, endAltitude, routeLegs, currentAnswer, endpoints.departureMetar);
    const resolver: NavlogWindResolver = { resolveEffectiveWind: () => progressiveResolvedWind(currentAnswer, selectedWind, terminal ? projectedArrivalWind : undefined, blendEvidence) };
    const calculated = calculateNavlogRow(session.value, state, subleg, resolver);
    if (!calculated.ok) throw new RouteWeatherSamplingError(calculated.error.message);
    state = calculated.value.state;
    if (!answerCovers(currentAnswer, finalArrivalMs())) throw new RouteWeatherSamplingError(`Winds-aloft period does not cover the completed interval ending at route distance ${endDistance.toFixed(2)} NM.`);
    return Number(calculated.value.row.estimatedTimeEnroute);
  };
  const intervalWind = (phase: AllocatedNavlogSubleg["phase"], startAltitude: number, endAltitude: number, terminal: boolean): Wind => {
    if (terminal && projectedArrivalWind !== undefined) return requiredWind(projectedArrivalWind.effectiveWind.directionFromDegTrue, projectedArrivalWind.effectiveWind.speedKt);
    if (phase === "climb" && startAltitude < currentAnswer.query.altitudeFeetMsl) {
      return blendDepartureSurface(routeLegs, currentAnswer, endpoints.departureMetar, (startAltitude + endAltitude) / 2);
    }
    return pointWind(currentAnswer);
  };

  const requestTopOfDescent = async (line: RouteLine): Promise<void> => {
    const todCoordinate = coordinateAtRouteDistance(lines, todDistance);
    generatedBoundaries.push(makeGeneratedBoundary("top-of-descent", line, todDistance, todCoordinate, todPlacementTrace(finalCruiseAltitude, finalTargetAltitude, profile.descentRateFeetPerMinute, descentTas, totalDistance - todDistance)));
    const todTarget: WaypointTarget = { routeDistance: todDistance, coordinate: todCoordinate, altitudeFeetMsl: finalCruiseAltitude };
    await fetchAt(todTarget, "generated top of descent");
    todRequested = true;
    if (!todInsideTerminalRing) {
      const projectedMinutes = estimateRemainingMinutes(lines, todDistance, totalDistance, descentTas, pointWind(currentAnswer));
      projectedArrivalWind = selectArrivalTafWind(endpoints.destinationTaf, new Date(finalArrivalMs() + projectedMinutes * 60_000).toISOString(), terminalCourse(lines, totalDistance), descentTas);
    } else if (projectedArrivalWind === undefined) projectedArrivalWind = selectTerminalWindAtBoundary();
    if (Math.abs(currentAltitude - finalCruiseAltitude) > 1) throw new RouteWeatherSamplingError("Aircraft has not reached the selected cruise altitude at the fixed top-of-descent point.");
    mode = "descent";
    phaseTarget = finalTargetAltitude;
    phaseId = "arrival-descent";
  };

  const destination = routeLegs.at(-1)!.end;
  if (destination.kind !== "airport") throw new RouteWeatherSamplingError("Route weather requires an airport destination.");
  const allowedDestinationMetarIcaos = new Set([destination.icao, draft.weatherSelection?.destinationMetarIcao].filter((icao): icao is string => icao !== undefined));
  const selectTerminalWindAtBoundary = (): SelectedArrivalWind => selectProjectedTerminalWind({
    taf: endpoints.destinationTaf,
    metar: endpoints.destinationMetar,
    allowedMetarIcaos: allowedDestinationMetarIcaos,
    lines,
    totalDistance,
    fromDistance: terminalBoundaryDistance,
    nowMs: finalArrivalMs(),
    currentAnswer,
    courseDegTrue: terminalCourse(lines, totalDistance),
    tasKnots: descentTas,
    cruiseTasKnots: profile.cruiseTasKnots,
    todDistance,
    preTodVerticalPhase: isVerticalMode(mode) ? {
      currentAltitude,
      targetAltitude: phaseTarget,
      tasKnots: isClimbingMode(mode) ? profile.climbTasKnots : profile.descentTasKnots,
      rateFeetPerMinute: checkedRate(isClimbingMode(mode) ? profile.climbRateFeetPerMinute : profile.descentRateFeetPerMinute, isClimbingMode(mode) ? "climb" : "descent"),
    } : undefined,
  });
  const selectTerminalWindAtBoundaryIfReached = (distance: number): void => {
    if (todInsideTerminalRing && projectedArrivalWind === undefined && Math.abs(distance - terminalBoundaryDistance) < 1e-7) projectedArrivalWind = selectTerminalWindAtBoundary();
  };
  if (todInsideTerminalRing && terminalBoundaryDistance <= 1e-8) projectedArrivalWind = selectTerminalWindAtBoundary();

  const processVerticalInterval = async (line: RouteLine, legIndex: number, nextWaypointDistance: number): Promise<void> => {
    assertNotAtUnfetchedTod(todRequested, cursorDistance, todDistance);
    const climbing = isClimbingMode(mode);
    const rate = checkedRate(climbing ? profile.climbRateFeetPerMinute : profile.descentRateFeetPerMinute, climbing ? "climb" : "descent");
    const tas = checkedVerticalTas(climbing ? profile.climbTasKnots : profile.descentTasKnots);
    const phaseEventDistance = verticalEventDistance(nextWaypointDistance, todRequested, todDistance, cursorDistance, mode, totalDistance);
    const terminal = cursorDistance >= totalDistance - TERMINAL_PATTERN_DISTANCE_NM;
    let selectedWind = intervalWind(mode, currentAltitude, phaseTarget, terminal);
    const remainingToEvent = phaseEventDistance - cursorDistance;
    const neededMinutes = Math.abs(phaseTarget - currentAltitude) / rate;
    const estimate = verticalDistanceEstimate(line, tas, selectedWind, neededMinutes, remainingToEvent);
    let triangle = estimate.triangle;
    const neededDistance = estimate.distance;
    const reachesTarget = neededDistance <= remainingToEvent + 1e-8;
    const segmentDistance = reachesTarget ? neededDistance : remainingToEvent;
    if (!reachesTarget) ({ selectedWind, triangle } = refineVerticalWind(line, selectedWind, triangle, tas, climbing, rate, segmentDistance, terminal));
    const nextDistance = cursorDistance + segmentDistance;
    const predictedElapsed = segmentDistance / triangle.groundspeed * 60;
    const nextAltitude = reachesTarget ? phaseTarget : currentAltitude + (climbing ? 1 : -1) * rate * predictedElapsed;
    const elapsed = calculateInterval(line, nextDistance, mode, currentAltitude, nextAltitude, phaseId, selectedWind);
    cursorDistance = nextDistance;
    const calculatedAltitude = currentAltitude + (climbing ? 1 : -1) * rate * elapsed;
    assertVerticalTargetReached(reachesTarget, calculatedAltitude, phaseTarget);
    currentAltitude = reachesTarget ? phaseTarget : calculatedAltitude;
    if (reachesTarget) await finishVerticalTarget(line, legIndex, tas);
    selectTerminalWindAtBoundaryIfReached(cursorDistance);
    if (elapsed <= 0) throw new RouteWeatherSamplingError("A progressive route interval produced no positive time.");
  };

  const checkedVerticalTas = (speed: number): Knots => {
    const result = knots(speed);
    if (!result.ok) throw new RouteWeatherSamplingError("Vertical true airspeed is invalid.");
    return result.value;
  };
  const verticalEventDistance = (nextWaypoint: number, todDone: boolean, tod: number, cursor: number, phase: ProgressiveRouteMode, total: number): number => Math.min(
    nextWaypoint,
    !todDone && tod > cursor + 1e-8 ? tod : Number.POSITIVE_INFINITY,
    todInsideTerminalRing && projectedArrivalWind === undefined && cursor < terminalBoundaryDistance - 1e-8 ? terminalBoundaryDistance : Number.POSITIVE_INFINITY,
    phase === "descent" && cursor < total - TERMINAL_PATTERN_DISTANCE_NM - 1e-8 ? total - TERMINAL_PATTERN_DISTANCE_NM : Number.POSITIVE_INFINITY,
  );
  const requiredVerticalTriangle = (line: RouteLine, tas: Knots, localWind: Wind, endDistance: number) => {
    const course = courseForLineInterval(line, cursorDistance, endDistance);
    const result = solveWindTriangle(course, tas, localWind);
    if (!result.ok) throw new RouteWeatherSamplingError("Progressive vertical phase cannot produce a valid groundspeed.");
    return result.value;
  };
  const verticalDistanceEstimate = (line: RouteLine, tas: Knots, localWind: Wind, durationMinutes: number, remainingDistance: number) => {
    let triangle = requiredVerticalTriangle(line, tas, localWind, cursorDistance + remainingDistance);
    let distance = triangle.groundspeed * durationMinutes / 60;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      triangle = requiredVerticalTriangle(line, tas, localWind, cursorDistance + Math.min(distance, remainingDistance));
      distance = triangle.groundspeed * durationMinutes / 60;
    }
    return { triangle, distance };
  };
  const refineVerticalWind = (
    line: RouteLine, initialWind: Wind, initialTriangle: ReturnType<typeof requiredVerticalTriangle>, tas: Knots,
    climbing: boolean, rate: number, distance: number, terminal: boolean,
  ): { readonly selectedWind: Wind; readonly triangle: ReturnType<typeof requiredVerticalTriangle> } => {
    let selectedWind = initialWind, triangle = initialTriangle;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const predicted = currentAltitude + (climbing ? 1 : -1) * rate * (distance / triangle.groundspeed * 60);
      selectedWind = intervalWind(mode, currentAltitude, predicted, terminal);
      triangle = requiredVerticalTriangle(line, tas, selectedWind, cursorDistance + distance);
    }
    return { selectedWind, triangle };
  };

  const finishVerticalTarget = async (line: RouteLine, legIndex: number, tas: number): Promise<void> => {
    const completedDepartureClimb = mode === "climb";
    const completedPhaseId = phaseId;
    mode = "cruise";
    phaseId = `route-cruise-${legIndex + 1}`;
    if (!completedDepartureClimb || tocRequested) return;
    const tocCoordinate = coordinateAtRouteDistance(lines, cursorDistance);
    generatedBoundaries.push(makeGeneratedBoundary("top-of-climb", line, cursorDistance, tocCoordinate, tocPlacementTrace(profile.climbRateFeetPerMinute, tas, state.rows.filter((row) => row.subleg.phaseId === completedPhaseId))));
    await fetchAt({ routeDistance: cursorDistance, coordinate: tocCoordinate, altitudeFeetMsl: firstTargetAltitude }, "generated top of climb");
    tocRequested = true;
  };

  const advanceEventInterval = async (line: RouteLine, legIndex: number): Promise<void> => {
    const nextWaypointDistance = line.endDistance;
    if (await advanceToTerminalBoundaryBeforeTod(line, nextWaypointDistance)) return;
    if (await requestTodIfHere(line, nextWaypointDistance)) return;
    if (isVerticalMode(mode)) {
      await processVerticalInterval(line, legIndex, nextWaypointDistance);
      return;
    }
    const nextDistance = Math.min(nextCruiseEventDistance(cursorDistance, nextWaypointDistance, todDistance, todRequested, totalDistance, projectedArrivalWind !== undefined), todInsideTerminalRing && projectedArrivalWind === undefined && cursorDistance < terminalBoundaryDistance - 1e-8 ? terminalBoundaryDistance : Number.POSITIVE_INFINITY);
    calculateInterval(line, nextDistance, "cruise", currentAltitude, currentAltitude, phaseId);
    cursorDistance = nextDistance;
    selectTerminalWindAtBoundaryIfReached(cursorDistance);
    if (!todRequested && Math.abs(cursorDistance - todDistance) < 1e-7) await requestTopOfDescent(line);
  };

  const advanceToTerminalBoundaryBeforeTod = async (line: RouteLine, nextWaypointDistance: number): Promise<boolean> => {
    if (!todInsideTerminalRing || projectedArrivalWind !== undefined || terminalBoundaryDistance <= cursorDistance + 1e-8 || terminalBoundaryDistance >= nextWaypointDistance - 1e-8 || isClimbOrTransition(mode)) return false;
    calculateInterval(line, terminalBoundaryDistance, "cruise", currentAltitude, currentAltitude, `${phaseId}:to-terminal-boundary`);
    cursorDistance = terminalBoundaryDistance;
    projectedArrivalWind = selectTerminalWindAtBoundary();
    return true;
  };

  const requestTodIfHere = async (line: RouteLine, nextWaypointDistance: number): Promise<boolean> => {
    const canStart = !todRequested && todDistance >= cursorDistance - 1e-8 && todDistance <= nextWaypointDistance + 1e-8 && !isClimbOrTransition(mode);
    if (!canStart) return false;
    if (todDistance > cursorDistance + 1e-8) calculateInterval(line, todDistance, "cruise", currentAltitude, currentAltitude, `${phaseId}:to-tod`);
    cursorDistance = todDistance;
    await requestTopOfDescent(line);
    return true;
  };

  const fetchPilotWaypoint = async (waypointIndex: number): Promise<void> => {
    if (waypointIndex >= draft.route.points.length) return;
    const target = { ...prepared.targets[waypointIndex]!, altitudeFeetMsl: Math.max(3_000, Math.min(53_000, Math.round(currentAltitude))) };
    await fetchAt(target, `waypoint ${waypointIndex + 1}`);
    if (waypointIndex >= draft.route.legs.length) return;
    updateAltitudeModeAtWaypoint(waypointIndex);
  };

  const updateAltitudeModeAtWaypoint = (waypointIndex: number): void => {
    const outboundAltitude = draft.route.legs[waypointIndex]!.cruiseAltitudeFeetMsl;
    const activeTransition = isClimbOrTransition(mode);
    if (activeTransition && Math.abs(phaseTarget - outboundAltitude) > 1) throw new RouteWeatherSamplingError("A selected altitude change begins before the prior climb or transition reaches its target altitude.");
    if (activeTransition || Math.abs(currentAltitude - outboundAltitude) <= 1 || todRequested) return;
    phaseTarget = outboundAltitude;
    mode = outboundAltitude > currentAltitude ? "transition-climb" : "transition-descent";
    phaseId = `transition:${draft.route.legs[waypointIndex - 1]!.id}->${draft.route.legs[waypointIndex]!.id}`;
  };

  const processProgressiveEvents = async (): Promise<void> => {
  for (let legIndex = 0; legIndex < lines.length; legIndex += 1) {
    const line = lines[legIndex]!;
    while (cursorDistance < line.endDistance - 1e-8) {
      await advanceEventInterval(line, legIndex);
    }
    await fetchPilotWaypoint(legIndex + 1);
  }
  };
  await processProgressiveEvents();

  if (!todRequested) throw new RouteWeatherSamplingError("The generated top of descent was not reached in route order.");
  if (Math.abs(currentAltitude - finalTargetAltitude) > 1) throw new RouteWeatherSamplingError("The selected descent rate and true airspeed cannot reach the destination target altitude.");
  const arrival = validateFinalArrivalWind(projectedArrivalWind, endpoints.destinationTaf, endpoints.destinationMetar, allowedDestinationMetarIcaos, new Date(finalArrivalMs()).toISOString(), terminalCourse(lines, totalDistance), profile.descentTasKnots);
  const navlog = finalizeNavlog(session.value, state);
  if (!navlog.ok) throw new RouteWeatherSamplingError(navlog.error.message);
  const snapshot = jsonValue({
    schema: "complete-navlog/v1", status: "calculated",
    weather: { snapshotIds: [...new Set(samples.map((sample) => sample.answer.requestId))], provenance: { source: "progressive-route-events", eventCount: samples.length }, endpointSources: endpointSourceProvenance(endpoints.departureMetar, endpoints.destinationTaf, endpoints.destinationMetar, arrival) },
    phaseAllocation: { status: "allocated", transitionPolicy: "progressive-event-walk", boundaries: progressiveBoundaries(generatedBoundaries), phases: phaseEvidence(state.rows), sublegs: state.rows.map((row) => row.subleg), warnings: ["Each interval was calculated once from the latest preceding weather event."] },
    navlog: navlog.value,
  });
  return { samples, snapshot, arrivalWind: arrival };
};

const createFixedAirspeedDescentPlan = (finalCruise: number, target: number, distance: number, profile: AircraftProfile) => {
  if (target >= finalCruise) throw new RouteWeatherSamplingError("Destination target altitude must be below the final selected cruise altitude.");
  const tas = profile.descentTasKnots;
  if (!Number.isFinite(tas) || tas <= 0) throw new RouteWeatherSamplingError("Descent true airspeed must be finite and positive.");
  checkedRate(profile.climbRateFeetPerMinute, "climb");
  const minutes = (finalCruise - target) / checkedRate(profile.descentRateFeetPerMinute, "descent");
  const tod = minutes === 0 ? Number.POSITIVE_INFINITY : distance - tas * minutes / 60;
  if (tod < 0) throw new RouteWeatherSamplingError("Fixed-airspeed top of descent falls before the route starts; the selected descent cannot fit.");
  return { descentTas: tas, descentMinutes: minutes, todDistance: tod };
};

const isFreshDestinationMetar = (metar: MetarSuccessPayload | undefined, allowedIcaos: ReadonlySet<string>, arrivalMs: number): metar is MetarSuccessPayload => {
  if (metar === undefined) return false;
  const observed = metar.metar.observedAt === null ? Number.NaN : Date.parse(metar.metar.observedAt);
  return allowedIcaos.has(metar.metar.icao) && Number.isFinite(observed) && observed <= arrivalMs && arrivalMs - observed <= MAX_METAR_AGE_MS && metar.provenance.cache.status !== "stale_on_error" && metar.provenance.cache.freshnessRemainingSeconds > 0 && metarWind(metar) !== null;
};

const selectProjectedTerminalWind = (input: {
  readonly taf: TafAnswer;
  readonly metar: MetarSuccessPayload | undefined;
  readonly allowedMetarIcaos: ReadonlySet<string>;
  readonly lines: readonly RouteLine[];
  readonly totalDistance: number;
  readonly fromDistance: number;
  readonly nowMs: number;
  readonly currentAnswer: AloftPointAnswer;
  readonly courseDegTrue: number;
  readonly tasKnots: number;
  readonly cruiseTasKnots: number;
  readonly todDistance: number;
  readonly preTodVerticalPhase?: PreTodVerticalPhase;
}): SelectedArrivalWind => {
  const localWind = pointWind(input.currentAnswer);
  const projectedMinutes = input.preTodVerticalPhase === undefined
    ? estimateTerminalRemainingMinutes(input.lines, input.fromDistance, input.todDistance, input.totalDistance, input.cruiseTasKnots, input.tasKnots, localWind)
    : estimateTerminalArrivalThroughVerticalPhase(input.lines, input.fromDistance, input.todDistance, input.totalDistance, input.cruiseTasKnots, input.tasKnots, localWind, input.preTodVerticalPhase);
  const projectedArrivalMs = input.nowMs + projectedMinutes * 60_000;
  const metar = input.metar;
  const surfaceWind = metar?.metar.wind;
  if (isFreshDestinationMetar(metar, input.allowedMetarIcaos, projectedArrivalMs) && surfaceWind !== undefined && surfaceWind.directionType !== "variable") {
    return selectArrivalMetarWind({
      icao: metar.metar.icao,
      requestId: metar.requestId,
      reportSource: metar.metar.source,
      fetchedAt: metar.metar.fetchedAt,
      observedAt: metar.metar.observedAt!,
      raw: metar.metar.metarRaw,
      cacheProvenance: {
        status: metar.provenance.cache.status,
        source: metar.provenance.cache.source,
        freshnessRemainingSeconds: metar.provenance.cache.freshnessRemainingSeconds,
        fetchedAt: metar.provenance.cache.fetchedAt,
        expiresAt: metar.provenance.cache.expiresAt,
      },
      directionType: surfaceWind.directionType,
      directionFromDegTrue: surfaceWind.directionDegTrue,
      speedKt: surfaceWind.speedKt,
    }, input.courseDegTrue, input.tasKnots);
  }
  return selectArrivalTafWind(input.taf, new Date(projectedArrivalMs).toISOString(), input.courseDegTrue, input.tasKnots);
};

const validateFinalArrivalWind = (
  projected: SelectedArrivalWind | undefined,
  taf: TafAnswer,
  metar: MetarSuccessPayload | undefined,
  allowedMetarIcaos: ReadonlySet<string>,
  arrivalUtc: string,
  courseDegTrue: number,
  tasKnots: number,
): SelectedArrivalWind => {
  if (projected?.source === "metar") {
    if (!isFreshDestinationMetar(metar, allowedMetarIcaos, Date.parse(arrivalUtc))) throw new RouteWeatherSamplingError("Destination METAR is no longer fresh through the completed arrival; update the plan again for a consistent estimate.");
    return projected;
  }
  const arrival = selectArrivalTafWind(taf, arrivalUtc, courseDegTrue, tasKnots);
  if (projected !== undefined && arrivalTafWindSelectionChanged(projected, arrival)) throw new RouteWeatherSamplingError("Completed arrival moved into a different destination TAF wind group; update the plan again for a consistent estimate.");
  return arrival;
};

const estimateTerminalRemainingMinutes = (
  lines: readonly RouteLine[], from: number, tod: number, to: number, cruiseTas: number, descentTas: number, localWind: Wind,
): number => lines.reduce((minutes, line) => {
  const preTodStart = Math.max(from, line.startDistance), preTodEnd = Math.min(tod, to, line.endDistance);
  const cruiseTasForLine = line.leg.sourceLeg.performanceOverrides?.cruiseTasKnots?.effectiveValue ?? cruiseTas;
  const cruiseMinutes = estimateRemainingMinutes([line], preTodStart, preTodEnd, cruiseTasForLine, localWind);
  const descentStart = Math.max(from, tod, line.startDistance), descentEnd = Math.min(to, line.endDistance);
  return minutes + cruiseMinutes + estimateRemainingMinutes([line], descentStart, descentEnd, descentTas, localWind);
}, 0);

const estimateTerminalArrivalThroughVerticalPhase = (
  lines: readonly RouteLine[], from: number, tod: number, to: number, cruiseTas: number, descentTas: number, localWind: Wind, phase: PreTodVerticalPhase,
): number => {
  const remainingPhaseMinutes = Math.abs(phase.targetAltitude - phase.currentAltitude) / phase.rateFeetPerMinute;
  const verticalEstimate = estimateVerticalPhaseToDistance(lines, from, tod, phase.tasKnots, localWind, remainingPhaseMinutes);
  return verticalEstimate.minutes
    + estimateTerminalRemainingMinutes(lines, verticalEstimate.endDistance, tod, to, cruiseTas, descentTas, localWind);
};

const estimateVerticalPhaseToDistance = (
  lines: readonly RouteLine[], from: number, limit: number, tasKnots: number, localWind: Wind, neededMinutes: number,
): { readonly endDistance: number; readonly minutes: number } => {
  const tas = knots(tasKnots);
  if (!tas.ok) throw new RouteWeatherSamplingError("Vertical true airspeed is invalid.");
  let elapsedMinutes = 0;
  let cursor = from;
  for (const line of lines) {
    const start = Math.max(from, line.startDistance), end = Math.min(limit, line.endDistance);
    if (end <= start + 1e-8) continue;
    const triangle = solveWindTriangle(courseForLineInterval(line, start, end), tas.value, localWind);
    if (!triangle.ok) throw new RouteWeatherSamplingError("Could not estimate terminal arrival during the active vertical phase.");
    const segmentMinutes = (end - start) / triangle.value.groundspeed * 60;
    const remainingMinutes = Math.max(0, neededMinutes - elapsedMinutes);
    if (remainingMinutes <= segmentMinutes) return { endDistance: start + triangle.value.groundspeed * remainingMinutes / 60, minutes: neededMinutes };
    elapsedMinutes += segmentMinutes;
    cursor = end;
  }
  return { endDistance: cursor, minutes: elapsedMinutes };
};

const makeProgressiveSubleg = (line: RouteLine, startDistance: number, endDistance: number, phase: AllocatedNavlogSubleg["phase"], startAltitude: number, endAltitude: number, id: string, phaseId: string, distance: number): AllocatedNavlogSubleg => {
  const startOffset = nauticalMiles(startDistance - line.startDistance), endOffset = nauticalMiles(endDistance - line.startDistance);
  const checkedDistance = nauticalMiles(distance), start = coordinateAtLineDistance(line, startDistance), end = coordinateAtLineDistance(line, endDistance);
  const startingAltitude = feetMsl(startAltitude), endingAltitude = feetMsl(endAltitude), selected = feetMsl(line.leg.sourceLeg.cruiseAltitudeFeetMsl);
  if (!startOffset.ok || !endOffset.ok || !checkedDistance.ok || !startingAltitude.ok || !endingAltitude.ok || !selected.ok) throw new RouteWeatherSamplingError("Progressive subleg geometry or altitude is invalid.");
  const routeStartDistance = nauticalMiles(startDistance), routeEndDistance = nauticalMiles(endDistance);
  if (!routeStartDistance.ok || !routeEndDistance.ok) throw new RouteWeatherSamplingError("Progressive route distance is invalid.");
  const base = { id, sourceLegId: line.leg.sourceLeg.id, phase, start, end, distance: checkedDistance.value };
  return { ...base, phaseId, trueCourse: courseForLineInterval(line, startDistance, endDistance), routeStartDistance: routeStartDistance.value, routeEndDistance: routeEndDistance.value, startingAltitude: startingAltitude.value, endingAltitude: endingAltitude.value, selectedCruiseAltitude: selected.value };
};

const courseForLineInterval = (line: RouteLine, startDistance: number, endDistance: number) => {
  const result = calculateGreatCircleDistanceAndInitialCourse(coordinateAtLineDistance(line, startDistance), coordinateAtLineDistance(line, endDistance));
  if (!result.ok) throw new RouteWeatherSamplingError(result.error.message);
  return result.value.initialTrueCourse;
};

const terminalCourse = (lines: readonly RouteLine[], totalDistance: number): number => {
  const finalLine = lines.at(-1);
  if (finalLine === undefined) throw new RouteWeatherSamplingError("A final route segment is required for arrival wind selection.");
  return courseForLineInterval(finalLine, Math.max(finalLine.startDistance, totalDistance - TERMINAL_PATTERN_DISTANCE_NM), totalDistance);
};

const endpointMetarSource = (metar: MetarSuccessPayload | undefined) => metar === undefined ? undefined : ({
  stationIcao: metar.metar.icao,
  requestId: metar.requestId,
  reportSource: metar.metar.source,
  fetchedAt: metar.metar.fetchedAt,
  observedAt: metar.metar.observedAt,
  cache: {
    status: metar.provenance.cache.status,
    source: metar.provenance.cache.source,
    fetchedAt: metar.provenance.cache.fetchedAt,
    expiresAt: metar.provenance.cache.expiresAt,
    freshnessRemainingSeconds: metar.provenance.cache.freshnessRemainingSeconds,
  },
});

const endpointSourceProvenance = (departure: MetarSuccessPayload, taf: TafAnswer, destination: MetarSuccessPayload | undefined, arrival: SelectedArrivalWind) => ({
  departureMetar: { ...endpointMetarSource(departure), selectedForTerminalWind: false },
  destinationTaf: { stationIcao: taf.stationIcao, requestId: taf.requestId, issuedAt: taf.issuedAt, validFrom: taf.validFrom, validUntil: taf.validUntil, selectedForTerminalWind: arrival.source === "taf" },
  ...(destination === undefined ? {} : { destinationMetar: { ...endpointMetarSource(destination), selectedForTerminalWind: arrival.source === "metar" } }),
});

const segmentMagneticVariation = (leg: CompletePlanRouteLeg, subleg: AllocatedNavlogSubleg, date: Date): CompletePlanRouteLeg["magneticVariation"] => {
  const geometry = calculateGreatCircleDistanceAndInitialCourse(subleg.start, subleg.end);
  if (!geometry.ok) throw new RouteWeatherSamplingError(geometry.error.message);
  const midpointDistance = nauticalMiles(geometry.value.distance / 2);
  if (!midpointDistance.ok) throw new RouteWeatherSamplingError(midpointDistance.error.message);
  const midpoint = pointAlongGreatCircle(subleg.start, geometry.value.initialTrueCourse, midpointDistance.value);
  if (!midpoint.ok) throw new RouteWeatherSamplingError(midpoint.error.message);
  const calculated = calculatePlanningMagneticVariation({
    coordinate: midpoint.value,
    date,
    altitudeFeetMsl: (subleg.startingAltitude + subleg.endingAltitude) / 2,
  });
  const base = leg.magneticVariation.variation;
  if (base.override === undefined) return calculated;
  return {
    ...calculated,
    variation: { ...calculated.variation, effectiveValue: base.effectiveValue, override: base.override },
  };
};

interface DepartureBlendEvidence { readonly stationIcao: string; readonly aloftRequestId: string; readonly aloftLatitudeDeg: number; readonly aloftLongitudeDeg: number; readonly fieldElevationFeetMsl: number; readonly aloftAltitudeFeetMsl: number; readonly midpointAltitudeFeetMsl: number; readonly fraction: number; readonly directionFromDegTrue: number; readonly speedKt: number; }
const departureBlendEvidence = (
  phase: AllocatedNavlogSubleg["phase"], startAltitude: number, endAltitude: number,
  routeLegs: readonly CompletePlanRouteLeg[], aloftAnswer: AloftPointAnswer, metar: MetarSuccessPayload,
): DepartureBlendEvidence | undefined => {
  if (phase !== "climb" || startAltitude >= aloftAnswer.query.altitudeFeetMsl) return undefined;
  const surface = metarWind(metar), fieldElevation = routeLegs[0]!.start.kind === "airport" ? routeLegs[0]!.start.elevationFeetMsl : 0;
  const aloftAltitude = aloftAnswer.query.altitudeFeetMsl, midpoint = (startAltitude + endAltitude) / 2;
  if (surface === null || aloftAltitude <= fieldElevation) return undefined;
  return { stationIcao: metar.metar.icao, aloftRequestId: aloftAnswer.requestId, aloftLatitudeDeg: aloftAnswer.query.latitudeDeg, aloftLongitudeDeg: aloftAnswer.query.longitudeDeg, fieldElevationFeetMsl: fieldElevation, aloftAltitudeFeetMsl: aloftAltitude, midpointAltitudeFeetMsl: midpoint, fraction: Math.max(0, Math.min(1, (midpoint - fieldElevation) / (aloftAltitude - fieldElevation))), directionFromDegTrue: surface.directionFrom, speedKt: surface.speed };
};

const progressiveResolvedWind = (answer: AloftPointAnswer, value: Wind, arrival?: SelectedArrivalWind, blend?: DepartureBlendEvidence) => {
  const metadata = progressiveWindMetadata(answer, arrival, blend);
  const windValue = { computedValue: value, effectiveValue: value, ...metadata };
  const windTrace = trace(progressiveWindFormula(arrival, blend), [
    { name: "point request id", value: answer.requestId, unit: "unitless" },
    { name: "point latitude", value: answer.query.latitudeDeg, unit: "degrees" },
    { name: "point longitude", value: answer.query.longitudeDeg, unit: "degrees" },
    { name: "point altitude", value: answer.query.altitudeFeetMsl, unit: "feet-msl" },
    { name: "wind from", value: answer.windFromDegTrue ?? 0, unit: "degrees-true" },
    { name: "wind speed", value: answer.windSpeedKt, unit: "knots" },
    { name: "report valid from", value: answer.useFrom, unit: "unitless" },
    { name: "report valid until", value: answer.useUntil, unit: "unitless" },
    { name: "point interpolation method", value: answer.method, unit: "unitless" },
    { name: "winds product region", value: answer.product.region, unit: "unitless" },
    { name: "winds product cycle", value: answer.product.cycle, unit: "unitless" },
    { name: "winds product cache status", value: answer.product.cache.status, unit: "unitless" },
    { name: "winds product cache source", value: answer.product.cache.source, unit: "unitless" },
    { name: "winds product cache age seconds", value: answer.product.cache.ageSeconds, unit: "unitless" },
    { name: "winds product cache fetched at", value: answer.product.cache.fetchedAt, unit: "unitless" },
    { name: "winds product cache expires at", value: answer.product.cache.expiresAt, unit: "unitless" },
    { name: "winds product cache freshness remaining seconds", value: answer.product.cache.freshnessRemainingSeconds, unit: "unitless" },
    { name: "winds product cache served at", value: answer.product.cache.servedAt, unit: "unitless" },
    ...answer.sources.flatMap(progressiveSourceTraceInputs),
    ...departureBlendTraceInputs(blend),
    ...arrivalTraceInputs(arrival),
  ], [], { name: "effective wind from", value: value.directionFrom, unit: "degrees-true" }, arrival === undefined ? "The current interval uses the point report fetched at its starting route event." : `${arrival.source === "metar" ? "Destination METAR" : "Worst-case active destination TAF"} wind is applied to the terminal 5 NM.`);
  return success({ wind: windValue, trace: windTrace });
};

const progressiveWindFormula = (arrival?: SelectedArrivalWind, blend?: DepartureBlendEvidence): string =>
  arrival !== undefined
    ? arrival.source === "metar" ? "progressive-destination-metar-wind" : "progressive-destination-taf-wind"
    : blend !== undefined ? "departure-surface-to-aloft-wind" : "progressive-route-point-wind";
const progressiveWindMetadata = (answer: AloftPointAnswer, arrival?: SelectedArrivalWind, blend?: DepartureBlendEvidence) => ({
  origin: arrival !== undefined || blend !== undefined ? "interpolated" as const : "external-data" as const,
  provenance: {
    sourceId: arrival !== undefined ? arrival.source === "metar" ? `destination-metar:${arrival.requestId}` : `destination-taf:${arrival.selectedGroup.fromUtc}` : `route-point:${answer.requestId}`,
    sourceLabel: arrival !== undefined ? `Destination ${arrival.source === "metar" ? "METAR" : `TAF ${arrival.selectedGroup.kind}`} wind` : blend !== undefined ? "Departure METAR and aloft point blend" : "Most recent progressive winds-aloft point",
    sourceVersion: arrival !== undefined ? arrival.source === "metar" ? arrival.raw : `${arrival.selectedGroup.fromUtc} to ${arrival.selectedGroup.untilUtc}` : `${answer.method}; cycle ${answer.forecastCycle}`,
    recordedAt: arrival !== undefined ? arrival.source === "metar" ? arrival.observedAt : arrival.selectedGroup.fromUtc : answer.issuedAt,
  },
  explanation: { formulaId: progressiveWindFormula(arrival, blend), formulaVersion: "v1" },
});
const progressiveSourceTraceInputs = (source: AloftPointAnswer["sources"][number]) => [
  { name: `${source.stationId} station id`, value: source.stationId, unit: "unitless" as const },
  { name: `${source.stationId} source distance`, value: source.distanceNauticalMiles, unit: "nautical-miles" as const },
  { name: `${source.stationId} horizontal weight`, value: source.horizontalWeight, unit: "unitless" as const },
  { name: `${source.stationId} lower altitude`, value: source.lowerAltitudeFeet, unit: "feet-msl" as const },
  { name: `${source.stationId} upper altitude`, value: source.upperAltitudeFeet, unit: "feet-msl" as const },
  { name: `${source.stationId} vertical weight`, value: source.verticalWeight, unit: "unitless" as const },
  { name: `${source.stationId} lower wind from`, value: source.lowerWindFromDegTrue ?? 0, unit: "degrees-true" as const },
  { name: `${source.stationId} lower wind speed`, value: source.lowerWindSpeedKt, unit: "knots" as const },
  { name: `${source.stationId} upper wind from`, value: source.upperWindFromDegTrue ?? 0, unit: "degrees-true" as const },
  { name: `${source.stationId} upper wind speed`, value: source.upperWindSpeedKt, unit: "knots" as const },
  ...(source.temperatureLowerAltitudeFeet === null ? [] : [{ name: `${source.stationId} temperature lower altitude`, value: source.temperatureLowerAltitudeFeet, unit: "feet-msl" as const }]),
  ...(source.temperatureUpperAltitudeFeet === null ? [] : [{ name: `${source.stationId} temperature upper altitude`, value: source.temperatureUpperAltitudeFeet, unit: "feet-msl" as const }]),
  ...(source.temperatureVerticalWeight === null ? [] : [{ name: `${source.stationId} temperature vertical weight`, value: source.temperatureVerticalWeight, unit: "unitless" as const }]),
  ...(source.temperatureLowerC === null ? [] : [{ name: `${source.stationId} lower temperature`, value: source.temperatureLowerC, unit: "celsius" as const }]),
  ...(source.temperatureUpperC === null ? [] : [{ name: `${source.stationId} upper temperature`, value: source.temperatureUpperC, unit: "celsius" as const }]),
];
const departureBlendTraceInputs = (blend?: DepartureBlendEvidence) => blend === undefined ? [] : [
  { name: "departure METAR station", value: blend.stationIcao, unit: "unitless" as const },
  { name: "departure blend aloft request id", value: blend.aloftRequestId, unit: "unitless" as const },
  { name: "departure blend aloft latitude", value: blend.aloftLatitudeDeg, unit: "degrees" as const },
  { name: "departure blend aloft longitude", value: blend.aloftLongitudeDeg, unit: "degrees" as const },
  { name: "departure METAR wind from", value: blend.directionFromDegTrue, unit: "degrees-true" as const },
  { name: "departure METAR wind speed", value: blend.speedKt, unit: "knots" as const },
  { name: "departure field elevation", value: blend.fieldElevationFeetMsl, unit: "feet-msl" as const },
  { name: "departure aloft answer altitude", value: blend.aloftAltitudeFeetMsl, unit: "feet-msl" as const },
  { name: "departure climb midpoint altitude", value: blend.midpointAltitudeFeetMsl, unit: "feet-msl" as const },
  { name: "departure surface-to-aloft blend fraction", value: blend.fraction, unit: "unitless" as const },
];
const arrivalTraceInputs = (arrival?: SelectedArrivalWind) => arrival === undefined ? [] : arrival.source === "metar" ? [
  { name: "destination METAR station", value: arrival.stationIcao, unit: "unitless" as const },
  { name: "destination METAR request id", value: arrival.requestId, unit: "unitless" as const },
  { name: "destination METAR report source", value: arrival.reportSource, unit: "unitless" as const },
  { name: "destination METAR fetched at", value: arrival.fetchedAt, unit: "unitless" as const },
  { name: "destination METAR observed at", value: arrival.observedAt, unit: "unitless" as const },
  { name: "destination METAR raw", value: arrival.raw, unit: "unitless" as const },
  { name: "destination METAR cache status", value: arrival.cacheProvenance.status, unit: "unitless" as const },
  { name: "destination METAR cache source", value: arrival.cacheProvenance.source, unit: "unitless" as const },
  { name: "destination METAR cache freshness remaining seconds", value: arrival.cacheProvenance.freshnessRemainingSeconds, unit: "unitless" as const },
  { name: "destination METAR wind from", value: arrival.effectiveWind.directionFromDegTrue, unit: "degrees-true" as const },
  { name: "destination METAR wind speed", value: arrival.effectiveWind.speedKt, unit: "knots" as const },
] : [
  { name: "destination TAF selected group kind", value: arrival.selectedGroup.kind, unit: "unitless" as const },
  { name: "destination TAF selected group from", value: arrival.selectedGroup.fromUtc, unit: "unitless" as const },
  { name: "destination TAF selected group until", value: arrival.selectedGroup.untilUtc, unit: "unitless" as const },
  { name: "destination TAF selected group raw", value: arrival.selectedGroup.raw, unit: "unitless" as const },
  ...arrival.candidates.flatMap((candidate, index) => [
    { name: `TAF candidate ${index + 1} kind`, value: candidate.group.kind, unit: "unitless" as const },
    { name: `TAF candidate ${index + 1} from`, value: candidate.group.fromUtc, unit: "unitless" as const },
    { name: `TAF candidate ${index + 1} until`, value: candidate.group.untilUtc, unit: "unitless" as const },
    { name: `TAF candidate ${index + 1} groundspeed`, value: candidate.groundspeedKt, unit: "knots" as const },
    { name: `TAF candidate ${index + 1} selected`, value: candidate.group === arrival.selectedGroup, unit: "unitless" as const },
  ]),
];

const coordinateAtLineDistance = (line: RouteLine, routeDistance: number): Coordinate => {
  const offset = nauticalMiles(Math.max(0, Math.min(line.leg.distance, routeDistance - line.startDistance)));
  if (!offset.ok) throw new RouteWeatherSamplingError(offset.error.message);
  const point = pointAlongGreatCircle(line.leg.start.coordinate, line.leg.trueCourse, offset.value);
  if (!point.ok) throw new RouteWeatherSamplingError(point.error.message);
  return point.value;
};
const coordinateAtRouteDistance = (lines: readonly RouteLine[], routeDistance: number): Coordinate => {
  const line = lines.find((candidate) => routeDistance <= candidate.endDistance + 1e-8) ?? lines.at(-1)!;
  return coordinateAtLineDistance(line, routeDistance);
};
const estimateRemainingMinutes = (lines: readonly RouteLine[], from: number, to: number, tas: number, localWind: Wind): number => {
  const checkedTas = knots(tas);
  if (!checkedTas.ok) throw new RouteWeatherSamplingError("Descent true airspeed is invalid.");
  let minutes = 0;
  for (const line of lines) {
    const segmentStart = Math.max(from, line.startDistance), segmentEnd = Math.min(to, line.endDistance);
    const segmentDistance = Math.max(0, segmentEnd - segmentStart);
    if (segmentDistance <= 1e-8) continue;
    const triangle = solveWindTriangle(courseForLineInterval(line, segmentStart, segmentEnd), checkedTas.value, localWind);
    if (!triangle.ok) throw new RouteWeatherSamplingError("Could not estimate destination arrival from top-of-descent weather.");
    minutes += segmentDistance / triangle.value.groundspeed * 60;
  }
  return Math.max(0, minutes);
};
interface GeneratedRouteBoundary {
  readonly kind: "top-of-climb" | "top-of-descent";
  readonly routeDistanceNauticalMiles: number;
  readonly coordinate: Coordinate;
  readonly sourceLegId: string;
  readonly placementTrace: readonly { readonly name: string; readonly value: number; readonly unit: string }[];
}
const makeGeneratedBoundary = (kind: GeneratedRouteBoundary["kind"], line: RouteLine, distance: number, location: Coordinate, placementTrace: GeneratedRouteBoundary["placementTrace"]): GeneratedRouteBoundary => ({ kind, routeDistanceNauticalMiles: distance, coordinate: location, sourceLegId: line.leg.sourceLeg.id, placementTrace });
const tocPlacementTrace = (rate: number, tas: number, rows: readonly { readonly subleg: AllocatedNavlogSubleg; readonly estimatedTimeEnroute: number }[]) => [
  { name: "TOC starting altitude", value: rows[0]?.subleg.startingAltitude ?? 0, unit: "feet-msl" },
  { name: "TOC target altitude", value: rows.at(-1)?.subleg.endingAltitude ?? 0, unit: "feet-msl" },
  { name: "TOC climb rate", value: rate, unit: "feet-per-minute" },
  { name: "TOC true airspeed", value: tas, unit: "knots" },
  { name: "TOC cumulative climb time", value: rows.reduce((sum, row) => sum + row.estimatedTimeEnroute, 0), unit: "minutes" },
  { name: "TOC cumulative climb distance", value: rows.reduce((sum, row) => sum + Number(row.subleg.distance), 0), unit: "nautical-miles" },
];
const todPlacementTrace = (startAltitude: number, targetAltitude: number, rate: number, tas: number, noWindDistance: number) => [
  { name: "TOD start altitude", value: startAltitude, unit: "feet-msl" },
  { name: "TOD target altitude", value: targetAltitude, unit: "feet-msl" },
  { name: "TOD altitude difference", value: startAltitude - targetAltitude, unit: "feet" },
  { name: "TOD descent rate", value: rate, unit: "feet-per-minute" },
  { name: "TOD true airspeed", value: tas, unit: "knots" },
  { name: "TOD no-wind placement distance", value: noWindDistance, unit: "nautical-miles" },
];
const progressiveBoundaries = (boundaries: readonly GeneratedRouteBoundary[]) => boundaries
  .map((boundary, index) => ({ id: `generated-${boundary.kind === "top-of-climb" ? "toc" : "tod"}-${index + 1}`, kind: boundary.kind, routeDistanceNauticalMiles: boundary.routeDistanceNauticalMiles, coordinate: boundary.coordinate, sourceLegId: boundary.sourceLegId, placementTrace: boundary.placementTrace }));
const phaseEvidence = (rows: readonly { readonly subleg: AllocatedNavlogSubleg; readonly estimatedTimeEnroute: number; readonly fuel: number }[]) => {
  const groups = new Map<string, typeof rows[number][]>();
  for (const row of rows) groups.set(row.subleg.phaseId, [...(groups.get(row.subleg.phaseId) ?? []), row]);
  return [...groups.entries()].map(([id, phaseRows]) => ({ id, kind: phaseRows[0]!.subleg.phase, startRouteDistance: phaseRows[0]!.subleg.routeStartDistance, endRouteDistance: phaseRows.at(-1)!.subleg.routeEndDistance, startingAltitude: phaseRows[0]!.subleg.startingAltitude, targetAltitude: phaseRows.at(-1)!.subleg.endingAltitude, calculation: { durationMinutes: phaseRows.reduce((sum, row) => sum + row.estimatedTimeEnroute, 0), fuelGallons: phaseRows.reduce((sum, row) => sum + row.fuel, 0), distanceNauticalMiles: phaseRows.reduce((sum, row) => sum + row.subleg.distance, 0), trace: trace("progressive-route-phase", [], [], { name: "phase duration", value: phaseRows.reduce((sum, row) => sum + row.estimatedTimeEnroute, 0), unit: "minutes" }, "Aggregated from finalized progressive rows.") }, convergenceIterations: 1 }));
};

const buildWaypointTargets = (draft: PlanDraft, lines: readonly RouteLine[]): WaypointTarget[] => draft.route.points.map((routePoint, index) => ({
  routeDistance: index === 0 ? 0 : lines[index - 1]!.endDistance,
  coordinate: routePoint.coordinate,
  altitudeFeetMsl: aloftAltitudeAtWaypoint(draft, index),
}));
const queryAt = (target: WaypointTarget, plannedUtc: string): AloftPointQuery => ({ latitudeDeg: canonicalPointCoordinateDegrees(target.coordinate.latitude), longitudeDeg: canonicalPointCoordinateDegrees(target.coordinate.longitude), altitudeFeetMsl: Math.round(target.altitudeFeetMsl), plannedUtc });
const fetchOnePointAnswer = async (client: RouteWeatherPointClient, query: AloftPointQuery): Promise<AloftPointAnswer> => {
  const answer = await client.fetchPoint(query);
  validateAnswer(query, answer);
  return answer;
};
const sampleFromAnswer = (target: WaypointTarget, query: AloftPointQuery, answer: AloftPointAnswer): RouteWeatherSample => ({ routeDistanceNauticalMiles: target.routeDistance, plannedUtc: query.plannedUtc, altitudeFeetMsl: query.altitudeFeetMsl, answer });
const answerCovers = (answer: AloftPointAnswer, timeMs: number): boolean => timeMs >= Date.parse(answer.issuedAt) && timeMs >= Date.parse(answer.useFrom) && timeMs < Date.parse(answer.useUntil);


export class RouteWeatherSamplingError extends Error {
  public constructor(message: string) { super(message); this.name = "RouteWeatherSamplingError"; }
}

const buildRouteLegs = (draft: PlanDraft): CompletePlanRouteLeg[] => {
  const points = new Map(draft.route.points.map((point) => [point.id, point]));
  const result: CompletePlanRouteLeg[] = [];
  for (const sourceLeg of draft.route.legs) {
    const start = points.get(sourceLeg.fromPointId), end = points.get(sourceLeg.toPointId);
    if (start === undefined || end === undefined) throw new RouteWeatherSamplingError(`Route leg ${sourceLeg.id} references a missing point.`);
    const geometry = calculateGreatCircleDistanceAndInitialCourse(start.coordinate, end.coordinate);
    if (!geometry.ok) throw new RouteWeatherSamplingError(geometry.error.message);
    const midpointDistance = nauticalMiles(geometry.value.distance / 2);
    if (!midpointDistance.ok) throw new RouteWeatherSamplingError(midpointDistance.error.message);
    const midpoint = pointAlongGreatCircle(start.coordinate, geometry.value.initialTrueCourse, midpointDistance.value);
    if (!midpoint.ok) throw new RouteWeatherSamplingError(midpoint.error.message);
    result.push({
      sourceLeg, start, end, distance: geometry.value.distance, trueCourse: geometry.value.initialTrueCourse,
      magneticCoordinate: midpoint.value,
      magneticVariation: calculatePlanningMagneticVariation({ coordinate: midpoint.value, date: new Date(draft.departureTimeUtc), altitudeFeetMsl: sourceLeg.cruiseAltitudeFeetMsl }),
    });
  }
  return result;
};

const routeLines = (routeLegs: readonly CompletePlanRouteLeg[]): RouteLine[] => {
  let distance = 0;
  return routeLegs.map((leg) => {
    const startDistance = distance;
    distance += leg.distance;
    return { leg, startDistance, endDistance: distance };
  });
};

const checkedRate = (value: number, phase: string): number => {
  if (!Number.isFinite(value) || value <= 0) throw new RouteWeatherSamplingError(`${phase} rate must be finite and positive.`);
  return value;
};
/** Departure uses outbound leg altitude; later waypoints use inbound leg altitude. */
const aloftAltitudeAtWaypoint = (draft: PlanDraft, index: number): number => {
  const legIndex = index === 0 ? 0 : Math.min(index - 1, draft.route.legs.length - 1);
  const altitude = draft.route.legs[legIndex]?.cruiseAltitudeFeetMsl;
  const departurePoint = draft.route.points[0];
  const departureElevation = departurePoint?.kind === "airport" ? departurePoint.elevationFeetMsl : 0;
  if (altitude === undefined || altitude < 3_000 || altitude > 53_000) throw new RouteWeatherSamplingError(`Waypoint ${index + 1} has no supported selected aloft altitude.`);
  if (index === 0 && altitude < departureElevation) throw new RouteWeatherSamplingError("Departure cruise altitude is below the departure field elevation.");
  return altitude;
};

const validateAnswer = (query: AloftPointQuery, answer: AloftPointAnswer): void => {
  if (!matchesPointQuery(query, answer)) throw new RouteWeatherSamplingError("A point-weather response does not match its requested waypoint, altitude, and UTC.");
  if (!hasSupportedPointWind(answer)) throw new RouteWeatherSamplingError("A point-weather response contains an unsupported wind value.");
  if (!pointAnswerCoversQuery(query, answer)) throw new RouteWeatherSamplingError("A point-weather response does not cover its planned waypoint UTC.");
};
const matchesPointQuery = (query: AloftPointQuery, answer: AloftPointAnswer): boolean =>
  answer.query.latitudeDeg === query.latitudeDeg && answer.query.longitudeDeg === query.longitudeDeg && answer.query.altitudeFeetMsl === query.altitudeFeetMsl && answer.query.plannedUtc === query.plannedUtc;
const hasSupportedPointWind = (answer: AloftPointAnswer): boolean => Number.isFinite(answer.windSpeedKt) && answer.windSpeedKt >= 0 && answer.windSpeedKt <= 199 && (answer.windFromDegTrue === null ? answer.windSpeedKt === 0 : answer.windFromDegTrue >= 0 && answer.windFromDegTrue <= 360);
const pointAnswerCoversQuery = (query: AloftPointQuery, answer: AloftPointAnswer): boolean => {
  const at = Date.parse(query.plannedUtc), issued = Date.parse(answer.issuedAt), from = Date.parse(answer.useFrom), until = Date.parse(answer.useUntil);
  return [at, issued, from, until].every(Number.isFinite) && issued <= at && at >= from && at < until;
};

const validateDepartureMetar = (draft: PlanDraft, departure: Extract<CompletePlanRouteLeg["start"], { kind: "airport" }>, metar: MetarSuccessPayload): void => {
  const allowedIcaos = new Set([departure.icao, draft.weatherSelection?.departureMetarIcao, draft.weatherSelection?.surfaceWeatherIcao].filter((icao): icao is string => icao !== undefined));
  if (!isFreshDepartureMetar(metar, allowedIcaos, Date.parse(draft.departureTimeUtc))) throw new RouteWeatherSamplingError("A fresh, identity-matched departure METAR is required for the departure surface anchor.");
};
const isFreshDepartureMetar = (metar: MetarSuccessPayload, allowedIcaos: ReadonlySet<string>, departureMs: number): boolean => {
  const observed = metar.metar.observedAt === null ? Number.NaN : Date.parse(metar.metar.observedAt);
  return allowedIcaos.has(metar.metar.icao) && Number.isFinite(observed) && observed <= departureMs && departureMs - observed <= MAX_METAR_AGE_MS && metar.provenance.cache.status !== "stale_on_error" && metar.provenance.cache.freshnessRemainingSeconds > 0 && metarWind(metar) !== null;
};

const weatherFor = (
  routeLegs: readonly CompletePlanRouteLeg[], samples: readonly RouteWeatherSample[], metar: MetarSuccessPayload,
  taf: TafAnswer, arrival: SelectedArrivalWind, totalDistance: number,
): CompletePlanWeather => ({
  snapshotIds: [...new Set(samples.map((sample) => sample.answer.requestId))],
  routeWeatherSamples: samples,
  departureMetarPayload: metar,
  destinationTafPayload: taf,
  arrivalTafWind: arrival,
  phaseWindResolver: createWaypointPhaseResolver(routeLegs, samples, metar, arrival, totalDistance),
  warnings: [
    arrival.surfaceToPatternAssumption,
    "Each route interval uses weather fetched at its starting waypoint or generated top-of-climb/top-of-descent event.",
  ],
  provenance: jsonValue({ source: "progressive-route-point-winds", eventCount: samples.length, waypointAltitudeRule: "carried aircraft altitude with a 3000-foot supported minimum", arrivalTafSelection: arrival }),
});

export const createWaypointPhaseResolver = (
  routeLegs: readonly CompletePlanRouteLeg[], samples: readonly RouteWeatherSample[], _metar: MetarSuccessPayload,
  arrival: SelectedArrivalWind, totalDistance: number,
): EffectiveWindResolver => ({
  resolveEffectiveWind: (request) => {
    const distance = projectRouteDistance(routeLegs, request.start);
    if (isTerminalPhase(request.phase) && distance >= totalDistance - TERMINAL_PATTERN_DISTANCE_NM) {
      return success(requiredWind(arrival.effectiveWind.directionFromDegTrue, arrival.effectiveWind.speedKt));
    }
    const sample = [...samples].reverse().find((candidate) => candidate.routeDistanceNauticalMiles <= distance + 1e-8) ?? samples[0];
    if (sample === undefined) return failure("INVALID_WIND_SAMPLING", "No preceding progressive weather event is available.");
    return success(pointWind(sample.answer));
  },
});

const isTerminalPhase = (phase: string): boolean => phase === "descent" || phase === "pattern" || phase === "terminal";
const blendDepartureSurface = (routeLegs: readonly CompletePlanRouteLeg[], aloftAnswer: AloftPointAnswer, metar: MetarSuccessPayload, altitude: number): Wind => {
  const surface = metarWind(metar);
  const fieldElevation = routeLegs[0]!.start.kind === "airport" ? routeLegs[0]!.start.elevationFeetMsl : 0;
  const selectedAloftAltitude = aloftAnswer.query.altitudeFeetMsl;
  if (surface === null || selectedAloftAltitude <= fieldElevation) throw new RouteWeatherSamplingError("Departure surface-to-aloft wind cannot be interpolated.");
  const fraction = Math.max(0, Math.min(1, (altitude - fieldElevation) / (selectedAloftAltitude - fieldElevation)));
  return interpolateWind(surface, pointWind(aloftAnswer), fraction);
};

const interpolateWind = (lower: Wind, upper: Wind, fraction: number): Wind => {
  const a = windToVector(lower), b = windToVector(upper);
  const result = vectorToWind({ north: a.north + (b.north - a.north) * fraction, east: a.east + (b.east - a.east) * fraction });
  if (!result.ok) throw new RouteWeatherSamplingError(result.error.message);
  return result.value;
};
const pointWind = (answer: AloftPointAnswer): Wind => requiredWind(answer.windFromDegTrue ?? 0, answer.windSpeedKt);
const requiredWind = (direction: number, speed: number): Wind => {
  const result = wind(direction, speed);
  if (!result.ok) throw new RouteWeatherSamplingError(result.error.message);
  return result.value;
};
const metarWind = (metar: MetarSuccessPayload): Wind | null => {
  const value = metar.metar.wind;
  if (value.directionType === "variable") return null;
  const result = wind(value.directionType === "calm" ? 0 : value.directionDegTrue ?? 0, value.speedKt);
  return result.ok ? result.value : null;
};

const projectRouteDistance = (routeLegs: readonly CompletePlanRouteLeg[], target: Coordinate): number => {
  const candidates = routeLines(routeLegs).map((line) => projectOntoRouteLine(line, target));
  return candidates.reduce((nearest, candidate) => candidate.distance < nearest.distance ? candidate : nearest).routeDistance;
};
const projectOntoRouteLine = (line: RouteLine, target: Coordinate): { readonly distance: number; readonly routeDistance: number } => {
  if (sameCoordinate(line.leg.start.coordinate, target)) return { distance: 0, routeDistance: line.startDistance };
  if (sameCoordinate(line.leg.end.coordinate, target)) return { distance: 0, routeDistance: line.endDistance };
  const fromStart = calculateGreatCircleDistanceAndInitialCourse(line.leg.start.coordinate, target);
  if (!fromStart.ok) throw new RouteWeatherSamplingError(fromStart.error.message);
  const delta13 = fromStart.value.distance / MEAN_EARTH_RADIUS_NAUTICAL_MILES;
  const deltaTheta = degreesToRadians(fromStart.value.initialTrueCourse - line.leg.trueCourse);
  const crossTrack = Math.asin(Math.sin(delta13) * Math.sin(deltaTheta)) * MEAN_EARTH_RADIUS_NAUTICAL_MILES;
  const alongTrack = Math.atan2(Math.sin(delta13) * Math.cos(deltaTheta), Math.cos(delta13)) * MEAN_EARTH_RADIUS_NAUTICAL_MILES;
  if (alongTrack < 0) return { distance: fromStart.value.distance, routeDistance: line.startDistance };
  if (alongTrack > line.leg.distance) {
    const toEnd = calculateGreatCircleDistanceAndInitialCourse(line.leg.end.coordinate, target);
    if (!toEnd.ok) throw new RouteWeatherSamplingError(toEnd.error.message);
    return { distance: toEnd.value.distance, routeDistance: line.endDistance };
  }
  return { distance: Math.abs(crossTrack), routeDistance: line.startDistance + alongTrack };
};

const sameCoordinate = (left: Coordinate, right: Coordinate): boolean => Math.abs(left.latitude - right.latitude) < 1e-8 && Math.abs((((left.longitude - right.longitude) + 540) % 360) - 180) < 1e-8;

const jsonValue = (value: unknown): JsonValue => {
  assertFiniteJsonInput(value, "snapshot", new WeakSet<object>());
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new RouteWeatherSamplingError("Progressive calculation snapshot is not serializable.");
  return JSON.parse(serialized) as JsonValue;
};
const assertFiniteJsonInput = (value: unknown, path: string, seen: WeakSet<object>): void => {
  if (typeof value === "number" && !Number.isFinite(value)) throw new RouteWeatherSamplingError(`Progressive calculation snapshot contains a non-finite number at ${path}.`);
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) throw new RouteWeatherSamplingError(`Progressive calculation snapshot contains a cycle at ${path}.`);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => assertFiniteJsonInput(item, `${path}[${index}]`, seen));
  else Object.entries(value).forEach(([key, item]) => assertFiniteJsonInput(item, `${path}.${key}`, seen));
  seen.delete(value);
};
