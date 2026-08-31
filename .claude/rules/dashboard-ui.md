---
paths:
  - "src/components/**"
  - "src/ui.css"
  - "src/theme.js"
  - "src/nav.js"
---

UI work. Read the `src/components/Dashboard.jsx` and `src/ui.css` rows in
`docs/memory/key-files.md` (they are long because they are load-bearing)
and the UI Conventions in `docs/memory/conventions.md` BEFORE editing.
Dashboard.jsx is ~7,900 lines — search it (Explore agent), never read it
whole.

Hard invariants:
- Verify at 390px; every UI diff gets the smoke walk + screenshots
  (ui-verifier agent) before push.
- Theme token VALUES live only in src/ui.css (+ index.html's pre-paint
  duplicate). Never set a token as an inline style — an inline custom
  property beats `:root` (the dark-mode bug).
- New UI needs `data-mm-*` hooks so CI's render walk actually renders it —
  collapsed-by-default JSX renders for nobody in CI (the `searchOpen`
  lesson).
- Every overlay ships the trio: `useEscClose` + `role="dialog"`/aria-modal
  + registration in BOTH `anySheetOpen` and `closeAllSheets`; sheet state
  declared above `anySheetOpen` (the TDZ hazard passes tests AND build).
- Optimistic edits go through `patchAllTxLists`; a list `reloadData` never
  reaches will otherwise show stale data ("it didn't save").
- No nested interactive elements (button in button is invalid HTML); `Sk`
  skeleton slots are divs.
