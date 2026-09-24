# Route-aware Weather Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Calculate a current navlog with location- and time-specific aloft winds, departure METAR, destination TAF, and inspectable weather math.

**Architecture:** The Worker owns aloft product selection, station matching, and point interpolation, and exposes a separate bounded TAF read. The browser requests exactly one winds-aloft point per pilot waypoint in route order. Each corrected leg ETA determines the next point request before the existing phase and navlog engines assemble the full route once against those immutable answers. It validates final waypoint and leg coverage and checks that the same fetched TAF selects the same group at final arrival. Pilot inputs remain the only durable plan data.

**Tech Stack:** TypeScript, Cloudflare Worker, IndexedDB, Vitest, Vite, `mise` with repository Node 22.

**Spec:** `docs/superpowers/specs/2026-09-24-route-aware-weather-design.md`

## Global Constraints

- The browser must not select aloft stations, forecast periods, or geographic interpolation methods.
- `GET /api/weather/winds/point` takes one coordinate, altitude MSL, and planned UTC; it never retrieves METAR or TAF.
- Departure uses the selected METAR. Destination selects the TAF group at the progressive carried arrival UTC after all leg ETAs, then confirms final navlog arrival still selects that group, including applicable conditional groups and worst-case groundspeed among overlapping winds. No runway selection or crosswind calculation.
- The navlog shows values and current-weather validity; the inspector shows sources and interpolation math; a future PDF contains values only.
- Weather payloads, point answers, and calculated results are session-only. Existing `surfaceWeatherIcao` maps only to departure; destination starts unset.
- A failed Update plan retains submitted inputs, retains its error until success, and clears any earlier current result.
- Retain fixed upstream hosts, bounded requests/responses, timeouts, rate limiting, validation, and nonsensitive errors. Use synthetic large-product fixtures; do not add private source payloads or credentials.
- A valid regional winds/temps product larger than the current 512 KiB decoded cap must load. Measure supported-region/cycle product sizes before choosing a finite replacement byte, parse-work, and cache-size budget.
- Every implementation task is performed by a Luna/Medium subagent in an isolated worktree. The architect inspects its diff, runs fresh focused verification, and sends findings to the same agent for correction before accepting it. Agents do not merge or open PRs.

## Review Focus

- A future-issued or amended forecast must not be used before issuance; Task 2 and Task 3 tests pin issue-time behavior.
- Two station-catalog entries sharing an ID with different coordinates must fail; Task 1 tests pin ambiguous identity behavior.
- A point just outside a use window or published altitude envelope must fail instead of borrowing a nearby period or level; Task 2 tests pin boundary behavior.
- A valid regional product just above 512 KiB must parse and cache within the measured budget; Task 2 tests pin the large-source behavior.
- An arrival time that moves into another TAF group after the one calculation pass blocks the update; Task 5 tests pin timing stability.
- An edit or failed update must make earlier inspector and navlog evidence unavailable even if the old result object remains in memory; Task 6 tests pin visible-state behavior.

## File and Interface Map

The following public shapes are the coordination contract. Agents may refine private helpers, but must ask the architect before changing these cross-task fields. All UTC strings are canonical ISO-8601 instants; directions are true degrees and speeds are knots.

```ts
// worker/api/contracts.ts and the browser's validated transport equivalent
export interface AloftPointQuery { latitudeDeg: number; longitudeDeg: number; altitudeFeetMsl: number; plannedUtc: string }
export interface AloftSourceWeight { stationId: string; latitudeDeg: number; longitudeDeg: number; distanceNauticalMiles: number; horizontalWeight: number; lowerAltitudeFeet: number; upperAltitudeFeet: number; verticalWeight: number }
export interface AloftPointAnswer { query: AloftPointQuery; windFromDegTrue: number | null; windSpeedKt: number; temperatureC: number; issuedAt: string; useFrom: string; useUntil: string; forecastCycle: "06" | "12" | "24"; sources: AloftSourceWeight[]; method: "station-level" | "vertical-vector" | "horizontal-vector" | "horizontal-vertical-vector"; requestId: string }
export interface TafWindGroup { kind: "prevailing" | "FM" | "TEMPO" | "PROB"; fromUtc: string; untilUtc: string; windFromDegTrue: number | null; windSpeedKt: number | null; gustKt: number | null; probabilityPercent: number | null; raw: string }
export interface TafAnswer { stationIcao: string; issuedAt: string; validFrom: string; validUntil: string; rawTaf: string; groups: TafWindGroup[]; requestId: string }
```

