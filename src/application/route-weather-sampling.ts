import type { AloftPointAnswer, AloftPointQuery, MetarSuccessPayload } from "../../worker/api/contracts";
import { calculateGreatCircleDistanceAndInitialCourse } from "../domain/distance-course";
import { failure, success } from "../domain/errors";
import { wind, type Wind } from "../domain/wind";
import type { PlanDraft, JsonValue, RoutePoint, UserRouteLeg } from "../domain/route";
import type { AircraftProfile } from "../domain/aircraft";
import { describeAircraftProfileValidation, inspectAircraftProfile } from "../domain/aircraft-profile-validation";
import { canonicalPointCoordinateDegrees, type Coordinate } from "../domain/coordinates";
import { trace } from "../domain/calculation-trace";
import { MAX_CHECKPOINTS_PER_PLAN } from "../services/storage/pilot-input-repository";
import { calculatePlanningMagneticVariation } from "./magnetic-variation";
import { validateNavlogFuelInputs } from "./worksheet-input-validation";
import type { PreparedWaypoint } from "./waypoint-preparation";
import { calculateWaypointWorksheet } from "./waypoint-worksheet";
import type { WaypointWorksheetWeather } from "./waypoint-worksheet";
import type { WaypointWorksheetRow } from "./waypoint-worksheet-row";

const MAX_ROUTE_WAYPOINTS = MAX_CHECKPOINTS_PER_PLAN + 2;
const MAX_METAR_AGE_MS = 2 * 60 * 60 * 1_000;
const WEATHER_GRACE_WARNING = "Weather refresh is temporarily unavailable; using cached context within the two-minute grace period.";

export interface RouteWeatherPointClient {
  fetchPoint(query: AloftPointQuery): Promise<AloftPointAnswer>;
}

export interface RouteWeatherSample {
  readonly routeDistanceNauticalMiles: number;
  readonly plannedUtc: string;
  readonly altitudeFeetMsl: number;
  readonly answer: AloftPointAnswer;
}
export interface RouteWeatherSolution {
  readonly calculationSnapshot: JsonValue;
  readonly weatherSnapshotIds: readonly string[];
  readonly warnings: readonly string[];
  readonly departureMetarPayload: MetarSuccessPayload;
  readonly routeWeatherSamples: readonly RouteWeatherSample[];
  readonly weatherProvenance: JsonValue;
  readonly sampledPoints: readonly AloftPointAnswer[];
  readonly iterations: 1;
}
interface RouteLegEvidence {
  readonly sourceLeg: UserRouteLeg;
  readonly start: RoutePoint;
  readonly end: RoutePoint;
  readonly distance: number;
  readonly trueCourse: number;
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
  if (draft.selectedAircraftProfileId !== profile.id) throw new RouteWeatherSamplingError("The selected aircraft profile does not match the plan draft.");
  const checkedProfile = inspectAircraftProfile(profile);
  if (checkedProfile.kind !== "valid") throw new RouteWeatherSamplingError(describeAircraftProfileValidation(checkedProfile));
  validateRoutePerformanceOverrides(routeLegs);
  const fuel = validateNavlogFuelInputs(draft.fuelInputs, profile);
  if (!fuel.ok) throw new RouteWeatherSamplingError(fuel.error.message);
};

const validateEndpointElevations = (departureElevation: number, destinationElevation: number): void => {
  if (!Number.isFinite(departureElevation) || !Number.isFinite(destinationElevation)) throw new RouteWeatherSamplingError("Departure and destination field elevations must be finite before weather is requested.");
};

const validateSingleCruiseAltitude = (routeLegs: readonly RouteLegEvidence[], departureElevation: number, destinationElevation: number): void => {
  const cruiseAltitude = routeLegs[0]!.sourceLeg.cruiseAltitudeFeetMsl;
  if (!Number.isFinite(cruiseAltitude) || cruiseAltitude <= departureElevation || cruiseAltitude <= destinationElevation) throw new RouteWeatherSamplingError("Choose a valid cruise altitude above departure and destination field elevations.");
  if (cruiseAltitude < 3_000 || cruiseAltitude > 53_000) throw new RouteWeatherSamplingError("Choose a cruise altitude from 3,000 through 53,000 ft MSL for winds-aloft data.");
  if (routeLegs.some(({ sourceLeg }) => sourceLeg.cruiseAltitudeFeetMsl !== cruiseAltitude)) throw new RouteWeatherSamplingError("Choose one cruise altitude for the whole route before calculating.");
};

