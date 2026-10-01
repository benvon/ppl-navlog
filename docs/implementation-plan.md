# Navigation Worksheet Implementation Plan

**Current baseline:** the approved [navigation worksheet teaching contract](navigation-worksheet-teaching-contract.md), together with the [saved-input and weather-refresh contract](revisions-and-weather-refresh.md), governs this plan. This document replaces earlier implementation requirements for per-waypoint altitudes, immutable calculation revisions, input or snapshot migration, and printable output. PR #33 implements the worksheet direction for issue #28; production promotion and deployment remain separate operational steps.

## 1. Product goal

Help a student build and explain a VFR navigation worksheet using the arithmetic and learning sequence in FAA Pilot's Handbook of Aeronautical Knowledge Chapter 16. The student should be able to trace course and distance through wind correction, headings, groundspeed, time, and fuel, then compare estimates with actual checkpoint observations.

This is a teaching aid. Estimates do not model an aircraft trajectory or replace chart, terrain, airspace, weather briefing, aircraft-limit, or arrival-procedure review. The FAA reference is [PHAK Chapter 16](https://www.faa.gov/sites/faa.gov/files/18_phak_ch16.pdf), printed pages 16-12–21, especially Figure 16-26. The TOC/TOD weather rules below are product assumptions, not FAA-prescribed methods.

## 2. Approved behavior

### Route and altitude

- Provide one route-level cruise altitude in feet MSL. Removing or adding checkpoints does not change it.
- Keep authored route order and pilot inputs. Remove per-leg altitude editing and intermediate altitude transitions from the current worksheet.
- Use the selected aircraft profile's TAS, climb/descent rates, and fuel rates. Use the entered descent rate; a longer descent distance moves TOD earlier rather than increasing the rate.
- Place generated TOC and TOD by ordered route distance. Preserve route occurrence when coordinates repeat. Coincident authored/generated labels share carried time and fuel and do not create a zero-length row.
- Require every authored checkpoint to lie between estimated TOC and TOD, inclusive with arithmetic-roundoff tolerance. After placement, report all violating checkpoint numbers, names, and reasons together. Stop before checkpoint-row weather requests and leave the authored route unchanged.

### Weather and estimates

- Keep the weather API and retrieve only data needed by the worksheet.
- Use departure METAR wind as the disclosed initial-climb approximation for TOC placement. Compute climb time from altitude gain and profile climb rate, then climb groundspeed and distance.
- Use one winds-aloft forecast at cruise altitude above the destination to estimate TOD, descending to destination field elevation. Select it using departure UTC plus charted route distance divided by cruise TAS as a preliminary, no-wind arrival estimate. Place TOD once by working backward; do not iterate or change the entered descent rate.
- At TOC, select aloft wind for the outgoing cruise row. At each allowed authored checkpoint, select wind for its outgoing row at the single cruise altitude. Reuse the destination cruise-altitude placement wind at TOD for the outgoing descent row. Completed rows do not change when later weather is selected.
- Use climb performance before TOC, cruise between TOC and TOD, and descent after TOD. Carry unrounded time and fuel totals forward; round only for display.
- Show estimates and weather-check status accurately. Forecasts are not observations or a complete preflight briefing.

### Worksheet and teaching interface

- Keep navlog rows compact and show the planned inputs and calculated values needed to read the worksheet.
- Keep the existing page structure and value-selection interaction. Show the selected value's inputs, units, formula, intermediate steps, and assumptions in the inspector below the route lines. Keep raw weather and technical provenance collapsed.
- Show the cruise-altitude assumption with the row phase; do not display invented row altitude transitions or checkpoint crossing altitudes. Explain whole-phase altitude change and TOC/TOD placement in the inspector.
- Explain wind as source → aircraft push → steering correction.
- Label generated TOC/TOD as estimated, including coincident labels, while preserving authored checkpoint names.
- Retain the signed estimated arrival fuel balance. A shortage does not invalidate otherwise valid calculations. Show route-completion fuel deficit separately from reserve shortfall; zero fuel is exhausted.

### Inputs, persistence, and calculation lifecycle

- Save only the latest pilot inputs per plan and current validated aircraft profiles. Preserve literal input text, including incomplete or invalid entries, and authored route order.
- Keep calculations, weather responses, and inspector evidence transient. Input edits invalidate the displayed result. Reopening a plan or reloading requires **Update navlog** to fetch weather and calculate again.
- Saving inputs does not fetch weather or calculate. **Update navlog** is unavailable during an input save or plan switch. Once editing is ready, it saves the current inputs and selected profile snapshot, stops if that save fails, validates required inputs and the profile before weather retrieval, then calculates. Retrieval or calculation failures leave pilot inputs saved and show an actionable error.
- The plan state manager owns save/switch transitions and Update readiness. It must prevent Update from racing an in-progress save or accepted plan switch, and keep the visible plan and its inputs aligned.
- Support only the current plan input schema. Discard an unsupported stored format and show a brief notice to create a new plan. Reject malformed data that claims the current format with a useful error; do not silently repair it or migrate it.
- Validate current aircraft profiles through the shared validator before network or calculator work. Unsupported stored profile formats are discarded with a notice to recreate or select a valid profile; preserve other authored inputs.
- Validate required route, rate, coordinate, wind, and profile inputs before dependent work. Report unavailable weather, impossible wind triangles, invalid TOC/TOD ordering, and other calculation failures clearly. Do not invent fallback weather or impose a minimum cruise duration.

## 3. Acceptance criteria

The implementation is acceptable when all of the following observable behavior holds:

1. One cruise-altitude input remains stable when checkpoints are added or removed; no intermediate altitude transitions are produced.
2. An ordinary worksheet exposes the complete course, wind, heading, groundspeed, time, and fuel chain through compact rows and the below-route inspector.
3. TOC uses departure METAR wind as a labeled climb approximation. TOD uses the destination cruise-altitude forecast and destination field elevation. At a fixed descent rate, a tailwind increases descent distance without changing vertical descent time.
4. Every authored checkpoint is checked against the inclusive estimated TOC–TOD interval after placement. All out-of-interval checkpoints are reported together, and no checkpoint-row weather is requested after that failure.
5. Coincident labels share state without a zero-length row; repeated coordinates retain the correct ordered route occurrence.
6. Weather selections supply only their outgoing rows. A later selection never rewrites a completed row or changes a previously placed TOC/TOD.
7. Selected values expose understandable formulas, units, inputs, assumptions, and intermediate steps. Raw source provenance remains available in the technical disclosure.
8. Invalid required inputs and invalid profiles stop before weather retrieval. Failed saves stop Update; weather or calculation failures preserve saved pilot inputs and clear stale results.
9. Update readiness follows plan-state save and switch transitions. Unsupported stored formats produce the create-new-plan notice; malformed current-format plans are rejected.
10. Fuel balances remain signed. Route-completion deficit and reserve shortfall are independently understandable, including when calculations otherwise succeed.

The detailed examples and edge conditions in the teaching contract remain authoritative. Acceptance does not imply a production deployment or completion of separately tracked work.

## 4. Delivery status and remaining slices

### Implemented baseline

PR #33 implements the issue #28 worksheet direction: stable cruise altitude, estimated TOC/TOD placement, checkpoint weather and inclusive interval validation, compact rows with the below-route inspector, disposable calculations, current profile validation, and signed fuel-shortage reporting. The current repository also contains the plan-state save/switch lifecycle and associated readiness behavior. These are the working baseline; do not reintroduce superseded behaviors while addressing follow-ups.

### Issue #34: authoritative learning sources

Add authoritative learning-source references at the bottom of the page. Keep sources distinct from the per-value calculation inspector. Acceptance: the source list is visible at the page bottom, links to authoritative materials, and does not expand worksheet rows or alter calculations.

### Calculator retirement

Issue #30 completes the removal of competing engines, old weather resolvers, phase models, and journal/forecast-selector types. The planner consumes the finalized sequential worksheet and its in-memory evidence directly. See [the sole calculation path](worksheet-calculation.md) and [issue #30 implementation plan](issue-30/implementation-plan.md). Shared wind interpolation, course, headings, time/fuel, magnetic variation, and current input validation remain covered.

### Release and operations

Production promotion is separate from implementation. Before describing the worksheet as live, verify deployment state and smoke-test the configured production domains. A local build or deployment dry run alone is not evidence of a live release.

## 5. Scope boundaries

- Printing and PDF output are deferred; they are not acceptance criteria for the current worksheet.
- Plan and profile import/export, cloud synchronization, accounts, and revision/history systems are outside this plan.
- Do not preserve unsupported stored plan formats through migration. Preserve current authored inputs when clearing an unsupported profile or calculation result.
- Do not add route simulation, modeled checkpoint crossing altitudes, altitude-transition allocation, or automatic descent-rate adjustment.
- Do not modify the `runway-picker` service as part of worksheet work.

## 6. Change and review rules

- Treat the teaching contract and saved-input contract as the source of truth when older design notes or legacy code conflict.
- For changes to calculation behavior, state the student decision supported, inputs used, uncertainty retained, and failure behavior before implementation. Include an ordinary and boundary case in the change review.
- Keep changes purpose-focused. Preserve unrelated authored inputs and working-tree changes.
- Review the complete user-visible worksheet and inspector flow, not just isolated calculation helpers. Run the relevant repository quality gates for implementation changes and report anything unavailable or inconclusive.
- Do not label implementation complete, deployed, or production verified without current evidence for that exact claim.
