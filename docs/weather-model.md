# Current worksheet weather model

The [teaching contract](navigation-worksheet-teaching-contract.md) governs weather selection and calculation precision. The only production orchestration is described in [worksheet calculation](worksheet-calculation.md).

## Placement estimates

- Departure METAR supplies the disclosed initial-climb wind approximation. Climb time comes from altitude gain and the entered aircraft profile climb rate; groundspeed converts it to estimated TOC distance.
- Request winds aloft at cruise altitude above destination for TOD placement. Use departure UTC plus charted route distance divided by cruise TAS as the deterministic preliminary no-wind arrival time.
- Descend to destination field elevation at the entered profile descent rate. Use that wind to convert descent time into route distance, working backward once. Do not iterate or adjust the rate.
- Reject overlap/infeasible placement and report all checkpoints outside the inclusive estimated TOC–TOD interval before requesting checkpoint-row weather.

## Outgoing rows

Departure wind supplies the climb row. Select one aloft answer at TOC and each allowed authored checkpoint, at the single cruise altitude and carried estimated UTC, for the outgoing cruise row. Reuse the destination cruise-altitude placement answer at TOD for descent. Validate each selected answer at its requested time and retain the evidence needed to explain it. Later selections do not recalculate completed rows.

The primary departure airport supplies METAR when available. An explicitly entered ICAO alternate is eligible only when the primary airport has no METAR or no ICAO identifier; stale reports or transport errors do not authorize substitution. Destination METAR/TAF and forecast-period selectors are not worksheet inputs.

The Worker continues to resolve winds from verified stations and published levels without extrapolation. Its transport contracts, cache/freshness rules, and wind/temperature interpolation math are retained. Selected forecasts are estimates; these checks do not constitute a complete weather briefing.

Weather products, point answers, source provenance, and calculations remain in memory. Reopening inputs requires Update navlog. Input edits or failed updates clear the displayed result. Saving inputs never requests weather.
