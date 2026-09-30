# ppl-navlog

A navigation teaching worksheet that makes its calculations visible.

## Planning

The [navigation worksheet teaching contract](docs/navigation-worksheet-teaching-contract.md) defines the current product scope: one cruise altitude, real checkpoint weather, simple estimated TOC/TOD, and calculation explanations in the inspector below compact route rows. It supersedes conflicting requirements in the older [consolidated implementation plan](docs/implementation-plan.md).

See the [magnetic-model record](docs/magnetic-model.md) for the WMM2025 source, license, validation vectors, and calculation assumptions.

The active worksheet follows Chapter 16 course, wind, heading, groundspeed, time, and fuel arithmetic. TOC uses departure METAR wind as a disclosed climb approximation; TOD uses cruise-altitude wind above destination and descent to field elevation. Both positions are estimated once. Profile rates remain the entered assumptions. The [complete navlog engine](docs/full-navlog-engine.md), [phase-allocation model](docs/phase-allocation.md), and [weather model](docs/weather-model.md) include historical implementation details; the teaching contract takes precedence. The earlier [vertical-profile slice](docs/vertical-profile-slice.md) is a separate precursor.

The [pilot input and calculation workflow](docs/revisions-and-weather-refresh.md) documents v2 input-only persistence, explicit update submissions, ephemeral calculation results, and guarded overrides. Plan and profile import/export are out of scope before 1.0.

The browser stores pilot inputs and aircraft profiles locally. Airport and weather responses and calculated navlog output are session-only; reload or reopening a plan requires a new successful **Update plan**. Issue #7's v2 store does not load or migrate v1 browser data.

The [UI architecture](docs/ui-architecture.md) explains the layout/theme boundary and the worksheet-to-inspector interaction.

The [PDF output guide](docs/pdf-output.md) records why printing is deferred while the core planner is built. The [release-readiness audit](docs/release-readiness-audit.md), [security review](docs/security-review.md), and [GitHub CI/CD setup guide](docs/github-ci-cd-setup.md) track the remaining development and production gates.
