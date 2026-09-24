# Complete-flight study fixture

`src/test/fixtures/complete-flight.ts` is a legacy fixture for the former revision-based planner. It runs the browser plan calculator with a frozen clock and synthetic weather transport and yields a saved plan family, immutable revision, and weather-reference snapshots. Those storage artifacts do not describe issue #7's v2 persistence contract, which stores pilot inputs only and keeps calculation output ephemeral. Tests that exercise the active planner must assert its result separately from durable pilot input records.

The scenario is KORD → a latitude/longitude checkpoint → KJVL. The selected cruise altitude is 4,500 ft MSL on leg 1 and 5,500 ft MSL on leg 2. The engine generates a departure climb, top of climb, checkpoint-started transition climb, top of descent, and arrival descent to a pilot-entered 808 ft MSL target. It uses a deliberately overridden 102 kt cruise TAS on leg 1; the default is 95 kt. Taxi/run-up fuel is 0.8 gal and reserve fuel is 3 gal.

The synthetic METAR reports a 270° true wind at 10 kt. Wind interpolation anchors that observation at the departure airport's fixture field elevation of 680 ft MSL, then uses the synthetic winds-aloft levels. The selected forecast period, source evidence, sampled wind assumptions, calculation traces, and override provenance remain available in the fixture's calculated revision. In the active planner, equivalent calculation provenance is session-only and is not stored in a pilot input record.

All aircraft performance, airport details, weather, and times here are **test data**, not current operational information. Neither this fixture nor an output generated from it is suitable for flight planning or a weather briefing.
