# Calculation inspector and draft TAS editor separation

The Calculation Inspector explains a value from the current session calculation. It shows the route weather, wind-triangle math, time, and fuel evidence used to produce that value. It does not read or save a historical revision.

The inspector stays read-only and does not silently select a leg. Draft cruise TAS overrides belong to the route editor and require an explicit leg choice.

## Behavior

- With no calculated value selected, the inspector shows a short prompt and no leg defaults, override controls, or first-leg fallback.
- Selecting a calculated navlog value shows that row's stored value, point station identities, issue/use periods, wind and temperature altitude levels, interpolation weights, vector/leg math, and planning assumptions. Weather and user-provided strings render as text nodes.
- Changing any pilot input, switching plans, starting an update, or failing an update clears the current result and selected evidence. Submitted pilot inputs are saved before weather requests; a failure remains visible until a later successful update. Reload begins without weather results and requires a new update.
- The navlog shows current-weather validity, calculated values, and relevant planning and fuel warnings. It contains no station identities, raw TAF, source periods, interpolation weights, or calculation traces. Calculated values remain selectable for the inspector.
- The route editor lists each saved draft leg by origin and destination and offers an explicit `Edit TAS` action for that leg. No leg is selected by default, and opening the editor never chooses the first leg implicitly.
- The TAS editor keeps the existing per-leg override confirmation, effective/default value display, restore action, and unsaved-input gate. Applying or restoring an override keeps the route editor focused on the same leg while clearing any calculated-value inspection. A route topology change or opening another draft clears the TAS editor's leg selection.
- A draft row and its TAS editor must refer to the same saved leg ID. Never target a different leg because a previous selection is absent.

## Constraints and acceptance

- Weather answers and calculated output are session-only; the pilot-input repository stores submitted inputs only.
- Keep PDF output out of this flow; any later PDF may contain navlog values only.
- Tests cover an empty inspector, selected-value evidence, value agreement, selection clearing after input changes, failure and later recovery, and TAS editor behavior. Tests prove there is no first-leg fallback.
