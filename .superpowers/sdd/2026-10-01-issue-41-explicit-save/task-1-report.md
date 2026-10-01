# Issue #41 Task 1 report

## Status

Implementation and local Task 1 checks are complete. Independent live-browser replay remains with the coordinator. No concurrency or storage architecture changes were needed.

## Files

- `src/ui/pilot-intent-planner.ts`: removed ordinary route/profile blur persistence and synthesized blur dispatches; added literal textbox baselines, changed-only `data-unsaved="true"` markers, successful-save acknowledgement, checkpoint baseline lifecycle, and changed-only accessible status descriptions.
- `src/ui/pilot-intent-planner.test.ts`: replaced blur-save assertions with explicit-save boundaries and added coverage for no-write focus movement, exact restore and literal comparisons, save failure/retry, rerender retention, reused checkpoint names, and local/UTC departure controls.
- `src/ui/styles/components.css`: red changed-field border, distinct keyboard focus ring, visible explanation, and visually hidden accessible description.
- `README.md`, `docs/ui-architecture.md`: documented explicit save boundaries and textbox feedback.
- `docs/issue-15/requirements.md`, `docs/superpowers/plans/2026-09-29-serialized-planner-save-switch.md`: added short notices that issue #41 supersedes their historical blur-save requirements while preserving other requirements.

## Red/green evidence

- Added `keeps ordinary blur out of persistence and tracks literal textbox changes` first. Before implementation it failed because an untouched field blur made one repository write where the test expected zero.
- After implementation the focused regression passed. The test verifies unchanged blur, whitespace change, exact restore, blank text, literal `1` versus `1.0` after acknowledgement, profile draft markers, changed-only `aria-describedby`, and no `aria-invalid` for unsaved status.
- Added failure/retry and structural-rerender coverage; changed text retains its marker after a failed structural save, retry acknowledges it, and subsequent edits compare with that successful baseline.
- Added checkpoint removal/re-add coverage proving a reused field name starts clean with its new displayed value.

## Checks

- `mise exec -- npx vitest run src/ui/pilot-intent-planner.test.ts` → 84/84 passed.
- `mise exec -- npm test` → 39 files, 435/435 passed.
- `mise exec -- npm run typecheck` → passed.
- `mise exec -- npm run lint` → passed.
- `git diff --check` → passed.

## Blur and pointer/focus audit

The active planner has no route/profile textbox blur persistence handler and no derived-control blur dispatch. Text input events update the active in-memory draft, validation, and calculated-result invalidation. Existing deliberate persistence remains for explicit Save changes, save-before-New/Open and Update navlog, profile save, and route structure/override actions. Single-flight writes, accepted destination behavior, control locks during deliberate saves, retry/discard handling, and snapshot capture remain with the unchanged `PlannerPlanState` model.

The pointerdown default prevention and accepted-button focus transfer remain. They no longer guard against blur-triggered writes; they preserve first-click action behavior and button focus. The coordinator's browser replay reported correct forward/reverse Tab traversal through profile and route fields, no write/focus loss on unchanged profile blur, isolated dirty marker and exact revert behavior, and keyboard Save changes activation with focus retained.

## Concerns and limits

The coordinator owns the final browser pass, including narrow viewport and save-failure/retry replay. Ordinary edits are held in memory until an explicit boundary; refresh/close recovery and browser-close warnings remain out of scope as specified. No other implementation concern was found.
