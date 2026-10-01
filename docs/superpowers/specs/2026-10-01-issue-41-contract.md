## Problem

Tabbing through the navlog form should follow the visible layout, generally left to right and then top to bottom. Ordinary field-exit autosaves currently enter the saving phase and disable editor controls, which can interrupt focus and the next Tab step. Merely visiting an unchanged field can initiate a save.

The current single-flight save/switch model intentionally rejects edits while saving. Removing input locking while retaining field-exit autosave would introduce concurrent editing and snapshot replacement risks. This issue instead removes saves from ordinary focus movement and keeps deliberate action boundaries.

## Behavioral contract

### Editing and keyboard navigation

- Remove automatic persistence triggered by ordinary textbox blur in both route inputs and the aircraft profile editor. Focus and blur alone must not dirty the draft or initiate a write.
- Capture actual value changes in the authoritative in-memory draft while editing, including incomplete and invalid literal text. Preserve existing validation and calculated-result invalidation.
- Tab and Shift+Tab follow the visible reading order through enabled inputs, selectors, buttons, and disclosure controls. Preserve keyboard access to actions. Prefer matching DOM and visual order; do not introduce positive tabindex values or a custom Tab interception scheme.
- Ordinary typing and focus movement must not disable editor controls, replace the focused textbox, or move focus. Saving may still lock controls during deliberate actions under the existing state model.

### Save boundaries and concurrency

- Keep Save changes as the explicit way to persist the current pilot-input draft.
- Preserve save-before-switch for New/Open and save-before-calculation for Update navlog. Capture current inputs before executing the action. A failed required save must prevent the switch/calculation and preserve the draft and existing recovery choices.
- Preserve existing deliberate action-triggered persistence, such as saving an aircraft profile or changing route structure; audit derived controls that currently synthesize blur so they cannot accidentally restore field-exit saving.
- Keep one write in flight, existing command availability guards, and existing first-accepted-destination behavior. This issue does not permit edits during a write or add a write queue/revision architecture.
- Inspect the earlier pointer/focus collision fixes and retain safeguards still needed at action boundaries. Remove obsolete blur-specific behavior and tests only when demonstrably superseded by this contract.

### Red textbox outlines for unsaved changes

- Show a red outline on each textbox whose current literal value differs from its baseline. Focus or blur without a content change must never show the unsaved outline.
- Baseline means the value loaded when the plan/editor opens, or the value acknowledged by the latest successful persistence of that textbox's owning draft. For a new plan, use its initial displayed values; for a newly added textbox, use its initial displayed value.
- Compare literal values without trimming, normalization, or numeric coercion: changing `1` to `1.0`, or adding whitespace, is a change. Restoring the exact baseline clears the outline even before saving.
- Update the outline as the value changes, including paste and programmatic user actions such as Use current UTC or local-time conversion. Derived editing controls should compare with the value corresponding to the same baseline.
- Advance the baseline only after successful persistence. A failed save leaves changed outlines and draft contents intact. Opening another plan resets comparisons to that plan's values.
- Distinguish persistence of aircraft-editor draft text from the separate Save aircraft profile operation; saving draft text must not imply an aircraft profile was validated or committed.
- Keep a clear keyboard focus indicator visible on changed and unchanged textboxes. Red denotes unsaved content, not invalid input: do not set aria-invalid solely because a field is changed. Provide an accessible unsaved description and a brief visible explanation of the red outline so color is not the only cue. Retain existing validation messages.
- Non-text controls and structural route changes must still participate correctly in draft/save state; this issue does not require red outlines for those controls.

## Acceptance criteria

- [ ] Tab through untouched route and aircraft textboxes: no writes, no red outlines, no save-related input disabling, and no focus jumps. Shift+Tab reverses the sequence.
- [ ] Edit a textbox and tab onward: the literal draft value remains, the changed textbox has a red outline, and ordinary field exit performs no write.
- [ ] Edit then restore the exact baseline: the red outline clears. Test blank values, whitespace, and numerically equivalent but textually different values.
- [ ] Save changes successfully: persisted values match the draft, outlines clear for acknowledged textbox values, and later edits compare against the new baseline.
- [ ] Force a save failure: edited text and outlines remain, failure is visible, and retry succeeds without losing values. Tabbing does not silently retry.
- [ ] Immediately activate Save changes, New, Open, or Update navlog after typing: current inputs are captured, only one write runs, and the action uses the correct plan/snapshot. Test delayed writes and repeated activation.
- [ ] Required save failure prevents New/Open or Update navlog from proceeding; existing retry/discard semantics remain safe.
- [ ] Preserve literal aircraft-editor draft inputs, checkpoint inputs, TAS/reason inputs, and departure-time editing behavior across saves and plan switching.
- [ ] Verify actual browser keyboard traversal on desktop and narrow layouts, including rapid tabbing, keyboard button activation, and accessible focus/unsaved feedback. Same-turn synthetic blur tests alone are insufficient.
- [ ] Relevant regression tests and repository CI pass. Update current documentation and tests that require blur autosave to reflect this explicitly superseding decision.

## Scope and non-goals

No timed/debounced/background autosave, concurrent editing during persistence, storage-schema changes, calculation/weather changes, or general state-machine rewrite. No unrelated layout redesign.

Removing field-exit persistence means recent textbox edits can be lost if the user refreshes or closes the page before a deliberate save boundary. Automatic recovery and browser-close warnings are outside this issue; do not claim that drafts are automatically protected against those events.

## Implementation reference

Start with `src/ui/pilot-intent-planner.ts`, `src/ui/planner-plan-state.ts`, their tests, and the planner layout/focus styles. The serialized save/switch plan in `docs/superpowers/plans/2026-09-29-serialized-planner-save-switch.md` describes earlier invariants: this issue supersedes its requirement to keep blur autosave while preserving applicable single-flight and failure protections.

