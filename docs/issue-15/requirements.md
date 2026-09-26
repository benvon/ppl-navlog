# Issue #15: fuel aboard and running fuel balance

Authority: GitHub issue #15 and the user's clarification on 2026-09-26. This is a fuel-model correction in its own PR. The active path is `renderPilotIntentPlanner`; the older revision planner is outside scope except for type compatibility. Do not incorporate the guided planner UI redesign.

## Product contract

1. Keep optional usable fuel capacity on the aircraft profile. Add `fuel-aboard` as literal plan input text, in gallons before taxi/run-up. Never infer it from capacity, past calculations, or old saved plans. Zero is valid.
2. A plan with missing or malformed fuel aboard remains savable as a browser-local working copy. `Update plan` (submission, weather fetch, calculation) is unavailable until all required inputs are valid. Keep the existing autosave-on-blur and failed-save behavior: a failed local write is surfaced and must not be reported as saved. Opening old plans lacking the key shows an empty fuel-aboard field and retains every other input.
3. Fuel aboard must parse to a finite nonnegative number. If usable capacity exists, fuel aboard > capacity is a field-level error and blocks Update plan; equality is valid. If capacity is absent, do not invent it or use aboard as capacity. Validate again at the domain/application calculation boundary so callers bypassing the UI cannot calculate invalid input. Missing fuel aboard blocks a fresh calculation.
4. The running balance begins at fuel aboard. Deduct taxi/run-up first; deduct each calculated row's fuel in route order. Keep unrounded arithmetic through every row. Preserve each row's calculated consumption and the existing phase/taxi/reserve/required-fuel breakdown. A row's balance may be signed as a mathematical estimate, but the UI must never label a negative value as fuel available.
5. Show in the navlog, with gallons and clear pilot-input versus calculated provenance: aboard, taxi/run-up deduction, post-taxi balance, each calculated row's fuel used and post-row balance, estimated arrival balance, reserve, margin above reserve or reserve shortfall, and any fuel-exhaustion deficit. Insufficiency is prominent even when input is zero or the route reaches exactly zero; distinguish capacity comparison unavailable from actual aboard-fuel sufficiency. Existing calculation evidence must include aboard and the running calculation. Show at least one decimal place but use unrounded values for comparisons.
6. Keep profile fuel flow as the consumption source. Do not add leg fuel editor fields. Existing TAS override recalculation must flow through ETE, row fuel used, running balance, and arrival status. Weather/calculated results remain session-only; submitted input snapshot retains literal text.

## Examples and acceptance criteria

- 40 gal capacity, 30 aboard, 1 taxi, 8 route, 5 reserve -> 29 after taxi, 21 arrival, +16 reserve margin.
- 41 aboard with 40 capacity blocks Update with a field error; 40 aboard is allowed.
- 10 aboard, 1 taxi, 8 route, 3 reserve -> 1 arrival and a prominent 2 gal reserve shortfall.
- Zero aboard is valid input; any positive taxi/route burn or reserve makes the route insufficient. Exactly zero remaining with zero reserve still gets a prominent fuel-exhaustion warning per user clarification.
- Taxi consumption greater than aboard and route consumption that crosses zero remain calculated (no input error); present deficit prominently rather than claiming available fuel.
- Missing capacity permits calculation from aboard and labels capacity comparison unavailable.
- Sequential rows carry the unrounded prior balance; display rounding must not alter subsequent arithmetic or the reserve decision.
- Old saved plan reload has blank aboard and unchanged other inputs; incomplete working copy saves; no fetch or calculation occurs until entry is valid. Literal input text survives blur and explicit submission. Failed local save is reported without a false success claim.
- Changing TAS through the existing override changes time, fuel used, balances, and arrival status.

## Implementation boundaries

- Task A: stored input/draft contract and validation. Own `src/domain/route.ts`, `src/application/plan-use-cases.ts`, `src/services/storage/*` only as needed, and associated tests. Use backward-compatible optional stored representation; no database version bump merely for a raw field.
- Task B: calculation and evidence. Own `src/domain/phase-planning.ts`, `src/application/navlog-calculation.ts`, `src/application/route-weather-sampling.ts`, `src/application/full-navlog-engine.ts` only as needed, and associated tests. Consume Task A's `fuelAboardGallons` in `PlanFuelInputs`. Keep existing `requiredFuel`, `usableFuelDifference`, and phase totals for compatibility; add aboard-specific balances and shortfall.
- Task C: active planner and display. Own `src/ui/pilot-intent-planner.ts`, `src/ui/calculated-navlog.ts`, `src/ui/styles.css` only as needed, and associated tests. Add field-level error and separate incomplete-save from Update gate. Do not add per-leg fuel editors. Update current fuel docs (`docs/calculation-model.md`, `docs/data-provenance.md`) and relevant fixtures.

## Verification and review

Each task adds behavior-focused tests before implementation, reports the command and result, and leaves a reviewable diff. Architect reviews each task and sends findings back to its implementer. Final review checks the combined active path, old-plan compatibility, numeric precision, warning wording, calculation evidence, and unchanged unrelated work. Run typecheck, lint, relevant tests, build, and repository security scripts; report any unavailable checks. Use mise-managed Node and npm. Do not commit secrets or unrelated changes.
