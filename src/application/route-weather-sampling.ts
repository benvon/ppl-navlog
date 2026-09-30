import type { AloftPointAnswer, AloftPointQuery, MetarSuccessPayload } from "../../worker/api/contracts";
import { calculateGreatCircleDistanceAndInitialCourse, pointAlongGreatCircle, MEAN_EARTH_RADIUS_NAUTICAL_MILES } from "../domain/distance-course";
import { failure, success } from "../domain/errors";
import { wind, type Wind } from "../domain/wind";
import { nauticalMiles, degreesToRadians } from "../domain/units";
import type { EffectiveWindResolver } from "../domain/phase-planning";
import type { PlanDraft, JsonValue } from "../domain/route";
import type { AircraftProfile } from "../domain/aircraft";
import { canonicalPointCoordinateDegrees, type Coordinate } from "../domain/coordinates";
import { trace } from "../domain/calculation-trace";
import { MAX_CHECKPOINTS_PER_PLAN } from "../services/storage/pilot-input-repository";
import { calculatePlanningMagneticVariation } from "./magnetic-variation";
import { deviationTablePoint } from "../domain/deviation";
import type { CompletePlanRouteLeg, CompletePlanWeather, RouteWeatherSample } from "./complete-plan";
import { validateNavlogFuelInputs } from "./navlog-calculation";
import type { PreparedWaypoint } from "./waypoint-preparation";
import { calculateWaypointWorksheet } from "./waypoint-worksheet";
import type { WaypointWorksheetWeather } from "./waypoint-worksheet";
import type { WaypointWorksheetRow } from "./waypoint-worksheet-row";

const MAX_ROUTE_WAYPOINTS = MAX_CHECKPOINTS_PER_PLAN + 2;
const MAX_METAR_AGE_MS = 2 * 60 * 60 * 1_000;

export interface RouteWeatherPointClient {
  fetchPoint(query: AloftPointQuery): Promise<AloftPointAnswer>;
}

export interface RouteWeatherSolution {
  readonly weather: CompletePlanWeather;
  readonly sampledPoints: readonly AloftPointAnswer[];
  readonly iterations: 1;
}

/** Validates authored route and performance inputs before any weather is fetched. */
export const validateWorksheetPlanningInputs = (draft: PlanDraft, profile: AircraftProfile): void => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(draft.departureTimeUtc) || !Number.isFinite(Date.parse(draft.departureTimeUtc))) throw new RouteWeatherSamplingError("Plan departure time must be a valid ISO-8601 UTC instant.");
  const routeLegs = buildRouteLegs(draft);
  const lines = routeLines(routeLegs);
  const totalDistance = lines.at(-1)?.endDistance;
  if (totalDistance === undefined || totalDistance <= 0) throw new RouteWeatherSamplingError("A complete route is required for route weather sampling.");
  const departure = routeLegs[0]!.start;
  if (departure.kind !== "airport") throw new RouteWeatherSamplingError("Route weather requires an airport departure endpoint.");
  const destination = routeLegs.at(-1)!.end;
  if (destination.kind !== "airport") throw new RouteWeatherSamplingError("Route weather requires an airport destination endpoint with field elevation.");
  validateEndpointElevations(departure.elevationFeetMsl, destination.elevationFeetMsl);
  validateSingleCruiseAltitude(routeLegs, departure.elevationFeetMsl, destination.elevationFeetMsl);
  validateVerticalPerformance(profile, routeLegs);
  validateDeviationTable(profile);
  const fuel = validateNavlogFuelInputs(draft.fuelInputs, profile);
  if (!fuel.ok) throw new RouteWeatherSamplingError(fuel.error.message);
};

const validateEndpointElevations = (departureElevation: number, destinationElevation: number): void => {
  if (!Number.isFinite(departureElevation) || !Number.isFinite(destinationElevation)) throw new RouteWeatherSamplingError("Departure and destination field elevations must be finite before weather is requested.");
};

