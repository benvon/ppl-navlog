# PPL Navlog Implementation Plan

## 1. Purpose

Build a desktop-first VFR flight-planning and study application based on the conceptual workflow in FAA Pilot's Handbook of Aeronautical Knowledge Figure 16-26. The application must be useful as a conventional visual flight log, but its primary purpose is teaching: every important result must remain traceable to pilot input, aircraft-profile data, authoritative external data, interpolation, or an explicit calculation.

The governing product rule is:

> Never show the pilot a calculated number that cannot be explained.

This application is a planning aid and educational tool. It is not an official weather briefing, does not analyze all hazards, does not file flight plans, and must not imply that its output is sufficient by itself for regulatory preflight action.

## 2. Confirmed Product Decisions

- The frontend uses strict TypeScript, browser-native HTML and CSS, and a minimal framework footprint. Vite is the expected build tool unless implementation proves a smaller option materially better.
- The application is deployed independently using Cloudflare Workers with static assets and Worker API routes.
- The application may consume compatible `runway-picker` airport and METAR contracts, but this repository does not modify or deploy `runway-picker` and must tolerate that service being unavailable.
- There is no login and no server-side storage of aircraft profiles or navlogs. Structured user data is stored in IndexedDB; small UI preferences may use `localStorage`.
- Airport entry uses exact four-character ICAO identifiers. Checkpoints use a name and manually entered decimal latitude/longitude.
- A plan has a required departure date and time in UTC. Forecast selection is explicit and must not silently substitute a different valid period.
- Aircraft profiles supply cruise, climb, descent, fuel, and compass-deviation defaults. Leg-specific values may differ.
- The route model includes climb, a generated top-of-climb point, cruise, a generated top-of-descent point, and descent. Taxi/run-up fuel and reserve fuel are separate pilot-provided values that default to zero.
- The default descent target is destination elevation plus 1,000 feet. The pilot may deliberately override it.
- Actual in-flight logging is deferred.
- Calculated and default values can be deliberately overridden, but they are read-only by default. Overrides are conspicuous, reversible, and preserved with their original value and provenance.
- Saved plans are immutable revisions. Refreshing weather or recalculating after an input change creates a new revision rather than silently changing the prior snapshot.
- Winds aloft use the nearest available reporting station for v1. Altitude interpolation and climb/descent sampling operate on vector components, never directly on angular headings.
- A flight profile in which climb and descent overlap is reported as infeasible. The application must not silently truncate either phase.

## 3. V1 Scope

### 3.1 Route and plan definition

V1 supports:

- departure and destination airports resolved from exact ICAO identifiers;
- zero or more manually entered checkpoints;
- route ordering and removal;
- decimal-degree coordinates and SkyVector-style compact DMS waypoint input such as `420604N0884405W` (normalized to canonical decimal degrees);
- planned departure UTC date/time;
- independently selected cruise altitude for each user-defined route leg;
- aircraft-profile selection and a snapshot of the selected profile;
- pilot-entered taxi/run-up fuel and reserve fuel;
- generated TOC and TOD points;
- immutable saved plan revisions;
- JSON export and import with schema validation and versioning;
- a print-friendly PDF export of a selected, complete saved navlog revision.

### 3.2 Flight phases and calculations

V1 calculates and explains:

- great-circle leg distance and initial true course;
- climb time, distance, fuel, effective sampled wind, and TOC position;
- cruise-segment distance after generated phase boundaries are placed;
- descent time, distance, fuel, effective sampled wind, and TOD position;
- wind correction angle;
- true heading;
- WMM magnetic variation at a documented representative coordinate, date, and altitude;
- magnetic heading;
- compass deviation from an aircraft deviation table;
- compass heading;
- groundspeed;
- per-sub-leg and cumulative ETE;
- per-phase, per-leg, cumulative, taxi/run-up, reserve, and total required fuel;
- remaining distance and fuel summaries;
- structured errors for infeasible wind triangles, invalid routes, missing weather, and overlapping climb/descent profiles.

### 3.3 Weather and reference data

V1 supports:

- current departure and destination METARs, including the raw report, observation time, parsed surface wind, and source metadata;
- an explicitly selected Winds and Temperatures Aloft forecast valid period;
- nearest-station selection with the selected station and distance exposed;
- altitude interpolation between published levels using north/east wind-vector components;
- sampled effective climb/descent wind across the applicable altitude range;
- preservation of the original textual forecast product and normalized values;
- visible age, issue time, valid time, retrieval time, and cache state when available;
- deliberate distinction between METAR surface wind and winds aloft.

### 3.4 Explicit non-goals

V1 does not include:

- an interactive route map or sectional-chart background;
- graphical route editing;
- terrain, obstacle, airspace, TFR, or NOTAM analysis;
- official weather briefings;
- weight and balance;
- takeoff or landing distance calculations;
- a complete POH performance engine or density-altitude performance tables;
- IFR planning;
- flight-plan filing;
- actual in-flight logging;
- accounts, authentication, cloud synchronization, or collaboration;
- mobile-first design;
- route optimization;
- ForeFlight or Garmin integration.

