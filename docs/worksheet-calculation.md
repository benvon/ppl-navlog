# Current worksheet calculation path

The production path is:

`main.ts` → `pilot-intent-planner.ts` → `resolveRouteWeather` → `calculateWaypointWorksheet` → `prepareWaypoints` and `calculateWaypointWorksheetRow`.

The planner validates current inputs and the aircraft profile before weather retrieval, saves the latest pilot inputs/profile snapshot, obtains departure METAR, and invokes route weather sampling. The worksheet places estimated TOC/TOD once, validates authored checkpoints against their inclusive interval, and advances through the ordered rows. Each row uses its selected wind to calculate course, headings, groundspeed, time, and fuel; later winds cannot rewrite earlier rows.

`resolveRouteWeather` returns the finalized worksheet snapshot, selected weather evidence, warnings, and source IDs directly. The planner displays that result and passes it to the inspector. There is no injected calculator, final recalculation, progressive-snapshot bypass, legacy phase allocation, or alternate weather resolver.

`WorksheetResult` is a disposable in-memory display envelope, not a saved revision. The only saved data is the latest current-format pilot inputs and current aircraft profiles. Unsupported saved input formats are discarded with a create-new-plan notice. Malformed current-format data is rejected. No history or migration is retained.

The extracted fuel validator checks entered amounts and aircraft capacity before weather requests. Fuel insufficiency is calculated and displayed as a teaching result, not hidden by validation. Zero fuel remains valid input and is visibly exhausted.

The [teaching contract](navigation-worksheet-teaching-contract.md) specifies arithmetic assumptions, request timing, checkpoint failure behavior, rounding, and inspector placement. The [weather model](weather-model.md) describes the selected weather. Printing remains deferred; authoritative learning sources are separate work in issue #34.
