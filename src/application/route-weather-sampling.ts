import type { AloftPointAnswer, AloftPointQuery, MetarSuccessPayload, TafAnswer } from "../../worker/api/contracts";
import { calculateGreatCircleDistanceAndInitialCourse, pointAlongGreatCircle, MEAN_EARTH_RADIUS_NAUTICAL_MILES } from "../domain/distance-course";
import { failure, success, type DomainResult } from "../domain/errors";
import { averageWindSamples, vectorToWind, wind, windToVector, type Wind } from "../domain/wind";
import { nauticalMiles, knots, degreesToRadians } from "../domain/units";
import { solveWindTriangle } from "../domain/wind-triangle";
import type { EffectiveWindResolver } from "../domain/phase-planning";
import type { PlanDraft, JsonValue } from "../domain/route";
import type { AircraftProfile } from "../domain/aircraft";
import type { Coordinate } from "../domain/coordinates";
import { trace } from "../domain/calculation-trace";
import { MAX_CHECKPOINTS_PER_PLAN } from "../services/storage/pilot-input-repository";
import { selectArrivalTafWind, type SelectedArrivalWind } from "./arrival-taf-wind";
import { calculatePlanningMagneticVariation } from "./magnetic-variation";
import type { CompletePlanRouteLeg, CompletePlanWeather, RouteWeatherSample } from "./complete-plan";
import type { AllocatedNavlogSubleg, NavlogWindResolver } from "./navlog-calculation";

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

/**
 * Fetches exactly one aloft point per pilot waypoint in route order. Each
 * corrected leg ETA determines the next query; final navlog timing is checked
 * against every immutable answer and adjacent product-window coverage.
 */
export const resolveRouteWeather = async (
  draft: PlanDraft,
  profile: AircraftProfile,
  pointClient: RouteWeatherPointClient,
  endpoints: { readonly departureMetar: MetarSuccessPayload; readonly destinationTaf: TafAnswer },
): Promise<RouteWeatherSolution> => {
  const prepared = prepareRouteWeatherInputs(draft, profile, endpoints);
  const progressive = await collectProgressiveSamples(draft, profile, pointClient, prepared.targets, prepared.lines, prepared.footprints);
  const arrivalWind = selectArrivalTafWind(endpoints.destinationTaf, new Date(progressive.arrivalMs).toISOString(), prepared.routeLegs.at(-1)!.trueCourse, profile.descentTasKnots);
  const weather = weatherFor(draft, prepared.routeLegs, progressive.samples, endpoints.departureMetar, endpoints.destinationTaf, arrivalWind, prepared.totalDistance, profile);
  return { weather, sampledPoints: progressive.samples.map((sample) => sample.answer), iterations: 1 };
};

interface PreparedRouteWeatherInputs {
  readonly routeLegs: readonly CompletePlanRouteLeg[];
  readonly lines: readonly RouteLine[];
  readonly totalDistance: number;
  readonly targets: readonly WaypointTarget[];
  readonly footprints: readonly PhaseFootprint[];
}
const prepareRouteWeatherInputs = (
  draft: PlanDraft, profile: AircraftProfile, endpoints: { readonly departureMetar: MetarSuccessPayload; readonly destinationTaf: TafAnswer },
): PreparedRouteWeatherInputs => {
  if (draft.route.points.length > MAX_ROUTE_WAYPOINTS) throw new RouteWeatherSamplingError(`Route exceeds the ${MAX_ROUTE_WAYPOINTS}-waypoint weather limit.`);
  if (draft.route.points.length < 2 || draft.route.legs.length !== draft.route.points.length - 1) throw new RouteWeatherSamplingError("Route weather requires one leg between every adjacent waypoint.");
  const routeLegs = buildRouteLegs(draft), lines = routeLines(routeLegs), totalDistance = lines.at(-1)?.endDistance;
  if (totalDistance === undefined || totalDistance <= 0) throw new RouteWeatherSamplingError("A complete route is required for route weather sampling.");
  const departure = routeLegs[0]!.start, destination = routeLegs.at(-1)!.end;
  if (departure.kind !== "airport" || destination.kind !== "airport") throw new RouteWeatherSamplingError("Route weather requires airport departure and destination endpoints.");
  validateDepartureMetar(draft, departure, endpoints.departureMetar);
  const selectedDestinationIcao = draft.weatherSelection?.destinationTafIcao ?? destination.icao;
  if (endpoints.destinationTaf.stationIcao !== selectedDestinationIcao) throw new RouteWeatherSamplingError("Destination TAF station does not match the selected destination source.");
  const targets = buildWaypointTargets(draft, lines);
  return { routeLegs, lines, totalDistance, targets, footprints: buildPhaseFootprints(draft, profile, lines, totalDistance) };
};