## 4. Architecture

### 4.1 Repository structure

Start with a single application and clear internal layers. Do not introduce a package monorepo until a concrete independently versioned package is required.

```text
/
├── src/
│   ├── domain/          # Pure types, calculations, errors, and explanation traces
│   ├── application/     # Use cases and orchestration
│   ├── services/        # HTTP, IndexedDB, import/export, and clock adapters
│   ├── ui/              # Controllers, presenters, components, and layout
│   ├── test/            # Shared test builders and fixtures
│   └── main.ts
├── worker/
│   ├── api/             # Route handlers and transport validation
│   ├── resources/       # Airport, METAR, winds, and model adapters
│   ├── cache/           # Cache policy and provenance
│   ├── security/        # Rate limiting, headers, and request validation
│   └── index.ts
├── tests/
│   ├── e2e/
│   ├── fixtures/
│   └── faa-examples/
├── docs/
│   ├── implementation-plan.md
│   ├── architecture.md
│   ├── calculation-model.md
│   ├── data-provenance.md
│   ├── weather-model.md
│   └── operations.md
├── public/
├── .github/workflows/
├── wrangler.jsonc
└── package.json
```

Dependencies point inward: UI and services may depend on application and domain interfaces; application may depend on domain; domain must not depend on DOM, network, storage, Cloudflare, or UI code.

### 4.2 Cloudflare topology

One independently deployed Worker serves the static frontend and the `/api/*` boundary. It may call the existing `runway-picker` service through a configurable internal or HTTPS adapter when that contract is available. A local or direct upstream adapter remains possible so development and recovery do not require the other application.

Expected endpoints:

```text
GET /api/health
GET /api/airports/:icao
GET /api/weather/metar/:icao
GET /api/weather/winds/stations?route=...
GET /api/weather/winds?station=...&validTime=...&region=...
```

The exact airport and METAR response shapes should be compatible with the fields already exposed by `runway-picker`: canonical ICAO identity, coordinates/elevation for airports, raw METAR and parsed wind for METARs, fetch timestamps, cache provenance, structured error codes, and request IDs. The application must validate all responses at the transport boundary and map them into its own domain models.

Worker requirements:

- fixed upstream hosts and validated request parameters;
- allowlisted methods and routes;
- bounded timeouts and response-size limits;
- cache keys that include every input affecting the response;
- explicit fresh, stale-while-refresh, and stale-on-error behavior;
- rate limiting at the authoritative Worker boundary;
- request IDs and structured errors without leaking upstream credentials or payloads;
- least-privilege secrets and bindings;
- security headers for API and static responses;
- no browser exposure of provider credentials;
- raw weather retention only to the degree required for explanation and troubleshooting.

### 4.3 Domain and provenance model

Use branded or opaque types at domain boundaries for degrees true, degrees magnetic, degrees compass, knots, nautical miles, feet MSL, minutes, gallons, and gallons per hour. Runtime validation is still required because TypeScript types do not validate external or persisted data.

Every effective planning value has a lineage similar to:

```ts
interface PlanningValue<T> {
  computedValue: T | null;
  effectiveValue: T;
  origin: "pilot-input" | "aircraft-default" | "external-data" | "calculated" | "interpolated";
  provenance: Provenance;
  explanation?: CalculationTrace;
  override?: {
    value: T;
    reason?: string;
    createdAt: string;
  };
}
```

Raw upstream products belong to a weather/reference snapshot referenced by provenance IDs. Do not duplicate large raw payloads into every calculated cell.

The calculation trace is structured data, not a preformatted prose string. It records formula identity and version, named inputs with units, intermediate results, rounding policy, and structured warnings. The UI is responsible for rendering the trace as an explanation.

### 4.4 Route and generated sub-leg model

The user-defined route is an ordered list of airports and checkpoints. Calculations produce a separate immutable planned route containing generated phase boundaries and sub-legs.

```text
User route:       Departure ───────── Checkpoint ───────── Destination
Calculated route: Departure ─ Climb ─ TOC ─ Cruise ─ TOD ─ Descent ─ Destination
```

TOC and TOD can fall within any user-defined leg. Their coordinates are found along that leg's geodesic at the calculated distance from its start or end. Splitting a user leg must retain a relationship to the source leg so the UI can explain why generated sub-legs exist.

Profile calculation may require bounded iteration because phase groundspeed affects phase distance and therefore the coordinates at which wind is sampled. The algorithm must define a convergence tolerance, iteration limit, and structured non-convergence error. It must never loop without a bound.

If climb distance plus descent distance exceeds available route distance, return an infeasible-profile result containing both independently calculated phase requirements and the amount of overlap. Do not invent a cruise segment or silently reduce a phase.

## 5. Calculation Requirements

### 5.1 Coordinate, distance, and course

