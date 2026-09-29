# Waypoint Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide pure route and estimated generated-waypoint preparation for issue #27, ready for the single sequential calculator in #28.

**Architecture:** Add a focused application module that validates the pilot's ordered route, accumulates charted leg distances, estimates TOC/altitude-transition end points from supplied planning wind and aircraft performance, and returns ordered waypoint anchors plus only positive-distance spans. TOD uses one estimated descent distance on the final charted course: subtract that distance from the route total, reject a point behind the current waypoint, then locate it in forward route order. The module reuses existing great-circle, wind-triangle, units, and generated-boundary functions. It does not fetch weather, calculate row UTC/fuel, walk the route backward, enforce checkpoint altitude, or change the active planner.

**Tech Stack:** TypeScript, Vitest, existing domain math; `mise exec -- npm` for validation.

**Spec:** [`docs/waypoint-first-navlog-contract.md`](../../waypoint-first-navlog-contract.md), approved in issue #26; issue #27 defines this bounded deliverable.

## Global Constraints

- Preserve authored route point IDs, names, coordinates, and leg altitude/override inputs.
- TOC, TOD, and transition-end positions are estimates placed once from supplied inputs; no convergence or checkpoint-altitude tolerance.
- TOD must be available before the containing final cruise span is calculated in #28. This module accepts the then-known starting distance and wind and returns TOD synchronously.
- Keep distinct labels for coincident generated/pilot points. Suppress only exactly zero-distance spans; retain nearby positive spans.
- Canonicalize a calculated boundary to a known route waypoint only when the difference is floating-point roundoff; do not use a forecast/display tolerance to merge distinct points.
- An impossible ordered geometry returns a structured, actionable failure naming points and estimated distances. Do not invent a phase or silently move a pilot checkpoint.
- #27 has no active `Update navlog` behavior change and must not add a second calculation path.

## Review Focus

- Repeated/missing point or leg IDs and discontinuous leg references: reject before generating any point (Task 1 test).
- A bent route where an estimated phase crosses a turn: consume the supplied phase time along each charted leg's local course, with the same wind but a newly solved groundspeed (Task 2 test).
- TOD on a bent route uses the final charted course for a single descent-distance estimate and locates its cumulative route distance forward; it does not integrate backward over turns (Task 2 test).
- Wind that cannot yield positive groundspeed: return the wind-triangle error without a bogus position (Task 2 test).
- TOD candidate after TOC but before the current final pilot waypoint: return “TOD is calculated to be before final waypoint” with its name, the candidate/current distances, and guidance; the caller stops before the next row or TOD weather request (Task 2 test).
- A generated point exactly at a pilot checkpoint versus just beside it: retain both labels at exact coincidence, omit only the zero span, and retain the nearby span (Task 3 test).
- TOD at/before TOC or transition beyond the next checkpoint/TOD: return affected distances and useful guidance (Task 3 test).
- A pilot checkpoint before TOC remains in the ordered route; a supplied altitude transition starting there is rejected as contradictory geometry. The #28 calculator must skip that transition, ignore the checkpoint's outbound altitude selection, warn the pilot, and continue with climb inputs.

---

### Task 1: Ordered pilot-route geometry

**Files:**
- Create: `src/application/waypoint-preparation.ts`
- Test: `src/application/waypoint-preparation.test.ts`

**Interfaces:**
- `preparePilotRoute(route: RouteDefinition): DomainResult<PreparedPilotRoute>`
- `PreparedPilotRoute` contains immutable `pilotPoints` (source `RoutePoint`, cumulative `routeDistanceNauticalMiles`) and `legs` (source `UserRouteLeg`, start/end coordinates, true course, distance, cumulative start/end distance), plus total route distance.
- Export `PreparedWaypoint` as `{ id, kind: "departure" | "pilot-checkpoint" | "destination" | "estimated-toc" | "estimated-tod" | "estimated-transition-end", label, coordinate, routeDistanceNauticalMiles, sourcePointId?, sourceLegId?, placement? }`. `placement` records altitude difference, rate, TAS, supplied wind, estimated duration/distance, and formula/source IDs for generated points.

- [ ] Write tests for a straight route, a bent route, and malformed references/duplicate IDs; assert authored point objects remain untouched.
- [ ] Run `mise exec -- npm test -- src/application/waypoint-preparation.test.ts` and observe the new tests fail.
- [ ] Implement ordered route validation and cumulative geometry using existing `calculateGreatCircleDistanceAndInitialCourse` and unit checks; avoid editing old allocators.
- [ ] Rerun the targeted test and typecheck; commit the focused result with a signed Conventional Commit.

### Task 2: One-time estimated vertical-boundary placement

**Files:**
- Modify: `src/application/waypoint-preparation.ts`
- Test: `src/application/waypoint-preparation.test.ts`

