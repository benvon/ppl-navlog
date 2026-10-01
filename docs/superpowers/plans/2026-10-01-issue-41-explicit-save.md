# Explicit saves and changed textbox outlines implementation plan

> **For agentic workers:** Use subagent-driven-development for the bounded implementation below.

**Goal:** Implement issue #41 without a concurrency redesign.

**Architecture:** Keep PlannerPlanState's single-flight writes and edit lock. Remove persistence from ordinary blur. Maintain only a presentation baseline of displayed literal textbox values, reset on plan load and successful draft persistence. It has no revision numbers, reconciliation, merge behavior, or storage schema.

**Tech Stack:** TypeScript DOM UI, CSS, Vitest/jsdom, existing IndexedDB repository.

**Spec:** `docs/superpowers/specs/2026-10-01-issue-41-contract.md` (approved GitHub issue #41).

## Global constraints

- No timed/background autosave, concurrent edits during writes, save queue, revision convergence, storage/calculation/weather changes, new warnings, or unrelated refactors.
- Keep explicit Save changes, save-before-New/Open, save-before-Update navlog, and existing deliberate action persistence.
- Preserve applicable pointer/focus and single-write/failure protections. Supersede obsolete blur-only tests and documentation.
- Literal text comparison; edited then restored clears the outline. Successful persistence advances baseline; failed persistence does not.
- Accessibility approved: red outline plus accessible description and brief visible explanation; preserve focus and validation separately.
- If the approved behavior truly requires changing concurrency architecture, report the conflict to the coordinator before proceeding.

## Review focus

1. Rapid Tab/Shift+Tab between unchanged and edited fields must neither save nor lock controls.
2. Whole-form rebuilds from deliberate structural actions must not erase unsaved comparisons for existing textboxes; new textboxes begin at their initial value.
3. Delayed and failed saves must preserve existing action guards and accurate textbox baselines without concurrent editing.
4. Profile draft text is saved as draft text; its outline must not imply profile validation/commit.
5. Derived local-time editing and Use current UTC must reflect literal changes without synthesized blur persistence.

## Task 1: Implement bounded planner behavior and tests

**Files:** `src/ui/pilot-intent-planner.ts`, `src/ui/pilot-intent-planner.test.ts`, relevant `src/ui/styles/*.css`, README/current planner documentation. Touch `planner-plan-state.ts` only if necessary to avoid marking identical values dirty, with no phase/concurrency changes. Historical plan/spec documents may get a short superseded note instead of rewriting history.

**Interfaces:** Keep repository, state-owner, and renderer public interfaces unchanged. Testbox marker: `data-unsaved="true"` only on changed textboxes; remove attribute when clean. Coordinator will use it for browser verification. Preserve existing aria-describedby validation IDs while adding/removing an unsaved description ID. No aria-invalid for unsaved status alone.

- [ ] Read spec and relevant existing tests/state code. Identify obsolete blur helpers vs safeguards still relevant to accepted actions.
- [ ] Write failing behavior tests first; record expected red failures before production changes.
- [ ] Implement removal of route/profile ordinary blur saves and audited derived blur dispatches. Keep validation-on-blur if it does not persist or dirty unchanged content.
- [ ] Implement minimal literal display-value baseline and changed textbox markers. Reset on load/accepted switch and acknowledged successful persistence. Do not infer success from status text or reset on every render/input notification.
- [ ] Style red changed outlines and preserve distinguishable keyboard focus. Add approved accessible description/visible explanation.
- [ ] Test untouched traversal, changed/restored text (blank, whitespace, 1 vs 1.0), save success/failure/retry, new/open baselines, structural rerenders, profile and route/checkpoint/override fields, and departure time controls.
- [ ] Adapt earlier blur-centric action tests to explicit saves and keep delayed writes, first accepted destination, retries, immediate action-after-input, disabled guard, and snapshot correctness assertions.
- [ ] Update current docs to explicit save behavior and mark conflicting historical design as superseded. No new page-close warning.
- [ ] Run targeted tests, full test suite, typecheck/lint. Commit only task files with signed Conventional Commit. Report paths, red/green evidence, any concerns.

## Coordinator verification

- Review spec compliance and implementation quality; return concrete bounded corrections.
- Run `mise exec -- npm run ci` in isolated worktree.
- Verify actual Tab/Shift+Tab in browser on desktop and narrow layouts, changed outlines/revert/save, keyboard save activation, and focus. Record browser evidence and honest limits.
- Run final independent whole-branch review. Integrate any bounded corrections and reverify affected behavior.
- Create reviewable draft PR only after local verification; attach it to this chat, inspect remote checks, report their actual state. Do not merge or deploy.
