# YNAB-inspired redesign — build spec (2026-08-15)

**What this is:** the approved, build-ready spec for the YNAB-style UI redesign +
4-type transaction model (Mason, 2026-08-15). It is a SESSION-STARTER process
artifact (the `docs/next-session-prompt.md` precedent): a fresh session must be
able to execute it start to finish with no input beyond the one
migration-sequenced step called out in PR D. It is NOT a second roadmap —
`docs/next-iteration-plan-2026-08-04.md` keeps that job.

**Lifecycle:** each PR edits THIS file to mark its own phase shipped (so a
session that dies mid-sequence leaves an honest state). The PR that finishes
PR F DELETES this file after migrating its durable rules into CLAUDE.md —
grep the filename repo-wide first (maintenance-contract rule).

**Every PR follows the ONE standard flow** (CLAUDE.md Development workflow):
fetch + absorb `origin/main` (merge, never rebase; re-check this spec's
premises against moved code — main moves) → green `npm test` → placeholder-env
build (`VITE_SUPABASE_URL=https://placeholder.supabase.co
VITE_SUPABASE_ANON_KEY=placeholder npm run build`) → screenshots at 390×844 in
BOTH themes for UI work → push → open PR → arm auto-merge (squash) → confirm
the merge landed. CLAUDE.md is maintained in the SAME PR as any change that
alters a recorded rule. Exception: PR D is migration-sequenced — see its
section; do NOT arm auto-merge there until Mason confirms the SQL paste.

Build order: **A → B → D → C → E → F** (D before C because the redesigned list
renders type pills that need `tx_type` on the tx shape). One PR per session is
the safe default; a session may chain PRs if each merges before the next
branches.

## Ship record (updated by each PR)

- [x] PR A — tokens + primitives (shipped 2026-08-15)
- [ ] PR B — bottom nav + IA + smoke harness
- [ ] PR D — user_type migration + model (MIGRATION — Mason pastes SQL)
- [ ] PR C — Spending list redesign
- [ ] PR E — transaction detail sheet + type selector
- [ ] PR F — final re-skins + CLAUDE.md migration + delete this doc

---

## 0. Decisions settled during planning (do not relitigate during the build)

1. **PR order is A, B, D, C, E, F.** D moved ahead of C so the Spending list
   can render "Transfer"/"Card payment" pills from `tx_type` without shipping
   the list twice.
2. **`user_type='transfer'` is NOT implemented by stamping `_internal`.**
   Mechanism: rows with non-null `user_type` are removed from
   `markInternalTransfers`' candidate pool, and `isSpend`/`cashIncome` read
   `user_type` DIRECTLY. Reason: `_internal` only exists on row sets that went
   through pairing — the account sheet and search results never pair, so a
   stamp-based design would be wrong exactly where the `counted` caveat
   already bites. Direct predicate reads make every surface (paired or not)
   honor the override; nothing but `isSpend`/`cashIncome` reads `_internal`,
   so no third consumer is stranded.
3. **Sign guards outrank `user_type`.** `isSpend` keeps `amount <= 0 → false`
   BEFORE the override read; `cashIncome` keeps
   `type==='depository' && amount < 0` as the outer gate. Consequence:
   `'spending'` on a money-in row is inert (otherwise `sumSpending` would ADD
   a negative and silently shrink totals), and `'inflow'` on a money-out row
   is inert. The UI mirrors this: the four-type menu renders all four but
   disables the sign-incompatible one with a one-line muted reason.
4. **Paired-row display refinement:** an `_internal` row displays
   `card_payment` (not `transfer`) when it sits on a credit account OR its
   wording passes `isCardPaymentDescriptor`; otherwise `transfer`. "Internal
   pair = Transfer" unconditionally would label every checking→card payment
   "Transfer" on both legs, contradicting the YNAB vocabulary this feature
   adopts. Display-only; totals identical.
5. **Loan rows ignore `user_type` entirely** (not just "no selector"): an
   account retyped to `loan` after an override was written must not resurrect
   the override. `isLoanAccount` stays ahead of the override read in
   `isSpend`, and `deriveTxType` returns the display-only `'loan'` before
   looking at `user_type`.
6. **Page titles are 30px / weight 600 / `letterSpacing:"-.03em"`.** The
   shipped `dm-sans.woff2` is a 400–600 variable font; a heavier weight means
   a new woff2 → precache + sw `CACHE_VERSION` bump + preload + lockstep
   churn. Not worth it. Deliberate.
7. **Light palette values do not change.** "Both themes first-class" is
   satisfied by shared typography/radius/spacing and the dark palette moving
   to navy; keeping `--light-*` byte-identical keeps index.html's light
   meta/backgrounds, the light paletteContrast fixtures, and the recorded
   `--light-muted` 3.61:1 note all true — half the lockstep blast radius.
8. **`test/paletteContrast.test.js`: only the theme-mirror fixtures update.**
   `DARK_SURFACES` (L40) and the `#222224` fixtures (L210–212) mirror ui.css
   and must change. The `#FFFFFF`/`#18181A` literals in the
   direction/reachability tests (L270+) are MATH EXTREMES, not theme mirrors —
   leave them (the new bg `#12141F` is darker than `#18181A`; swapping it in
   could flip the deliberately-failing mid-grey fixtures). Add a one-line
   comment there saying so.