const validateRoutePerformanceOverrides = (legs: readonly RouteLegEvidence[]): void => {
  for (const leg of legs) validatePerformanceOverride(leg.sourceLeg.performanceOverrides?.cruiseTasKnots?.effectiveValue, leg.sourceLeg.performanceOverrides?.cruiseFuelFlowGallonsPerHour?.effectiveValue);
};


const validatePerformanceOverride = (tas: number | undefined, fuelFlow: number | undefined): void => {
  if (tas !== undefined && (!Number.isFinite(tas) || tas <= 0)) throw new RouteWeatherSamplingError("Cruise TAS override must be finite and positive.");
  if (fuelFlow !== undefined && (!Number.isFinite(fuelFlow) || fuelFlow <= 0)) throw new RouteWeatherSamplingError("Cruise fuel-flow override must be finite and positive.");
};

interface RouteLine {
  readonly leg: RouteLegEvidence;
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
  recheckSampleFreshness(worksheet.samples, Date.now());
  const usedProductGrace = worksheet.samples.some((sample) => sample.answer.product.cache.status === "stale_on_error");
  const usedCatalogGrace = worksheet.samples.some((sample) => sample.answer.catalog.cache.status === "stale_on_error");
  const warnings = usedProductGrace || usedCatalogGrace
    ? [...worksheet.warnings, ...(worksheet.warnings.includes(WEATHER_GRACE_WARNING) ? [] : [WEATHER_GRACE_WARNING])]
    : worksheet.warnings;
  return {
    calculationSnapshot: worksheet.snapshot,
    weatherSnapshotIds: [...new Set(worksheet.samples.map((sample) => sample.answer.requestId))],
    warnings,
    departureMetarPayload: endpoints.departureMetar,
    routeWeatherSamples: worksheet.samples,
    weatherProvenance: jsonValue({ source: "sequential-waypoint-worksheet-winds", eventCount: worksheet.samples.length, altitudeRule: "single route cruise altitude for TOC and checkpoint selections; destination cruise-altitude forecast for TOD placement", resourceProvenance: worksheet.samples.map(({ plannedUtc, answer }) => ({ plannedUtc, product: answer.product.cache, catalog: answer.catalog.cache })) }),
    sampledPoints: worksheet.samples.map((sample) => sample.answer), iterations: 1,
  };
};