- Validate latitude in `[-90, 90]` and longitude in `[-180, 180]`.
- Accept SkyVector-style compact waypoint coordinates in exact `DDMMSSNDDDMMSSW` form, after trimming whitespace and normalizing hemisphere case. Reject malformed fields, minutes/seconds outside `00`–`59`, and nonzero minutes/seconds at latitude `90` or longitude `180`; preserve the original input and expected form in structured validation details.
- Calculate great-circle distance and initial true course using a documented Earth model.
- Normalize directional output to `[0, 360)` internally and display aviation headings as `001°` through `360°` according to one documented presentation rule.
- Preserve higher internal precision than the displayed worksheet value.
- Permit a guarded pilot override of distance or TC while keeping the computed suggestion visible.
- Document that geodesic calculation is not identical to manually measuring a line on a sectional.

### 5.2 Wind triangle

- Treat wind direction as the true direction from which the wind blows.
- Convert wind into north/east vector components with a single canonical sign convention.
- Solve WCA and groundspeed as one coherent wind-triangle result so inconsistent formulas cannot diverge.
- Return structured errors for crosswind components exceeding TAS, nonpositive groundspeed, invalid inputs, or non-finite results.
- Normalize headings only after the signed correction is preserved for explanation.

### 5.3 Winds aloft and sampling

- Select the nearest available forecast station using documented geodesic distance and expose the station, distance, and selection method.
- Require the user to choose an available valid time. If the requested departure time is outside the available product window, show available choices and do not substitute one silently.
- Decode all special Winds and Temperatures Aloft encodings before interpolation, including calm/light wind representations, winds of 100 knots or more, and unavailable temperatures.
- Interpolate between altitude levels by converting each wind-from observation into canonical north/east velocity components, interpolating the components, and converting the result back into wind-from direction and speed.
- Never average or interpolate direction angles directly. For example, 350° and 010° must average near north, not south.
- Compute effective climb/descent wind from five deterministic, evenly spaced altitude samples across the phase, including both endpoints. Obtain the wind vector at each sample altitude, apply trapezoidal weights (one-half at each endpoint and one at interior levels), average vector components, and convert the result back to direction and speed. The domain API may allow a bounded explicit sample-count override for verified future models, but it must retain this same inclusive-endpoint trapezoidal method.
- Preserve every source level and sample used by the effective-wind explanation.
- Do not infer a missing temperature when the source product does not publish one for that altitude.

### 5.4 Climb

Aircraft-profile defaults:

- climb rate in feet per minute;
- climb TAS in knots;
- climb fuel flow in gallons per hour.

Required inputs include departure elevation, initial altitude if different, target cruise altitude, climb defaults or deliberate overrides, route geometry, planned time, and sampled wind.

Required outputs include altitude gained, climb time, effective wind, WCA, true heading, groundspeed, climb distance, climb fuel, TOC coordinate, and explanation trace. A nonpositive climb rate or target altitude below the starting altitude is a validation error rather than an implicit descent.

### 5.5 Cruise

Each user-defined leg can specify an altitude. The selected aircraft profile supplies default cruise TAS and fuel flow; guarded leg-level overrides are supported. If adjacent cruise legs use different altitudes, v1 must not silently model the change as level cruise. The implementation must either create an explicit transition phase using the climb/descent model or require the user to acknowledge that the change is not modeled. The preferred behavior is an explicit generated transition sub-leg.

Cruise outputs include distance, TC, selected wind, WCA, TH, variation, MH, deviation, CH, groundspeed, ETE, and fuel.

### 5.6 Descent

Aircraft-profile defaults:

- descent rate in feet per minute;
- descent TAS in knots;
- descent fuel flow in gallons per hour.

The default target is destination elevation plus 1,000 feet. Required outputs mirror climb: altitude lost, descent time, effective wind, WCA, true heading, groundspeed, descent distance, descent fuel, TOD coordinate, and explanation trace. A nonpositive descent rate or target altitude above the starting altitude is a validation error rather than an implicit climb.

### 5.7 Magnetic variation and compass deviation

- Use a maintained WMM2025 implementation during its supported validity interval.
- Record the model version, model-data version, calculation date, coordinate, altitude, signed declination, and conventional east/west display.
- Centralize the conversion between true and magnetic headings and document the sign convention without relying solely on mnemonics.
- Allow a guarded manual variation override for chart-based or instructor-provided exercises.
- Model compass deviation as pilot-provided aircraft data indexed by magnetic heading.
- Define interpolation across the `360°/000°` boundary and reject ambiguous or duplicate table points.
- Allow zero deviation while clearly labeling it as pilot-provided/default data, not measured truth.

### 5.8 Time and fuel

- Calculate ETE from unrounded distance and groundspeed.
- Store duration in an unambiguous base unit and round only for display.
- Calculate phase fuel from unrounded phase duration and the applicable fuel flow.
- Present taxi/run-up, climb, cruise/transition, descent, reserve, and total required fuel separately.
- Default taxi/run-up and reserve to zero, display that zero explicitly, and identify both as pilot-provided values.
- Compare total required fuel with usable fuel when usable fuel is present, but do not silently add a regulatory reserve.

