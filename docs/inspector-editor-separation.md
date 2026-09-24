# Calculation inspector and draft TAS editor separation

## Intent

This note was written for the former revision-based planner. Under issue #7, the inspector reads the successful calculated result held in the current session; it does not read a saved revision. Any pilot edit, failed update, plan open, import, or reload leaves no current result to inspect. Its revision-history and persistence-schema constraints below are superseded by the [pilot intent design](superpowers/specs/2026-09-24-pilot-intent-design.md).

The Calculation Inspector is a read-only explanation of a selected calculated navlog value: how the saved revision arrived at that number. It must not silently select a leg or contain draft editing controls. Draft cruise TAS overrides belong to the route editor and require an explicit leg choice.

## Behavior

- With no calculated value selected, the Calculation Inspector shows a short selection prompt and no leg defaults, override controls, or first-leg fallback.
- Selecting a calculated navlog value shows that saved row's value, inputs, intermediate results, assumptions, and provenance. Selection remains keyboard accessible and visibly identifies the chosen cell.
- Changing plan inputs or opening, saving, calculating, or refreshing a revision clears the selected calculation. The inspector then returns to its prompt. It never displays an explanation bound to stale inputs as the current selection.
- The draft navlog has no ambiguous `Inspect` action. Its uncalculated values remain visibly uncalculated, and calculated cells remain inspectable after a successful calculation.
- The route editor lists each saved draft leg by origin and destination and offers an explicit `Edit TAS` action for that leg. No leg is selected by default, and opening the editor never chooses the first leg implicitly.
- The TAS editor keeps the existing per-leg override confirmation, effective/default value display, restore action, and unsaved-revision gate. Applying or restoring an override keeps the route editor focused on the same leg while clearing any calculated-value inspection. A route topology change or opening another draft clears the TAS editor's leg selection.
- A draft row and its TAS editor must refer to the same saved leg ID. Never target a different leg because a previous selection is absent.

## Constraints and acceptance

- Do not change flight math, weather selection, persistence schema, or immutable revision behavior.
- Preserve the existing calculated navlog inspector's trace and provenance rendering and the print/PDF behavior.
- Tests cover the empty Calculation Inspector, calculated-value selection, selection clearing after an input or revision change, second-leg TAS override and restore, and clearing the TAS editor on route change. Tests must prove no first-leg fallback.
- Run typecheck, lint, the full test suite, build, secret scan, and diff checks before updating PR #8.