const collectProgressiveSamples = async (
  draft: PlanDraft, profile: AircraftProfile, client: RouteWeatherPointClient,
  targets: readonly WaypointTarget[], lines: readonly RouteLine[], footprints: readonly PhaseFootprint[],
): Promise<{ readonly samples: readonly RouteWeatherSample[]; readonly arrivalMs: number }> => {
  let carriedArrivalMs = Date.parse(draft.departureTimeUtc);
  const firstQuery = queryAt(targets[0]!, draft.departureTimeUtc);
  const firstAnswer = await fetchOnePointAnswer(client, firstQuery);
  const samples: RouteWeatherSample[] = [sampleFromAnswer(targets[0]!, firstQuery, firstAnswer)];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!, target = targets[index + 1]!;
    const provisionalMinutes = estimateLegMinutes(line, footprints, profile, samples[index]!, undefined, true);
    const query = queryAt(target, new Date(carriedArrivalMs + provisionalMinutes * 60_000).toISOString());
    const answer = await fetchOnePointAnswer(client, query);
    const nextSample = sampleFromAnswer(target, query, answer);
    const correctedMinutes = estimateLegMinutes(line, footprints, profile, samples[index]!, nextSample, false);
    carriedArrivalMs += correctedMinutes * 60_000;
    if (!answerCovers(answer, carriedArrivalMs)) throw new RouteWeatherSamplingError(`Winds-aloft period does not cover the corrected arrival at waypoint ${index + 2}.`);
    samples.push(nextSample);
  }
  return { samples, arrivalMs: carriedArrivalMs };
};

const buildWaypointTargets = (draft: PlanDraft, lines: readonly RouteLine[]): WaypointTarget[] => draft.route.points.map((routePoint, index) => ({
  routeDistance: index === 0 ? 0 : lines[index - 1]!.endDistance,
  coordinate: routePoint.coordinate,
  altitudeFeetMsl: aloftAltitudeAtWaypoint(draft, index),
}));
const queryAt = (target: WaypointTarget, plannedUtc: string): AloftPointQuery => ({ latitudeDeg: target.coordinate.latitude, longitudeDeg: target.coordinate.longitude, altitudeFeetMsl: Math.round(target.altitudeFeetMsl), plannedUtc });
const fetchOnePointAnswer = async (client: RouteWeatherPointClient, query: AloftPointQuery): Promise<AloftPointAnswer> => {
  const answer = await client.fetchPoint(query);
  validateAnswer(query, answer);
  return answer;
};
const sampleFromAnswer = (target: WaypointTarget, query: AloftPointQuery, answer: AloftPointAnswer): RouteWeatherSample => ({ routeDistanceNauticalMiles: target.routeDistance, plannedUtc: query.plannedUtc, altitudeFeetMsl: target.altitudeFeetMsl, answer });
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

