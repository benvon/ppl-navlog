import type { AircraftProfile } from "../domain/aircraft";
import type { CalculationTrace } from "../domain/calculation-trace";
import { interpolateCompassDeviation, deviationTablePoint } from "../domain/deviation";
import { propagateFailure, failure, success, type DomainResult } from "../domain/errors";
import { convertMagneticToCompassHeading, convertTrueToMagneticHeading } from "../domain/heading-conversion";
import type { PlanningOverride, PlanningValue } from "../domain/planning-value";
import { calculateFuelSummary } from "../domain/phase-planning";
import type { JsonValue, UserRouteLeg } from "../domain/route";
import { calculateEstimatedTimeEnroute, calculateFuelForDuration } from "../domain/time-fuel";
import {
  feetMsl,
  gallons,
  gallonsPerHour,
  minutes,
  nauticalMiles,
  positiveKnots,
  type Gallons,
  type GallonsPerHour,
  type Knots,
  type Minutes,
  type NauticalMiles,
  type SignedDegrees,
} from "../domain/units";
import type { Wind } from "../domain/wind";
import { solveWindTriangle } from "../domain/wind-triangle";
import type { AppliedSurfaceToAloftInterpolation } from "../services/weather/winds-adapter";
import type { AllocatedRouteSubLeg } from "./phase-allocation";

/** Exact allocation contract; all route geometry is established upstream. */
export type AllocatedNavlogSubleg = AllocatedRouteSubLeg;
export type NavlogPhaseKind = AllocatedNavlogSubleg["phase"];

/**
 * This record is deliberately retained on the result whenever surface METAR
 * wind was used to bridge the field-elevation to first-aloft-level gap.
 */
export type SurfaceToAloftInterpolationProvenance = AppliedSurfaceToAloftInterpolation;

export interface ResolvedNavlogWind {
  /** A calculated/interpolated value may retain a guarded manual replacement. */
  readonly wind: PlanningValue<Wind>;
  readonly trace: CalculationTrace;
  readonly warnings?: readonly string[];
  /** Present only when the resolver actually used a METAR field-elevation anchor. */
  readonly surfaceToAloftInterpolation?: SurfaceToAloftInterpolationProvenance;
}

export interface NavlogWindRequest {
  readonly subleg: AllocatedNavlogSubleg;
}

/** Synchronous by design: data retrieval belongs outside this calculation seam. */
export interface NavlogWindResolver {
  resolveEffectiveWind(request: NavlogWindRequest): DomainResult<ResolvedNavlogWind>;
}

export interface NavlogSourceLeg {
  readonly sourceLeg: UserRouteLeg;
  readonly magneticVariation: {
    readonly variation: PlanningValue<SignedDegrees>;
    readonly trace: CalculationTrace;
  };
}

export interface NavlogCalculationInput {
  readonly allocatedSublegs: readonly AllocatedNavlogSubleg[];
  readonly routeLegs: readonly NavlogSourceLeg[];
  readonly aircraftProfile: AircraftProfile;
  readonly fuelInputs: {
    readonly taxiRunupFuelGallons: number;
    readonly reserveFuelGallons: number;
  };
  readonly windResolver: NavlogWindResolver;
}

/** Static inputs shared by a progressive, one-row-at-a-time calculation. */
export type NavlogCalculationSessionInput = Omit<NavlogCalculationInput, "allocatedSublegs">;

/** Validated inputs that do not change as finalized route rows are carried forward. */
export interface NavlogCalculationSession {
  readonly routeLegs: ReadonlyMap<string, NavlogSourceLeg>;
  readonly aircraftProfile: AircraftProfile;
  readonly taxiRunupFuel: Gallons;
  readonly reserveFuel: Gallons;
  readonly usableFuel?: Gallons;
  readonly windResolver: NavlogWindResolver;
}

/** Immutable accumulator returned after each fully calculated interval. */
export interface NavlogCalculationState {
  readonly rows: readonly NavlogCalculationRow[];
  readonly cumulativeDistance: NauticalMiles;
  readonly cumulativeMinutes: Minutes;
  readonly cumulativeEnrouteFuel: Gallons;
}

export interface FinalizedNavlogRow {
  readonly row: NavlogCalculationRow;
  readonly state: NavlogCalculationState;
}

export interface AppliedNavlogOverride {
  readonly input: "effective-wind" | "true-airspeed" | "fuel-flow" | "magnetic-variation";
  readonly computedValue: number | Wind | null;
  readonly effectiveValue: number | Wind;
  readonly reason?: string;
  readonly createdAt: string;
}