const validateDeviationTable = (profile: AircraftProfile): void => {
  const headings = new Set<number>();
  for (const point of profile.compassDeviationTable) {
    const validated = deviationTablePoint(point.magneticHeadingDegrees, point.deviationDegrees);
    if (!validated.ok) throw new RouteWeatherSamplingError(validated.error.message);
    if (headings.has(validated.value.magneticHeading)) throw new RouteWeatherSamplingError("Compass deviation table has duplicate normalized magnetic headings.");
    headings.add(validated.value.magneticHeading);
  }
};

const validateSingleCruiseAltitude = (routeLegs: readonly CompletePlanRouteLeg[], departureElevation: number, destinationElevation: number): void => {
  const cruiseAltitude = routeLegs[0]!.sourceLeg.cruiseAltitudeFeetMsl;
  if (!Number.isFinite(cruiseAltitude) || cruiseAltitude <= departureElevation || cruiseAltitude <= destinationElevation) throw new RouteWeatherSamplingError("Choose a valid cruise altitude above departure and destination field elevations.");
  if (cruiseAltitude < 3_000 || cruiseAltitude > 53_000) throw new RouteWeatherSamplingError("Choose a cruise altitude from 3,000 through 53,000 ft MSL for winds-aloft data.");
  if (routeLegs.some(({ sourceLeg }) => sourceLeg.cruiseAltitudeFeetMsl !== cruiseAltitude)) throw new RouteWeatherSamplingError("Choose one cruise altitude for the whole route before calculating.");
};

const validateVerticalPerformance = (profile: AircraftProfile, legs: readonly CompletePlanRouteLeg[]): void => {
  const values = [["climb rate", profile.climbRateFeetPerMinute], ["climb TAS", profile.climbTasKnots], ["climb fuel flow", profile.climbFuelFlowGallonsPerHour], ["descent rate", profile.descentRateFeetPerMinute], ["descent TAS", profile.descentTasKnots], ["descent fuel flow", profile.descentFuelFlowGallonsPerHour], ["cruise TAS", profile.cruiseTasKnots], ["cruise fuel flow", profile.cruiseFuelFlowGallonsPerHour]] as const;
  for (const [label, value] of values) if (!Number.isFinite(value) || value <= 0) throw new RouteWeatherSamplingError(`${label} must be finite and positive.`);
  for (const leg of legs) validatePerformanceOverride(leg.sourceLeg.performanceOverrides?.cruiseTasKnots?.effectiveValue, leg.sourceLeg.performanceOverrides?.cruiseFuelFlowGallonsPerHour?.effectiveValue);
};

const validatePerformanceOverride = (tas: number | undefined, fuelFlow: number | undefined): void => {
  if (tas !== undefined && (!Number.isFinite(tas) || tas <= 0)) throw new RouteWeatherSamplingError("Cruise TAS override must be finite and positive.");
  if (fuelFlow !== undefined && (!Number.isFinite(fuelFlow) || fuelFlow <= 0)) throw new RouteWeatherSamplingError("Cruise fuel-flow override must be finite and positive.");
};

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
export const resolveRouteWeather = async (
  draft: PlanDraft,
  profile: AircraftProfile,
  pointClient: RouteWeatherPointClient,
  endpoints: { readonly departureMetar: MetarSuccessPayload },
): Promise<RouteWeatherSolution> => {
  validateWorksheetPlanningInputs(draft, profile);
  const prepared = prepareRouteWeatherInputs(draft, endpoints);
  const worksheet = await calculateWorksheetRoute(draft, profile, pointClient, prepared, endpoints);
  const weather = {
    ...weatherFor(prepared.routeLegs, worksheet.samples, endpoints.departureMetar, worksheet.warnings),
    progressiveCalculationSnapshot: worksheet.snapshot,
  };
  return { weather, sampledPoints: worksheet.samples.map((sample) => sample.answer), iterations: 1 };
};