interface PhaseFootprint { readonly start: number; readonly end: number; readonly minutes: number; readonly phase: "climb" | "descent"; }
const buildPhaseFootprints = (draft: PlanDraft, profile: AircraftProfile, lines: readonly RouteLine[], totalDistance: number): readonly PhaseFootprint[] => {
  const result: PhaseFootprint[] = [];
  const departureAltitude = lines[0]!.leg.start.kind === "airport" ? lines[0]!.leg.start.elevationFeetMsl : 0;
  if (lines[0]!.leg.sourceLeg.cruiseAltitudeFeetMsl < departureAltitude) throw new RouteWeatherSamplingError("Departure cruise altitude is below the departure field elevation.");
  addPhaseFootprint(result, 0, departureAltitude, lines[0]!.leg.sourceLeg.cruiseAltitudeFeetMsl, profile.climbRateFeetPerMinute, profile.climbTasKnots, false);
  for (let index = 1; index < lines.length; index += 1) {
    const from = lines[index - 1]!.leg.sourceLeg.cruiseAltitudeFeetMsl, to = lines[index]!.leg.sourceLeg.cruiseAltitudeFeetMsl;
    if (from !== to) addPhaseFootprint(result, lines[index - 1]!.endDistance, from, to, to > from ? profile.climbRateFeetPerMinute : profile.descentRateFeetPerMinute, to > from ? profile.climbTasKnots : profile.descentTasKnots, false);
  }
  const finalAltitude = lines.at(-1)!.leg.sourceLeg.cruiseAltitudeFeetMsl;
  addPhaseFootprint(result, totalDistance, finalAltitude, draft.descentTargetAltitudeFeetMsl.effectiveValue, profile.descentRateFeetPerMinute, profile.descentTasKnots, true);
  return result;
};
const addPhaseFootprint = (result: PhaseFootprint[], anchor: number, from: number, to: number, rate: number, tas: number, backward: boolean): void => {
  if (from === to) return;
  const minutes = Math.abs(to - from) / checkedRate(rate, "vertical"), distance = tas * minutes / 60;
  result.push({ start: backward ? anchor - distance : anchor, end: backward ? anchor : anchor + distance, minutes, phase: to > from ? "climb" : "descent" });
};
interface TravelSegment { readonly start: number; readonly end: number; readonly phase?: PhaseFootprint["phase"]; readonly minutes: number; }
const legTravelSegments = (line: RouteLine, phases: readonly PhaseFootprint[]): TravelSegment[] => {
  const relevant = phases.map((phase) => ({ phase, start: Math.max(line.startDistance, phase.start), end: Math.min(line.endDistance, phase.end) })).filter((part) => part.end > part.start).sort((a, b) => a.start - b.start);
  const segments: TravelSegment[] = [];
  let cursor = line.startDistance;
  for (const part of relevant) {
    if (part.start < cursor - 1e-6) throw new RouteWeatherSamplingError("Vertical phase assumptions overlap on this route leg.");
    if (part.start > cursor) segments.push({ start: cursor, end: part.start, minutes: 0 });
    segments.push({ start: part.start, end: part.end, phase: part.phase.phase, minutes: part.phase.minutes * (part.end - part.start) / (part.phase.end - part.phase.start) });
    cursor = part.end;
  }
  if (cursor < line.endDistance) segments.push({ start: cursor, end: line.endDistance, minutes: 0 });
  return segments;
};
const estimateLegMinutes = (line: RouteLine, phases: readonly PhaseFootprint[], profile: AircraftProfile, start: RouteWeatherSample, end: RouteWeatherSample | undefined, provisional: boolean): number => {
  return legTravelSegments(line, phases).reduce((elapsed, segment) => elapsed + (segment.phase === undefined ? cruiseMinutesForSegment(segment, line, start, end, profile, provisional) : segment.minutes), 0);
};
const cruiseMinutesForSegment = (segment: TravelSegment, line: RouteLine, start: RouteWeatherSample, end: RouteWeatherSample | undefined, profile: AircraftProfile, provisional: boolean): number => {
  const tas = knots(cruiseTas(line.leg, profile));
  if (!tas.ok) throw new RouteWeatherSamplingError("Cruise true airspeed is invalid.");
  const positions = [0, 0.25, 0.5, 0.75, 1];
  let elapsedHours = 0;
  for (let index = 0; index < positions.length; index += 1) {
    const fraction = positions[index]!;
    const distance = segment.start + (segment.end - segment.start) * fraction;
    const legFraction = line.leg.distance === 0 ? 0 : (distance - line.startDistance) / line.leg.distance;
    const localWind = provisional || end === undefined ? pointWind(start.answer) : interpolateWind(pointWind(start.answer), pointWind(end.answer), legFraction);
    const triangle = solveWindTriangle(line.leg.trueCourse, tas.value, localWind);
    if (!triangle.ok) throw new RouteWeatherSamplingError("Progressive route wind cannot produce a valid groundspeed.");
    const edgeWeight = index === 0 || index === positions.length - 1 ? 0.5 : 1;
    const span = (segment.end - segment.start) / (positions.length - 1) * edgeWeight;
    elapsedHours += span / triangle.value.groundspeed;
  }
  return elapsedHours * 60;
};

