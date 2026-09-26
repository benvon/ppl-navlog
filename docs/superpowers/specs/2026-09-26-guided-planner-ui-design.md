# Guided planner UI design

## Goal

Make the existing browser-local VFR study planner easy to follow: select or create an aircraft profile, enter a route, update the plan, then inspect the calculated navlog. Preserve the pilot-input persistence and calculation workflow while redesigning its presentation.

## Scope and constraints

The active page is rendered by `src/main.ts` and `src/ui/pilot-intent-planner.ts`. Older `renderApp.ts`, `planner.ts`, and `workspace-layout.ts` describe a prior workflow and are not the implementation target. This design changes presentation and interaction in the active planner, plus the input handling needed for the time control and TAS override.

The teaching disclaimer stays at the top. Pilot-entered values remain browser-local and autosave on field exit. `Update plan` remains the explicit action that fetches current context and calculates; opening a saved plan or reloading does not restore a prior calculation. No calculation formula, data source, storage migration, or export behavior changes are in scope. Merged issue #15 supplies the fuel model that this UI design must present accurately.

## Single-page stages

Use four ordered, semantic disclosure sections: **Aircraft**, **Route information**, **Calculate**, and **Calculated navlog**. Section headers show a short status summary. Only the active section is expanded by default; users may open or close any section manually. Manual expansion is respected during ordinary rerenders, and moving to a new workflow milestone changes the active section.

- With no selected valid aircraft profile, a new plan starts in Aircraft. With a profile, it starts in Route information.
- Opening a saved plan expands Route information and summarizes its selected aircraft in the collapsed Aircraft header.
- Completing profile selection or creation advances to Route information.
- Route input stays available even when incomplete. Calculate clearly shows why `Update plan` is unavailable. Successful `Update plan` expands Calculated navlog and collapses the other sections by default.
- Editing any input invalidates the current calculated result and activates the section containing that input. The navlog section then shows that a new update is needed rather than presenting stale results.
- A failed update leaves inputs intact, opens Calculate, and shows the failure there. Opening another plan or starting a new plan resets the stage as above.

The selected profile control is compact and aligned with its label. Profile creation lives inside Aircraft. Any profile editing or versioning behavior requires a separate decision. Saved-plan selection and New plan are compact controls at the start of the planner, visually separate from the four stages.

## Route information

Group related controls within Route information: plan identity and endpoints; departure date and time; checkpoints and per-leg cruise altitudes; plan-level fuel inputs and arrival target; and the optional departure METAR alternate. Optional or advanced groups may be nested disclosures. Do not hide ordinary required route fields behind an advanced label. Use concise guidance near the control it explains and a clear visual boundary between groups.

Fuel aboard before taxi/run-up, taxi/run-up fuel, and reserve fuel belong together as plan-level inputs. Profile usable capacity and fuel-flow values belong in Aircraft. The calculated navlog shows the post-taxi balance, fuel used and remaining through the route, estimated arrival balance, and reserve assessment. No fuel entry belongs in a leg editor. Keep usable capacity and fuel aboard visually and verbally distinct.

The departure-time picker accepts the browser's local date and time, constructs an explicit UTC value, and shows both representations together. The UTC value is directly editable; a valid UTC edit updates the displayed local equivalent. The UTC field displays its expected format in a persistent hint and an example, such as `2026-09-26T18:30` (year-month-day, `T`, 24-hour hour:minute; UTC). Its validation message repeats the expected format. Preserve incomplete or invalid raw UTC text as pilot input and show a field-level error rather than silently replacing it. Clarify the browser time-zone name or offset so a pilot can detect a wrong device zone. Daylight-saving conversion follows the selected date; nonexistent and ambiguous local wall times must have an explicit, predictable behavior specified in the implementation plan and tested. Do not silently reinterpret the pilot's entered UTC value.

A live clock near departure time shows current browser-local and UTC times on adjacent lines, with labels, date, and offset visible. It is informational and never overwrites departure time. Every navlog time reference remains UTC.

## TAS override exception

