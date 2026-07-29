# my-money — project memory

Household spending dashboard for two users (Mason + wife), shared login,
laptop + iPhone PWA. Personal project; pragmatic > enterprise.

**Maintain this file** in the same PR as any change that settles an
architecture decision, changes the workflow, merges a branch, or adds a gotcha.
Keep Pending/Roadmap current. Deep history lives in git log, GitHub PRs, and the
Vercel dashboard — don't duplicate it here; keep this file lean and
load-bearing. Build specs in Roadmap collapse to a one-line "Merged features"
entry once shipped.

## Architecture (decided, don't relitigate)

- **Cloud-first**: Supabase Postgres is the single source of truth. No local
  cache / IndexedDB (Dexie was removed — don't reintroduce).
- **React + Vite SPA** on **Vercel**; secrets live in serverless `api/`
  functions. Client reads/writes Supabase directly (RLS-scoped) and calls `api/`
  only for service-secret work (the SimpleFIN access URL, the assistant key).
- **ONE bank feed: SimpleFIN**, plus CSV/PDF statement import as the permanent
  coverage floor for anything it can't reach. **Plaid is gone** (phase 4) —
  don't reintroduce it; ~$15/yr flat beat its per-Item billing, which was the
  whole point of the migration.
  - Two dead ends left their names behind, and both are load-bearing today:
    a scraper that was designed then abandoned (`synthetic_id`, renamed
    `plaid_tx_id`), and Plaid itself. **`transactions.plaid_tx_id` and
    `accounts.plaid_account_id` are ADAPTER-AGNOSTIC external ids** carrying
    every feed's id space — `sfin:`, `csv:` (both CSV *and* PDF), `manual:` —
    and both upsert conflict targets. Never rename or drop them; the name is
    ugly, the column is critical. `test/noPlaid.test.js` asserts the cleanup
    guard doesn't start flagging them.
  - Feed discriminator: `institutions.simplefin_org_id is not null` ⇒
    SimpleFIN-fed; null ⇒ the manual "Imported" institution.
  - **New SimpleFIN accounts arrive `hidden: true`.** The original reason (a
    bank on both feeds would double-count) is gone, but the rule stays for the
    surviving one: the account's TYPE is *guessed* from its name, and unhiding
    is the deliberate act that confirms the guess. A card mistyped as checking
    turns every purchase into household spending.
- **Auth**: one shared Supabase Auth user for the household.
  `household_members` maps user → household; `current_household_id()` + RLS
  policies scope every table. `api/` routes verify the JWT via `requireUser()`
  (`api/_lib/supabase.js`).
- **RLS shape**: `accounts` / `transactions` / `institutions` each have a single
  `for all to authenticated using (…) with check (household_id =
  current_household_id())` policy — INSERT is gated by the WITH CHECK, satisfied
  because `household_id` defaults to `current_household_id()`, so the **client
  can INSERT/update/delete its own rows directly**. `simplefin_access` has ZERO
  client policies — only service_role (api/) reads it. Never expose it: the
  access URL embeds the household's bank credentials.
- **Sync is server-side** (`api/sync.js`), ONE pass, upserting accounts
  (onConflict `institution_id,plaid_account_id`) and transactions (onConflict
  `account_id,plaid_tx_id`), limited to `depository`+`credit`+`loan`
  (`ALLOWED_TYPES`); loans carry sparse/no transactions — their debt data is
  hand-entered (see Roadmap).
  - **SimpleFIN pass**: per *access URL*, not per institution — one URL covers
    every bank, fetched in a single GET with no cursor and no pagination. Fans
    out into institutions (one per SimpleFIN org), accounts and transactions.
    Incremental via a `last_pulled_at` watermark minus a 30-day overlap, and
    every request is clamped to **~88 days** (`MAX_LOOKBACK_DAYS`) because
    SimpleFIN serves at most 90 per call. `FIRST_PULL_DAYS` (730) stays the reach
    we WANT — the difference is reported as a `coverage_shortfall`, not quietly
    redefined, because the constant is the only record that older history was
    never fetched.
    `last_pulled_at` (data watermark, advanced when **no REAL error** came back —
    a date-range advisory is NOT an error, see the gotcha; so is a *capped*
    range, since stalling recovers nothing) and `last_attempt_at` (throttle,
    stamped **before** the request so a timeout still counts) are deliberately
    two columns — one column would force a choice between skipping transactions
    after a failure and re-hitting the Bridge on every dashboard load while a
    connection is broken. One pull an hour (SimpleFIN refreshes ~daily).

## Key files

| File | Role |
|---|---|
| `src/ui.css` | The ONLY place theme-token values live: `:root` light + a `prefers-color-scheme: dark` block (--bg/--card/--text/--muted/--border/--accent/--accent-text/--danger*/--warn*/--input-bg/--track/--shadow/--overlay), plus the font `@import` (must stay line 1), the `*` reset, keyframes, and the shared `.card`/`.tab`/`.ibtn` classes. Global so the pre-Dashboard screens get them. |
| `src/theme.js` | Theme selection + application: localStorage pref (`mm:theme`), `resolveTheme`, `applyTheme` (sets `<html data-theme>` + syncs the `theme-color` metas), `subscribeTheme`/`subscribeSystemTheme`, `readToken` (runtime token read), `initTheme` (called from main.jsx), and the `useTheme` hook the header toggle uses. |
| `src/paletteContrast.js` | Pure, zero imports: WCAG math + `readableInk`/`markColor`/`chipStyle`, which hold hue fixed and bisect lightness to guarantee 4.5:1 / 3:1 against a given surface. Never throws (runs during render). Covered by `test/paletteContrast.test.js`. |
| `src/components/Dashboard.jsx` | Almost the entire UI — single file, inline styles, tabs: overview/categories/**budget**/transactions/accounts/trends/recurring/ask. Shared mini-components: `Pill`, `Swatch`, `EditName`, `Sk` (skeleton), `Donut`, `DrillNum` (the tap-a-number affordance) ; envelope editors `AssignEdit`/`BudgetEdit`/`IncomeEdit` + the `TargetSheet`/`MoveSheet`/`CategorySheet` modals. |
| `src/dataAdapter.js` | All Supabase reads + shapes consumed by Dashboard. Keep return shapes stable. Also holds the CSV/PDF-import writes (`findOrCreateManualInstitution`, `createManualAccount`, `getExistingTxIds`, `importCsvTransactions`, `isManualAccount`), the comparison-mode read `getAccountTransactionsInRange`, the backfill boundary `getFeedCoverageStart`, the learned-rule CRUD (`getCategoryRules`/`setCategoryRule`/`applyCategoryRuleToHistory`/`deleteCategoryRule`), the SimpleFIN predicates (`isSimpleFinAccount`, `ACCOUNT_TYPES`/`ACCOUNT_SUBTYPES`), the envelope I/O (`getEnvelopes`, `setAssigned`, `setCategoryRollover`, `setTargetKind`, `fundTargets`, `moveMoney`, `getBudgetIncome`/`setBudgetIncome`), and re-exports the pure helpers from `cashFlow.js` and `envelopes.js` so existing importers/harnesses keep working. |
| `src/cashFlow.js` | The Trends cash-flow model (see Conventions), extracted pure: `markInternalTransfers` + `maxMatchTransfers` (Kuhn's), `cashIncome`/`cashSpending`, account-type predicates. Zero imports — plain-Node importable; covered by `test/cashFlow.test.js` incl. the brute-force matching parity check. |
| `src/envelopes.js` | The envelope-budgeting model (see Roadmap), pure: `walkEnvelopes` (`available = assigned + carry − spent`), `targetNeed`, `readyToAssign`, `planMove`, month-key helpers. Zero imports — dataAdapter does the I/O and hands it plain arrays. Covered by `test/envelopes.test.js`. |
| `src/categoryMap.js` | `ERA_CATEGORIES` (the taxonomy source of truth) + `applyAccountRules` (credit-card negatives → "Return", excluded from income); `UNCATEGORIZED`/`FALLBACK_CATEGORY` + `isBudgetableCategory`; pure JS, imported by server code too. No "Housing"/"Income" member; `Uncategorized` IS one. `mapPlaidCategory` was deleted with Plaid — nothing produces those codes now, and it was never called at read time, so historical rows are unaffected. |
| `src/csvImport.js` | Pure CSV-import core (no React/Supabase): `parseCsv`, `detectHeader`, `parseMoney`/`parseDate`, transfer flagging, dedup `plaid_tx_id` hashing, `buildRows`/`analyzeCsv` (both take `rules` + `overlapFrom`). Re-exports `guessCategory`/`transferRawCategory`/`invalidRuleCategories` from `txClassify.js`, which now owns the rule table. Plus `importPlan` (which sections the modal shows, derived from the file's dates vs the feed boundary) and the audit core: `reconcileCsv` (max-matching), `descSimilarity`, `csvDateRange`. Testable in isolation. |
| `src/txClassify.js` | Learned-rule matching (`merchantKey`, `matchLearnedRule`) + the shared descriptor→category rule table + internal-transfer tagging (`guessCategory`, `transferRawCategory`, `classifyDescription`), validated against `ERA_CATEGORIES` at load. Lifted out of `csvImport.js` when SimpleFIN became a second caller: both feeds get a descriptor and no category, so both derive `mapped_category` at WRITE time from this one table. Pure JS — imported by server code too. |
| `src/accountBalance.js` | `isDebtAccount` / `displayBalance` — the stored-positive → displayed-negative rule for credit and loan balances. Pure JS; imported by both Dashboard.jsx and the server-side assistant context. |
| `api/_lib/simplefin.js` | SimpleFIN protocol layer: setup-token decode, claim POST, access-URL split (creds → Authorization header), the `/accounts` GET, and `normalizeAccountSet` (reads BOTH wire shapes, and splits feed messages into errors / advisories / capped). Also the **feed-message classifier** (`classifyFeedMessage`, allowlist polarity) and the lookback clamp (`clampStartDate`/`MAX_LOOKBACK_DAYS`) — both pure, covered by `test/simplefin.test.js`. Also `inferAccountType`, `normalizeBalance`, the sign flip, and the env knobs. Server-only — handles bank credentials. |
| `src/components/SimpleFinConnect.jsx` | The connect modal, reachable from the Accounts tab, the EmptyState and the FAB: link banks at SimpleFIN Bridge → paste the setup token → claim + first sync. Shows connection status, a disconnect action, and Restore for removed banks. |
| `src/components/CsvImport.jsx` | Import modal for **CSV *and* PDF**. **TWO sections, chosen by the FILE'S DATE RANGE against the feed's coverage** — not by the target account, which can no longer tell backfill from audit now that every account is manual or SimpleFIN-fed. Rows before the boundary import; rows on/after it are compared and never inserted; a straddling file does both on its respective slices. One override, "Compare only", which can only move toward not-inserting. A never-synced fed account must sync first (the first pull reaches back ~88 days — SimpleFIN's cap). |
| `src/pdfImport.js` | Pure PDF-statement parsing core (no pdf.js/React/Supabase): text runs → lines → columns → **the same cell grid `buildRows` consumes**. Template auto-detect (`autoDetectTemplate`), `applyTemplate`, month-name dates + year inference from the statement period, `normalizeDebitCredit`, `defaultTemplate` (the fallback the modal seeds the editor with). Testable in Node. |
| `src/pdfExtract.js` | The only file that touches pdf.js. Lazy `import()` (keeps ~1.8MB out of the main bundle) of the **legacy** build, bundled locally (no CDN, CSP/offline-safe). Runs the parser on the **main thread** via `globalThis.pdfjsWorker` so `src/pdfPolyfills.js` is in scope for it (a Worker has its own globals). |
| `src/pdfPolyfills.js` | Feature-detected polyfills pdf.js needs on iOS Safari — **`ReadableStream` async iteration** (the load-bearing one; see Gotchas), plus `.at` and `structuredClone` for genuinely old devices. |
| `src/components/PdfTemplateEditor.jsx` | Visual "teach it once" editor: renders the statement from its own text runs, draggable column boundaries, per-column role selectors, live parsed-row count. Saved per account as `pdftpl:<accountId>` in `settings`. |
| `src/apiClient.js` | Client → api/ fetch wrappers (JWT attached). Was `plaidClient.js`; renamed when nothing in it was Plaid-specific any more. |
| `src/components/AddAccount.jsx` | The "add a bank" button + the SimpleFinConnect modal it owns. Replaces `LinkAccount.jsx` (Plaid Link) in BOTH places that rendered it: the EmptyState CTA and App's floating action button. Talks to the server only when pressed — LinkAccount minted a link token on mount, so every app open hit the server before the user asked for anything. |
| `src/sync.js` | Single-flight wrapper triggering server sync. |
| `src/db.js` | getSetting/setSetting on the Supabase `settings` table (dashboard prefs: colors, names, custom categories, `asst:model`/`asst:effort`). |
| `src/assistantModels.js` | Shared client+server allowlist of assistant models + cost estimator. |
| `api/_lib/supabase.js` | Service-role client + `requireUser` (JWT → householdId). |
| `supabase/migrations/` | Ordered SQL migrations (additive-only on live data). |
| `supabase/setup_all.sql` | One-paste fresh install — **DESTRUCTIVE, wipes all tables. Never run on live data. Never re-generate to include new migrations without that warning.** Convenience snapshot only — `migrations/` is the source of truth; ends with a column-level self-check that raises if it drifts behind migrations. |
| `test/` | `npm test` — Node's built-in `node --test`, zero deps. Covers the pure cores only: cashFlow (incl. brute-force max-matching parity), csvImport parsing/dedup-id idempotency, category rules, txClassify (learned-rule matching: what collapses, what stays distinct, and the over-specific-key limit), envelopes (both walk regressions + by-date targets). Run before pushing. |

## Development workflow

1. `main` is the trunk and **Vercel's production branch** — pushes auto-deploy
   to production (`my-money-smoky.vercel.app`).
2. Features on `claude/feature-<name>` branches cut from main → Vercel Preview
   deploys (preview URLs need Mason's Vercel login; **previews share the PROD
   Supabase database** — schema-dependent branches need their migration landed
   first, and preview edits are real).
3. Mason reviews the preview → says "merge <feature>" → merge to main. Don't
   merge without that. Don't open PRs unless asked. Delete branches after merge
   (this sandbox can't delete remote branches — Mason clicks it in the UI;
   GitHub MCP tools may transiently disconnect — retry before treating as fatal).
4. **Migrations are additive-only** on live data (`alter table … add column`).
   Hand Mason the exact SQL to paste in the Supabase SQL Editor at merge time.
   **A migration that DROPS inverts the order**: additive SQL is safe to paste
   before the merge because old code ignores new columns, but a drop is only
   safe AFTER the new code is deployed and live — old code naming a dropped
   column 500s. `20260728000002_remove_plaid.sql` is the first of these and
   says so in its header. Confirm the deploy is actually serving the new build
   before pasting, and note that after pasting, Vercel's **Instant Rollback**
   button becomes a foot-gun rather than an escape hatch.

**Local checks** (gitignored; recreate as needed): SQL — local Postgres 16 stub
(create `auth` schema + `auth.users` + `auth.uid()` reading
`request.jwt.claims.sub`, the three roles, publication `supabase_realtime`; run
migrations in order, test triggers/RLS). UI — mock harness: a tiny Vite app
rendering `Dashboard.jsx` with `resolve.alias` **full-match** regexes
(`/^.*\/dataAdapter\.js$/`) swapping dataAdapter/sync/db/apiClient for mocks;
playwright-core screenshot (`executablePath:'/opt/pw-browsers/chromium'`,
390×844). Screenshot new UI before pushing. Tests (checked in, not gitignored):
`npm test` (node --test over `test/`). Build:
`VITE_SUPABASE_URL=https://placeholder.supabase.co VITE_SUPABASE_ANON_KEY=placeholder npm run build`.

## Conventions

- Dashboard style: compact inline-styled JSX, CSS vars, accent #7F77DD.
  Mobile-first: verify at 390px; tab bar scrolls horizontally.
- **Theme selection**: Auto/Light/Dark toggle in the header. The preference is
  `mm:theme` in **localStorage, NOT the `settings` table** — `settings` is
  household-shared under one login, so storing it there would flip the other
  person's phone; localStorage also reads synchronously, which is what lets
  index.html apply the theme pre-paint instead of flashing. **Device/visual
  prefs go in localStorage; account-level prefs go in `settings`.** No stored
  value ⇒ no `data-theme` ⇒ follow the OS. Every storage access is try/caught
  (Safari private mode throws on access). `src/theme.js` owns it; index.html
  carries a deliberate 3-line duplicate of read+apply that must stay in sync.
- **Theme tokens live ONLY in `src/ui.css`.** Never redeclare a token value in a
  component and never set one as an inline style — an inline custom property on
  a subtree root beats even `!important` on `:root` (that was the dark-mode bug).
  Use tokens, not literals, for anything themed. Two exceptions that must stay
  hardcoded and be changed in lockstep with `--bg`: index.html's `theme-color`
  metas and its pre-paint `html/body` background (parsed before CSS loads).
- `ACCOUNT_COLORS` / `DEFAULT_COLORS` (Dashboard.jsx) are **data, not theme** —
  user-overridable colors persisted in `settings`. Never tokenize them and
  **never change their stored hex values**. Same for the `#1D9E75`/`#D85A30`
  good/bad status pair and CsvImport/PdfTemplateEditor's bucket + role hues.
  What IS theme-dependent is how they **render**: `src/paletteContrast.js`
  holds hue fixed and moves lightness until the color clears 4.5:1 (text) or
  3:1 (marks) against the surface it actually sits on — which also covers the
  arbitrary colors the Swatch picker can produce, as a second fixed palette
  could not. Pass the surface read from the token at runtime (`readToken`), and
  re-read it on theme change or chips keep the old theme's contrast. Two things
  deliberately NOT corrected: the Swatch fill (it's the color picker — it must
  show the stored value truthfully) and the Donut's slice separation (the
  palette maps several categories to one hex, so adjacent slices can be a
  literal 1:1 — a `--card` stroke separates them instead).
- Amounts: **positive = money out, negative = money in** — the app's own
  convention, inherited from Plaid and kept because every stored row already
  uses it. SimpleFIN is the opposite (positive = money *in*) and its amounts arrive as numeric
  *strings* ("-05.50" is real), so `api/_lib/simplefin.js` parses then negates.
- **SimpleFIN sends no account type/subtype/mask/category.** Type is *inferred
  from the account name* at first insert and is **user-owned thereafter** — the
  sync writes it on INSERT only, and the Accounts tab lets it be corrected
  (that's why the account write splits into insert-new / update-balances). It
  matters because `isCheckingAccount` decides whether an account's outflows
  count as household spending. The editor covers MANUAL accounts too: their type
  is written once at creation and never again, so a mistyped import would
  otherwise be uncorrectable forever. (It used to be SimpleFIN-only because a
  Plaid sync rewrote both columns on every pull and an edit would silently
  revert — a reason that died with Plaid.) Crossing the debt boundary re-syncs
  only FED accounts; a manual balance was typed by hand and no pull restates it.
- **Debt balances: stored positive, displayed negative.** `accounts.current_balance`
  is POSITIVE = money owed for `credit`/`loan` (SimpleFIN reports negative and
  `normalizeBalance` flips it on the way in). Every place a balance is shown to a human runs it
  through `displayBalance(balance, type)` (`src/accountBalance.js`), which
  negates debts — a card reads −$5,127.97. Keeping storage positive is what
  keeps payoff amortization and utilization (`current_balance / credit_limit`)
  natural; only presentation flips.
  There are exactly four display sites — three in Dashboard.jsx (Overview
  headline, accounts list, account sheet) and the assistant context in
  `api/_lib/spendingContext.js`, which must match or the Ask tab contradicts the
  screen. `fmtX` renders negatives as −$1,234.56.
- Effective category = `user_category || mapped_category` (user override wins).
- **A custom category is a category, not a kind of category.** `dash:cats` is a
  NAME REGISTRY (so a category with no spending yet can still be offered in the
  pickers); its `color` is only the seed chosen at creation. **`dash:colors` is
  the one mutable colour store for every category, built-in or custom** — which
  is what lets `getColor` answer for both and keeps a custom category the same
  colour on the Categories tab, the Budget tab, the donut and every pill.
  (Before this, `getColor` knew nothing about `dash:cats`, so custom categories
  rendered #888780 grey everywhere except the separate block they were penned
  into.) Renaming one is a DISPLAY ALIAS in `dash:names`, exactly like renaming
  a built-in — never a rewrite of the registry name, which is the raw label
  `user_category`/`budgets`/`budget_months` are all keyed by, and rewriting it
  orphans every one of them. Adding and retiring live in the "+ Add category"
  sheet rather than on the rows, because a delete button on some rows and not
  others is the separation the unified list exists to remove.
- **`toTxShape` stamps `counted`** = the shared `isSpend()` verdict for that
  row. Anything that lists transactions behind a total (the category drill-in)
  must split on it rather than re-deriving the rule, or the list's own sum
  drifts from the number that was tapped to open it. Same reasoning as
  `getEnvelopeSpending` aggregating through `isSpend()`.
- "Transfers and card payments" and "Return" (credit-card negatives) are never
  counted as spending; "Return" is never counted as income.
- **`Uncategorized` is the fallback, and it is a real taxonomy member.** It IS
  counted as spending (the money left) but is never budgetable and is never
  offered in the manual category picker — the way to undo a wrong pick is
  "Reset to automatic". It exists because the old fallback was "Shopping and
  gear", a category actually in use, so "we don't know" was indistinguishable
  from a confident answer: 46% of a realistic merchant corpus landed there.
  Now the unknown is visible and sized. Don't reintroduce a real category as
  the fallback.
- **CSV history must never overlap a live feed.** `csv:` and `sfin:` dedup ids
  are separate namespaces and cannot see each other, so a CSV covering dates the
  feed already has double-counts every transaction in the overlap, with nothing
  downstream able to catch it. Importing into a SimpleFIN account excludes every
  row dated on or after that account's earliest synced transaction
  (`getFeedCoverageStart` → `overlapFrom` → `isOverlap`). The boundary day
  itself belongs to the feed. This is what makes "rebuild history from CSV" safe.
- **Categorization precedence at WRITE time:** learned rule (`category_rules`)
  → keyword table (`src/txClassify.js`) → `Uncategorized`. At READ time
  `user_category` still wins over all of it. Learned rules do NOT override the
  transfer/card-payment guards — those protect spending totals, and a rule that
  made card payments count as spending would be a footgun. Both write paths
  (SimpleFIN sync and CSV import) must pass `rules`, or a corrected merchant
  reverts on the next pull. `merchantKey` drops numeric tokens only, so
  "SAFEWAY #1234" and "SAFEWAY 8892" collapse but "COSTCO GAS" and
  "COSTCO WHSE" stay distinct; matching is exact or whole-token prefix,
  longest rule wins.
  **Known limit, pinned by a REGRESSION test in `test/txClassify.test.js`:** the
  prefix runs rule→row, so a rule is only general if the descriptor it was
  taught from was ALREADY the short form. Teach from "COSTCO GAS #0117 SEATTLE
  WA" and the key becomes `COSTCO GAS SEATTLE WA`, which matches that store and
  nothing else — not even "COSTCO GAS #0117". Every automatic fix (stem to N
  tokens, strip a trailing city/state, match both directions) trades false
  misses for false MERGES, and a confidently wrong category is the failure mode
  this codebase repeatedly refuses. Left as-is deliberately; letting the user
  shorten the key in the confirm is the honest fix if it starts to matter.
- **A card PURCHASE can never be classified as a card payment.** "Transfers and
  card payments" is excluded from spending, so a false positive there deletes
  money from every total silently. Two guards in `src/txClassify.js`: an issuer
  name (CAPITAL ONE / AMEX / DISCOVER…) must co-occur with payment wording, and
  a positive amount on a `credit` account skips the transfer rules entirely — a
  payment arrives as money *in*. Always pass `accountType` to
  `classifyDescription` where it's known. Before this, "Capital One Travel" and
  "Discover Tire and Auto" vanished from the dashboard.
- Sync upserts deliberately OMIT user-owned columns (nickname, color, hidden,
  type/subtype on existing rows, user_category, user_description, excluded) so
  edits survive syncs.
- Account labels: `nickname || "name ··mask"`; badge color from `ACCOUNT_COLORS`
  by index when `color` is null.

### Two spending/income models (deliberate — don't "unify" without asking)
- **Purchase-based** (Categories tab, Overview headline, budgets, the Budget
  tab's envelopes, "vs last month" delta): `sumSpending` / `getSpending` count
  what was *bought* by category, excluding Transfers/Return **and every
  `type === 'loan'` account** (a loan debit is a payment, not a purchase, and
  the cash already counts on its way out of checking). All of them go through
  the shared `isSpend()` predicate in `dataAdapter.js` — keep it that way so an
  envelope's Spent can never disagree with the Categories bar.
- **Joint-budget cash-flow** (Trends income-vs-spending, 6-mo bars, Cash flow
  section): `getCashFlow`. The connected accounts are two **joint** BECU
  accounts (checking + savings); real paychecks land in three **personal**
  accounts that are NOT connected to Plaid — so true household income is
  unmeasurable until those are added (see CSV import in Roadmap). Model chosen
  by Mason ("joint-budget view"):
  - **Income** (`cashIncome`) = money *into* either joint account, checking OR
    savings — `isHouseholdDepository` = `type === 'depository'`. Includes money
    moved in from the personal accounts (no synced counter-leg to wash against),
    so income runs high — it is NOT just paychecks.
  - **Spending** (`cashSpending`) = money *out of* joint **checking** only
    (`isCheckingAccount` = depository & `subtype !== 'savings'`). Savings
    outflows are never spending. Incl. credit-card *payments*; card *purchases*
    are not counted here.
  - **Internal transfers** washed by `markInternalTransfers`: a depository
    `TRANSFER_OUT` pairs with a depository `TRANSFER_IN` of equal amount on a
    *different* account within 4 days → both `_internal`, skipped. Only the two
    joint accounts are synced, so the only pairs that can match are joint
    checking ↔ savings; transfers in from the un-synced personal accounts stay
    counted as income (by design). Keep the depository↔depository restriction
    tight — matching a depository→credit leg would wrongly wash out card
    payments (which `cashSpending` must count) and unmatched real-income
    deposits. Needs `raw_category` + `subtype` (both queried).
    Pairing is a **maximum bipartite matching** (Kuhn's, in `maxMatchTransfers`,
    per equal-amount bucket) — NOT greedy nearest-partner, which could give an
    early leg the nearer partner and strand a later pair outside the window,
    leaving a real transfer counted and inflating income AND spending equally
    (net unaffected). Verified maximum against brute force — that check is now a
    permanent seeded test in `test/cashFlow.test.js`. Inputs are sorted
    before matching so the same data always washes the same pairs. The whole
    model lives in `src/cashFlow.js` (pure, zero imports); dataAdapter
    re-exports the helpers.
  - **Cash flow section** = net per month (income − spending), diverging bars.
  - Trends spending can legitimately differ from the Overview headline —
    different questions. Abandoned attempts (same-day/same-amount wash; blanket
    `raw_category` income filter) are in git log — don't retry them.
- **Assistant model/effort** is user-selectable; `src/assistantModels.js` is the
  shared allowlist (Haiku 4.5 / Sonnet 5 / Opus 4.8) + `estimateCostRange`. The
  server validates the choice and only sends `thinking`/`effort` to models that
  support them (Haiku 4.5 predates both — sending them 400s). Requires
  `ANTHROPIC_API_KEY` in Vercel (else the Ask tab shows "not configured").

### Envelope budgeting (decided — don't relitigate)
The Budget tab's model. `available = assigned + carry − spent`, walked from each
category's own first assignment; the pure core is `src/envelopes.js`.

- **A missing `budget_months` row means `assigned` 0. Never fall back to
  `monthly_limit`.** Falling back makes every month nobody touched accrue
  `(limit − spent)` into the carry and manufactures a phantom balance on day
  one. Assignments only ever come from an explicit user action, so the number on
  screen always equals the number the walk rolls forward. (Caught in review
  before it shipped; pinned by a named REGRESSION test in
  `test/envelopes.test.js`.) A **zero** assignment is likewise not an envelope —
  `moveMoney` can leave a 0 row behind, and a 0 row must stay equivalent to no
  row, or the category would start walking from there and turn its earlier
  ordinary spending into rolled-over debt.
- **Envelopes use the purchase-based model only** (`isSpend()`, shared with
  `getSpending`/`sumSpending`, including the loan-account guard). Never
  `getCashFlow` — mixing the two models double-counts.
- **`Uncategorized` (and the transfer bucket) can't be budgeted** —
  `isBudgetableCategory` gates assignments, targets, moves and the picker; its
  spending still renders read-only so the size of the unknown stays visible.
- **Overspend carries the category negative.** Real YNAB instead docks next
  month's Ready to Assign on *cash* overspending and only rolls credit-covered
  overspend negative. With no cash-vs-credit envelope split, carrying negative
  is the only coherent choice — a simplification, not fidelity.
- `assigned` / targets are plain positive dollars, **outside** the
  `positive = money out` sign convention (only Spent carries the sign).
- Envelope tables key on the **raw** category label, like `budgets`.
- **Don't put a date clamp on the walk.** A rolling balance is every assignment
  and every dollar spent since the envelope opened, so the walk starts at each
  category's *own* first assignment, however old. A 24-month window was tried
  and reverted: it froze a long-running sinking fund at a stale balance that
  drifted further every month. `budget_months` is paginated for the same
  reason — a row cap would silently drop real dollars. `MAX_WALK_MONTHS` is
  only a runaway guard on the loop, and tripping it sets `truncated` rather than
  quietly returning nothing.
- **RTA income is hand-entered and never carried between months.** With a typed
  figure, a carry-forward would compound every month the user left blank. One
  month in, one month out.
- The walk reads only the columns `isSpend()` needs and **skips
  `markInternalTransfers`** — envelopes never read `_internal`, and that
  matching is O(V·E) over a range that grows with the budgeting history.
- A by-date target **forces rollover on** — a sinking fund only reaches its
  number because leftovers carry; with rollover off it would ask for the full
  share forever and never converge.

**The income wall (why Rule 1 is hand-entered):** Ready to Assign needs
trustworthy income. SimpleFIN syncs only what is linked *and unhidden* (new
accounts arrive hidden), CSV/PDF import is periodic, and a missed paycheck
would silently read as less money to budget — so deriving income risks a
quietly-wrong number in exactly the place that must be trusted. The figure is
typed in. If every income account proves reliably fed, deriving it becomes an
option; that is a decision for Mason, not an automatic upgrade.

## Merged features (live on main; details in code + PRs)

- **Transaction editing** — detail sheet: recategorize (`user_category`),
  exclude (`excluded`), rename (`user_description`); columns on `transactions`.
- **Budgets** — per-category monthly limits + progress bars; `budgets` table.
- **Recurring** — client-side subscription detection (`src/recurring.js`, pure).
- **Search** — cross-month `ilike` search (`searchTransactions`).
- **Assistant** — "Ask" tab, Claude spending Q&A (`api/assistant.js` +
  `api/_lib/spendingContext.js`), read-only, model/effort selectable. The
  context honors user edits: skips `excluded` rows, prefers `user_category` /
  `user_description` — keep any change to it deterministic (byte-stable output
  per DB state) or prompt caching stops hitting.
- **Trends joint-budget cash-flow + Cash flow section** (see Conventions).
- **CSV import** — Accounts-tab modal, modes by target account
  (`src/csvImport.js` pure core + `src/components/CsvImport.jsx`; migration
  `20260722000001_csv_import.sql` adds `accounts.is_manual` + `transactions.source`,
  additive `not null default`). **Standalone** (manual target): parse a bank CSV
  (BECU preset; sign flip Debit−Credit → positive=out; category validated against
  `ERA_CATEGORIES`; internal-transfer flags), preview (greyed dupes), then upsert
  real rows on a manual "Imported" account (no `plaid_tokens` + `status='disabled'`
  → sync skips it). Dedup id `csv:`+64-bit hash(date,amount,normDesc)+per-day
  ordinal (never the file row-index → idempotent re-import). **Comparison**
  (Plaid-linked target): `reconcileCsv` maximum-matching audit (exact amount +
  ±4-day window, description optional), inserts NOTHING — buckets: sync gaps /
  pending-timing / amount·date·category mismatches. No cash-flow change (imported
  depository rows flow through `getCashFlow`; personal↔joint transfers wash across
  CSV+Plaid legs). The importer degrades gracefully if the two columns are absent.
  A third mode, **history backfill** into a SimpleFIN account, shipped with the
  SimpleFIN merge below.
- **Internal-transfer max-matching** — `markInternalTransfers` pairs transfer
  legs with a maximum bipartite matching instead of greedy nearest-partner (see
  Conventions). Only affects two same-amount transfers made 2–5 days apart whose
  legs drift 2–3 days — i.e. cross-bank personal↔joint ACH, which CSV/PDF import
  made reachable; same-day BECU sweeps were already matched correctly, so most
  months' figures don't move at all.
- **Dark mode + Auto/Light/Dark toggle + render-time palette contrast** — the
  app had NEVER rendered dark: inline CSS vars on Dashboard's root div shadowed
  the `:root` dark rule (an inline custom property beats even `!important` on an
  ancestor). `src/ui.css` now owns the tokens AND the shared `.card`/`.tab`/
  `.ibtn` classes, which were trapped in Dashboard's `<style>` — so Login /
  EmptyState / LinkAccount, which render before Dashboard mounts, are styled for
  the first time. Header toggle + `src/theme.js` (see Conventions);
  `src/paletteContrast.js` keeps category colors legible in both themes from the
  same stored hexes. Three latent bugs fixed on the way: the Trends 6-month bars
  collapsed to 4px stubs (% height against an auto-height flex parent), the
  "All accounts" chip asked for `var(--muted)22` (not a color, so its active tint
  never painted), and the Donut's `opacity:.9` ate the contrast correction.
  Light mode is a pixel no-op EXCEPT where contrast correction deliberately
  changes it — the amber "approaching budget" bar was 1.20:1 on the light track
  (invisible) and now renders as legible dark gold. Known and deliberate:
  `--light-muted` #888780 is 3.61:1 on the card, so light-mode small labels still
  fail AA while their dark counterparts pass — a palette decision, not a bug.
- **PDF statement import** — the same modal accepts a PDF, for accounts whose
  statements are only downloadable that way. No per-bank code: `src/pdfExtract.js`
  (lazy pdf.js) yields positioned text runs, and a **template** the user confirms
  once in `PdfTemplateEditor` (drag column edges, label each column) turns them
  into the **same cell grid `buildRows` consumes** — so dedup, categories, the
  preview, the standalone insert and the comparison audit are reused unchanged.
  Templates save per account as `pdftpl:<accountId>` in `settings` and re-apply to
  later statements; rows are selected by SHAPE inside a text-anchored region and
  no page/y coordinate is stored, so a template survives the table moving next
  month. Month-name dates resolve from the statement period (Dec→Jan wrap
  handled); card statements use the POSTED date to match Plaid. Adds a manual
  **credit-card** account type and tags rows `source='csv'|'pdf'`. No migration.
  Verified on real statements (Capital One 112 rows with totals matching the
  statement exactly; NewRez mortgage 7 rows across a page-split table) and on a
  real iPhone.
- **SimpleFIN feed (migration phases 1–2)** — a second bank feed running
  alongside Plaid, built to replace it (~$15/yr flat vs Plaid's per-Item
  billing). `api/_lib/simplefin.js` (protocol) + a second pass in `api/sync.js`
  + `api/simplefin-claim.js` / `simplefin-status.js` + the
  `SimpleFinConnect.jsx` modal; migration `20260724000001_simplefin.sql`
  (`simplefin_access` table + `institutions.simplefin_org_id`). Feed
  discriminator, hidden-on-arrival accounts, the two-watermark throttle, the
  both-wire-shapes reader, the SSRF-safe claim, and the balance-sign rule are all
  in Architecture / Conventions. **Phase 3 (diff, then retire Plaid bank by
  bank) is the next task**, not something this merge did.
- **Account-type editor** — SimpleFIN sends no type, so it's guessed from the
  account name and then user-owned; the Accounts tab can correct it, and
  crossing the debt boundary forces a re-sync so the stored balance sign follows.
- **Classifier rebuild** — `src/txClassify.js` now owns the descriptor→category
  table for BOTH feeds (SimpleFIN and CSV/PDF derive `mapped_category` at write
  time from it). `Uncategorized` replaced 'Shopping and gear' as the fallback,
  which took the fallback rate on a realistic merchant corpus from 46% to 7% and
  made the size of the unknown visible instead of silently inflating a real
  category; five categories that no rule could ever reach gained rules; and two
  guards stop a card PURCHASE ever being read as a card payment (see
  Conventions) — before them "Capital One Travel" and "Discover Tire and Auto"
  vanished from every total.
- **Learned merchant rules** — correcting a transaction offers "always
  categorize this merchant as X", which writes a `category_rules` row
  (migration `20260728000001_category_rules.sql`) and optionally re-labels past
  transactions. Rules beat the keyword table at write time but never override
  the transfer / card-payment guards.
- **Plaid removed (SimpleFIN phase 4)** — the end state: SimpleFIN + CSV/PDF
  import, no Plaid anywhere. Deleted `api/_lib/plaid.js`,
  `api/create-link-token.js`, `api/exchange-token.js`,
  `src/components/LinkAccount.jsx`, the Plaid pass in `api/sync.js` (~200 lines)
  and both npm packages; `src/plaidClient.js` → `src/apiClient.js`;
  `mapPlaidCategory` gone. Migration `20260728000002_remove_plaid.sql` drops
  `plaid_tokens`, `institutions.plaid_credential_key`/`plaid_item_id` and the
  `needs_reauth` status value — **pasted AFTER the deploy**, see the inverted
  order in Development workflow. Statement import was rebuilt around it (below).
  Two latent bugs surfaced and fixed: the modal classes were trapped in
  Dashboard's `<style>` (the dark-mode incident repeating), and a successful
  first connect landed on an all-em-dash dashboard because new accounts arrive
  hidden and `getOverview` filters them out.
- **Statement import: mode derived from the file, not the account** — with every
  account now manual or SimpleFIN-fed, the target can't distinguish "backfill"
  from "audit", so the file's date range against the feed boundary decides (see
  the CsvImport row in Key files). Fixed on the way: `targetIsManual` was
  `!targetIsPlaid` and silently became true for every SimpleFIN account; a
  FAILED coverage lookup was indistinguishable from "the feed has nothing", so a
  dropped connection opened the overlap guard on a synced account; a never-synced
  account read as "import everything" when its first pull reaches back as far as
  the feed allows.
- **Envelope budgeting (YNAB rules 1–3)** — a **Budget tab** that plans forward:
  `available = assigned + carry − spent`, walked month by month from each
  category's own first assignment. Ready to Assign on **hand-entered** income
  (recurring default + per-month override in `settings`; the feed can't see
  every paycheck — see "the income wall" in the spec history); funding targets
  that are monthly top-ups or **by-date sinking funds** + "Fund targets";
  per-category rollover of leftovers *and* overspend + moving money between
  envelopes in one atomic upsert. Model is pure in `src/envelopes.js`
  (`test/envelopes.test.js`); `budget_months` is the per-(category, month)
  grain and `budgets.monthly_limit` becomes a funding target. Migration
  `20260729000001_budget_envelopes.sql`, **applied to PROD 2026-07-29**. The
  decided-don't-relitigate list is in Conventions below — the two that were
  nearly got wrong (a missing assignment must never fall back to the target; the
  walk must have no date clamp) are pinned by named REGRESSION tests.

- **Category drill-in + custom categories unified** — tapping a category's
  transaction count or amount (Categories tab) or its Spent (Budget tab) opens
  `CategorySheet`: that month's rows in that category, split into the ones the
  total is made of and a "Not counted" tail, off the adapter's `counted` flag so
  the list's sum is the number that was tapped. Custom categories became
  ordinary rows in the Categories list carrying their own colour into the Budget
  tab, the donut and every pill (see the Conventions entry); "+ Add category"
  became the add-and-retire manager. Three optimistic-refresh bugs fixed with
  it, all the same shape — `reloadData` only refetches the current month, so
  anything it doesn't reach keeps the pre-edit value on screen while the DB write
  lands fine: a **category change or rename made from SEARCH** never appeared
  (`saveTx` never patched `searchRes`, and `merchant_name` is derived, so
  `toTxShape` gained `auto_description` to recompute it), and **"Always
  categorize this merchant as X"** appeared not to reach the other transactions
  (a rule rewrites OTHER rows, so there is no id to patch — `learnMerchant` now
  refetches the search results and the open account sheet). Alongside those, a
  **failed** learned-rule dry run was folded into `count = 0`, which renders
  identically to "nothing to update", and the candidate scan paged an unordered
  result set treating PostgREST's end-of-range 416 as fatal. See the `saveTx`
  Gotcha and `test/txClassify.test.js` (first coverage of that path, incl. a
  REGRESSION test pinning the over-specific-key limit). No migration.
- **SimpleFIN advisory deadlock fixed** — the feed had been stuck since it
  shipped: SimpleFIN returns notices about the date range *we* requested in the
  same `errors` array as broken-bank reports, `api/sync.js` counted them as bank
  errors, so `last_pulled_at` never advanced, so every pull re-asked for the full
  730-day window and got the same notice — while each pull wrote ~490
  transactions perfectly well. It also blocked CSV/PDF import into EVERY
  SimpleFIN account (`pullWasClean` rejects any `warnings`), which is how it
  surfaced. `classifyFeedMessage` now splits messages **error / advisory /
  capped** on an allowlist, requests are clamped to `MAX_LOOKBACK_DAYS` (88 —
  the feed's real reach is ~90 days, not two years, and the modal/README copy
  said otherwise), and a *capped* range reports a `coverage_shortfall` instead of
  stalling the watermark (stalling recovers nothing — the next pull is served the
  same truncated window). Review caught two mis-downgrades of real failures, both
  now named REGRESSION tests: the trouble veto ran after the guessed code
  allowlist, and `\bauthenticat\b` cannot match "Authentication". First unit
  coverage for `api/_lib/simplefin.js`. No migration. See the first Gotcha.

## Pending branches

None.

Envelope budgeting merged 2026-07-29; its migration was applied to PROD ahead of
the merge, so nothing is outstanding there.

Phase 4 is fully landed: code merged and deployed, and
`20260728000002_remove_plaid.sql` **applied on 2026-07-29** after its pre-flight
fired once (below). Every migration in `supabase/migrations/` is live.

**What the pre-flight caught, because it is the kind of thing that recurs.**
Three `plaid_tokens` rows survived a phase-3 cleanup that had gone by what was
visible in the app — and they were invisible for a reason: `ALLOWED_TYPES` did
not include `'loan'` until `031c330` (2026-07-23), so every attempt to link the
NewRez mortgage produced an Item and an institution row but filtered the account
away. Three link attempts, three live Plaid Items, nothing on screen. The lesson
is that "I removed everything I could see" is not the same as "the database is
empty", and a migration that DROPS should verify rather than trust. All three
had zero accounts and zero transactions, so clearing them lost nothing.

**Still outstanding, and NOT a code task:** those three Plaid Items still exist
on Plaid's side. A Transactions Item is a live recurring pull — Plaid keeps
reading the bank 1–4× a day for as long as the Item exists, Items never expire,
and no code in this repo can call `itemRemove` any more. Retiring them is a
manual job (Plaid Dashboard keys + `POST /item/remove`, or my.plaid.com, or the
servicer's own third-party-access screen). Deleting the five `PLAID_*` Vercel
env vars is done.

## Roadmap

**Next: Debt tracker** — **balance-only + hand-entered APR/min** under SimpleFIN
(spec below). The whole off-Plaid migration is **DONE** — phases 1–4 shipped;
the app is SimpleFIN + CSV/PDF import with no Plaid anywhere. Later (discussed,
not committed): net worth over time, cash-flow forecast, savings goals, CSV/PDF
export, sign-out button. **Envelope follow-ups** (the tab is shipped, these are
not): Age of Money — wants real *measured* income, so it waits on the income
wall; scheduled/expected transactions; reconciliation; per-month target
overrides (a target is one setting per category today, not per month);
auto-filling next month's assignments from this month's. **`accounts.available_balance` holds two conventions**
— SimpleFIN's raw feed value when it sends `available-balance`, and the
*normalized* balance when it doesn't (`api/sync.js`'s `?? balance` fallback).
Invisible today (nothing renders it) but it surfaces the moment the Debt view
shows utilization; sort it out then, and never run it through `displayBalance`
— for a card it means available *credit*, not a debt.

### Off-Plaid: SimpleFIN — COMPLETE (phases 1–4 shipped)
Decision (settled, executed): **SimpleFIN Bridge** replaced Plaid as the bank
feed — ~$15/yr flat (no per-product / Item-slot billing), read-only, daily
refresh, **serverless-friendly (no daemon)**. Coverage verified for every
household institution incl. NewRez / Launch / Jenius. The end state is
**SimpleFIN + CSV/PDF import**, and it is where the app now is.

Phases, all shipped: 1. CSV import (the permanent coverage floor). 2. SimpleFIN
alongside Plaid. 3. Diff, then migrate bank by bank. 4. Remove Plaid entirely.

Caveats that came with the trade: weaker categorization than Plaid (it leans
entirely on `src/txClassify.js` plus learned rules); daily freshness, not
real-time; $15/yr flat.

**Settled during the build** (verified against simplefin.org/protocol.md plus
independent Go/Rust/Python clients — don't relitigate):
- Claim: setup token is base64 of a **single-use** claim URL → POST it, no body,
  no auth → the response **body** is the durable access URL (plain text; trim).
- The access URL embeds Basic credentials and **Node's fetch refuses a URL with
  userinfo** — they must be split out into an `Authorization` header.
- `amount`/`balance`/`available-balance` are numeric **strings** ("-05.50" is
  real); `posted`/`transacted_at`/`balance-date` are epoch **seconds**, and
  `posted` may be **0** for a pending row (a sentinel, not 1970).
- **Two wire shapes** — v1 `errors` + a per-account `org`; v2 `errlist` (objects)
  + top-level `connections` joined by `conn_id`. **The server picks** when the
  request doesn't pin `version`, so `normalizeAccountSet` reads both and both
  resolve to the same org key (a flip must not fork institutions).
- Per-bank failures come back as **HTTP 200** with usable accounts *plus* error
  entries; 403 = credentials revoked, 402 = payment required. The protocol
  requires **sanitizing** feed messages before display.
- No cursor, no pagination, and **no "removed" signal** — idempotent upsert on
  `(account_id, plaid_tx_id)` is the only thing making a re-pull safe. Which is
  why **pending transactions are off by default** (`SIMPLEFIN_INCLUDE_PENDING=1`
  to try them): a pending row whose id changes when it posts would strand a
  duplicate forever with nothing to clean it up.
- Ids: `plaid_account_id = 'sfin:'+account.id`, `plaid_tx_id = 'sfin:'+tx.id`,
  `transactions.source = 'simplefin'` (deviates from the original spec's bare
  `tx.id` — the prefix matches the `csv:`/`manual:` precedent and keeps each
  adapter's id space self-describing).
- Unlinking a SimpleFIN institution **disables** it rather than deleting it: one
  access URL covers every bank, so a deleted row would just be recreated by the
  next pull. The disabled row is the tombstone that keeps it out — and the
  connect modal lists removed banks with a Restore button, because without one
  that tombstone is permanent and a mis-tap is unrecoverable.

**SETTLED against live data (2026-07, Capital One Venture X):** SimpleFIN
reports a credit/loan balance **NEGATIVE when money is owed**. The feed sent
-5127.97 for a card Plaid reported as +5127.97, so `normalizeBalance()`'s flip
is correct and the Debt tracker can rely on it. (Proof it was the raw feed
value: `normalizeBalance` can never *return* a negative for a credit account, so
a stored negative means the row was typed `depository` at sync time.) Still
approximate for an **overpaid** card — reported positive, left positive, i.e.
shown as owed. Rare and small.

**Account-type inference is the fragile part, not the balance.** Card *product*
names carry no card-ish word — a "Venture X" landed as `depository/checking`,
which would have counted all 348 card purchases as household cash spending the
moment it was unhidden. `inferAccountType` now also matches product names
(venture/quicksilver/freedom/sapphire/…), card-only issuers, and falls back to
`credit` on a negative balance; the deposit rules still run first so
"Platinum Savings" and "Preferred Checking" stay deposits. **Always eyeball the
type on a new SimpleFIN account** — the sync logs a warning when it guessed.

OUT (not now): **email-alert cron** (Vercel Cron → `api/` route polling Gmail,
parsing alerts, inserting service-role for minutes-fresh top-ups, reconciled
against the ledger). **Channel C home-IP scraper** — possible later build-out for
any servicer a feed can't cover: runs on a home Pi/NAS (residential IP,
outbound-only to Supabase, `household_id` set explicitly under service_role),
reusing the dormant `pull_jobs` / `mfa_prompts` / `pending_items` schema + the
24h `check_pull_job_constraints` rate limiter; real ToS/lockout risk → scoped
surgically, never the foundation.

Caveats: weaker categorization than Plaid (leans on `src/txClassify.js`); daily
freshness, not real-time (same as Plaid today); $15/yr flat.

### Debt tracker — build spec
**NOTE (data source, decided):** with the off-Plaid → SimpleFIN move, debt data
is **balance-only + hand-entered APR/min** — SimpleFIN has no Liabilities feed.
The Plaid `additional_consented_products` / `/liabilities/get` build steps below
apply ONLY while Plaid is retained; under SimpleFIN, `current_balance` comes from
the feed and `apr`/`minimum_payment` are user-entered (kept out of the sync
upsert). Balances + `getDebts` + `debtPayoff` + the Debt view are unchanged.

Goal: track the household's debts (mortgage, credit cards, personal/student
loans) with balances, APR, minimum payments, and payoff projections. Balances
come from connected accounts (Plaid now, SimpleFIN after migration); the app only
ever saw the *payments* leaving checking, so connecting the debt accounts is the
point.

Foundation already shipped: `api/sync.js` `ALLOWED_TYPES` now includes `'loan'`,
so a Plaid-linked mortgage/loan account syncs its balance and appears in the
Accounts tab (`getAccounts` has no type filter; `getOverview`'s header list is
still credit+depository by design — the Debt view owns debts).

What Plaid gives beyond payments — the **Liabilities** product (`/liabilities/get`):
- Credit cards: per-APR breakdown, `last_statement_balance`, `minimum_payment_amount`,
  `next_payment_due_date`, last payment amount/date, overdue flag.
- Mortgages: `interest_rate`, current `principal`, next monthly payment + due date,
  `maturity_date`, YTD interest vs principal, origination amount.
- Student/personal loans: interest rate, minimum payment, next due date,
  `expected_payoff_date`, outstanding interest, servicer/status.
- Plain balance product already gives outstanding balance + `credit_limit`
  (→ utilization). Verify exact field names against current Plaid docs at build.

Build steps:
1. **Consent to Liabilities at link time.** `api/create-link-token.js` currently
   `products: ['transactions']`. Add liabilities via
   **`additional_consented_products: ['liabilities']`** (keep `products:
   ['transactions']`) — Plaid's PFM pattern: doesn't block institutions lacking
   Liabilities and, unlike `products`/`optional_products`, is NOT billed at Item
   creation, only when you first call `/liabilities/get`. **Existing
   transactions-only Items need Link update mode** (a link token minted with the
   Item's `access_token` + liabilities in `additional_consented_products`) to
   gain the consent — preserves the Item + transactionsSync cursor;
   unlink→relink is the fallback. Surface a "reconnect for debt details" action;
   detect Items needing it by credit/loan accounts whose liability fields are
   still null.
2. **Pull liabilities in sync.** After `transactionsSync`, call
   `liabilitiesGet({ access_token })`; map `credit[]`/`mortgage[]`/`student[]`
   by `account_id` onto the account row. Outstanding balance stays the account
   `current_balance` (`balances.current`), not a liability field. Card `apr` =
   the `aprs[]` entry where `apr_type === 'purchase_apr'` (array can be empty →
   null). **Handle absence gracefully** — institutions without Liabilities throw
   (`PRODUCTS_NOT_SUPPORTED` / `PRODUCT_NOT_READY`); catch per-institution, don't
   fail the whole sync.
3. **Schema (additive on `accounts`):** `apr`, `minimum_payment`, `credit_limit`,
   `statement_balance`, `next_payment_due_date`, `interest_rate`,
   `original_balance` (all nullable numeric/date). Plaid returns rates as
   **percent**; payoff/getDebts read one normalized `debtRate = apr ??
   interest_rate` and divide by 100 for monthly math. `current_balance` is the
   outstanding balance, **stored** positive = owed — payoff math and utilization
   both want that; the Debt view must render it through `displayBalance` like
   every other balance. These are **Plaid-owned** (refreshed
   each sync). Optional `liabilities_raw jsonb` to keep overdue/last-payment/YTD
   fields without column sprawl (recommended).
4. **Balance history:** `balance_snapshots (id, account_id, household_id,
   captured_on date, balance numeric, unique(account_id, captured_on))` — same
   RLS shape as other tables. **`balance` mirrors the STORED convention** (it is
   `accounts.current_balance` at capture time, so debts positive); the chart
   flips at render via `displayBalance` like everywhere else. Do NOT store debts
   negative here to make a net-worth `SUM()` easier — mixing both signs in one
   column is unrecoverable once rows accumulate. Sync appends a row only when the balance changed
   (≤ one/day; upsert on the unique key) and — running as **service_role** —
   must set `household_id` explicitly (the `current_household_id()` default is
   NULL there; see Gotchas). Powers the debt-over-time chart AND seeds net worth.
5. **`src/debtPayoff.js`** (pure, like `recurring.js`): month-by-month
   amortization from `current_balance` + `apr` + `minimum_payment`; **snowball**
   (smallest balance first) vs **avalanche** (highest APR first) vs extra-$/mo
   what-if → debt-free date, total interest, interest saved.
6. **`getDebts()` in dataAdapter:** accounts where `type in ('credit','loan')`
   with the liability fields + computed totals (total debt, total minimums).
   Compute totals from the STORED positives; then decide deliberately how the
   total is shown, because a positive "total debt" sitting above negative
   per-card rows is exactly the inconsistency `displayBalance` exists to remove.
7. **Debt view** (new "Debt" tab): per-debt cards (balance, APR, min, due date,
   card utilization = `current_balance/credit_limit`), totals (exclude hidden
   accounts), payoff projection (snowball/avalanche toggle + extra-payment slider
   → debt-free date + interest saved). **Mortgages dominate a snowball/avalanche
   and make "debt-free date" meaningless — exclude mortgages from the payoff
   projection by default** (still list them; keep out of the debt-free calc or
   behind an opt-in toggle). Card progress uses utilization (cards have no
   `original_balance`).

Keep out of spending/cash-flow: loan/credit accounts are debts, not spend —
`isCheckingAccount`/`isHouseholdDepository` already exclude them from cash-flow,
and `sumSpending`/`getSpending`/`buildSpendingContext` now **guard
`type === 'loan'`** (done on the SimpleFIN branch — Plaid loans carry no
transactions, but SimpleFIN ships the servicer's real list, which double-counted
the mortgage against the checking outflow). Never guard out `credit`, whose
*purchases* must still count. Card *payments* from checking stay transfers.

Manual fallback (FOLLOW-UP, not v1): the CSV-import manual-account machinery
(`is_manual`, manual institution) has **shipped** — a manual debt can reuse it
(`is_manual`, `type='credit'|'loan'`, hand-entered balance/apr/min). **v1 is
Plaid-linked debts only** — which is the point (the household wants it automatic).

Caveats: Liabilities is a separate Plaid product (billing) with uneven
institution coverage; existing Items need re-linking to gain it; connecting many
debts eats Plaid Item slots (the multi-credential picker handles it). Debt
tracker is the liability half of the future net-worth feature — the
`balance_snapshots` table is shared groundwork.

## Gotchas

- **SimpleFIN puts advisories about YOUR OWN REQUEST in the same
  `errors`/`errlist` array as broken-bank reports, and the ordinary first pull
  triggers one.** Two live examples: "Requested date range exceeds limit of 90
  days and was capped." (asked >90; data WAS truncated at the old end) and
  "…exceeds recommended range of 45 days. In the future, this may be capped."
  (asked 46–90; purely advisory, nothing lost). `api/sync.js` counted every entry
  as a bank error, which **deadlocked the feed in production**: `last_pulled_at`
  only advances on an error-free pull, so it stayed NULL, so the next pull asked
  for the full `FIRST_PULL_DAYS` window, which re-emitted the notice — forever,
  while each of those pulls wrote hundreds of transactions perfectly well. It
  also blocked ALL CSV/PDF import into EVERY SimpleFIN account, because
  `pullWasClean` treats any `warnings` as unclean. Four rules now:
  (a) `classifyFeedMessage` is an **allowlist** — an unfamiliar message stays an
  error, per-bank structure (`conn_id`/`account_id`) forces error unless the
  `code` is allowlisted, and a "needs attention / reconnect / credential" veto
  beats the range match; (b) requests are **clamped** (`MAX_LOOKBACK_DAYS`, ~88)
  so the hard-cap notice can't arise, at `fetchAccountSet` so the new-account
  backfill is covered too; (c) advisories never reach the result `warnings[]`
  (which `pullWasClean` inspects), travelling in a separate `advisories` key —
  nor `last_error` (rendered in `--danger`) on any ordinary pull; the one path
  that can still put one there is the zero-usable-accounts throw, which is
  pre-existing and self-clears as soon as a bank is linked; (d) **the watermark
  is never used to express
  a coverage shortfall** — stalling it recovers nothing, since the next pull
  computes the same start and is served the same truncated window, so a shortfall
  is *reported* (`coverage_shortfall`) and the watermark still moves. Note the
  shape of this failure: a watermark that never advances has **no alarm
  anywhere** — the only tell was `last_pulled_at` NULL while transactions kept
  arriving. `test/simplefin.test.js` pins the classification, including that a
  novel message stays an error.
- **Nothing in this repo loads `api/*.js` except `test/apiLoads.test.js`.**
  `vite build` bundles only what `src/main.jsx` reaches, and no `src/` file
  imports `api/` — the client talks to those routes over HTTP. So a dangling
  import in a route passes both `npm run build` and (without that test) `npm
  test`, and ships green; it surfaces as a 500 on the first real request. If
  that request is `/api/sync`, the bank feed is dead while the dashboard just
  looks stale. Demonstrated during phase 4: the build reported success with a
  broken `sync.js`.
- **Applied migration files are append-only history.** Several under
  `supabase/migrations/` carry Plaid prose in comments. Correct stale
  explanations in CLAUDE.md and the READMEs — never in a migration that has
  already been pasted, or `migrations/` stops describing what the live database
  actually ran.
- **A `404` is not proof a deploy went out.** Probing a deleted route returns
  404 straight from Vercel's router without loading any other function, so a
  deploy whose `sync.js` fails at module load passes that check. Probe
  `POST /api/sync` and require **401** (`requireUser` rejecting an
  unauthenticated call proves the module loaded and ran); a module-load failure
  is a 500.
- Supabase SQL Editor runs as service_role: `auth.uid()` is NULL, so
  `household_id` defaults DON'T resolve — admin inserts there must set it
  explicitly. (Client inserts are fine — `auth.uid()` resolves.) Same trap in
  `api/` routes: `simplefin_access` deliberately has **no** `household_id`
  default so a service-role insert that forgets it fails loudly.
- Node's `fetch` (undici) throws on any URL containing credentials — "Request
  cannot be constructed from a URL that includes credentials". SimpleFIN access
  URLs are exactly that, so `splitAccessUrl` moves them into an `Authorization`
  header. Don't "simplify" it back to fetching the URL directly.
- The SimpleFIN setup token is user-supplied and the server POSTs to whatever it
  decodes to, so both outbound calls go through `fetchNoOpenRedirect`
  (`redirect: 'manual'`, re-checking scheme + host at every hop). Plain `fetch`
  follows redirects by default, which walks straight past the private-address
  check — a public claim URL can 302 to the cloud metadata endpoint.
- A missing-COLUMN error names its table too ("column simplefin_access.
  last_attempt_at does not exist"), so the graceful-degrade checks for a missing
  table and a missing column must be **separate** tests (`isMissingTableError` /
  `isMissingColumnError` in `api/sync.js`). Conflating them reads a column
  problem as "the feature isn't installed" and silently switches the whole feed
  off. Relatedly: never add a column to the body of an already-published
  `create table if not exists` — that's a no-op on a database that already ran
  it. Restate it as `alter table … add column if not exists`.
- PostgREST bulk upsert needs an **identical key set** on every row in the
  array, which is why the SimpleFIN account write splits into a bulk insert for
  new accounts and per-row updates for existing ones — restating type/subtype/
  hidden in a uniform payload is precisely what must not be overwritten.
- Vercel `VITE_*` vars are baked at BUILD time — changing them needs a redeploy
  (check Production AND Preview). Missing client config renders the
  ConfigErrorScreen (App.jsx), not white.
- The empty-institution count-query error must NOT fall back to the "connect
  your first account" screen (see App.jsx count handling).
- iOS PWA: apple-touch-icon must be PNG; service worker (`public/sw.js`) never
  caches `/api/*`; bump its CACHE_VERSION when changing it.
- **pdf.js must be the LEGACY build** (`pdfjs-dist/legacy/build/…`). The modern
  bundle calls `Map.prototype.getOrInsertComputed`, which current Chromium and
  iOS Safari don't have — it throws "getOrInsertComputed is not a function" on a
  real device (caught only because the harness drives a real browser). Load it
  with a dynamic `import()` so it stays out of the main bundle.
- **Safari has no `ReadableStream` async iteration** — and pdf.js's
  `getTextContent()` does `for await (const v of readableStream)`, so on EVERY
  iPhone (not just old ones) reading a PDF died with JavaScriptCore's
  "undefined is not a function (near '…i of t…')". `src/pdfPolyfills.js` fills
  it in. The tell: `getDocument` succeeds and `getTextContent` throws. Don't
  mistake this for an old-iOS problem — it isn't version-dependent. Emulate it
  locally by `delete ReadableStream.prototype[Symbol.asyncIterator]`.
- Anything that runs during **render** must be try/caught — the app has **no
  React error boundary** except `ModalErrorBoundary` inside `CsvImport.jsx`,
  which backstops only the import-modal body. Outside the modal a render throw
  still blanks the whole PWA instead of showing a message.
- **`saveTx`'s optimistic patch is the only refresh some lists ever get, and it
  must recompute every DERIVED field of the tx shape.** `reloadData` refetches
  the CURRENT MONTH only, so `transactions` self-heals but `searchRes`
  (cross-month; its effect keys on `searchQ` alone) and `acctTxs` (keyed on
  `selAcct`) do not — miss one and the edit reads as "it didn't save" even
  though the DB write landed. Same for the fields: `toTxShape` DERIVES
  `category` (from `user_category`) and `merchant_name` (from
  `user_description`), so patching only the raw column leaves the old value on
  screen. Both bugs were live — a category change made from the search results
  never appeared, and a rename never appeared anywhere `reloadData` didn't
  reach. `auto_description` exists so the rename (and "reset name") can be
  recomputed without a round trip, exactly like `auto_category`. `counted` is
  the one field that CAN'T be recomputed — it needs the account type, which the
  shape doesn't carry — which is fine only because its sole reader
  (`CategorySheet`) renders from `transactions`.
- A bank words the same transaction differently in its CSV and its PDF, so the
  dedup hash differs: importing both formats into ONE manual account
  double-inserts. `transactions.source` records `'csv'|'pdf'` and the importer
  warns on a mix — one format per account.
- A mortgage/loan statement's rows are loan accounting (suspense-account
  postings, reversals), not household spending, and the real payment is already
  in cash flow via the checking feed. Those belong to the future Debt tracker —
  don't import them onto a depository account.
- One Claude session per line of work, branched from current main — two sessions
  off different bases once regressed production (the "iphone-app" incident).
- If pushes stop deploying and GitHub API calls 503, check githubstatus.com
  before debugging webhooks/Vercel — GitHub-side outages happen.