const checkedRate = (value: number, phase: string): number => {
  if (!Number.isFinite(value) || value <= 0) throw new RouteWeatherSamplingError(`${phase} rate must be finite and positive.`);
  return value;
};
const cruiseTas = (leg: CompletePlanRouteLeg, profile: AircraftProfile): number => {
  const value = leg.sourceLeg.performanceOverrides?.cruiseTasKnots?.effectiveValue ?? profile.cruiseTasKnots;
  if (!Number.isFinite(value) || value <= 0) throw new RouteWeatherSamplingError("Cruise true airspeed must be finite and positive.");
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
  const expectedIcao = draft.weatherSelection?.departureMetarIcao ?? draft.weatherSelection?.surfaceWeatherIcao ?? departure.icao;
  if (!isFreshDepartureMetar(metar, expectedIcao, Date.parse(draft.departureTimeUtc))) throw new RouteWeatherSamplingError("A fresh, identity-matched departure METAR is required for the departure surface anchor.");
};
const isFreshDepartureMetar = (metar: MetarSuccessPayload, expectedIcao: string, departureMs: number): boolean => {
  const observed = metar.metar.observedAt === null ? Number.NaN : Date.parse(metar.metar.observedAt);
  return metar.metar.icao === expectedIcao && Number.isFinite(observed) && observed <= departureMs && departureMs - observed <= MAX_METAR_AGE_MS && metar.provenance.cache.status !== "stale_on_error" && metar.provenance.cache.freshnessRemainingSeconds > 0 && metarWind(metar) !== null;
};

const weatherFor = (
  draft: PlanDraft, routeLegs: readonly CompletePlanRouteLeg[], samples: readonly RouteWeatherSample[], metar: MetarSuccessPayload,
  taf: TafAnswer, arrival: SelectedArrivalWind, totalDistance: number, profile: AircraftProfile,
): CompletePlanWeather => ({
  snapshotIds: [...new Set(samples.map((sample) => sample.answer.requestId))],
  routeWeatherSamples: samples,
  departureMetarPayload: metar,
  destinationTafPayload: taf,
  arrivalTafWind: arrival,
  phaseWindResolver: createWaypointPhaseResolver(routeLegs, samples, metar, arrival, totalDistance),
  validateCalculatedTiming: (snapshot) => validateFinalTiming(snapshot, draft, samples, taf, arrival, routeLegs.at(-1)!.trueCourse, profile.descentTasKnots),
  warnings: [
    "Departure METAR is used only as a surface anchor at the departure field elevation.",
    arrival.surfaceToPatternAssumption,
    "Winds aloft between route waypoints are estimates formed by interpolating the selected waypoint vectors; no interior weather was fetched.",
  ],
  provenance: jsonValue({ source: "route-waypoint-point-winds", waypointCount: samples.length, waypointAltitudeRule: "departure uses outbound leg altitude; subsequent waypoints use inbound leg altitude", arrivalTafSelection: arrival }),
});

export const createWaypointPhaseResolver = (
  routeLegs: readonly CompletePlanRouteLeg[], samples: readonly RouteWeatherSample[], metar: MetarSuccessPayload,
  arrival: SelectedArrivalWind, totalDistance: number,
): EffectiveWindResolver => ({
  resolveEffectiveWind: (request) => {
    const distance = projectRouteDistance(routeLegs, request.start);
    const altitude = (request.startingAltitudeFeetMsl + request.targetAltitudeFeetMsl) / 2;
    return success(windAtDistance(routeLegs, samples, metar, arrival, totalDistance, distance, request.phase, altitude));
  },
});

export const createWaypointNavlogWindResolver = (
  routeLegs: readonly CompletePlanRouteLeg[], samples: readonly RouteWeatherSample[], weather: CompletePlanWeather, profile: AircraftProfile,
): NavlogWindResolver => ({
  resolveEffectiveWind: ({ subleg }) => resolveWaypointSubleg(subleg, routeLegs, samples, weather, profile),
});