Each leg normally shows the selected aircraft's cruise TAS as a read-only default. An **Override TAS** action for that leg reveals a value and reason editor. It changes TAS used in the leg computation and therefore may change calculated fuel consumption, but it never exposes a leg fuel input. There is no separate acknowledgement checkbox. A valid active override is visibly labeled on the leg, appears in calculation provenance, and can be removed to restore the aircraft default. The reason remains required when an override is entered; existing stored override values and reasons must survive opening and editing a plan. Route changes that remove or remap legs continue to clear affected overrides with a visible notice.

## Visual and accessibility behavior

The page uses a readable content width, consistent spacing, compact profile and plan selectors, and control sizes suited to their purpose. Primary actions are visually distinct from secondary actions. At laptop and narrow widths, groups reflow without horizontal page overflow; the wide navlog itself may scroll within its own container.

Disclosure headers are keyboard operable and expose expanded state to assistive technology. Labels remain attached to controls, error messages identify the affected field, and focus moves predictably after stage changes or calculation failure. Autosave, result invalidation, loading, and calculation failure remain observable without relying on color alone. Collapsing a section must not discard raw input or override state.

## Acceptance scenarios

1. First visit without profiles: Aircraft opens; saving a valid profile selects it and opens Route information. The profile selector is compact.
2. Returning pilot: opening a saved plan opens Route information, shows the selected aircraft summary, preserves incomplete raw inputs, and requires a fresh `Update plan`.
3. Valid route: local picker builds the correct UTC date and time, the visible UTC example matches accepted input, direct UTC editing updates the local display, the clock shows both zones, and a successful update opens a navlog whose times are UTC.
4. Editing a calculated plan: the result disappears immediately, the edited section opens, input persists on blur, and a later update recalculates.
5. Override exception: the normal leg has no override fields or acknowledgement; activating the editor allows value and reason, displays the active override, and restoring the default removes it.
6. Invalid or unavailable inputs: the relevant control and Calculate section explain the block, and a failed external update preserves all pilot input.
7. Fuel: profile usable capacity and plan fuel aboard are distinct; fuel aboard, taxi/run-up, and reserve are grouped as plan inputs, while calculated consumption and remaining fuel appear only in the navlog.

## Fuel-model dependency

[GitHub issue #15](https://github.com/benvon/ppl-navlog/issues/15) is closed through merged PR #16. That change adds the distinct fuel-aboard input, capacity validation, running balances, arrival balance, and reserve assessment. The UI redesign should build on that contract without changing its calculations. The calling checkout may need to update to merged `main` before implementation; this draft was checked against the merged PR's fuel worktree because the current checkout had not fetched the merge.

## UI design decisions

- **Stage structure:** Use the four named sections above, including a separate Calculate section. The user approved this spec on 2026-09-26.
- **Stage transitions:** Open Route information after profile save, Calculate after failure, and the edited section after result invalidation, in addition to the saved-plan and successful-update transitions specified above.
- **Manual disclosure state:** Keep manually opened sections open during ordinary rerenders. On a workflow milestone, restore the one-active-section default.
- **Saved-plan behavior:** Keep the current first-saved-plan-on-load behavior and replace the saved-plan button list with compact controls.
- **Profile lifecycle:** Keep current profile creation and selection semantics; profile editing/versioning is outside this UI change.
- **UTC interaction:** Use the local-time picker, editable constructed UTC value, visible format hint, two-line clock, and UTC navlog references. Synchronize valid edits in both directions. Reject ambiguous or nonexistent local wall times with guidance to use direct UTC entry; place the clock adjacent to the time controls.
- **TAS exception:** Remove the acknowledgement checkbox and hide override controls until needed. Keep the current reason requirement, restore action, and route-change clearing behavior.
- **Visual/accessibility details:** Verify responsive widths, focus movement, validation presentation, and section summaries in a rendered interface.

## Validation

Add focused DOM behavior tests for stage transitions, persistence across disclosures, time conversion including a date boundary and DST edge, UTC navlog labels, TAS override reveal/restore, and error/failure states. Run typecheck, lint, relevant tests, build, and available repository security checks. Review the rendered desktop and narrow layouts with keyboard navigation and a screen reader pass before calling the UI complete.