interface PreparedRouteWeatherInputs {
  readonly routeLegs: readonly CompletePlanRouteLeg[];
  readonly lines: readonly RouteLine[];
  readonly totalDistance: number;
}
const prepareRouteWeatherInputs = (
  draft: PlanDraft, endpoints: { readonly departureMetar: MetarSuccessPayload },
): PreparedRouteWeatherInputs => {
  if (draft.route.points.length > MAX_ROUTE_WAYPOINTS) throw new RouteWeatherSamplingError(`Route exceeds the ${MAX_ROUTE_WAYPOINTS}-waypoint weather limit.`);
  if (draft.route.points.length < 2 || draft.route.legs.length !== draft.route.points.length - 1) throw new RouteWeatherSamplingError("Route weather requires one leg between every adjacent waypoint.");
  const routeLegs = buildRouteLegs(draft), lines = routeLines(routeLegs), totalDistance = lines.at(-1)?.endDistance;
  if (totalDistance === undefined || totalDistance <= 0) throw new RouteWeatherSamplingError("A complete route is required for route weather sampling.");
  const departure = routeLegs[0]!.start;
  if (departure.kind !== "airport") throw new RouteWeatherSamplingError("Route weather requires an airport departure endpoint.");
  validateDepartureMetar(draft, departure, endpoints.departureMetar);
  return { routeLegs, lines, totalDistance };
};

interface ProgressiveWeatherResult {
  readonly samples: readonly RouteWeatherSample[];
  readonly snapshot: JsonValue;
  readonly warnings: readonly string[];
}

