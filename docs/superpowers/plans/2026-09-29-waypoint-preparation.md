# Waypoint Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide pure route and estimated generated-waypoint preparation for issue #27, ready for the single sequential calculator in #28.

**Architecture:** Add a focused application module that validates the pilot's ordered route, accumulates charted leg distances, estimates TOC/TOD/altitude-transition end points from one supplied planning wind and aircraft performance, and returns ordered waypoint anchors plus only positive-distance spans. It reuses existing great-circle, wind-triangle, units, and generated-boundary functions. The module does not fetch weather, calculate row UTC/fuel, enforce checkpoint altitude, or change the active planner.

**Tech Stack:** TypeScript, Vitest, existing domain math; `mise exec -- npm` for validation.

**Spec:** [`docs/waypoint-first-navlog-contract.md`](../../waypoint-first-navlog-contract.md), approved in issue #26; issue #27 defines this bounded deliverable.

## Global Constraints

- Preserve authored route point IDs, names, coordinates, and leg altitude/override inputs.
- TOC, TOD, and transition-end positions are estimates placed once from supplied inputs; no convergence or checkpoint-altitude tolerance.
- TOD must be available before the containing final cruise span is calculated in #28. This module accepts the then-known starting distance and wind and returns TOD synchronously.
- Keep distinct labels for coincident generated/pilot points. Suppress only exactly zero-distance spans; retain nearby positive spans.
- An impossible ordered geometry returns a structured, actionable failure naming points and estimated distances. Do not invent a phase or silently move a pilot checkpoint.
- #27 has no active `Update navlog` behavior change and must not add a second calculation path.

## Review Focus

- Repeated/missing point or leg IDs and discontinuous leg references: reject before generating any point (Task 1 test).
- A bent route where an estimated phase crosses a turn: consume the supplied phase time along each charted leg's local course, with the same wind but a newly solved groundspeed (Task 2 test).
- Wind that cannot yield positive groundspeed: return the wind-triangle error without a bogus position (Task 2 test).
- A generated point exactly at a pilot checkpoint versus just beside it: retain both labels at exact coincidence, omit only the zero span, and retain the nearby span (Task 3 test).
- TOD at/before TOC or transition beyond the next checkpoint/TOD: return affected distances and useful guidance (Task 3 test).

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
- `estimateVerticalWaypoint(input: { route: PreparedPilotRoute; kind: "estimated-toc" | "estimated-tod" | "estimated-transition-end"; id: string; label: string; startRouteDistanceNauticalMiles: number; startingAltitudeFeetMsl: number; targetAltitudeFeetMsl: number; verticalRateFeetPerMinute: number; trueAirspeedKnots: number; fuelFlowGallonsPerHour: number; planningWind: Wind }): DomainResult<PreparedWaypoint>`.
- TOC and transition-end consume `abs(altitude difference) / rate` minutes forward from their start distance. TOD consumes that duration backward from the destination's cumulative distance. The caller supplies the wind known at the appropriate worksheet boundary; no weather fetch or elapsed-time calculation occurs here.

- [ ] Test the approved no-wind examples: 3,000 ft climb at 500 ft/min and 60 kt places TOC at NM 6; 4,000 ft descent at 500 ft/min and 90 kt places TOD 12 NM before destination. Test one 1,000 ft transition and a bent course.
- [ ] Test nonpositive/nonfinite rate or TAS, invalid altitude direction, route overflow, and wind with no usable groundspeed.
- [ ] Run the targeted test and observe failures.
- [ ] Implement a single bounded walk of the prepared route geometry in the phase direction. At each crossed source leg, solve its wind triangle once and consume available time/distance; place the endpoint with existing great-circle geometry. Return the generated waypoint with placement evidence. Do not iterate or adjust the rate to hit a waypoint.
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
- [ ] Run the targeted test and observe failures.
- [ ] Implement deterministic ordering and span construction; check geometry from estimated cumulative distances only. Keep weather and UTC/fuel state out of this module.
- [ ] Run targeted tests, `mise exec -- npm run ci`, and `git diff --check`; review the combined API against the approved contract; commit with a signed Conventional Commit.

## Handoff to issue #28

The sequential calculator calls `preparePilotRoute` once, requests TOC and transition-end placement at the proper starting waypoints, then requests TOD before calculating the cruise span that reaches it. It consumes the ordered positive spans and computes weather, headings, UTC, and fuel one row at a time. No row result may change a generated position already returned by this module.
