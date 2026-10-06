# Saved pilot inputs and disposable calculations

The active planner stores one current input document per plan, along with aircraft profiles, in the browser's local IndexedDB database. It preserves literal editor text, including incomplete or invalid values, ordered checkpoints, selected aircraft inputs, and override reasons. There is no submission or revision history.

Checkpoint names and coordinates live only in `checkpoints`, and current TAS override reasons live only in `overrideReasons`. `rawFields` holds base route text, aircraft profile draft text, and TAS override text. Earlier redundant raw checkpoint/reason copies are removed on the next editor save; unrelated raw fields are preserved. Removing a checkpoint preserves the remaining literal checkpoint text and clears route overrides and reasons. Textbox comparison baselines remain in memory only. The supported controls require at most 46 raw entries (9 base fields, 11 profile fields, and 26 TAS overrides), within the existing 100-entry map limit. String and document size limits still apply.

**Save changes** saves the current inputs without requesting weather or calculating. Leaving an input field does not save. **Update navlog** saves the current input document, including the selected profile snapshot, then validates the required inputs before airport or weather retrieval. A failed save stops the update. A failed retrieval or calculation leaves the inputs saved and shows the error.

Airport responses, METAR and winds products, source evidence, calculations, and inspector traces exist only in memory. Input edits invalidate the current result. A failed update clears the prior result. Reopening a plan or reloading starts without calculations and requires **Update navlog**. Nothing copies a calculated result or weather evidence into saved plan data.

Weather sampling and the calculation steps follow the [teaching contract](navigation-worksheet-teaching-contract.md). Status wording describes checks of the selected planning weather inputs; this is not a complete preflight briefing.

The inactive revision planner, revision journal, calculation persistence, and hidden input submission history have been removed. Saved plans carry an explicit current schema version. Unsupported or unversioned stored plans are discarded with a notice to create a new plan; there is no migration of submission history or obsolete fields. Malformed current-format data produces a validation error. The old revision database is not opened by the application.

Printing and plan/profile import/export are deferred. The Worker receives only lookup parameters required for airport and weather calculations, not saved plans.
