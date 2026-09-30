# Sequential waypoint worksheet implementation plan

**Goal:** Implement issue #28 as one forward calculation API over the ordered pilot and generated waypoints prepared by issue #27.

**Contract:** [Approved waypoint-first navlog contract](../../waypoint-first-navlog-contract.md) and [issue #28](https://github.com/benvon/ppl-navlog/issues/28). This issue adds a pure worksheet result beside the current Update navlog path. Issue #30 owns activation and removal of the old path.

## Shared behavior and acceptance

- Validate authored route, profile, departure UTC, and fuel inputs before weather selection. Deduct taxi/run-up fuel once. Preserve authored input objects and report a usable-capacity violation when capacity is known.
- Place TOC from departure wind, then advance through route waypoints. A pilot checkpoint before TOC remains in the log; ignore its outbound altitude selection with a warning and keep climb inputs until TOC.
- At a pilot checkpoint after TOC, an outbound altitude change starts one transition, with a generated end before the next checkpoint and TOD. Weather chosen at a waypoint supplies its following positive-distance row.
- Estimate TOD at the current final cruise boundary before calculating its inbound row. An estimate before the final pilot waypoint stops with the approved geometry error before more rows or TOD weather. TOD weather can affect only its outbound descent row.
- Coincident pilot and generated labels share one UTC/fuel state and weather selection. Apply all boundary effects before the next positive-distance row; TOD descent inputs prevail over a conflicting checkpoint altitude selection while retaining that selection as provenance.
- Each positive-distance row uses one interface for course/distance, selected wind, heading chain, groundspeed, ETE, fuel, and unrounded cumulative UTC/fuel. No simulated crossing altitude, backward row revision, convergence, or forecast-precision tolerance controls placement.
- Fuel shortage and zero-fuel exhaustion remain calculated warnings, not blockers. Invalid wind/groundspeed, required weather, performance, or ordering produce explicit failures.
- Tests exercise the 60 NM and 24 NM worked examples, 14 NM overlap, altitude transition, coincidence, pre-TOC checkpoint, weather failure, wind failure, and fuel boundaries. Run `mise exec -- npm run ci` and review the combined flow.

## Work units

1. **Pure row arithmetic:** `src/application/waypoint-worksheet-row.ts` and focused tests. Consume already selected wind and immutable starting state; return complete one-row result without weather retrieval.
2. **Sequential worksheet:** `src/application/waypoint-worksheet.ts` and focused tests. Consume issue #27 preparation and the row interface; select weather only at the current estimated waypoint UTC; finalize each row once.
3. **Architect/reviewer integration:** Review public interfaces, ordinary and boundary cases, user-visible warnings and errors, and unchanged Update navlog behavior. Add focused corrections where needed, run CI, and create a signed Conventional Commit and reviewable PR.