interface LocalWeatherPiece { readonly wind: Wind; readonly timeWeight: number; readonly routeDistance: number; readonly altitude: number; }
const resolveWaypointSubleg = (
  subleg: AllocatedNavlogSubleg, routeLegs: readonly CompletePlanRouteLeg[], samples: readonly RouteWeatherSample[], weather: CompletePlanWeather, profile: AircraftProfile,
): ReturnType<NavlogWindResolver["resolveEffectiveWind"]> => {
  const sourceLeg = routeLegs.find((leg) => leg.sourceLeg.id === subleg.sourceLegId);
  if (sourceLeg === undefined) return failure("ROUTE_GEOMETRY_ERROR", "Weather subleg does not match a pilot route leg.");
  const metar = weather.departureMetarPayload!, arrival = weather.arrivalTafWind!;
  const piecesResult = sampleSublegPieces(subleg, sourceLeg, routeLegs, samples, metar, arrival, profile);
  if (!piecesResult.ok) return piecesResult;
  const pieces = piecesResult.value;
  const effective = averageWindSamples(pieces.map((piece) => ({ wind: piece.wind, weight: piece.timeWeight })));
  if (!effective.ok) return effective;
  const sourceSamples = samplesForInterval(samples, subleg.routeStartDistance, subleg.routeEndDistance);
  const traceInputs = buildWeatherTraceInputs(sourceSamples, routeLegs, metar, arrival, weather.destinationTafPayload!.stationIcao);
  const interpolationTrace = trace(
    "waypoint-vector-route-interpolation", traceInputs,
    pieces.flatMap((piece) => [
      { name: `subleg route position ${piece.routeDistance.toFixed(2)}`, value: piece.routeDistance, unit: "nautical-miles" as const },
      { name: `subleg altitude ${piece.routeDistance.toFixed(2)}`, value: piece.altitude, unit: "feet-msl" as const },
      { name: `subleg time weight ${piece.routeDistance.toFixed(2)}`, value: piece.timeWeight, unit: "unitless" as const },
    ]),
    { name: "effective wind from", value: effective.value.directionFrom, unit: "degrees-true" },
    "Wind components interpolate linearly between waypoint answers and are trapezoidally averaged using profile groundspeed time weights.",
  );
  return success({
    wind: { computedValue: effective.value, effectiveValue: effective.value, origin: "interpolated", provenance: { sourceId: `route-waypoint-weather:${subleg.id}`, sourceLabel: "Interpolated route waypoint winds and endpoint surface weather", sourceVersion: `${sourceSamples.length} waypoint point answers`, recordedAt: sourceSamples[0]?.plannedUtc ?? "" }, explanation: { formulaId: interpolationTrace.formulaId, formulaVersion: "waypoint-vector-route-interpolation/v1" } },
    trace: interpolationTrace,
    ...(subleg.phase === "climb" && subleg.routeStartDistance < 0.001 ? { warnings: ["Planning assumption: departure METAR wind is anchored at field elevation and blended to the departure waypoint aloft answer during climb."] } : {}),
  });
};

const sampleSublegPieces = (
  subleg: AllocatedNavlogSubleg, sourceLeg: CompletePlanRouteLeg, routeLegs: readonly CompletePlanRouteLeg[], samples: readonly RouteWeatherSample[],
  metar: MetarSuccessPayload, arrival: SelectedArrivalWind, profile: AircraftProfile,
): DomainResult<readonly LocalWeatherPiece[]> => {
  const tas = subleg.phase === "cruise" ? cruiseTas(sourceLeg, profile) : isClimbPhase(subleg.phase) ? profile.climbTasKnots : profile.descentTasKnots;
  const positions = [0, 0.25, 0.5, 0.75, 1], pieces: LocalWeatherPiece[] = [];
  for (let index = 0; index < positions.length; index += 1) {
    const fraction = positions[index]!;
    const distance = subleg.routeStartDistance + (subleg.routeEndDistance - subleg.routeStartDistance) * fraction;
    const altitude = subleg.startingAltitude + (subleg.endingAltitude - subleg.startingAltitude) * fraction;
    const localWind = windAtDistance(routeLegs, samples, metar, arrival, samples.at(-1)!.routeDistanceNauticalMiles, distance, subleg.phase, altitude);
    const checkedTas = knots(tas);
    if (!checkedTas.ok) return failure("INVALID_WIND_TRIANGLE", "The subleg true airspeed is invalid.");
    const triangle = solveWindTriangle(subleg.trueCourse, checkedTas.value, localWind);
    if (!triangle.ok) return failure("INVALID_WIND_TRIANGLE", "Interpolated route weather cannot produce a valid groundspeed.");
    const edgeWeight = index === 0 || index === positions.length - 1 ? 0.5 : 1;
    const segmentDistance = (subleg.routeEndDistance - subleg.routeStartDistance) / (positions.length - 1) * edgeWeight;
    pieces.push({ wind: localWind, timeWeight: segmentDistance / triangle.value.groundspeed, routeDistance: distance, altitude });
  }
  return { ok: true, value: pieces };
};
const isClimbPhase = (phase: string): boolean => phase === "climb" || phase === "transition-climb";

