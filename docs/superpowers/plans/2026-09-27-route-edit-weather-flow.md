# Route Editing and Weather Flow Implementation Plan

> **For agentic workers:** Implement only the assigned task. The coordinating agent owns the shared contract, reviews each task, and verifies the combined pilot flow before PR creation.

**Goal:** Make saved-plan edits, waypoint altitude entry, and weather-dependent navlog updates understandable and reliable.

**Architecture:** Keep the current input-only `PilotInputPlan` and per-leg altitude array. Change the active planner's presentation and persistence affordance; keep the existing weather fetch on Update navlog and make its validation failures specific. Do not modify the legacy planner or the Worker API.

**Tech Stack:** TypeScript, DOM UI, Vitest, CSS, IndexedDB repository contract.

**Spec:** `docs/superpowers/specs/2026-09-27-route-edit-weather-flow-design.md`

## Global constraints

- Preserve literal pilot input, plan identity, submission history, and autosave-on-blur.
- Keep altitude per outbound leg: index 0 begins at Departure; checkpoint `i` begins leg `i + 1`.
- Keep METAR identity, nonstale cache, usable-wind, observation-at-or-before-departure, and two-hour age requirements.
- Do not add a manual METAR refresh control or silently change departure UTC.
- Each worker uses a signed Conventional Commit and reports tests plus known limits. The architect reviews the diff and user-visible behavior before the next worker starts.

## Task 1: Group altitude and TAS controls with their source waypoint

**Worker:** Luna/Medium. **Files:** `src/ui/pilot-intent-planner.ts`, its DOM tests, and planner styles only.

- [ ] Add a failing DOM test proving Departure contains `altitude-0` and TAS for leg 1, and checkpoint `i` contains name, coordinate, `altitude-(i+1)`, and TAS for leg `i+2`; labels identify outbound destination.
- [ ] Add a focused add/remove test proving existing `cruiseAltitudeTexts` semantics and the existing TAS-override clearing contract are preserved.
- [ ] Implement semantic waypoint groups/cards in `renderRouteCollections` without changing `PilotInputPlan`, `createRouteDefinition`, or the calculation model. Style them for narrow and wide screens.
- [ ] Run focused tests, typecheck, lint, and diff check; commit the task.

**Review gate:** The architect checks DOM grouping, label clarity, keyboard reachability, and stored leg indexing before Task 2.

## Task 2: Make saving an explicit, separate action

**Worker:** Luna/Medium. **Files:** `src/ui/pilot-intent-planner.ts`, its DOM tests, and any necessary planner styles.

- [ ] Add failing tests that Save changes persists literal and structured inputs, including incomplete text, without `submitInputs`, METAR/point requests, or calculation; opening a saved plan gives accurate guidance.
- [ ] Cover serialized save-queue ordering, a save failure, and a later successful retry without losing current editor text.
- [ ] Add a visible Save changes button in Route information using `captureStructured` plus existing `persist()`. Keep blur autosave. Distinguish a successful explicit save from calculation and surface failures without false success. Relabel Update plan to Update navlog if required for clarity; update existing tests accordingly.
- [ ] Run focused tests, typecheck, lint, and diff check; commit the task.

**Review gate:** The architect confirms save-only behavior, persistence failure visibility, and that the Calculate action remains the sole weather/calculation trigger before Task 3.

## Task 3: Make departure-time recovery and METAR failures actionable

**Worker:** Luna/Medium. **Files:** `src/ui/pilot-intent-planner.ts`, `src/application/route-weather-sampling.ts`, focused tests, and `docs/weather-model.md` if behavior wording needs updating.

- [ ] Add failing UI tests proving a valid past departure offers Use current UTC, clicking it updates and saves the literal UTC field, clears any result, and makes no weather request; a later Update navlog fetches METAR automatically.
- [ ] Add weather-validation tests for a suitable same-station recent report from a fresh cache hit and for specific rejection causes: observation after departure, more than two hours old, wrong station, stale cache, missing observation, and unusable wind.
- [ ] Implement distinct, pilot-actionable errors without relaxing any validation. Keep the existing primary/alternate fetch policy and do not require the METAR to differ from a prior response.
- [ ] Run focused tests, typecheck, lint, and diff check; commit the task.

**Review gate:** The architect checks the difference between fetch failure and fetched-but-ineligible data, literal time preservation, and successful retry before integration.

## Integration and acceptance

- [ ] The architect runs the ordinary and boundary cases in the spec through tests and a browser when available, checking that altitude edits survive Save changes and that a subsequent Update navlog uses the intended route.
- [ ] Run `mise exec -- npm run ci` and inspect every failure; verify clean diff and signed commits.
- [ ] Review the whole branch for unintended changes to fuel, route geometry, weather validity, and pilot-input persistence.
- [ ] Create a Conventional Commit PR summarizing what, why, testing, and limits. Do not merge it before review.
