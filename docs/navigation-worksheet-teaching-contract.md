# Navigation worksheet teaching contract

Status: product decisions approved 2026-09-30 and implemented in PR #33. This supersedes the earlier waypoint-first contract. Production changes await PR integration and deployment.

## Purpose and reference

Help a student build and explain a navigation worksheet following FAA PHAK Chapter 16: chart the route, select recognizable checkpoints, determine course/distance, apply wind and heading corrections, then calculate groundspeed, time, and fuel. Success means the student can reproduce the arithmetic and understand how actual checkpoint observations test the estimates.

This is a teaching tool. Estimates do not predict an aircraft trajectory or establish an operational flight plan. The arithmetic does not replace chart, terrain, airspace, weather briefing, aircraft limitations, or arrival-procedure review.

Reference: [FAA PHAK Chapter 16](https://www.faa.gov/sites/faa.gov/files/18_phak_ch16.pdf), printed pp. 16-12–21, especially Figure 16-26. Specific TOC/TOD sampling rules below are simplifying product assumptions, not prescriptions attributed to the FAA.

## One cruise altitude

- Provide one route-level **Cruise altitude (feet MSL)** input and remove per-waypoint altitude controls.
- Assume stable cruise altitude between initial climb and final descent. Adding/removing checkpoints does not change this input.
- Remove intermediate altitude changes, generated transition-end points, and their compatibility/ordering rules and tests.
- Use aircraft profile climb/descent rates, TAS, and fuel rates. Keep the entered descent rate; a longer required descent distance moves TOD earlier. Do not automatically increase the rate.
- Preserve authored route, profile, fuel, and other inputs during the change.

A saved plan with one repeated altitude supplies that value. A saved plan with differing leg altitudes retains its original data and requires the student to choose one cruise altitude before calculation. Store the new choice separately from historical leg-altitude entries. Do not silently choose or discard a value.

## Real weather and rows

Keep the weather API. Select applicable winds aloft once at each student checkpoint, using its estimated UTC and applicable planning altitude. That wind supplies the outgoing row's WCA and groundspeed. Later selections do not rewrite completed rows. Forecasts are estimates, not observations of actual progress.

Each positive-length row calculates the course/distance, WCA, true/magnetic/compass heading, groundspeed, ETE, and fuel. Carry unrounded totals forward and round presentation. Apply climb performance before TOC, cruise between TOC and TOD, and descent after TOD.

Select aloft wind at TOC for the outgoing cruise row. Reuse destination cruise-altitude wind at TOD for the outgoing descent row. For this teaching exercise, require every authored pilot checkpoint to fall between estimated TOC and TOD, inclusive; checkpoints equal to either boundary within arithmetic roundoff are allowed. This is a worksheet constraint and does not imply that a checkpoint outside the estimated interval is physically wrong. The estimated interval may change when weather or aircraft performance inputs change. For allowed checkpoints, use the single cruise altitude for aloft selection without inventing a modeled crossing altitude.

For this teaching exercise, reject all authored checkpoints strictly before estimated TOC or strictly after estimated TOD, except positions equal to a boundary within arithmetic roundoff. After TOC/TOD placement, report every out-of-interval checkpoint by authored checkpoint number and name, with its before-TOC or after-TOD reason, and ask the student to remove or move it between the estimated boundaries. Do not alter the authored route. Do not request row weather or calculate rows after this validation fails. Coincident student/generated labels share time/fuel, suppress the zero-length row, and apply phase changes before the next positive row. Identify points by ordered route position: repeated coordinates must not snap a generated point to an earlier visit. Retain genuinely positive spacing.

## TOC estimate

Use departure METAR wind as the initial climb approximation. Label it as a surface observation assumed for the climb, not a forecast representative of the whole climb.

1. Altitude gain = cruise altitude minus departure field elevation.
2. Climb time = altitude gain divided by profile climb rate.
3. Calculate estimated climb groundspeed using climb TAS, departure wind, and departure route course.
4. Climb distance = groundspeed multiplied by time in hours.
5. Place TOC once that distance forward along the route.

## TOD estimate

Use one winds-aloft forecast at the single cruise altitude above the destination airport to estimate descent groundspeed. Treat that wind as constant for the descent placement estimate. Work backward along the ordered route from destination; do not iterate placement.

1. Altitude loss = cruise altitude minus destination **field elevation**.
2. Descent time = altitude loss divided by the entered profile descent rate.
3. Calculate descent groundspeed using descent TAS, the wind forecast at cruise altitude above the destination airport, and final route course.
4. Descent distance = groundspeed multiplied by time in hours.
5. Place TOD once that distance before destination. TOD before the final student checkpoint is not itself an error.

The destination coordinate at field elevation is an arithmetic endpoint, not a modeled traffic pattern or landing path. Explain that a tailwind increases descent distance at fixed rate, while vertical descent time remains unchanged.

Later checkpoint weather may change row ETE without moving TOC/TOD. Do not enforce modeled altitude agreement or adjust the descent rate to reconcile estimates.

Select the destination forecast using a preliminary arrival UTC: departure UTC plus total charted route distance divided by profile cruise TAS. This is a disclosed no-wind time estimate used once for forecast selection, not the worksheet's final ETA. Use the cruise-altitude wind for TOD placement rather than requesting wind at a midpoint descent altitude.

## Explanations, fuel, and errors

Preserve the existing UI/UX structure. Keep navlog route rows compact, showing the planned inputs and calculated results needed to read the worksheet. Present detailed calculation explanations in the existing **inspector below the route lines**, reached by selecting a value. Do not expand the rows with formulas, derivations, or lengthy teaching text. The single cruise-altitude input replaces the per-waypoint altitude inputs without a broader UI redesign.

The altitude column shows the single cruise-altitude assumption alongside the row's phase label. Worksheet rows do not store or display starting/ending altitude transitions. Explain the whole-phase altitude gain/loss and TOC/TOD placement in the inspector; do not invent checkpoint crossing altitudes.

Pre-1.0 calculated worksheets have no backward-compatibility guarantee. Only the current stable-cruise worksheet format is eligible for display and inspection. Discard unsupported calculated results from the usable view and ask the student to recalculate; do not infer missing TOC/TOD metadata or render historical altitude/endpoint formats. Preserve pilot-authored route inputs. This requires no snapshot migration or rewriting of authored data.

In the inspector, show inputs, units, formulas, intermediate steps, and assumptions for each calculated value. Retain the existing source → aircraft push → steering correction explanation. Keep technical weather provenance in disclosure. Show estimates and explain comparison with actual checkpoint observations; a live in-flight tracking system is outside scope.

Label generated TOC/TOD points as estimated, including points coincident with authored checkpoints; preserve authored checkpoint names. The normal walkthrough uses rounded intermediate estimates to one decimal and explains that rounded arithmetic may differ slightly from the displayed result. Keep unrounded selected values and complete traces in the collapsed technical disclosure. Weather status describes checks of the selected inputs, rather than implying a complete weather briefing.

Printing is deferred to separate work.

Persist pilot-entered inputs, not calculated worksheets. The current result and its inspector evidence are disposable in-memory state; input edits invalidate them, and reopening a plan requires Update navlog to obtain a fresh result. An input-only save contains no calculation snapshot or pending-calculation placeholder. Stored calculation/weather revision history has no product purpose and is to be retired with the inactive planner in issue #30.

Deduct entered taxi/run-up fuel before airborne rows. Compare signed estimated arrival fuel with entered reserve. Zero is exhausted; a shortage remains visible alongside valid calculations.

Show the fuel exhaustion deficit separately from the reserve shortfall. For estimated arrival fuel of −2 gallons and an entered reserve of 3 gallons, show 2 gallons short of completing the route and 5 gallons short of completing it with reserve. Preserve signed balances and the worksheet so the student can inspect fuel consumption.

Validate aircraft profiles through one shared validator before weather retrieval or calculator execution. Reject malformed current-format profiles with actionable errors, including empty or duplicate-heading compass-deviation tables, invalid types, and nonfinite or invalid performance values. Profile format validation belongs at the input boundary; calculators retain arithmetic and cross-input checks. Unsupported stored profile formats are discarded without migration, with a brief notice to recreate or select a valid profile. Preserve route and other authored inputs while clearing unusable profile selections and attachments.

Validate required authored inputs before weather requests. Report invalid rates/coordinates, impossible wind triangles, missing required weather, and TOC/TOD that cannot fit in route order with actionable errors. Do not fabricate fallback weather or impose intermediate-transition/minimum-cruise-time requirements.

## Acceptance and follow-up

- One cruise-altitude control survives adding/removing checkpoints.
- Navlog rows remain compact; selecting a calculated value presents its explanation in the inspector below the route lines, preserving the existing interaction and page structure.
- Climb/descent rows show the cruise-altitude assumption without repeating whole-phase altitude endpoints as individual row transitions.
- Ordinary exercise demonstrates the complete heading/time/fuel chain.
- Tailwind exercise increases descent distance without changing descent time at fixed profile rate.
- Every authored checkpoint falls within the estimated TOC-to-TOD interval, with either exact/tolerance-equal boundary allowed.
- All checkpoints outside the interval are reported together, and row weather selection stops after the placement weather requests.
- Coincident labels do not duplicate time/fuel; repeated coordinates retain route occurrence.
- Invalid input fails before weather; unavailable weather and fuel shortfall remain explicit.
- Saved authored altitude data is preserved through migration.

[Issue #34](https://github.com/benvon/ppl-navlog/issues/34) separately adds authoritative learning sources at the bottom of the page.

PR #33 implements this contract for issue #28. Broader retirement of legacy calculation engines remains issue #30. Preserve this contract when reassessing older review findings; retain necessary corrections for row input selection, route identity, validation, and arithmetic.