export interface NavlogCalculationRow {
  readonly subleg: AllocatedNavlogSubleg;
  readonly effectiveWind: ResolvedNavlogWind;
  readonly trueAirspeed: PlanningValue<Knots>;
  readonly fuelFlow: PlanningValue<GallonsPerHour>;
  readonly windCorrectionAngle: SignedDegrees;
  readonly trueHeading: number;
  readonly variation: PlanningValue<SignedDegrees>;
  readonly magneticHeading: number;
  readonly compassDeviation: SignedDegrees;
  readonly compassHeading: number;
  readonly groundspeed: Knots;
  readonly estimatedTimeEnroute: Minutes;
  readonly fuel: Gallons;
  readonly cumulative: {
    readonly routeDistance: NauticalMiles;
    readonly estimatedTimeEnroute: Minutes;
    readonly enrouteFuel: Gallons;
    readonly requiredFuelWithTaxiRunup: Gallons;
    readonly requiredFuelWithTaxiRunupAndReserve: Gallons;
  };
  /** User-facing disclosure, not a warning hidden in a diagnostic-only trace. */
  readonly assumptions: readonly string[];
  /** Guarded input replacements used in this row, if any. */
  readonly appliedOverrides: readonly AppliedNavlogOverride[];
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
}

export interface NavlogCalculationResult {
  readonly schema: "navlog-calculation/v1";
  readonly rows: readonly NavlogCalculationRow[];
  readonly fuelSummary: ReturnType<typeof calculateFuelSummary> extends DomainResult<infer T> ? T : never;
  readonly warnings: readonly string[];
}

/** Prepares stable calculation inputs before a progressive row sequence begins. */
export const createNavlogCalculationSession = (input: NavlogCalculationSessionInput): DomainResult<NavlogCalculationSession> => {
  const taxiRunupFuel = gallons(input.fuelInputs.taxiRunupFuelGallons);
  if (!taxiRunupFuel.ok) return propagateFailure(taxiRunupFuel);
  const reserveFuel = gallons(input.fuelInputs.reserveFuelGallons);
  if (!reserveFuel.ok) return propagateFailure(reserveFuel);
  const usableFuelResult = input.aircraftProfile.usableFuelGallons === undefined ? undefined : gallons(input.aircraftProfile.usableFuelGallons);
  if (usableFuelResult !== undefined && !usableFuelResult.ok) return propagateFailure(usableFuelResult);
  return success({
    routeLegs: new Map(input.routeLegs.map((routeLeg) => [routeLeg.sourceLeg.id, routeLeg])),
    aircraftProfile: input.aircraftProfile,
    taxiRunupFuel: taxiRunupFuel.value,
    reserveFuel: reserveFuel.value,
    ...(usableFuelResult === undefined ? {} : { usableFuel: usableFuelResult.value }),
    windResolver: input.windResolver,
  });
};

export const createNavlogCalculationState = (): NavlogCalculationState => ({
  rows: [], cumulativeDistance: 0 as NauticalMiles,
  cumulativeMinutes: 0 as Minutes,
  cumulativeEnrouteFuel: 0 as Gallons,
});

/** Calculates and finalizes one interval exactly once, carrying its totals forward. */
export const calculateNavlogRow = (
  session: NavlogCalculationSession,
  state: NavlogCalculationState,
  subleg: AllocatedNavlogSubleg,
  windResolver: NavlogWindResolver = session.windResolver,
): DomainResult<FinalizedNavlogRow> => {
  const sourceLeg = session.routeLegs.get(subleg.sourceLegId);
  const calculated = calculateRow(subleg, sourceLeg, session.aircraftProfile, windResolver);
  if (!calculated.ok) return propagateFailure(calculated);
  const distance = nauticalMiles(state.cumulativeDistance + subleg.distance);
  if (!distance.ok) return propagateFailure(distance);
  const duration = minutes(state.cumulativeMinutes + calculated.value.estimatedTimeEnroute);
  if (!duration.ok) return propagateFailure(duration);
  const enrouteFuel = gallons(state.cumulativeEnrouteFuel + calculated.value.fuel);
  if (!enrouteFuel.ok) return propagateFailure(enrouteFuel);
  const cumulative = cumulativeValues(distance.value, duration.value, enrouteFuel.value, session.taxiRunupFuel, session.reserveFuel);
  if (!cumulative.ok) return propagateFailure(cumulative);
  const row = { ...calculated.value, cumulative: cumulative.value };
  const nextState: NavlogCalculationState = {
    rows: [...state.rows, row],
    cumulativeDistance: distance.value,
    cumulativeMinutes: duration.value,
    cumulativeEnrouteFuel: enrouteFuel.value,
  };
  return success({ row, state: nextState });
};

