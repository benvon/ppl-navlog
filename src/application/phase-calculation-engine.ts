import type { CompletePlanCalculationEngine, CompletePlanRouteLeg } from "./complete-plan";
import { assessProfileFeasibility, calculateConvergedVerticalPhase, type ConvergedVerticalPhase, type InfeasibleProfileResult } from "../domain/phase-planning";
import { calculateRouteDistance, placeTopOfDescent, placeTopOfClimb, type RouteGeometryLeg } from "../domain/phase-geometry";
import type { EffectiveWindResolver } from "../domain/phase-planning";
import { gallonsPerHour, feetMsl, positiveKnots, type NauticalMiles } from "../domain/units";
import type { AircraftProfile } from "../domain/aircraft";
import type { DomainResult } from "../domain/errors";
import type { JsonValue } from "../domain/route";

export class UnsupportedCompletePlanInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnsupportedCompletePlanInputError";
  }
}

/** Distinguishes missing/unsupported weather from an unsupported plan shape. */
export class WeatherPhaseResolutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WeatherPhaseResolutionError";
  }
}

/**
 * Concrete vertical-profile slice: departure climb, generated TOC, level
 * cruise distance, generated TOD, and arrival descent. It uses the selected
 * weather adapter's sampled-phase resolver and bounded phase convergence.
 *
 * Per-leg altitude changes are intentionally rejected until a phase-allocation
 * policy can assign an inter-leg transition to actual remaining route space.
 * It is not APP-01's complete per-leg navigation-log calculation: it does not
 * yet produce cruise heading, ETE, fuel, or compass-deviation rows.
 */
export const createVerticalProfileCalculationEngine = (): CompletePlanCalculationEngine => ({
  calculate: async ({ draft, aircraftProfile, routeLegs, weather }) => {
    const route = routeGeometry(routeLegs);
    const cruiseAltitude = uniformCruiseAltitude(routeLegs);
    const endpoints = phaseEndpoints(routeLegs);
    const { departure, firstCourse, lastCourse, finalLegStart } = endpoints;
    const departureAltitude = value(feetMsl(departure.elevationFeetMsl));
    const targetDescentAltitude = value(feetMsl(draft.descentTargetAltitudeFeetMsl.effectiveValue));
    const checkedCruiseAltitude = value(feetMsl(cruiseAltitude));
    const climbPerformance = performance(aircraftProfile, "climb");
    const descentPerformance = performance(aircraftProfile, "descent");
    const climb = value(calculateConvergedVerticalPhase({
      kind: "climb",
      start: departure.coordinate,
      course: firstCourse,
      startingAltitude: departureAltitude,
      targetAltitude: checkedCruiseAltitude,
      performance: climbPerformance,
    }, weather.phaseWindResolver));
    const descent = value(calculateConvergedVerticalPhase({
      kind: "descent",
      start: finalLegStart.coordinate,
      course: lastCourse,
      startingAltitude: checkedCruiseAltitude,
      targetAltitude: targetDescentAltitude,
      performance: descentPerformance,
    }, descentWindResolver(weather.phaseWindResolver, route)));
    const totalRouteDistance = value(calculateRouteDistance(route));
    const feasibility = value(assessProfileFeasibility(totalRouteDistance, climb.calculation.distance, descent.calculation.distance));
    return phasePlanResult(route, totalRouteDistance, feasibility, climb, descent);
  },
});

const routeGeometry = (routeLegs: readonly CompletePlanRouteLeg[]): readonly RouteGeometryLeg[] =>
  routeLegs.map((leg) => ({ sourceLegId: leg.sourceLeg.id, start: leg.start.coordinate, end: leg.end.coordinate }));

const phaseEndpoints = (routeLegs: readonly CompletePlanRouteLeg[]) => {
  const first = routeLegs[0];
  const final = routeLegs[routeLegs.length - 1];
  if (first === undefined || final === undefined) throw new UnsupportedCompletePlanInputError("A concrete phase calculation requires at least one complete route leg.");
  if (first.start.kind !== "airport" || final.end.kind !== "airport") throw new UnsupportedCompletePlanInputError("A concrete phase calculation requires airport departure and destination endpoints.");
  return { departure: first.start, firstCourse: first.trueCourse, lastCourse: final.trueCourse, finalLegStart: final.start };
};

