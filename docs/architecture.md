# Architecture

PPL Navlog is a single TypeScript application deployed as one Cloudflare Worker with static assets. The Worker owns the same-origin `/api/*` boundary and serves the built Vite frontend from `dist/`. The browser stores pilot input documents and aircraft profiles in a versioned v2 IndexedDB database; no user account or server-side navlog store exists. The v2 planner does not load or migrate the former v1 database. Airport and weather responses and calculated navlog output are session-only and are not written as durable plan history.

The repository uses inward dependencies: `src/domain` contains pure calculation types and functions; `src/application` orchestrates domain use cases; `src/services` adapts browser storage, HTTP, and clocks; `src/ui` renders and collects user intent. Plan and profile import/export are out of scope before 1.0. Domain code must not import the DOM, storage, HTTP, Cloudflare, Worker, UI, application, or service modules. ESLint and `npm run lint:boundaries` enforce this constraint.

The Worker is deployed independently of `runway-picker` but uses its existing airport and METAR read contracts through a configured Cloudflare service binding. If that service is unavailable, these endpoints fail explicitly; there is no silent direct-upstream fallback. No Worker secret is available to browser JavaScript.

`npm run dev` starts Vite on port 5173 and a local Worker on port 8787. Vite proxies `/api/*` to the Worker, so development uses the same-origin API shape. `npm run dev:worker` builds `dist/` then runs the Worker as the combined static-assets and API server.

## API conventions

API routes are versioned by their transport schema before a breaking contract change, use `GET` unless an explicitly designed mutation needs another method, and reject unrecognized routes and methods. Every response carries `X-Request-Id`; a syntactically valid client-supplied UUID is propagated, otherwise the Worker generates one. Errors use `{ "error": string, "code": string, "requestId": string }`, never include tokens or raw upstream payloads, and use stable lowercase codes such as `invalid_request`, `not_found`, `method_not_allowed`, `upstream_unavailable`, and `rate_limited`.

Successful resource responses will include normalized resource fields plus a provenance object. That object will identify source, observed/fetched timestamp, cache status, and forecast validity where applicable. The application validates this transport shape at the HTTP adapter boundary and converts it to its own domain types; UI and domain modules do not consume raw JSON.

## Current adapter feasibility record

The `runway-picker` airport and METAR read contracts are `GET /api/airport?icao=<airport-code>` and `GET /api/metar?icao=<ICAO>`. The `icao` parameter name is historical: airport lookup accepts exact uppercase-normalized three- or four-character FAA LID or ICAO identifiers without adding a prefix, while METAR lookup still requires a four-character ICAO identifier. `runway-picker` added the airport contract in [PR #106](https://github.com/benvon/runway-picker/pull/106); release [v0.13.1](https://github.com/benvon/runway-picker/releases/tag/v0.13.1) contains it, and its production Worker deployment completed successfully. Airport results include requested and matched identity, name, municipality, country, elevation, coordinates, runways, frequencies, source, fetch time, and cache provenance. METAR results include ICAO identity, raw report, parsed surface wind, source, fetch time, observed time, and cache provenance. The normalized sources are `airportdb` and `aviationweather` respectively.

This Worker exposes stable navlog routes `GET /api/airports/:icao` and `GET /api/weather/metar/:icao`, validates the evidenced payloads before mapping them, and rejects mismatched resource identity. `wrangler.jsonc` declares `RUNWAY_PICKER_API` bound to `runway-picker-metar-api`; deployment requires that service in the same Cloudflare account. Missing or unavailable binding returns a structured 503. Winds aloft comes from the Aviation Weather Center through the navlog Worker; the browser selects a forecast period before calculation.

The development deployment smoke must resolve `1C8` through `/api/airports/1C8` after checking static/API build identity and before creating an RC tag. It requires matching airport identity, usable coordinates and field elevation, and `runway-picker` provenance. This is a live service-binding check; local mock tests and a successful upstream release alone do not prove the deployed integration.