/** Produces route totals from the already finalized rows; no row is recalculated. */
export const finalizeNavlog = (
  session: NavlogCalculationSession,
  state: NavlogCalculationState,
): DomainResult<NavlogCalculationResult> => {
  const phaseFuel: Record<"climb" | "transition" | "cruise" | "descent", Gallons[]> = {
    climb: [], transition: [], cruise: [], descent: [],
  };
  const warnings: string[] = [];
  for (const row of state.rows) {
    phaseFuel[phaseFuelBucket(row.subleg.phase)].push(row.fuel);
    warnings.push(...(row.effectiveWind.warnings ?? []), ...row.assumptions);
  }
  const summary = calculateFuelSummary({
    taxiRunupFuel: session.taxiRunupFuel,
    climbFuel: sumGallons(phaseFuel.climb),
    transitionFuel: sumGallons(phaseFuel.transition),
    cruiseFuel: sumGallons(phaseFuel.cruise),
    descentFuel: sumGallons(phaseFuel.descent),
    reserveFuel: session.reserveFuel,
    ...(session.usableFuel === undefined ? {} : { usableFuel: session.usableFuel }),
  });
  if (!summary.ok) return propagateFailure(summary);
  return success({ schema: "navlog-calculation/v1", rows: state.rows, fuelSummary: summary.value, warnings: unique(warnings) });
};

/**
 * Compatibility wrapper for callers that already have all allocated intervals.
 * Progressive planners should call calculateNavlogRow as each interval is ready.
 */
export const calculateNavlog = (input: NavlogCalculationInput): DomainResult<NavlogCalculationResult> => {
  const session = createNavlogCalculationSession(input);
  if (!session.ok) return propagateFailure(session);
  let state = createNavlogCalculationState();
  for (const subleg of input.allocatedSublegs) {
    const result = calculateNavlogRow(session.value, state, subleg);
    if (!result.ok) return propagateFailure(result);
    state = result.value.state;
  }
  return finalizeNavlog(session.value, state);
};

type NavlogRowWithoutCumulative = Omit<NavlogCalculationRow, "cumulative">;

const calculateRow = (
  subleg: AllocatedNavlogSubleg,
  sourceLeg: NavlogSourceLeg | undefined,
  profile: AircraftProfile,
  windResolver: NavlogWindResolver,
): DomainResult<NavlogRowWithoutCumulative> => {
  if (sourceLeg === undefined) return missingSourceLeg(subleg);
  const performance = performanceFor(subleg, sourceLeg.sourceLeg, profile);
  if (!performance.ok) return propagateFailure(performance);
  const resolvedWind = windResolver.resolveEffectiveWind({ subleg });
  if (!resolvedWind.ok) return propagateFailure(resolvedWind);
  const validSurfaceInterpolation = validateSurfaceInterpolation(resolvedWind.value.surfaceToAloftInterpolation);
  if (!validSurfaceInterpolation.ok) return propagateFailure(validSurfaceInterpolation);
  return calculateHeadingAndFuelRow(subleg, sourceLeg, profile, performance.value, resolvedWind.value);
};

const missingSourceLeg = (subleg: AllocatedNavlogSubleg): DomainResult<never> =>
  failure("ROUTE_GEOMETRY_ERROR", "Allocated subleg references a source route leg that is not available.", {
    sublegId: subleg.id, sourceLegId: subleg.sourceLegId,
  });

