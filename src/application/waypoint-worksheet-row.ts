import { calculateGreatCircleDistanceAndInitialCourse } from "../domain/distance-course";
import { failure, propagateFailure, success, type DomainResult } from "../domain/errors";
import type { PreparedWaypoint } from "./waypoint-preparation";
import {
  feetMsl,
  gallons,
  gallonsPerHour,
  minutes,
  nauticalMiles,
  positiveKnots,
  signedDegrees,
  type FeetMsl,
  type Gallons,
  type GallonsPerHour,
  type Knots,
  type Minutes,
  type SignedDegrees,
} from "../domain/units";
import { convertMagneticToCompassHeading, convertTrueToMagneticHeading } from "../domain/heading-conversion";
import { calculateEstimatedTimeEnroute, calculateFuelForDuration } from "../domain/time-fuel";
import { interpolateCompassDeviation, type DeviationTablePoint } from "../domain/deviation";
import type { Wind } from "../domain/wind";
import { trace, type CalculationTrace } from "../domain/calculation-trace";
import type { PlanningValue } from "../domain/planning-value";
import { solveWindTriangle } from "../domain/wind-triangle";

export type WaypointWorksheetPhase = "climb" | "cruise" | "descent";

export interface WaypointWorksheetRowInput {
  readonly startWaypoint: PreparedWaypoint;
  readonly endWaypoint: PreparedWaypoint;
  readonly phase: WaypointWorksheetPhase;
  readonly plannedAltitudeFeetMsl: number;
  readonly trueAirspeedKnots: number;
  readonly fuelFlowGallonsPerHour: number;
  readonly wind: Wind;
  /** Positive east, matching the domain heading-conversion convention. */
  readonly magneticVariationEastPositiveDegrees: number;
  readonly deviationTable: readonly DeviationTablePoint[];
  readonly startingEstimatedUtc: string;
  /** Signed estimated balance allows a prior shortfall to remain visible. */
  readonly startingFuelGallons: number;
  readonly cumulativeEstimatedMinutes: number;
  readonly cumulativeFuelUsedGallons: number;
  readonly performanceInputs?: {
    readonly trueAirspeed: PlanningValue<number>;
    readonly fuelFlow: PlanningValue<number>;
  };
  readonly warnings?: readonly string[];
  readonly weatherProvenance?: string;
}

export interface WaypointWorksheetRowProvenance {
  readonly startWaypointId: string;
  readonly endWaypointId: string;
  readonly selectedWind: Wind;
  readonly weather?: string;
  readonly magneticVariationEastPositiveDegrees: number;
  readonly compassDeviationEastPositiveDegrees: number;
  readonly performanceInputs?: {
    readonly trueAirspeed: PlanningValue<number>;
    readonly fuelFlow: PlanningValue<number>;
  };
}

export interface WaypointWorksheetRow {
  readonly startWaypoint: PreparedWaypoint;
  readonly endWaypoint: PreparedWaypoint;
  readonly phase: WaypointWorksheetPhase;
  readonly plannedAltitudeFeetMsl: number;
  readonly trueAirspeedKnots: number;
  readonly fuelFlowGallonsPerHour: number;
  readonly wind: Wind;
  readonly distanceNauticalMiles: number;
  readonly trueCourseDegrees: number;
  readonly windCorrectionAngleDegrees: number;
  readonly trueHeadingDegrees: number;
  readonly magneticHeadingDegrees: number;
  readonly compassHeadingDegrees: number;
  readonly groundspeedKnots: number;
  readonly estimatedTimeEnrouteMinutes: number;
  readonly estimatedFuelGallons: number;
  readonly startingEstimatedUtc: string;
  readonly endingEstimatedUtc: string;
  readonly startingFuelGallons: number;
  readonly endingFuelGallons: number;
  readonly cumulativeEstimatedMinutes: number;
  readonly cumulativeFuelUsedGallons: number;
  readonly provenance: WaypointWorksheetRowProvenance;
  readonly traces: {
    readonly effectiveWind: CalculationTrace;
    readonly windTriangle: CalculationTrace;
    readonly magneticVariation: CalculationTrace;
    readonly trueToMagnetic: CalculationTrace;
    readonly compassDeviation: CalculationTrace;
    readonly magneticToCompass: CalculationTrace;
    readonly estimatedTimeEnroute: CalculationTrace;
    readonly fuel: CalculationTrace;
  };
  readonly warnings: readonly string[];
}

