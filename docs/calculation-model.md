# Calculation Model

This document reserves the calculation contract for implementation in the domain layer. All external, persisted, and pilot-entered values must undergo runtime validation before they become calculation inputs. Calculation functions return typed values and explanation traces; presentation formatting and worksheet rounding do not alter stored calculation precision.

Unless a later FAA-reference fixture specifies otherwise, calculations retain full practical precision internally. A single formatter policy will define visible rounding for display and final worksheet values. Each trace will identify formula, input values and units, intermediate values, rounding stage, and the resulting value. A calculated value may become effective through an explicit pilot override, but the original computed value and override provenance remain retained.

Rounding is applied only at declared presentation boundaries. A trace must distinguish unrounded calculation output from rounded display value and identify the rounding mode. Intermediate display rounding must never be fed back into a later calculation. Unit conversion occurs at the domain boundary and is recorded in the trace when it changes a reported value.

Wind direction is never averaged numerically. Wind samples are converted to vector components, averaged in component form, then converted to direction and speed. The future detailed model will define coordinate precision, great-circle calculations, wind-triangle conventions, climb/descent sampling points, phase iteration bounds, and FAA-example tolerances.
