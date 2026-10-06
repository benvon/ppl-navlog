# Issue #39: Learning sources focus contrast

The Learning sources `:focus-visible` outline uses the existing `--color-focus`
token (`#0b69a3`), retaining its 3px width and 2px offset. The change is scoped
to those links; other focus indicators retain their existing styling.

## Verification — 2026-10-06

- Relative luminance contrast between `#0b69a3` and the rendered page background
  `#f5f7fa` is **5.4907:1**, exceeding the issue's 3:1 requirement. Calculated
  using sRGB linearization and `(Llighter + 0.05) / (Ldarker + 0.05)`.
- Browser computed styles confirmed a `rgb(11, 105, 163) solid 3px` outline,
  a 2px offset, and `:focus-visible` on each of the three links.
- Tab navigation through all three links was verified at 1280×900 and 390×844.
  Visual inspection confirmed readable text and visible, unclipped outlines,
  including outlines around wrapped mobile link text. The viewport override
  was reset after verification.
- Typecheck, ESLint, and architecture boundaries passed.
- Current-checkout coverage validation passed: 53 files, 651 tests, and all
  configured coverage thresholds (`npm run test:coverage -- --exclude '.worktrees/**'`).
- Build/artifact verification, static routing verification, secret scan,
  workflow lint, and dependency audit passed; audit reported 0 vulnerabilities.
- The unmodified `npm run ci` command failed because it also discovered five
  failing smoke tests in the existing `.worktrees/pr13-leg-fields` checkout.
  That worktree was preserved, and only nested worktrees were excluded in the
  coverage run above. Routing verification was rerun with the local server
  permissions required by its harness.

No remote CI or deployed-site verification was performed.