`worker/api/winds.ts` owns product loading, catalog matching, and aloft resolution; `worker/api/taf.ts` owns the TAF upstream adapter and normalization; `worker/api/request.ts` and `handlers.ts` expose both routes. `src/services/weather/winds-client.ts` validates both response contracts. `src/application/route-weather-sampling.ts` owns sequential per-waypoint fetches, progressive leg timing, and final timing validation. `src/application/arrival-taf-wind.ts` owns conditional-group selection. `src/application/full-navlog-engine.ts` consumes immutable samples through the existing synchronous resolver. `src/ui/pilot-intent-planner.ts` owns the two endpoint source fields and current-result lifetime; `src/ui/calculation-inspector.ts` renders the retained math. Documentation updates belong with the task that changes the behavior.

## Execution Batches and Review Gates

Task 1 establishes the shared aloft contract and corrects catalog identity. After its review, Tasks 2, 3, and 4 may run concurrently in separate worktrees. Tasks 2 and 3 both touch Worker routing/transport files, so the architect integrates their reviewed commits one at a time and asks the later agent to rebase and rerun its focused checks if those files conflict. Task 4 edits only pilot-input and domain files. Task 5 starts after Tasks 2 and 3; Task 6 starts after Tasks 4 and 5. The architect integrates only reviewed commits onto a feature branch from current `origin/main` and runs the end-to-end gate in Task 7. Each accepted task must be independently testable and signed; the architect checks ancestry and avoids changing unrelated work.

### Task 1: Shared contract and exact station identity

**Files:** Modify `worker/api/contracts.ts`, `worker/api/winds.ts`, `worker/api/winds.test.ts`; add `docs/weather-coverage-fixtures.md` with representative CONUS, Alaska, and Hawaii IDs and source dates.

**Interfaces:** Produces `AloftPointQuery`, `AloftSourceWeight`, `AloftPointAnswer` and an exported `getWindsPoint(query: AloftPointQuery): Promise<AloftPointAnswer>` method on `WindsDataAdapter`. Preserve existing discovery/forecast methods until the active browser no longer calls them.

- [ ] **Step 1: Add red identity and contract tests.** Include a catalog fixture where two entries claim `BRL` with different coordinates, one where the exact ID is absent, one where the ID belongs to another region, and unique IDs from each supported region. Expect an explicit `upstream_invalid_response` for ambiguous/region-inconsistent records and no guessed coordinate. Add a compile-time test of the point method shape.

```ts
expect(await api.getWindsStations([{ latitudeDeg: 42.6, longitudeDeg: -89 }])).rejects.toMatchObject({ code: 'upstream_invalid_response' });
const query: AloftPointQuery = { latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 4500, plannedUtc: '2026-09-22T01:00:00.000Z' };
expectTypeOf<WindsDataAdapter['getWindsPoint']>().toBeFunction();
```

- [ ] **Step 2: Run** `mise exec -- npm test -- worker/api/winds.test.ts`; expect the new tests to fail before implementation.
- [ ] **Step 3: Replace the `stationInfo` last-entry-wins map with exact match accounting.** Count every catalog match for a station ID, compare coordinates and region, reject ambiguous/conflicting matches, and never derive an ICAO/IATA prefix. Add only the contract and method signature needed by Task 2; the method may throw a typed `service_unavailable` until Task 2 implements it.
- [ ] **Step 4: Run** focused tests, `mise exec -- npm run typecheck`, and `git diff --check`; commit `feat(weather): validate exact winds station identity`.
- [ ] **Step 5: Architect review.** Inspect exact-ID, duplicate, and region handling; run the focused tests afresh. Send concrete defects back to this agent and repeat verification before accepting the commit.

