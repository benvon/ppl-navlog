# Waypoint altitude, TOC, and TOD contract

## Confirmed behavior

- A pilot-entered leg altitude is the required altitude **at its named endpoint checkpoint**. It is not an altitude that must hold across the whole incoming leg. The final leg's entered altitude is instead the cruise target reached before TOD. The existing ordered leg data and saved pilot values remain intact; the labels and calculation interpretation change together.
- From departure, use the aircraft climb rate, climb TAS, climb fuel flow, and calculated wind/groundspeed until the first named waypoint altitude is reached. Insert a top-of-climb (TOC) event and navlog row boundary at the actual crossing. If the crossing is after that waypoint, the route is infeasible rather than treating the waypoint target as met.
- For later checkpoints, reach each entered target altitude at its waypoint. A climb or descent may begin before that waypoint. The final leg's cruise target must be reached before TOD. Calculate time and fuel for each vertical and level interval, carrying unrounded state forward.
- Reach the pilot's arrival descent target (default: airport elevation plus 1,000 ft MSL) at a point **3 NM before the destination**. Insert a top-of-descent (TOD) event and end the calculated navlog at the 3 NM point. The final 3 NM and traffic-pattern operations are outside this navlog.
- A direct departure-to-destination plan may contain both generated TOC and TOD events. If the available distance to the 3 NM endpoint cannot accommodate both vertical phases, report the overlap or infeasibility clearly and do not invent level distance.
- Every calculated row uses the applicable aircraft phase TAS and fuel flow, a wind-derived groundspeed, elapsed time, and fuel. Generated events expose their cumulative time, distance, altitude, and fuel in the navlog. The route's original waypoints remain pilot-authored data; generated events are ephemeral results.

## Root cause and affected contracts

Before this change, the progressive engine in `src/application/route-weather-sampling.ts` placed TOD at a fixed distance based on descent TAS without wind, then calculated the descent with wind and required exact target altitude at the airport. That mismatch could produce the reported error. It also allowed an unfinished climb to pass a checkpoint whose entered altitude was intended at that point. The visible navlog labeled generated sublegs only by their source pilot leg endpoints.

## Planning rules and limits

- Preserve the progressive weather rule: each completed interval uses weather available at its starting event; later point answers do not revise it. Fetch at generated TOC/TOD as needed. Use bounded calculations and fail when weather or performance cannot support a result.
- For TOD placement, use a bounded estimate consistent with descent groundspeed and the 3 NM endpoint. Candidate weather requests may be needed to reconcile wind at TOD with that estimate; do not revise already finalized rows or silently invent a descent. Do not claim exact future wind or flight performance. Display calculated timing/fuel as planning estimates.
- If a descent would cross a pilot checkpoint before the 3 NM endpoint, block with a clear explanation. The current progressive weather model cannot use that checkpoint's later wind to place an earlier TOD while preserving completed rows and the checkpoint altitude requirement.
- No runway, pattern maneuver, final 3 NM time/fuel, or terrain clearance model is added here.
- Existing saved altitude numbers remain unchanged. The new endpoint interpretation applies when recalculating them; make the changed meaning visible in the editor.

## Worked planning cases

On a direct 60 NM route with a 1,000 ft departure elevation, 4,500 ft selected cruise altitude, 2,000 ft pattern target, 500 ft/min climb and descent, and a simplified 90 kt groundspeed in both vertical phases: climb takes 7 min and 10.5 NM; descent takes 5 min and 7.5 NM. TOC is at 10.5 NM, TOD is at 49.5 NM, and the navlog ends at 57 NM. The actual plan uses its resolved wind for each phase's groundspeed and fuel, so these simple distances are illustrative.

On a direct 15 NM route with the same vertical demands, only 12 NM are available before the 3 NM endpoint. Climb plus descent need 18 NM at the illustrative groundspeed. The plan stops as infeasible rather than producing a cruise row or carrying descent into the final 3 NM.

## Acceptance checks

1. A normal multi-leg route shows the entered altitude at each checkpoint, reaches the final cruise target before TOD, shows TOC and TOD in route order, and ends at pattern altitude 3 NM short of the airport.
2. A direct route shows TOC and TOD when both fit; cumulative ETE and fuel include climb and descent phase performance.
3. A climb that cannot reach its named waypoint target and a route where vertical phases overlap fail clearly.
4. A headwind or tailwind during descent does not cause a false exact-airport-target error; TOD timing and placement are consistent with the descent calculation and 3 NM endpoint.
5. Navlog labels identify generated TOC/TOD, and the final row clearly identifies the 3 NM pattern-altitude endpoint.
6. Existing pilot-entered values survive recalculation. Relevant tests, typecheck, lint, build, and security checks pass or limitations are reported.
