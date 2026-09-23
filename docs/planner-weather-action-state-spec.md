# Planner weather selection and button state specification

## Purpose

Fix the open PR #6 finding where editing a surface METAR source on a reopened plan enables Save but silently drops the saved forecast and the source edit. Make the Save and Refresh controls reflect the operation their handlers will actually perform. Keep this work inside the existing planner and weather selection use case; do not add a general state machine framework.

## State contract

The saved revision is the source of truth for its committed forecast and surface METAR source. The planner editor may also hold a newly selected published forecast period and an edited source. An absent newly selected period means "no replacement chosen"; it must never by itself mean "delete the saved forecast."

Derive one effective weather choice from those inputs for rendering availability and preparing a save:

- If a new published period was explicitly selected and is valid for the current departure time, use it with the current source field.
- Otherwise, if the saved revision has a forecast and the route and departure time have not invalidated it, preserve that forecast and apply the current source field. A source-only edit must therefore produce a new revision with the prior forecast and edited source.
- If no forecast exists, a nonempty source field cannot be persisted by the current schema. Disable Save with a visible reason to load and select a published period, rather than claim to save a value that will be discarded.
- If a route or departure-time edit invalidates the saved forecast and no replacement was chosen, do not silently delete it while saving. Disable Save with a visible reason to select a new period or deliberately remove the old weather selection. A deliberate removal control is optional for this PR; if omitted, reselecting a period must restore Save availability.

Loading available periods only changes availability data; it must not silently remove the committed forecast. An explicit selection replaces the inherited forecast. Clearing the period selector must not silently delete committed weather. Continue to block Calculate while any effective editor inputs differ from the open saved revision. Refresh remains available only for a current calculated revision with a currently selected published period and no route, time, aircraft, or altitude edits.

## Action contract

For Save and Refresh, derive availability from the same effective state that each handler consumes. Disabled controls must show the specific reason. Handlers must recheck their preconditions because a programmatic event can bypass the disabled UI. While an async operation is pending, preserve the existing input lock and immediate status feedback.

Do not change the exact FAA LID/ICAO airport contract, weather provider contract, revision journal, calculation formulas, or local storage schema. Keep existing ability to create and save an input-only draft when no prior forecast or surface source exists.

## Acceptance tests

1. Reopen a saved forecast-bearing revision, change only the ICAO surface source, save, and assert that the new revision retains the original forecast and contains the new source.
2. Reopen a saved forecast-bearing revision, load periods without selecting one, save an unrelated allowed edit, and assert that the existing forecast remains.
3. Enter a source on a new draft with no forecast: Save is disabled with a visible explanation, and a dispatched click does not write a revision.
4. Invalidate a saved forecast by changing departure time, then verify that Save cannot silently drop the forecast; selecting an applicable published period restores availability.
5. Verify Calculate remains disabled for an unsaved source edit, and Refresh uses an explicitly selected published period and the edited source when its other guards pass.
6. Run the planner tests and the repository CI gate. Report any network-dependent audit skip honestly.