const buildWeatherTraceInputs = (sourceSamples: readonly RouteWeatherSample[], routeLegs: readonly CompletePlanRouteLeg[], metar: MetarSuccessPayload, arrival: SelectedArrivalWind, tafStationIcao: string) => [
  ...sourceSamples.flatMap((sample) => [
    { name: `point ${sample.answer.requestId} source`, value: sample.answer.requestId, unit: "unitless" as const },
    { name: `point ${sample.answer.requestId} latitude`, value: sample.answer.query.latitudeDeg, unit: "degrees" as const },
    { name: `point ${sample.answer.requestId} longitude`, value: sample.answer.query.longitudeDeg, unit: "degrees" as const },
    { name: `point ${sample.answer.requestId} altitude`, value: sample.answer.query.altitudeFeetMsl, unit: "feet-msl" as const },
    { name: `point ${sample.answer.requestId} wind from`, value: sample.answer.windFromDegTrue ?? 0, unit: "degrees-true" as const },
    { name: `point ${sample.answer.requestId} wind speed`, value: sample.answer.windSpeedKt, unit: "knots" as const },
    { name: `point ${sample.answer.requestId} planned UTC`, value: sample.answer.query.plannedUtc, unit: "unitless" as const },
    { name: `point ${sample.answer.requestId} issued UTC`, value: sample.answer.issuedAt, unit: "unitless" as const },
    { name: `point ${sample.answer.requestId} use from`, value: sample.answer.useFrom, unit: "unitless" as const },
    { name: `point ${sample.answer.requestId} use until`, value: sample.answer.useUntil, unit: "unitless" as const },
    { name: `point ${sample.answer.requestId} interpolation method`, value: sample.answer.method, unit: "unitless" as const },
    ...sample.answer.sources.flatMap((source) => [
      { name: `${source.stationId} source distance`, value: source.distanceNauticalMiles, unit: "nautical-miles" as const },
      { name: `${source.stationId} horizontal weight`, value: source.horizontalWeight, unit: "unitless" as const },
      { name: `${source.stationId} vertical weight`, value: source.verticalWeight, unit: "unitless" as const },
    ]),
  ]),
  { name: "departure METAR station", value: metar.metar.icao, unit: "unitless" as const },
  { name: "departure METAR wind from", value: metar.metar.wind.directionDegTrue ?? 0, unit: "degrees-true" as const },
  { name: "departure METAR wind speed", value: metar.metar.wind.speedKt, unit: "knots" as const },
  { name: "departure field elevation anchor", value: routeLegs[0]!.start.kind === "airport" ? routeLegs[0]!.start.elevationFeetMsl : 0, unit: "feet-msl" as const },
  { name: "destination TAF station", value: tafStationIcao, unit: "unitless" as const },
  { name: "destination TAF wind from", value: arrival.effectiveWind.directionFromDegTrue, unit: "degrees-true" as const },
  { name: "destination TAF wind speed", value: arrival.effectiveWind.speedKt, unit: "knots" as const },
  { name: "destination TAF group", value: arrival.selectedGroup.kind, unit: "unitless" as const },
  { name: "destination TAF raw group", value: arrival.selectedGroup.raw, unit: "unitless" as const },
  { name: "destination terminal assumption", value: arrival.surfaceToPatternAssumption, unit: "unitless" as const },
];

