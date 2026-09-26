# Guided Planner UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the active planner a readable, single-page flow from aircraft selection through route entry, calculation, and UTC navlog review.

**Architecture:** Change the active `PilotIntentPlanner` composition and its small UI state, leaving the browser-local input repository and calculation pipeline intact. Isolate local/UTC conversion in a focused UI utility; preserve `departure-time` as the existing literal UTC input key. Keep fuel aboard and capacity semantics from merged issue #15.

**Tech Stack:** TypeScript, DOM APIs, CSS, Vitest/jsdom, Vite, mise-managed Node 22.

**Spec:** `docs/superpowers/specs/2026-09-26-guided-planner-ui-design.md`

## Global Constraints

- Start from `main` at or after merged PR #16 (`01abb0d` in the updated local checkout); preserve the untracked design document and unrelated `.worktrees/` content.
- Do not change fuel, route, weather, or navlog calculation formulas; preserve browser-local raw input autosave and session-only results.
- Keep profile creation/selection semantics. Do not add profile editing/versioning, import/export, or a print/PDF flow.
- Every displayed navlog time remains UTC. The local picker and clock are input aids, not alternate navlog time zones.
- No acknowledgement checkbox for TAS override. Retain required reason, effective/default provenance, restore behavior, and current route-change clearing.

## Review Focus

- A DOM rerender while several sections are manually open must preserve their open state and raw input; Task 1 tests this.
- An incomplete or invalid UTC edit must survive blur and reload, with the local display unable to misrepresent it; Task 2 tests this.
- A daylight-saving gap or repeated local wall time must be rejected with direct-UTC guidance; Task 2 tests this.
- A stored TAS override must remain visible after reopening a plan, while unused legs show no override controls; Task 3 tests this.
- A profile or route edit after calculation must remove the stale navlog without dropping fuel-aboard text or a persistent save failure; Task 1 and Task 4 test this.

---

### Task 1: Stage flow and grouped plan inputs

**Files:**
- Modify: `src/ui/pilot-intent-planner.ts`
- Test: `src/ui/pilot-intent-planner.test.ts`
- Modify: `docs/ui-architecture.md`

**Interfaces:**
- Consumes: existing `PilotInputPlan`, `PilotIntentPlannerDependencies`, `renderCalculatedNavlog`, and the `fuel-aboard`, `taxi-fuel`, and `reserve-fuel` raw keys.
- Produces: four semantic stage sections with `data-stage="aircraft|route|calculate|navlog"`, an `activeStage` value, and disclosure open state owned by the planner. The saved-plan selector and New plan control remain outside the stages.

- [ ] **Step 1: Write failing DOM tests** for first visit without profiles (Aircraft open), new plan with selected profile (Route open), saved plan (Route open and aircraft summary), successful update (Navlog open), failed update (Calculate open), editing a current result (edited section open and result gone), and two manually opened sections surviving an inspector rerender.
- [ ] **Step 2: Run** `mise exec -- npm test -- src/ui/pilot-intent-planner.test.ts`; confirm the new tests fail for missing stage behavior.
- [ ] **Step 3: Implement** stage headers as keyboard-operable native disclosures, stage transition helpers in `PilotIntentPlanner`, and a compact saved-plan selector. Keep `current`, `fields`, and `profileDraftDirty` as existing state owners. Preserve manually opened sections on ordinary rerenders; reset to one open section at workflow milestones. Do not select or load a plan merely because the user opens a disclosure.
- [ ] **Step 4: Move existing controls into groups:** Aircraft selection/creation; route identity and endpoints, timing, checkpoints/leg altitudes, plan-level fuel (`fuel-aboard`, `taxi-fuel`, `reserve-fuel`), arrival target, and optional METAR alternate; Calculate action/error; current navlog and inspector. Preserve input `name` attributes and form capture behavior.
- [ ] **Step 5: Run** the focused test file, `mise exec -- npm run typecheck`, and `mise exec -- npm run lint`; confirm pass. Update `docs/ui-architecture.md` to describe the active stage layout and state ownership.
- [ ] **Step 6: Commit** focused changes with a signed Conventional Commit, for example `feat(ui): organize planner into guided stages`.

### Task 2: Local picker, editable UTC, and paired clock

**Files:**
- Create: `src/ui/departure-time.ts`
- Create: `src/ui/departure-time.test.ts`
- Modify: `src/ui/pilot-intent-planner.ts`
- Test: `src/ui/pilot-intent-planner.test.ts`
- Modify: `src/ui/styles/components.css`

**Interfaces:**
- Produces: `localDateTimeToUtcText(localText: string): { ok: true; utcText: string } | { ok: false; reason: string }` and `utcTextToLocalDateTime(utcText: string): string | undefined`. Both use the browser time zone; the persisted UTC string remains `YYYY-MM-DDTHH:mm` under `departure-time`.
- Consumes: existing `localUtcTextToIso` validation when Update plan builds a draft.