const calculateHeadingAndFuelRow = (
  subleg: AllocatedNavlogSubleg,
  sourceLeg: NavlogSourceLeg,
  profile: AircraftProfile,
  performance: { readonly trueAirspeed: PlanningValue<Knots>; readonly fuelFlow: PlanningValue<GallonsPerHour> },
  effectiveWind: ResolvedNavlogWind,
): DomainResult<NavlogRowWithoutCumulative> => {
  const windTriangle = solveWindTriangle(subleg.trueCourse, performance.trueAirspeed.effectiveValue, effectiveWind.wind.effectiveValue);
  if (!windTriangle.ok) return propagateFailure(windTriangle);
  const magnetic = convertTrueToMagneticHeading(windTriangle.value.trueHeading, sourceLeg.magneticVariation.variation.effectiveValue);
  if (!magnetic.ok) return propagateFailure(magnetic);
  const deviation = deviationFor(profile, magnetic.value.heading);
  if (!deviation.ok) return propagateFailure(deviation);
  const compass = convertMagneticToCompassHeading(magnetic.value.heading, deviation.value.deviation);
  if (!compass.ok) return propagateFailure(compass);
  const ete = calculateEstimatedTimeEnroute(subleg.distance, windTriangle.value.groundspeed);
  if (!ete.ok) return propagateFailure(ete);
  const fuel = calculateFuelForDuration(ete.value.duration, performance.fuelFlow.effectiveValue);
  if (!fuel.ok) return propagateFailure(fuel);
  return success(rowWithoutCumulative(subleg, sourceLeg, performance, effectiveWind, windTriangle.value, magnetic.value, deviation.value, compass.value, ete.value, fuel.value));
};

const rowWithoutCumulative = (
  subleg: AllocatedNavlogSubleg,
  sourceLeg: NavlogSourceLeg,
  performance: { readonly trueAirspeed: PlanningValue<Knots>; readonly fuelFlow: PlanningValue<GallonsPerHour> },
  effectiveWind: ResolvedNavlogWind,
  windTriangle: ReturnType<typeof solveWindTriangle> extends DomainResult<infer T> ? T : never,
  magnetic: ReturnType<typeof convertTrueToMagneticHeading> extends DomainResult<infer T> ? T : never,
  deviation: ReturnType<typeof deviationFor> extends DomainResult<infer T> ? T : never,
  compass: ReturnType<typeof convertMagneticToCompassHeading> extends DomainResult<infer T> ? T : never,
  ete: ReturnType<typeof calculateEstimatedTimeEnroute> extends DomainResult<infer T> ? T : never,
  fuel: ReturnType<typeof calculateFuelForDuration> extends DomainResult<infer T> ? T : never,
): NavlogRowWithoutCumulative => {
  const assumptions = assumptionsFor(effectiveWind);
  return {
    subleg, effectiveWind, trueAirspeed: performance.trueAirspeed, fuelFlow: performance.fuelFlow,
    windCorrectionAngle: windTriangle.windCorrectionAngle, trueHeading: windTriangle.trueHeading,
    variation: sourceLeg.magneticVariation.variation, magneticHeading: magnetic.heading,
    compassDeviation: deviation.deviation, compassHeading: compass.heading, groundspeed: windTriangle.groundspeed,
    estimatedTimeEnroute: ete.duration, fuel: fuel.fuel, assumptions,
    appliedOverrides: appliedOverrides(effectiveWind.wind, performance.trueAirspeed, performance.fuelFlow, sourceLeg.magneticVariation.variation),
    traces: {
      effectiveWind: effectiveWind.trace, windTriangle: windTriangle.trace, magneticVariation: sourceLeg.magneticVariation.trace,
      trueToMagnetic: magnetic.trace, compassDeviation: deviation.trace, magneticToCompass: compass.trace,
      estimatedTimeEnroute: ete.trace, fuel: fuel.trace,
    },
  };
};

const cumulativeValues = (
  distance: number,
  duration: number,
  enrouteFuel: number,
  taxiRunupFuel: Gallons,
  reserveFuel: Gallons,
): DomainResult<NavlogCalculationRow["cumulative"]> => {
  const checkedDistance = nauticalMiles(distance);
  if (!checkedDistance.ok) return propagateFailure(checkedDistance);
  const checkedDuration = minutes(duration);
  if (!checkedDuration.ok) return propagateFailure(checkedDuration);
  const checkedEnrouteFuel = gallons(enrouteFuel);
  if (!checkedEnrouteFuel.ok) return propagateFailure(checkedEnrouteFuel);
  const withTaxi = gallons(checkedEnrouteFuel.value + taxiRunupFuel);
  if (!withTaxi.ok) return propagateFailure(withTaxi);
  const withReserve = gallons(withTaxi.value + reserveFuel);
  if (!withReserve.ok) return propagateFailure(withReserve);
  return success({ routeDistance: checkedDistance.value, estimatedTimeEnroute: checkedDuration.value, enrouteFuel: checkedEnrouteFuel.value, requiredFuelWithTaxiRunup: withTaxi.value, requiredFuelWithTaxiRunupAndReserve: withReserve.value });
};

