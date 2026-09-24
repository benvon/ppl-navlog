# Weather Worker bugfix specification

This specification covers issues #2, #3, and #4. The existing station-based, single-period planning model remains in scope. Route-aware sampling and persistence redesign in #9 and #7 remain separate.

## Shared constraints

- Keep the existing fixed Aviation Weather Center origin, bounded responses, timeouts, region validation, cache freshness and provenance, and public error envelope.
- Do not silently select a different station, forecast period, or cycle. Preserve the browser's deterministic nearest-station selection and the pilot's explicit period choice.
- A discovery response may contain only validated, coordinate-verified stations and published periods. Its station-to-period relationship must be explicit and bounded at both Worker and browser boundaries.
- Preserve fail-closed behavior for ambiguous or unavailable exact matches. Treat unavailable upstream products as incomplete availability, never as proof that a product does not exist.

## #2: Station-scoped discovery availability

**Problem:** Discovery currently intersects periods across all stations. A missing period at an unrelated station hides a valid period at the selected station.

**Required behavior:** Return validated availability per station in the discovery contract. After choosing the deterministic nearest station, the planner offers only that station's published periods, and calculation validates its selected period against that same station. Do not use a regional union or intersection as a substitute for station-specific availability. Keep ordering deterministic by valid time and cycle, and reject duplicate or conflicting entries for one station/valid time rather than presenting an ambiguous choice. A station with no usable periods cannot be offered as a selectable wind source.

**Tests:** With ABQ period 12 present and distant ATL period 12 absent, an ABQ route offers and calculates period 12. An ATL route does not offer period 12. A forged selection for ATL period 12 fails before forecast retrieval. Verify malformed station-period identity and ambiguous duplicate records are rejected. Existing single-station fixtures continue to work through the revised contract.

## #3: Isolate unrelated cycle failures

**Problem:** Loading 06, 12, and 24 through one rejecting `Promise.all` makes an unrelated product failure block a valid exact forecast.

**Required behavior:** Load each supported cycle with bounded independent handling. Discovery returns validated availability from successful cycles, with provenance only for products actually served. Exact lookup returns a unique validated station/valid-time match from successful cycles even if another cycle failed or returned no data. If no match exists and any cycle failed, return an explicit unavailable/inconclusive error rather than claiming the selected period is absent. If all cycles succeeded and no match exists, retain the no-data error. If multiple matches exist across successful cycles, fail closed as ambiguous. Do not convert malformed source content into a successful product.

**Tests:** A valid 06 request succeeds when 12 fails or returns 204. Discovery still lists 06 from a valid product. A missing requested time with an unavailable cycle returns an unavailable/inconclusive error; a missing time with all cycles healthy returns no-data. Duplicate matching products remain rejected. Verify cache and source provenance correspond to successful products only.

## #4: Cache read faults fall back to upstream

**Problem:** Rejected `CacheStore.match` calls currently abort before a healthy upstream fetch, both for wind products and the station catalog.

**Required behavior:** Treat cache match, read, parse, and validation faults as cache misses for both resources. Continue through the existing bounded upstream retrieval and validation. Successful upstream data must retain `upstream_refresh` provenance; never label it as a cache hit or stale result. Existing best-effort cache-write behavior and stale-on-error behavior for a successfully read, still eligible cached product remain intact. If the cache read failed and upstream also fails, return the upstream error without inventing stale data.

**Tests:** Throwing `match` plus healthy upstream succeeds for exact forecast and station discovery, including catalog lookup. Throwing `match` plus failing upstream surfaces an unavailable error. Invalid cached JSON falls through to upstream. A valid cached product still serves a fresh hit and retains the bounded stale-on-error path when appropriate.

## Validation and completion

Run focused Worker and browser adapter tests, typecheck, lint, boundary lint, the full test suite, build, and secret scan. Review the final diff for unrelated behavior changes. The three issues close only after the corresponding regression tests and contract checks pass.