const ISO_UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

const parseUtcInstant = (value: string): DomainResult<number> => {
  const matched = ISO_UTC_INSTANT.exec(value);
  if (matched === null) {
    return failure("INVALID_NUMBER", "Starting estimated UTC must be an ISO-8601 UTC instant.", {
      field: "startingEstimatedUtc",
      value,
    });
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    return failure("INVALID_NUMBER", "Starting estimated UTC must be a real ISO-8601 UTC instant.", {
      field: "startingEstimatedUtc",
      value,
    });
  }
  const parsed = new Date(milliseconds);
  const components = [
    String(parsed.getUTCFullYear()).padStart(4, "0"),
    String(parsed.getUTCMonth() + 1).padStart(2, "0"),
    String(parsed.getUTCDate()).padStart(2, "0"),
    String(parsed.getUTCHours()).padStart(2, "0"),
    String(parsed.getUTCMinutes()).padStart(2, "0"),
    String(parsed.getUTCSeconds()).padStart(2, "0"),
  ];
  if (matched.slice(1, 7).some((component, index) => component !== components[index])) {
    return failure("INVALID_NUMBER", "Starting estimated UTC must be a real ISO-8601 UTC instant.", {
      field: "startingEstimatedUtc",
      value,
    });
  }
  return success(milliseconds);
};

interface ValidatedRowInputs {
  readonly altitude: FeetMsl;
  readonly airspeed: Knots;
  readonly fuelFlow: GallonsPerHour;
  readonly variation: SignedDegrees;
  readonly startingTimeMilliseconds: number;
  readonly startingFuelGallons: number;
  readonly priorElapsedMinutes: Minutes;
  readonly priorFuelUsedGallons: Gallons;
}

const validateRowInputs = (input: WaypointWorksheetRowInput): DomainResult<ValidatedRowInputs> => {
  const altitude = feetMsl(input.plannedAltitudeFeetMsl);
  if (!altitude.ok) return propagateFailure(altitude);
  const airspeed = positiveKnots(input.trueAirspeedKnots);
  if (!airspeed.ok) return propagateFailure(airspeed);
  const fuelFlow = gallonsPerHour(input.fuelFlowGallonsPerHour);
  if (!fuelFlow.ok) return propagateFailure(fuelFlow);
  const variation = signedDegrees(input.magneticVariationEastPositiveDegrees);
  if (!variation.ok) return propagateFailure(variation);
  const startingTime = parseUtcInstant(input.startingEstimatedUtc);
  if (!startingTime.ok) return propagateFailure(startingTime);
  if (!Number.isFinite(input.startingFuelGallons)) {
    return failure("INVALID_NUMBER", "Starting fuel balance must be finite.", { field: "startingFuelGallons" });
  }
  const priorElapsed = minutes(input.cumulativeEstimatedMinutes);
  if (!priorElapsed.ok) return propagateFailure(priorElapsed);
  const priorFuelUsed = gallons(input.cumulativeFuelUsedGallons);
  if (!priorFuelUsed.ok) return propagateFailure(priorFuelUsed);
  if (input.performanceInputs !== undefined &&
      (input.performanceInputs.trueAirspeed.effectiveValue !== airspeed.value ||
       input.performanceInputs.fuelFlow.effectiveValue !== fuelFlow.value)) {
    return failure("INVALID_NUMBER", "Performance provenance must match the effective TAS and fuel flow used by the row.");
  }
  return success({
    altitude: altitude.value,
    airspeed: airspeed.value,
    fuelFlow: fuelFlow.value,
    variation: variation.value,
    startingTimeMilliseconds: startingTime.value,
    startingFuelGallons: input.startingFuelGallons,
    priorElapsedMinutes: priorElapsed.value,
    priorFuelUsedGallons: priorFuelUsed.value,
  });
};

