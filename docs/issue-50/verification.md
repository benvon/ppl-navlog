# Issue 50: saved-history editing cost

## Contract and implementation

Ordinary textbox edits, state reads, and subscriber publications must not copy or traverse full saved documents. The state owner exposes frozen ID/title summaries, rebuilt during initialization and successful saves, and defensive copies of the bounded active draft. Full saved records remain private. Open still reads by ID through the existing serialized repository transition. A validation pass reuses one draft view.

Selector order and saved labels, explicit saves, save-before-Update, serialized New/Open, failure/retry/discard, literal text, and textbox baselines retain their behavior. No persistence schema, calculation/weather, general controller restructuring, or selector optimization changes are included.

## Reproducible local measurement

Command: `PLANNER_INPUT_BENCHMARK=1 mise exec -- npm test -- src/ui/pilot-intent-planner.test.ts -t 'measures input events'`.

The opt-in test writes `/tmp/ppl-navlog-input-benchmark.json`. Raw baseline and post-change measurements are retained alongside this report. Baseline production code: `da2a700`; post-change: the accompanying working diff. Environment: macOS 27.0.1 arm64, Node 22.19.0 through mise, Vitest 5.0.1, jsdom 26.1.0. Timings measure synchronous dispatch of actual planner `input` events, including controller validation, DOM control synchronization, and subscriber callbacks. They exclude initialization, storage I/O, and browser painting.

Fixtures use a fixed 25-checkpoint active draft and attached aircraft profile. Saved counts include that active record. Each inactive record has the same checkpoints/profile with an additional 2,048 or 32,768 ASCII bytes spread equally across four notes fields (512 or 8,192 bytes each, within the 10,000-character field limit). IDs/titles, record count, and active draft stay constant across payload variants. Thus the 1-record cases contain no additional notes payload and are equivalent controls. Notes totals for 100 and 1,000 records are respectively 202,752/3,244,032 and 2,045,952/32,735,232 bytes (excluding the common document fields). Both title and final-checkpoint-name edits use three warmup events and twelve measured events. Median is the upper middle sample; nearest-rank p95 is the maximum of twelve samples.

No timing assertion is added to CI. These local jsdom measurements are evidence about saved-payload scaling, not browser/device guarantees. Selector work still grows with saved count, and active-draft cloning/form scans remain.

| Saved records | Extra bytes per inactive record | Field | Before median / p95 (ms) | After median / p95 (ms) |
| --- | --- | --- | --- | --- |
| 1 | 2048 | plan-title | 20.05 / 20.90 | 17.60 / 18.52 |
| 1 | 2048 | checkpoint-name-24 | 18.74 / 19.28 | 16.95 / 17.84 |
| 1 | 32768 | plan-title | 18.37 / 19.15 | 16.15 / 16.55 |
| 1 | 32768 | checkpoint-name-24 | 18.16 / 18.52 | 15.97 / 16.86 |
| 100 | 2048 | plan-title | 36.88 / 38.38 | 18.48 / 18.84 |
| 100 | 2048 | checkpoint-name-24 | 37.80 / 38.71 | 17.97 / 18.48 |
| 100 | 32768 | plan-title | 101.94 / 108.90 | 17.60 / 18.11 |
| 100 | 32768 | checkpoint-name-24 | 101.44 / 107.71 | 17.70 / 18.24 |
| 1000 | 2048 | plan-title | 233.30 / 236.66 | 34.36 / 34.99 |
| 1000 | 2048 | checkpoint-name-24 | 235.80 / 244.96 | 34.37 / 35.07 |
| 1000 | 32768 | plan-title | 1689.25 / 1772.47 | 34.29 / 35.63 |
| 1000 | 32768 | checkpoint-name-24 | 1688.92 / 1860.34 | 31.92 / 33.59 |

## Verification

Regression tests cover metadata-only views, failure/retry label updates, mutation attempts through caller/subscriber values, and inactive-payload clone guards on state reads/publications and actual textbox input. Existing planner tests cover explicit saves, Update persistence ordering, New/Open serialization, failure/discard recovery, whitespace/incomplete text, comparison baselines, and maximum-checkpoint IndexedDB save/reopen.

Integrated local browser checks used an isolated in-memory fixture, without modifying existing browser storage: literal title Save, selector label refresh, save failure before Open preserving the unsaved draft, Retry completing the pending Open, reopening the saved literal title, and New plan. Failure recovery used a synthetic repository write failure. No live weather or Cloudflare changes are involved.

An independent reviewer found no actionable correctness or ownership regressions.

Full `mise exec -- npm run ci` passed: typecheck, ESLint, architecture boundaries, 53 test files / 655 tests with coverage thresholds, build/artifact checks, static routing in base/development/production configurations, secret scan, workflow lint, and dependency audit (zero vulnerabilities). The opt-in measurement is skipped during normal CI. The initial sandboxed run could not start the local routing check; the complete run passed with the required local access. No remote CI was run because no PR was created.

The input-event guard was also checked against baseline production code: it failed because textbox handlers cloned the inactive payload. Baseline files were temporarily restored for measurements and then the implementation was restored without discarding any edits.

After the measurement-fixture and input-event assertion refinements, typecheck, lint, and the full test suite passed again (53 files, 655 tests; only the opt-in benchmark skipped). `git diff --check` also passed.
