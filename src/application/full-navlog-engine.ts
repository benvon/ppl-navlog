import type { AircraftProfile } from "../domain/aircraft";
import { failure, propagateFailure, success, type DomainError, type DomainResult } from "../domain/errors";
import type { RouteGeometryLeg } from "../domain/phase-geometry";
import type { VerticalPhasePerformance } from "../domain/phase-performance";
import type { JsonValue } from "../domain/route";
import { gallonsPerHour, feetMsl, positiveKnots } from "../domain/units";
import { resolveLoadedEffectiveWindForSubleg, type LoadedWindsData } from "../services/weather/winds-adapter";
import { isJsonValue } from "../services/storage/validation";
import type { CompletePlanCalculationEngine, CompletePlanRouteLeg, CompletePlanWeather } from "./complete-plan";
import { calculateNavlog, toNavlogCalculationSnapshot, type NavlogWindResolver } from "./navlog-calculation";
import { allocateRoutePhases, type RoutePhaseAllocationInput, type RoutePhaseAllocationResult } from "./phase-allocation";
import { UnsupportedCompletePlanInputError, WeatherPhaseResolutionError } from "./phase-calculation-engine";
import { createWaypointNavlogWindResolver } from "./route-weather-sampling";

/**
 * The complete calculation engine. It composes only selected immutable weather
 * evidence, phase allocation, and navigation-row calculation; it never fetches
 * data, chooses forecasts, or turns an infeasible allocation into a route.
 */
export const createFullNavlogCalculationEngine = (): CompletePlanCalculationEngine => ({
  calculate: async ({ draft, aircraftProfile, routeLegs, weather }) => {
    const routeSamples = weather.routeWeatherSamples;
    const loadedWinds = weather.loadedWindsData;
    if (routeSamples === undefined && loadedWinds === undefined) {
      throw new WeatherPhaseResolutionError("Complete navlog calculation requires immutable route waypoint answers or legacy loaded winds data.");
    }
    const allocationInput = allocationInputFor(draft.descentTargetAltitudeFeetMsl.effectiveValue, aircraftProfile, routeLegs, weather);
    const allocation = allocateRoutePhases(requireValue(allocationInput));
    const allocatedPlan = requireValue(allocation);

    if (allocatedPlan.status === "infeasible") {
      const snapshot = requireValue(completeSnapshot("infeasible-phase-allocation", allocatedPlan, weather));
      return { calculationSnapshot: snapshot, warnings: allocatedPlan.warnings };
    }

    const navlog = calculateNavlog({
      allocatedSublegs: allocatedPlan.sublegs,
      routeLegs: routeLegs.map((routeLeg) => ({
        sourceLeg: routeLeg.sourceLeg,
        magneticVariation: routeLeg.magneticVariation,
      })),
      aircraftProfile,
      fuelInputs: draft.fuelInputs,
      windResolver: routeSamples !== undefined
        ? createWaypointNavlogWindResolver(routeLegs, routeSamples, weather, aircraftProfile)
        : navlogWindResolver(loadedWinds!),
    });
    const calculatedNavlog = requireValue(navlog);
    const navlogSnapshot = requireValue(toNavlogCalculationSnapshot(calculatedNavlog));
    const snapshot = requireValue(completeSnapshot("calculated", allocatedPlan, weather, navlogSnapshot));
    return { calculationSnapshot: snapshot, warnings: unique([...allocatedPlan.warnings, ...calculatedNavlog.warnings]) };
  },
});

const allocationInputFor = (
  descentTargetAltitudeFeetMsl: number,
  profile: AircraftProfile,
  routeLegs: readonly CompletePlanRouteLeg[],
  weather: CompletePlanWeather,
): DomainResult<RoutePhaseAllocationInput> => {
  const first = routeLegs[0];
  const final = routeLegs[routeLegs.length - 1];
  if (first === undefined || final === undefined || first.start.kind !== "airport" || final.end.kind !== "airport") {
    return failure("ROUTE_GEOMETRY_ERROR", "A complete navlog requires airport departure and destination endpoints.");
  }
  const departureAltitude = feetMsl(first.start.elevationFeetMsl);
  if (!departureAltitude.ok) return propagateFailure(departureAltitude);
  const destinationAltitude = feetMsl(descentTargetAltitudeFeetMsl);
  if (!destinationAltitude.ok) return propagateFailure(destinationAltitude);
  const climbPerformance = verticalPerformance(profile, "climb");
  if (!climbPerformance.ok) return propagateFailure(climbPerformance);
  const descentPerformance = verticalPerformance(profile, "descent");
  if (!descentPerformance.ok) return propagateFailure(descentPerformance);
  const legAltitudes = checkedLegAltitudes(routeLegs);
  if (!legAltitudes.ok) return propagateFailure(legAltitudes);
  return success({
    route: routeLegs.map(toRouteGeometry),
    legAltitudes: legAltitudes.value,
    departureAltitude: departureAltitude.value,
    destinationAltitude: destinationAltitude.value,
    climbPerformance: climbPerformance.value,
    descentPerformance: descentPerformance.value,
    windResolver: weather.phaseWindResolver,
  });
};

const toRouteGeometry = (routeLeg: CompletePlanRouteLeg): RouteGeometryLeg => ({
  sourceLegId: routeLeg.sourceLeg.id,
  start: routeLeg.start.coordinate,
  end: routeLeg.end.coordinate,
});

