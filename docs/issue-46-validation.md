# Issue 46 weather budget validation

This report records local implementation evidence for the approved #46 design and incorporated #48 behavior. It does not claim a deployment, live Cloudflare binding, live AWC request, or production smoke. #49 parsing optimization and #55 browser response reuse remain outside scope.

## Changes and integrated behavior

- The private edge resource envelope is now cacheable by the Workers Cache API. Its bounded `max-age` is computed from the validated resource `refreshAfter` and current time, retaining the one-hour winds and 24-hour catalog policies. Public weather API responses still return `Cache-Control: no-store`.
- The edge write uses the Worker execution context's `waitUntil` when available, and stays bounded by the existing request deadline. Unit callers without a context remain supported. The platform Cache API has no cancellation method for an in-flight `put`; on timeout the caller stops waiting, records the fault, and attempts response-body cleanup, while the platform write itself may settle later.
- The public two-application Miniflare test proves a first development response causes four coordinator resource calls; after its legitimate response/waitUntil completion, a second public request leaves coordinator and upstream counts unchanged and retains `no-store` on the public response.
- The two isolated dev/prod stacks use separate public Workers, service bindings, coordinator Workers, SQLite Durable Objects, and test state. Two requests within each application join the same resource work; equivalent requests in the other application perform their own refreshes. The test holds each mock upstream behind a release barrier, checks that completed-upstream counts do not advance before release, then releases both applications and awaits all four public responses. Test controls exist only in runtime harness modules, not the deployed coordinator artifact.
- The development exhaustion case performs four actual persisted catalog dispatches that fail with provider 429 responses, with waits that clear the progressive per-key cooldowns. An immediate retry during provider cooldown causes no dispatch. After the fourth key cooldown expires, another catalog attempt is denied by the rolling catalog cap and the mock upstream count stays unchanged. Production catalog/resource state remains fresh and unchanged. This uses actual requests; no attempt history is preseeded.
- After a successful persistent reservation, the coordinator emits bounded `attempt_started` aggregate telemetry before provider dispatch. It carries the event kind only, without caller, key, or response payload.

## Validation results

- `mise exec -- node --version`: `v22.19.0`.
- `mise exec -- npm run ci`: passed after the locked dependency overrides; typecheck, ESLint, architecture boundaries, 497/497 coverage tests, static build/artifact verification, secret scan, workflow lint, and registry-enabled audit all passed. Global V8 coverage was 87.89% statements, 80.69% branches, 93.07% functions, and 93.46% lines. No threshold was changed and production coordinator/store/upstream code remains included. Only test-only runtime harness/tooling/fixture files are excluded. Six existing direct Node upstream tests were moved to Node-environment coverage instead of being treated as Workerd tests. A small test-only Node SQLite adapter adds three meaningful persistent-store cases using Node 22's built-in `node:sqlite`.
- `mise exec -- npm run test:workers`: passed, 3 files and 26 tests on Wrangler-bundled Workerd at compatibility date `2026-09-21`. The six upstream tests in `worker/weather-coordinator/upstream.test.ts` run under Node, not Workerd. The final changed public integration file was also rerun separately after the barrier and exhaustion assertions were corrected: 1 file, 3 tests passed. The final integration file therefore has direct focused evidence in addition to the full runtime-suite run.
- `mise exec -- npm run weather:bindings`: passed; development and production bindings are private and isolated.
- The local static build, coordinator bundle build, and `weather:artifact` identity/hash verifier passed with the same explicit test SHA/version. The four Wrangler `--dry-run` bundles passed: navlog development, navlog production, coordinator development, coordinator production. App outputs named their matching environment coordinator; coordinator outputs exposed only the private Durable Object binding. These were dry-runs only.
- The verified stable Miniflare package remains pinned at `4.20260730.0`; tests select the already Wrangler-bundled newer Workerd executable to run at the deployed compatibility date `2026-09-21`. The test harness lazily initializes its fake clock from captured native time after Workerd module initialization. Production dates and time policy were not altered.
- The existing browser evidence is injected-client UI testing with mocked weather responses: ordinary and 25-checkpoint route flows covered fresh, grace, and expired states. It verifies the visible grace warning and product/catalog Inspector provenance, but does not exercise real browser-to-Worker HTTP payload validation; that contract is covered by client tests. No AWC request was made in browser tests.
- Local test durations (focused final integration: about 1.1 seconds; full runtime suite: about 16 seconds) are execution observations only, not Cloudflare latency or billing measurements. The Worker tests exercise persistent SQLite accounting, all rolling-window denial cases, cooldown/restart/lease recovery, queue and waiter caps, and mock attempt counts. Per-statement production storage latency and deployed memory/billing were not measured.
- `npm install` applied narrowly scoped overrides for Miniflare's vulnerable `sharp` (`0.35.2` to `0.35.4`) and `undici` (`7.28.0` to `7.29.1`) transitives. Registry-enabled `mise exec -- npm run security:audit` then reported zero vulnerabilities. The existing Wrangler-nested Miniflare package already carried patched versions. This retained stable Miniflare 4 and added no dependency or major upgrade.
- The test-only coordinator clock can be explicitly advanced or sequenced; the test harness separately initializes to native current time. Production code uses runtime time. The mock tests do not establish real AWC release timing or deployed timer behavior.