## 6. Aircraft Profiles

An aircraft profile contains:

- stable ID and user-visible name;
- cruise TAS and cruise fuel flow defaults;
- climb rate, climb TAS, and climb fuel flow;
- descent rate, descent TAS, and descent fuel flow;
- optional usable fuel;
- optional compass deviation table;
- schema version and created/updated timestamps.

Profile values are pilot-entered and must be labeled accordingly. A plan revision stores a complete snapshot of relevant profile values so later profile edits cannot change an existing plan.

Profile editing validates finite positive rates and speeds, nonnegative fuel values, usable-fuel consistency, heading ranges, and deviation-table uniqueness. No profile may claim that generic values represent POH performance for a particular aircraft unless the pilot entered and named them that way.

## 7. Override Safety and UX

Calculated or inherited values are read-only by default. A deliberate override flow must:

1. require an explicit `Override` action for the individual value or scoped group;
2. explain what downstream calculations will change;
3. require entry through a distinct override editor rather than turning every table cell into an editable field;
4. validate the replacement value and units;
5. optionally capture a reason;
6. display an `OVERRIDDEN` badge anywhere the effective value is shown;
7. keep the original calculated/default value adjacent or one interaction away;
8. provide a clear `Restore calculated value` action;
9. record the override in the immutable revision and calculation trace.

Keyboard navigation and screen-reader text must communicate override state without relying on color. The application must not use a global unlock mode that leaves many calculated fields accidentally editable.

## 8. Primary User Experience

The primary target is a landscape laptop display. Narrow screens may scroll horizontally; table readability takes priority over forcing every column into a mobile viewport.