interface CalculatedRowLeg {
  readonly trueCourseDegrees: number;
  readonly windCorrectionAngleDegrees: number;
  readonly trueHeadingDegrees: number;
  readonly magneticHeadingDegrees: number;
  readonly compassHeadingDegrees: number;
  readonly groundspeedKnots: number;
  readonly estimatedTimeEnrouteMinutes: number;
  readonly estimatedFuelGallons: number;
  readonly compassDeviationEastPositiveDegrees: number;
  readonly traces: WaypointWorksheetRow["traces"];
}

const calculateLeg = (
  input: WaypointWorksheetRowInput,
  validated: ValidatedRowInputs,
  distance: number,
): DomainResult<CalculatedRowLeg> => {
  const distanceValue = nauticalMiles(distance);
  if (!distanceValue.ok) return propagateFailure(distanceValue);
  const geometry = calculateGreatCircleDistanceAndInitialCourse(input.startWaypoint.coordinate, input.endWaypoint.coordinate);
  if (!geometry.ok) return propagateFailure(geometry);
  const windTriangle = solveWindTriangle(geometry.value.initialTrueCourse, validated.airspeed, input.wind);
  if (!windTriangle.ok) return propagateFailure(windTriangle);
  const magnetic = convertTrueToMagneticHeading(windTriangle.value.trueHeading, validated.variation);
  if (!magnetic.ok) return propagateFailure(magnetic);
  const deviation = interpolateCompassDeviation(input.deviationTable, magnetic.value.heading);
  if (!deviation.ok) return propagateFailure(deviation);
  const compass = convertMagneticToCompassHeading(magnetic.value.heading, deviation.value.deviation);
  if (!compass.ok) return propagateFailure(compass);
  const ete = calculateEstimatedTimeEnroute(distanceValue.value, windTriangle.value.groundspeed);
  if (!ete.ok) return propagateFailure(ete);
  const fuel = calculateFuelForDuration(ete.value.duration, validated.fuelFlow);
  if (!fuel.ok) return propagateFailure(fuel);
  return success({
    trueCourseDegrees: geometry.value.initialTrueCourse,
    windCorrectionAngleDegrees: windTriangle.value.windCorrectionAngle,
    trueHeadingDegrees: windTriangle.value.trueHeading,
    magneticHeadingDegrees: magnetic.value.heading,
    compassHeadingDegrees: compass.value.heading,
    groundspeedKnots: windTriangle.value.groundspeed,
    estimatedTimeEnrouteMinutes: ete.value.duration,
    estimatedFuelGallons: fuel.value.fuel,
    compassDeviationEastPositiveDegrees: deviation.value.deviation,
    traces: {
      effectiveWind: trace("selected-row-wind", [
        { name: "wind direction from", value: input.wind.directionFrom, unit: "degrees-true" },
        { name: "wind speed", value: input.wind.speed, unit: "knots" },
      ], [], { name: "selected wind speed", value: input.wind.speed, unit: "knots" }),
      windTriangle: windTriangle.value.trace,
      magneticVariation: trace("row-magnetic-variation", [
        { name: "true course", value: geometry.value.initialTrueCourse, unit: "degrees-true" },
        { name: "variation (east positive)", value: validated.variation, unit: "degrees" },
      ], [], { name: "variation (east positive)", value: validated.variation, unit: "degrees" }),
      trueToMagnetic: magnetic.value.trace,
      compassDeviation: deviation.value.trace,
      magneticToCompass: compass.value.trace,
      estimatedTimeEnroute: ete.value.trace,
      fuel: fuel.value.trace,
    },
  });
};

