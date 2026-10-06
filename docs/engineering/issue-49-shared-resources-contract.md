# Issue 49: approved behavioral contract on current main

Baseline: a616ec5ad4e3a386106c4e6d7c50f4581bcc797d. Optimize the validated resource client while preserving the issue 46 coordinator as refresh authority.

Reuse completed validated immutable weather envelopes and a catalog identity index across requests in one Worker isolate. Keep forecast selection, geographic filtering, duplicate checks, coordinator authority, provenance, request deadlines, and API/security controls unchanged.

- Fixed versioned resources only: nine supported winds region/horizon keys and station-catalog:v1. Development and production state remain separate; injected coordinator/cache binding contexts must not share unrelated state.
- Retain at most 512 KiB serialized data per winds envelope, 3 MiB per catalog envelope, 8 MiB aggregate per environment and ten resource slots. Existing upstream/transport byte limits remain unchanged. Valid larger resources remain usable without retention.
- Deeply freeze canonical resource records; consumers cannot mutate retained graphs. Bind the identity index to the exact retained catalog entries array; unretained/grace resources use the existing catalog scan. Replace it whenever its catalog changes.
- Return local hits only while checkedAt <= now < refreshAfter. Never extend refreshAfter/staleUntil or cache a coordinator failure/grace decision as fresh. Expiry follows the current edge/client/coordinator path. Preserve final response-time eligibility checks and the coordinator's fixed grace deadline.
- Global state contains completed plain data and bounded publication timestamps only. No promises, Response streams, request objects, AbortControllers, or cross-request refresh ownership. Older checkedAt completions cannot overwrite newer publication, even after oversized data removes a retained predecessor.
- Preserve resource key/version matching, validation at edge/coordinator admission, malformed-data failure handling, bounded request deadlines, and independent catalog provenance.
- Verify adapter/client recreation and actual Worker fetch reuse, independent environment/binding state, refresh deadlines, catalog updates, malformed cache data, failures, concurrent publication, caller mutation, reset, and oversized resources.
- Benchmark five-point ordinary and 28-point maximum route-shaped request series, with 250-entry and 10,000-entry synthetic catalogs and representative full winds envelope sizes. Compare cache reads and parsed bytes; label process CPU, wall time, and heap/serialized retention as local measurements. Cloudflare CPU and actual deployed retained memory may remain explicitly unverified if unavailable. No production traffic or deployment is authorized.

Execution: architect reviews the integrated user-visible behavior, delegates bounded code and benchmark tasks to Luna/medium, obtains independent review, then runs relevant local/Worker runtime checks and production dry runs. Keep unrelated work preserved; no merge or deployment.