const phasePlanResult = (
  route: readonly RouteGeometryLeg[],
  totalRouteDistance: NauticalMiles,
  feasibility: InfeasibleProfileResult,
  climb: ConvergedVerticalPhase,
  descent: ConvergedVerticalPhase,
) => {
  if (!feasibility.feasible) {
    const calculationSnapshot: JsonValue = {
      schema: "vertical-profile-plan/v1", status: "infeasible-profile", scope: "vertical-profile-only", routeDistanceNauticalMiles: feasibility.routeDistance,
      climbDistanceNauticalMiles: climb.calculation.distance, descentDistanceNauticalMiles: descent.calculation.distance,
      overlapDistanceNauticalMiles: feasibility.overlapDistance, climbIterations: climb.iterations, descentIterations: descent.iterations,
    };
    return { calculationSnapshot, warnings: ["Climb and descent requirements overlap; no cruise segment was invented."] };
  }
  const topOfClimb = value(placeTopOfClimb(route, climb.calculation.distance));
  const topOfDescent = value(placeTopOfDescent(route, descent.calculation.distance));
  const calculationSnapshot: JsonValue = {
    schema: "vertical-profile-plan/v1", status: "calculated", scope: "vertical-profile-only", routeDistanceNauticalMiles: totalRouteDistance,
    cruiseDistanceNauticalMiles: totalRouteDistance - climb.calculation.distance - descent.calculation.distance,
    climb: phaseSnapshot(climb.calculation, climb.iterations), descent: phaseSnapshot(descent.calculation, descent.iterations),
    topOfClimb: boundarySnapshot(topOfClimb), topOfDescent: boundarySnapshot(topOfDescent),
  };
  return { calculationSnapshot, warnings: ["Cruise navigation-log rows, heading conversions, ETE, and fuel summary are not calculated by this vertical-profile slice."] };
};

const descentWindResolver = (resolver: EffectiveWindResolver, route: readonly RouteGeometryLeg[]): EffectiveWindResolver => ({
  resolveEffectiveWind: (request) => {
    const topOfDescent = placeTopOfDescent(route, request.estimatedDistanceNauticalMiles);
    if (!topOfDescent.ok) return topOfDescent;
    return resolver.resolveEffectiveWind({ ...request, start: topOfDescent.value.coordinate });
  },
});

const uniformCruiseAltitude = (routeLegs: readonly CompletePlanRouteLeg[]): number => {
  const first = routeLegs[0]?.sourceLeg.cruiseAltitudeFeetMsl;
  if (first === undefined) throw new UnsupportedCompletePlanInputError("A concrete phase calculation requires a selected cruise altitude.");
  if (routeLegs.some((leg) => leg.sourceLeg.cruiseAltitudeFeetMsl !== first)) {
    throw new UnsupportedCompletePlanInputError("Per-leg altitude changes require explicit transition-phase allocation, which is not yet implemented.");
  }
  return first;
};

const performance = (profile: AircraftProfile, phase: "climb" | "descent") => ({
  verticalRateFeetPerMinute: phase === "climb" ? profile.climbRateFeetPerMinute : profile.descentRateFeetPerMinute,
  trueAirspeed: value(positiveKnots(phase === "climb" ? profile.climbTasKnots : profile.descentTasKnots)),
  fuelFlow: value(gallonsPerHour(phase === "climb" ? profile.climbFuelFlowGallonsPerHour : profile.descentFuelFlowGallonsPerHour)),
});

const phaseSnapshot = (phase: { readonly altitudeChange: number; readonly duration: number; readonly distance: number; readonly fuel: number; readonly windTriangle: { readonly groundspeed: number } }, iterations: number) => ({
  altitudeChangeFeet: phase.altitudeChange,
  durationMinutes: phase.duration,
  distanceNauticalMiles: phase.distance,
  fuelGallons: phase.fuel,
  groundspeedKnots: phase.windTriangle.groundspeed,
  convergenceIterations: iterations,
});

const boundarySnapshot = (boundary: { readonly coordinate: { readonly latitude: number; readonly longitude: number }; readonly sourceLegId: string; readonly routeDistance: number }) => ({
  latitude: boundary.coordinate.latitude,
  longitude: boundary.coordinate.longitude,
  sourceLegId: boundary.sourceLegId,
  routeDistanceNauticalMiles: boundary.routeDistance,
});

const value = <T>(result: DomainResult<T>): T => {
  if (!result.ok) {
    if (result.error.code === "UNSUPPORTED_WIND_ALTITUDE" || result.error.code === "INVALID_WIND_SAMPLING") {
      throw new WeatherPhaseResolutionError(result.error.message);
    }
    throw new UnsupportedCompletePlanInputError(result.error.message);
  }
  return result.value;
};
