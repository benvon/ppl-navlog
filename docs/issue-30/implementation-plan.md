## Goal

Finish the simplification effort by making the sequential waypoint worksheet the only production calculation path. This is a PHAK Chapter 16 teaching tool, with compact navlog rows and explanations in the inspector below them.

## Approved contract

- Keep one cruise altitude, departure-METAR TOC approximation, destination winds aloft at cruise altitude for TOD, descent to field elevation at the aircraft profile descent rate, and one wind selection per outgoing checkpoint row.
- Preserve unrounded carried time/fuel, inclusive TOC–TOD checkpoint validation, ordered route occurrences, signed fuel shortage, validation before network work, and disclosed estimates.
- Save only latest pilot inputs and validated aircraft profiles. Calculations/weather/inspector evidence remain in memory.
- Support only the current saved-plan schema. Discard unsupported or unversioned stored plans and ask the student to create a new plan. Reject malformed current-format data. Do not add migration or older-format compatibility.
- Plan state governs save/switch/Update readiness. Preserve PR #35's race fix.
- Printing remains deferred. Sources footer is separate work in #34.

## Implementation plan

1. Trace the active entry point and all callers of complete-plan, full-navlog-engine, phase-calculation-engine, phase-allocation, and obsolete weather resolvers.
2. Make the active planner consume the finalized sequential worksheet result directly. Remove the progressive-snapshot bypass wrapper and alternate calculators; no new selectable engine or fallback.
3. Retire obsolete weather/phase composition, callers, types, fixtures, and tests. Extract only math/validation still needed by the current worksheet; preserve current arithmetic and API request behavior.
4. Update current documentation to identify the sole path and remove superseded revision/migration/modeling requirements. Historical design notes must not be treated as current requirements.
5. Verify ordinary and boundary cases through the integrated UI tests: invalid input/weather, geometry failures, checkpoint placement, insufficient fuel, save/switch readiness, and current/unsupported saved-plan behavior. Run full CI and current GitHub checks; review the displayed worksheet/inspector flow.

## Acceptance criteria

- Update navlog has exactly one authoritative route from validated current pilot inputs and selected weather to worksheet rows.
- No production caller or alternate engine can invoke the superseded phase-allocation model or accept an injected progressive snapshot as a substitute calculator.
- Existing current worksheet results, teaching explanations, request counts/order, and failure behavior are preserved.
- Unsupported stored formats are discarded; no older-plan migration or compatibility tests are added.
- Shared math needed by the worksheet remains covered. Tests solely exercising retired behavior are removed.
- Local and remote quality gates pass, and integrated user-visible behavior is verified. Production deployment is separate.

## Dependencies and completed baseline

PR #33 supplies the sequential worksheet. PR #35 completes presentation, removes inactive planner/history/printing, updates the implementation plan, and enforces current-plan-only persistence. Issue #29 presentation is complete. This issue owns the remaining calculator retirement.