Recommended layout:

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Plan, departure time, aircraft, weather validity, save/revision controls │
├───────────────────────┬──────────────────────────────────────────────────┤
│ Route and phase inputs│ METAR and winds source/status                    │
├───────────────────────┴──────────────────────────┬───────────────────────┤
│ PHAK-style visual flight log                    │ Calculation Inspector │
│ User points plus generated TOC/TOD sub-legs     │ Inputs/formula/source │
├──────────────────────────────────────────────────┴───────────────────────┤
│ Fuel summary, warnings, raw data, revision provenance                    │
└──────────────────────────────────────────────────────────────────────────┘
```

The flight-log table groups columns by concept:

- Route: checkpoint/phase, coordinates, altitude, leg and remaining distance.
- Wind triangle: TC, wind, TAS, WCA, TH.
- Heading conversion: variation, MH, deviation, CH.
- Performance: GS, leg ETE, cumulative ETE, phase fuel, cumulative fuel.

Selecting any calculated value opens a persistent Calculation Inspector. The inspector shows effective and original values, inputs with units, formulas, intermediate results, source and validity metadata, rounding, warnings, and override state. Avoid a separate modal for every cell.

Generated TOC and TOD rows must be visually distinct but participate in the same explanations and cumulative totals as other rows.

The PDF is a one-way output artifact, not a persistence or interchange format. Export uses the selected immutable calculated revision without refreshing weather or silently recalculating values. It presents the PHAK-style worksheet in a legible landscape layout with sensible pagination and repeats table headings when a log spans pages. Include route and aircraft identity, planned departure UTC, revision ID and generation time, source/forecast validity, visible assumptions and overrides, fuel summary, and the application's preflight limitation. PDF creation stays browser-local; no plan or aircraft data is uploaded. PDF import or reconstruction of a plan from a PDF is explicitly out of scope.

## 9. Persistence, Revisions, and Portability

IndexedDB stores:

- aircraft profiles;
- navlog plan families and immutable revisions;
- weather/reference snapshots used by revisions;
- application schema and migration state.

Editable work occurs in a draft. Saving produces a revision with a stable plan ID, revision ID, parent revision ID when applicable, creation reason, timestamps, route inputs, aircraft snapshot, weather snapshot references, effective overrides, calculated route, calculation versions, and warnings.

Refreshing weather creates a new draft from the selected revision, retrieves new weather, recalculates, and saves a new revision only after the user confirms. Prior revisions remain readable.

JSON export includes a documented format version and checksummed or otherwise integrity-checked envelope. Import must validate size, JSON shape, schema version, identifiers, timestamps, numeric ranges, and nested collections before writing anything. Import is atomic: invalid content writes no partial state. Unsupported future schema versions fail closed with a useful message.

JSON remains the only supported round-trip portability format. PDF export is available only for a complete saved calculated revision and must not be offered as an import path.

## 10. Failure and Freshness Behavior

- Never replace a valid saved snapshot merely because a refresh fails.
- Surface unavailable, stale, interpolated, overridden, or incomplete data explicitly.
- Permit manual winds only through the guarded override workflow and label the plan accordingly.
- Distinguish upstream unavailability, rate limiting, invalid ICAO, no METAR, no winds product, unsupported altitude, forecast outside validity, malformed provider response, and local persistence failure.
- Use bounded retry only for safe transient requests and honor `Retry-After` when present.
- Do not retry validation failures.
- Preserve request IDs for troubleshooting without exposing sensitive data.
- Block a final calculated plan when a required input is missing or the profile is infeasible; allow the incomplete draft to be saved with its blocking errors.

## 11. Security and Privacy

Trust boundaries include user-entered route/profile data, imported files, IndexedDB records from older versions, upstream APIs, the compatible `runway-picker` service, URL parameters, and Worker request inputs.

Controls include:

- runtime schemas and range/length limits at every boundary;
- canonical ICAO and coordinate validation;
- fixed upstream base URLs and separately supplied query parameters;
- no untrusted string interpolation into executable HTML, shell, or URLs;
- safe text rendering for raw weather and user-entered labels;
- import size, depth, and collection-count limits;
- content security policy, no-sniff, referrer, frame, and permissions headers;
- secrets injected only through Cloudflare/GitHub secret mechanisms;
- logs that exclude raw imported files, credentials, full IP addresses, and unnecessary user flight-plan content;
- dependency, secret, workflow, and static-analysis checks in CI.

## 12. Testing Strategy

### 12.1 Domain tests

Use deterministic table-driven tests for:

- coordinate and heading normalization boundaries;
- distance/course examples and antipodal/identical-point errors;
- all wind quadrants, calm wind, direct headwind/tailwind, wraparound, and impossible wind triangles;
- vector interpolation across north and winds over 100 knots;
- climb/descent sampling and convergence;
- TOC/TOD splitting at checkpoints and within legs;
- overlapping climb/descent profiles;
- magnetic east/west sign conventions and heading wraparound;
- deviation interpolation across north;
- time/fuel precision and display rounding;
- override application and restoration.

Where the FAA example contains enough published inputs, reproduce its results within a documented tolerance. Do not force a passing result where the publication omits inputs or uses chart/worksheet rounding; document the limitation in the fixture.

### 12.2 Application and service tests

- Use case tests with fake clock, weather, airport, magnetic-model, and persistence adapters.
- Contract tests for compatible `runway-picker` airport and METAR responses.
- Worker tests for validation, allowlisted routes, caching, stale behavior, rate limiting, timeouts, source metadata, and redacted errors.
- IndexedDB migration, quota failure, atomic import, duplicate import, and corrupt-record tests.
- Snapshot/revision tests proving that profile edits and weather refreshes do not mutate prior revisions.

### 12.3 UI and end-to-end tests

- Route entry through a complete climb/cruise/descent plan.
- Calculation Inspector content and keyboard operation.
- Override guard, badge, downstream recalculation, and restoration.
- Explicit forecast selection and out-of-range forecast behavior.
- Offline/retry/stale weather states.
- Save, reopen, revise, export, and import.
- Infeasible-profile presentation.
- Desktop layouts at representative laptop sizes and a narrower horizontally scrolling layout.
- Accessibility checks for labels, focus order, table semantics, contrast, non-color status communication, and reduced motion.

### 12.4 Required quality gates

CI must run at minimum:

- deterministic dependency installation;
- TypeScript typecheck;
- ESLint with zero warnings;
- unit/integration tests with an initial 80% threshold for statements, branches, functions, and lines;
- production build and artifact verification;
- workflow linting;
- secret scan;
- dependency audit;
- CodeQL or equivalent JavaScript/TypeScript static analysis;
- end-to-end tests for release candidates and deployed previews.

## 13. CI/CD and Operations

### 13.1 Pull requests

Pull requests run all quality gates and build one immutable artifact. Eligible same-repository pull requests may deploy an isolated preview only after CI succeeds. Preview deployment must use a least-privilege preview environment and must deploy the already validated artifact rather than rebuilding untrusted code with deployment credentials.

Preview verification covers static assets, `/api/health`, critical security headers, build identity, and a mocked or safe external-data path. Preview URLs are posted or updated on the pull request.

### 13.2 Production

Merges to protected `main` run CI. Production deployment occurs only from a successful, immutable release artifact tied to a conventional versioned GitHub release. The deployed application exposes build version and commit SHA. Deployment uses a protected production environment and least-privilege Cloudflare credentials.

The initial deployment milestone must document rollback, service bindings, secrets, provider credentials, cache resources, custom domain configuration, and a production smoke test.

### 13.3 Observability

Record aggregate Worker request counts, latency, status/error codes, upstream identity, cache status, and request IDs. Do not log complete navlogs, raw imported files, provider tokens, or other unnecessary user data. Operational documentation defines alertable failures, upstream degradation behavior, and how to trace a user-visible request ID.

## 14. Phased Milestones and Acceptance Criteria

### Phase 0: Foundation and architecture record

Deliverables:

- TypeScript/Vite/Worker skeleton;
- mise configuration and locked tool versions;
- layering and dependency rules;
- baseline CI, security checks, coverage enforcement, and build identity;
- architecture, calculation, provenance, weather, and operations documentation shells;
- recorded decision on the compatible `runway-picker` adapter and direct-development fallback.

Acceptance criteria:

- A local command starts static assets and Worker routes together.
- CI passes typecheck, lint, tests, coverage, build, workflow lint, secret scan, dependency audit, and static analysis.
- `/api/health` returns a versioned, non-sensitive response with a request ID.
- Domain code has no imports from UI, browser storage, HTTP, or Cloudflare modules.
- The built UI displays version and commit identity.

### Phase 1: Pure flight-math foundation

Deliverables:

- branded domain units and validation;
- coordinates, distance, TC, heading normalization, wind vectors, wind triangle, time, fuel, variation-conversion, and deviation-interpolation functions;
- structured calculation traces and errors;
- FAA/example fixtures with documented tolerances.

Acceptance criteria:

- All functions are deterministic and platform-independent.
- Normal, boundary, wraparound, and impossible cases are covered.
- Wind directions crossing north interpolate correctly through vector components.
- No function returns `NaN` or infinity as a successful domain result.
- Calculation traces contain formula IDs, units, inputs, intermediates, and unrounded results.

### Phase 2: Aircraft profiles and local persistence

Deliverables:

- aircraft-profile model and editor;
- IndexedDB repository with schema migrations;
- profile snapshot behavior;
- versioned JSON export/import foundation.

Acceptance criteria:

- Profiles persist across reloads and validate all fields.
- Updating a profile cannot change a previously stored snapshot.
- Import is atomic and rejects malformed, oversized, or unsupported data without partial writes.
- Export followed by import preserves all supported profile fields.

### Phase 3: Route planning without live weather

Deliverables:

- exact ICAO route endpoints using mock/local airport data;
- manual checkpoints;
- ordered user legs with per-leg altitude;
- aircraft defaults and guarded overrides;
- initial PHAK-style table and Calculation Inspector;
- draft and immutable revision model.

Acceptance criteria:

- A user can create, save, reopen, and revise a route.
- TC, distance, no-wind headings, time, and fuel are explained per leg.
- Calculated/default fields cannot be edited without the explicit override flow.
- Overridden values show original and effective values, an `OVERRIDDEN` indicator, and a restore action.
- A new revision does not mutate its parent.

### Phase 4: Climb, generated TOC, cruise transitions, TOD, and descent

Deliverables:

- climb/descent performance inputs;
- generated phase-boundary placement;
- sub-leg splitting and source-leg relationships;
- cruise-altitude transition phases;
- taxi/run-up, reserve, and complete fuel summary;
- infeasible-profile detection.

Acceptance criteria:

- TOC and TOD appear as generated, inspectable rows with coordinates, time, distance, and fuel.
- Generated points can fall within any appropriate source leg without losing cumulative totals.
- Multiple user-leg altitudes create explicit transition behavior rather than an unexplained altitude jump.
- Short routes produce a visible overlap/infeasibility result and never silently truncate phases.
- Taxi/run-up and reserve remain separate and default visibly to zero.

### Phase 5: Independent aviation-data Worker integration

Deliverables:

- compatible airport and METAR adapters;
- winds-product adapter and raw-product preservation;
- station selection, valid-time selection, caching, rate limiting, and source metadata;
- robust upstream failure handling.

Acceptance criteria:

- Exact valid ICAO input resolves canonical coordinates/elevation or returns a structured error.
- METAR display includes the raw report, observation time, parsed surface wind, source, and freshness.
- Winds selection identifies the nearest station and its distance.
- The user explicitly selects an available forecast valid time; out-of-window requests are not silently replaced.
- Provider credentials never reach the browser or logs.
- `runway-picker` unavailability is surfaced clearly and does not corrupt existing saved plans.

### Phase 6: Sampled winds, magnetic model, and complete calculated plan

Deliverables:

- altitude-interpolated winds;
- deterministic sampled effective climb/descent winds;
- bounded phase-geometry iteration;
- WMM2025 integration;
- complete TC-to-CH, GS, ETE, and fuel lineage;
- weather refresh creating a new revision.

Acceptance criteria:

- Every wind average occurs in vector space, including samples around north.
- Inspectors list the forecast station, levels, valid time, samples, weights, intermediate vectors, and resulting wind.
- Iteration converges within documented tolerance or returns a structured non-convergence error within a fixed limit.
- WMM results identify model/data versions, date, position, altitude, signed value, and east/west notation.
- Refreshing weather creates a reviewable new revision and preserves the old weather/calculations unchanged.

### Phase 7: Teaching UX, accessibility, and resilience

Deliverables:

- completed table grouping and inspector;
- raw-data/source view;
- warnings and freshness states;
- keyboard and screen-reader support;
- responsive desktop/narrow-screen behavior;
- offline and partial-failure handling.
- print-friendly PDF export from a complete saved revision.

Acceptance criteria:

- Every important displayed result can open a complete explanation.
- Pilot input, aircraft default, external data, interpolation, calculation, and override states are visually and semantically distinguishable.
- Status does not rely on color alone.
- The core workflow is usable with a keyboard.
- A failed refresh leaves the last saved revision intact and visibly identifies stale or unavailable data.
- Automated accessibility and targeted manual checks have no unresolved critical findings.
- The PDF shows the same saved values as the on-screen revision, retains phase rows and visible assumptions/overrides, paginates without clipping columns, and is visually checked at representative short and long route lengths.
- A draft, blocked, or infeasible plan cannot be exported as a flyable calculated navlog PDF; no PDF import control exists.

### Phase 8: Release and production validation

Deliverables:

- preview and protected production workflows;
- environment configuration and least-privilege credentials;
- release automation, rollback instructions, and production runbook;
- end-to-end and smoke-test suite;
- source, limitation, and user-safety documentation.

Acceptance criteria:

- A pull request produces a verified preview from the CI-built artifact.
- Production deploys only a successful release artifact from protected `main`.
- Production exposes the expected build identity and passes static, API, header, persistence, and core-planning smoke tests.
- Rollback is documented and tested without deleting user-local browser data.
- Documentation clearly states limitations and that the application is not an official briefing or complete preflight solution.

## 15. Dependency-Aware Issue Breakdown

Issue IDs below are planning identifiers, not existing tracker numbers. Each issue should remain independently reviewable. An issue may start only after all listed dependencies are complete unless it explicitly uses a temporary interface or fixture.

| ID | Issue | Depends on | Primary result |
| --- | --- | --- | --- |
| FND-01 | Scaffold strict TypeScript, Vite, Worker static assets, and mise tooling | — | Locally runnable application and Worker |
| FND-02 | Establish domain/application/services/UI dependency boundaries | FND-01 | Enforced architecture and import rules |
| FND-03 | Add CI quality, security, coverage, and build-identity gates | FND-01 | Merge-blocking validation |
| FND-04 | Define architecture, provenance, error, rounding, and API conventions | FND-02 | Reviewed technical contracts |
| DOM-01 | Implement branded units, validation primitives, and structured domain errors | FND-02, FND-04 | Safe calculation inputs and outputs |
| DOM-02 | Implement coordinates, great-circle distance, interpolation along route, and TC | DOM-01 | Route geometry engine |
| DOM-03 | Implement canonical wind vectors, wind triangle, WCA, heading, and GS | DOM-01 | Wind calculation engine |
| DOM-04 | Implement duration, fuel, cumulative totals, and rounding policy | DOM-01 | Time/fuel engine |
| DOM-05 | Implement true/magnetic conversion and compass-deviation interpolation | DOM-01 | Heading-conversion engine |
| DOM-06 | Implement structured calculation traces and formula registry | DOM-01 | Renderable explanations |
| TST-01 | Build FAA/reference fixtures and tolerance documentation | DOM-02, DOM-03, DOM-04, DOM-05, DOM-06 | Authoritative regression suite |
| STO-01 | Implement IndexedDB schema, repositories, and migrations | FND-02, DOM-01 | Durable local data |
| STO-02 | Implement validated atomic JSON export/import | STO-01 | Portable user data |
| AIR-01 | Implement aircraft-profile model and validation | DOM-01, STO-01 | Persisted aircraft defaults |
| AIR-02 | Implement compass-deviation table editor and preview | AIR-01, DOM-05 | Usable deviation profiles |
| RTE-01 | Implement route, checkpoint, user-leg, and plan-draft models | DOM-01, DOM-02 | Editable route domain |
| RTE-02 | Implement plan snapshots and immutable revision lineage | STO-01, AIR-01, RTE-01 | Revision-safe saved plans |
| OVR-01 | Implement computed/effective value and guarded override use cases | DOM-06, RTE-01 | Auditable overrides |
| UI-01 | Build plan/aircraft/route input shell | AIR-01, RTE-01 | Desktop-first input workflow |
| UI-02 | Build extensible visual flight-log table and initial route/performance columns | DOM-02, DOM-04, RTE-01 | Conventional navlog display foundation |
| UI-03 | Build Calculation Inspector | DOM-06, UI-02 | Teaching explanations |
| UI-04 | Build guarded override, badge, impact, and restore interactions | OVR-01, UI-02, UI-03 | Accident-resistant override UX |
| FLT-01 | Define phase performance and generated sub-leg model | AIR-01, RTE-01, DOM-02, DOM-03, DOM-04 | Phase calculation contract |
| FLT-02 | Implement climb and TOC geometry | FLT-01 | Generated climb sub-legs |
| FLT-03 | Implement descent and TOD geometry | FLT-01 | Generated descent sub-legs |
| FLT-04 | Implement altitude-transition sub-legs between cruise legs | FLT-02, FLT-03 | Explicit altitude changes |
| FLT-05 | Implement bounded geometry/wind iteration and infeasibility detection | FLT-02, FLT-03, DOM-03 | Stable complete phase profile |
| FLT-06 | Implement taxi/run-up, phase, reserve, usable, and total fuel summary | FLT-02, FLT-03, DOM-04 | Complete fuel plan |
| API-01 | Define and test internal airport/METAR/winds API schemas | FND-04 | Versioned transport contracts |
| API-02 | Implement Worker request validation, security headers, errors, and request IDs | FND-01, API-01 | Secure API boundary |
| API-03 | Verify `runway-picker` contract access, versioning, environments, and failure boundaries | API-01 | Evidence-backed integration decision |
| API-04 | Implement compatible `runway-picker` airport adapter | API-02, API-03 | Exact ICAO resolution |
| API-05 | Implement compatible `runway-picker` METAR adapter | API-02, API-03 | Surface weather data |
| API-06 | Implement winds-product upstream adapter and decoder | API-01, API-02 | Normalized authoritative forecast |
| API-07 | Implement Worker caching, rate limiting, timeouts, and stale policies | API-04, API-05, API-06 | Resilient external-data service |
| WX-01 | Implement nearest winds-station selection | API-06, DOM-02 | Explainable station choice |
| WX-02 | Implement explicit forecast valid-time selection | API-06, RTE-01 | Time-correct forecast use |
| WX-03 | Implement vector altitude interpolation | API-06, DOM-03 | Winds at requested altitude |
| WX-04 | Implement sampled effective climb/descent winds | WX-03, FLT-01 | Phase-average wind vectors |
| MAG-01 | Select, license-review, and verify maintained WMM2025 implementation/data | FND-04 | Approved magnetic-model dependency |
| MAG-02 | Integrate WMM through a domain adapter with provenance | MAG-01, DOM-05, DOM-06 | Explainable variation |
| APP-01 | Orchestrate airport, route, aircraft, weather, phase, and magnetic calculations | RTE-02, FLT-05, API-04, API-05, WX-04, MAG-02 | Complete calculated plan |
| APP-02 | Implement weather refresh as a new revision with comparison | APP-01, RTE-02 | Immutable refresh workflow |
| UI-05 | Add generated TOC/TOD/transition rows and infeasibility presentation | FLT-05, UI-02, UI-03 | Visible phase planning |
| UI-06 | Add weather status, selection, raw data, and source views | API-05, WX-02, WX-03, UI-03 | Weather transparency |
| UI-07 | Add revision history, comparison, export, and import | RTE-02, APP-02, STO-02 | Durable plan management |
| UI-08 | Generate a browser-local, print-friendly PDF from a complete saved revision; never import PDF | APP-01, UI-02, UI-05, UI-06, UI-07 | One-way printable navlog artifact |
| QUA-01 | Add end-to-end core-planning and failure-path coverage | APP-01, UI-04, UI-05, UI-06, UI-07, UI-08 | Release-level behavior tests |
| QUA-02 | Complete accessibility and representative-layout validation | UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-07, UI-08 | Accessible desktop and print experience |
| OPS-01 | Implement trusted preview deployment from CI artifacts | FND-03, API-06 | Reviewable deployed previews |
| OPS-02 | Implement release creation and protected production deployment | OPS-01, QUA-01, QUA-02 | Traceable production releases |
| OPS-03 | Add observability, smoke tests, runbook, and rollback validation | API-07, OPS-02 | Operable production service |
| DOC-01 | Complete calculation, weather, provenance, limitation, and user documentation | APP-01, QUA-01 | Release-ready documentation |

### Recommended delivery slices

The issue graph should be delivered in vertical slices rather than completing every backend concern before showing usable behavior:

1. Foundation: `FND-*`.
2. No-wind teaching slice: `DOM-01`, `DOM-02`, `DOM-04`, `DOM-06`, `STO-01`, `AIR-01`, `RTE-01`, `RTE-02`, `UI-01`, `UI-02`, `UI-03`.
3. Wind and heading slice: `DOM-03`, `DOM-05`, `AIR-02`, `OVR-01`, `UI-04`, `TST-01`.
4. Phase-planning slice: `FLT-01` through `FLT-06`, then `UI-05`.
5. Live-data slice: `API-01` through `API-07`, `WX-01` through `WX-04`, `MAG-01`, `MAG-02`.
6. Complete-plan slice: `APP-01`, `APP-02`, `UI-06`, `UI-07`, `UI-08`.
7. Release slice: `QUA-*`, `OPS-*`, `DOC-01`.

## 16. V1 Definition of Done

V1 is complete only when a pilot can enter exact ICAO endpoints, manual checkpoints, departure UTC time, per-leg altitudes, an aircraft profile, taxi/run-up fuel, and reserve fuel; explicitly select applicable weather; generate an explained climb/cruise/descent plan with TOC and TOD; inspect raw sources and every material calculation; deliberately override and restore supported values; save immutable revisions; refresh weather into a new revision; export and import JSON plan data safely; export a print-friendly PDF of a complete saved revision without supporting PDF import; and use the deployed application through a tested, accessible desktop workflow.

All automated quality gates must pass, production deployment and rollback must be documented and smoke-tested, and known limitations must be visible in both the application and user documentation. Human review must confirm that the teaching explanations match the implemented formulas and that the worksheet remains usable at representative laptop sizes.
