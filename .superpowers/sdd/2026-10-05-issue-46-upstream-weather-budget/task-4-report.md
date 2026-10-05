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
