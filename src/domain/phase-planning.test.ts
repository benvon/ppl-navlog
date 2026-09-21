import { describe, expect, it } from "vitest";

import { coordinate } from "./coordinates";
import { calculateRouteDistance, placeGeneratedBoundary, placeTopOfClimb, placeTopOfDescent, splitSourceLegAtBoundary } from "./phase-geometry";
import { phaseAltitudes, phasePerformanceFromAircraftValues, phaseSpeed, calculateVerticalPhase } from "./phase-performance";
import { assessProfileFeasibility, calculateConvergedVerticalPhase, calculateFuelSummary, type EffectiveWindResolver } from "./phase-planning";
import { calculateClimbToTopOfClimb, calculateDescentFromTopOfDescent } from "./phase-route-planning";
import { calculateAltitudeTransition } from "./phase-transitions";
import { failure } from "./errors";
import { feetMsl, gallons, nauticalMiles, trueCourse } from "./units";
import { wind } from "./wind";

const value = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!result.ok) throw new Error("Expected a successful domain result.");
  return result.value;
};

const calmWind = value(wind(0, 0));
const start = value(coordinate(0, 0));
const eastCourse = value(trueCourse(90));
const climbPerformance = value(phasePerformanceFromAircraftValues(1000, 100, 8, calmWind));
const descentPerformance = value(phasePerformanceFromAircraftValues(500, 100, 6, calmWind));