interface PreparedRouteWeatherInputs {
  readonly routeLegs: readonly RouteLegEvidence[];
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
  if (samples.some(({ answer }) => answer.product.cache.status === "stale_on_error" || answer.catalog.cache.status === "stale_on_error") && !warnings.includes(WEATHER_GRACE_WARNING)) warnings.push(WEATHER_GRACE_WARNING);
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
    fuelExhaustionDeficit: Math.max(0, -worksheet.value.estimatedArrivalFuelGallons),
    sufficientAboardFuel: !worksheet.value.fuelShortage, capacityComparisonAvailable: profile.usableFuelGallons !== undefined,
    usableFuelDifference: profile.usableFuelGallons === undefined ? undefined : profile.usableFuelGallons - fuelUsed - reserve,
    sufficientUsableFuel: profile.usableFuelGallons === undefined ? undefined : profile.usableFuelGallons >= fuelUsed + reserve,
    trace: trace("worksheet-fuel-summary", [], [], { name: "estimated arrival fuel", value: worksheet.value.estimatedArrivalFuelGallons, unit: "gallons" }, "Taxi/run-up fuel is deducted before airborne rows; reserve is compared with estimated arrival fuel."),
  };
  const boundaries = worksheet.value.waypoints.filter((point) => point.kind === "estimated-toc" || point.kind === "estimated-tod").map((point, index) => worksheetBoundary(point, index, prepared));
  const phases = ["climb", "cruise", "descent"].map((phase) => {
    const phaseRows = rows.filter((row) => row.subleg.phase === phase);
    return phaseRows.length === 0 ? undefined : { id: `worksheet-${phase}`, kind: phase, startRouteDistance: phaseRows[0]!.subleg.routeStartDistance,
      endRouteDistance: phaseRows.at(-1)!.subleg.routeEndDistance,
      startingAltitude: phase === "climb" ? departure.elevationFeetMsl : draft.route.legs[0]!.cruiseAltitudeFeetMsl,
      targetAltitude: phase === "descent" ? destination.elevationFeetMsl : draft.route.legs[0]!.cruiseAltitudeFeetMsl,
      calculation: { durationMinutes: phaseRows.reduce((sum, row) => sum + row.estimatedTimeEnroute, 0), fuelGallons: phaseRows.reduce((sum, row) => sum + row.fuel, 0),
        distanceNauticalMiles: phaseRows.reduce((sum, row) => sum + row.subleg.distance, 0) }, convergenceIterations: 1 };
  }).filter((phase) => phase !== undefined);
  const snapshot = jsonValue({
    schema: "complete-navlog/v1", status: "calculated",
    weather: { snapshotIds: [...new Set(samples.map((sample) => sample.answer.requestId))], provenance: { source: "sequential-waypoint-worksheet", eventCount: samples.length, destinationForecastUtcRule: "departure UTC plus total charted distance divided by cruise TAS without wind; preliminary estimate" }, resourceProvenance: samples.map(({ plannedUtc, answer }) => ({ plannedUtc, product: answer.product.cache, catalog: answer.catalog.cache })),
      endpointSources: { departureMetar: endpointMetarSource(endpoints.departureMetar), destinationCruiseAltitudeForecast: (() => {
        const answer = samples.find((sample) => sample.routeDistanceNauticalMiles === total)?.answer;
        return answer === undefined ? undefined : { requestId: answer.requestId, issuedAt: answer.issuedAt, plannedUtc: answer.query.plannedUtc, altitudeFeetMsl: answer.query.altitudeFeetMsl, method: answer.method, forecastCycle: answer.forecastCycle, validFrom: answer.useFrom, validUntil: answer.useUntil, cache: answer.product.cache };
      })() } },
    phaseAllocation: { status: "allocated", transitionPolicy: "stable-cruise-altitude", navlogEndpoint: { kind: "field-elevation-airport", routeDistanceNauticalMiles: total, elevationFeetMsl: destination.elevationFeetMsl }, boundaries, phases, sublegs: rows.map((row) => row.subleg), warnings },
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
    altitudePresentation: "cruise-assumption", selectedCruiseAltitude: cruiseAltitude,
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
  ...(row.phase === "climb" ? ["TOC placement uses departure METAR wind as an initial climb approximation."] : []),
  "The altitude column shows the fixed cruise-altitude assumption, not a row's starting or ending altitude.",
  ...(row.phase === "descent" ? ["A single cruise-altitude forecast above the destination is treated as constant for TOD placement."] : []),
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

const buildRouteLegs = (draft: PlanDraft): RouteLegEvidence[] => {
  const points = new Map(draft.route.points.map((point) => [point.id, point]));
  const result: RouteLegEvidence[] = [];
  for (const sourceLeg of draft.route.legs) {
    const start = points.get(sourceLeg.fromPointId), end = points.get(sourceLeg.toPointId);
    if (start === undefined || end === undefined) throw new RouteWeatherSamplingError(`Route leg ${sourceLeg.id} references a missing point.`);
    const geometry = calculateGreatCircleDistanceAndInitialCourse(start.coordinate, end.coordinate);
    if (!geometry.ok) throw new RouteWeatherSamplingError(geometry.error.message);
    result.push({ sourceLeg, start, end, distance: geometry.value.distance, trueCourse: geometry.value.initialTrueCourse });
  }
  return result;
};

const routeLines = (routeLegs: readonly RouteLegEvidence[]): RouteLine[] => {
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
  validateResourceCache(answer.product.cache, `winds:${answer.product.region}:${answer.product.cycle}`, "winds-temps", 3600, Date.now());
  validateResourceCache(answer.catalog.cache, "station-catalog:v1", "station-catalog", 86400, Date.now());
};
const validateResourceCache = (cache: AloftPointAnswer["product"]["cache"], key: string, resource: string, ttl: number, now: number): void => {
  const checked = Date.parse(cache.checkedAt), fetched = Date.parse(cache.fetchedAt), refresh = Date.parse(cache.refreshAfter), staleUntil = Date.parse(cache.staleUntil), served = Date.parse(cache.servedAt);
  if (!all(cache.key === key, cache.resource === resource, cache.ttlSeconds === ttl, cache.maxPayloadAgeSeconds >= 0,
      cache.maxPayloadAgeSeconds === Math.floor((staleUntil - fetched) / 1000), cache.expiresAt === cache.refreshAfter,
      refresh - checked === ttl * 1000, staleUntil - refresh === 120_000, fetched <= checked, checked <= served, served < staleUntil,
      served <= now, checked <= now, cache.ageSeconds === Math.floor((served - fetched) / 1000))) throw new RouteWeatherSamplingError(`The ${resource} weather provenance is missing or inconsistent.`);
  if (cache.status === "stale_on_error") {
    if (cache.source !== "stale" || cache.freshnessRemainingSeconds !== 0 || now < refresh || now >= staleUntil) throw new RouteWeatherSamplingError(`The ${resource} weather cache grace period is not currently valid.`);
  } else if (!all(["edge_hit", "kv_hit", "upstream_refresh"].includes(cache.status), ["edge", "kv", "upstream"].includes(cache.source), cache.freshnessRemainingSeconds >= 0, now < refresh)) {
    throw new RouteWeatherSamplingError(`The ${resource} weather cache is no longer fresh.`);
  }
};
const all = (...conditions: readonly boolean[]): boolean => conditions.every(Boolean);
const recheckSampleFreshness = (samples: readonly RouteWeatherSample[], now: number): void => {
  for (const { answer } of samples) {
    validateResourceCache(answer.product.cache, `winds:${answer.product.region}:${answer.product.cycle}`, "winds-temps", 3600, now);
    validateResourceCache(answer.catalog.cache, "station-catalog:v1", "station-catalog", 86400, now);
  }
};
const matchesPointQuery = (query: AloftPointQuery, answer: AloftPointAnswer): boolean =>
  answer.query.latitudeDeg === query.latitudeDeg && answer.query.longitudeDeg === query.longitudeDeg && answer.query.altitudeFeetMsl === query.altitudeFeetMsl && answer.query.plannedUtc === query.plannedUtc;
const hasSupportedPointWind = (answer: AloftPointAnswer): boolean => Number.isFinite(answer.windSpeedKt) && answer.windSpeedKt >= 0 && answer.windSpeedKt <= 199 && (answer.windFromDegTrue === null ? answer.windSpeedKt === 0 : answer.windFromDegTrue >= 0 && answer.windFromDegTrue <= 360);
const pointAnswerCoversQuery = (query: AloftPointQuery, answer: AloftPointAnswer): boolean => {
  const at = Date.parse(query.plannedUtc), issued = Date.parse(answer.issuedAt), from = Date.parse(answer.useFrom), until = Date.parse(answer.useUntil);
  return [at, issued, from, until].every(Number.isFinite) && issued <= at && at >= from && at < until;
};

const validateDepartureMetar = (draft: PlanDraft, departure: Extract<RoutePoint, { kind: "airport" }>, metar: MetarSuccessPayload): void => {
  const allowedIcaos = new Set([departure.icao, draft.weatherSelection?.departureMetarIcao].filter((icao): icao is string => icao !== undefined));
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

const jsonValue = (value: unknown): JsonValue => {
  assertFiniteJsonInput(value, "snapshot", new WeakSet<object>());
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new RouteWeatherSamplingError("Worksheet calculation snapshot is not serializable.");
  return JSON.parse(serialized) as JsonValue;
};
const assertFiniteJsonInput = (value: unknown, path: string, seen: WeakSet<object>): void => {
  if (typeof value === "number" && !Number.isFinite(value)) throw new RouteWeatherSamplingError(`Worksheet calculation snapshot contains a non-finite number at ${path}.`);
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) throw new RouteWeatherSamplingError(`Worksheet calculation snapshot contains a cycle at ${path}.`);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => assertFiniteJsonInput(item, `${path}[${index}]`, seen));
  else Object.entries(value).forEach(([key, item]) => assertFiniteJsonInput(item, `${path}.${key}`, seen));
  seen.delete(value);
};
