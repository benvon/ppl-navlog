# Issue 55 after measurement

Measured in jsdom through planner DOM actions using the real `WorkerAirportLookup` and `WorkerWindsClient` adapters. Fixture responses are deterministic and synthetic, with production-shaped v1 airport, METAR, winds, and station-catalog provenance. The fixture pins `Date.now()` and requires a current result after each successful Update.

| Route | Initial | Unchanged / title / fuel, each | Altitude 4500 to 5500 | Departure 22:00 to 22:05 |
|---|---:|---:|---:|---:|
| Direct | 5 (2 airport, 1 METAR, 2 winds) | 0 | 2 winds | 2 winds |
| 25 checkpoints | 30 (2 airport, 1 METAR, 27 winds) | 0 | 27 winds | 27 winds |

On the 25-checkpoint route, moving the final checkpoint produced 2 fresh point requests (that checkpoint and destination) while 25 exact point queries remained reusable. An early-leg TAS override then produced 25 fresh point requests while 2 exact point queries remained reusable. Switching between identical-query saved plans on one adapter instance used 0 requests while the title and calculated fuel result changed. Repeating the query from a new adapter session used 5 requests. Concurrent duplicate airport, normalized METAR, and exact point pairs made 3 requests for 3 unique keys. After advancing beyond the fixture's one-hour source freshness, the direct route refreshed with 5 requests and the next identical Update used 0; a later explicit failed point request preserved saved inputs, and retry fetched that failed key again.

The tests also confirm unchanged inputs render the same calculated table, fuel changes the result while reusing fetched context, literal departure time is saved, and fetched provenance is absent from the saved plan. Counts are synthetic requests at the adapter fetch boundary; they do not establish production traffic, provider behavior, latency, or billing savings. See [baseline.md](baseline.md) and [after.json](after.json) for the before/after counts.

The baseline on `main` made 5 / 30 requests on every Update. Unchanged, title-only, and fuel-only updates move from 5 / 30 requests to 0 / 0. Altitude and departure-time edits require new point winds queries while airport and METAR context is reused. Real-browser verification also confirmed direct and maximum-route request reuse, unchanged worksheet output, current fuel calculations, changed-altitude query isolation, and empty caches after reload. See [browser-verification.md](browser-verification.md).

Focused validation passed: 65 transport tests and 96 planner tests, with one optional planner performance benchmark skipped. Independent final review found two helper issues (mutable retained cooldown errors and expiry-before-LRU ordering); both received failing regression tests, fixes, and scoped re-review. Independent scoped re-review accepted both fixes with no remaining actionable findings.

Final coordinator validation: `mise exec -- npm run ci` passed on the corrected tree: 54 test files, 690 tests passed and one optional performance benchmark skipped; typecheck, lint, architecture boundaries, coverage thresholds, production build/artifact checks, local Worker static-routing checks for base/development/production, secret scan, workflow lint, and dependency audit all passed. The audit found zero vulnerabilities. No PR, remote CI, deployment, or live-provider smoke test was performed. Server implementation and dependencies are unchanged; the separate Worker-runtime suite was not run.