describe("vertical phase performance", () => {
  it("calculates climb duration, distance, fuel, and generated endpoint", () => {
    const altitudes = value(phaseAltitudes(1000, 3000));
    const result = value(
      calculateVerticalPhase({
        kind: "climb",
        start,
        course: eastCourse,
        ...altitudes,
        performance: climbPerformance,
      }),
    );
    expect(result.duration).toBe(2);
    expect(result.distance).toBeCloseTo(100 / 30, 10);
    expect(result.fuel).toBeCloseTo(8 / 30, 10);
    expect(result.end.longitude).toBeCloseTo(0.0555, 3);
    expect(result.trace.formulaId).toBe("vertical-phase-performance");
  });

  it("rejects invalid phase direction and performance", () => {
    const sameAltitudes = value(phaseAltitudes(3000, 3000));
    expect(
      calculateVerticalPhase({ kind: "climb", start, course: eastCourse, ...sameAltitudes, performance: climbPerformance }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PHASE_ALTITUDES" } });
    expect(phasePerformanceFromAircraftValues(0, 100, 8, calmWind)).toMatchObject({
      ok: false,
      error: { code: "INVALID_PHASE_PERFORMANCE" },
    });
    expect(phasePerformanceFromAircraftValues(1000, 0, 8, calmWind)).toMatchObject({
      ok: false,
      error: { code: "OUT_OF_RANGE" },
    });
    expect(phasePerformanceFromAircraftValues(1000, 100, 0, calmWind)).toMatchObject({
      ok: false,
      error: { code: "OUT_OF_RANGE" },
    });
    expect(phaseAltitudes(Number.NaN, 3000)).toMatchObject({ ok: false, error: { code: "INVALID_NUMBER" } });
    expect(phaseSpeed(0)).toMatchObject({ ok: false, error: { code: "OUT_OF_RANGE" } });
  });

  it("rejects a wind triangle that cannot be flown during a phase", () => {
    const altitudes = value(phaseAltitudes(1000, 2000));
    const impossiblePerformance = value(phasePerformanceFromAircraftValues(1000, 50, 8, value(wind(270, 60))));
    expect(
      calculateVerticalPhase({ kind: "climb", start, course: value(trueCourse(0)), ...altitudes, performance: impossiblePerformance }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_WIND_TRIANGLE" } });
  });
});

describe("generated phase geometry", () => {
  const route = [
    { sourceLegId: "leg-1", start: value(coordinate(0, 0)), end: value(coordinate(0, 1)) },
    { sourceLegId: "leg-2", start: value(coordinate(0, 1)), end: value(coordinate(0, 2)) },
  ] as const;

  it("places TOC/TOD inside the appropriate source leg", () => {
    const toc = value(placeTopOfClimb(route, value(nauticalMiles(90))));
    expect(toc.sourceLegId).toBe("leg-2");
    expect(toc.sourceLegDistance).toBeCloseTo(29.959, 2);
    const tod = value(placeTopOfDescent(route, value(nauticalMiles(30))));
    expect(tod.sourceLegId).toBe("leg-2");
    expect(tod.sourceLegDistance).toBeCloseTo(30.04046, 5);
  });

  it("retains source-leg relationships when a generated point splits a leg", () => {
    const boundary = value(placeGeneratedBoundary(route, value(nauticalMiles(20)), "top-of-climb", "toc-a"));
    const split = value(splitSourceLegAtBoundary(route[0], boundary, "climb", "cruise"));
    expect(split.map((leg) => leg.phase)).toEqual(["climb", "cruise"]);
    expect(split[0]!.distance + split[1]!.distance).toBeCloseTo(60.04046, 5);
  });

  it("rejects generated boundaries outside the route", () => {
    expect(placeGeneratedBoundary(route, value(nauticalMiles(999)), "top-of-descent", "tod-a")).toMatchObject({
      ok: false,
      error: { code: "ROUTE_GEOMETRY_ERROR" },
    });
  });

  it("rejects malformed geometry and a TOD that would begin before route start", () => {
    expect(calculateRouteDistance([])).toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
    expect(calculateRouteDistance([{ ...route[0], sourceLegId: "" }])).toMatchObject({
      ok: false,
      error: { code: "ROUTE_GEOMETRY_ERROR" },
    });
    expect(placeTopOfDescent(route, value(nauticalMiles(999)))).toMatchObject({
      ok: false,
      error: { code: "ROUTE_GEOMETRY_ERROR" },
    });
  });

  it("rejects a split boundary assigned to the wrong leg or outside its source leg", () => {
    const boundary = value(placeGeneratedBoundary(route, value(nauticalMiles(20)), "top-of-climb", "toc-b"));
    expect(splitSourceLegAtBoundary(route[1], boundary, "climb", "cruise")).toMatchObject({
      ok: false,
      error: { code: "ROUTE_GEOMETRY_ERROR" },
    });
    expect(
      splitSourceLegAtBoundary(
        route[0],
        { ...boundary, sourceLegDistance: value(nauticalMiles(999)) },
        "climb",
        "cruise",
      ),
    ).toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
  });

  it("combines independently calculated climb/descent phases with TOC/TOD placement", () => {
    const climb = value(
      calculateClimbToTopOfClimb(
        {
          start: route[0].start,
          course: eastCourse,
          startingAltitude: value(feetMsl(0)),
          targetAltitude: value(feetMsl(1000)),
          performance: climbPerformance,
        },
        route,
      ),
    );
    expect(climb.topOfClimb.kind).toBe("top-of-climb");
    const descent = value(
      calculateDescentFromTopOfDescent(
        {
          start: route[1].start,
          course: eastCourse,
          startingAltitude: value(feetMsl(3000)),
          targetAltitude: value(feetMsl(1000)),
          performance: descentPerformance,
        },
        route,
      ),
    );
    expect(descent.topOfDescent.kind).toBe("top-of-descent");
  });

  it("reports a phase that cannot fit on the route as infeasible instead of placing it off-route", () => {
    const firstLeg = route[0]!;
    const shortRoute = [firstLeg];
    expect(
      calculateClimbToTopOfClimb(
        {
          start: firstLeg.start,
          course: eastCourse,
          startingAltitude: value(feetMsl(0)),
          targetAltitude: value(feetMsl(40_000)),
          performance: climbPerformance,
        },
        shortRoute,
      ),
    ).toMatchObject({ ok: false, error: { code: "INFEASIBLE_PROFILE" } });
    expect(
      calculateDescentFromTopOfDescent(
        {
          start: firstLeg.start,
          course: eastCourse,
          startingAltitude: value(feetMsl(40_000)),
          targetAltitude: value(feetMsl(0)),
          performance: descentPerformance,
        },
        shortRoute,
      ),
    ).toMatchObject({ ok: false, error: { code: "INFEASIBLE_PROFILE" } });
  });
});

describe("transitions, convergence, and infeasibility", () => {
  it("makes non-level cruise altitude changes explicit", () => {
    const transition = value(
      calculateAltitudeTransition({
        start,
        course: eastCourse,
        startingAltitude: value(feetMsl(3000)),
        targetAltitude: value(feetMsl(5000)),
        climbPerformance,
        descentPerformance,
      }),
    );
    expect(transition).toMatchObject({ required: true, calculation: { kind: "transition-climb" } });
    const noTransition = value(
      calculateAltitudeTransition({
        start,
        course: eastCourse,
        startingAltitude: value(feetMsl(5000)),
        targetAltitude: value(feetMsl(5000)),
        climbPerformance,
        descentPerformance,
      }),
    );
    expect(noTransition.required).toBe(false);
    const descentTransition = value(
      calculateAltitudeTransition({
        start,
        course: eastCourse,
        startingAltitude: value(feetMsl(5000)),
        targetAltitude: value(feetMsl(3000)),
        climbPerformance,
        descentPerformance,
      }),
    );
    expect(descentTransition).toMatchObject({ required: true, calculation: { kind: "transition-descent" } });
    const impossiblePerformance = value(phasePerformanceFromAircraftValues(1000, 50, 8, value(wind(270, 60))));
    expect(
      calculateAltitudeTransition({
        start,
        course: value(trueCourse(0)),
        startingAltitude: value(feetMsl(3000)),
        targetAltitude: value(feetMsl(5000)),
        climbPerformance: impossiblePerformance,
        descentPerformance,
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_WIND_TRIANGLE" } });
  });

  it("converges when a deterministic wind resolver stabilizes", () => {
    const resolver: EffectiveWindResolver = { resolveEffectiveWind: () => wind(0, 10) };
    const result = value(
      calculateConvergedVerticalPhase(
        {
          kind: "climb",
          start,
          course: eastCourse,
          startingAltitude: value(feetMsl(0)),
          targetAltitude: value(feetMsl(1000)),
          performance: { ...climbPerformance },
        },
        resolver,
      ),
    );
    expect(result.iterations).toBe(2);
    expect(result.trace.formulaId).toBe("bounded-phase-geometry-convergence");
  });

  it("returns a structured result rather than silently accepting nonconvergence", () => {
    const resolver: EffectiveWindResolver = {
      resolveEffectiveWind: (request) => wind(0, request.iteration % 2 === 0 ? 20 : 0),
    };
    expect(
      calculateConvergedVerticalPhase(
        {
          kind: "descent",
          start,
          course: eastCourse,
          startingAltitude: value(feetMsl(3000)),
          targetAltitude: value(feetMsl(0)),
          performance: { ...descentPerformance },
        },
        resolver,
        { maxIterations: 3, distanceToleranceNauticalMiles: 0.00001 },
      ),
    ).toMatchObject({ ok: false, error: { code: "NON_CONVERGENT_PHASE_GEOMETRY" } });
  });

  it("rejects invalid convergence options and preserves a resolver failure", () => {
    const baseInput = {
      kind: "climb" as const,
      start,
      course: eastCourse,
      startingAltitude: value(feetMsl(0)),
      targetAltitude: value(feetMsl(1000)),
      performance: { ...climbPerformance },
    };
    const resolver: EffectiveWindResolver = { resolveEffectiveWind: () => wind(0, 0) };
    expect(calculateConvergedVerticalPhase(baseInput, resolver, { distanceToleranceNauticalMiles: 0 })).toMatchObject({
      ok: false,
      error: { code: "OUT_OF_RANGE" },
    });
    expect(calculateConvergedVerticalPhase(baseInput, resolver, { maxIterations: 1.5 })).toMatchObject({
      ok: false,
      error: { code: "OUT_OF_RANGE" },
    });
    const failingResolver: EffectiveWindResolver = {
      resolveEffectiveWind: () => failure("ROUTE_GEOMETRY_ERROR", "Weather geometry unavailable."),
    };
    expect(calculateConvergedVerticalPhase(baseInput, failingResolver)).toMatchObject({
      ok: false,
      error: { code: "ROUTE_GEOMETRY_ERROR" },
    });
  });

  it("reports phase overlap without truncating a phase", () => {
    const result = value(assessProfileFeasibility(value(nauticalMiles(100)), value(nauticalMiles(70)), value(nauticalMiles(50))));
    expect(result.feasible).toBe(false);
    expect(result.overlapDistance).toBe(20);
    expect(result.trace.warnings).toHaveLength(1);
    const feasible = value(assessProfileFeasibility(value(nauticalMiles(100)), value(nauticalMiles(60)), value(nauticalMiles(40))));
    expect(feasible).toMatchObject({ feasible: true, overlapDistance: 0 });
  });
});

describe("fuel summary", () => {
  it("keeps taxi, each phase, reserve, and usable-fuel comparison distinct", () => {
    const result = value(
      calculateFuelSummary({
        taxiRunupFuel: value(gallons(1)),
        climbFuel: value(gallons(2)),
        transitionFuel: value(gallons(0.5)),
        cruiseFuel: value(gallons(6)),
        descentFuel: value(gallons(1)),
        reserveFuel: value(gallons(3)),
        usableFuel: value(gallons(12)),
      }),
    );
    expect(result.enrouteFuel).toBe(9.5);
    expect(result.requiredFuel).toBe(13.5);
    expect(result.sufficientUsableFuel).toBe(false);
    expect(result.usableFuelDifference).toBe(-1.5);
  });

  it("allows a fuel summary without a usable-fuel comparison", () => {
    const result = value(
      calculateFuelSummary({
        taxiRunupFuel: value(gallons(0)),
        climbFuel: value(gallons(0)),
        transitionFuel: value(gallons(0)),
        cruiseFuel: value(gallons(0)),
        descentFuel: value(gallons(0)),
        reserveFuel: value(gallons(0)),
      }),
    );
    expect(result.usableFuelDifference).toBeUndefined();
    expect(result.sufficientUsableFuel).toBeUndefined();
  });
});
