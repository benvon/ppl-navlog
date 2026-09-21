# Vertical-Profile Calculation Slice

`createVerticalProfileCalculationEngine` is a bounded APP-01 precursor, not the complete calculated navlog promised by the implementation plan.

It calculates an initial climb, generated top of climb, final descent, generated top of descent, convergence counts, and climb/descent overlap from a uniform route cruise altitude. The descent wind resolver repositions each bounded-convergence iteration to the candidate TOD before asking the weather adapter for sampled wind; it does not treat the final user-leg origin as the actual TOD.

It deliberately does not calculate cruise navigation-log rows: per-leg wind correction angle, true/magnetic/compass heading, ETE, cruise fuel, fuel summary, or compass-deviation interpolation. It also rejects different cruise altitudes between user legs because the project has not yet specified how an explicit transition phase consumes remaining route distance. These cases surface as `unsupported-plan-input`, never as a silently incomplete plan.

`createWorkerWindsPlanWeatherResolver` provides the concrete typed Worker-to-plan adapter. It requires a caller-provided station-selection coordinate, selected forecast valid time, and generated weather-snapshot ID; it returns immutable raw-product evidence for a later atomic plan write and never infers those choices. `PlanDraft` does not currently persist a selected forecast period or valid time, so this slice cannot choose one or refresh it safely. In addition, the FB Winds/Temps Low product begins at 3,000 feet. A phase that traverses an altitude below the published envelope must fail with the weather adapter’s explicit unsupported-altitude result; V1 has not approved a METAR-to-3,000-foot interpolation policy, and the slice does not extrapolate.