/** Adapts the teaching worksheet's single finalized row sequence to the durable navlog schema. */
const calculateWorksheetRoute = async (
  draft: PlanDraft, profile: AircraftProfile, client: RouteWeatherPointClient,
  prepared: PreparedRouteWeatherInputs, endpoints: { readonly departureMetar: MetarSuccessPayload },
): Promise<ProgressiveWeatherResult> => {
  const departure = prepared.routeLegs[0]!.start;
  const destination = prepared.routeLegs.at(-1)!.end;
  if (departure.kind !== "airport" || destination.kind !== "airport") throw new RouteWeatherSamplingError("Worksheet weather requires departure and destination airports with field elevations.");
  const fuelAboard = draft.fuelInputs.fuelAboardGallons;
  if (fuelAboard === undefined) throw new RouteWeatherSamplingError("Fuel aboard is required for a fresh calculation.");
  const departureWind = requiredMetarWind(endpoints.departureMetar);
  const departureWeather: WaypointWorksheetWeather = {
      wind: departureWind, provenance: `Departure METAR ${endpoints.departureMetar.metar.icao}, assumed as the climb wind at departure field elevation.`,
    validFromUtc: endpoints.departureMetar.metar.observedAt ?? draft.departureTimeUtc,
  };
  const samples: RouteWeatherSample[] = [];
  const warnings: string[] = [];
  const variationByWaypoint = new Map<string, ReturnType<typeof calculatePlanningMagneticVariation>>();
  const variationFor = (waypoint: { readonly id: string; readonly coordinate: Coordinate }) => {
    let value = variationByWaypoint.get(waypoint.id);
    if (value === undefined) {
      value = calculatePlanningMagneticVariation({ coordinate: waypoint.coordinate, date: new Date(draft.departureTimeUtc), altitudeFeetMsl: draft.route.legs[0]!.cruiseAltitudeFeetMsl });
      variationByWaypoint.set(waypoint.id, value);
    }
    return value;
  };
  const selectedWeather = async (waypoint: PreparedWaypoint, plannedUtc: string, altitudeFeetMsl: number) => {
    try {
      const target = { routeDistance: waypoint.routeDistanceNauticalMiles, coordinate: waypoint.coordinate, altitudeFeetMsl };
      const query = queryAt(target, plannedUtc);
      const answer = await fetchOnePointAnswer(client, query);
      samples.push(sampleFromAnswer(target, query, answer));
      return success({
        wind: pointWind(answer), provenance: `Winds-aloft ${answer.requestId} (${answer.method}); forecast valid ${answer.useFrom} to ${answer.useUntil}.${waypoint.kind === "destination" ? " Destination cruise-altitude forecast UTC is preliminary: departure UTC plus total charted distance divided by cruise TAS without wind." : ""}`,
        validFromUtc: answer.useFrom, validToUtc: answer.useUntil,
      });
    } catch (error) {
      return failure("INVALID_WIND_SAMPLING", error instanceof Error ? error.message : `Weather selection failed at ${waypoint.label}.`);
    }
  };
  const worksheet = await calculateWaypointWorksheet({
    route: draft.route, profile, departureEstimatedUtc: draft.departureTimeUtc,
    fuelAboardGallons: fuelAboard,
    taxiRunupFuelGallons: draft.fuelInputs.taxiRunupFuelGallons,
    reserveFuelGallons: draft.fuelInputs.reserveFuelGallons,
    descentTargetAltitudeFeetMsl: destination.elevationFeetMsl,
    magneticVariationEastPositiveDegrees: 0,
    departureWeather,
    magneticVariationAt: (waypoint) => variationFor(waypoint).variation.effectiveValue,
    selectWeather: selectedWeather,
  });
  if (!worksheet.ok) throw new RouteWeatherSamplingError(worksheet.error.message);
  warnings.push(...worksheet.value.warnings);
  const total = worksheet.value.route.totalRouteDistanceNauticalMiles;
  const rows = worksheet.value.rows.map((row, index) => worksheetNavlogRow(row, index, prepared, draft, profile, variationFor));
  const taxi = draft.fuelInputs.taxiRunupFuelGallons;
  const reserve = draft.fuelInputs.reserveFuelGallons;
  const fuelUsed = taxi + rows.reduce((sum, row) => sum + row.fuel, 0);
  const fuelSummary = {
    fuelAboard, usableFuel: profile.usableFuelGallons, taxiRunupFuel: taxi, fuelAfterTaxi: fuelAboard - taxi, reserveFuel: reserve,
    enrouteFuel: fuelUsed - taxi, requiredFuel: fuelUsed + reserve,
    estimatedArrivalFuel: worksheet.value.estimatedArrivalFuelGallons,
    reserveMargin: worksheet.value.estimatedArrivalFuelGallons - reserve,
    reserveShortfall: Math.max(0, reserve - worksheet.value.estimatedArrivalFuelGallons),
    fuelExhausted: worksheet.value.estimatedArrivalFuelGallons <= 0,
    sufficientAboardFuel: !worksheet.value.fuelShortage, capacityComparisonAvailable: profile.usableFuelGallons !== undefined,
    usableFuelDifference: profile.usableFuelGallons === undefined ? undefined : profile.usableFuelGallons - fuelUsed - reserve,
    sufficientUsableFuel: profile.usableFuelGallons === undefined ? undefined : profile.usableFuelGallons >= fuelUsed + reserve,
    trace: trace("worksheet-fuel-summary", [], [], { name: "estimated arrival fuel", value: worksheet.value.estimatedArrivalFuelGallons, unit: "gallons" }, "Taxi/run-up fuel is deducted before airborne rows; reserve is compared with estimated arrival fuel."),
  };
  const boundaries = worksheet.value.waypoints.filter((point) => point.kind === "estimated-toc" || point.kind === "estimated-tod").map((point, index) => worksheetBoundary(point, index, prepared));
  const phases = ["climb", "cruise", "descent"].map((phase) => {
    const phaseRows = rows.filter((row) => row.subleg.phase === phase);
    return phaseRows.length === 0 ? undefined : { id: `worksheet-${phase}`, kind: phase, startRouteDistance: phaseRows[0]!.subleg.routeStartDistance,
      endRouteDistance: phaseRows.at(-1)!.subleg.routeEndDistance, startingAltitude: phaseRows[0]!.subleg.startingAltitude,
      targetAltitude: phaseRows.at(-1)!.subleg.endingAltitude,
      calculation: { durationMinutes: phaseRows.reduce((sum, row) => sum + row.estimatedTimeEnroute, 0), fuelGallons: phaseRows.reduce((sum, row) => sum + row.fuel, 0),
        distanceNauticalMiles: phaseRows.reduce((sum, row) => sum + row.subleg.distance, 0) }, convergenceIterations: 1 };
  }).filter((phase) => phase !== undefined);
  const snapshot = jsonValue({
    schema: "complete-navlog/v1", status: "calculated",
    weather: { snapshotIds: [...new Set(samples.map((sample) => sample.answer.requestId))], provenance: { source: "sequential-waypoint-worksheet", eventCount: samples.length, destinationForecastUtcRule: "departure UTC plus total charted distance divided by cruise TAS without wind; preliminary estimate" },
      endpointSources: { departureMetar: endpointMetarSource(endpoints.departureMetar), destinationCruiseAltitudeForecast: (() => {
        const answer = samples.find((sample) => sample.routeDistanceNauticalMiles === total)?.answer;
        return answer === undefined ? undefined : { requestId: answer.requestId, issuedAt: answer.issuedAt, plannedUtc: answer.query.plannedUtc, altitudeFeetMsl: answer.query.altitudeFeetMsl, method: answer.method, forecastCycle: answer.forecastCycle, validFrom: answer.useFrom, validUntil: answer.useUntil, cache: answer.product.cache };
      })() } },
    phaseAllocation: { status: "allocated", transitionPolicy: "stable-cruise-altitude", navlogEndpoint: { kind: "field-elevation-airport", routeDistanceNauticalMiles: total }, boundaries, phases, sublegs: rows.map((row) => row.subleg), warnings },
    navlog: { schema: "navlog-calculation/v1", rows, fuelSummary, warnings },
  });
  return { samples, snapshot, warnings };
};

