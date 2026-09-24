# ppl-navlog

A VFR flight planning log that makes all the calculations visible.

## Planning

See the [consolidated implementation plan](docs/implementation-plan.md) for the agreed product scope, architecture, phased milestones, acceptance criteria, and dependency-aware issue breakdown.

See the [magnetic-model record](docs/magnetic-model.md) for the WMM2025 source, license, validation vectors, and calculation assumptions.

The [complete navlog engine](docs/full-navlog-engine.md) calculates PHAK-style rows, phase transitions, cumulative time and fuel, and inspectable calculation traces. The [phase-allocation model](docs/phase-allocation.md) and [weather model](docs/weather-model.md) explain the generated sublegs and wind assumptions. The earlier [vertical-profile slice](docs/vertical-profile-slice.md) remains documented as a separate precursor.

The [pilot input and calculation workflow](docs/revisions-and-weather-refresh.md) documents v2 input-only persistence, explicit update submissions, ephemeral calculation results, and guarded overrides. Plan and profile import/export are out of scope before 1.0.

The browser stores pilot inputs and aircraft profiles locally. Airport and weather responses and calculated navlog output are session-only; reload or reopening a plan requires a new successful **Update plan**. Issue #7's v2 store does not load or migrate v1 browser data.

The [UI architecture](docs/ui-architecture.md) explains the layout/theme boundary and the worksheet-to-inspector interaction.

The [PDF output guide](docs/pdf-output.md) explains browser-local printing. The [release-readiness audit](docs/release-readiness-audit.md), [security review](docs/security-review.md), and [GitHub CI/CD setup guide](docs/github-ci-cd-setup.md) track the remaining development and production gates.
