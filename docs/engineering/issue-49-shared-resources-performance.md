# Issue 49 shared weather resource benchmark

Run the hermetic before-and-after benchmark with:

```sh
mise exec -- node --expose-gc scripts/benchmark-winds-cache.mjs
```

The harness archives the complete Worker tree at baseline commit `a616ec5ad4e3a386106c4e6d7c50f4581bcc797d`, compiles that and the current Worker entry point into temporary directories, and invokes each `default.fetch` path with production-mode bindings. It fixes the clock at `2026-10-06T12:00:00.000Z` and asserts that both winds and catalog provenance use that time. The edge cache is a hermetic mock populated with validated fresh `WeatherResourceEnvelope` JSON. The coordinator binding throws on every call, and global `fetch` also throws; the benchmark observed zero calls to either provider. Cache writes were zero.

Each fixture has three regional winds products with 120 station forecasts and nine validated decoded levels per station. Each product has a 12,000-character opaque raw-product field. Catalogs have either 250 or 10,000 unique station entries. The 250-entry catalog is a synthetic representative-size assumption, not a measured live catalog; 10,000 entries exercises the bounded catalog case. These are cached-shape JSON fixtures. The raw product field is synthetic opaque text, so the benchmark measures cache JSON parsing, validation, retained-resource lookup and point assembly, not upstream decompression or official product decoding. Five point calls make the ordinary route series; 28 calls make the maximum route series with endpoints and generated points. Three route series are measured per row.

| Catalog entries | Point calls per route series | Cache reads before → after (three series) | Cache JSON bytes parsed before → after (three series) | Local process CPU ms before → after | Wall time ms before → after | Mean Worker fetch ms before → after |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 250 | 5 | 60 → 4 | 7,943,685 → 529,579 | 64.60 → 16.19 | 47.11 → 12.21 | 3.14 → 0.81 |
| 250 | 28 | 336 → 4 | 44,484,636 → 529,579 | 236.47 → 55.95 | 215.74 → 32.56 | 2.57 → 0.39 |
| 10,000 | 5 | 60 → 4 | 28,117,620 → 1,874,508 | 135.84 → 38.01 | 117.44 → 23.78 | 7.83 → 1.59 |
| 10,000 | 28 | 336 → 4 | 157,458,672 → 1,874,508 | 656.06 → 65.37 | 593.64 → 42.93 | 7.07 → 0.51 |

The cache read count is the number of `CacheStore.match` calls. Before sharing validated resources across requests, each point call reads and parses three winds products and the catalog: 20 reads for a five-point series or 112 for 28 points. After the change, the first request reads those four edge entries and every subsequent request reads zero. Across three measured series the totals are therefore four reads after the change, versus 60 or 336 before it. The four fixture JSON bodies total 529,579 bytes with 250 catalog entries and 1,874,508 bytes with 10,000 entries. Each winds body is 165,071 bytes; the catalog body is 34,366 or 1,379,295 bytes.

The shared-store snapshot reported four entries and 529,579 or 1,874,508 retained serialized bytes. Those counts are UTF-8 JSON byte sizes used by the retention budget; they do not include the in-memory object graph, catalog index, Map/WeakMap structures or allocator overhead. The Node heap delta after forced garbage collection was about 0.63–0.69 MB for the 250-entry case and 5.14–5.17 MB for the 10,000-entry case. It is a local estimate of this Node process's additional retained heap, including the catalog identity index. Heap deltas can vary with the runtime and garbage collector.

Each measured winds product is 165,071 serialized bytes against the 512 KiB per-winds-resource cap. The 10,000-entry catalog is 1,379,295 bytes against the 3 MiB catalog cap. The fixed supported set is nine winds products plus one catalog per environment, matching the ten-resource slot limit; the bounded fixture totals 1,874,508 bytes against the 8 MiB per-environment serialized cap. These caps bound serialized retention, not actual Worker heap use or the memory cost of the identity index. A valid over-cap envelope remains usable for the current request and is left out of shared retention.

CPU and wall time are local Node measurements around the Worker request and response path. They include response construction and JSON parsing in the harness; diagnostic `console.info` output is suppressed so log I/O does not dominate these small runs. TypeScript compilation, fixture construction, and a separate JavaScript warmup are outside the timed interval. These values do not predict or report Cloudflare billed CPU. The harness did not run in workerd and did not measure deployed Cloudflare memory. Those Cloudflare metrics remain unavailable from this run. It used production environment semantics and mocked providers only; it made no production requests and performed no deployment. Fixture timestamps encode the configured 60-minute winds refresh interval, 24-hour catalog interval, and 120-second stale window. The benchmark exercised fresh cache hits; grace/error behavior was not timed.