- [ ] **Step 1: Write failing utility tests** for local-to-UTC conversion across a date boundary, UTC-to-local round trip, invalid calendar text, a nonexistent spring-forward local time, and an ambiguous fall-back local time. Reject either DST ambiguity with a message directing direct UTC entry; do not silently select one offset.
- [ ] **Step 2: Run** `mise exec -- npm test -- src/ui/departure-time.test.ts`; confirm failures.
- [ ] **Step 3: Implement** the conversion functions using built-in `Date` and local calendar component checks; detect alternate offset candidates around a local wall time before accepting it. Do not add a date library unless a demonstrated edge cannot be handled reliably without one.
- [ ] **Step 4: Add DOM tests** that the local picker writes the UTC field, a valid UTC edit updates local display, incomplete UTC text persists without being overwritten, and the displayed UTC hint says `YYYY-MM-DDTHH:mm` with an example such as `2026-09-26T18:30`. Make the field error repeat this format. Verify the two-line live clock labels local zone/offset and UTC date/time; fake timers must not alter departure input.
- [ ] **Step 5: Implement** the picker and clock adjacent to the UTC field. Use an interval that updates clock text without replacing the route form; clean it up when the planner is no longer mounted. Keep invalid local selection visible with an error and leave the last pilot-entered UTC text untouched.
- [ ] **Step 6: Run** focused tests, typecheck, and lint; confirm pass. Commit as `feat(ui): add local departure picker and UTC clock`.

### Task 3: TAS override as an exception

**Files:**
- Modify: `src/ui/pilot-intent-planner.ts`
- Test: `src/ui/pilot-intent-planner.test.ts`
- Modify: `src/ui/styles/components.css`

**Interfaces:**
- Consumes: existing raw `override-tas-{index}` values and `PilotInputPlan.overrideReasons`/`override-reason-{index}` capture.
- Produces: per-leg **Override TAS** reveal action, active override label, and **Restore aircraft default** action. No change to `applyCruiseTasOverride` or calculation data structures.

- [ ] **Step 1: Write failing DOM tests** for normal legs showing the aircraft default without override inputs, reveal/editor entry with required reason but no acknowledgement, existing stored override shown on reopen, restore clearing both value and reason, and checkpoint changes still clearing/remapping overrides with a notice.
- [ ] **Step 2: Run** `mise exec -- npm test -- src/ui/pilot-intent-planner.test.ts`; confirm failures.
- [ ] **Step 3: Implement** per-leg disclosure state and restore action. Remove `confirmedOverrides` and its validation path, preserve positive TAS and required-reason validation, and keep the active override distinguished in text as well as style. A cancelled empty editor must not create an override.
- [ ] **Step 4: Run** focused tests, typecheck, and lint; confirm pass. Commit as `feat(ui): simplify leg TAS override controls`.

### Task 4: Responsive visual hierarchy and integrated behavior

**Files:**
- Modify: `src/ui/styles/layout.css`
- Modify: `src/ui/styles/components.css`
- Modify: `src/ui/styles/tokens.css` only if an existing token cannot express the new hierarchy
- Test: `src/ui/pilot-intent-planner.test.ts`
- Test: `src/ui/calculated-navlog.test.ts` only if UTC labels or result rendering require a correction

**Interfaces:**
- Consumes: stage markup from Task 1, time controls from Task 2, and TAS controls from Task 3.
- Produces: readable laptop and narrow layouts, compact selector widths, consistent action hierarchy, grouped field spacing, and visible focus/error states.

- [ ] **Step 1: Write or adjust behavior tests** for keyboard-operable disclosures, focus after a failed update, visible field and section error associations, a persistent save failure across stage changes, fuel-aboard text surviving an edit/rerender, and UTC labels in result output.
- [ ] **Step 2: Run** focused tests; confirm any new behavior assertions fail before changes.
- [ ] **Step 3: Style** the active stages and related input groups. Keep the aircraft selector content-sized with a sensible max width, make New plan and secondary actions compact, and make Update plan visually primary. Preserve readable navlog columns with scroll limited to the table container.
- [ ] **Step 4: Inspect** a representative laptop viewport and a narrow viewport in the rendered app. Check tab order, disclosure operation, field labels, focus indicator, status/error announcements, time hint, paired clock, and a result containing a fuel shortfall. Fix observed problems rather than asserting visual quality from tests alone.
- [ ] **Step 5: Run** `mise exec -- npm run ci`, `git diff --check`, and any browser smoke needed for the final observed issue. Record unavailable checks and do not claim they passed. Commit as `style(ui): clarify planner hierarchy and responsive layout`.

## Completion Review

Compare the whole active flow against the spec with an ordinary new plan and a boundary case: reopen a plan with incomplete UTC or fuel aboard, edit it, use a TAS override, calculate, then inspect UTC times and fuel balances. Confirm no pilot text disappears when sections collapse or a calculation fails. Review the final diff for unrelated model changes, run the full quality gate once on the final branch, and prepare a Conventional Commit PR body with what changed, why, validation, and any remaining limits.