### Task 2: Worker aloft point resolution

**Files:** Modify `worker/api/winds.ts`, `worker/api/request.ts`, `worker/api/handlers.ts`, `worker/api/winds.test.ts`, `worker/api.functional.test.ts`; create `worker/api/winds-point.test.ts`; update `docs/weather-model.md` and `docs/weather-coverage-fixtures.md`.

**Interfaces:** Consumes Task 1's exact catalog and point types. Produces `GET /api/weather/winds/point?lat=<decimal>&lon=<decimal>&altitudeFeetMsl=<integer>&plannedUtc=<encoded ISO>` and `WindsDataAdapter.getWindsPoint`.

- [ ] **Step 1: Measure and fixture the actual regional source.** From a development Worker environment with official-source network access, record the decoded byte count and fetch duration for all supported regions and cycles, without logging source bodies. Build a synthetic valid regional-product fixture above 512 KiB. If the official source is unavailable, mark measurement inconclusive and do not select a new production cap until it can be measured. Record source issue/use windows, station coordinates, nearest distances, and two same-altitude route points that should differ. Derive and document an initial maximum station distance and sampling guidance from these fixtures; reject routes outside demonstrated coverage. Include cache entries with fresh fetch time but expired published use window, a newer applicable product, a failed cycle, a gap, and a future-issued product.
- [ ] **Step 2: Write red request and resolver tests.** Reject duplicate/unknown query keys, malformed UTC, out-of-region coordinates, unsupported altitude, oversized query, stale product, insufficient coverage, and mixed-period station inputs. Assert a valid product above 512 KiB parses and caches, while a product above the newly measured finite budget is rejected before unbounded buffering or parsing. Distinguish byte-limit and unreadable-stream diagnostics internally. Assert vector interpolation on a 350°/10° pair avoids a false 180° result and that temperature/vertical interpolation stays within published levels.

```ts
const answer = await adapter.getWindsPoint({ latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 4500, plannedUtc: '2026-09-22T01:00:00.000Z' });
expect(answer.sources.every((source) => source.distanceNauticalMiles >= 0)).toBe(true);
expect(answer.useFrom <= answer.query.plannedUtc && answer.query.plannedUtc < answer.useUntil).toBe(true);
```

- [ ] **Step 3: Run** `mise exec -- npm test -- worker/api/winds-point.test.ts worker/api.functional.test.ts`; expect new assertions to fail.
- [ ] **Step 4: Implement point selection and interpolation.** Set a measured regional-product limit with headroom, preserving streaming byte checks and bounded parse/cache work. Parse one canonical query; choose the newest issued applicable nonstale product per point; require compatible source windows; rank exact-coordinate stations deterministically; interpolate `u/v` wind components, temperature, and bounded altitude; return weights and provenance. Reject failed-cycle uncertainty when it could change the chosen answer. Keep source cache freshness separate from product validity; never serve `stale_on_error` as current.
- [ ] **Step 5: Run** focused Worker tests, typecheck, lint, boundary checks, and `git diff --check`; commit `feat(weather): resolve aloft weather at a point`.
- [ ] **Step 6: Architect review.** Recompute representative vectors and period choices independently, inspect abuse bounds and cache semantics, then send defects back to the same agent.

### Task 3: Destination TAF transport and conditional wind selection

**Files:** Create `worker/api/taf.ts`, `worker/api/taf.test.ts`, `src/application/arrival-taf-wind.ts`, `src/application/arrival-taf-wind.test.ts`; modify `worker/api/contracts.ts`, `worker/api/request.ts`, `worker/api/handlers.ts`, `src/services/weather/winds-client.ts`, `src/services/weather/winds-adapter.test.ts`, and `worker/api.functional.test.ts`.

