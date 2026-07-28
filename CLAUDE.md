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
  only for Plaid or service-secret work.
- **Two bank feeds run side by side** during the Plaid→SimpleFIN migration
  (cost; see the SimpleFIN spec in Roadmap). Plaid is still the live feed for
  everything currently linked; **SimpleFIN is built and syncing** (phase 2).
  A scraper was designed then abandoned — hence scraper-era names like the
  original `synthetic_id` column, now `plaid_tx_id`, which SimpleFIN reuses as
  an adapter-agnostic external id.
  - Feed discriminator: `institutions.simplefin_org_id is not null` ⇒
    SimpleFIN-fed. `api/sync.js` runs a Plaid pass (skipping those) then a
    SimpleFIN pass, and a failure in either can't take the other down.
  - **New SimpleFIN accounts arrive `hidden: true`.** A bank connected to both
    feeds would otherwise import every transaction twice and silently double
    every total. Unhiding is the deliberate act that switches a bank over.
- **Multi-Plaid-credential**: `PLAID_CREDENTIALS` env = JSON list of
  `{key, client_id, secret}`; link-token creation picks the first credential
  with < 10 Items; each institution stores its `plaid_credential_key`. Legacy
  `PLAID_CLIENT_ID`/`PLAID_SECRET` fall back as key "main".
- **Auth**: one shared Supabase Auth user for the household.
  `household_members` maps user → household; `current_household_id()` + RLS
  policies scope every table. `api/` routes verify the JWT via `requireUser()`
  (`api/_lib/supabase.js`).
- **RLS shape**: `accounts` / `transactions` / `institutions` each have a single
  `for all to authenticated using (…) with check (household_id =
  current_household_id())` policy — INSERT is gated by the WITH CHECK, satisfied
  because `household_id` defaults to `current_household_id()`, so the **client
  can INSERT/update/delete its own rows directly**. `plaid_tokens` and
  `simplefin_access` have ZERO client policies — only service_role (api/) reads
  them. Never expose them (the SimpleFIN access URL embeds bank credentials).
- **Sync is server-side** (`api/sync.js`), two passes, both upserting accounts
  (onConflict `institution_id,plaid_account_id`) and transactions (onConflict
  `account_id,plaid_tx_id`), both limited to `depository`+`credit`+`loan`
  (`ALLOWED_TYPES`); loans carry sparse/no transactions — their debt data comes
  from Liabilities under Plaid, hand-entered under SimpleFIN (see Roadmap).
  - **Plaid pass**: cursor-based transactionsSync per institution;
    `needs_reauth` on ITEM_LOGIN_REQUIRED.
  - **SimpleFIN pass**: per *access URL*, not per institution — one URL covers
    every bank, fetched in a single GET with no cursor and no pagination. Fans
    out into institutions (one per SimpleFIN org), accounts and transactions.
    Incremental via a `last_pulled_at` watermark minus a 30-day overlap.
    `last_pulled_at` (data watermark, advanced **only on success** so a failed
    pull can't skip transactions) and `last_attempt_at` (throttle, stamped
    **before** the request so a timeout still counts) are deliberately two
    columns — one column would force a choice between skipping transactions
    after a failure and re-hitting the Bridge on every dashboard load while a
    connection is broken. One pull an hour (SimpleFIN refreshes ~daily).

## Key files

