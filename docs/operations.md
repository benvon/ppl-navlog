# Operations

Cloudflare deployment is intentionally deferred until the aviation-data adapter and trusted preview implementation are ready. The deployed Worker will serve a prebuilt static artifact and expose `GET /api/health`. Its non-sensitive response contains status, build version, commit SHA, and request ID. The UI displays the static build identity.

CI runs type checking, linting, architecture checks, test coverage, build artifact verification, secret scanning, workflow validation, dependency auditing, and CodeQL. Pull-request preview deployment must consume a validated immutable artifact and use a least-privilege preview environment; it must not rebuild untrusted pull-request code with deployment credentials. Production deployment requires a protected environment, a conventional versioned release, a release artifact tied to the deployed SHA, documented rollback, and smoke checks for static assets, health response, headers, and build identity.

Worker observability must be aggregate-only: request counts, latency, status/error code, upstream identity, cache status, and request ID are allowed. Do not log complete navlogs, imported payloads, provider tokens, or browser-local profile data.