**Interfaces:**
- `estimateForwardVerticalWaypoint(input: { route: PreparedPilotRoute; kind: "estimated-toc" | "estimated-transition-end"; id: string; label: string; startRouteDistanceNauticalMiles: number; startingAltitudeFeetMsl: number; targetAltitudeFeetMsl: number; verticalRateFeetPerMinute: number; trueAirspeedKnots: number; fuelFlowGallonsPerHour: number; planningWind: Wind }): DomainResult<PreparedWaypoint>`.
- `estimateTopOfDescent(input: { route: PreparedPilotRoute; currentWaypoint: PreparedWaypoint; cruiseAltitudeFeetMsl: number; patternAltitudeFeetMsl: number; descentRateFeetPerMinute: number; descentTrueAirspeedKnots: number; descentFuelFlowGallonsPerHour: number; planningWind: Wind }): DomainResult<PreparedWaypoint>`.
- TOC and transition-end consume `abs(altitude difference) / rate` minutes forward from their start distance, solving local leg courses when a turn is crossed. TOD uses the final charted course to estimate one groundspeed and descent distance. Its cumulative distance is `route total − descent distance`; reject if this is before `currentWaypoint.routeDistanceNauticalMiles`, naming that waypoint and both distances with revision guidance, then locate the point in forward route order. Use the “before final waypoint” wording for a pilot checkpoint; use TOC/TOD overlap wording when the current waypoint is TOC. The caller supplies the wind known at the worksheet boundary; no weather fetch, backward route walk, or row calculation occurs here.

- [ ] Test the approved no-wind examples: 3,000 ft climb at 500 ft/min and 60 kt places TOC at NM 6; 4,000 ft descent at 500 ft/min and 90 kt gives a 12 NM descent distance and TOD at route total minus 12 NM. Test one 1,000 ft transition and a bent course, asserting TOD uses the final charted course without backward segment integration.
- [ ] Test a final pilot checkpoint named “Lake” at NM 50 on the 60 NM route with a 12 NM descent estimate: TOD at NM 48 is behind Lake but after TOC. Assert the result begins “TOD is calculated to be before final waypoint Lake,” includes NM 48 and NM 50, and suggests checking waypoint position, cruise altitude, descent performance, or route. Add the no-further-row/weather assertion during #28 integration.
- [ ] Test nonpositive/nonfinite rate or TAS, invalid altitude direction, route overflow, and wind with no usable groundspeed.
- [ ] Run the targeted test and observe failures.
- [ ] Implement a bounded forward walk for TOC/transition placement. For TOD, solve one wind triangle on the final charted course, subtract the estimated descent distance from the route total, enforce the current-waypoint lower bound, and locate that cumulative distance through the existing ordered route geometry. Return generated waypoints with placement evidence. Do not iterate, walk backward, or adjust the rate to hit a waypoint.
- [ ] Rerun targeted tests and typecheck; commit the focused result with a signed Conventional Commit.

### Task 3: Ordering, positive spans, and actionable geometry checks

**Files:**
- Modify: `src/application/waypoint-preparation.ts`
- Test: `src/application/waypoint-preparation.test.ts`

**Interfaces:**
- `orderPreparedWaypoints(route: PreparedPilotRoute, generated: readonly PreparedWaypoint[]): DomainResult<{ waypoints: readonly PreparedWaypoint[]; spans: readonly { from: PreparedWaypoint; to: PreparedWaypoint; sourceLegId: string; distanceNauticalMiles: number }[] }>`.
- `validateWaypointGeometry(input: { route: PreparedPilotRoute; toc: PreparedWaypoint; tod: PreparedWaypoint; transitions: readonly { startPointId: string; end: PreparedWaypoint; nextPilotPointId: string }[] }): DomainResult<true>`.

- [ ] Test normal order and split spans for the 60 NM and 24 NM examples; assert the calculated route distances and that authored points are unchanged.
- [ ] Test exact coincidence with a pilot point and a nearby positive-distance generated point; assert distinct labels at the same route distance, no zero-distance span, and retention of the nearby positive span.
- [ ] Test 14 NM overlap (TOC NM 6, TOD NM 2), a transition that reaches beyond the next pilot checkpoint, and a transition crossing TOD; assert error details identify both points/distances and offer a basic corrective action.
- [ ] Test that a checkpoint before TOC remains valid with no transition, while a supplied transition starting there is rejected with checkpoint and TOC distances.
- [ ] Run the targeted test and observe failures.
- [ ] Implement deterministic ordering and span construction; check geometry from estimated cumulative distances only. Keep weather and UTC/fuel state out of this module.
- [ ] Run targeted tests, `mise exec -- npm run ci`, and `git diff --check`; review the combined API against the approved contract; commit with a signed Conventional Commit.

## Handoff to issue #28

The sequential calculator calls `preparePilotRoute` once, requests TOC and transition-end placement at the proper starting waypoints, then requests TOD before calculating the cruise span that reaches it. It consumes the ordered positive spans and computes weather, headings, UTC, and fuel one row at a time. No row result may change a generated position already returned by this module.

For coincident pilot and generated points, #28 must treat all labels at the shared route distance as one worksheet boundary: carry one UTC/fuel state, select weather once, and apply all phase and checkpoint choices before the next positive-distance row. Test the next row's actual phase and altitude, not only the ordered labels. When TOD coincides with a pilot checkpoint, use TOD descent inputs even if the checkpoint's outbound altitude selection conflicts; retain that authored selection for provenance.

For a pilot checkpoint before estimated TOC, #28 retains the checkpoint, ignores any outbound altitude selection there, adds a nonblocking warning, and keeps climb inputs through the next row. It must omit an altitude transition for that checkpoint before calling `validateWaypointGeometry`; a transition supplied to the pure validator is an invalid preparation request.