## Scope and remaining release evidence

There was no deployment, merge, push, PR, production-domain smoke, or live AWC probe. Dry-runs and local Workerd tests do not verify account bindings, deployed permissions, provider behavior, aggregate telemetry delivery, or production billing. A protected release handoff still needs normal artifact selection/identity verification, deployed binding checks, controlled mock-provider concurrency, and—if separately authorized—a small admitted live parsing smoke in both environments. The `Cache.put` cancellation limitation described above remains a platform constraint.

Task 2 implementation began before its operational runtime harness was usable. Its ledger explicitly records that strict preimplementation RED/GREEN sequencing was not achieved for every behavior; later review regressions have RED/GREEN evidence, but that original process gap is preserved here rather than retrospectively claimed away. The compatibility gap was resolved for local integration by using Wrangler's bundled Workerd at `2026-09-21`; stable Miniflare's own older runtime remains pinned and the production compatibility date remains unchanged.

## SDD ledger rulings and cost if wrong

The following approved rulings are retained verbatim from the SDD progress ledger:

> Ruling: Task 2 may add a test-only Durable Object harness to exercise storage before the production Task 3 entrypoint exists — resolves setup dependency while retaining runtime evidence — wrong choice costs harness cleanup, not relaxed controls.

> Ruling: Use shared snapshot/port types in contract.md as authoritative task interfaces; return unavailable operator-required cooldown via a bounded retry indication while preserving indefinite fail-closed state internally — prevents unsafe timestamp coercion — wrong choice costs response contract refinement.

> Ruling: Use direct Miniflare runtime tests rather than @cloudflare/vitest-plugin — npm metadata for 1.3.6 requires Vitest ^4.1 while repository uses 5.0.1 — costs a small runtime harness, avoids unrelated downgrade. Stable Miniflare 4.20260730.0 supports Node >=22; avoid latest alpha.

> Ruling: Add trusted explicit nowMs to publishResource and completion clock callback to fetchWeatherResource — reviewed lease/time failures require actual completion/current time — wrong choice costs dependent interface adjustment.

> Ruling: Coordinator deployment compatibility date matches approved existing app2026-09-21 rather than newly introduced2026-10-05 — preserves established platform baseline — wrong choice costs a reviewed future date update.

> Ruling: Task4 resource client takes an explicit application environment alongside its port/cache/clock dependencies so internal cache keys unambiguously include development or production — spec requires cache isolation but planned constructor omitted identity — wrong choice costs a small constructor/test adjustment. No caller-supplied environment or implicit production default.

> Ruling: Resource transport client is request-scoped and shares one absolute15s deadline across products/catalog — public wait bound must not stack across multiple resources; existingindex constructsadapterperrequest — wrongchoice costs constructor/lifetime contract revision iffuturecallersreuseclient. Requiredresources mayloadconcurrently; nofrontendresponsecache.

> Ruling: The Task7 integration review and whole-branch final review will be one review dispatch with both explicit verdicts and the full branch diff — Task7 is the integrated verification handoff, so this avoids duplicating the same final review while preserving whole-branch scrutiny — wrong choice costs a separate review pass if the combined gate misses task-specific evidence.

The handoff reports from Tasks 2, 4, and 5 were scratch process records, not durable design artifacts; their relevant runtime, deadline, browser-injection, and TDD limitations are summarized above. They are removed from the tracked tree after transferring this evidence. The parent-owned modified Task 5 report remains physically untouched for parent cleanup.