const windAtDistance = (
  routeLegs: readonly CompletePlanRouteLeg[], samples: readonly RouteWeatherSample[], metar: MetarSuccessPayload,
  arrival: SelectedArrivalWind, totalDistance: number, distance: number, phase: string, altitude: number,
): Wind => {
  const clamped = Math.max(0, Math.min(totalDistance, distance));
  if (isTerminalPhase(phase) && clamped >= totalDistance - TERMINAL_PATTERN_DISTANCE_NM) return requiredWind(arrival.effectiveWind.directionFromDegTrue, arrival.effectiveWind.speedKt);
  const { index, fraction } = locateSamplePair(routeLegs, samples, clamped);
  const aloft = interpolateWind(pointWind(samples[index]!.answer), pointWind(samples[index + 1]!.answer), fraction);
  return index === 0 && isClimbPhase(phase) ? blendDepartureSurface(routeLegs, samples, metar, altitude) : aloft;
};
const isTerminalPhase = (phase: string): boolean => phase === "descent" || phase === "pattern" || phase === "terminal";
const locateSamplePair = (routeLegs: readonly CompletePlanRouteLeg[], samples: readonly RouteWeatherSample[], distance: number): { readonly index: number; readonly fraction: number } => {
  const lines = routeLines(routeLegs);
  const match = lines.findIndex((line) => distance <= line.endDistance + 1e-7);
  const index = match < 0 ? lines.length - 1 : Math.max(0, match);
  const line = lines[index]!;
  if (samples[index] === undefined || samples[index + 1] === undefined) throw new RouteWeatherSamplingError("Waypoint winds do not bracket this route leg.");
  return { index, fraction: line.leg.distance <= 0 ? 0 : Math.max(0, Math.min(1, (distance - line.startDistance) / line.leg.distance)) };
};
const blendDepartureSurface = (routeLegs: readonly CompletePlanRouteLeg[], samples: readonly RouteWeatherSample[], metar: MetarSuccessPayload, altitude: number): Wind => {
  const surface = metarWind(metar);
  const fieldElevation = routeLegs[0]!.start.kind === "airport" ? routeLegs[0]!.start.elevationFeetMsl : 0;
  const selectedAloftAltitude = samples[0]!.altitudeFeetMsl;
  if (surface === null || selectedAloftAltitude <= fieldElevation) throw new RouteWeatherSamplingError("Departure surface-to-aloft wind cannot be interpolated.");
  const fraction = Math.max(0, Math.min(1, (altitude - fieldElevation) / (selectedAloftAltitude - fieldElevation)));
  return interpolateWind(surface, pointWind(samples[0]!.answer), fraction);
};

