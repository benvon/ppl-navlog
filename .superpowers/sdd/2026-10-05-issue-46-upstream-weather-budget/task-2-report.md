# Task 2 implementation report

## Delivered APIs

- `WeatherBudgetStore` constructor: `new WeatherBudgetStore(storage: StoreStorage)`, where `StoreStorage` requires `{ sql, transactionSync }` from `DurableObjectStorage`.
- Required methods: `reserveAttempt(key, nowMs)`, `readResource(key)`, `publishResource(key, generation, resource, nowMs)`, and `recordFailure(key, generation, nowMs, providerRetryAtMs?)`.
- Task 3 coordinator observers: `readResourceState(key)` gives generation, lease expiry, failure count, and per-key retry deadline; `readProviderCooldown()` gives deadline or `'operator_required'`; `readAccountingMetadata()` gives attempt/resource counts and provider cooldown state. `clearResource(key)` removes only the envelope and retains accounting and lease history.
- `fetchWeatherResource(key, fetcher, previous?, now: () => number = Date.now)` creates fixed upstream URLs and validates response content. It uses a fixed User-Agent, `redirect: 'manual'`, five-second racing deadlines for fetch and stream reads, compressed and decompressed catalog caps, and a 1 MiB winds cap. It throws `UpstreamFailure` with 429 status and Retry-After preserved. The optional prior envelope preserves `fetchedAt` for unchanged checks; `checkedAtMs` is completion time and stamps refresh deadlines.

## Persistence and safety

All reservations and publications run inside `transactionSync`. A reservation clamps the supplied clock to persisted `last_clock`, counts the attempt before network I/O, acquires a 30-second lease, and refuses requests on cooldown or applicable rolling-window exhaustion. Storage exceptions reject the reservation, allowing the coordinator to fail closed. A timed-out/uncertain lease establishes cooldown on recovery; attempts are never refunded. The store validates keys and persisted envelopes, fences stale generations and expired leases, rejects regressed winds issue times, preserves prior resources on failure, prunes attempts beyond 24 hours, and caps resources at ten. An unrepresentable provider cooldown is persisted as operator-required and cannot be replaced by a later ordinary deadline.

## RED/GREEN evidence

The first Miniflare launch was RED because its runtime rejected compatibility date `2026-10-05`; the test-only harness now uses the latest date supported by the pinned stable Miniflare runtime (`2026-07-30`). With SQLite enabled, the first real store run exposed a SQL bind-count error in reservation insertion; correcting the extra argument made the accounting runtime assertions pass. Other early failures were harness setup or incorrect expectations around same-key leases and cooldown timing, and were fixed in the tests. This was not strict test-first sequencing for every behavior: implementation began before the runtime harness was operational, so no pre-implementation failing test exists for each requested behavior.

Final `test:workers` runs 17 assertions in Miniflare/workerd covering all ten allowlisted keys, per-key eight-attempt exhaustion without an extra debit, restart/expired-lease recovery, generation and lease publication fencing, invalid stored JSON rejection, operator-required cooldown persistence, storage fault rollback/no debit, clock regression clamping, redirects, oversized/invalid bodies, fetch and body timeouts, provider Retry-After propagation, and successful validated gzip catalog retrieval.

The application suite was run once: 41 files and 459 tests passed. Typecheck and lint pass. Test runtime uses Miniflare 4.20260730.0 rather than the incompatible Vitest 5 Cloudflare plugin; its test compatibility date predates the deployment config's date because the bundled workerd runtime cannot execute newer dates. The production coordinator entrypoint is Task 3's responsibility, so this test-only harness validates the concrete store against SQLite but does not validate production HTTP orchestration. `wrangler.weather-coordinator.jsonc` includes the requested SQLite class migration.

## Validation

- `mise exec -- npm run test:workers` — passed (17 assertions, 2 files).
- `mise exec -- npm test` — passed (41 files, 459 tests; run once).
- `mise exec -- npm run typecheck` — passed.
- `mise exec -- npm run lint` — passed.

Full CI and deployment dry-runs were not run; coordinator entrypoint and production environment bindings are still Task 3/6 work.

## Review fix round

The reviewer added two failing regressions before this fix: publish returned true after another key advanced the shared store clock beyond the lease, and a hostile stream whose `cancel()` never settled kept the fetch promise pending beyond the five-second deadline. Both reproduced RED in Miniflare. After the fix, both pass GREEN.

The final signatures are:

- `publishResource(key, generation, resource, nowMs): Promise<boolean>` now clamps `nowMs` against persisted store time inside the same SQLite transaction as generation and lease checks. It rejects a future resource `checkedAt`, an expired lease, stale generations, and regressed winds issues.
- `fetchWeatherResource(key, fetcher, previous?, now: () => number = Date.now): Promise<WeatherResourceEnvelope>` calls the trusted clock after bounded body reading and payload validation. Identical data retains the previous `fetchedAt`; refreshed deadlines use completion time.

Cancellation is best-effort and never awaited. Rejected HTTP response bodies, including 429, are canceled without delaying the caller. Both compressed and inflated station-catalog sizes are capped at 3 MiB. The coordinator Wrangler config uses compatibility date `2026-09-21`, `workers_dev: false`, and `preview_urls: false`.

Additional runtime assertions cover four catalog checks per day, the shared 20-attempt/minute ceiling across ten resource keys, no debit after denial, ordinary provider cooldown across Miniflare restart, operator-required cooldown surviving a later normal Retry-After, failed-attempt retention, failed-refresh preservation of the prior resource, regressed winds rejection, and compressed/inflated catalog bounds. The test suite now has 17 assertions across two files. No production entrypoint/orchestration is included.

Fix-round validation: `mise exec -- npm run test:workers` passed (17 assertions); `mise exec -- npm run lint` passed with no complexity suppressions; `mise exec -- npm run typecheck` passed. No full application suite rerun was needed because this round changed only coordinator storage/retrieval, test harness/config, and its tests.
