# Issue 55 baseline measurement

Measured 2026-10-07 against main a98b6e6214b5b4e509106586d93b32d881272352, verified equal to fetched origin/main.

Method: actual planner DOM actions under Vitest/jsdom, actual WorkerAirportLookup and WorkerWindsClient adapters, counted fetch calls with deterministic synthetic JSON responses. KORD to KJVL, synthetic aircraft profile, 4500 ft, explicit KORD departure METAR. Maximum route has 25 distinct checkpoints placed between 25% and 70% along the route, beyond estimated TOC and before TOD. Every Update was required to produce a current result. Scenarios run sequentially: initial, unchanged, title, fuel aboard 20 to 19, altitude 4500 to 5500, departure 22:00 to 22:05. Queries compared by complete serialized URL. No application behavior changed.

| Scenario | Direct route requests (airport/METAR/winds) | 25 checkpoints | Exact URLs repeated from prior Update (direct/max) |
|---|---|---|---|
| Initial | 5 (2/1/2) | 30 (2/1/27) | 0/0 |
| Unchanged | 5 (2/1/2) | 30 (2/1/27) | 5/30 |
| Title only | 5 (2/1/2) | 30 (2/1/27) | 5/30 |
| Fuel aboard only | 5 (2/1/2) | 30 (2/1/27) | 5/30 |
| Altitude | 5 (2/1/2) | 30 (2/1/27) | 3/3 |
| Departure time | 5 (2/1/2) | 30 (2/1/27) | 3/3 |

No duplicate URLs occurred within an individual Update. Two concurrent calls each for the same airport, normalized METAR, and exact point made six requests for three unique URLs. All succeeded.

The initial plus three identical-query Updates use 20 or 120 requests. If all responses are still eligible, exact-query session reuse could use 5 or 30: a 75% reduction in this constructed sequence. Across all six Update scenarios, the corresponding ceiling is 30 to 9 (70%) or 180 to 84 (53.3%). These are potential reductions, not measured after implementation. Concurrent-pair joining could reduce six to three, but the planner action lock means this is not evidence of ordinary concurrent Update traffic.

Recommendation: request duplication is large enough to justify a small bounded session cache if reduced request volume is the objective. Prioritize repeated successful exact queries; do not introduce controller convergence or approximate query matching. Initial request count remains unchanged; edits affecting sequential time legitimately require new winds requests. Airport and METAR policy needs its own eligibility contract, independent of winds product and catalog deadlines. Airport adapter currently discards provenance when mapping to AirportRoutePoint, so adding airport reuse requires retaining or checking policy at the transport boundary.

This measurement does not establish production Update frequency, latency savings, Cloudflare billing savings, live upstream behavior, or cache-eligible lifetime distributions. It uses jsdom, not an integrated real browser, and synthetic responses. Real-browser verification remains an implementation acceptance check. Full repository CI was not run for this measurement-only task.

Validation: measurement repeated twice with byte-identical JSON results; measurement and existing weather/airport transport tests passed. Harness and raw JSON retained alongside this report. To rerun, copy /private/tmp/issue-55-baseline.test.ts to src/ui/issue-55-baseline.test.ts, run mise exec -- npm test -- src/ui/issue-55-baseline.test.ts, then remove that temporary copy. Raw results are /private/tmp/issue-55-baseline.json.