const samplesForInterval = (samples: readonly RouteWeatherSample[], start: number, end: number): readonly RouteWeatherSample[] => {
  const first = samples.findIndex((sample) => sample.routeDistanceNauticalMiles >= start);
  const last = samples.findIndex((sample) => sample.routeDistanceNauticalMiles >= end);
  const from = first < 0 ? Math.max(0, samples.length - 2) : Math.max(0, first - 1);
  const to = last < 0 ? samples.length - 1 : Math.min(samples.length - 1, last + 1);
  return samples.slice(from, to + 1);
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

const validateFinalTiming = (
  snapshot: JsonValue, draft: PlanDraft, samples: readonly RouteWeatherSample[], taf: TafAnswer,
  initialArrival: SelectedArrivalWind, arrivalCourse: number, arrivalTas: number,
): string | undefined => {
  const rows = asRecord(asRecord(snapshot)?.navlog)?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return "Final waypoint weather periods cannot be verified because the calculation did not produce navlog timing.";
  const waypointTimes = calculateFinalWaypointTimes(rows, draft, samples);
  if (typeof waypointTimes === "string") return waypointTimes;
  return validateFinalArrival(rows, draft, samples, taf, initialArrival, arrivalCourse, arrivalTas) ?? validateLegTimeWindows(samples, waypointTimes);
};
const calculateFinalWaypointTimes = (rows: readonly unknown[], draft: PlanDraft, samples: readonly RouteWeatherSample[]): number[] | string => {
  const times: number[] = [];
  for (const sample of samples) {
    const elapsed = elapsedAtDistance(rows, sample.routeDistanceNauticalMiles);
    if (elapsed === undefined) return "Final waypoint weather coverage is indeterminate for this route.";
    const finalMs = Date.parse(draft.departureTimeUtc) + elapsed * 60_000;
    times.push(finalMs);
    if (finalMs < Date.parse(sample.answer.issuedAt) || finalMs < Date.parse(sample.answer.useFrom) || finalMs >= Date.parse(sample.answer.useUntil)) return `Winds-aloft period no longer covers waypoint ${sample.answer.query.latitudeDeg.toFixed(3)}, ${sample.answer.query.longitudeDeg.toFixed(3)} at its calculated UTC.`;
  }
  return times;
};
const validateLegTimeWindows = (samples: readonly RouteWeatherSample[], times: readonly number[]): string | undefined => {
  for (let index = 0; index < samples.length - 1; index += 1) {
    if (!windowsCoverInterval(samples[index]!.answer, samples[index + 1]!.answer, times[index]!, times[index + 1]!)) return `Winds-aloft report periods leave an uncovered time gap on route leg ${index + 1}.`;
  }
  return undefined;
};
const validateFinalArrival = (
  rows: readonly unknown[], draft: PlanDraft, samples: readonly RouteWeatherSample[], taf: TafAnswer,
  initialArrival: SelectedArrivalWind, arrivalCourse: number, arrivalTas: number,
): string | undefined => {
  const elapsed = elapsedAtDistance(rows, samples.at(-1)!.routeDistanceNauticalMiles);
  if (elapsed === undefined) return "Arrival TAF group could not be verified against the calculated arrival time.";
  try {
    const finalUtc = utcAt(draft.departureTimeUtc, elapsed);
    const final = selectArrivalTafWind(taf, finalUtc, arrivalCourse, arrivalTas);
    return final.selectedGroup.raw === initialArrival.selectedGroup.raw && final.selectedGroup.fromUtc === initialArrival.selectedGroup.fromUtc ? undefined : "Calculated arrival moved into a different TAF wind group; update the plan again for a consistent estimate.";
  } catch { return "Calculated arrival is outside the selected destination TAF's valid period."; }
};

const windowsCoverInterval = (first: AloftPointAnswer, second: AloftPointAnswer, start: number, end: number): boolean => {
  if (end < start) return false;
  let coveredUntil = start;
  const windows = [first, second].map((answer) => ({ from: Math.max(Date.parse(answer.useFrom), Date.parse(answer.issuedAt)), until: Date.parse(answer.useUntil) })).sort((a, b) => a.from - b.from);
  for (const window of windows) {
    if (!Number.isFinite(window.from) || !Number.isFinite(window.until) || window.from > coveredUntil) continue;
    coveredUntil = Math.max(coveredUntil, window.until);
    if (coveredUntil > end) return true;
  }
  return coveredUntil > end;
};

const elapsedAtDistance = (rows: readonly unknown[], distance: number): number | undefined => {
  let elapsed = 0;
  let lastRouteEnd = 0;
  for (const candidate of rows) {
    const segment = timingSegment(candidate);
    if (segment === undefined) continue;
    lastRouteEnd = Math.max(lastRouteEnd, segment.end);
    if (distance >= segment.end - 1e-7) { elapsed += segment.duration; continue; }
    if (distance >= segment.start - 1e-7) return elapsed + segment.duration * Math.max(0, distance - segment.start) / (segment.end - segment.start);
    return elapsed;
  }
  return distance <= lastRouteEnd + 1e-7 ? elapsed : undefined;
};

const timingSegment = (candidate: unknown): { readonly start: number; readonly end: number; readonly duration: number } | undefined => {
  const row = asRecord(candidate), subleg = asRecord(row?.subleg);
  const start = subleg?.routeStartDistance, end = subleg?.routeEndDistance, duration = row?.estimatedTimeEnroute;
  return typeof start === "number" && typeof end === "number" && typeof duration === "number" && end > start ? { start, end, duration } : undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
const utcAt = (departureUtc: string, elapsedMinutes: number): string => new Date(Date.parse(departureUtc) + elapsedMinutes * 60_000).toISOString();
const jsonValue = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
