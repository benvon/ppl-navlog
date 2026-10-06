# Issue #46: authoritative AWC budgets and refresh ownership

Status: approved design. Tasks 1–7 implementation and local verification are recorded in [issue-46-validation.md](../../issue-46-validation.md); independent whole-branch review and protected-release evidence remain pending. No deployment is claimed.

## Intent and agreed scope

Protect Aviation Weather Center (AWC) availability and limit upstream requests regardless of client count, client IP, edge location, repeated updates, cache faults, or provider outages. Ordinary clients may wait for a shared refresh. A short stale grace is acceptable, independently of forecast applicability. Resource policies and budgets must reflect the actual update frequency and necessary outputs.

Confirmed decisions:

- Each environment is a separate application with its own authoritative coordinator, infrastructure, and upstream budgets. Development and production do not share runtime resources or reserve portions of a combined allowance.
- Provider-wide limits and resource-specific limits count actual attempted upstream HTTP requests, including failures.
- Winds have comfortable capacity for refresh checks and upstream variability; the daily station catalog has a small budget.
- Cull the unused public TAF endpoint and its adapter. Do not replace it with another TAF retrieval path.
- Leave runway-picker, its airport/METAR providers, service contract, and controls unchanged.
- Frontend call efficiency belongs to [#55](https://github.com/benvon/ppl-navlog/issues/55). Worker parsing/index optimization belongs to [#49](https://github.com/benvon/ppl-navlog/issues/49).
- Incorporate [#48](https://github.com/benvon/ppl-navlog/issues/48)'s shared refresh ownership and bounded failure retries here. Its old fresh-only requirement is superseded by the explicit grace below.

Non-goals: new forecast sources, new interpolation, new geographic coverage, durable browser weather/history, arbitrary query caches, a planner convergence engine, runway-picker changes, or a guarantee that public Worker request charges are capped. Static execution reduction remains [#47](https://github.com/benvon/ppl-navlog/issues/47).

## Evidence and interpretation

Reviewed current paths: `worker/index.ts`, `worker/api/winds.ts`, `worker/api/taf.ts`, `worker/api/request.ts`, `worker/api/contracts.ts`, `worker/api/response.ts`, and `src/services/weather/winds-client.ts`.

The current Worker constructs adapters per request; winds retrieve three horizons per region and a shared catalog. Edge cache refreshes have no authoritative ownership. Current product freshness is 20 minutes, with two-hour stale fallback on some legacy paths; the point API and client reject stale results. TAF is uncached. The per-IP Cloudflare rate limiter is admission control, not an upstream quota.

Primary references, checked 2026-10-05:

1. [AWC Data API — Guidelines and Cache Files](https://aviationweather.gov/data/api/): consider update frequency, limit scope/frequency, maximum 100 requests/minute; station JSON cache updates daily. AWC does not prescribe a universal client TTL or 50%-of-validity refresh rule.
2. [NWS Instruction 10-812](https://www.weather.gov/media/directives/010_pdfs/pd01008012curr.pdf), §2 (printed p.2): four scheduled FB issues daily, no amendment requirement. §6.1 (printed p.5) distinguishes bulletin heading time, DATA BASED ON time, and VALID/FOR USE times. §7 (printed p.5) permits continuing with valid prior FB forecasts when transmission is delayed.
3. [AWC product information — TAF issuance and valid period](https://aviationweather.gov/help/data/): amendments supersede earlier TAFs. This is evidence against deriving a common refresh TTL from validity; TAF itself is removed here.
4. [Cloudflare rate-limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/): location-scoped, permissive/eventually consistent accounting cannot supply a strict global budget.

The consulted sources do not establish a guaranteed availability timestamp for each region/horizon on the AWC REST endpoint. Do not infer publication from the current `issuedAt` field: the parser populates it from DATA BASED ON. Preserve its existing transport meaning in this change and describe that limitation in operations documentation.

**Application policy, not an FAA/NWS instruction:** use a 60-minute successful-check interval initially. This is longer than the current 20-minute TTL, checks several times per six-hour issuance interval, and tolerates variable dissemination without asserting a release schedule. It can delay discovery of a new issue by up to one hour under continuous demand. There are no unattended hourly refreshes. Schedule-specific optimization requires separately verified availability evidence; it is not a prerequisite or an implicit TODO in this implementation.

## Architecture and trust boundary

Deploy a dedicated, private coordinator Worker containing a SQLite-backed Durable Object for each environment. Each navlog environment binds only to its corresponding coordinator deployment, with a separate Durable Object namespace and a fixed, versioned object identity within that namespace. Isolate stored resources, edge caches, budget counters, refresh leases, cooldowns, and deployment configuration. Share source code and policy definitions, not runtime infrastructure or state. Each coordinator has no public route and workers.dev is disabled. Public clients cannot select its object name, environment, or policy configuration.

The coordinator owns retrieval, validated immutable resource storage, refresh eligibility, budgets, failure state, and fixed upstream request construction. Navlog retains route validation, geographic selection, interpolation, and response assembly. Its edge Cache API remains an optional acceleration layer, never a refresh authority. An edge miss or fault goes to the coordinator; no public Worker path may fall back to a direct AWC fetch.

The private interface accepts only a discriminated resource key:

- `winds:{us|alaska|hawaii}:{06|12|24}` (nine keys), always low-level products;
- `station-catalog:v1` (one key).

It accepts no URL, client coordinate, planned time, arbitrary station ID, force-refresh flag, TTL, quota, or arbitrary cache key. Reject unsupported keys before storage/fetch. Generate URLs exclusively from fixed allowlisted origins, paths, and parameters. Disable automatic redirects; a redirect is a failed attempted fetch, not permission to contact another origin. Every future provider request needs a reviewed resource policy.

Store bounded validated resource envelopes and existing payload size limits. Share parsing/validation through a purpose-focused module where needed, preserving the current duplicate-identity, geographic, finite-value, decompression, and payload-size controls. Do not duplicate subtly different parsers. Persist a response only after bounded body consumption and validation succeeds. Publish replacement atomically; retain the previous validated version on failure.

No cross-request response streams, AbortControllers, or fetch promises are shared between navlog isolates. The coordinator owns refresh I/O; callers receive completed serialized resources. Within the one object, requests for the same resource join one pending refresh. Do not hold a storage transaction across upstream I/O. Before I/O, atomically record budget debit and a bounded refresh lease. Completion publishes only if the lease generation still owns that resource. Restarted/abandoned leases cannot cause immediate duplicate requests or overwrite newer results.

## Proposed hard budgets

The following limits apply independently and in full to each application/environment. There is no cross-environment counter, reservation, borrowing, or admission dependency. All windows are exact rolling windows, with persisted attempt timestamps pruned to bounded retention. Check/debit every applicable window atomically before dispatch. Time is coordinator-owned; caller timestamps are ignored. A failed/aborted request consumes its slot. Storage failure denies dispatch. A debit followed by process failure may conservatively consume an unused slot; never refund an ambiguous attempt.

| Scope | Limit | Basis |
| --- | --- | --- |
| All direct AWC resources | 20 attempts per rolling 60 seconds and 300 per rolling 24 hours | Considerably below AWC's documented minute ceiling; bounds aggregate daily activity |
| All winds keys | 288 attempts per rolling 24 hours | Nine keys × 32 attempts, including hourly checks and recovery slack |
| Each winds key | 8 attempts per rolling 6 hours and 32 per rolling 24 hours | About six hourly checks per six-hour period plus retry slack; about 24 normal daily checks plus eight extra |
| Station catalog | 4 attempts per rolling 24 hours | One daily success plus three recovery attempts |

Worst normal continuous demand across all regions: approximately 216 winds checks plus one catalog check per day (nine × 24 + one). Quiet resources perform no checks. Cold start can fetch all nine winds resources plus the catalog within the minute allowance. Client-driven region changes cannot create additional keys. Existing supported legacy winds routes consume the same resources/budgets.

Resource limits cannot borrow from another resource's allowance. The overall ceiling applies even when individual limits permit work. A catalog refresh cannot exhaust winds capacity. These are proposed operating limits, not claims about AWC's enforcement scope. The bound covers this coordinator's traffic only; other applications contacting AWC remain outside it.

**Accepted cross-application risk:** the two applications can together attempt up to 40 requests per rolling minute and 600 per rolling day under the stated overall ceilings. These are arithmetic upper bounds, not a jointly enforced budget. AWC may group callers under an enforcement scope broader than an application; its documented guidance does not establish that separate deployments receive separate quotas. Development cannot consume production's local allowance or modify its infrastructure, but development traffic may contribute to provider-side throttling or blocking that affects production. The maintainer accepts this risk; do not introduce shared infrastructure or a reserved dev/prod budget to eliminate it.

On denial, calculate the earliest eligible retry from exhausted windows and cooldowns. Do not queue unbounded callers until quota resets. Return an explicit resource-unavailable outcome with a bounded retry indication; serve eligible grace data only under the rules below.

## Refresh, freshness, and grace

Each stored envelope includes resource/version, `fetchedAt`, `checkedAt`, `refreshAfter`, fixed `staleUntil`, and the validated data. Product validity/use windows remain separate fields.

- Winds: a successful validated check sets `checkedAt` to completion and `refreshAfter` to completion + 60 minutes. Preserve `fetchedAt` for unchanged data; equality of a fully validated product may advance `checkedAt`, not its issue/base or applicability times. Changed data gets its own fetched timestamp. Do not extend freshness after failed or invalid checks.
- Catalog: successful checks set `refreshAfter` to completion + 24 hours. Preserve fetched time on unchanged data similarly. This is elapsed daily refresh, since the provider does not document an exact daily publication time here.
- For both: `staleUntil = refreshAfter + 120 seconds`. Grace starts at the original refresh deadline, not at the first client request or each failure. A quiet period cannot manufacture a new grace interval.
- Before `refreshAfter`, return cached validated data without spending upstream budget.
- At/after the deadline, initiate or join one eligible refresh. Prefer waiting for that bounded refresh; if it fails/is denied, return the previous resource only while current time is strictly before `staleUntil`. Beyond grace, fail explicitly even when a previous payload is present.
- Check eligibility at response assembly, not only request arrival. Edge-cache retention may exceed serve eligibility for recovery, but must never authorize serving it.
- A successful response containing the same still-applicable forecast is a successful revalidation; a different newer issue is not required to satisfy the refresh deadline. Invalid, empty, mixed, or regressed products are not successful revalidations. Reject a product whose DATA BASED ON time regresses relative to the stored version; preserve current applicability validation.

Point-weather selection continues to require `useFrom <= plannedUtc < useUntil` and all existing applicability constraints. A two-minute retrieval grace cannot extend a FOR USE window, fabricate a forecast, or hide unavailable-cycle ambiguity. One expired required catalog also prevents a point answer. Catalog metadata gets the same short retrieval grace rather than the old seven-day fallback.

Supersede the old two-hour weather stale policy and seven-day catalog serving fallback. Remove conflicting tests/documentation instead of allowing legacy routes to retain a wider fallback accidentally.

## Failure, retries, and request lifetime

Keep the existing five-second upstream timeout and bounded payload readers. Permit at most two upstream fetches concurrently across distinct keys. Do not immediately retry within the same retrieval attempt. Queue at most one refresh job per resource (ten total); count the attempt at dispatch, not enqueue. A queued job has a ten-second start deadline; if not started, return unavailable and let a later admitted request retry. Public API requests wait at most 15 seconds for coordinator work and then fail explicitly; preserve or adjust browser timeouts to exceed that bound. Bound coordinator caller admission to 64 concurrent waiting requests; excess callers receive immediate structured unavailable/retry responses. Numbers are configurable server policy with finite validated bounds, not client inputs.

After network failures, 5xx, invalid payloads, or no-data responses, set a per-resource retry delay of 60 seconds, then 120 seconds, then 300 seconds for subsequent failures; cap further delays at 300 seconds. Success resets the sequence. No timers or alarms retry idle resources: a later request may trigger one eligible attempt. The eight-per-six-hour and daily ceilings bound prolonged outages even after cooldowns expire.

For 429, establish a provider-wide cooldown of at least 60 seconds. Honor a valid Retry-After delta/date if longer; handle malformed values with the default. Persist the deadline; overflow or unrepresentable delays fail closed and require an operator review rather than shortening the requested delay. The provider cooldown prevents new dispatches, but does not abort requests already dispatched or block fresh cached responses. Record concurrent completions conservatively so success does not erase an active provider cooldown.

Refresh leases last 30 seconds. An expired lease after restart counts as an uncertain failure and establishes the resource cooldown before a new dispatch. Keep attempt records and cooldowns across deployment/restart. No lease or retry deadline can reset `staleUntil`.

## Public contract and abuse admission

Keep per-source admission control. Require the limiter and coordinator bindings in both deployed environments and fail closed when required controls cannot be evaluated. Validate route/method/query before coordinator access. Unknown routes and removed TAF routes return bounded errors without AWC activity.

Keep existing API error vocabulary: provider-budget exhaustion, cooldown, coordinator failure, and wait/admission exhaustion return 503 `service_unavailable` or `upstream_unavailable` as appropriate, with a safe Retry-After header. Per-source admission denial remains 429 `rate_limited`. No internal URL, raw upstream error/body, stack trace, or arbitrary Retry-After string is echoed.

Extend point product cache provenance deliberately to support grace with `stale_on_error`/`stale` and explicit `checkedAt`, `refreshAfter`, and `staleUntil` metadata. Existing `expiresAt` means the refresh deadline, not forecast validity. `freshnessRemainingSeconds` is zero during grace; age continues from fetched time. Update Worker contracts, strict browser transport validation, and route sampling so eligible grace answers are accepted and explicitly marked as temporarily stale in the navlog/inspector. Never label them fresh. This is a narrowly required client compatibility change, not #55's caching implementation. Existing unchanged wind values and applicability constraints remain authoritative.

Catalog provenance must accompany point responses sufficiently to expose its independent check deadline and stale state; product-only freshness must not conceal stale catalog use. Use a typed catalog provenance field and validate it at the browser boundary. Do not expose catalog bodies to the browser.

API response caching remains no-store in this work unless an implementation plan justifies a narrowly scoped alternative; the internal edge resource cache must obey the coordinator's deadlines. Do not add arbitrary point-response caching.

## Cost and operability

Warm edge hits bypass coordinator requests. Edge misses incur a service-bound coordinator request and Durable Object invocation/storage work, but no additional upstream request while the authoritative resource remains fresh. Joining refreshes bounds upstream I/O, not total public request executions. A malicious caller can still cause Worker/coordinator execution within admission limits; deployment WAF/bot policy and #47/#55 address separate cost layers.

Document each environment's private coordinator deployment order, environment-specific bindings/namespace/object identity, SQLite migration, restart behavior, rollback, and policy version. Updating navlog alone must not provision a second authority within that environment. Development deployment, invalidation, or failure must not modify production state or bindings. Rollback must not restore unbudgeted direct fetches. Operator cache invalidation retains that environment's attempt history and does not bypass policy. Budget increases require reviewed configuration and never exceed the documented provider ceiling for an individual application; explicitly reassess the accepted cross-application throttling risk when changing limits.

Emit aggregate resource-kind counts for attempts, budget denials, refresh joins, success/failure class, cooldowns, cache/grace use, coordinator latency, and storage failures. No client IP, full route query, planning payload, raw weather body, or secret logs. Alert on sustained cooldown/budget exhaustion or coordinator failure. Report measured coordinator invocations, storage work, and request CPU during deployment validation; do not claim a currency estimate without current account pricing/usage evidence.

## Ordinary and boundary walkthroughs

Ordinary: two production users at different edges request different points in CONUS. Both map to the same three winds resources and catalog. Empty edges ask the production coordinator; each resource refresh dispatches once, consumes one production budget slot, validates, persists, and answers both callers. Subsequent requests use production edge resources until their refresh deadlines. Point interpolation remains specific to each request. If a later check returns identical valid data, checked deadlines advance but data timestamps/applicability do not. A development request independently uses the development coordinator and its own cache/budget, even for identical resources.

Boundary: a product becomes due at 12:00. The shared refresh fails at 12:00:05; all callers can use the prior applicable resource until 12:02, with stale provenance. At 12:01:05 an admitted caller may trigger the next attempt if all budgets allow. At 12:02 no caller can use grace, even if the forecast use window lasts several more hours. A successful check at 12:03 restores service. If the FOR USE window ended at 12:01, applicability rejects that forecast earlier, independently of grace. Repeated callers, edge misses, restarts, and cache-write failures never reset these deadlines or budget history.

## Acceptance and validation

- Independent clients/IPs and simulated edge caches within an environment share that environment's authoritative object and cannot exceed any rolling window, including just before/after boundaries, concurrent dispatch, restart, and storage faults.
- Within each environment, all callers use its one authority. Exhausting development budgets leaves production counters, cached resources, leases, and admission unchanged. Tests cover separate namespaces/bindings, independent identical-key refreshes, and development deployment/failure isolation; provider-side throttling remains an explicitly accepted external risk.
- All nine winds keys plus catalog have documented finite storage and queue bounds; arbitrary point parameters never increase resource cardinality. Catalog activity cannot consume winds allowance beyond the overall shared accounting.
- Cold concurrent callers refresh each key once; warm authoritative/edge hits consume no upstream budget. Cache read/write failures do not open a direct-fetch bypass.
- Tests cover failed/aborted fetch accounting, no-data, invalid/regressed payloads, 429 and Retry-After, provider-wide cooldown, queue/wait limits, abandoned leases, rejected waiters, and subsequent recovery.
- Tests cover successful identical revalidation, absent/expired data, fixed grace boundaries, independently expired catalog, applicability end, unavailable-cycle ambiguity, and stale provenance through transport and visible UI.
- Removed TAF route performs zero provider calls; remove its adapter/tests and obsolete claims while retaining unrelated TAF presentation types only if current consumers require them.
- No security controls, source validation, payload bounds, interpolation, pilot-input persistence, or runway-picker behavior regress.
- Run `mise exec -- npm run ci`, production/development Wrangler dry-runs, and coordinator tests using the Workers/Durable Objects runtime. Unit mocks alone do not establish cross-request I/O correctness.
- Deployment verification confirms each environment targets its own private coordinator and distinct namespace, and fails closed without its required binding. Exercise concurrency/outage/recovery with a mock provider in a controlled environment; do not load-test AWC. A small admitted live smoke verifies actual provider parsing and binding behavior, with attempt counts recorded separately per environment.
- Report validation limitations and measured execution overhead. Maintainer review of this spec precedes implementation planning.