**Interfaces:** Produces `GET /api/weather/taf/<exact ICAO>`, validated `TafAnswer`, `TafTransportClient.fetchTaf(icao: string): Promise<TafAnswer>`, and `selectArrivalTafWind(taf: TafAnswer, arrivalUtc: string, arrivalCourseDegTrue: number, arrivalTasKt: number): SelectedArrivalWind`. `SelectedArrivalWind` includes selected group, effective true wind, candidate groundspeeds, and the surface-to-pattern assumption.

- [ ] **Step 1: Inspect official AWC TAF JSON/OpenAPI and save small redacted fixtures.** Map the actual group fields; do not invent a parser contract from a single TAF example. Include prevailing, FM, TEMPO, PROB, amendment/correction, absent wind, overlapping conditionals, variable wind, and no-TAF cases.
- [ ] **Step 2: Write red Worker/client tests.** Require exact station identity, latest issued non-superseded report, valid issue/arrival windows, bounded response and timeout, fixed AWC host, no stale-as-current answer, and specific unavailable errors. Assert browser rejection of wrong-station or malformed groups.
- [ ] **Step 3: Write red arrival-selector tests.** A conditional wind-bearing group covering arrival overrides prevailing; a group without wind inherits prevailing. Two overlapping groups choose the lowest groundspeed on the arrival course, with stable tie-breaking and candidate evidence. An arrival outside TAF validity fails. Do not substitute gust for mean wind or calculate crosswind.

```ts
const chosen = selectArrivalTafWind(taf, '2026-09-22T03:00:00.000Z', 270, 100);
expect(chosen.candidates.length).toBeGreaterThan(1);
expect(chosen.groundspeedKt).toBe(Math.min(...chosen.candidates.map((candidate) => candidate.groundspeedKt)));
```

- [ ] **Step 4: Run** `mise exec -- npm test -- worker/api/taf.test.ts src/application/arrival-taf-wind.test.ts`; expect the new tests to fail.
- [ ] **Step 5: Implement** the bounded Worker adapter, route/response validation, and pure selector using the existing wind-triangle solver. Treat uncertain or malformed TAF group timing as unavailable. Keep the selected group's raw source and conditional label in the current answer.
- [ ] **Step 6: Run** focused tests, typecheck, lint, and `git diff --check`; commit `feat(weather): select destination taf wind`.
- [ ] **Step 7: Architect review.** Inspect TAF period and amendment semantics against official documentation and fixtures, then send any correction to this agent.

### Task 4: Separate pilot-entered endpoint choices

**Files:** Modify `src/ui/pilot-intent-planner.ts`, `src/ui/pilot-intent-planner.test.ts`, `src/services/storage/pilot-input-repository.test.ts`, `src/domain/route.ts`, `src/services/storage/validation.ts`, and the relevant storage validation tests. Do not change Worker files.

**Interfaces:** Use raw field names `departure-metar-icao` and `destination-taf-icao`; preserve the saved value of `surface-weather-icao` as a departure-only migration source. `PlanWeatherSelection` has optional `departureMetarIcao?: string`, `destinationTafIcao?: string`, and legacy optional `forecastValidTimeUtc?: string` and `surfaceWeatherIcao?: string`; the active path requires neither legacy field.

- [ ] **Step 1: Write red UI/storage tests.** Assert independent blur saves and reload, incomplete raw text preservation, old `surface-weather-icao=KORD` mapping to departure only, blank destination after migration, exact four-character alternate validation, and removal of the forecast-period gate without losing other raw fields.

```ts
expect(opened.rawFields['departure-metar-icao']).toBe('KORD');
expect(opened.rawFields['destination-taf-icao']).toBe('');
expect(opened.rawFields['departure-icao']).toBe('1C8');
```

