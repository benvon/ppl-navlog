# Adversarial security review - 2026-09-21

## Threat model

This is a public, zero-login application. Under issue #7, pilot input documents and aircraft profiles are browser-local and are not intentionally uploaded; the Worker sees only airport, METAR, and winds lookup parameters. Plan and profile import/export are out of scope before version 1.0. Trust boundaries are browser input, browser IndexedDB, upstream aviation products, the runway-picker service binding, Cloudflare cache, deployment configuration, and GitHub Actions credentials. The active planner uses a separate v2 input-only IndexedDB database and does not load or migrate the former v1 store. Plausible attackers include a malicious public API caller, a malicious or compromised upstream payload, and an actor with access to a deployment token or workflow edit. No review can guarantee that the application cannot be hacked; the findings below are release gates and risk reductions, not a security certification.

## Findings and status

| Severity | Finding | Status / action |
| --- | --- | --- |
| High | Public callers could drive upstream requests and exhaust provider capacity or incur cost. A per-source limit is not a global upstream quota. | Development config now binds `API_RATE_LIMITER` at 30 requests/minute and fails closed when unavailable. **Still open for production:** verify live 429 behavior, add a separate production namespace, and apply Cloudflare WAF/bot controls. |
| High | Static assets could bypass Worker-applied CSP and other security headers when Workers Static Assets serve files before the Worker. | **Fixed in code:** `assets.run_worker_first: true` routes asset requests through the Worker, and `assets.binding: "ASSETS"` lets the Worker fetch the files. Wrangler dry-run validated the binding. Must verify headers on deployed HTML and JS. |
| Medium | Upstream response size was checked after `response.text()`, allowing an untrusted chunked response without a truthful Content-Length to consume excessive memory. | **Fixed in code:** shared bounded streaming reader now caps bytes before buffering; tests cover a forged Content-Length. |
| Medium | The winds route query accepted 100 points but no total character limit, allowing oversized numeric strings to consume parsing time. | **Fixed in code:** route query capped at 4,096 characters before parsing. Add a deployed abuse smoke test. |
| Medium | Public dev and production deploy credentials and promotion path are not yet defined. A broad or PR-exposed token would allow unauthorized deployment. | **Open release blocker.** Use separate environment-scoped least-privilege tokens, protected production approval, pinned Actions, and deployment only from validated trusted refs. See `docs/github-ci-cd-setup.md`. |
| Medium | `RUNWAY_PICKER_API` availability and response shape have only mock/local functional tests. A missing binding fails with 503, but the live contract and failure behavior are unverified. | **Open validation gate.** Smoke-test exact-ICAO airport/METAR success and 503 behavior on dev before production. |
| Low | Browser print headers/footers may include the page URL by default. This is a local PDF privacy concern, not remote exfiltration. | **Documented:** users may disable browser headers/footers; print output itself is browser-local. |

## Positive controls reviewed

The UI places user-entered and upstream strings with `textContent`, not HTML interpretation. Plan and profile import/export controls and recovery formats are absent from the pre-1.0 scope. API paths and parameters are allowlisted; the Worker uses fixed Aviation Weather Center hosts and bounded request time. API responses are `no-store` with a restrictive CSP; static responses gain restrictive headers through the Worker-first routing change. Provider failures return generic client-visible errors. A current reachable `npm audit --audit-level=high` returned zero known vulnerabilities; this does not prove dependencies are free of unknown defects.

## Before a production deployment

Require passing CI and CodeQL on a protected main branch; verify the exact release SHA and artifact identity; inspect Cloudflare bindings, rate limits, routes, and headers; run invalid-input, oversized-input, unavailable-upstream, missing-service, and 429 tests against dev; run a browser XSS check with harmless sentinel markup; check no plan/profile payload reaches Worker logs; and confirm rollback can restore the previous version without touching browser-local data. Re-review these controls after any dependency, upstream-contract, Worker-route, or deployment-workflow change.
