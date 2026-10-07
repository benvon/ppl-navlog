# Issue 55: exact-query browser session reuse

Approved scope: implement the small bounded session cache recommended after baseline measurement, using the architect/worker/reviewer workflow. No planner convergence engine, provider changes, durable weather storage, approximate queries, polling, or server abuse-control changes.

## Behavioral contract

- Preserve public adapter interfaces and production instances in main.ts. Reuse belongs inside WorkerAirportLookup and WorkerWindsClient; planner always recalculates current inputs.
- Keys: normalized airport/METAR identifier and complete winds URL after existing canonicalization. No additional rounding; location, altitude and planned UTC remain independent.
- Share identical active requests. Failed promises clear in finally. Bound active tracked keys; overflow may bypass tracking instead of retaining unbounded state.
- Retain only successfully validated payloads, bounded per adapter: 128 success entries and 1 MiB serialized UTF-8 payload bytes. A payload above the total limit is returned without retention. Evict expired entries then least recently used entries. Bound cooldown entries to 128 too. Clone at ownership boundaries so callers cannot mutate cached or shared results.
- Airport and METAR reuse require valid, fresh resource-specific provenance. Reuse deadline is the earliest of expiresAt, servedAt + freshnessRemainingSeconds, fetchedAt + maxPayloadAgeSeconds. Reject eligibility for negative/inconsistent timing or unrecognized resource/status/source. No invented common TTL. Invalid cache policy may preserve an otherwise usable initial airport result but must not retain it.
- Winds reuse ends at the earlier product/catalog refreshAfter deadline, with the existing strict point validator still run on reused answers. A server grace response can be returned on its initial request if existing validators accept it, but is not retained beyond refreshAfter. Forecast applicability is checked independently for the exact planned UTC. Never reinterpret forecast useUntil as retrieval TTL.
- On reuse, account for elapsed time in eligibility deadlines and decreasing freshnessRemainingSeconds; preserve server-snapshot ageSeconds because existing validators bind it to original servedAt; preserve fetchedAt, checkedAt, servedAt, expiresAt, refreshAfter, staleUntil, requestId and source/status. Never add a new source fetch time. No source provenance persisted.
- Errors and malformed responses never enter success retention. Honor valid Retry-After for unsuccessful responses on the exact request key, on later explicit calls only; support delta seconds and HTTP dates, capped at 86400 seconds to match Worker policy. Keep a small safe error representation, not the failed response body/promise. Without a valid Retry-After, permit immediate explicit recovery. No automatic retry loops/background timers; deadline comparisons are lazy.
- Session means adapter-instance lifetime: production instances survive plan switches, page reload/new instance starts empty. Save-before-Update and controller lock remain unchanged.

## Acceptance and verification

1. Transport tests: identical normalized requests join; changed keys independent; expiry boundaries, elapsed freshness, mutation isolation, grace nonretention, invalid provenance, malformed/mismatched responses, upstream failures, Retry-After expiry/recovery and bounded storage/in-flight state.
2. Planner DOM integration with actual adapters and deterministic fetch responses: direct and 25-checkpoint routes, initial/repeated/title/fuel/altitude/time/location edits, downstream sequential query propagation, identical worksheet calculations, plan switching/reload ownership and existing save/lock tests.
3. Record before/after request counts. Baseline direct: 2 airport + 1 METAR + 2 winds = 5; maximum: 2 + 1 + 27 = 30 each Update. Repeat/title/fuel all exact repeats; altitude/time only 3 repeated endpoints. Concurrent pairs: 6 calls / 3 unique keys. Describe reductions as requests, not billing.
4. Independent reviewer checks code and integrated flow; coordinator runs mise exec -- npm run ci, relevant Worker runtime checks where applicable and real browser verification. Record unavailable checks explicitly.

## Tasks and ownership

Task 1: transport worker owns src/services/request-reuse.ts (and tests), src/services/weather/winds-client.ts (and tests), src/services/airport/worker-airport-lookup.ts (and tests). May add focused fixture helpers. No planner/controller edits. Follow test-first changes and report red/green evidence.
Task 2: integration worker owns planner integration test additions and docs/issue-55/verification.md, adapting retained /private/tmp/issue-55-baseline.test.ts. Wait for Task 1 public behavior, do not change its service files. Exercise real adapters and current DOM actions; no controller refactor.
Task 3: architect independently reviews combined code, delegates a final reviewer, resolves findings and runs full checks/browser verification. No PR, merge, deployment or publication requested.

## Decisions

Ruling: treat previous approval of bounded session reuse and current 'let's do it' as implementation authorization; contract specifies existing issue requirements and reversible implementation choices.
Ruling: browser does not extend server stale grace; fresh-only success retention is the simplest correct implementation. Server may return agreed grace under existing validators.
Ruling: no arbitrary error cooldown; only valid server Retry-After creates a bounded explicit-call cooldown, preserving immediate recovery otherwise.

Ruling: original ageSeconds remains bound to servedAt; local elapsed time is reflected in remaining freshness and deadline checks. Altering source age while preserving servedAt would violate strict provenance validation.

Ruling: checked-in runway-picker source uses v1:airport:IDENTIFIER and v1:metar:ICAO provenance keys. Integration fixtures must represent that contract, rather than assuming older navlog-only synthetic keys. This is source inspection, not verification of deployed provider policy.
Ruling: Retry-After supports integer delta-seconds and canonical IMF-fixdate only. The existing Worker emits integer seconds; adding obsolete date grammars introduces unrelated parsing complexity. Unsupported date strings permit immediate explicit recovery rather than imposing a guessed cooldown.
