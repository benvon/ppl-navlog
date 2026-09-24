# Print and PDF output

The issue #7 planner exposes **Print current plan** only while a successful calculation result is available in the current session. It invokes the browser's `window.print()` action. The result is ephemeral; printing does not save a calculation, weather evidence, or a revision to IndexedDB. The planner must be updated again after opening a plan, editing pilot inputs, or reloading.

The print action is browser-local and does not refresh weather or upload planning data. Browser print layout and output have not been verified for the issue #7 planner, so this action is not documented as a finished worksheet PDF export. There is no PDF import path. The application remains a teaching and planning aid, not an official weather briefing or complete preflight plan.
