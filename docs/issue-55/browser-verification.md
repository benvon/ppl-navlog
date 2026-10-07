# Integrated browser verification

The architect exercised the real planner in the Codex in-app browser against a disposable Vite fixture using the actual WorkerAirportLookup and WorkerWindsClient adapters and deterministic synthetic responses. The fixture used memory-only pilot inputs, no live airport/weather provider, and an on-page counter incremented at each adapter fetch.

## Observed results

- Direct route initial Update: 5 calls (2 airport, 1 METAR, 2 winds). Unchanged Update added zero; the displayed worksheet table was identical.
- 25 checkpoints initial Update: 30 calls (2 airport, 1 METAR, 27 winds). Unchanged and title-only Updates added zero; the displayed table was identical.
- Fuel aboard 20 to 19 gallons: zero new requests; output reflected the current 19-gallon input and recalculated balances.
- Cruise altitude 4500 to 5500 feet MSL: 27 new winds requests only; airport/METAR counts stayed 2 and 1, total 57. A successful current result was rendered.
- Reload: request counter reset to zero; adapters were reconstructed with empty caches.
- After transport review fixes, repeated maximum-route Update again added zero requests with identical table, and fuel-only edit again added zero with changed fuel output.

The request-count baseline and browser results are synthetic functional evidence, not live provider behavior, measured Cloudflare billing, or latency estimates. Transport tests separately cover expiry and recovery boundaries. The fixture source is retained in /private/tmp/issue-55-browser.ts and /private/tmp/issue-55-browser.html; screenshot evidence is /private/tmp/issue-55-browser.png. The fixture imports this worktree's source and test fixtures; it was removed from the repository tree after the check to keep it out of production builds and linting.
