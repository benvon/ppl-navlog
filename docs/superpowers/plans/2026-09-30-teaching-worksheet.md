# Teaching Worksheet Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for bounded implementation and coordinated review.

**Goal:** Implement the approved Chapter 16 teaching contract in the active worksheet while preserving compact rows and the inspector.

**Architecture:** Simplify the existing waypoint worksheet to one cruise altitude and two generated boundaries. Adapt its result to the existing complete-navlog snapshot so the UI and inspector retain their interaction and calculation explanations. Retain input persistence and weather API boundaries.

**Tech Stack:** TypeScript, Vitest, existing DOM UI and IndexedDB; no new dependencies.

**Spec:** `docs/navigation-worksheet-teaching-contract.md`

## Approved follow-up: cruise checkpoints and altitude presentation

The subsequent approved change restricts authored checkpoints to the inclusive estimated TOC–TOD interval. Collect and report every checkpoint outside it after placement weather and before row calculations; preserve authored input. Show the single cruise-altitude assumption in compact cells and explain whole-phase altitude changes in the inspector, without fabricated row crossing altitudes. This supersedes the initial plan's allowance for checkpoints during climb/descent.

## Global Constraints

Approved profile/fuel follow-up: use one shared profile validator before weather/calculation, remove duplicate structural validation from calculators, discard unsupported stored profile formats without migration while retaining route inputs and notifying the pilot, and reject malformed current-format profiles. Preserve a distinct fuel exhaustion deficit and reserve shortfall in the snapshot and visible worksheet.

- One cruise altitude; no intermediate altitude transitions.
- TOC uses departure METAR; TOD uses cruise-altitude aloft wind above destination and field elevation.
- Profile descent rate is fixed for the estimate; placement occurs once.
- Each checkpoint's selected weather supplies its outgoing row; completed rows never change.
- Compact rows and inspector below route lines remain; authored legacy data is preserved.
- Issue #34 source display is separate work; do not merge or deploy.

## Review Focus

- Legacy differing altitude text requires a choice without data loss.
- TOD before the final checkpoint must remain calculable.
- Coincident and repeated-coordinate route occurrences preserve arithmetic and outbound overrides.
- Invalid authored inputs fail before weather access.
- Existing inspector retains the full calculation chain for newly generated results.

## Task 1: Simplify worksheet calculation

**Files:** `src/application/waypoint-worksheet.ts`, `waypoint-worksheet-row.ts`, `waypoint-preparation.ts` and their tests.

**Interface:** Retain `calculateWaypointWorksheet` and its result. Add optional `departureWeather` and `destinationWeather` explicit placement wind evidence; existing `selectWeather(waypoint, estimatedUtc, altitude)` remains. Single cruise altitude comes from equal source-leg altitude values; reject differing values before weather. Destination field elevation overrides the legacy descent target input for current calculation. All generated points are established before row progression. Placement wind uses explicit evidence when supplied, otherwise selector at departure/destination. Destination forecast time uses departure UTC plus total charted distance/profile cruise TAS (no wind) once, and is disclosed as a preliminary estimate. Checkpoint and TOC/TOD outgoing weather still selected sequentially, reusing coincident evidence.

- [x] Add failing cases for destination wind TOD, TOD before last checkpoint, stable altitude, repeated route coordinates, outbound overrides, and invalid input zero selector calls.
- [x] Remove transition state and superseded tests; use one TOC and TOD estimate and a straightforward forward row loop.
- [x] Run focused tests and report evidence for coordinator review.

## Task 2: Single altitude editor and safe saved-plan handling

**Files:** `src/ui/pilot-intent-planner.ts`, its tests; input storage only if needed.

**Interface:** Preserve `PilotInputPlan.cruiseAltitudeTexts` as legacy authored evidence. Store the single explicit choice as `rawFields['cruise-altitude']`; if absent infer only one identical nonblank text across legacy values, otherwise present empty control and require a choice. Route creation receives repeated single numeric altitude through the existing `cruiseAltitudesFeetMsl` adapter. No removal of legacy arrays or history. Remove descent-target control from current editing/calculation; current drafts use destination field elevation, preserving old raw text. Keep per-leg TAS overrides indexing based on checkpoint count rather than altitude array length.

- [x] Add failing tests for one altitude control, checkpoint edit stability, legacy repeated/differing values, and preserved raw data.
- [x] Replace controls and validation, use destination field elevation, retain page/inspector structure.
- [x] Run focused UI tests and report evidence.

## Task 3: Integrate real weather and preserve snapshot/inspector

**Files:** `src/application/route-weather-sampling.ts`, supporting snapshot adapter and tests; `src/ui/calculated-navlog.ts`/inspector only for accurate endpoint wording if necessary.

**Interface:** `resolveRouteWeather` retains its public return and emits `progressiveCalculationSnapshot` in existing `complete-navlog/v1` format, now calculated by `calculateWaypointWorksheet`. Use departure METAR explicit weather. Fetch destination wind once at cruise altitude using preliminary no-wind arrival UTC. Sequential callback fetches TOC/checkpoint point forecasts and retains evidence; TOD's outgoing descent uses the destination placement wind. Adapt row calculations and domain traces into existing snapshot shape; use domain math for traces, never an independently computed second result. Endpoint kind `field-elevation-airport` is rendered accurately while legacy endpoint kinds remain readable. Existing full engine uses already finalized snapshot; production does not invoke transition simulation.

- [x] Replace old progressive trajectory/weather loop and tests requiring modeled crossing altitude or rate adjustments.
- [x] Verify production integration requests, TOD source, field endpoint, fuel, row traces, and inspector selection.
- [x] Run focused integration tests and report evidence.

## Task 4: Combined review and delivery

- [x] Review diffs and fix contract/quality gaps; verify input to weather to result to inspector flow.
- [x] Run `mise exec -- npm run ci`, resolve failures, inspect diff for unintended scope.
- [ ] Signed Conventional Commit, push feature branch and update PR #33 description and superseded review threads; do not merge.
- [ ] Verify current remote checks and report status and remaining follow-up issue #34.

## Decisions

User approved contract and requested execution using usual workflow; proceed without another plan-approval round. Legacy storage arrays remain historical data, while only the route-level chosen altitude drives current calculations. Preliminary destination forecast time is explicitly an estimate, not iterated to match final arrival.

Ruling: reuse destination placement wind for the TOD outbound descent row; select fresh aloft at TOC for outbound cruise. This keeps the single descent estimate consistent and avoids using surface METAR as cruise wind. Checkpoints after TOD still select their own outgoing wind at cruise altitude as a disclosed worksheet assumption.

Ruling: broader retirement of legacy fixture/browser calculation engines remains issue #30; remove the now-unused private progressive simulation from the active weather module, but preserve old persisted snapshot reading and legacy fixture callers.
