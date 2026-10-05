# Task 2 implementation report

## Delivered APIs

- `WeatherBudgetStore` constructor: `new WeatherBudgetStore(storage: StoreStorage)`, where `StoreStorage` requires `{ sql, transactionSync }` from `DurableObjectStorage`.
- Required methods: `reserveAttempt(key, nowMs)`, `readResource(key)`, `publishResource(key, generation, resource)`, and `recordFailure(key, generation, nowMs, providerRetryAtMs?)`.
- Task 3 coordinator observers: `readResourceState(key)` gives generation, lease expiry, failure count, and per-key retry deadline; `readProviderCooldown()` gives deadline or `'operator_required'`; `readAccountingMetadata()` gives attempt/resource counts and provider cooldown state. `clearResource(key)` removes only the envelope and retains accounting and lease history.
- `fetchWeatherResource(key, fetchedAtMs, fetcher, previous?, checkedAtMs?)` creates fixed upstream URLs and validates response content. It uses a fixed User-Agent, `redirect: 'manual'`, five-second racing deadlines for fetch and stream reads, compressed and decompressed catalog caps, and a 1 MiB winds cap. It throws `UpstreamFailure` with 429 status and Retry-After preserved. The optional prior envelope preserves `fetchedAt` for unchanged checks; `checkedAtMs` is completion time and stamps refresh deadlines.

## Persistence and safety

All reservations and publications run inside `transactionSync`. A reservation clamps the supplied clock to persisted `last_clock`, counts the attempt before network I/O, acquires a 30-second lease, and refuses requests on cooldown or applicable rolling-window exhaustion. Storage exceptions reject the reservation, allowing the coordinator to fail closed. A timed-out/uncertain lease establishes cooldown on recovery; attempts are never refunded. The store validates keys and persisted envelopes, fences stale generations and expired leases, rejects regressed winds issue times, preserves prior resources on failure, prunes attempts beyond 24 hours, and caps resources at ten. An unrepresentable provider cooldown is persisted as operator-required and cannot be replaced by a later ordinary deadline.

## RED/GREEN evidence

The first Miniflare launch was RED because its runtime rejected compatibility date `2026-10-05`; the test-only harness now uses the latest date supported by the pinned stable Miniflare runtime (`2026-07-30`). With SQLite enabled, the first real store run exposed a SQL bind-count error in reservation insertion; correcting the extra argument made the accounting runtime assertions pass. Other early failures were harness setup or incorrect expectations around same-key leases and cooldown timing, and were fixed in the tests. This was not strict test-first sequencing for every behavior: implementation began before the runtime harness was operational, so no pre-implementation failing test exists for each requested behavior.

Final `test:workers` runs 12 assertions in Miniflare/workerd covering all ten allowlisted keys, per-key eight-attempt exhaustion without an extra debit, restart/expired-lease recovery, generation and lease publication fencing, invalid stored JSON rejection, operator-required cooldown persistence, storage fault rollback/no debit, clock regression clamping, redirects, oversized/invalid bodies, fetch and body timeouts, provider Retry-After propagation, and successful validated gzip catalog retrieval.

The application suite was run once: 41 files and 459 tests passed. Typecheck and lint pass. Test runtime uses Miniflare 4.20260730.0 rather than the incompatible Vitest 5 Cloudflare plugin; its test compatibility date predates the deployment config's date because the bundled workerd runtime cannot execute newer dates. The production coordinator entrypoint is Task 3's responsibility, so this test-only harness validates the concrete store against SQLite but does not validate production HTTP orchestration. `wrangler.weather-coordinator.jsonc` includes the requested SQLite class migration.

## Validation

- `mise exec -- npm run test:workers` — passed (12 assertions, 2 files).
- `mise exec -- npm test` — passed (41 files, 459 tests; run once).
- `mise exec -- npm run typecheck` — passed.
- `mise exec -- npm run lint` — passed.

Full CI and deployment dry-runs were not run; coordinator entrypoint and production environment bindings are still Task 3/6 work.