const calculateRowValues = (
  input: WaypointWorksheetRowInput,
  validated: ValidatedRowInputs,
): DomainResult<WaypointWorksheetRow> => {
  const routeDistanceDifference = input.endWaypoint.routeDistanceNauticalMiles - input.startWaypoint.routeDistanceNauticalMiles;
  if (!Number.isFinite(routeDistanceDifference) || routeDistanceDifference <= 0) {
    return failure("ROUTE_GEOMETRY_ERROR", "Waypoint row must have a positive route distance.", {
      startWaypointId: input.startWaypoint.id,
      endWaypointId: input.endWaypoint.id,
      startRouteDistanceNauticalMiles: input.startWaypoint.routeDistanceNauticalMiles,
      endRouteDistanceNauticalMiles: input.endWaypoint.routeDistanceNauticalMiles,
    });
  }
  const leg = calculateLeg(input, validated, routeDistanceDifference);
  if (!leg.ok) return propagateFailure(leg);
  const { compassDeviationEastPositiveDegrees, ...legResults } = leg.value;

  const endingFuelGallons = validated.startingFuelGallons - leg.value.estimatedFuelGallons;
  const cumulativeEstimatedMinutes = validated.priorElapsedMinutes + leg.value.estimatedTimeEnrouteMinutes;
  const cumulativeFuelUsedGallons = validated.priorFuelUsedGallons + leg.value.estimatedFuelGallons;
  if (![endingFuelGallons, cumulativeEstimatedMinutes, cumulativeFuelUsedGallons].every(Number.isFinite)) {
    return failure("NON_FINITE_RESULT", "Waypoint row totals are not finite.");
  }
  const endingTimeMilliseconds = validated.startingTimeMilliseconds + leg.value.estimatedTimeEnrouteMinutes * 60_000;
  if (!Number.isFinite(endingTimeMilliseconds) || Math.abs(endingTimeMilliseconds) > 8.64e15) {
    return failure("OUT_OF_RANGE", "Waypoint row ending UTC is outside the supported date range.");
  }

  return success({
    startWaypoint: input.startWaypoint,
    endWaypoint: input.endWaypoint,
    phase: input.phase,
    plannedAltitudeFeetMsl: validated.altitude,
    trueAirspeedKnots: validated.airspeed,
    fuelFlowGallonsPerHour: validated.fuelFlow,
    wind: input.wind,
    distanceNauticalMiles: routeDistanceDifference,
    ...legResults,
    startingEstimatedUtc: input.startingEstimatedUtc,
    endingEstimatedUtc: new Date(endingTimeMilliseconds).toISOString(),
    startingFuelGallons: validated.startingFuelGallons,
    endingFuelGallons,
    cumulativeEstimatedMinutes,
    cumulativeFuelUsedGallons,
    provenance: {
      startWaypointId: input.startWaypoint.id,
      endWaypointId: input.endWaypoint.id,
      selectedWind: input.wind,
      ...(input.weatherProvenance === undefined ? {} : { weather: input.weatherProvenance }),
      magneticVariationEastPositiveDegrees: validated.variation,
      compassDeviationEastPositiveDegrees,
      ...(input.performanceInputs === undefined ? {} : { performanceInputs: input.performanceInputs }),
    },
    warnings: [...(input.warnings ?? [])],
  });
};

/** Calculates one positive-distance worksheet row from its waypoint endpoints and selected inputs. */
export const calculateWaypointWorksheetRow = (
  input: WaypointWorksheetRowInput,
): DomainResult<WaypointWorksheetRow> => {
  const validated = validateRowInputs(input);
  if (!validated.ok) return propagateFailure(validated);
  return calculateRowValues(input, validated.value);
};
