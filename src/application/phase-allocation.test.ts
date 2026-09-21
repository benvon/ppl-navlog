import { describe, expect, it } from "vitest";

import { coordinate } from "../domain/coordinates";
import type { DomainResult } from "../domain/errors";
import type { RouteGeometryLeg } from "../domain/phase-geometry";
import type { EffectiveWindResolver } from "../domain/phase-planning";
import { phasePerformanceFromAircraftValues } from "../domain/phase-performance";
import { feetMsl } from "../domain/units";
import { wind } from "../domain/wind";
import { allocateRoutePhases } from "./phase-allocation";

const value = <T>(result: DomainResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const calmResolver: EffectiveWindResolver = { resolveEffectiveWind: () => wind(0, 0) };
const climbPerformance = value(phasePerformanceFromAircraftValues(1_000, 120, 8, value(wind(0, 0))));
const descentPerformance = value(phasePerformanceFromAircraftValues(500, 120, 6, value(wind(0, 0))));

const route = (): readonly RouteGeometryLeg[] => [
  { sourceLegId: "leg-1", start: value(coordinate(0, 0)), end: value(coordinate(0, 1)) },
  { sourceLegId: "leg-2", start: value(coordinate(0, 1)), end: value(coordinate(0, 2)) },
  { sourceLegId: "leg-3", start: value(coordinate(0, 2)), end: value(coordinate(0, 3)) },
];

describe("route phase allocation", () => {
  it("allocates a changed user-leg altitude as explicit generated transition sublegs", () => {
    const result = value(allocateRoutePhases({
      route: route(),
      legAltitudes: [
        { sourceLegId: "leg-1", cruiseAltitude: value(feetMsl(3_000)) },
        { sourceLegId: "leg-2", cruiseAltitude: value(feetMsl(5_000)) },
        { sourceLegId: "leg-3", cruiseAltitude: value(feetMsl(5_000)) },
      ],
      departureAltitude: value(feetMsl(1_000)),
      destinationAltitude: value(feetMsl(500)),
      climbPerformance,
      descentPerformance,
      windResolver: calmResolver,
    }));

    expect(result.status).toBe("allocated");
    if (result.status !== "allocated") throw new Error("Expected an allocated route.");
    expect(result.transitionPolicy).toBe("begin-at-checkpoint-and-consume-following-route-space");
    expect(result.boundaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "top-of-climb", id: "generated-toc" }),
      expect.objectContaining({ kind: "top-of-descent", id: "generated-tod" }),
      expect.objectContaining({ kind: "altitude-transition", id: "transition:leg-1->leg-2:start" }),
      expect.objectContaining({ kind: "altitude-transition", id: "transition:leg-1->leg-2:end" }),
    ]));
    const transition = result.sublegs.find((subleg) => subleg.phaseId === "transition:leg-1->leg-2");
    expect(transition).toMatchObject({
      sourceLegId: "leg-2",
      phase: "transition-climb",
      routeStartDistance: expect.closeTo(60.04, 1),
      startingAltitude: 3_000,
      endingAltitude: 5_000,
      selectedCruiseAltitude: 5_000,
    });
    expect(transition?.start.longitude).toBeCloseTo(1, 10);
    expect(result.sublegs.filter((subleg) => subleg.phase === "cruise").every((subleg) => subleg.startingAltitude === subleg.endingAltitude)).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/never applied as an instantaneous jump/i);
  });

  it("samples arrival-descent wind at candidate TODs during bounded convergence", () => {
    const descentSampleStarts: number[] = [];
    const resolver: EffectiveWindResolver = {
      resolveEffectiveWind: (request) => {
        if (request.phase === "descent") descentSampleStarts.push(request.start.longitude);
        return wind(0, 0);
      },
    };
    const result = value(allocateRoutePhases({
      route: route(),
      legAltitudes: route().map((leg) => ({ sourceLegId: leg.sourceLegId, cruiseAltitude: value(feetMsl(3_000)) })),
      departureAltitude: value(feetMsl(3_000)),
      destinationAltitude: value(feetMsl(500)),
      climbPerformance,
      descentPerformance,
      windResolver: resolver,
    }));

    expect(result.status).toBe("allocated");
    expect(descentSampleStarts).toHaveLength(2);
    expect(descentSampleStarts[0]).toBeCloseTo(3, 10);
    expect(descentSampleStarts[1]).toBeLessThan(3);
  });

  it("returns infeasible instead of overlapping changed-altitude phases or fabricating cruise rows", () => {
    const result = value(allocateRoutePhases({
      route: [
        { sourceLegId: "leg-1", start: value(coordinate(0, 0)), end: value(coordinate(0, 0.1)) },
        { sourceLegId: "leg-2", start: value(coordinate(0, 0.1)), end: value(coordinate(0, 0.2)) },
      ],
      legAltitudes: [
        { sourceLegId: "leg-1", cruiseAltitude: value(feetMsl(3_000)) },
        { sourceLegId: "leg-2", cruiseAltitude: value(feetMsl(8_000)) },
      ],
      departureAltitude: value(feetMsl(0)),
      destinationAltitude: value(feetMsl(0)),
      climbPerformance,
      descentPerformance,
      windResolver: calmResolver,
    }));

    expect(result.status).toBe("infeasible");
    if (result.status !== "infeasible") throw new Error("Expected an infeasible route.");
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "phase-outside-route" }),
      expect.objectContaining({ kind: "phase-overlap" }),
    ]));
    expect(result.warnings.join(" ")).toMatch(/no cruise or transition subleg was invented/i);
  });

  it("rejects route legs without an ordered selected-altitude mapping", () => {
    const result = allocateRoutePhases({
      route: route(),
      legAltitudes: [{ sourceLegId: "leg-1", cruiseAltitude: value(feetMsl(3_000)) }],
      departureAltitude: value(feetMsl(1_000)),
      destinationAltitude: value(feetMsl(500)),
      climbPerformance,
      descentPerformance,
      windResolver: calmResolver,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
  });

  it("leaves an already-level route as cruise-only sublegs without inventing vertical phases or boundaries", () => {
    const result = value(allocateRoutePhases({
      route: route(),
      legAltitudes: route().map((leg) => ({ sourceLegId: leg.sourceLegId, cruiseAltitude: value(feetMsl(3_000)) })),
      departureAltitude: value(feetMsl(3_000)), destinationAltitude: value(feetMsl(3_000)),
      climbPerformance, descentPerformance, windResolver: calmResolver,
    }));
    expect(result).toMatchObject({ status: "allocated", phases: [], boundaries: [] });
    if (result.status !== "allocated") throw new Error("Expected allocation.");
    expect(result.sublegs.every((subleg) => subleg.phase === "cruise" && subleg.startingAltitude === 3_000 && subleg.endingAltitude === 3_000)).toBe(true);
  });

  it("allocates an explicit descending checkpoint transition with descent performance", () => {
    const result = value(allocateRoutePhases({
      route: route(),
      legAltitudes: [
        { sourceLegId: "leg-1", cruiseAltitude: value(feetMsl(5_000)) },
        { sourceLegId: "leg-2", cruiseAltitude: value(feetMsl(3_000)) },
        { sourceLegId: "leg-3", cruiseAltitude: value(feetMsl(3_000)) },
      ],
      departureAltitude: value(feetMsl(5_000)), destinationAltitude: value(feetMsl(3_000)),
      climbPerformance, descentPerformance, windResolver: calmResolver,
    }));
    expect(result.status).toBe("allocated");
    if (result.status !== "allocated") throw new Error("Expected allocation.");
    expect(result.phases).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "transition-descent", startingAltitude: 5_000, targetAltitude: 3_000 })]));
    expect(result.sublegs).toEqual(expect.arrayContaining([expect.objectContaining({ phase: "transition-descent", sourceLegId: "leg-2" })]));
  });

  it("rejects empty, duplicated, misordered, and invalid-convergence allocation requests", () => {
    const base = {
      route: route(),
      legAltitudes: route().map((leg) => ({ sourceLegId: leg.sourceLegId, cruiseAltitude: value(feetMsl(3_000)) })),
      departureAltitude: value(feetMsl(3_000)), destinationAltitude: value(feetMsl(3_000)),
      climbPerformance, descentPerformance, windResolver: calmResolver,
    };
    expect(allocateRoutePhases({ ...base, route: [] })).toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
    expect(allocateRoutePhases({ ...base, legAltitudes: [{ ...base.legAltitudes[0]!, sourceLegId: "wrong" }, ...base.legAltitudes.slice(1)] })).toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
    const duplicateRoute = [{ ...route()[0]!, sourceLegId: "leg-1" }, { ...route()[1]!, sourceLegId: "leg-1" }];
    expect(allocateRoutePhases({ ...base, route: duplicateRoute, legAltitudes: [{ sourceLegId: "leg-1", cruiseAltitude: value(feetMsl(3_000)) }, { sourceLegId: "leg-1", cruiseAltitude: value(feetMsl(3_000)) }] })).toMatchObject({ ok: false, error: { code: "ROUTE_GEOMETRY_ERROR" } });
    expect(allocateRoutePhases({ ...base, departureAltitude: value(feetMsl(1_000)), convergence: { maxIterations: 0 } })).toMatchObject({ ok: false, error: { code: "OUT_OF_RANGE" } });
    expect(allocateRoutePhases({ ...base, departureAltitude: value(feetMsl(1_000)), convergence: { distanceToleranceNauticalMiles: 0 } })).toMatchObject({ ok: false, error: { code: "OUT_OF_RANGE" } });
    expect(allocateRoutePhases({ ...base, destinationAltitude: value(feetMsl(0)), convergence: { maxIterations: 1 } })).toMatchObject({ ok: false, error: { code: "NON_CONVERGENT_PHASE_GEOMETRY" } });
  });
});
