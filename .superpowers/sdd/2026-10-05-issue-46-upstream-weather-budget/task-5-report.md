# Task 5 report: strict client compatibility and visible grace

## Delivered

- The browser winds client now requires exact product and catalog cache provenance, including AWC resource identity, key, TTL, payload-age limit, fetched/checked/served times, refresh deadline, and grace deadline. It validates the exact query and forecast-use interval, accepts eligible grace with zero freshness, and checks response receipt time against the deadline. METAR validation and its 10-second transport timeout are unchanged; point requests use a 20-second timeout.
- Route sampling rechecks every resource at the end of sequential route sampling, rejects invalid or expired product/catalog grace, and records independent product and catalog provenance. Eligible grace adds the required warning to the rendered navlog without duplicating that warning or removing other worksheet warnings.
- The Calculation Inspector identifies whether each resource used grace and shows separate checked, refresh, and grace-until timestamps. The ordinary and 25-checkpoint planner behavior is covered with current-schema fixtures.

## TDD evidence

Before production changes, the focused tests failed on the Task 4-required cache fields, point catalog metadata, eligible grace, and inspector provenance. After implementation and correcting a fixture's derived payload-age calculation, the focused suite passed: 4 files, 145 tests.

## Validation

- `mise exec -- npx vitest run src/services/weather/winds-client.test.ts src/application/route-weather-sampling.test.ts src/ui/calculation-inspector.test.ts src/ui/pilot-intent-planner.test.ts` — 4 files, 145 tests passed.
- `mise exec -- npm run typecheck` — passed.
- Scoped ESLint on the seven changed TypeScript source/test files — passed.
- `git diff --check` — passed.
- Actual isolated Chrome with the repository-bundled Playwright runtime, local airport data, and mocked in-memory weather responses — ordinary and 25-checkpoint routes each passed fresh and grace modes and visibly rejected expired winds grace. Grace mode rendered a navlog; the browser assertions verified the required warning and distinct product/catalog Inspector provenance and deadlines. Screenshots: `.worktrees/task5-browser-proof/{ordinary,maximum}-{fresh,grace,expired}.png`. No AWC requests were made. The UI harness injected the weather client; strict `WorkerWindsClient` HTTP payload validation is separately covered by its focused tests.

## Changed files

- `src/services/weather/winds-client.ts` and `src/services/weather/winds-client.test.ts`
- `src/application/route-weather-sampling.ts` and `src/application/route-weather-sampling.test.ts`
- `src/ui/calculation-inspector.ts` and `src/ui/calculation-inspector.test.ts`
- `src/ui/pilot-intent-planner.test.ts`

## Interface handoff

Task 4's required point-answer shape remains `product.cache` plus independent `catalog.cache`; no fields were made optional. Product provenance uses `resource: "winds-temps"` and key `winds:${region}:${cycle}`; catalog uses `resource: "station-catalog"` and key `station-catalog:v1`. The existing `fetchPoint(query): Promise<AloftPointAnswer>` API is unchanged. Sampling emits resource-level provenance and the grace warning through the existing worksheet/navlog interfaces. No durable weather storage or API reuse layer was added.