const worksheetBoundary = (point: PreparedWaypoint, index: number, prepared: PreparedRouteWeatherInputs) => ({
  id: `worksheet-generated-${index + 1}`, kind: point.kind === "estimated-toc" ? "top-of-climb" : "top-of-descent",
  routeDistanceNauticalMiles: point.routeDistanceNauticalMiles, coordinate: point.coordinate,
  sourceLegId: point.sourceLegId ?? prepared.routeLegs.find((leg) => leg.start.kind === "airport")!.sourceLeg.id,
  placementFormulaId: point.placement?.formulaId,
  placementAssumption: point.kind === "estimated-toc" ? "Departure METAR wind is used as the climb placement approximation." : "One cruise-altitude wind forecast above destination is treated as constant for descent placement; the preliminary forecast UTC uses no-wind cruise time.",
  placementTrace: worksheetPlacementTrace(point),
});

const worksheetPlacementTrace = (point: PreparedWaypoint) => {
  const placement = point.placement;
  if (placement === undefined) return [];
  const entries = [
    ["altitude difference", placement.altitudeDifferenceFeet, "feet"],
    ["vertical rate", placement.verticalRateFeetPerMinute, "feet per minute"],
    ["planning groundspeed", placement.planningGroundspeedKnots, "knots"],
    ["true airspeed", placement.trueAirspeedKnots, "knots"],
    ["estimated duration", placement.estimatedDurationMinutes, "minutes"],
    ["estimated distance", placement.estimatedDistanceNauticalMiles, "nautical miles"],
    ["planning wind from", placement.planningWind.directionFrom, "degrees-true"],
    ["planning wind speed", placement.planningWind.speed, "knots"],
  ] as const;
  return entries.filter((entry) => entry[1] !== undefined).map(([name, value, unit]) => ({ name, value: value as number, unit }));
};

