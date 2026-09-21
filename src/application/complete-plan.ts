import { calculateGreatCircleDistanceAndInitialCourse, pointAlongGreatCircle } from "../domain/distance-course";
import type { EffectiveWindResolver } from "../domain/phase-planning";
import type { PlanDraft, RoutePoint, UserRouteLeg, JsonValue, WeatherReferenceSnapshot } from "../domain/route";
import type { AircraftProfile } from "../domain/aircraft";
import type { Coordinate } from "../domain/coordinates";
import type { LoadedWindsData } from "../services/weather/winds-adapter";
import type { NauticalMiles, TrueCourse } from "../domain/units";
import { nauticalMiles } from "../domain/units";
import {
  calculatePlanningMagneticVariation,
  type CalculatedMagneticVariation,
  type MagneticVariationCalculator,
} from "./magnetic-variation";
import { UnsupportedCompletePlanInputError, WeatherPhaseResolutionError } from "./phase-calculation-engine";

export interface CompletePlanRouteLeg {
  readonly sourceLeg: UserRouteLeg;
  readonly start: RoutePoint;
  readonly end: RoutePoint;
  readonly distance: NauticalMiles;
  readonly trueCourse: TrueCourse;
  /** The midpoint is the documented representative location for leg variation. */
  readonly magneticCoordinate: Coordinate;
  readonly magneticVariation: CalculatedMagneticVariation;
}

export interface CompletePlanWeather {
  readonly snapshotIds: readonly string[];
  /** New immutable evidence awaiting atomic persistence with its plan revision. */
  readonly referenceSnapshots?: readonly WeatherReferenceSnapshot[];
  readonly selectedForecastValidTimeUtc: string;
  readonly phaseWindResolver: EffectiveWindResolver;
  /** Immutable selected source data for per-subleg winds and teaching traces. */
  readonly loadedWindsData?: LoadedWindsData;
  readonly warnings: readonly string[];
  readonly provenance: JsonValue;
}

export interface CompletePlanWeatherResolver {
  resolve(input: {
    readonly draft: PlanDraft;
    readonly aircraftProfile: AircraftProfile;
    readonly routeLegs: readonly Omit<CompletePlanRouteLeg, "magneticVariation">[];
  }): Promise<CompletePlanWeather>;
}

export interface CompletePlanCalculationEngine {
  calculate(input: {
    readonly draft: PlanDraft;
    readonly aircraftProfile: AircraftProfile;
    readonly routeLegs: readonly CompletePlanRouteLeg[];
    readonly weather: CompletePlanWeather;
  }): Promise<{ readonly calculationSnapshot: JsonValue; readonly warnings: readonly string[] }>;
}

export type CompletePlanResult =
  | {
    readonly status: "ready";
    readonly routeLegs: readonly CompletePlanRouteLeg[];
    readonly weather: CompletePlanWeather;
    readonly calculationSnapshot: JsonValue;
    readonly warnings: readonly string[];
  }
  | {
    readonly status: "blocked";
    readonly reason: "invalid-route" | "weather-unavailable" | "magnetic-unavailable" | "unsupported-plan-input" | "calculation-failed";
    readonly message: string;
    readonly warnings: readonly string[];
  };

export interface CompletePlanDependencies {
  readonly weather: CompletePlanWeatherResolver;
  readonly magnetic?: MagneticVariationCalculator;
  readonly calculations: CompletePlanCalculationEngine;
}

/**
 * The application boundary that composes immutable route/profile inputs with
 * weather, WMM variation, and phase calculations. It intentionally returns a
 * blocked state instead of inventing a fallback when any external datum fails.
 */