| File | Role |
|---|---|
| `src/ui.css` | The ONLY place theme-token values live: `:root` light + a `prefers-color-scheme: dark` block (--bg/--card/--text/--muted/--border/--accent/--accent-text/--danger*/--warn*/--input-bg/--track/--shadow/--overlay), plus the font `@import` (must stay line 1), the `*` reset, keyframes, and the shared `.card`/`.tab`/`.ibtn` classes. Global so the pre-Dashboard screens get them. |
| `src/theme.js` | Theme selection + application: localStorage pref (`mm:theme`), `resolveTheme`, `applyTheme` (sets `<html data-theme>` + syncs the `theme-color` metas), `subscribeTheme`/`subscribeSystemTheme`, `readToken` (runtime token read), `initTheme` (called from main.jsx), and the `useTheme` hook the header toggle uses. |
| `src/paletteContrast.js` | Pure, zero imports: WCAG math + `readableInk`/`markColor`/`chipStyle`, which hold hue fixed and bisect lightness to guarantee 4.5:1 / 3:1 against a given surface. Never throws (runs during render). Covered by `test/paletteContrast.test.js`. |
| `src/components/Dashboard.jsx` | Almost the entire UI — single file, inline styles, tabs: overview/categories/transactions/accounts/trends/recurring/ask. Shared mini-components: `Pill`, `Swatch`, `EditName`, `Sk` (skeleton), `Donut`. |
| `src/dataAdapter.js` | All Supabase reads + shapes consumed by Dashboard. Keep return shapes stable. Also holds the CSV/PDF-import writes (`findOrCreateManualInstitution`, `createManualAccount`, `getExistingTxIds`, `importCsvTransactions`, `isManualAccount`), the comparison-mode read `getAccountTransactionsInRange`, the backfill boundary `getEarliestTransactionDate`, the learned-rule CRUD (`getCategoryRules`/`setCategoryRule`/`applyCategoryRuleToHistory`/`deleteCategoryRule`), the SimpleFIN predicates (`isSimpleFinAccount`, `ACCOUNT_TYPES`/`ACCOUNT_SUBTYPES`), and re-exports the cash-flow helpers (`markInternalTransfers`/`cashIncome`/`cashSpending`) from `cashFlow.js` so existing importers/harnesses keep working. |
| `src/cashFlow.js` | The Trends cash-flow model (see Conventions), extracted pure: `markInternalTransfers` + `maxMatchTransfers` (Kuhn's), `cashIncome`/`cashSpending`, account-type predicates. Zero imports — plain-Node importable; covered by `test/cashFlow.test.js` incl. the brute-force matching parity check. |
| `src/categoryMap.js` | Plaid category → app category mapping; `applyAccountRules` (credit-card negatives → "Return", excluded from income); `UNCATEGORIZED`/`FALLBACK_CATEGORY` + `isBudgetableCategory`; pure JS, imported by server code too. `ERA_CATEGORIES` is the taxonomy source of truth (no "Housing"/"Income" member; `Uncategorized` IS one). |
| `src/csvImport.js` | Pure CSV-import core (no React/Supabase): `parseCsv`, `detectHeader`, `parseMoney`/`parseDate`, transfer flagging, dedup `plaid_tx_id` hashing, `buildRows`/`analyzeCsv` (both take `rules` + `overlapFrom`). Re-exports `guessCategory`/`transferRawCategory`/`invalidRuleCategories` from `txClassify.js`, which now owns the rule table. Also the comparison-mode core: `reconcileCsv` (max-matching audit), `descSimilarity`, `csvDateRange`. Testable in isolation. |
| `src/txClassify.js` | Learned-rule matching (`merchantKey`, `matchLearnedRule`) + the shared descriptor→category rule table + internal-transfer tagging (`guessCategory`, `transferRawCategory`, `classifyDescription`), validated against `ERA_CATEGORIES` at load. Lifted out of `csvImport.js` when SimpleFIN became a second caller: both feeds get a descriptor and no category, so both derive `mapped_category` at WRITE time from this one table. Pure JS — imported by server code too. |
| `src/accountBalance.js` | `isDebtAccount` / `displayBalance` — the stored-positive → displayed-negative rule for credit and loan balances. Pure JS; imported by both Dashboard.jsx and the server-side assistant context. |
| `api/_lib/simplefin.js` | SimpleFIN protocol layer: setup-token decode, claim POST, access-URL split (creds → Authorization header), the `/accounts` GET, and `normalizeAccountSet` (reads BOTH wire shapes). Also `inferAccountType`, `normalizeBalance`, the sign flip, and the env knobs. Server-only — handles bank credentials. |
| `src/components/SimpleFinConnect.jsx` | Accounts-tab modal replacing Plaid Link: link banks at SimpleFIN Bridge → paste the setup token → claim + first sync. Shows connection status, a disconnect action, and Restore for removed banks. |
| `src/components/CsvImport.jsx` | Accounts-tab import modal for **CSV *and* PDF**, **three** modes by target: **standalone** (manual target) file → preview (greyed dupes) → confirm; **history backfill** (SimpleFIN target) imports only rows predating the feed's coverage — see the overlap guard in Conventions; **comparison** (Plaid-linked target) read-only reconciliation audit, inserts nothing. Writes via dataAdapter's `createManualAccount`/`importCsvTransactions`; reads Plaid rows via `getAccountTransactionsInRange`. |
| `src/pdfImport.js` | Pure PDF-statement parsing core (no pdf.js/React/Supabase): text runs → lines → columns → **the same cell grid `buildRows` consumes**. Template auto-detect (`autoDetectTemplate`), `applyTemplate`, month-name dates + year inference from the statement period, `normalizeDebitCredit`, `defaultTemplate` (the fallback the modal seeds the editor with). Testable in Node. |
| `src/pdfExtract.js` | The only file that touches pdf.js. Lazy `import()` (keeps ~1.8MB out of the main bundle) of the **legacy** build, bundled locally (no CDN, CSP/offline-safe). Runs the parser on the **main thread** via `globalThis.pdfjsWorker` so `src/pdfPolyfills.js` is in scope for it (a Worker has its own globals). |
| `src/pdfPolyfills.js` | Feature-detected polyfills pdf.js needs on iOS Safari — **`ReadableStream` async iteration** (the load-bearing one; see Gotchas), plus `.at` and `structuredClone` for genuinely old devices. |
| `src/components/PdfTemplateEditor.jsx` | Visual "teach it once" editor: renders the statement from its own text runs, draggable column boundaries, per-column role selectors, live parsed-row count. Saved per account as `pdftpl:<accountId>` in `settings`. |
| `src/plaidClient.js` | Client → api/ fetch wrappers (JWT attached). |
| `src/sync.js` | Single-flight wrapper triggering server sync. |
| `src/db.js` | getSetting/setSetting on the Supabase `settings` table (dashboard prefs: colors, names, custom categories, `asst:model`/`asst:effort`). |
| `src/assistantModels.js` | Shared client+server allowlist of assistant models + cost estimator. |
| `api/_lib/plaid.js` | Credential list parsing + capacity picker. |
| `api/_lib/supabase.js` | Service-role client + `requireUser` (JWT → householdId). |
| `supabase/migrations/` | Ordered SQL migrations (additive-only on live data). |
| `supabase/setup_all.sql` | One-paste fresh install — **DESTRUCTIVE, wipes all tables. Never run on live data. Never re-generate to include new migrations without that warning.** Convenience snapshot only — `migrations/` is the source of truth; ends with a column-level self-check that raises if it drifts behind migrations. |
| `test/` | `npm test` — Node's built-in `node --test`, zero deps. Covers the pure cores only: cashFlow (incl. brute-force max-matching parity), csvImport parsing/dedup-id idempotency, category rules. Run before pushing. |

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

**Local checks** (gitignored; recreate as needed): SQL — local Postgres 16 stub
(create `auth` schema + `auth.users` + `auth.uid()` reading
`request.jwt.claims.sub`, the three roles, publication `supabase_realtime`; run
migrations in order, test triggers/RLS). UI — mock harness: a tiny Vite app
rendering `Dashboard.jsx` with `resolve.alias` **full-match** regexes
(`/^.*\/dataAdapter\.js$/`) swapping dataAdapter/sync/db/plaidClient for mocks;
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
- Amounts follow Plaid: **positive = money out, negative = money in**. SimpleFIN
  is the opposite (positive = money *in*) and its amounts arrive as numeric
  *strings* ("-05.50" is real), so `api/_lib/simplefin.js` parses then negates.
- **SimpleFIN sends no account type/subtype/mask/category.** Type is *inferred
  from the account name* at first insert and is **user-owned thereafter** — the
  sync writes it on INSERT only, and the Accounts tab lets it be corrected
  (that's why the account write splits into insert-new / update-balances). It
  matters because `isCheckingAccount` decides whether an account's outflows
  count as household spending. The type editor is deliberately hidden for Plaid
  accounts: their sync overwrites both columns, so an edit wouldn't survive.
- **Debt balances: stored positive, displayed negative.** `accounts.current_balance`
  is POSITIVE = money owed for `credit`/`loan` (Plaid's convention; SimpleFIN
  reports negative and `normalizeBalance` flips it on the way in, so both feeds
  agree in the database). Every place a balance is shown to a human runs it
  through `displayBalance(balance, type)` (`src/accountBalance.js`), which
  negates debts — a card reads −$5,127.97. Keeping storage positive is what
  keeps payoff amortization and utilization (`current_balance / credit_limit`)
  natural and keeps Plaid and SimpleFIN rows identical; only presentation flips.
  There are exactly four display sites — three in Dashboard.jsx (Overview
  headline, accounts list, account sheet) and the assistant context in
  `api/_lib/spendingContext.js`, which must match or the Ask tab contradicts the
  screen. `fmtX` renders negatives as −$1,234.56.
- Effective category = `user_category || mapped_category` (user override wins).
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
  (`getEarliestTransactionDate` → `overlapFrom` → `isOverlap`). The boundary day
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
- **A card PURCHASE can never be classified as a card payment.** "Transfers and
  card payments" is excluded from spending, so a false positive there deletes
  money from every total silently. Two guards in `src/txClassify.js`: an issuer
  name (CAPITAL ONE / AMEX / DISCOVER…) must co-occur with payment wording, and
  a positive amount on a `credit` account skips the transfer rules entirely — a
  payment arrives as money *in*. Always pass `accountType` to
  `classifyDescription` where it's known. Before this, "Capital One Travel" and
  "Discover Tire and Auto" vanished from the dashboard.
- Plaid sync upserts deliberately OMIT user-owned columns (nickname, color,
  hidden, user_category, user_description, excluded) so edits survive syncs.
- Account labels: `nickname || "name ··mask"`; badge color from `ACCOUNT_COLORS`
  by index when `color` is null.

### Two spending/income models (deliberate — don't "unify" without asking)
- **Purchase-based** (Categories tab, Overview headline, budgets, "vs last
  month" delta): `sumSpending` / `getSpending` count what was *bought* by
  category, excluding Transfers/Return **and every `type === 'loan'` account**
  (a loan debit is a payment, not a purchase, and the cash already counts on its
  way out of checking).
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

## Pending branches

None — `claude/simplefin-build-start-ijj2fa` merged. Both of its migrations
(`20260724000001_simplefin.sql`, `20260728000001_category_rules.sql`) were
pasted into Supabase before the merge and are live.

## Roadmap

**Next: SimpleFIN phase 3** — diff SimpleFIN against Plaid on the joint BECU
accounts, then unhide + retire the Plaid Items bank by bank (spec below; phases
1–2 are **merged**), followed by **phase 4: remove Plaid entirely** — Mason has
decided the end state is SimpleFIN + CSV/PDF import only. **Then: Debt tracker**
— **balance-only + hand-entered APR** under SimpleFIN (spec below). (CSV/PDF
import — the permanent coverage floor for the off-Plaid plan — the
`markInternalTransfers` max-matching fix, and auto-categorization rules
(learned merchant rules) are **shipped**; see Merged features.) Later
(discussed, not committed): net worth over time, cash-flow forecast, savings
goals, CSV/PDF export, sign-out button. **`accounts.available_balance` holds
three conventions** — SimpleFIN's raw feed value when it sends
`available-balance`, the *normalized* balance when it doesn't (`api/sync.js`'s
`?? balance` fallback), and Plaid's "available credit" for cards. Invisible
today (nothing renders it) but it surfaces the moment the Debt view shows
utilization; sort it out then, and never run it through `displayBalance` — for a
card it means available *credit*, not a debt.

### Off-Plaid: SimpleFIN migration — phases 1–2 SHIPPED, phase 3 next
Decision (settled): replace Plaid with **SimpleFIN Bridge** as the bank feed —
~$15/yr flat (no per-product / Item-slot billing), read-only, daily refresh,
**serverless-friendly (no daemon)**. Coverage verified for all household
institutions incl. NewRez / Launch / Jenius. The plan is capped at
**SimpleFIN + CSV import + (optional) email-alert cron**.

Phases: 1. **CSV import** — permanent coverage floor. **SHIPPED** (Merged
features). 2. **SimpleFIN alongside Plaid** — **SHIPPED** (Merged features).
3. **Diff, then migrate bank by bank** ← *next*. 4. **Remove Plaid** code paths
and `PLAID_*` env once nothing depends on them, then rewrite the Architecture
feed bullets → SimpleFIN only. Mason has **decided** phase 4 happens: the end
state is SimpleFIN + CSV/PDF import, no Plaid.

**Phase 3 — what's left.** Connect at Accounts → ⚡ SimpleFIN. Accounts land
hidden, so nothing moves until they're checked. For each bank: (a) confirm the
inferred account **type/subtype** in the account sheet — a card typed as
checking would turn its purchases into household spending; (b) compare the
SimpleFIN account's transactions against the Plaid copy for the same month —
count, amounts, **signs**, dates, categories; (c) unhide the SimpleFIN account
and unlink the Plaid institution in the same sitting (never leave both visible —
that's the double count). Things the diff is specifically there to catch:
**date drift** (SimpleFIN gives an epoch, converted in UTC — an evening
transaction can land a day later and cross a month boundary) and the
**debt-balance sign** (below). Then rebuild `getOverview`'s expectations if the
credit/depository header list looks wrong.

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
- Only institutions holding a `plaid_tokens` row consume a Plaid Item slot.
  `create-link-token` counts those, not all institutions — the manual "Imported"
  institution and every SimpleFIN org also carry the `plaid_credential_key`
  default of 'main' and would otherwise burn phantom capacity.
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