const worksheetNavlogRow = (
  row: WaypointWorksheetRow, index: number, prepared: PreparedRouteWeatherInputs, draft: PlanDraft, profile: AircraftProfile,
  variationFor: (waypoint: PreparedWaypoint) => ReturnType<typeof calculatePlanningMagneticVariation>,
) => {
  const startDistance = row.startWaypoint.routeDistanceNauticalMiles;
  const endDistance = row.endWaypoint.routeDistanceNauticalMiles;
  const leg = prepared.lines.find((line) => startDistance >= line.startDistance && endDistance <= line.endDistance)?.leg;
  if (leg === undefined) throw new RouteWeatherSamplingError("A worksheet row does not fit within its authored route leg.");
  const variation = variationFor(row.startWaypoint);
  const cruiseAltitude = draft.route.legs[0]!.cruiseAltitudeFeetMsl;
  const subleg = {
    id: `worksheet-row-${index + 1}`, sourceLegId: leg.sourceLeg.id, phase: row.phase, phaseId: row.phase,
    start: row.startWaypoint.coordinate, end: row.endWaypoint.coordinate, startLabel: row.startWaypoint.label, endLabel: row.endWaypoint.label, distance: row.distanceNauticalMiles,
    trueCourse: row.trueCourseDegrees, routeStartDistance: row.startWaypoint.routeDistanceNauticalMiles,
    routeEndDistance: row.endWaypoint.routeDistanceNauticalMiles,
    startingAltitude: row.phase === "climb" ? prepared.routeLegs[0]!.start.kind === "airport" ? prepared.routeLegs[0]!.start.elevationFeetMsl : cruiseAltitude : cruiseAltitude,
    endingAltitude: row.plannedAltitudeFeetMsl, selectedCruiseAltitude: cruiseAltitude,
  };
  const performance = row.provenance.performanceInputs;
  return {
    subleg,
    effectiveWind: { wind: { computedValue: row.wind, effectiveValue: row.wind, origin: "external-data", provenance: { sourceId: `worksheet-weather:${row.provenance.startWaypointId}`, sourceLabel: row.provenance.weather ?? "Selected route weather", recordedAt: row.startingEstimatedUtc }, explanation: { formulaId: "worksheet-selected-wind", formulaVersion: "v1" } }, trace: row.traces.effectiveWind },
    trueAirspeed: performance?.trueAirspeed ?? aircraftPlanningValue(row.trueAirspeedKnots, `${row.phase} TAS`, profile),
    fuelFlow: performance?.fuelFlow ?? aircraftPlanningValue(row.fuelFlowGallonsPerHour, `${row.phase} fuel flow`, profile),
    windCorrectionAngle: row.windCorrectionAngleDegrees, trueHeading: row.trueHeadingDegrees,
    variation: variation.variation, magneticHeading: row.magneticHeadingDegrees,
    compassDeviation: row.provenance.compassDeviationEastPositiveDegrees, compassHeading: row.compassHeadingDegrees,
    groundspeed: row.groundspeedKnots, estimatedTimeEnroute: row.estimatedTimeEnrouteMinutes, fuel: row.estimatedFuelGallons,
    cumulative: { routeDistance: row.endWaypoint.routeDistanceNauticalMiles, estimatedTimeEnroute: row.cumulativeEstimatedMinutes,
      enrouteFuel: row.cumulativeFuelUsedGallons - draft.fuelInputs.taxiRunupFuelGallons,
      requiredFuelWithTaxiRunup: row.cumulativeFuelUsedGallons,
      requiredFuelWithTaxiRunupAndReserve: row.cumulativeFuelUsedGallons + draft.fuelInputs.reserveFuelGallons,
      fuelRemaining: row.endingFuelGallons },
    assumptions: worksheetRowAssumptions(row), appliedOverrides: worksheetRowOverrides(row),
    traces: { ...row.traces, magneticVariation: variation.trace },
  };
};

const aircraftPlanningValue = (value: number, label: string, profile: AircraftProfile) => ({
  computedValue: value, effectiveValue: value, origin: "aircraft-default" as const,
  provenance: { sourceId: `aircraft-profile:${profile.id}`, sourceLabel: `${profile.name} ${label}`, recordedAt: profile.updatedAt },
});

const worksheetRowAssumptions = (row: WaypointWorksheetRow): readonly string[] => [
  ...(row.phase === "climb" ? ["TOC placement uses departure METAR wind as an initial climb approximation; checkpoint forecasts can change subsequent row estimates."] : []),
  "Checkpoint forecasts are sampled at the single cruise altitude even when they fall inside climb or descent.",
  ...(row.phase === "descent" ? ["A single cruise-altitude forecast above the destination is treated as constant for TOD placement; later checkpoint weather does not move TOD."] : []),
  ...row.warnings,
];

