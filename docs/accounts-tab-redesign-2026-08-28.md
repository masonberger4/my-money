# Accounts tab redesign — collapsible sections + account tiles (2026-08-28)

**Status: SHIPPED.** Process doc, kept at Mason's request ("save the planning doc
to the repository"). Every durable rule from it now lives in the memory docs —
the `Dashboard.jsx` key row (docs/memory/key-files.md) and the localStorage
device-pref Convention (docs/memory/conventions.md) — read those
first; this file is the reasoning trail behind them, not a second source of truth.

## The ask

Mason shared three screenshots of a reference app's Accounts screen and asked to
"make the style of the accounts tab look similar to this with open and closable
carrots. With tiles for each account that make a large clickable rectangular
area." Then, on the actions: "the add account and manage connections lives at the
bottom of the accounts page, same as what is in the picture." And on the third
screenshot (an account's own page): "clicking an account opens a page where that
account's transactions appear. A back button appears top left."

Reference anatomy taken from the screenshots:

- Section header on the page background: caret + bold section name, section total
  right-aligned (green when positive). Tapping it folds the section to just that
  header.
- One rounded container per open section; each account a large full-width tile —
  mark, name, balance, `›` — with inset dividers.
- Full-width pill actions stacked at the bottom of the page.
- The account page: back button top-left, then that account's transactions grouped
  under long-date headers with signed amounts.

## What shipped

All in `src/components/Dashboard.jsx` (plus one smoke-mock fidelity fix).

1. **Collapsible sections.** Cash / Credit / Loans / Hidden. Header is a real
   `<button aria-expanded>` with the app's existing ▾/▸ caret vocabulary; body is
   a `.card` of tiles. State is `acctCollapsed` — the list of COLLAPSED labels,
   persisted per device at `mm:acctCollapsed`.
2. **Tiles.** `.tx` rows at `padding:"13px 0"` (~64px tall), whole row navigates to
   the account page, muted `›` at the far right, balance green when
   `displayBalance > 0` (matching the section total above it).
3. **Bottom pills.** Add Account · Import Statement · Manage Bank Connections.
4. **Account page transaction list** day-grouped via `src/txList.js` with the
   Spending list's row-level signed amounts.

## Decisions worth keeping (the reasoning, not the rules)

- **Default open, and store the COLLAPSED set.** Two reasons that point the same
  way: a collapsed-by-default screen renders for nobody in CI's smoke walk (the
  `searchOpen` lesson, already recorded), and storing collapsed-rather-than-open
  labels makes "nothing stored" mean "everything open" — so a new section, or a
  fresh install, can never start folded. A stale label from an earlier install
  simply never matches a rendered section.
- **localStorage, not `settings`.** The `mm:theme` / `mm:cardTile` rule: `settings`
  is household-shared under one login, so folding Credit on one phone would fold
  it on the other.
- **The rename had to leave the tile.** `EditName` opens on DOUBLE-click, so its
  `stopPropagation` wrapper swallowed single taps across the widest part of the
  row — the exact spot a thumb lands. Caught by the screenshot harness, whose
  centre-of-element click did nothing. The two gestures cannot share the row
  either: a double-click's first click would navigate away. Rename and the
  editable `Swatch` moved to the account page's header, where nothing competes
  for the tap; the tile's colour chip became the static `markOn` mark the Debt
  tab already uses. **The first cut of this commit left the Swatch on the tile**
  — an adversarial review of the diff caught it, four separate prose sites
  (comment, commit message, CLAUDE.md, this doc) already claiming it had moved
  while the code kept a 14px zone that swallowed the navigation tap and wrote a
  colour to the database on a mis-tap. The lesson is the enforceable phrasing:
  "wholly navigational" means the tile has NO interactive child, which is a
  thing you can check, unlike "the tap area is big".
- **Feed badges came off the tile.** `acctInst` already prints "Imported" or the
  bank's name on the line below, and a hidden account only ever renders inside the
  Hidden section at half opacity — so the badges were duplicating information
  while costing a wrapped second line at 390px on any name long enough to collide
  with one.
- **Import Statement is a pill, not a quieter link.** It is the only route to
  history older than the feed's ~88-day window, so it must not be the hard one to
  find. Add Account and Manage Bank Connections open the same
  `SimpleFinConnect` modal (it is both the link flow and the
  status/disconnect/Restore surface) but stay two rows because they are two
  errands.
- **The Hidden section header carries a COUNT, not a total.** Hidden balances are
  excluded from every total in the app; printing one here would contradict that at
  a glance.
- **The smoke mock now sorts date-desc** like the real
  `getAccountTransactions` query. `groupByDay` preserves the caller's order by
  contract, so an unsorted mock rendered correct code as out-of-sequence date
  headers — a mock that makes a working screen look broken is a mock bug, and the
  component keeps the documented contract rather than adding a second sort.

## Deliberately NOT done

- No schema, adapter or query change; no new dependency; no new CSS class (the
  tile and header are inline-styled like the rest of the file).
- The account page's other panels (Hide/Remove, account type, rental property)
  are untouched — only its transaction list changed.
- The Feed reach and Data coverage cards below the list are untouched.