export const calculateCompletePlan = async (
  draft: PlanDraft,
  aircraftProfile: AircraftProfile,
  dependencies: CompletePlanDependencies,
): Promise<CompletePlanResult> => {
  if (draft.selectedAircraftProfileId !== aircraftProfile.id) {
    return blocked("invalid-route", "The selected aircraft profile does not match the plan draft.");
  }
  const baseLegs = buildRouteLegs(draft);
  if (!baseLegs.ok) return blocked("invalid-route", baseLegs.message);

  let weather: CompletePlanWeather;
  try {
    weather = await dependencies.weather.resolve({ draft, aircraftProfile, routeLegs: baseLegs.value });
  } catch (error) {
    return blocked("weather-unavailable", errorMessage(error, "Weather inputs are unavailable; the plan was not calculated."));
  }
  if (!isValidUtcInstant(weather.selectedForecastValidTimeUtc)) {
    return blocked("weather-unavailable", "Weather resolution did not provide an explicit UTC forecast-valid time.", weather.warnings);
  }

  const routeLegs: CompletePlanRouteLeg[] = [];
  try {
    for (const leg of baseLegs.value) {
      const magneticVariation = calculatePlanningMagneticVariation({
        coordinate: leg.magneticCoordinate,
        date: new Date(draft.departureTimeUtc),
        altitudeFeetMsl: leg.sourceLeg.cruiseAltitudeFeetMsl,
      }, dependencies.magnetic);
      routeLegs.push({ ...leg, magneticVariation });
    }
  } catch (error) {
    return blocked("magnetic-unavailable", errorMessage(error, "Magnetic variation is unavailable; the plan was not calculated."), weather.warnings);
  }

  try {
    const calculation = await dependencies.calculations.calculate({ draft, aircraftProfile, routeLegs, weather });
    return {
      status: "ready",
      routeLegs,
      weather,
      calculationSnapshot: calculation.calculationSnapshot,
      warnings: [...weather.warnings, ...calculation.warnings],
    };
  } catch (error) {
    if (error instanceof WeatherPhaseResolutionError) {
      return blocked("weather-unavailable", error.message, weather.warnings);
    }
    if (error instanceof UnsupportedCompletePlanInputError) {
      return blocked("unsupported-plan-input", error.message, weather.warnings);
    }
    return blocked("calculation-failed", errorMessage(error, "Phase calculation failed; the plan was not saved."), weather.warnings);
  }
};

type BaseRouteLeg = Omit<CompletePlanRouteLeg, "magneticVariation">;

const buildRouteLegs = (draft: PlanDraft): { readonly ok: true; readonly value: readonly BaseRouteLeg[] } | { readonly ok: false; readonly message: string } => {
  if (!isValidUtcInstant(draft.departureTimeUtc)) return { ok: false, message: "Plan departure time must be a valid ISO-8601 UTC instant." };
  const pointsById = new Map(draft.route.points.map((point) => [point.id, point]));
  if (draft.route.legs.length === 0) return { ok: false, message: "A complete plan requires at least one route leg." };
  const result: BaseRouteLeg[] = [];
  for (const sourceLeg of draft.route.legs) {
    const start = pointsById.get(sourceLeg.fromPointId);
    const end = pointsById.get(sourceLeg.toPointId);
    if (start === undefined || end === undefined) return { ok: false, message: `Route leg ${sourceLeg.id} references a missing route point.` };
    const geometry = calculateGreatCircleDistanceAndInitialCourse(start.coordinate, end.coordinate);
    if (!geometry.ok) return { ok: false, message: geometry.error.message };
    const midpointDistance = nauticalMiles(geometry.value.distance / 2);
    if (!midpointDistance.ok) return { ok: false, message: midpointDistance.error.message };
    const midpoint = pointAlongGreatCircle(start.coordinate, geometry.value.initialTrueCourse, midpointDistance.value);
    if (!midpoint.ok) return { ok: false, message: midpoint.error.message };
    result.push({
      sourceLeg,
      start,
      end,
      distance: geometry.value.distance,
      trueCourse: geometry.value.initialTrueCourse,
      magneticCoordinate: midpoint.value,
    });
  }
  return { ok: true, value: result };
};

const isValidUtcInstant = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && !Number.isNaN(Date.parse(value));

const errorMessage = (error: unknown, fallback: string): string => error instanceof Error && error.message.length > 0 ? error.message : fallback;

const blocked = (reason: Extract<CompletePlanResult, { readonly status: "blocked" }>["reason"], message: string, warnings: readonly string[] = []): CompletePlanResult => ({
  status: "blocked",
  reason,
  message,
  warnings,
});