/**
 * Removes absent optional fields and rejects non-finite values before the
 * calculation result crosses into immutable JSON persistence.
 */
export const toNavlogCalculationSnapshot = (result: NavlogCalculationResult): DomainResult<JsonValue> => {
  try {
    const serialized = JSON.stringify(result, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("A navlog snapshot contains a non-finite number.");
      return value;
    });
    if (serialized === undefined) return failure("INVALID_NUMBER", "Navlog calculation could not be serialized as JSON.");
    return success(JSON.parse(serialized) as JsonValue);
  } catch (error) {
    return failure("INVALID_NUMBER", error instanceof Error ? error.message : "Navlog calculation could not be serialized as JSON.");
  }
};

const phaseFuelBucket = (phase: NavlogPhaseKind): "climb" | "transition" | "cruise" | "descent" => {
  if (phase === "climb") return "climb";
  if (phase === "descent") return "descent";
  if (phase === "cruise") return "cruise";
  return "transition";
};

const sumGallons = (values: readonly Gallons[]): Gallons => values.reduce((total, value) => total + value, 0) as Gallons;

const performanceFor = (
  subleg: AllocatedNavlogSubleg,
  sourceLeg: UserRouteLeg,
  profile: AircraftProfile,
): DomainResult<{ readonly trueAirspeed: PlanningValue<Knots>; readonly fuelFlow: PlanningValue<GallonsPerHour> }> => {
  return subleg.phase === "cruise" ? cruisePerformance(sourceLeg, profile) : verticalPerformance(profile, isClimbPhase(subleg.phase));
};

const cruisePerformance = (sourceLeg: UserRouteLeg, profile: AircraftProfile): DomainResult<{ readonly trueAirspeed: PlanningValue<Knots>; readonly fuelFlow: PlanningValue<GallonsPerHour> }> => {
  const tas = checkedPlanningValue(sourceLeg.performanceOverrides?.cruiseTasKnots, profile.cruiseTasKnots, profile, "cruise-tas", "Cruise true airspeed", positiveKnots);
  if (!tas.ok) return propagateFailure(tas);
  const fuelFlow = checkedPlanningValue(sourceLeg.performanceOverrides?.cruiseFuelFlowGallonsPerHour, profile.cruiseFuelFlowGallonsPerHour, profile, "cruise-fuel-flow", "Cruise fuel flow", gallonsPerHour);
  if (!fuelFlow.ok) return propagateFailure(fuelFlow);
  return success({ trueAirspeed: tas.value, fuelFlow: fuelFlow.value });
};

const isClimbPhase = (phase: Exclude<NavlogPhaseKind, "cruise">): boolean => phase === "climb" || phase === "transition-climb";

const verticalPerformance = (profile: AircraftProfile, climb: boolean): DomainResult<{ readonly trueAirspeed: PlanningValue<Knots>; readonly fuelFlow: PlanningValue<GallonsPerHour> }> => {
  const tas = positiveKnots(climb ? profile.climbTasKnots : profile.descentTasKnots);
  if (!tas.ok) return propagateFailure(tas);
  const fuelFlow = gallonsPerHour(climb ? profile.climbFuelFlowGallonsPerHour : profile.descentFuelFlowGallonsPerHour);
  if (!fuelFlow.ok) return propagateFailure(fuelFlow);
  return success({
    trueAirspeed: aircraftDefault(tas.value, profile, climb ? "climb-tas" : "descent-tas", climb ? "Climb true airspeed" : "Descent true airspeed"),
    fuelFlow: aircraftDefault(fuelFlow.value, profile, climb ? "climb-fuel-flow" : "descent-fuel-flow", climb ? "Climb fuel flow" : "Descent fuel flow"),
  });
};

const aircraftDefault = <T extends number>(value: T, profile: AircraftProfile, sourceId: string, sourceLabel: string): PlanningValue<T> => ({
  computedValue: value,
  effectiveValue: value,
  origin: "aircraft-default",
  provenance: { sourceId: `aircraft-profile:${profile.id}:${sourceId}`, sourceLabel, recordedAt: profile.updatedAt },
});

const checkedPlanningValue = <T extends number>(
  supplied: PlanningValue<number> | undefined,
  defaultValue: number,
  profile: AircraftProfile,
  sourceId: string,
  sourceLabel: string,
  validator: (value: number) => DomainResult<T>,
): DomainResult<PlanningValue<T>> => {
  if (supplied === undefined) {
    const checked = validator(defaultValue);
    return checked.ok ? success(aircraftDefault(checked.value, profile, sourceId, sourceLabel)) : propagateFailure(checked);
  }
  return checkedSuppliedPlanningValue(supplied, validator);
};

