# Visible Visual Flight Log PDF design

## Intent and scope

The **Print / Save PDF** action is in the Visual Flight Log panel. Its output must contain the information visibly rendered in that panel at the instant the action is invoked, with print-friendly layout. It must not invent PDF-only sections or expand a collapsed disclosure. The action does not print the editable aircraft, route, or separate inspector panels. That panel scope follows the action's current placement and avoids presenting unsaved editor values as if they belonged to the saved calculation.

This is the immediate PR #6 slice. The separate durable-data lifecycle is deferred to a repository issue. There is no storage schema, weather provider, calculation formula, or revision-retention change in this slice.

## Repository truth

`src/ui/planner.ts` renders the current saved calculation through `renderCalculatedNavlog` and a separate collapsed raw-weather disclosure, then builds an unrelated hidden `.print-sheet` through `createPrintableNavlog`. `src/ui/calculated-navlog.ts` owns the visible row values, fuel notices, warnings, and disclosure state. `src/ui/printable-navlog.ts` instead adds metadata, expanded phase boundaries, fuel buckets, weather evidence, assumptions, and caveats that can be absent or collapsed on screen. Its applied-interpolation sentence reads `surfaceWeatherIcao`, whereas older saved evidence can carry the selected METAR identity in `metar.icao` without that top-level property. The result is a false “Surface METAR Unavailable” label. `airportIcao` is the departure airport and cannot stand in for an explicitly selected nearby METAR ICAO when a FAA LID and reporting station differ.

## Selected approach

Print the actual rendered Visual Flight Log panel, using print CSS to isolate that existing DOM and fit its table to landscape pages. No second data renderer or cloned data tree is needed. Keep the current requirement that a complete saved calculated revision and all referenced weather evidence be available before enabling print. When unsaved editor changes exist, the visible “Viewing the saved revision” notice prints with the saved log; the action never calculates or silently substitutes unsaved values.

The print-only differences are presentation: hide the action button and interaction affordances while retaining their displayed values, remove page chrome and other workspace panels, allow the horizontally scrollable table to flow across printed pages, repeat table headers, and prevent row splits where the browser supports it. A closed `<details>` element is omitted in its entirety, including its summary. An open one prints its visible summary and content. Print must preserve the current on-screen numeric formatting, row order, warnings, and visible weather source statements. It does not fetch data or write a revision.

## Interfaces and failure behavior

- `Planner.printCurrentRevision()` obtains the already rendered `[data-region="navlog"]` node. It refuses printing when the open revision is not complete, any referenced weather snapshot is missing, or the panel is unavailable. Missing evidence is reported in the existing planner feedback region.
- The print mode is a temporary DOM/CSS state around `window.print()`; it does not mutate the revision, current selection, disclosure `open` attributes, or saved weather evidence. Cleanup follows `afterprint` and also handles a thrown print call.
- `src/ui/styles/print.css` targets that panel only during the explicit action. It hides controls such as Print / Save PDF without hiding their neighboring content; `.navlog-value` button text remains printable as text.
- The old `createPrintableNavlog` output path is removed once the panel print path is covered. That removes the divergent interpolation label. If an interim targeted fix is needed before removal, the source identity is `surfaceWeatherIcao ?? metar.icao` only when each is a valid four-character ICAO; never infer it from `airportIcao`, and omit the sentence if neither is trustworthy. No legacy migration framework is introduced.

## Acceptance criteria

1. For a complete saved revision, printed panel text and row count match the visible Visual Flight Log panel at click time, apart from interaction labels and print styling. There is no PDF-only metadata, fuel breakdown, or interpolation sentence.
2. Closed raw row, phase/weather, refresh-comparison, and raw-weather disclosures contribute no summary or body to print. Opening one includes exactly its currently visible content; printing does not change its open state.
3. A selected value's displayed number prints. No separate Calculation Inspector panel is included.
4. The saved-revision/unsaved-input notice, fuel warning, and weather warnings print if visible. A calculation preview, draft, infeasible revision, or revision missing referenced weather evidence cannot use the action.
5. A historical applied interpolation with `metar.icao = "KORD"` and `airportIcao = "1C8"` cannot print “Surface METAR Unavailable” or claim 1C8 as the METAR source. Since the separate sentence disappears, the exact visible statement/raw evidence is the only printable source explanation when disclosed.
6. Print uses local browser functionality only. A cancelled dialog, an `afterprint` event, or a thrown `window.print()` leaves the normal screen usable without duplicate print DOM.
7. Unit/integration tests cover panel selection, closed/open disclosures, missing evidence, older interpolation data, and escaping of user/source text. Typecheck, lint, boundary checks, relevant tests, and a browser landscape PDF inspection pass before calling the change complete.

## Deferred work

Do not alter the current 20-revision retention, single-plan recovery archive, IndexedDB schema, or weather/calculation persistence in PR #6. Those require an intentional upgrade and backup design captured in the data-lifecycle issue.
