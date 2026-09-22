# Complete-flight study fixture

`src/test/fixtures/complete-flight.ts` runs the browser plan calculator with a frozen clock and synthetic weather transport. It yields one saved plan family, immutable revision, and the weather-reference snapshots used by that revision. UI and one-way PDF output tests can consume the same calculated result without network access or duplicating flight math.

The scenario is KORD → a latitude/longitude checkpoint → KJVL. The selected cruise altitude is 4,500 ft MSL on leg 1 and 5,500 ft MSL on leg 2. The engine generates a departure climb, top of climb, checkpoint-started transition climb, top of descent, and arrival descent to a pilot-entered 808 ft MSL target. It uses a deliberately overridden 102 kt cruise TAS on leg 1; the default is 95 kt. Taxi/run-up fuel is 0.8 gal and reserve fuel is 3 gal.

The synthetic METAR reports a 270° true wind at 10 kt. Wind interpolation anchors that observation at the departure airport's fixture field elevation of 680 ft MSL, then uses the synthetic winds-aloft levels. The selected forecast period, source evidence, sampled wind assumptions, calculation traces, and override provenance remain visible in the saved snapshot. Tests pin the major phase boundaries, selected times and fuel totals, and source-evidence linkage.

All aircraft performance, airport details, weather, and times here are **test data**, not current operational information. Neither this fixture nor an output generated from it is suitable for flight planning or a weather briefing.
