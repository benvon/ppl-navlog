# Full Navlog Calculation Engine

## Current teaching worksheet

The active `Update navlog` path is `pilot-intent-planner` → `resolveRouteWeather` → `calculateWaypointWorksheet`. It establishes one estimated TOC and TOD, then calculates rows forward using selected checkpoint weather. `resolveRouteWeather` adapts those finalized rows and their domain traces to `complete-navlog/v1`; `createFullNavlogCalculationEngine` returns that finalized snapshot without running another allocator. The table remains compact and the inspector below it presents calculation steps.

See the [teaching contract](navigation-worksheet-teaching-contract.md) for the single cruise altitude, field-elevation endpoint, weather selection, fuel semantics, and uncertainty assumptions.

## Historical engine and compatibility

The remaining description applies to legacy fixture/browser callers. Broad retirement of those callers is tracked in issue #30; their convergence and altitude-transition rules do not control the active teaching worksheet.

`createFullNavlogCalculationEngine` is the concrete complete-plan calculation engine. It requires immutable selected `loadedWindsData`; it neither requests weather nor selects a forecast. The engine uses those levels for phase-allocation convergence and resolves every allocated subleg again through `resolveLoadedEffectiveWindForSubleg`, so a level subleg uses a direct altitude resolution and a vertical subleg uses the documented sampled effective wind.

The persisted `complete-navlog/v1` snapshot records selected-weather provenance, the complete allocation result, generated boundaries, vertical-phase calculation traces, and—for an allocated result—the JSON-safe `navlog-calculation/v1` result. Every row retains the resolved wind planning value, its source/explanation metadata, PHAK heading and fuel traces, and any applied field-elevation METAR interpolation evidence.

If allocation is infeasible, the snapshot status is `infeasible-phase-allocation`; it contains the allocation violations and available boundaries but intentionally contains no navlog rows or fabricated cruise distance. Calculation failures due to unavailable wind altitudes remain weather-resolution failures, while invalid route, aircraft, or planning inputs remain explicit unsupported-input failures.