- [ ] **Step 2: Run** `mise exec -- npm test -- src/ui/pilot-intent-planner.test.ts src/services/storage/pilot-input-repository.test.ts`; expect new tests to fail.
- [ ] **Step 3: Implement** field labels, raw-field migration at read/use, local validation, and typed source choices. Keep source fields optional but require a resolvable endpoint station at update. Do not persist fetched METAR/TAF or alter checkpoint behavior.
- [ ] **Step 4: Run** focused tests, typecheck, and `git diff --check`; commit `feat(weather): separate endpoint source inputs`.
- [ ] **Step 5: Architect review.** Inspect old-plan migration and raw-text preservation independently; send defects back to this agent.

### Task 5: One point query per route waypoint and final timing validation

**Files:** Create `src/application/route-weather-sampling.ts`, `src/application/route-weather-sampling.test.ts`; modify `src/application/full-navlog-engine.ts`, `src/application/full-navlog-engine.test.ts`, `src/application/complete-plan.ts`, and their focused tests. Update the route-calculation design/spec and `docs/weather-coverage-fixtures.md`. Preserve the legacy loaded-winds path until Task 6 replaces planner orchestration.

**Interfaces:** Consumes `AloftPointAnswer`, `TafAnswer`, and endpoint METAR. Produces `resolveRouteWeather(draft: PlanDraft, profile: AircraftProfile, pointClient: { fetchPoint(query: AloftPointQuery): Promise<AloftPointAnswer> }, endpoints: { departureMetar: MetarSuccessPayload; destinationTaf: TafAnswer }): Promise<RouteWeatherSolution>`, where `RouteWeatherSolution` contains `weather: CompletePlanWeather`, exactly one `sampledPoints` answer per pilot route waypoint, and `iterations: 1`. The weather retains immutable waypoint answers indexed by route distance and progressive query UTC, a synchronous vector-interpolating `phaseWindResolver`, and a post-calculation validator for waypoint period, continuous adjacent-leg coverage, and arrival TAF-group stability.

- [ ] **Step 1: Write red tests.** Assert exactly one point API call per route waypoint and no interior or generated-boundary calls; departure and destination are queried at the adjacent aloft altitude while endpoint surface forecasts remain anchors. Cover distinct same-altitude waypoint winds, vector interpolation along a leg and at generated boundaries, and resulting row groundspeed/ETE/fuel. Add an answer whose period covers its provisional ETA but expires before corrected leg arrival and expect `weather-unavailable` without querying later waypoints. Also cover final row timing outside a period and a gap between adjacent report windows. Add arrival time moving into a different TAF group and expect `weather-unavailable`. Assert unsupported waypoint reports and more than 27 route points fail closed before returning a navlog. Use deferred fake responses to prove no next waypoint request starts before the current answer is received and corrected; changing the preceding leg wind must change the next query UTC.
- [ ] **Step 2: Run** `mise exec -- npm test -- src/application/route-weather-sampling.test.ts src/application/full-navlog-engine.test.ts`; expect new assertions to fail.
- [ ] **Step 3: Implement** deterministic geometry/profile and altitude selection. Start at planned departure UTC, fetch the first waypoint once, then for each leg estimate a provisional next-waypoint ETA using the current waypoint wind, fetch that next waypoint once at the provisional ETA, calculate corrected leg timing from both endpoint vectors, and carry the corrected arrival UTC into the following leg. Use those immutable answers to vector-interpolate every subleg and phase boundary. Use profile/per-leg TAS and fuel-flow overrides. After the final leg, select the destination TAF at the carried arrival UTC, then validate that final navlog arrival selects the same TAF group. After calculation, validate every waypoint's final UTC against its returned issue/use window and require adjacent answer windows jointly to cover the whole calculated leg interval without a gap; otherwise throw a weather-unavailable error. Do not retry/refetch. Include complete source and interpolation math in each row's evidence.
- [ ] **Step 4: Run** focused application tests, typecheck, lint, boundary checks, and `git diff --check`; commit `feat(weather): calculate with waypoint weather`.
- [ ] **Step 5: Architect review.** Independently verify one short and one long route, exact API call counts, calculation row changes, and the fail-closed period-shift case; send any correction to this agent.

