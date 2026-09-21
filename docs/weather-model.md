# Weather Model

The independent Worker will expose exact-ICAO airport lookup, METAR, winds-station discovery, and winds forecast routes under `/api/*`. It allowlists methods and routes, validates parameters, uses fixed upstream hosts, bounds time and response size, assigns a request ID, and returns structured non-sensitive errors. Future adapters may use compatible `runway-picker` airport and METAR contracts where their fields and freshness behavior meet this application’s needs.

The currently implemented airport and METAR adapter applies a five-second timeout, rejects non-successful upstream responses, limits decoded response bodies to 256 KiB, validates JSON shape and identity, and maps failures to non-sensitive 502/503 responses. It makes no network request until a configured binding receives a browser request; all tests use local fixtures and fake service fetchers.

V1 chooses the nearest available winds-aloft station by an explainable documented rule, then interpolates winds by altitude in vector form. Climb and descent use a sampled vector average across the applicable altitude range. The pilot selects the departure time in UTC and an available forecast-valid period explicitly; the application must not silently substitute an out-of-range forecast.

Worker cache provenance distinguishes fresh, stale-while-refresh, and stale-on-error data. The detailed implementation will document TTLs, rate limits, upstream timeouts, cache-key inputs, and the user-facing stale-data behavior before live upstream calls are introduced.
