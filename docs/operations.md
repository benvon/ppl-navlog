# Operations

The intended development domain is `navlog.benvon.dev`; production is `navlog.benvon.net`. Neither domain is configured or deployed by this repository yet. See `docs/github-ci-cd-setup.md` for required GitHub and Cloudflare setup, `docs/release-readiness-audit.md` for milestone status, and `docs/security-review.md` for the deployment blockers.

No Cloudflare deployment was performed as part of the local data-layer implementation. The Worker serves a prebuilt static artifact and exposes `GET /api/health`. Its non-sensitive response contains status, build version, commit SHA, and request ID. The UI displays the static build identity. Deployment requires the `RUNWAY_PICKER_API` service binding target `runway-picker-metar-api` in the same account; local mock tests do not validate that production binding.

CI runs type checking, linting, architecture checks, test coverage, build artifact verification, secret scanning, workflow validation, dependency auditing, and CodeQL. Pull-request preview deployment must consume a validated immutable artifact and use a least-privilege preview environment; it must not rebuild untrusted pull-request code with deployment credentials. Production deployment requires a protected environment, a conventional versioned release, a release artifact tied to the deployed SHA, documented rollback, and smoke checks for static assets, health response, headers, and build identity.

Worker observability must be aggregate-only: request counts, latency, status/error code, upstream identity, cache status, and request ID are allowed. Do not log complete navlogs, imported payloads, provider tokens, or browser-local profile data.

## Aviation Weather Center operating limits

The winds adapter calls only `https://aviationweather.gov/api/data/windtemp` and `https://aviationweather.gov/api/data/stationinfo`. The AWC Data API currently documents a 100-requests-per-minute limit, no browser CORS, maximum 400 entries for most endpoints, and the requirement to use documented parameters. The Worker is the CORS and policy boundary: it never exposes an upstream token (none is required), allowlists its own route parameters, uses a custom User-Agent, limits upstream text to 512 KiB, and aborts requests after five seconds.

Deployments must configure the Cloudflare rate-limit binding for API traffic. It must enforce a per-source key and a policy materially below AWC’s 100 requests/minute ceiling, with a 429 response from the Worker when denied. The current application policy relies on the 20-minute edge cache for the three forecast-cycle products and allows a cached product to be served as `stale_on_error` only until it is two hours old. An upstream outage with no eligible cache must remain a structured 503; it must not manufacture a forecast or replace a saved browser-local weather snapshot.

The Worker must not log raw weather-product bodies, complete route query strings, client IP addresses, or browser-local planning data. It may record aggregate cache state, route kind, upstream status class, duration, and request ID.