### Task 6: Planner orchestration and inspector

**Files:** Modify `src/ui/pilot-intent-planner.ts`, `src/ui/pilot-intent-planner.test.ts`, `src/ui/calculation-inspector.ts`, `src/ui/calculation-inspector.test.ts`, `src/ui/calculated-navlog.ts`, `src/ui/calculated-navlog.test.ts`, `src/services/weather/winds-client.ts`, `src/main.ts`, and `docs/inspector-editor-separation.md`.

**Interfaces:** Consumes reviewed point/TAF clients, Task 4 source fields, and Task 5 `resolveRouteWeather`. Produces only a current session `PlanRevision`-shaped view model; the v2 repository saves submitted pilot inputs before any fetch and never saves that view model.

- [ ] **Step 1: Write red UI tests.** Assert one Update plan loads departure METAR, destination TAF, and route aloft points; success shows valid-weather status; selecting a wind, groundspeed, ETE, or fuel value shows the relevant station/period/weights/vector math and conditional TAF choice; the navlog does not show station details. Assert the displayed value matches inspector evidence.
- [ ] **Step 2: Write red failure/recovery tests.** After a successful result, edit, blocked point, invalid TAF, or failed update must hide old rows and inspector evidence while keeping the submitted inputs and persistent error. Later success clears the error and shows a new result. Reload requires new weather. Confirm HTML is rendered through text nodes rather than weather strings as markup.
- [ ] **Step 3: Run** `mise exec -- npm test -- src/ui/pilot-intent-planner.test.ts src/ui/calculation-inspector.test.ts`; expect new tests to fail.
- [ ] **Step 4: Implement** orchestration and inspector renderers. Remove the current single-station/explicit-period path from the active planner. Keep legacy helpers only where a still-used API/test depends on them; do not refactor unrelated UI. Keep PDF out of scope because the active planner has no print action.
- [ ] **Step 5: Run** focused UI tests, typecheck, lint, build, and `git diff --check`; commit `feat(weather): show current route weather evidence`.
- [ ] **Step 6: Architect review.** Inspect DOM evidence for selected rows and blocked-preview stale-state paths; send corrections back to this agent.

### Task 7: Architect integration and release verification

**Files:** Update `docs/weather-model.md`, `docs/revisions-and-weather-refresh.md`, `docs/pdf-output.md`, and issue #9 only after all behavior is verified; touch code only for integration conflicts that cannot be returned to an agent.

- [ ] **Step 1: Integrate only reviewed signed task commits** on a focused `feature/route-aware-weather` branch. Check `origin/main` ancestry, current PRs, and working-tree cleanliness before branch or PR operations; preserve unrelated user changes.
- [ ] **Step 2: Audit the combined diff against every spec section.** Confirm no persisted weather/results, exact station and endpoint identities, latest applicable aloft reports, conditional TAF worst-case rule, request bounds, stale-data rejection, and inspector/navlog consistency. Return any defects to the responsible Luna agent and re-review its correction.
- [ ] **Step 3: Run full repository gates.** Use `mise exec -- npm run ci`, `mise exec -- npm run lint:workflows`, `git diff --check origin/main...HEAD`, and the repository's deployment-artifact verification. Report skipped/unavailable audit or network checks distinctly.
- [ ] **Step 4: Run a local development Worker smoke** against live official AWC sources for representative short/long CONUS and supported Alaska/Hawaii queries plus one current destination TAF. Record timestamp, decoded regional-product sizes, fetch durations, sample requests/statuses, provider gaps, and selected coverage limits without treating a provider outage as a passing calculation.
- [ ] **Step 5: Refresh docs and issue #9 acceptance text** to reflect destination TAF, navlog weather validity, inspector detail, and values-only future PDF. Open a focused conventional-title PR with changes, rationale, tests, limitations, and live-smoke status; attach the PR to this task. Do not claim remote checks passed until their current results are read.
