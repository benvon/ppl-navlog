# Waypoint-first navlog behavioral contract (superseded)

Superseded on 2026-09-30 by [Navigation worksheet teaching contract](navigation-worksheet-teaching-contract.md). Retained as historical context for PR #33. Its intermediate altitude transitions, pattern-altitude endpoint, and final-checkpoint-based TOD rules are no longer current requirements.

Status: **proposed for review** under [issue #26](https://github.com/benvon/ppl-navlog/issues/26). This document records agreed behavior and calls out choices that still need product approval. It supersedes conflicting calculation behavior in the older implementation plan only after approval and implementation; no calculation code changes in this issue.

## Purpose and limits

The navlog is a sequential planning worksheet for a pilot-selected VFR route. It estimates headings, groundspeed, elapsed time, and fuel at identifiable checkpoints. The pilot compares those estimates with observed progress and revises the plan in flight. It does not predict the exact aircraft trajectory, crossing altitude, or arrival instant, and it does not replace a weather briefing, chart/airspace/terrain review, alternatives assessment, or aircraft performance check.

The reference is FAA *Pilot's Handbook of Aeronautical Knowledge*, Chapter 16, printed pp. 16-12–21, especially “Flight Planning,” “Charting the Course,” “Dead Reckoning,” “Pilotage,” and Figure 16-26. The chapter's flight log separates estimates from actual observations and treats checkpoints as aids to correcting dead-reckoning estimates.

## Confirmed product rules

1. The route is an ordered series of departure, pilot-selected checkpoints, and destination. Estimate top of climb (TOC), top of descent (TOD), and the end of any pilot-selected altitude transition once when their required planning inputs are available. Insert them as generated waypoints; thereafter calculate their rows through the same waypoint interface as pilot-selected checkpoints. TOD need not be known before the earlier rows are calculated.
2. Start with pilot-entered departure UTC, fuel aboard, route, aircraft profile, and planning inputs. Deduct pilot-entered taxi/run-up fuel before the airborne row sequence. Do not add an implicit regulatory reserve.
3. A row represents travel from one ordered waypoint to the next. Establish the next waypoint before calculating that row. In particular, estimate and insert TOD **before calculating the last cruise row that reaches it**; split that row at TOD. Then use the starting waypoint, starting estimated UTC and fuel balance, applicable wind, course/distance, TAS, fuel rate, variation, and deviation to calculate heading, groundspeed, estimated leg time and fuel. Record ending UTC and fuel balance at the next waypoint. Carry unrounded arithmetic to the following row; round only presentation.
4. The estimated UTC at a waypoint may be used to request/select applicable forecast data. Weather selected at a waypoint supplies the following row. Later weather never rewrites a completed row. The UTC and generated coordinates are planning estimates, not claims that the aircraft will occupy an exact position at an exact instant.
5. TOC/TOD placement is an estimate made when its inputs are available. Do not iterate a trajectory to force modeled altitude agreement. No 50 ft checkpoint tolerance or similarly precise crossing requirement may determine whether a waypoint row exists.
6. Strongly advise the pilot to choose recognizable checkpoints expected after TOC and before TOD, while showing a checkpoint near or outside those estimated boundaries rather than rejecting it solely for that placement.
7. Keep one authoritative production path from “Update navlog” through weather evidence to the worksheet result. Preserve user-authored plan/profile/fuel data. Fetched weather and calculation output are replaceable session results.

## Proposed row and waypoint contract

The row sequence is departure → any pilot checkpoints and generated points in route order → destination. Distances follow the pilot's ordered route polyline, accumulated from each source leg's charted endpoint distance. A generated distance is located on that polyline and splits its containing leg; the resulting nonzero legs receive their own course and distance from their endpoints. TOC is estimated from departure inputs. An altitude change selected for the leg leaving a pilot checkpoint starts there and has an estimated transition-end waypoint. TOD is estimated when the starting state and wind of its containing cruise leg are known, **before that leg is calculated**, and inserted as that leg's next waypoint. Earlier completed rows provide the starting state but are never revised. Every point has a stable source identity, route distance, coordinate, and kind (`departure`, `pilot-checkpoint`, `estimated-toc`, `estimated-transition-end`, `estimated-tod`, or `destination`). A generated point retains the assumptions used to place it. A pilot point retains its authored name and coordinates. Keep pilot and generated labels distinct when their estimated route positions coincide. Suppress only a mathematically zero-length leg between them; do not merge nearby nonzero legs merely because their displayed distances round to the same value. A coincident group has one carried UTC/fuel state, and no fuel/time is charged for a suppressed leg. Select weather once at the shared position/UTC. Apply all boundary effects before the next nonzero row: after TOC or transition-end, use the new cruise target/rate; after TOD, use descent inputs. If the shared position is also a pilot checkpoint, retain its label and outbound altitude selection. At a TOD/checkpoint coincidence, TOD descent inputs take precedence over a conflicting outbound altitude selection; otherwise the checkpoint's outbound altitude selection applies to the next nonzero row.

Each row has starting state `{estimated UTC, fuel balance}`, leg inputs `{start/end, distance, true course, planned altitude or phase, TAS, fuel flow, selected wind, variation, deviation}`, calculation `{wind correction, true/magnetic/compass heading, groundspeed, ETE, fuel}`, and ending state `{estimated UTC, fuel balance}`. The row carries provenance and warnings. Source positions and weather are inputs; calculated position is never fed back as a simulated aircraft state.

Fuel remaining may be negative as an estimated deficit, never as fuel available. Compare estimated arrival fuel with the pilot-entered reserve. Zero fuel is exhausted even if reserve is zero. A shortage is conspicuous but does not erase valid route calculations.

## Proposed TOC/TOD placement and weather handoff

- Compute an approximate climb duration from the selected altitude difference and profile climb rate; use climb TAS and the departure planning wind to estimate climb groundspeed and distance along the charted route. Place TOC once. For a pilot checkpoint before estimated TOC, keep the checkpoint and calculate its inbound and outbound rows with climb assumptions. Ignore any outbound altitude selection at that checkpoint and show a nonblocking incompatibility warning; do not create a transition there or demand a computed crossing altitude.
- When the pilot selects a different altitude for an outbound leg, start that estimated climb/descent transition at its origin checkpoint. Until its estimated end, the row uses the applicable climb/descent TAS and fuel flow; after that point, rows use the newly selected cruise altitude, TAS, and fuel flow. Use the chosen altitude difference, profile rate/TAS, and weather selected at that checkpoint to place one estimated transition-end waypoint. Calculate the transition row through the common interface. Do not interpolate/check modeled aircraft altitude at intervening checkpoints; if a transition conflicts with the next checkpoint or TOD, report a meaningful route-geometry problem for review.
- Compute an approximate descent duration from final cruise altitude to the selected airport pattern altitude and the profile descent rate. At the start of the cruise leg expected to contain TOD, its starting waypoint already has an estimated UTC, fuel balance, and eligible planning wind from earlier rows. Use descent TAS, that wind, and the final charted course to estimate one descent distance. Set TOD's cumulative route distance to total route distance minus estimated descent distance, then locate it in forward route order. Do not walk or recalculate completed rows backward. If TOD falls before the current final pilot-selected waypoint, stop before calculating that waypoint's next row or requesting TOD weather. Say, for example, “TOD is calculated to be before final waypoint [name] (estimated TOD at route NM 48; waypoint at NM 50). Review the waypoint position, selected cruise altitude, descent performance, or route.” Place TOD **before calculating the cruise leg**. Calculate only the starting waypoint → TOD cruise row with the starting waypoint's wind; its result supplies TOD's estimated UTC and fuel balance. Request/select TOD weather at that UTC for the outbound descent row. Do not move TOD in response to that later weather. The forecast used for placement and the TOD-row forecast may differ; disclose that assumption.
- Apply distinct climb, cruise, and descent TAS/fuel rates to rows in those portions of the ordered route. These rates are planning inputs, not an altitude simulation. A pilot checkpoint inside the estimated climb or descent portion stays visible, with a guidance note.
- Check that ordered TOC and TOD fit the selected route. Invalid/nonpositive rates, impossible wind triangles, missing required weather, and geometry that cannot order TOC before TOD are explicit blocking results. A transition that cannot finish before the next pilot checkpoint or before TOD also blocks. Each geometry error identifies the affected leg/waypoints and the estimated distances, then gives basic ways to revise the plan: choose a lower or more reachable altitude, revise performance assumptions, move/select a later checkpoint, or revise the route. Close but positive spacing is an estimate and should not trigger an artificial minimum-cruise-time rule.

The descent calculation ends at the destination airport coordinate at the pilot-selected pattern altitude. This is a planning endpoint, not a claim that the aircraft will be at pattern altitude over the airport or a model of traffic-pattern maneuvers or runway arrival.

## Display and explanation

Show the ordered waypoint names/kinds, charted leg distance/course, planned altitude or phase, selected wind, heading chain, groundspeed, leg and cumulative estimated time, leg fuel, and estimated fuel remaining. Label TOC/TOD positions and all times/fuel as estimates. Use whole degrees/knots/minutes and sensible distance/fuel rounding in the main log; a sub-minute leg may be shown as “<1 min” rather than as an exact seconds claim. Keep unrounded numbers for correct accumulation and raw technical inspection, not as evidence of forecast precision. The inspector should retain the source → aircraft push → steering correction explanation and the full calculation chain.

## Worked example A: ordinary route

Illustrative assumptions only, not operational data: straight 60 NM route, no wind or variation/deviation, initial UTC 14:00, fuel aboard 20.0 gal, taxi/run-up 0.5 gal, reserve 3.0 gal. Departure is 2,000 ft MSL, selected cruise is 5,000 ft MSL, and selected airport pattern altitude is 1,000 ft MSL. Climb uses 500 ft/min, TAS/GS 60 kt, and 10 GPH. Its 3,000 ft change takes 6 min, covering 6 NM, so TOC is at route NM 6. Descent uses 500 ft/min, TAS/GS 90 kt, and 6 GPH. Its 4,000 ft change takes 8 min, covering 12 NM; route total 60 NM minus 12 NM places TOD at NM 48. Cruise GS is 120 kt and fuel flow is 8 GPH. Pilot checkpoints are at 20 and 40 NM. All table values follow from these synthetic assumptions.

| From → to | Leg NM | GS kt | Leg min | Leg gal | Ending UTC | Estimated fuel remaining gal |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| Departure → TOC | 6 | 60 | 6 | 1.000 | 14:06 | 18.500 |
| TOC → checkpoint 1 | 14 | 120 | 7 | 0.933 | 14:13 | 17.567 |
| Checkpoint 1 → checkpoint 2 | 20 | 120 | 10 | 1.333 | 14:23 | 16.233 |
| Checkpoint 2 → TOD | 8 | 120 | 4 | 0.533 | 14:27 | 15.700 |
| TOD → destination | 12 | 90 | 8 | 0.800 | 14:35 | 14.900 |

The initial airborne balance is 19.5 gal after taxi/run-up. Total airborne ETE is 35 min, airborne fuel is 4.6 gal, and the estimated arrival balance is 14.9 gal, above the entered 3.0 gal reserve. Checkpoints, TOC, and TOD are all rows in the same progression.

In this example, checkpoint 2's carried state is 14:23 and 16.233 gal. Its selected wind and the 12 NM descent estimate locate TOD at route NM 48 **before** calculating the cruise row that begins at checkpoint 2. That row therefore covers only NM 40 → 48 and produces TOD's 14:27 and 15.700 gal state. TOD weather is then selected for the descent row; it cannot move the already placed TOD or change NM 40 → 48.

## Worked example B: short cruise and fuel shortfall

Illustrative assumptions only: straight 24 NM route, no wind or variation/deviation, initial UTC 16:00, fuel aboard 3.0 gal, taxi/run-up 0.5 gal, reserve 1.0 gal. The same 2,000 → 5,000 ft climb at 500 ft/min and 60 kt places TOC at 6 NM. The same 5,000 → 1,000 ft descent at 500 ft/min and 90 kt needs 12 NM, placing TOD at route NM 12. A recognizable pilot checkpoint is at 9 NM. Rates and speeds match example A. The 6 NM estimated cruise interval is short but positive; it is not collapsed or rejected because of a one-minute threshold.

| From → to | Leg NM | GS kt | Leg min | Leg gal | Ending UTC | Estimated fuel remaining gal |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| Departure → TOC | 6 | 60 | 6 | 1.000 | 16:06 | 1.500 |
| TOC → checkpoint | 3 | 120 | 1.5 | 0.200 | 16:07:30 | 1.300 |
| Checkpoint → TOD | 3 | 120 | 1.5 | 0.200 | 16:09 | 1.100 |
| TOD → destination | 12 | 90 | 8 | 0.800 | 16:17 | 0.300 |

The arrival estimate is 0.3 gal, below the pilot-entered 1.0 gal reserve. The log remains calculated and clearly marks the shortfall. The `16:07:30` value illustrates unrounded carry-forward; normal presentation should avoid implying a 30-second forecast accuracy. With the same assumptions on a 14 NM route, TOC at 6 NM and TOD at 2 NM cannot be ordered. Stop with feedback such as: “Estimated TOC is near route NM 6, after estimated TOD near NM 2 on this 14 NM route. Review the selected cruise altitude, climb/descent performance, or route before updating the navlog.” Do not invent a cruise/trajectory or drop TOC/TOD.

An additional transition acceptance case uses an 80 NM route with TOC near NM 6. At a pilot checkpoint at NM 30, an outbound change from 5,000 to 6,000 ft at 500 ft/min and 60 kt under no wind creates a 2 min, 2 NM transition row ending at a generated point near NM 32. The next pilot checkpoint is at NM 50; an outbound change back to 5,000 ft at 500 ft/min and 90 kt creates a 2 min, 3 NM transition row ending near NM 53. The following nonzero rows use each newly selected cruise altitude. A TOD estimate must be checked against those generated points. No checkpoint is tested against a simulated crossing altitude.

## Failure and uncertainty rules

- Missing or stale required weather, invalid forecast response, or a wind triangle without positive usable groundspeed: block the affected calculation and explain the source/leg. Do not invent a fallback forecast.
- Invalid aircraft or fuel inputs: block before weather retrieval where possible. Fuel shortage after valid arithmetic is a calculated warning, not an input error.
- Approximate TOC/TOD overlap, impossible ordering, or a transition that cannot fit before the next checkpoint/TOD: block the complete worksheet. Name the affected points and estimated distances and suggest which pilot inputs or route geometry to review. A checkpoint merely near either estimated point receives advice, not a precision-based block.
- When arithmetic for an estimated boundary differs from a known route waypoint by floating-point roundoff alone, use that waypoint's exact route distance and coordinate. This is a numerical consistency rule, not a planning tolerance: retain genuinely positive spacing between distinct waypoints.
- When a point forecast at TOD is requested after the inbound row, it supplies only the outbound descent row. The inbound row keeps the preceding waypoint's wind, UTC, and fuel calculation.
- Forecasts, rates, TAS, route coordinates, pilot-selected altitudes, and actual aircraft control introduce uncertainty that arithmetic cannot remove. The pilot must compare actual checkpoints and fuel with the plan and revise as conditions change.

## Review gate

The product choices raised during drafting are resolved: intermediate altitude changes use estimated transition-end waypoints; the descent planning endpoint is the destination airport coordinate at selected pattern altitude; coincident pilot/generated points keep both labels and suppress only the zero-length leg. Review the complete contract and worked examples before implementation issues change behavior.
