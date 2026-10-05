# Task 4 report: public weather API resource port

## Delivered

- Public winds endpoints now consume `WeatherResourcePort`; the browser-facing Worker has no direct AWC weather fetch path. Resource reads use the private service binding at the fixed coordinator URL, a 15-second request-scoped deadline, strict resource validation, and optional environment-isolated fresh-only edge cache acceleration.
- Weather answers carry AWC `checkedAt`, `refreshAfter`, and `staleUntil` provenance. Age remains based on `fetchedAt`; TTL describes `checkedAt` through `refreshAfter`. Catalog provenance is independent on point and legacy responses. Product and catalog are loaded concurrently and eligibility is checked again at answer assembly.
- Cache faults fall through to the coordinator. Typed coordinator retry deadlines produce bounded positive `Retry-After` headers. Worker API admission fails closed for unsupported/missing environment and missing limiter/coordinator controls.
- Removed the public TAF route, handler, adapter, and tests. Retained unrelated TAF presentation types. Wind parsing, geography, point selection, and interpolation remain in the adapter.
- Added public-Worker-to-service-binding-to-SQLite-DO integration coverage with mocked upstream, plus resource client and answer-boundary tests.

## TDD evidence

Before implementation, existing API behavior returned HTTP 502 for a production request with missing limiter instead of expected 503, and returned HTTP 200 for the removed TAF route instead of expected 404. The new resource-client tests initially failed to resolve the not-yet-created module. These were behavioral REDs before implementation.

## Validation

- `mise exec -- npm test -- --run worker/api.functional.test.ts worker/index.test.ts worker/api/weather-resource-client.test.ts worker/api/winds.test.ts worker/api/winds-point.test.ts worker/api/handlers.test.ts worker/api/response.test.ts` — 7 files, 69 tests passed.
- `mise exec -- npm test -- --run worker/api/winds-point.test.ts worker/api/weather-resource-client.test.ts worker/index.test.ts worker/api.functional.test.ts` — 4 files, 46 tests passed after final boundary changes.
- `mise exec -- npx vitest run worker` — 16 files, 95 tests passed, including the catalog grace-policy expectation update.
- `mise exec -- npm run test:workers` — 4 runtime files, 30 tests passed; the public API → service binding → SQLite coordinator → mocked upstream path is exercised.
- `mise exec -- npx eslint worker/api worker/index.ts worker/index.test.ts worker/weather-coordinator/runtime-harness.ts worker/weather-resources --max-warnings=0` — passed.
- `git diff --check` — passed.
- `mise exec -- npm run typecheck` — Worker files typecheck; repository typecheck still reports three Task 5-owned frontend fixture errors: `src/application/route-weather-sampling.test.ts:36` and `src/services/weather/winds-client.test.ts:13` need the required weather freshness metadata fields; `src/ui/pilot-intent-planner.test.ts:65` needs `catalog.cache` on its point answer fixture. No product/client fixtures were changed in Task 4.
- The first `mise exec -- npm run lint -- worker` attempt raced a temporary test directory being removed during full-repository ESLint traversal (ENOENT). The direct scoped ESLint command above passed.

## Boundaries and follow-up

- Runtime tests use the repository's Miniflare compatibility date; deployment compatibility date reconciliation remains Task 7. No deployment or live AWC calls were performed.
- Public API request handlers require `APP_ENV` to be exactly `development` or `production`, `API_RATE_LIMITER`, and `AWC_COORDINATOR_API` for weather routes. Task 6 owns root-local wiring.
- The returned cache provenance contract now requires `checkedAt`, `refreshAfter`, `staleUntil`, `ttlSeconds`, `maxPayloadAgeSeconds`, `key`, and `resource`; point answers also require `catalog.cache`. Task 5 should update test fixtures without making these fields optional.

## Task 4 fix round 1

### Regression evidence

- RED before the fix: `mise exec -- npm test -- --run worker/api/weather-resource-client.test.ts worker/api/winds-point.test.ts worker/api/winds.test.ts` — 3 files, 6 regressions failed (48 other tests passed). The failures showed hanging `cache.match`, cache body reads, and ignored-abort coordinator fetches; point and legacy forecast returned successful answers after an unchosen cycle expired.
- Cache-write fixture correction: the initial generic test did not enter the fresh-resource cache-write path. The corrected test asserts `writeStarted === true`; running it against the pre-fix committed client (`mise exec -- npm test -- --run worker/api/weather-resource-client.test.ts -t 'bounds a hanging cache write'`) failed by timing out at 5 seconds while awaiting the unresolved cache write.

### Fix and verification

- The 15-second request deadline now races each awaited cache lookup, cache body read, coordinator fetch, and coordinator body read against the same monotonic/wall deadline. Coordinator abort and stream cancellation are best-effort and non-blocking; late fetch responses have their bodies canceled. Fresh edge writes have a tracked race against that same deadline, consume/log failures, and attempt response-body cancellation on timeout without holding the public response open. `CacheStore.put` has no cancellation signal, so the underlying platform write can remain pending until the runtime settles it; the client stops waiting and owns its timeout cleanup only until the shared deadline.
- Point and legacy forecast answer assembly now rechecks every successful cycle resource, not only the selected cycle. Returned age, remaining freshness, and served time are recomputed at assembly.
- `mise exec -- npm test -- --run worker/api/weather-resource-client.test.ts worker/api/winds-point.test.ts worker/api/winds.test.ts` — 3 files, 57 tests passed after final cache-write ownership changes.
- `mise exec -- npm run test:workers` — 4 runtime files, 30 tests passed after final cache-write ownership changes.
- `mise exec -- npx eslint worker/api/weather-resource-client.ts worker/api/weather-resource-client.test.ts worker/api/winds.ts worker/api/winds-point.test.ts worker/api/winds.test.ts worker/api/winds-test-resources.ts --max-warnings=0 && git diff --check` — passed.
- `mise exec -- npm run typecheck` — same three Task 5 frontend fixture errors as previously documented; no Worker TypeScript errors.
- `git diff --check` — passed.
