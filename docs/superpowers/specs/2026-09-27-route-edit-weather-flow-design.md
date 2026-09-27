# Route editing, save, and departure weather flow

## Goal and pilot decisions

Make an existing plan understandable and editable without forcing a calculation to save it. A pilot chooses an aircraft, edits a route and its waypoint altitudes, saves literal inputs, then requests a current navlog. If an old departure time prevents use of newly fetched weather, the pilot can explicitly set the time to current UTC and retry.

The navlog remains a calculation from pilot inputs and current external data. A saved working copy is not a current navlog. Preserve existing plan IDs, literal input text, submission history, and current calculation invalidation behavior.

## Scope and invariants

1. The active planner is `src/ui/pilot-intent-planner.ts`. The legacy `src/ui/planner.ts` is outside this change.
2. Cruise altitude remains a per-leg value in `cruiseAltitudeTexts`. Index 0 belongs to departure-to-first-point. Each checkpoint's outbound leg uses the next index. No storage or calculation schema change is required.
3. Departure METAR is fetched automatically during each Update plan. Station identity, supported wind, nonstale cache, observation at or before planned departure, and at most two-hour age remain required. A cache hit for the same recently observed report can be valid. No manual METAR refresh button or freshness bypass is in scope.
4. Direct UTC text remains pilot-authored. The application never silently rewrites it; the pilot may explicitly choose Use current UTC when a valid entered departure time is in the past. The constructed value uses the browser clock at minute precision, remains directly editable, autosaves like other input, invalidates a current navlog, and does not calculate until Update plan is pressed.
5. Save changes is an explicit input-only action. It reuses the existing serialized working-copy persistence path, works even with incomplete route fields, and neither submits a calculation revision nor fetches weather. Existing blur autosave remains.

## Route editor presentation

Show a Departure group with the first outbound leg's altitude and optional TAS override. Show each checkpoint as one visually bounded group containing name, coordinate, and altitude for the leg leaving that checkpoint, with the optional TAS override for that same leg. Label the destination of each leg so the meaning is clear. The destination has no separate cruise-altitude input; arrival descent target remains in Arrival.

Adding/removing checkpoints preserves the existing `cruiseAltitudeTexts` ordering and route-change override clearing contract. Grouping is presentational: do not attach altitude to checkpoint storage or change calculations. Narrow layouts stack the group fields; related labels stay in the same group.

## Save and calculate flow

Opening a saved plan opens Route information and says that the inputs are ready to edit; do not call the open action an error or imply that calculation is needed to save. Provide a visible Save changes button in Route information. On click, capture current form text and structured checkpoint/altitude/override inputs and await the existing save queue. Show a clear saved or failure status. Calculation stays under Calculate and is labeled Update navlog or an equally explicit action, with copy that it obtains current weather and recalculates. A successful save does not display a current navlog. A calculation failure keeps the edited fields intact.

## Departure weather and time

On Update navlog, fetch the configured departure METAR automatically as today. Validation reports the actual cause when the fetched report cannot anchor the departure: planned time before observation, report older than two hours at planned departure, wrong station, stale cache, missing observation, or unsupported wind. The message must state the next pilot action when one is available and must not imply a refresh control exists. For a past entered UTC time, show Use current UTC alongside the departure-time input. The action uses the current browser time, sets the UTC input, persists the new literal value, and waits for the pilot to recalculate.

Do not reject a METAR merely because its report/request identity matches the prior calculation: a fresh cache response with a suitable observation is valid. Do not change the two-hour planning limit or accept a report observed after the chosen departure time. Upstream failures remain failures and cannot be disguised as successful refreshes.

## Acceptance criteria

### Ordinary case

Given a saved plan with one checkpoint and a valid departure time, opening it shows Route information. The departure group's altitude controls the departure-to-checkpoint leg, and the checkpoint group's altitude controls checkpoint-to-destination. Editing the checkpoint coordinate and outbound altitude then choosing Save changes persists the exact entered text and both leg altitudes. No weather request or navlog calculation occurs. Choosing Update navlog fetches a departure METAR and current point weather, then displays UTC navlog times with the changed route and altitudes.

### Boundary case

Given a saved plan whose departure UTC is earlier than the current browser time, opening it preserves that literal time and shows Use current UTC. An Update navlog attempt fetches a METAR but, if its observation is after the old departure, explains the time mismatch without changing the plan. Choosing Use current UTC changes and saves only the departure field, clears any old result, and does not fetch weather. A later Update navlog accepts a same-station, nonstale, recent-before-departure METAR even if that report was also returned by a previous request. A report after departure, more than two hours old at departure, wrong-station report, stale cache, or unusable wind still blocks with a specific reason.

### Verification gates

- DOM tests prove checkpoint/altitude/TAS grouping, preserved leg indexing, and add/remove behavior.
- Save-only tests prove literal persistence, serialized writes, failure visibility, and zero submission/weather/calculation calls.
- Time/weather tests prove explicit current-UTC action, automatic METAR fetch per update attempt, accepted suitable cache hit, and each important rejection reason.
- Run typecheck, lint, architecture boundaries, tests, build, secret/workflow scans, and audit. Review the combined pilot flow in a browser if available.