const worksheetRowOverrides = (row: WaypointWorksheetRow) => {
  const values = row.provenance.performanceInputs;
  if (values === undefined) return [];
  return [
    ...(values.trueAirspeed.override === undefined ? [] : [{ input: "true-airspeed", computedValue: values.trueAirspeed.computedValue, effectiveValue: values.trueAirspeed.effectiveValue, reason: values.trueAirspeed.override.reason, createdAt: values.trueAirspeed.override.createdAt }]),
    ...(values.fuelFlow.override === undefined ? [] : [{ input: "fuel-flow", computedValue: values.fuelFlow.computedValue, effectiveValue: values.fuelFlow.effectiveValue, reason: values.fuelFlow.override.reason, createdAt: values.fuelFlow.override.createdAt }]),
  ];
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

const queryAt = (target: WaypointTarget, plannedUtc: string): AloftPointQuery => ({ latitudeDeg: canonicalPointCoordinateDegrees(target.coordinate.latitude), longitudeDeg: canonicalPointCoordinateDegrees(target.coordinate.longitude), altitudeFeetMsl: Math.round(target.altitudeFeetMsl), plannedUtc });
const fetchOnePointAnswer = async (client: RouteWeatherPointClient, query: AloftPointQuery): Promise<AloftPointAnswer> => {
  const answer = await client.fetchPoint(query);
  validateAnswer(query, answer);
  return answer;
};
const sampleFromAnswer = (target: WaypointTarget, query: AloftPointQuery, answer: AloftPointAnswer): RouteWeatherSample => ({ routeDistanceNauticalMiles: target.routeDistance, plannedUtc: query.plannedUtc, altitudeFeetMsl: query.altitudeFeetMsl, answer });


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
  const failure = departureMetarFailure(metar, allowedIcaos, Date.parse(draft.departureTimeUtc));
  if (failure !== undefined) throw new RouteWeatherSamplingError(failure);
};
const departureMetarFailure = (metar: MetarSuccessPayload, allowedIcaos: ReadonlySet<string>, departureMs: number): string | undefined => {
  if (!allowedIcaos.has(metar.metar.icao)) return `The fetched departure METAR is for ${metar.metar.icao}, which is not the departure airport or selected alternate. Check the departure METAR ICAO alternate.`;
  if (metar.provenance.cache.status === "stale_on_error" || metar.provenance.cache.status === "stale_while_refresh" || metar.provenance.cache.freshnessRemainingSeconds <= 0) {
    return "The fetched departure METAR cache is stale. Try Update navlog again when current weather data is available.";
  }
  const observed = metar.metar.observedAt === null ? Number.NaN : Date.parse(metar.metar.observedAt);
  if (!Number.isFinite(observed)) return "The fetched departure METAR has no observation time, so it cannot anchor departure weather. Check the selected station's report.";
  if (observed > departureMs) return "The fetched departure METAR was observed after the planned departure UTC. For a past departure, choose Use current UTC, then Update navlog.";
  if (!Number.isFinite(departureMs) || departureMs - observed > MAX_METAR_AGE_MS) return "The fetched departure METAR observation is more than two hours before planned departure UTC. Choose a departure time within two hours of the observation, or try Update navlog later when a newer report is available.";
  if (metarWind(metar) === null) return "The fetched departure METAR has no usable fixed or calm wind. Check the selected station's report or departure METAR ICAO alternate.";
  return undefined;
};

const weatherFor = (
  routeLegs: readonly CompletePlanRouteLeg[], samples: readonly RouteWeatherSample[], metar: MetarSuccessPayload, warnings: readonly string[],
): CompletePlanWeather => ({
  snapshotIds: [...new Set(samples.map((sample) => sample.answer.requestId))],
  routeWeatherSamples: samples,
  departureMetarPayload: metar,
  phaseWindResolver: createWaypointPhaseResolver(routeLegs, samples, metar),
  warnings,
  provenance: jsonValue({ source: "sequential-waypoint-worksheet-winds", eventCount: samples.length, altitudeRule: "single route cruise altitude for TOC and checkpoint selections; destination cruise-altitude forecast for TOD placement" }),
});

export const createWaypointPhaseResolver = (
  routeLegs: readonly CompletePlanRouteLeg[], samples: readonly RouteWeatherSample[], metar?: MetarSuccessPayload,
): EffectiveWindResolver => ({
  resolveEffectiveWind: (request) => {
    const distance = projectRouteDistance(routeLegs, request.start);
    const sample = [...samples].reverse().find((candidate) => candidate.routeDistanceNauticalMiles <= distance + 1e-8);
    if (sample === undefined && metar !== undefined) return success(requiredMetarWind(metar));
    if (sample === undefined) return failure("INVALID_WIND_SAMPLING", "No preceding progressive weather event is available.");
    return success(pointWind(sample.answer));
  },
});

const requiredMetarWind = (metar: MetarSuccessPayload): Wind => {
  const value = metarWind(metar);
  if (value === null) throw new RouteWeatherSamplingError("The selected departure METAR has no usable wind.");
  return value;
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
