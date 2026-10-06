# Authoritative AWC Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound each environment's direct AWC traffic independently, coordinate refreshes, expose bounded stale context honestly, and remove unused TAF access.

**Architecture:** A private coordinator Worker and SQLite-backed Durable Object per environment own ten fixed upstream resources and persistent request accounting. Navlog uses environment-specific service bindings and an optional edge resource cache, retaining point selection/interpolation. The browser accepts the explicit grace contract without implementing #55's response reuse.

**Tech Stack:** Existing TypeScript, Node 22.19.0 via mise, Vitest, Wrangler, Cloudflare Workers/Durable Objects, SQLite storage. Add only the runtime-testing/type dependencies required for this change; retain the existing package manager and lockfile.

**Spec:** [Approved #46 design](../specs/2026-10-05-issue-46-upstream-weather-budget-design.md), approved after isolation revision `7a659af`.

## Global Constraints

- Development and production are separate applications: independent Workers, namespaces, caches, leases, cooldowns, and budgets. No shared runtime state or budget reservations.
- Each environment: overall 20 attempts/rolling 60 seconds and 300/rolling 24 hours; winds 288/rolling 24 hours; each winds key 8/rolling 6 hours and 32/rolling 24 hours; catalog 4/rolling 24 hours.
- Exactly nine winds keys (three regions × three horizons) and one catalog key. Clients cannot supply URLs, policy, object identity, or force-refresh instructions.
- Winds successful-check interval 60 minutes; catalog 24 hours; fixed stale grace 120 seconds beyond the original deadline; applicability is independent.
- Five-second upstream timeout; two concurrent upstream fetches; ten queued resource jobs maximum; ten-second queue-start deadline; 15-second caller wait; 64 waiting callers maximum; 30-second refresh leases.
- Failure cooldowns 60, 120, then 300 seconds; provider 429 cooldown at least 60 seconds and honor longer valid Retry-After.
- Fail closed on accounting/storage/control failure; count failed and uncertain attempts. No direct-fetch fallback, redirects, idle polling, or unbounded retries.
- Keep runway-picker untouched, #55 frontend reuse separate, and #49 parsing optimization separate. Preserve calculations and durable pilot inputs.
- Preserve unrelated user edits, use an isolated `feature/` branch/worktree for implementation, and use signed Conventional Commits. No deployment or merge is implied by plan review.

## Review Focus

1. A request crosses the grace deadline while waiting: response-time checks must reject it (Tasks 3–5).
2. A process dies between persistent debit and publish: no refunded ambiguous attempt, immediate retry, or obsolete overwrite (Tasks 2–3).
3. A failed catalog hides behind a fresh product: catalog provenance and eligibility must independently control the answer (Tasks 4–5).
4. Caller cancellation/timeout leaves coordinator work alive: bounded owner work completes safely, rejected waiters are released, and later calls recover (Task 3).
5. Deployment points development at production: configuration validation must reject cross-environment bindings and tests must prove isolation (Task 6).

## File and interface map

- `worker/weather-resources/contracts.ts`: discriminated private resource/result types and strict serialized validators.
- `worker/weather-resources/validation.ts`: existing bounded product/catalog parsing moved from winds.ts only where coordinator and navlog need the same checks; no calculation refactor.
- `worker/weather-resources/policy.ts`: constants, rolling-window decisions, deadlines, and bounded Retry-After interpretation.
- `worker/weather-coordinator/store.ts`: parameterized SQLite accounting, resource versions, leases, cooldowns, and bounded pruning.
- `worker/weather-coordinator/upstream.ts`: allowlisted URL construction and bounded validated retrieval.
- `worker/weather-coordinator/index.ts`: private HTTP service entrypoint and exported `WeatherBudgetCoordinator` Durable Object, refresh queue and ownership.
- `worker/api/weather-resource-client.ts`: service-binding resource transport and optional edge acceleration.
- Existing `worker/api/winds.ts`: consumes resource port; retains domain selection/interpolation and legacy supported route behavior.
- Existing API contracts/client/sampling/presentation files: explicit product/catalog freshness and visible grace compatibility.
- `wrangler.weather-coordinator.jsonc`, root `wrangler.jsonc`, CI/release tooling: isolated deployments and artifact verification.

Private interface uses HTTP service binding, avoiding a new RPC dependency in the application contract: `POST https://weather-coordinator.internal/resource`, JSON `{ resource: WeatherResourceKey }`, no query parameters or extra keys. The origin is a fixed internal placeholder, not an externally configurable upstream. One versioned object name `awc-budget-v1` per isolated namespace.

Task 1 defines these shared types:

```ts
type WeatherResourceKey = `winds:${WindsRegion}:${WindsForecastCycle}` | 'station-catalog:v1';
type WeatherCheckMetadata = {
  fetchedAt: string; checkedAt: string; refreshAfter: string; staleUntil: string;
};
// A discriminated union: kind/key and their validated payload always agree.
type WeatherResourceEnvelope = WindsResourceEnvelope | CatalogResourceEnvelope;
type WeatherResourceResult =
  | { ok: true; resource: WeatherResourceEnvelope; state: 'fresh' | 'grace' }
  | { ok: false; code: 'service_unavailable' | 'upstream_unavailable'; retryAt: string };
interface WeatherResourcePort {
  getResource(key: WeatherResourceKey): Promise<WeatherResourceResult>;
}
```

`WindsResourceEnvelope` contains `kind:'winds'`, matching key, metadata, raw product, and the existing decoded forecasts; `CatalogResourceEnvelope` contains `kind:'catalog'`, catalog key, metadata, and the existing validated catalog structure. Move existing payload types with their validators rather than introduce generic JSON into trusted consumers. Errors exposed to clients are safe existing API errors, not serialized exceptions.

## Task 1: Shared validated resources and policy

**Files:** create `worker/weather-resources/{contracts,validation,policy}.ts` and corresponding `.test.ts`; modify `worker/api/winds.ts` and its existing tests only for parser extraction.

**Interfaces:** produce `parseResourceKey(value: unknown): WeatherResourceKey`, `isWeatherResourceResult(value: unknown): value is WeatherResourceResult`, `resourceEligibility(metadata: WeatherCheckMetadata, nowMs: number): 'fresh' | 'grace' | 'expired'`, and `budgetDecision(key: WeatherResourceKey, attempts: readonly BudgetAttempt[], nowMs: number): BudgetDecision`. `BudgetAttempt={key:WeatherResourceKey; attemptedAtMs:number}`; `BudgetDecision={allowed:true}|{allowed:false;retryAtMs:number}`. Produce `parseRetryAfter(value: string|null, nowMs: number): number | 'operator_required'` returning a retry timestamp, with default now+60s.

- [ ] Write named tests: `rejects_unknown_or_extra_resource_input`, `preserves_existing_product_and_catalog_validation`, `eligibility_has_fixed_exclusive_grace_end`, `rolling_windows_do_not_reset_at_clock_boundaries`, `catalog_and_winds_limits_are_independent`, `retry_after_never_shortens_provider_delay`. Assert all table values from Global Constraints, exact 120-second boundary, negative/malformed/overflow Retry-After behavior, and unchanged parser fixtures.
- [ ] Run `mise exec -- npx vitest run worker/weather-resources`; confirm missing modules/behavior fail before implementation.
- [ ] Move only shared parsers/types and implement the above pure signatures. Use rolling timestamps in `(now-window, now]`; at exact expiry a timestamp no longer consumes allowance. Clamp effective accounting time against the persisted last clock value in Task 2 so clock regression never resets allowance. Return the latest retry deadline required by all exhausted applicable windows.
- [ ] Run the new tests plus `worker/api/winds.test.ts` and `worker/api/winds-point.test.ts`; expect all pass with unchanged weather decoding.
- [ ] Signed commit: `refactor(weather): extract resource validation and budget policy`.

## Task 2: Persistent accounting and validated upstream retrieval

**Files:** create `worker/weather-coordinator/{store,upstream}.ts`, matching tests, `vitest.workers.config.ts`, `wrangler.weather-coordinator.jsonc`, and `worker/weather-coordinator/fixtures.ts`; modify `package.json`, `package-lock.json`, `tsconfig.json`, and test exclusions as required.

**Interfaces:** consume Task 1. Produce `WeatherBudgetStore.reserveAttempt(key, nowMs): Promise<{allowed:true;generation:number}|{allowed:false;retryAtMs:number}>`, `readResource(key): Promise<WeatherResourceEnvelope|undefined>`, `publishResource(key,generation,resource): Promise<boolean>`, `recordFailure(key,generation,nowMs,providerRetryAtMs?): Promise<void>`, and `fetchWeatherResource(key: WeatherResourceKey, fetchedAtMs: number, fetcher: ServiceFetcher): Promise<WeatherResourceEnvelope>`. Store owns SQLite connection and clock clamping; reserve atomically checks deadlines/leases/cooldowns, records debit, and acquires generation/30-second lease.

- [ ] Add a separate Workers runtime test command `test:workers`, using Cloudflare's current `@cloudflare/vitest-plugin` integration after checking its peer compatibility with this repo's Vitest 5 and Node 22. Lock the compatible release; if incompatible, use direct Miniflare tests on the existing Vitest version rather than downgrade the app suite. Keep jsdom tests separate. Runtime fixture Workers alone may inject a controllable clock/mock fetcher; production bindings accept neither.
- [ ] Write `atomic_reservations_obey_all_windows`, `restart_preserves_attempts_and_expired_lease_cooldown`, `storage_fault_denies_fetch`, `obsolete_generation_cannot_publish`, `redirect_and_oversized_or_invalid_body_consume_attempt`, and `upstream_paths_are_allowlisted`. Assert no refunds, 30-second lease recovery, bounded retention, five-second abort through body reading, and existing decompression caps.
- [ ] Run `mise exec -- npm run test:workers`; confirm meaningful accounting/retrieval failures.
- [ ] Implement parameterized SQLite tables for attempts, resource envelopes/versions, resource state/lease, and provider state. Persist cooldown and clock state; prune attempts older than 24 hours and keep ten resources only. Preserve a previously valid payload on failure. Fetch with manual redirects, fixed custom User-Agent, and Task 1 validation; check product base-time regression against the existing resource before publication. Persist operator-required cooldown as a fail-closed state, not an unsafe timestamp.
- [ ] Run runtime tests and `mise exec -- npm run typecheck`; expect success and no production-only fixture controls. Include initial `new_sqlite_classes:["WeatherBudgetCoordinator"]` migration in coordinator config; separate environment Worker names and namespaces.
- [ ] Signed commit: `feat(weather): persist upstream accounting and validated resources`.

## Task 3: Bounded refresh coordinator

**Files:** create `worker/weather-coordinator/index.ts`, `index.test.ts`, `queue.ts`, `queue.test.ts`; extend store runtime tests and coordinator config.

**Interfaces:** consume Tasks 1–2. Produce `WeatherBudgetCoordinator.getResource(key: WeatherResourceKey): Promise<WeatherResourceResult>` and coordinator Worker `fetch(request, env): Promise<Response>` implementing the fixed private HTTP protocol. Queue is internal; no public force-refresh endpoint. Tests call the real HTTP entrypoint and object, not only class methods.

- [ ] Write `independent_requests_join_one_refresh`, `fresh_hit_spends_no_attempt`, `identical_valid_revalidation_preserves_fetched_time`, `grace_is_not_reset_by_failure_or_quiet_time`, `late_response_cannot_serve_expired_grace`, `429_blocks_all_new_dispatch_but_not_fresh_hits`, `success_cannot_clear_concurrent_provider_cooldown`, `caller_abort_does_not_leak_waiters`, and `queue_and_waiter_limits_are_finite`. Assert two active fetches, ten unique jobs, ten-second start deadline, 15-second waiter deadline, 64 waiters, and 60/120/300-second backoff. Excess queue/waiter calls must fail explicitly, not allocate extra maps or retries.
- [ ] Run `mise exec -- npm run test:workers`; confirm new behavior fails.
- [ ] Implement owner-managed refresh queue, persistent reservation at dispatch, generation-safe publication, same-resource join, and response-time eligibility checks. Use object-owned bounded I/O and runtime-supported lifetime management; no shared navlog response streams. Release slots, jobs, timers, and waiter registrations on every outcome. A successful identical payload advances checked deadlines, never data age or applicability. Grace failures return previous eligible resource with `state:'grace'`; otherwise safe unavailable/retry result.
- [ ] Reject unsupported method/path/query/JSON shape before object/resource access. Emit aggregate event fields only (resource kind, outcome, duration, joins, denials); do not log arbitrary inputs or provider bodies. No alarms/cron for idle retries.
- [ ] Run runtime suite including real object eviction/restart and concurrent requests. Validate orphan lease recovery and cancellation in workerd, not just fake-promise tests.
- [ ] Signed commit: `feat(weather): coordinate bounded refreshes and failure recovery`.

## Task 4: Navlog integration and TAF removal

**Files:** create `worker/api/weather-resource-client.ts` and tests; modify `worker/index.ts`, `worker/api/{winds,contracts,request,handlers,errors,response}.ts` and affected tests (`worker/index.test.ts`, `worker/rate-limit-budget.test.ts`, `worker/api.functional.test.ts`, `worker/api/request-abuse.test.ts`, adapter/winds/handler tests); delete `worker/api/taf.ts` and `taf.test.ts`.

**Interfaces:** consume `WeatherResourcePort` and serialized validators. Produce `createWeatherResourceClient(fetcher: ServiceFetcher, cache: CacheStore|undefined, now?:()=>Date): WeatherResourcePort`; replace `createAviationWeatherAdapter` network/cache construction with `createAviationWeatherAdapter(resources: WeatherResourcePort, now?:()=>Date): WindsDataAdapter`. Add `AWC_COORDINATOR_API?: ServiceFetcher` binding. Keep runway-picker API signature and global CacheProvenance unchanged; create `WeatherResourceCacheProvenance` extending its fields with checkedAt/refreshAfter/staleUntil for AWC only. `AloftPointAnswer` adds `catalog:{cache:WeatherResourceCacheProvenance}` and uses that type for product cache. Update legacy winds outputs consistently.

- [ ] Write `missing_controls_fail_closed_in_both_environments`, `malformed_or_unknown_requests_do_not_reach_coordinator`, `taf_route_is_not_found_and_makes_no_fetch`, `cache_fault_never_falls_back_to_awc`, `fresh_edge_resource_bypasses_coordinator`, `expired_catalog_blocks_fresh_product_answer`, `point_grace_never_extends_use_window`, and `retry_headers_are_safe_bounded_values`. Use independently constructed adapters and separate edge caches sharing one environment coordinator fixture.
- [ ] Run `mise exec -- npx vitest run worker`; expect new behavior failures.
- [ ] Route all supported winds paths through the resource port. Remove direct AWC URL construction from navlog; edge cache keys/envelopes carry version and environment isolation, validate on read, and recheck deadlines before answer assembly. Edge misses contact the coordinator using fixed private request construction and bounded response reading. Map unavailable results to existing safe errors; extend ApiError with optional typed retry deadline rather than exposing provider text. Response helper converts deadlines to finite positive Retry-After seconds.
- [ ] Remove TAF wiring/routes/tests and obsolete documentation claims. Remove two-hour product/seven-day catalog serving behavior. Do not remove inspector/persistence TAF-shaped fields merely because of their names; retain any unrelated consumers as the spec permits. Keep METAR stale handling unchanged.
- [ ] Run worker tests plus the Workers integration suite through the public navlog handler. Compare ordinary/boundary wind values with existing fixtures; expect identical calculations and zero direct navlog AWC calls.
- [ ] Signed commit: `fix(weather): enforce coordinator access and remove unused TAF route`.

## Task 5: Strict client compatibility and visible grace

**Files:** modify `src/services/weather/winds-client.ts` and tests, `src/application/route-weather-sampling.ts` and tests, `src/ui/calculated-navlog.ts`, `src/ui/calculation-inspector.ts` and tests, and integrated planner tests as needed. Keep storage and calculator code unchanged.

**Interfaces:** consume Task 4's AWC-specific product/catalog provenance. Existing `fetchPoint(query):Promise<AloftPointAnswer>` remains; no browser cache/reuse layer is introduced. Sampling records both resource provenances and emits a visible warning when either resource uses grace.

- [ ] Write `accepts_only_eligible_explicit_grace`, `rejects_grace_at_deadline_or_outside_forecast_window`, `rejects_missing_or_inconsistent_catalog_metadata`, and `stale_context_visible_in_navlog_and_inspector`. Test exact query matching, zero freshness during grace, elapsed fetched age, independent catalog status, fresh success, expired/invalid failure, and unchanged METAR rules. Test a delayed answer crossing staleUntil against client receive time, not serialized servedAt alone.
- [ ] Run `mise exec -- npx vitest run src/services/weather/winds-client.test.ts src/application/route-weather-sampling.test.ts src/ui/calculation-inspector.test.ts`; confirm new metadata/behavior fails.
- [ ] Update strict validators and sampling gates with current clock checks and deadline relationships. Increase browser request timeout only as necessary to exceed the 15-second coordinator wait (use 20 seconds); preserve abort behavior. Add warning copy: “Weather refresh is temporarily unavailable; using cached context within the two-minute grace period.” Inspector identifies whether product, catalog, or both used grace and shows their separate checked/refresh/grace times. Do not call it fresh or reset timestamps. Preserve sequential planned-UTC queries and save-before-Update behavior.
- [ ] Run targeted tests and integrated planner browser check with mocked fresh/grace/expired point responses. Verify warnings and failure UI at ordinary and maximum route lengths without durable weather storage.
- [ ] Signed commit: `fix(weather): expose bounded stale context with strict provenance`.

## Task 6: Isolated deployment wiring and release artifacts

**Files:** modify root `wrangler.jsonc`, `wrangler.weather-coordinator.jsonc`, `.github/workflows/{ci,production}.yml`, `package.json`, artifact verification scripts as required; create `scripts/verify-weather-bindings.mjs` and tests, `scripts/build-weather-coordinator.mjs`; update `docs/{operations,github-ci-cd-setup,security-review}.md`.

**Interfaces:** `verifyWeatherBindings(navlogConfig,coordinatorConfig):void` rejects mismatched environment targets/namespaces or any public coordinator exposure; `build-weather-coordinator.mjs` emits a deployment bundle/manifest bound to APP_COMMIT_SHA for existing immutable-release artifact flow. Do not deploy unverified coordinator source from an arbitrary checkout alongside a verified static artifact.

- [ ] Write `rejects_cross_environment_binding`, `rejects_shared_namespace_or_public_route`, `requires_both_controls`, and `release_artifact_includes_coordinator_sha`. Development target is `ppl-navlog-weather-development`, production target `ppl-navlog-weather-production`; each owns its own `WEATHER_BUDGET` binding/class namespace. Shared fixed object name inside distinct namespaces is allowed.
- [ ] Run `mise exec -- npx vitest run scripts/verify-weather-bindings.test.mjs`; confirm incorrect configurations fail.
- [ ] Wire `AWC_COORDINATOR_API` to matching private Worker names, preserve runway-picker binding, and use separate environment migration resources. Include runtime suite, isolation verification, and coordinator bundle verification in CI. Update release jobs to deploy verified same-SHA coordinator first, then matching navlog, through existing environment protections. Preserve both-domain production smoke requirements and avoid live AWC load probes.
- [ ] Document prerequisites, local multi-Worker mock development, migrations, admission/freshness/budgets, accepted cross-application throttling risk, aggregate observability/alerts, operator-required Retry-After recovery, and rollback that retains budget history. An application rollback cannot restore the pre-coordinator direct-fetch code; use a compatible version or return unavailable. Document manual cache invalidation without quota reset and environment-specific failure isolation.
- [ ] Run config/artifact tests and four dry-runs: `mise exec -- npx wrangler deploy --dry-run --env development`, the same for production, and both environments with `--config wrangler.weather-coordinator.jsonc`. Expect successful bundles with distinct environment targets and no public coordinator routes.
- [ ] Signed commit: `build(weather): wire isolated coordinator deployments and verification`.

## Task 7: Integrated verification and review handoff

**Status:** implementation and required local verification completed; see [issue-46-validation.md](../../issue-46-validation.md). The combined independent Task 7/whole-branch review remains pending. No deployment or PR is included in this handoff.

**Files:** extend runtime integration tests in `worker/weather-coordinator/index.test.ts` and `worker/api.functional.test.ts`; record evidence in `docs/issue-46-validation.md`.

**Interfaces:** exercise final public API → service binding → real object → mocked upstream flow using two isolated application stacks and independently constructed edge adapters. No production fixture controls exposed.

- [ ] Add `multi_edge_fanout_obeys_each_application_budget` and `dev_exhaustion_cannot_change_production_state`; assert same-environment coalescing, independent cross-environment refreshes, all window boundaries, catalog exhaustion, partial-cycle ambiguity, cache faults, restart, 429, and recovery. Verify unrelated callers cannot send arbitrary resource/URL/force-refresh instructions.
- [ ] Run the new tests and correct any integrated failures in their owning task; do not weaken controls or coverage to pass.
- [ ] Run `mise exec -- npm run ci`, `mise exec -- npm run test:workers`, config/artifact verification, and all four dry-runs once the final changes are integrated. Check Node version via mise; report unavailable checks honestly. Capture mock upstream attempt counts, cache hits, runtime latency/storage work, bounded queue/memory observations, and any remaining gaps. Do not present local timings as Cloudflare billing measurements.
- [ ] Perform independent whole-branch review of trust boundaries, concurrent I/O lifetimes, atomic accounting, environment isolation, and user-visible grace/failure flow. Return concrete findings for correction, then rerun only affected checks before a final full verification if code changed.
- [ ] Signed commit: `test(weather): verify integrated budgets and environment isolation` (include evidence document). Create a reviewable PR only after required local checks pass; verify current remote checks rather than assume success. Reference #46 and incorporated #48, explicitly exclude #49/#55.
- [ ] Leave deployment as a concrete protected-release handoff. If later authorized, verify bindings/runtime with controlled mock-provider concurrency first, then a small admitted live parsing smoke per environment. Record what was deployed, both production-domain smoke results, aggregate request counts, and any inability to measure live overhead. Do not mark live validation complete based on mocks.

## Execution and review boundaries

Tasks 1–4 establish the shared interfaces and coordinator behavior in order; Task 5 follows Task 4. Task 6 follows the coordinator/API interface and owns all configuration/workflow changes. Task 7 reviews the integrated flow. Delegate only within these file/responsibility boundaries; do not assign concurrent writers to winds.ts or contracts.ts. All implementers read the approved spec plus this plan and use the same values/types. The coordinator is one tightly coupled subsystem, so this is one implementation plan rather than separate independently deployable feature plans.

Recommended execution: architect/reviewer coordination with bounded GPT-6 Luna/medium implementation tasks, using the repository's default workflow and an isolated worktree. Review interfaces and results between tasks; use a fresh whole-branch reviewer at the end. Maintainer plan review precedes implementation. No implementation, dependency installation, infrastructure creation, or deployment was performed while writing this plan.

## Planning references

- [Cloudflare Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/) for runtime testing and multi-Worker support.
- [Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) for SQLite namespaces and lifecycle changes.
- Provider-policy references remain in the approved spec; the hourly check is application policy, not an asserted exact AWC release time.
