# ppl-navlog

A VFR flight planning log that makes all the calculations visible.

## Planning

See the [consolidated implementation plan](docs/implementation-plan.md) for the agreed product scope, architecture, phased milestones, acceptance criteria, and dependency-aware issue breakdown.

See the [magnetic-model record](docs/magnetic-model.md) for the WMM2025 source, license, validation vectors, and calculation assumptions.

The [complete navlog engine](docs/full-navlog-engine.md) calculates PHAK-style rows, phase transitions, cumulative time and fuel, and inspectable calculation traces. The [phase-allocation model](docs/phase-allocation.md) and [weather model](docs/weather-model.md) explain the generated sublegs and wind assumptions. The earlier [vertical-profile slice](docs/vertical-profile-slice.md) remains documented as a separate precursor.

The [revision and refresh workflow](docs/revisions-and-weather-refresh.md) documents guarded overrides, immutable history, weather refresh, and local backup/import behavior.
