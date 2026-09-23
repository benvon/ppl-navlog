# Visible Visual Flight Log PDF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user has selected GPT-6 Luna/medium for implementation. Do not start until the spec and plan have been reviewed.

**Goal:** Make Print / Save PDF reproduce the current visible Visual Flight Log panel, omitting collapsed details and PDF-only content.

**Architecture:** Print the existing panel DOM with a temporary print mode. CSS isolates and paginates that panel. The old separately generated print sheet is removed so screen and PDF cannot diverge.

**Tech Stack:** TypeScript, browser DOM and `window.print()`, CSS `@media print`, Vitest/jsdom; no new dependency.

**Spec:** `docs/superpowers/specs/2026-09-23-visible-navlog-pdf-design.md`

## Global constraints

- Immediate scope is the Visual Flight Log panel only; exclude route, aircraft, and separate inspector panels.
- No PDF-only data or forced-open disclosures. Closed `<details>` elements, including summaries, are omitted.
- Preserve the complete saved revision and weather-evidence gate. Do not print a draft, preview, infeasible result, or incomplete evidence.
- Do not infer a METAR source from `airportIcao`; a nearby ICAO station can differ from a FAA LID airport.
- Do not change storage schema, revision retention, import/export, weather APIs, or calculation math in PR #6.
- Use text nodes for untrusted input. Keep Markdown prose unwrapped and conventional commits signed if committing later.

## File map

- `src/ui/planner.ts`: select the already rendered navlog panel and invoke print with a temporary mode, plus failure/cleanup handling.
- `src/ui/styles/print.css`: isolate that panel in landscape output, retain displayed values, and omit closed disclosures.
- `src/ui/printable-navlog.ts`: delete the independent renderer after the live-panel path replaces it.
- `src/ui/printable-navlog.test.ts`: delete renderer-specific expectations; move observable behavior coverage into `src/ui/planner.test.ts`.
- `src/ui/planner.test.ts`: cover the action, evidence gate, disclosure state, and older METAR evidence with different departure LID.
- `docs/pdf-output.md`: document that the PDF is the current panel view and that collapsed details are omitted.

## Review focus

- A saved calculation with a missing weather snapshot must report failure and never call `window.print()`.
- An older applied interpolation with `metar.icao = "KORD"` and `airportIcao = "1C8"` must never produce a fabricated METAR label.
- Closed and open disclosures must retain their `open` state after print; only open ones appear in PDF.
- A selected numeric cell must print its visible text despite its button wrapper.
- Cancellation or a throwing print API must leave a usable, ordinary screen with no hidden duplicate sheet.

---

### Task 1: Print the rendered panel

**Files:** Modify `src/ui/planner.ts`, `src/ui/planner.test.ts`; delete `src/ui/printable-navlog.ts` and its direct test after coverage moves.

**Interfaces:** `Planner.printCurrentRevision(): void` consumes `this.state.currentRevision`, `this.state.weatherSnapshots`, and the rendered `[data-region="navlog"]`. It sets the `printing-navlog` body class and calls `window.print()`; `afterprint` removes the class. No new public interface.

- [ ] **Step 1: Add a failing interaction test.** Adapt the existing “offers browser-local PDF printing” test around the existing `MemoryPersistence`, `createCompleteFlightFixture`, and `clickByLabel` helpers. Assert the following after opening the saved plan and clicking Print; confirm the test fails before implementation:

```ts
const panel = root.querySelector<HTMLElement>('[data-region="navlog"]');
const closed = panel?.querySelector<HTMLDetailsElement>("details");
expect(panel).not.toBeNull();
expect(closed?.open).toBe(false);
clickByLabel(root, "Print / Save PDF");
expect(print).toHaveBeenCalledOnce();
expect(document.body.classList.contains("printing-navlog")).toBe(true);
expect(document.querySelector(".print-sheet")).toBeNull();
expect(panel?.querySelector("details")).toBe(closed);
window.dispatchEvent(new Event("afterprint"));
expect(document.body.classList.contains("printing-navlog")).toBe(false);
```

Use a copied weather fixture with `surfaceToAloftInterpolation: { ...evidence, airportIcao: "1C8", metar: { ...evidence.metar, icao: "KORD" } }` and no top-level `surfaceWeatherIcao`; assert no “Surface METAR Unavailable” string appears. Do not use `airportIcao` as the METAR label.
- [ ] **Step 2: Add the missing-evidence and throwing-print cases.** Inject `weatherEvidence.getWeatherSnapshot: async () => undefined` and assert `window.print()` is not called plus visible feedback. For a valid revision, use `vi.spyOn(window, "print").mockImplementation(() => { throw new Error("print unavailable"); })` and assert print mode is cleared and the feedback reports failure. Verify both fail first.
- [ ] **Step 3: Replace the print path.** Remove the `createPrintableNavlog` import. Give the action a `print-navlog-action` class for CSS. The guard and cleanup should have this shape; keep existing feedback language where accurate:

