# UI Composition and Theming Boundary

The issue #7 planner's actions and session state stay in `src/ui/pilot-intent-planner.ts`. It renders pilot input controls and the calculated worksheet and inspector after a successful update. Pilot input persistence is handled through `PilotInputRepository`; airport and weather retrieval and calculation run for the explicit **Update plan** action. The result and its provenance are in memory for the current session only. Editing inputs, a failed update, opening a plan, or reloading leaves no current result.

`src/ui/styles.css` imports token, layout, component, and print stylesheets. The token layer holds palette, spacing, and radius custom properties; the component layer styles controls, tables, and the inspector. Some layout and print selectors target the former planner's `data-region` structure and do not describe the current issue #7 planner markup.

The calculated worksheet remains a separate view in `calculated-navlog.ts`. It accepts an optional inspection callback and emits a row/field selection, not a CSS or DOM layout instruction. `calculation-inspector.ts` renders the current result's trace data using text nodes. Selecting a value updates the inspector and active-cell state without replacing the worksheet table. Raw row evidence remains available as a secondary disclosure while that result is in memory.

This structure does not yet claim a finished design or completed accessibility audit. The former `workspace-layout.ts` description of four `data-region` areas belongs to the earlier revision-based planner and is not a contract for the active issue #7 UI. The interface still needs keyboard, screen-reader, responsive, and browser print review.
