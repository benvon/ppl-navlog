# Architecture

PPL Navlog is a single TypeScript application deployed as one Cloudflare Worker with static assets. The Worker owns the same-origin `/api/*` boundary and serves the built Vite frontend from `dist/`. The browser keeps plans and aircraft profiles locally; no user account or server-side navlog store is part of V1.

The repository uses inward dependencies: `src/domain` contains pure calculation types and functions; `src/application` orchestrates domain use cases; `src/services` adapts browser storage, HTTP, import/export, and clocks; `src/ui` renders and collects user intent. Domain code must not import the DOM, storage, HTTP, Cloudflare, Worker, UI, application, or service modules. ESLint and `npm run lint:boundaries` enforce this constraint.

The Worker is deployed independently of `runway-picker` but uses its existing airport and METAR read contracts through a configured Cloudflare service binding. If that service is unavailable, these endpoints fail explicitly; there is no silent direct-upstream fallback. No Worker secret is available to browser JavaScript.

`npm run dev` starts Vite on port 5173 and a local Worker on port 8787. Vite proxies `/api/*` to the Worker, so development uses the same-origin API shape. `npm run dev:worker` builds `dist/` then runs the Worker as the combined static-assets and API server.

## API conventions

API routes are versioned by their transport schema before a breaking contract change, use `GET` unless an explicitly designed mutation needs another method, and reject unrecognized routes and methods. Every response carries `X-Request-Id`; a syntactically valid client-supplied UUID is propagated, otherwise the Worker generates one. Errors use `{ "error": string, "code": string, "requestId": string }`, never include tokens or raw upstream payloads, and use stable lowercase codes such as `invalid_request`, `not_found`, `method_not_allowed`, `upstream_unavailable`, and `rate_limited`.

Successful resource responses will include normalized resource fields plus a provenance object. That object will identify source, observed/fetched timestamp, cache status, and forecast validity where applicable. The application validates this transport shape at the HTTP adapter boundary and converts it to its own domain types; UI and domain modules do not consume raw JSON.

## Current adapter feasibility record

Local inspection of `../runway-picker` on 2026-09-21 establishes two compatible read contracts: `GET /api/airport?icao=XXXX` and `GET /api/metar?icao=XXXX`. Both accept four-character uppercase-normalized alphanumeric ICAO values and return JSON with a `cache` provenance object. Airport results include requested and canonical ICAO identity, name, municipality, country, elevation, coordinates, runways, frequencies, source, and fetch time. METAR results include canonical ICAO identity, raw report, parsed surface wind, source, fetch time, and observed time. The local source presently uses `airportdb` and `aviationweather` as the normalized resource sources.

This Worker exposes stable navlog routes `GET /api/airports/:icao` and `GET /api/weather/metar/:icao`, validates the evidenced payloads before mapping them, and rejects mismatched resource identity. `wrangler.jsonc` declares `RUNWAY_PICKER_API` bound to `runway-picker-metar-api`; deployment requires that service in the same Cloudflare account. Missing or unavailable binding returns a structured 503. Winds aloft comes from the Aviation Weather Center through the navlog Worker; the browser selects a forecast period before calculation.
