# Full Navlog Calculation Engine

`createFullNavlogCalculationEngine` is the concrete complete-plan calculation engine. It requires immutable selected `loadedWindsData`; it neither requests weather nor selects a forecast. The engine uses those levels for phase-allocation convergence and resolves every allocated subleg again through `resolveLoadedEffectiveWindForSubleg`, so a level subleg uses a direct altitude resolution and a vertical subleg uses the documented sampled effective wind.

The persisted `complete-navlog/v1` snapshot records selected-weather provenance, the complete allocation result, generated boundaries, vertical-phase calculation traces, and—for an allocated result—the JSON-safe `navlog-calculation/v1` result. Every row retains the resolved wind planning value, its source/explanation metadata, PHAK heading and fuel traces, and any applied field-elevation METAR interpolation evidence.

If allocation is infeasible, the snapshot status is `infeasible-phase-allocation`; it contains the allocation violations and available boundaries but intentionally contains no navlog rows or fabricated cruise distance. Calculation failures due to unavailable wind altitudes remain weather-resolution failures, while invalid route, aircraft, or planning inputs remain explicit unsupported-input failures.
