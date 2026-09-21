# Vertical-Profile Calculation Slice

`createVerticalProfileCalculationEngine` is a bounded APP-01 precursor retained separately from the complete navlog engine.

It calculates an initial climb, generated top of climb, final descent, generated top of descent, convergence counts, and climb/descent overlap from a uniform route cruise altitude. The descent wind resolver repositions each bounded-convergence iteration to the candidate TOD before asking the weather adapter for sampled wind; it does not treat the final user-leg origin as the actual TOD.

This legacy slice deliberately does not calculate cruise navigation-log rows and rejects different cruise altitudes between user legs. The complete navlog engine now handles those cases through explicit checkpoint-started transition sublegs; see `full-navlog-engine.md` and `phase-allocation.md`.

`createWorkerWindsPlanWeatherResolver` provides the typed Worker-to-plan adapter. It requires a caller-provided station-selection coordinate and generated weather-snapshot ID; it reads the pilot-selected forecast valid time from `PlanDraft`, returns immutable raw-product evidence for an atomic plan write, and never infers that choice. The UI presents available provider periods and persists the selection. The lower-than-published-altitude wind policy is documented in `weather-model.md`.