9. **Client reads get a 42703 degrade; the server does not.** Belt-and-braces
   is REQUIRED on the client because a missing `user_type` in
   `SPEND_TX_COLUMNS` would surface through `getEnvelopes` and could trip
   `isEnvelopeSchemaMissing` (any bare 42703 reads as "envelopes not
   installed" — kills the Budget tab). `api/_lib/spendingContext.js` relies on
   the paste-before-merge order with a comment: a loud assistant failure beats
   a silent fork, and the server has no equivalent misread hazard.
10. **Two-line transfer payee ("Transfer to X / From Y") is DEFERRED**: a row
    does not know its pairing partner (pairing stamps a boolean, not a link).
    Rows show the Transfer/Card-payment pill + the bank descriptor.
11. **Row-level signed amounts** (outflows "−$X", inflows green "+$X") apply
    at ROW level only; aggregate "Spent" figures everywhere stay positive
    magnitudes (`fmt`/`fmtX`, `sumSpending` untouched). YNAB does the same.
12. **"Done", not "Approve"**, on the detail sheet: there is no
    approved/reviewed column in v1 (deferred), and a Save-labeled button that
    doesn't save anything new would lie.

Verified during planning (2026-08-15), so the build session doesn't have to:
`isSpend`/`cashIncome`/`markInternalTransfers` bodies match the edits below;
`user_type` appears nowhere in the repo; the `transactionsHaveEntity` 42703
retry exists at dataAdapter.js ~L184/~L558/~L1058; `api/sync.js` txRows,
`csvImport.js` `INSERT_KEYS` and `buildManualTxRow` are explicit-column
payloads (a new column is omitted by construction); both spendingContext tx
selects are explicit-column (L101, L164) and copy rows via spread; the smoke
harness pins `EXPECTED_TABS = 10` on `.tab` selectors; index.html's dark
values live at the theme-color meta (~L19) and two background lines
(~L46/~L49); every palette ratio quoted below was computed with the real
`src/paletteContrast.js`.

---

## 1. Visual reference (YNAB iOS, dark mode — in words; the screenshots do not travel)

- Overall: near-black navy background; cards one step lighter navy; 16–20px
  card radius; roomy padding; large bold headings; muted grey-lavender
  secondary text; ONE periwinkle accent for interactive labels/buttons (ours
  stays `#7F77DD` light / `--dark-accent #A79FF0` dark).
- Bottom navigation: floating full-width rounded bar, 5 items (icon over
  ~11px label): Home, Plan, Spending, Accounts, Reflect; active item gets a
  lighter rounded-pill background + accent tint; a count badge may sit on one
  item (ours: Uncategorized count on Spending).
- Page headers: huge left-aligned page title; small round icon buttons
  (search, +, theme, …) top-right.
- Spending screen: banner card "N new transactions" with the count in a small
  pill + an accent "Review" button; the list grouped by day with
  "August 14, 2026" section headers; each row: payee bold; right-aligned
  amount (outflows "−$100.68" plain, inflows green "+$…"); second line: small
  dark category chip (emoji + name) left, muted account name under the amount
  right; transfer rows show a "Transfer" pill instead of a category chip;
  floating "+ Transaction" affordance (ours: header button, NOT a FAB).
- Accounts screen: collapsible sections "Cash" / "Credit" (+ "Loans" for us),
  each with a chevron and right-aligned section total; one card per section;
  rows: circular colored institution badge, name (may wrap), right-aligned
  balance — positive green, zero/negative plain with "−$"; inset dividers.
- Reflect screen: report cards. "Spending Breakdown": accent title + chevron,
  muted month label, huge month total, a horizontal color-segmented stacked
  bar (one segment per top category), a "Top Categories / Spent" header, rows
  of color-dot + name with right-aligned amounts, ending in "All Others".
  "Income vs. Spending": a plain-language insight sentence above the chart.
- Transaction detail sheet (tap a row): full-screen; top ~30% a lighter
  gradient header with ✕ close and a huge centered amount; beneath it a pill
  showing the current type, opening a menu of EXACTLY four types — Spending,
  Inflow, Credit Card Payment, Transfer — checkmark on the active one; below,
  a grouped card of rows with leading icons + trailing chevrons: Payee,
  Category (chip), Account (badge + name), Date; a second card: Photo, Memo
  (Memo deferred for us — `user_description` IS the rename); bottom: a
  "Show more" expander and a prominent rounded-full accent button.

---

## 2. IA (final)

Five bottom-nav items; the ten internal `tab` state values are KEPT UNCHANGED
so every body gate (`tab==="categories"&&…`), the month-picker clamp
(`maxAhead={tab==="budget"?12:0}`), `jumpToTax`, and the lazy-load effects
keep working untouched:

| Nav item | Label | `tab` values it owns |
|---|---|---|
| Home | Home | `overview` |
| Plan | Plan | `budget` |
| Spending | Spending | `transactions` |
| Accounts | Accounts | `accounts`, `debt` (segment control) |
| Reflect | Reflect | `reflect` (new hub), `categories`, `trends`, `recurring`, `tax`, `ask` |

- New pure module **`src/nav.js`**: `NAV_ITEMS` (5 objects
  `{id, label, icon, tab}`), `navForTab(tab)` (each of the 11 tab values → its
  nav id; unknown → `'overview'`), `REFLECT_TABS =
  ['categories','trends','recurring','tax','ask']`, `pageTitle(tab)`.
  Test `test/nav.test.js`: every tab value maps to exactly one nav item;
  reflect list complete; titles non-empty.
- Reflect children render a `‹ Reflect` back button above their body;
  the Accounts screen gets an `[Accounts | Debt]` two-chip segment control
  (`setTab('accounts'|'debt')`).
- The single nav handler `go(t)` carries the existing side effects verbatim:
  `setTab(t); if(t!=="accounts")setSelAcct(null);
  if(t!=="budget"&&isFuture)goCurrentMonth();`.
- The month cursor stays global (state untouched); a compact "‹ August 2026 ›"
  pill renders under the page title on month-scoped screens only
  (overview, budget, transactions, categories) — display placement only.
- **Review banner = the Uncategorized backlog**: count of viewed-month rows
  with `category === UNCATEGORIZED`; "Review" sets
  `txCatFilter(UNCATEGORIZED)` (toggle-off when already active). NO
  approved/reviewed column in v1 — deliberately deferred.
- **"+ Transaction"** = existing `QuickAddSheet`, launched from a `+` icon
  button in the Spending page header. No global FAB (Mason's 2026-08-01
  ruling stands).

---

## 3. The 4-type model (PR D implements exactly this)

### 3.1 Pure-model edits

**`src/cashFlow.js` — `markInternalTransfers` candidate gate** (~L44):

```js
if (t.excluded || t.accounts?.type === 'loan' || t.user_type) continue;
```

An explicit verdict never pairs; a formerly-matched partner re-derives
structurally on the next read (the correct outcome for the false-wash case:
mark the outflow leg `'spending'` and the inflow leg becomes income by
structure).

**`src/cashFlow.js` — `cashIncome`** (body becomes):

```js
if (t.excluded || t._internal) continue;
if (t.accounts?.type !== 'depository' || t.amount >= 0) continue;
if (t.user_type && t.user_type !== 'inflow') continue;
total += Math.abs(t.amount);
```

So: `'inflow'` on a depository negative counts (a falsely-washed paycheck can
be forced to count once it leaves the pool); any other override vetoes income;
income still counts depository inflows ONLY — `'inflow'` on a credit negative
behaves like Return (never income, never spending).

**`src/spending.js` — `isSpend`**:

```js
export function isSpend(t) {
  if (t.excluded || t._internal || isLoanAccount(t)) return false;
  if (t.amount <= 0) return false;
  if (t.user_type) return t.user_type === 'spending';
  return !isCardPaymentRow(t);
}
```

Precedence by construction: `excluded` > loan > sign > `user_type` >
structure (including both the `user_category === TRANSFER_CATEGORY` veto and
the descriptor veto — a `'spending'` override on a card-payment-worded row
counts). Also **promote `isCardPaymentRow` to an export** (same predicate,
new consumer — not a second predicate; say so in its comment).

**`src/spending.js` — derivers** (they live HERE because spending.js owns
`isCardPaymentRow`/`isLoanAccount` and already imports txClassify — no import
cycle):

```js
export function deriveTxType(t) {            // structural display type
  if (isLoanAccount(t)) return 'loan';       // informational; never storable
  if (t._internal) return (t.accounts?.type === 'credit'
      || isCardPaymentDescriptor(t.description)
      || isCardPaymentDescriptor(t.merchant_name))
    ? 'card_payment' : 'transfer';
  if (t.amount > 0) return isCardPaymentRow(t) ? 'card_payment' : 'spending';
  return 'inflow';   // depository negative = income; credit negative = Return
}
export function effectiveTxType(t) {
  if (isLoanAccount(t)) return 'loan';       // loan rows IGNORE user_type
  return TX_TYPES.includes(t.user_type) ? t.user_type : deriveTxType(t);
}
```

**New `src/txType.js`** (pure; imports from `./spending.js` only):

```js
export const TX_TYPES = ['spending','inflow','transfer','card_payment'];
export const TX_TYPE_LABELS = { spending:'Spending', inflow:'Inflow',
  transfer:'Transfer', card_payment:'Credit Card Payment', loan:'Loan' };
export { deriveTxType, effectiveTxType } from './spending.js';
export function allowedUserTypes(t) {        // drives the selector's enabled set
  if (isLoanAccount(t)) return [];
  return t.amount > 0 ? ['spending','transfer','card_payment']
                      : ['inflow','transfer','card_payment'];
}
```

(`TX_TYPES` is needed inside spending.js's `effectiveTxType` — define the
array in spending.js and re-export it from txType.js, or inline the
membership check; either way ONE copy.)

**`src/spending.js` — `toTxShape`** adds three fields (mirrors the
`auto_category`/`auto_description` pattern, which is what satisfies the
saveTx derived-fields invariant):

```js
user_type: t.user_type ?? null,
auto_tx_type: deriveTxType(t),
tx_type: effectiveTxType(t),
```

**`src/spending.js` — `patchTxShape`** adds:

```js
if ('user_type' in fields) next.tx_type = fields.user_type || t.auto_tx_type;
```

`counted` stays deliberately un-recomputed (needs `accounts.type` + pairing —
the existing documented caveat; `saveTx` already calls `reloadData` which
heals the month list). The same accuracy caveat as `counted` applies to
`auto_tx_type` on unpaired lists (search/account sheet may show `spending`
for a washable transfer leg) — document beside the `counted` comment.

### 3.2 Read paths — every select that gains `user_type`

| Site | Change |
|---|---|
| `TX_COLUMNS` (dataAdapter.js ~L138) | gains `user_type` via the degrade below |
| `SPEND_TX_COLUMNS` (~L252) | gains `user_type` (isSpend now reads it) — `RECURRING_TX_COLUMNS` inherits |
| `fetchRawBetween` (~L157) | new module flag `transactionsHaveUserType` (init `true`, beside `transactionsHaveEntity` ~L1594); append `', user_type'` to the built `cols` when the flag is set — for BOTH the wide and explicit-`columns` paths; in the catch, `if (transactionsHaveUserType && isMissingColumnError(error, 'user_type')) { transactionsHaveUserType = false; retry }` alongside the existing `entity_id` retry. This protects the Budget tab's `isEnvelopeSchemaMissing` gate |
| `getAccountTransactions` (~L549) | same flag + retry (mirrors the `transactionsHaveEntity` retry there) |
| `searchTransactions` (~L1047) | same flag + retry |
| `addManualTransaction` read-back select (~L1569) | rides `TX_COLUMNS` + the flag |
| `getAccountTransactionsInRange`, `getExistingTxIds`, coverage probes | UNCHANGED — reconcile/probe reads, never classify |
| `api/_lib/spendingContext.js` L101 and L164 | append `, user_type` to both selects; the row copies spread `...t`, so nothing else changes; add the comment: "no degrade here — the migration pastes before the merge; a loud failure beats a silent fork." Byte-determinism holds (`user_type` is a pure function of the row) |

### 3.3 Write path

`updateTransaction` (dataAdapter.js ~L348) allowlist gains one line:
`if ('user_type' in fields) allowed.user_type = fields.user_type;`.
Invalidation (`invalidateEnvelopeSpending`) and the `patchAllTxLists`
optimistic patch ride the existing machinery. **No writer changes**:
`api/sync.js` (~L550 payload), `csvImport.js` `INSERT_KEYS` (~L426), and
`buildManualTxRow` (~L1509) are explicit-column payloads that omit it —
overrides survive re-pulls exactly like `user_category`.

### 3.4 Migration

`supabase/migrations/20260815000001_transaction_user_type.sql`:

```sql
-- The 4-type override (Mason, 2026-08-15 — YNAB-style redesign).
-- transactions.user_type: nullable, USER-OWNED. null = automatic (the
-- structural linked-boundary derivation). Non-null routes THROUGH the shared
-- model — isSpend / cashIncome read it and markInternalTransfers drops
-- overridden rows from its candidate pool — never a second predicate.
-- User-owned like user_category / entity_id: api/sync.js, CSV/PDF import and
-- manual quick-add never write it, so it survives re-pulls.
-- Additive, so the normal order: safe to paste BEFORE the merge (old code
-- ignores new columns). Replays clean on a fresh empty DB (drop-if-exists
-- guard on the named constraint keeps it idempotent).

alter table transactions add column if not exists user_type text;

alter table transactions drop constraint if exists transactions_user_type_check;
alter table transactions add constraint transactions_user_type_check
  check (user_type is null
         or user_type in ('spending','inflow','transfer','card_payment'));

comment on column transactions.user_type is
  'User 4-type override (spending|inflow|transfer|card_payment); null = derive structurally. Written only by updateTransaction; every feed writer omits it.';
```

Same PR: append a boolean to `supabase/bootstrap_household.sql`'s
verification SELECT (the `information_schema.columns` shape already used for
`legacy_categories_saved`):

```sql
  -- 20260815000001 — the 4-type transaction override.
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'transactions'
            and column_name = 'user_type')            as transactions_user_type,
```

Also: append the filename to `docs/SETUP.md` Path B's post-snapshot migration
list, and repoint CLAUDE.md's frozen "five post-snapshot migrations" counts at
that list (the "record grep commands, never counts" rule applied to itself).
`setup_all.sql` is a tombstone — do NOT touch it.

**Sequencing (the ONE Mason-in-the-loop step):** this is a migration-sequenced
PR, so per CLAUDE.md workflow rule 3 it goes past Mason: open the PR with the
SQL + the bootstrap verification SELECT prominently in the body, ask Mason to
paste the SQL in the Supabase SQL Editor and confirm the SELECT's booleans
(never trust "Success. No rows returned"), and only THEN arm auto-merge.
Paste-before-merge is REQUIRED; paste-before-push is preferred (previews share
the prod DB — pre-paste, the client degrades cleanly and only the preview's
Ask tab fails loudly).

### 3.5 Orthogonality

`user_type` never writes or reads `user_category`; `taxReport.js` (its own
cash lens over `excluded`/`is_capital`) is untouched BY DESIGN — entities are
a lens, and a type override must not move money on a preparer's worksheet.
When the effective type is Transfer/Card Payment the list row hides the
category chip (display only); the stored category is untouched.

---

## 4. The PRs

### PR A — `claude/feature-ynab-tokens` — navy palette + shared primitives

**Goal:** the visual system, no behavior change. Light palette byte-identical.

**`src/ui.css`** — replace the `--dark-*` sources (ratios below are measured
with the real paletteContrast module; keep them as the in-file comments):

```
--dark-bg: #12141F;          /* near-black navy */
--dark-card: #1C1F2E;        /* text 14.21:1, muted 6.52:1 on it */
--dark-text: #F0EFEB;        (unchanged)
--dark-muted: #9FA3B5;       /* grey-lavender, 6.52:1 on --card */
--dark-border: #2B2F42;
--dark-accent: #A79FF0;      /* unchanged value; 7.73:1 on the new --bg */
--dark-accent-text: #12141F; /* = new --dark-bg */
--dark-input-bg: #232738;
--dark-track: #6E7188;       /* 3.41:1 on --card — a data mark */
--dark-danger*/--dark-warn*/--dark-shadow/--dark-overlay: unchanged
```

Shared classes: `.card` radius 14→16px, padding →20px; `.modal` radius
16→20px; `.ibtn`/`.nbtn` radius →10px, `.nbtn` 32→36px; add `.bnav` /
`.bnav-item` / `.bnav-item.active` (floating bar: `position:fixed;
bottom:calc(10px + env(safe-area-inset-bottom)); left:50%;
transform:translateX(-50%); width:min(688px, calc(100vw - 24px));
background:var(--card); border:1px solid var(--border); border-radius:24px;
box-shadow:0 4px 16px var(--shadow); z-index:50; display:flex;` — items: icon
over 11px label; active = `background:var(--bg)` pill + `color:var(--accent)`,
token-only) and `.sheet-full` (`width:100%; height:100dvh;
max-height:100dvh; border-radius:0; overflow-y:auto; padding:0;`) for PR E.
`.tab` styles STAY this PR (still used) — deleted in PR B. Never set a token
as an inline style; tokens only in ui.css.

**`index.html`:** dark theme-color meta → `#12141F`; the two dark
`background:` lines (~L46, ~L49) → `#12141F`. Light lines untouched. **The
inline `<script>` is NOT touched — the CSP hash must not change.** Keep the
metas' attribute order (`content` before `media` — the lockstep test pins it).

**`public/manifest.webmanifest`:** leave both colors (the `theme_color`
`#1D9E75` inconsistency is pre-existing, untested — out of scope, noted in
§6).

**Tests that break + honest fix:**
- `test/lockstep.test.js` tests 1–2 — fixed by the index.html edits (they
  fire if you forget).
- `test/paletteContrast.test.js`: `DARK_SURFACES` (L40) →
  `['#12141F', '#1C1F2E', '#232738', '#6E7188']`; the L210–212 fixtures swap
  `#222224` → `#1C1F2E` — verified: `readableInk('#1d9e75','#1C1F2E')`
  returns `#1D9E75` byte-identical (4.83:1), so the assertions keep their
  exact shape; update the ratio comment. Leave the `#FFFFFF`/`#18181A`
  extremes (see §0.8).
- `test/securityHeaders.test.js` must stay green UNTOUCHED — if it goes red,
  you touched the inline script; revert.

**CLAUDE.md:** grep for `#18181A`/`#222224` (should be absent — token names
only); update the ui.css key row to name `.bnav`/`.sheet-full` when they land.

**Screenshots:** Login, Overview, Transactions, Budget — light + dark, 390px.

**Risks:** contrast regressions on ad-hoc literals — mitigated because every
colored mark already routes through `chipOn`/`markOn`/`inkOn` against
runtime-read surfaces.

### PR B — `claude/feature-bottom-nav` — 5-item nav + IA + smoke harness

**Goal:** replace the 10-tab strip; Reflect hub shell; Accounts/Debt segment;
smoke harness rewritten in the SAME PR.

**`src/nav.js` (new) + `test/nav.test.js`** — §2.

**`src/components/Dashboard.jsx`:**
- Delete the tab-strip JSX (~L3745–3758). Add `<BottomNav>` (module-private
  component above Dashboard): maps `NAV_ITEMS`,
  `active = navForTab(tab)`, `onClick={()=>go(item.tab)}`; buttons carry
  `className="bnav-item"` + `data-mm-nav={item.id}` + `aria-current`; the
  Spending item renders a badge pill (`chipOn(OVER_MONEY, surf.card)`) with
  the viewed month's Uncategorized row count when > 0.
- `go(t)` helper with the verbatim side effects (§2). `jumpToTax` unchanged
  (lands on `tax`; nav highlights Reflect).
- New `{tab==="reflect"&&(…)}` body: five link cards (plain `.card` +
  `data-mm-report={id}` + chevron) → `go(REFLECT_TABS[i])`. Minimal here;
  PR F fills the hub.
- Reflect children get the `‹ Reflect` back button; the Accounts screen gets
  the `[Accounts | Debt]` segment chips rendering `data-mm-seg="debt"`.
- Move the 3-tile summary grid inside the overview body — **keep the array
  literal byte-identical** (labels, order, `fmt(cmpBase)`, `by this day`, no
  `fmt(lastSpent)`); its source pin is position-independent.
- Content column gets `paddingBottom:96` so the fixed bar never covers the
  last row.
- Do NOT reorder `reloadData`/`fetchData`/`handleUnlink`/`saveManualBalance`/
  `addManualDebt` or touch pinned effect dep arrays (`invalidationMatrix`,
  `apiErrorSanitize`, `accountBalance`, `unlink` source pins).

**`src/ui.css`:** delete `.tab`/`.tab.active`/`.tab:hover` rules.

**`test/smoke/render.mjs` rewrite (same PR):**
`waitForSelector('[data-mm-nav]')`; walk = click `[data-mm-nav=home]`,
`plan`, `spending`, `accounts`, then `[data-mm-seg=debt]`, then
`[data-mm-nav=reflect]`, then each `[data-mm-report=…]` for
categories/trends/recurring/tax/ask (returning via `[data-mm-nav=reflect]`
between reports; re-query every step — the stale-handle rule). 11 screens;
per-screen boundary check + fatal `pageerror` unchanged; final gates become
`visited.length >= 11` and nav count === 5. Keep the 600ms settle.

**Tests that break + honest fix:** the smoke render (rewritten above).
`test/smokeMocks.test.js` unchanged (`nav.js` is a pure module imported
directly, like `spending.js`).

**CLAUDE.md (same PR):** Conventions "tab bar scrolls horizontally" → bottom
5-item nav (`src/nav.js`), fixed; Dashboard key row's tab list → the
5-nav/11-view mapping; ui.css key row `.tab` → `.bnav`/`.sheet-full`;
"clicks ALL TEN tabs" phrasings → "walks all 11 views".

**Screenshots:** all five nav destinations + debt segment + one reflect
child, light + dark.

**Risks:** TDZ-class crashes from moved JSX (run the smoke harness locally
before pushing: vite dev server + `node test/smoke/render.mjs`); fixed-bar
overlap with overlays (overlays are z-index 100 > nav 50 — verify visually).

### PR D — `claude/feature-tx-user-type` — migration + model + adapter (NO UI)

**Goal:** everything in §3, invisible on screen. Follow §3.4's sequencing —
this is the migration-sequenced PR; do not arm auto-merge until Mason
confirms the paste.

**Files:** the migration + `supabase/bootstrap_household.sql` +
`docs/SETUP.md` (§3.4); `src/spending.js` (isSpend, export isCardPaymentRow,
deriveTxType/effectiveTxType, toTxShape ×3 fields, patchTxShape);
`src/cashFlow.js` (two gates); `src/txType.js` (new); `src/dataAdapter.js`
(§3.2, §3.3); `api/_lib/spendingContext.js` (two selects + comment);
`test/helpers/ledger.js` (`makeTx` row literal gains `user_type: null`;
overrides already pass through); `test/smoke/mocks/dataAdapter.js` (mock rows
gain `user_type: null`; no new exports — `smokeMocks` stays green).

**Tests that break + honest fix:**
- `test/cashFlow.test.js`: the brute-force `eligible()` gains
  `&& !t.user_type` IN THE SAME COMMIT as the pool gate (parity stays
  authoritative). Add: an override drops a leg from the pool and the partner
  re-derives; a `user_type:'transfer'` row lands in neither total; a
  forced-`inflow` paycheck counts after un-pairing.
- `test/spending.test.js`: add scenarios — `'spending'` override on a
  card-payment-worded row counts; `'card_payment'` override removes a row;
  sign-incompatible override is inert; conservation (toggling an override
  moves exactly that row's amount).
- `test/recurringColumns.test.js`: `user_type` arrives via
  `SPEND_TX_COLUMNS`; add it to the allow-list with the comment
  `// isSpend override — counted input`.
- `test/spendingContext.test.js`: add a fixture row with `user_type` set;
  assert the totals move and the not-counted marker follows;
  byte-determinism/no-mutation tests stay green untouched.
- `test/manualTx.test.js`: pin that `buildManualTxRow` never emits
  `user_type`.

**New tests:** `test/txType.test.js` — derivation matrix (four structural
cases + loan + Return-displays-Inflow + the paired-card-payment refinement),
`allowedUserTypes` sign gating, loan-ignores-override, and the **agreement
property test**: over `randomLedger` (test/helpers/ledger.js) with overrides
sprinkled deterministically by index, after pairing every row satisfies
`tx_type==='spending' ⟺ isSpend(t)`; `'inflow'` ∧ depository ⟺ counted by
`cashIncome`; `'transfer'|'card_payment'` ⇒ in neither total. This test IS
the "every surface agrees by construction" guarantee. Plus a source-scan test
(the sync-omit precedent): `api/sync.js`'s txRows literal and `csvImport.js`'s
`INSERT_KEYS` contain no `user_type`.

**CLAUDE.md (same PR):** new `src/txType.js` key row; extend the
linked-boundary Convention with the override paragraph (§3 semantics: pool
removal, direct predicate reads, sign-guard precedence, loan-ignores,
excluded-wins, inflow-on-credit ≡ Return); extend the sync-omit Convention's
column list with `user_type`; add "effective type = `user_type ??`
structural" beside the effective-category rule; fix the "five migrations"
counts (§3.4).

**Screenshots:** none (no UI) — say so in the PR body.

**Risks:** the SQL paste sequencing (§3.4 — the client degrade keeps the app
functional either way; the assistant fails loudly, which is the designed
tell); a missed select forking a surface (the agreement property test + the
`fetchRawBetween` chokepoint make this structural).

### PR C — `claude/feature-spending-list` — Spending screen redesign

**Goal:** day-grouped list, YNAB row anatomy, Review banner, header `+`.

**Dashboard.jsx (Transactions tab body only):**
- New pure module **`src/txList.js`**: `groupByDay(rows)` (order-preserving
  fold on `transaction_date` → `[{date, rows}]`) and `longDate(iso)`
  ("August 14, 2026" — sliced from the ISO string, never `new Date()`, the
  recorded off-by-one hazard). Test `test/txList.test.js` (grouping
  stability, label correctness, garbage-date passthrough). Do NOT use
  `localShortDate` — `test/accountBalance.test.js` pins exactly 2 call sites.
- Review banner card above the list:
  `uncatCount = listTxs.filter(t=>t.category===UNCATEGORIZED).length`;
  renders the count in a pill + accent **Review** button →
  `setTxCatFilter(UNCATEGORIZED)` (toggle-off when active). Renders only when
  count > 0 and no search is active.
- Tab header row: page title "Spending" (30/600) + icon buttons: search
  (focuses the existing input), `+` (`setQuickAdd(true)`) — remove the old
  `+ Add transaction` ibtn; gating inside the sheet unchanged.
- List: `groupByDay(listTxs)` → section header (11px/600 uppercase muted
  `longDate`) + rows. Row anatomy: line 1 = payee (14/600, ellipsis) |
  amount right; line 2 = category chip (emoji + name via
  `chipOn(getColor(cat), surf.card)`) — rows with
  `t.tx_type==='transfer'|'card_payment'` show a `Pill` labeled
  Transfer/Card payment instead of the category chip — + entity pill +
  Excluded pill | account name right (10px muted, `acctLabel`).
- Row-level amount formatter (Dashboard-local): stored positive (out) →
  `"−$"+…` in `--text`; stored negative (in) → `"+$"+…` in
  `inkOn(OK_MONEY, surf.card)`. Aggregates elsewhere keep `fmt`/`fmtX`
  positive magnitudes — do not touch tiles or category totals.
- Keep verbatim: `onClick={()=>setSelTx(t)}`, `opacity:.5` for excluded,
  stagger delays, skeletons, empty states, the category/account chips rows +
  their pinned rules, search + filters row, load-more.

**Tests that break:** none expected (no pinned source in this region). New:
`test/txList.test.js`.

**CLAUDE.md:** Dashboard key row — day-grouped list + the row-level signed
display rule ("row amounts show −/+ at ROW level only; aggregates stay
positive magnitudes — `sumSpending` unchanged").

**Screenshots:** Spending with banner, Review-filtered state, a transfer row,
an inflow row — light + dark.

**Risks:** sign-flip confusion (outflows gain a visible "−" they never had) —
deliberate, YNAB-matching, recorded in CLAUDE.md.

### PR E — `claude/feature-tx-sheet` — detail sheet + 4-type selector

**Goal:** full-screen tap-to-edit sheet per §1; every existing capability
preserved. Retraining is the live task — the teach flow is MOVED, never
rewritten.

**Dashboard.jsx (the `selTx` IIFE, ~L6076–6392):**
- Shell: `.overlay` unchanged (`selTx` already in
  `anySheetOpen`/`closeAllSheets`; capture-phase Escape + sheetHistory
  untouched) → inner container swaps `.modal` for `.sheet-full`, keeps
  `role="dialog" aria-modal="true"`, adds `aria-label="Transaction details"`.
- Header (~30%): `background:linear-gradient(180deg, var(--input-bg),
  var(--card))` (token-only); `×` close (`.nbtn`, top-left →
  `setSelTx(null)`); centered amount 42px DM Mono 500 using the PR-C row
  formatter; beneath it the **type pill**: `TX_TYPE_LABELS[selTx.tx_type]` +
  chevron; loan rows render a static muted "Loan account" label and NO menu.
- Type menu: local `useState` inside the sheet render (not a new overlay —
  Escape peels the whole sheet; document that). Four rows from `TX_TYPES`
  with labels, checkmark on `selTx.tx_type`; disabled entries =
  `TX_TYPES − allowedUserTypes(selTx)` with a muted reason ("money-in rows
  can't be Spending" / inverse). Select →
  `saveTx({user_type: v===selTx.auto_tx_type ? null : v})` (the
  null-equals-automatic precedent) → close menu. When `selTx.user_type` is
  non-null, a "Reset to automatic ({label of auto_tx_type})" row appears →
  `saveTx({user_type:null})`.
- Grouped card 1 (rows with leading icon + trailing chevron): **Payee**
  (EditName + "reset name", kept), **Category** (row shows the current chip;
  tapping expands the existing picker + `＋ New category` + reset + the FULL
  teach panel — all existing handlers verbatim, including `offerToLearn`,
  token-trim, scope buttons, `previewSeq` guard), **Account** (display-only:
  badge + `acctLabel`), **Date** (display-only — date editing does not exist
  today and is NOT added; deferred).
- Grouped card 2: **Photo** → `<ReceiptSection key={selTx.id} …/>`
  (unchanged).
- **"Show more" expander** (local state): raw bank text line,
  rental-property block, capital-expense fields (blur-commit + year floor
  verbatim), the excluded toggle + caption.
- Footer: full-width rounded-full accent **Done** button (`setSelTx(null)`).
- `saveTx`/`patchAllTxLists` untouched; `patchTxShape` (PR D) already
  recomputes `tx_type`.

**Tests that break:** none pinned in this region. Manual pass before pushing:
teach → trim → Always → learnedNote, and one full overlay stack
(CategorySheet → tx sheet → Escape ×2).

**CLAUDE.md:** Dashboard key row — sheet is full-screen (`.sheet-full`),
4-type selector pointer to the linked-boundary Convention; the
null-equals-automatic write shape.

**Screenshots:** sheet on a spending row, open type menu, a disabled option,
a transfer row, Show-more expanded, teach panel — light + dark.

### PR F — `claude/feature-reskin-final` — remaining re-skins + cleanup

**Goal:** finish the re-skin; migrate durable rules; delete this spec doc.

- **Header (all screens):** page title `pageTitle(tab)` 30/600; month pill
  "‹ August 2026 ›" under it on month-scoped screens (same
  `prevMonth`/`nextMonth`/`setMonthPicker` handlers + keyboard affordances);
  theme/refresh/sign-out become round icon buttons top-right (labels →
  `aria-label`/`title`). Eyebrow removed. Error/feed-health/all-hidden
  banners keep their exact shapes and tokens.
- **Accounts:** grouped sections **Cash** (depository + manual non-loan),
  **Credit**, **Loans** — collapsible header (chevron + right-aligned section
  total = Σ `displayBalance(a.current_balance, a.type)` via `fmtX`; positive
  totals green via `inkOn(OK_MONEY, surf.card)`, negatives plain with the
  minus) over one `.card` per section with inset dividers; hidden accounts in
  a collapsed **Hidden** section (opacity .5 + pill, as today). Rows keep
  `Swatch` (radius 50% badge look), `EditName`, badges, sub-line, balance +
  as-of line — **both `localShortDate(asOf.date)` sites survive verbatim**
  (exactly-2× pin). Restore strip, feed-reach + data-coverage panels, account
  detail sheet: restyle containers only; do not touch the `restorable` memo,
  its dep array, `handleUnlink`/`handleRestoreImported`, or
  `saveManualBalance`/`addManualDebt` order.
- **Home:** 3-tile grid (source-pinned literal intact) restyled; donut card;
  recent list adopts the PR-C row anatomy; expected-bills line kept.
- **Plan (Budget):** container/typography restyle only — RTA panel, envelope
  rows, bars, Auto-fill, Fund targets; the `New category</button>` literal
  PRESERVED (userOwnedCategories pin); no logic changes.
- **Reflect hub (fills PR B's shell):** card 1 **Spending Breakdown** —
  accent title + chevron (→ `go('categories')`), muted month label,
  `fmt(totalSpent)` 38px DM Mono, horizontal stacked bar + top-list from new
  pure **`src/reflect.js`**: `breakdownSegments(groups, {max:6})` → top
  segments + "All Others" (colors via `markOn(getColor(label), surf.card)`;
  renders from already-loaded `cats`). Card 2 **Income vs. Spending** —
  insight sentence from pure `incomeVsSpendingInsight(months)` (avg income vs
  avg spending, ±10% band → "less than / about as much as / more than you
  make") over the trends cash-flow data; extend the trends lazy-load gate to
  `tab==="trends"||tab==="reflect"` — mind the `trendsSeq` Gotcha (no loading
  gate; `invalidateTrends` bumps the seq itself). Cards 3–5:
  Recurring / Tax / Ask link cards. Test `test/reflect.test.js` (segment math
  conserves the total, All-Others bucketing, insight banding incl.
  zero-income).
- **Categories/Trends/Recurring/Tax/Ask:** container restyle only.
  Must-survive source pins: `{c.label===UNCATEGORIZED&&(` exactly once with
  `Everything starts here` nearby; the teach-queue card-level gate
  `{!loading&&(teachQueue.spending.length>0||teachQueue.other.length>0)&&(`;
  the `catsPresent` derivation verbatim; `rep.unmapped.map` present /
  `rep.unmapped.filter` absent; the debt `Math.min(99,…)` expression; no
  `pickingCat`/`unbudgetedCats`/"auto-detected if left blank" strings.
- **Spec-doc deletion:** delete `docs/ynab-redesign-plan-2026-08-15.md`;
  `grep -r "ynab-redesign-plan" .` must return only this deletion; annotate
  any overlapping items in `docs/next-iteration-plan-2026-08-04.md`
  (adjacent "YNAB muscle-memory" items are distinct — annotate, don't
  delete).
- **CLAUDE.md durable migration (same PR):** Dashboard key row rewritten for
  the final IA; `nav.js`/`txType.js`/`reflect.js`/`txList.js` key rows;
  Conventions: bottom-nav rule, row-level signed-amount rule, 4-type override
  rules (whatever PR D didn't land), grouped-accounts note; a 1–3 line
  Merged-features entry; grep the PR body's retired-vocabulary list: "tab bar
  scrolls horizontally", "ten tabs", "`.tab`".

**Screenshots:** all five destinations + accounts sections + reflect hub +
debt segment, light + dark.

---

## 5. Risk register

| # | Risk | Mitigation |
|---|---|---|
| 1 | A read path missing `user_type` silently forks a surface | All month/range reads funnel through `fetchRawBetween`; the two spendingContext selects are enumerated; the agreement property test turns divergence into a red test |
| 2 | Migration not pasted before merge | Additive order + the client 42703 degrade keeps the app functional; Budget tab protected from the `isEnvelopeSchemaMissing` misread; verify via the bootstrap SELECT, never "Success" |
| 3 | Dashboard restructure TDZ/hook-order crash shipping green past tests+build | The rewritten smoke harness walks all 11 views on every PR; run it locally before pushing |
| 4 | Breaking a source-pinned test while re-skinning | Each PR carries its must-survive list; style-only changes never rename/reorder pinned declarations |
| 5 | Dark re-theme drifting from index.html / paletteContrast fixtures | Lockstep tests fire on drift; light palette frozen; all new hexes pre-verified with measured ratios; CSP hash untouched |
| 6 | Sign-incompatible override corrupting totals | Sign guards outrank the override; UI disables incompatible options; conservation tests pin it |
| 7 | Optimistic-patch staleness (type edit not appearing in search/account lists) | `patchTxShape` recomputes `tx_type` from `auto_tx_type` (the `auto_category` pattern); `counted` keeps its documented caveat with `reloadData` healing the month list |
| 8 | Teach-flow regression in the sheet redesign | PR E moves JSX, never rewrites handlers; manual teach-flow pass before pushing |
| 9 | Fixed bottom nav vs overlays/safe-area/keyboard | Nav z-index 50 < overlay 100; `env(safe-area-inset-bottom)`; content bottom padding; screenshot an open sheet over the nav |
| 10 | Brute-force parity divergence in cashFlow tests | `eligible()` gains `!t.user_type` in the same commit as the pool gate |

---

## 6. Deliberately deferred (do not build; record in CLAUDE.md at PR F)

Approved/reviewed column + "Approve" semantics; "Show N uncleared" pending
banner; two-line transfer payee (needs a pair link the model doesn't store);
date editing in the sheet; a memo field (`user_description` IS the rename);
heavier font weights (variable font caps at 600); the manifest `theme_color`
inconsistency. Refuted things NOT reintroduced anywhere above: global FAB,
cross-month category browse, seed categories/keyword guessing, a second
spending predicate, per-transaction settings-row storage.