const checkedSuppliedPlanningValue = <T extends number>(
  supplied: PlanningValue<number>,
  validator: (value: number) => DomainResult<T>,
): DomainResult<PlanningValue<T>> => {
  const effective = validator(supplied.effectiveValue);
  if (!effective.ok) return propagateFailure(effective);
  const computed = checkedComputedValue(supplied.computedValue, validator);
  if (!computed.ok) return propagateFailure(computed);
  const override = checkedOverrideValue(supplied.override, validator);
  if (!override.ok) return propagateFailure(override);
  return success(copyPlanningValue(supplied, computed.value, effective.value, override.value));
};

const checkedComputedValue = <T extends number>(value: number | null, validator: (value: number) => DomainResult<T>): DomainResult<T | null> =>
  value === null ? success(null) : validator(value);

const checkedOverrideValue = <T extends number>(
  value: PlanningOverride<number> | undefined,
  validator: (value: number) => DomainResult<T>,
): DomainResult<PlanningOverride<T> | undefined> => {
  if (value === undefined) return success(undefined);
  const checked = validator(value.value);
  if (!checked.ok) return propagateFailure(checked);
  return success({ ...value, value: checked.value });
};

const copyPlanningValue = <T extends number>(
  supplied: PlanningValue<number>,
  computedValue: T | null,
  effectiveValue: T,
  override: PlanningOverride<T> | undefined,
): PlanningValue<T> => {
  return {
    computedValue, effectiveValue,
    origin: supplied.origin,
    provenance: supplied.provenance,
    ...(supplied.explanation === undefined ? {} : { explanation: supplied.explanation }),
    ...(override === undefined ? {} : { override }),
  };
};

const deviationFor = (profile: AircraftProfile, magneticHeading: number): DomainResult<ReturnType<typeof interpolateCompassDeviation> extends DomainResult<infer T> ? T : never> => {
  const table = [];
  for (const entry of profile.compassDeviationTable) {
    const point = deviationTablePoint(entry.magneticHeadingDegrees, entry.deviationDegrees);
    if (!point.ok) return propagateFailure(point);
    table.push(point.value);
  }
  return interpolateCompassDeviation(table, magneticHeading as Parameters<typeof interpolateCompassDeviation>[1]);
};

const validateSurfaceInterpolation = (value: SurfaceToAloftInterpolationProvenance | undefined): DomainResult<void> => {
  if (value === undefined) return success(undefined);
  const fieldElevation = feetMsl(value.fieldElevationFeetMsl);
  if (!fieldElevation.ok) return propagateFailure(fieldElevation);
  const firstAloftAltitude = value.firstAloftLevel.domainLevel?.altitude;
  if (firstAloftAltitude === undefined || firstAloftAltitude <= fieldElevation.value) {
    return failure("UNSUPPORTED_WIND_ALTITUDE", "METAR interpolation provenance must state the field elevation and a higher first winds-aloft level.", {
      fieldElevationFeetMsl: fieldElevation.value,
      firstAloftLevelFeetMsl: firstAloftAltitude ?? null,
    });
  }
  return success(undefined);
};

const assumptionsFor = (wind: ResolvedNavlogWind): readonly string[] =>
  wind.surfaceToAloftInterpolation === undefined ? [] : [wind.surfaceToAloftInterpolation.statement];

const appliedOverrides = (
  wind: PlanningValue<Wind>,
  tas: PlanningValue<Knots>,
  fuelFlow: PlanningValue<GallonsPerHour>,
  variation: PlanningValue<SignedDegrees>,
): readonly AppliedNavlogOverride[] => [
  override("effective-wind", wind),
  override("true-airspeed", tas),
  override("fuel-flow", fuelFlow),
  override("magnetic-variation", variation),
].filter((value): value is AppliedNavlogOverride => value !== undefined);

const override = <T extends number | Wind>(input: AppliedNavlogOverride["input"], value: PlanningValue<T>): AppliedNavlogOverride | undefined =>
  value.override === undefined ? undefined : {
    input,
    computedValue: value.computedValue,
    effectiveValue: value.effectiveValue,
    ...(value.override.reason === undefined ? {} : { reason: value.override.reason }),
    createdAt: value.override.createdAt,
  };

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)];