const checkedLegAltitudes = (routeLegs: readonly CompletePlanRouteLeg[]): DomainResult<RoutePhaseAllocationInput["legAltitudes"]> => {
  const result: RoutePhaseAllocationInput["legAltitudes"][number][] = [];
  for (const routeLeg of routeLegs) {
    const cruiseAltitude = feetMsl(routeLeg.sourceLeg.cruiseAltitudeFeetMsl);
    if (!cruiseAltitude.ok) return propagateFailure(cruiseAltitude);
    result.push({ sourceLegId: routeLeg.sourceLeg.id, cruiseAltitude: cruiseAltitude.value });
  }
  return success(result);
};

const verticalPerformance = (
  profile: AircraftProfile,
  phase: "climb" | "descent",
): DomainResult<Omit<VerticalPhasePerformance, "effectiveWind">> => {
  const climb = phase === "climb";
  const trueAirspeed = positiveKnots(climb ? profile.climbTasKnots : profile.descentTasKnots);
  if (!trueAirspeed.ok) return propagateFailure(trueAirspeed);
  const fuelFlow = gallonsPerHour(climb ? profile.climbFuelFlowGallonsPerHour : profile.descentFuelFlowGallonsPerHour);
  if (!fuelFlow.ok) return propagateFailure(fuelFlow);
  const verticalRateFeetPerMinute = climb ? profile.climbRateFeetPerMinute : profile.descentRateFeetPerMinute;
  if (!Number.isFinite(verticalRateFeetPerMinute) || verticalRateFeetPerMinute <= 0) {
    return failure("INVALID_PHASE_PERFORMANCE", "Vertical rate must be finite and greater than zero.", { verticalRateFeetPerMinute });
  }
  return success({ verticalRateFeetPerMinute, trueAirspeed: trueAirspeed.value, fuelFlow: fuelFlow.value });
};

const navlogWindResolver = (loadedWinds: LoadedWindsData): NavlogWindResolver => ({
  resolveEffectiveWind: ({ subleg }) => {
    const resolved = resolveLoadedEffectiveWindForSubleg(loadedWinds, subleg.startingAltitude, subleg.endingAltitude);
    if (!resolved.ok) return propagateFailure(resolved);
    return success({
      wind: {
        computedValue: resolved.value.wind,
        effectiveValue: resolved.value.wind,
        origin: resolved.value.method === "sampled-phase-wind" ? "interpolated" : "external-data",
        provenance: {
          sourceId: `winds-aloft:${loadedWinds.forecastPayload.forecast.station.id}:${loadedWinds.forecastSelection.period.id}:${subleg.id}`,
          sourceLabel: resolved.value.method === "sampled-phase-wind" ? "Selected winds-aloft effective wind" : "Selected winds-aloft altitude wind",
          sourceVersion: `${loadedWinds.forecastPayload.forecast.source}; issued ${loadedWinds.forecastPayload.forecast.issuedAt}`,
          recordedAt: loadedWinds.forecastPayload.forecast.fetchedAt,
        },
        explanation: { formulaId: resolved.value.trace.formulaId, formulaVersion: resolved.value.trace.formulaVersion },
      },
      trace: resolved.value.trace,
      ...(resolved.value.surfaceToAloftInterpolation === undefined ? {} : { surfaceToAloftInterpolation: resolved.value.surfaceToAloftInterpolation }),
    });
  },
});

const completeSnapshot = (
  status: "calculated" | "infeasible-phase-allocation",
  allocation: RoutePhaseAllocationResult,
  weather: CompletePlanWeather,
  navlog?: JsonValue,
): DomainResult<JsonValue> => jsonValue({
  schema: "complete-navlog/v1",
  status,
  weather: {
    selectedForecastValidTimeUtc: weather.selectedForecastValidTimeUtc,
    snapshotIds: weather.snapshotIds,
    provenance: weather.provenance,
  },
  phaseAllocation: allocation,
  ...(navlog === undefined ? {} : { navlog }),
});

const jsonValue = (value: unknown): DomainResult<JsonValue> => {
  try {
    const serialized = JSON.stringify(value, (_key, nested: unknown) => {
      if (typeof nested === "number" && !Number.isFinite(nested)) throw new Error("Complete navlog snapshot contains a non-finite number.");
      return nested;
    });
    if (serialized === undefined) return failure("INVALID_NUMBER", "Complete navlog snapshot could not be serialized as JSON.");
    const parsed: unknown = JSON.parse(serialized);
    return isJsonValue(parsed)
      ? success(parsed)
      : failure("INVALID_NUMBER", "Complete navlog snapshot is not valid finite JSON.");
  } catch (error) {
    return failure("INVALID_NUMBER", error instanceof Error ? error.message : "Complete navlog snapshot could not be serialized as JSON.");
  }
};

const throwError = (result: { readonly ok: false; readonly error: DomainError }): never => {
  if (result.error.code === "UNSUPPORTED_WIND_ALTITUDE" || result.error.code === "INVALID_WIND_SAMPLING") {
    throw new WeatherPhaseResolutionError(result.error.message);
  }
  throw new UnsupportedCompletePlanInputError(result.error.message);
};

const requireValue = <T>(result: DomainResult<T>): T => {
  if (result.ok) return result.value;
  return throwError(result);
};

const unique = (warnings: readonly string[]): readonly string[] => [...new Set(warnings)];
