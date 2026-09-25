# Print and PDF output

Printing and PDF output are deferred while the core issue #7 planner is being built. The active planner has no print action. A future print workflow must render only a successful current calculation, preserve the page-wide teaching disclaimer, avoid treating a prior session's weather as current, and receive browser layout and pagination review before release.

The current on-screen calculation is session-only. Editing pilot inputs, opening another plan, or reloading removes it until a new successful **Update plan**. There is no plan or PDF import path. When PDF output is implemented, it needs the calculated values only; source identities and interpolation math belong in the on-screen Calculation Inspector.
