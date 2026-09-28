# Waypoint altitude, TOC, and TOD contract

## Confirmed behavior

- A pilot-entered leg altitude is the required altitude **at its named endpoint checkpoint**. It is not an altitude that must hold across the whole incoming leg. The final leg's entered altitude is instead the cruise target reached before TOD. The existing ordered leg data and saved pilot values remain intact; the labels and calculation interpretation change together.
- Checkpoint and airport pattern-altitude targets are accepted within 50 ft. From departure, use the aircraft climb rate, climb TAS, climb fuel flow, and estimated wind/groundspeed toward the first named waypoint altitude. If the departure climb reaches the first target within 50 ft at that checkpoint, place TOC at the checkpoint; otherwise the route is infeasible. When a checkpoint target is accepted within 50 ft during a climb or a transition that is allowed to end at that checkpoint, end that phase there and preserve the actual estimated altitude; do not force an exact target or carry the phase past the accepted checkpoint.
- For later checkpoints, a climb or descent may begin before the checkpoint, but must end there when the entered target is reached within 50 ft. If it cannot reach the target within tolerance, the route is infeasible. The final leg's cruise target must be reached before TOD. Calculate time and fuel for each vertical and level interval, carrying unrounded state forward.
- Reach the pilot's arrival descent target (default: airport elevation plus 1,000 ft MSL) at the destination airport. The calculated navlog ends at the airport at that pattern altitude; no fixed distance before the airport is omitted.
- Accept the calculated airport altitude when it is within 50 ft of the configured target. A larger difference is an infeasible descent and must be reported clearly.
- A direct departure-to-destination plan may contain both generated TOC and TOD events. If the available distance to the airport cannot accommodate both vertical phases, report the overlap or infeasibility clearly and do not invent level distance.
- Every calculated row uses the applicable aircraft phase TAS and fuel flow, a wind-derived groundspeed, elapsed time, and fuel. Generated events expose their cumulative time, distance, altitude, and fuel in the navlog. The route's original waypoints remain pilot-authored data; generated events are ephemeral results.

## Root cause and affected contracts

Before this change, the progressive engine in `src/application/route-weather-sampling.ts` placed TOD at a fixed distance based on descent TAS without wind, then calculated the descent with wind and required exact target altitude at the airport. That mismatch could produce the reported error. It also allowed an unfinished climb to pass a checkpoint whose entered altitude was intended at that point. The visible navlog labeled generated sublegs only by their source pilot leg endpoints.

## Planning rules and limits

- Preserve the progressive weather rule: each completed interval uses weather available at its starting event; later point answers do not revise it. Fetch at generated TOC/TOD as needed. Use bounded calculations and fail when weather or performance cannot support a result.
- Forecast wind, aircraft performance, and fuel consumption are estimates. The navlog supports heading and fuel-sufficiency decisions; it does not establish exact future conditions.
- For TOD placement, use a bounded estimate consistent with descent groundspeed and the airport endpoint. Reconcile candidate TOD wind and location before evaluating overlap. Do not revise already finalized rows or silently invent a descent. Under the progressive weather rule, block if the reconciled descent would cross any pilot checkpoint before reaching the airport, even if the target altitude would be within 50 ft there.
- Display headings to the nearest whole degree, altitude to 100 ft, wind and groundspeed speeds to whole knots, distance to 0.1 NM, fuel to 0.1 gal, and ETE in whole minutes. Keep unrounded values for subsequent calculations, cumulative totals, and sufficiency decisions.
- Treat pilot-entered reserve as the fuel threshold. Show estimated arrival margin above that threshold or shortfall below it; do not add an arbitrary extra reserve buffer.
- No runway-specific pattern maneuver or terrain-clearance model is added here.
- Existing saved altitude numbers remain unchanged. The new endpoint interpretation applies when recalculating them; make the changed meaning visible in the editor.

## Worked planning cases

On a direct 60 NM route with a 1,000 ft departure elevation, 4,500 ft selected cruise altitude, 2,000 ft pattern target, 500 ft/min climb and descent, and a simplified 90 kt groundspeed in both vertical phases: climb takes 7 min and 10.5 NM; descent takes 5 min and 7.5 NM. TOC is at 10.5 NM, TOD is at 52.5 NM, and the navlog ends at the airport at 2,000 ft MSL. The actual plan uses its resolved wind for each phase's groundspeed and fuel, so these simple distances are illustrative.

On a direct 15 NM route with the same vertical demands, climb plus descent need 18 NM at the illustrative groundspeed. The plan stops as infeasible rather than producing a cruise row or carrying descent beyond the airport.

## Acceptance checks

1. A normal multi-leg route shows the entered altitude at each checkpoint, reaches the final cruise target before TOD, shows TOC and TOD in route order, and ends at the airport within 50 ft of the pattern-altitude target.
2. A direct route shows TOC and TOD when both fit; cumulative ETE and fuel include climb and descent phase performance.
3. A climb that cannot reach its named waypoint target and a route where vertical phases overlap fail clearly.
4. A headwind or tailwind during descent does not cause a false exact-altitude error; TOD timing and placement are consistent with the descent calculation and airport endpoint.
5. Navlog labels identify generated TOC/TOD, and the final row clearly identifies the airport pattern-altitude endpoint.
6. Existing pilot-entered values survive recalculation. Relevant tests, typecheck, lint, build, and security checks pass or limitations are reported.
7. Displayed headings are rounded to whole degrees, altitude to 100 ft, wind and groundspeed speeds to whole knots, distance to 0.1 NM, fuel to 0.1 gal, and ETE to whole minutes, while calculations continue with unrounded values.
8. Reconciled TOD wind is used before testing phase overlap; accepted checkpoint transitions end at the checkpoint and preserve their estimated altitude within 50 ft.
9. Fuel sufficiency compares estimated arrival fuel directly with the pilot-entered reserve threshold and reports the resulting margin or shortfall without an added buffer.
