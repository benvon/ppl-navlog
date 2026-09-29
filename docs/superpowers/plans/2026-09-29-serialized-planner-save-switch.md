# Serialized Planner Save and Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make planner saves and plan switches single-flight operations with one owner for editable pilot inputs and visible save state.

**Architecture:** A small state owner has four explicit phases: editing, saving, switching, and save failed. It permits one write and one accepted New/Open destination at a time. The planner UI reads the owner's active draft and saved list, forwards edits, and locks the editor during saving or switching without replacing focused DOM controls.

**Tech Stack:** TypeScript, Vitest/jsdom, existing `PilotInputRepository`; no new dependencies or storage migration.

**Spec:** [GitHub issue #12](https://github.com/benvon/ppl-navlog/issues/12), revised 2026-09-29 after the user approved single-flight transitions.

## Global Constraints

- Keep browser-local incomplete literal and structured pilot inputs, and preserve submission history.
- Keep blur autosave; a blur after a failed save does not silently retry.
- Keep New/Open clickable during a pending blur save so an immediate click is captured; only the first destination request is accepted until resolution.
- Disable plan editing during a write or destination read, and expose a visible Saving/Opening status.
- Keep weather, calculations, printing, import/export, and guided layout outside this issue.
- Use signed Conventional Commits and `mise exec -- npm run ci` before completion.

## Review Focus

- Blur then immediate New must capture the click before any control lock suppresses it.
- A write that fails with a pending destination must retain the exact draft and destination; later blur must not retry.
- A second New/Open during a write or read must not supersede the first.
- Failed Open read must retain the active draft and show a useful error.
- Keyboard focus and narrow-width controls must stay usable when the editor locks/unlocks.

### Task 1: Single-flight plan state owner

**Files:** Create `src/ui/planner-plan-state.ts`, `src/ui/planner-plan-state.test.ts`.

**Interfaces:** Consume `PilotInputPlan`, `PilotInputRepository`, IDs, clock. Export `PlannerPlanState` with `initialize()`, immutable `view`, `subscribe(listener)`, `edit(fullPlan)`, `save()`, `requestNew(createDraft)`, `requestOpen(id)`, `retry()`, and `discardPending()`. `view` exposes active draft, saved plans, phase/status, optional accepted destination, and error. Commands reject or ignore actions unavailable in the current phase rather than starting another operation. Decide exact types in this task and document them for Task 2.

- [ ] Write failing tests for edit/save success, one in-flight write, New/Open during save, first request wins, save failure and latest-draft retry, confirmed discard without an in-flight write, blur no-op after failure, missing/rejected Open, and list/rename updates.
- [ ] Run `mise exec -- npm test -- src/ui/planner-plan-state.test.ts` and confirm each new behavior fails for the intended reason.
- [ ] Implement one phase transition path per command; keep repository calls outside event callbacks but within the one active async operation. Clone the snapshot before writing. Reject edits while saving/switching. Do not add revision queues, last-request-wins pumps, or concurrent read/write recovery.
- [ ] Run focused tests and typecheck; signed commit.

### Task 2: Integrate the active planner UI

**Files:** Modify `src/ui/pilot-intent-planner.ts`, `src/ui/pilot-intent-planner.test.ts`, and the one owner-invariant paragraph in `docs/ui-architecture.md`.

**Interfaces:** Consume Task 1 owner. The owner is authoritative for active draft, saved list, and save phase. The UI may derive temporary field values from the owner or DOM, but must not maintain a second mutable plan copy. All field, profile, route, save, New, and Open actions call owner transitions. Existing selector and disclosures remain in place.

- [ ] Write failing UI tests for immediate blur/New, editor lock during delayed save, first destination wins, failed save with Retry/Discard, editing after failure without silent retry, saved-list refresh without editor replacement, missing/failed Open, keyboard focus through lock/unlock, and Update navlog after pending autosave.
- [ ] Run `mise exec -- npm test -- src/ui/pilot-intent-planner.test.ts`; confirm failures describe current behavior.
- [ ] Wire UI to owner, disable only plan editing during Saving and all plan interaction during Switching; keep New/Open able to capture one destination during Saving. On failure keep draft editable and New/Open locked to the accepted destination. Show explicit Retry and confirmed Discard. Do not replace the active editor on save completion.
- [ ] Run focused tests, full test suite, typecheck, lint; signed commit.

### Task 3: Integrated review and verification

- [ ] Review the combined user-visible flow against every issue acceptance criterion, including ordinary edit/save/switch and boundary failed-save/recovery sequences. Return concrete defects to the responsible implementer for test-first correction and scoped re-review.
- [ ] Run `mise exec -- npm run ci`; report all pass/fail output, including dependency-audit advisories. Manually check keyboard and a 390 px viewport. Note any unverified browser failure path.
- [ ] Confirm clean isolated worktree, signed focused commits, and no unrelated main-checkout edits. Do not create a PR until the integrated result is verified and reviewable.