```ts
const completeEvidence = revision.weatherSnapshotIds.length > 0 && revision.weatherSnapshotIds.every(
  (id) => this.state.weatherSnapshots.some((snapshot) => snapshot.id === id),
);
const panel = this.content.querySelector<HTMLElement>('[data-region="navlog"]');
if (!isCalculatedRevision(revision) || !completeEvidence || panel === null) {
  this.feedback.textContent = "Only a complete saved calculated revision with weather evidence can be printed.";
  return;
}
const cleanup = (): void => {
  document.body.classList.remove("printing-navlog");
  window.removeEventListener("afterprint", cleanup);
};
document.body.classList.add("printing-navlog");
window.addEventListener("afterprint", cleanup, { once: true });
try { window.print(); } catch (error) { cleanup(); this.reportError(error); }
```

Do not append a clone or change any `<details open>` state.
- [ ] **Step 4: Run the focused test.** `mise exec -- npm test -- src/ui/planner.test.ts` must pass. Remove the obsolete renderer and its direct test only after the panel test covers the behavior.

### Task 2: Print stylesheet and output documentation

**Files:** Modify `src/ui/styles/print.css`, `docs/pdf-output.md`; test through `src/ui/planner.test.ts` plus browser PDF inspection.

**Interfaces:** `.printing-navlog` is the only explicit print trigger. `[data-region="navlog"]` is the only printed workspace region. The existing `.navlog-value` text stays visible.

- [ ] **Step 1: Replace `.print-sheet` rules.** Keep the existing `@page` landscape intent and use selectors with this scope (add compact table/row/header rules as needed). Hide only action controls; a `.navlog-value` button contains the displayed cell value and must remain visible.

```css
@media print {
  body.printing-navlog .app-shell > :not(.planning-workspace),
  body.printing-navlog .planner-shell > :not(.planner-content),
  body.printing-navlog .planner-layout > [data-region]:not([data-region="navlog"]),
  body.printing-navlog [data-region="navlog"] .print-navlog-action,
  body.printing-navlog [data-region="navlog"] details:not([open]) { display: none !important; }
  body.printing-navlog .planner-layout { display: block; }
  body.printing-navlog .navlog-table-scroll { overflow: visible; }
  body.printing-navlog .calculated-navlog table { min-width: 0; }
  body.printing-navlog .calculated-navlog thead { display: table-header-group; }
  body.printing-navlog .calculated-navlog tr { break-inside: avoid; }
}
```
- [ ] **Step 2: Update docs.** Replace the description of a separate immutable print sheet with the panel-at-click contract; say that opening a disclosure before printing includes it and closing omits it. Keep the local browser Save as PDF instructions and saved-revision/evidence limits.
- [ ] **Step 3: Inspect a browser-generated landscape PDF.** Use the complete-flight fixture or a saved local test plan. Check a five-row case and a long enough table to paginate: no other workspace panel, no closed disclosure, no clipping, repeated headings, visible warnings, and no added source label. Record the browser/version and result in the PR testing notes; if browser automation is unavailable, report visual inspection as unverified rather than calling it passed.

### Task 3: Finish the PR #6 validation gate

**Files:** Tests and docs already listed; no data-lifecycle files.

- [ ] **Step 1: Run `mise exec -- npm run typecheck`, `mise exec -- npm run lint`, `mise exec -- npm run lint:boundaries`, and `mise exec -- npm test`.** Resolve failures caused by the PDF change; distinguish unrelated failures.
- [ ] **Step 2: Run `mise exec -- npm run build` and `mise exec -- npm run security:secrets`.** Confirm the built stylesheet contains the print isolation and the secret scanner reports clean output.
- [ ] **Step 3: Review `git diff --check`, `git diff`, and `git status --short`.** Ensure no storage, weather, calculation, or unrelated workspace files changed. The deferred lifecycle belongs in its GitHub issue.

## Handoff boundary

Stop after the PR #6 PDF behavior and its verification. The user-data revision/backup redesign is a separate issue and separate implementation approval. The issue carries its own architecture, migration, and acceptance criteria; do not begin it as a consequence of this plan.
