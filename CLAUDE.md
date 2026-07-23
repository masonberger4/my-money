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
- **Plaid** is the bank-data source (a custom scraper was designed then
  abandoned — hence scraper-era names like the original `synthetic_id` column,
  now `plaid_tx_id`).
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
  can INSERT/update/delete its own rows directly**. `plaid_tokens` has ZERO
  client policies — only service_role (api/) reads them. Never expose them.
- **Sync is server-side** (`api/sync.js`): cursor-based transactionsSync per
  institution; upserts accounts (onConflict `institution_id,plaid_account_id`)
  and transactions (onConflict `account_id,plaid_tx_id`); `needs_reauth` on
  ITEM_LOGIN_REQUIRED. Only `depository`+`credit` account types are synced.

## Key files

| File | Role |
|---|---|
| `src/components/Dashboard.jsx` | Almost the entire UI — single file, inline styles, tabs: overview/categories/transactions/accounts/trends/recurring/ask. Shared mini-components: `Pill`, `Swatch`, `EditName`, `Sk` (skeleton), `Donut`. |
| `src/dataAdapter.js` | All Supabase reads + shapes consumed by Dashboard; the Trends cash-flow model lives here (see Conventions). Keep return shapes stable. Also holds the CSV-import writes (`findOrCreateManualInstitution`, `createManualAccount`, `getExistingTxIds`, `importCsvTransactions`, `isManualAccount`), the comparison-mode read `getAccountTransactionsInRange`, and exports the cash-flow helpers (`markInternalTransfers`/`cashIncome`/`cashSpending`) for the dry-run harness. |
| `src/categoryMap.js` | Plaid category → app category mapping; `applyAccountRules` (credit-card negatives → "Return", excluded from income); pure JS, imported by server code too. `ERA_CATEGORIES` is the taxonomy source of truth (no "Housing"/"Income" member). |
| `src/csvImport.js` | Pure CSV-import core (no React/Supabase): `parseCsv`, `detectHeader`, `parseMoney`/`parseDate`, `guessCategory` (validated against `ERA_CATEGORIES`), transfer flagging, dedup `plaid_tx_id` hashing, `buildRows`/`analyzeCsv`. Also the comparison-mode core: `reconcileCsv` (max-matching audit), `descSimilarity`, `csvDateRange`. Testable in isolation. |
| `src/components/CsvImport.jsx` | Accounts-tab import modal, two modes by target: **standalone** (manual target) file → preview (greyed dupes) → confirm; **comparison** (Plaid-linked target) read-only reconciliation audit, inserts nothing. Writes via dataAdapter's `createManualAccount`/`importCsvTransactions`; reads Plaid rows via `getAccountTransactionsInRange`. |
| `src/plaidClient.js` | Client → api/ fetch wrappers (JWT attached). |
| `src/sync.js` | Single-flight wrapper triggering server sync. |
| `src/db.js` | getSetting/setSetting on the Supabase `settings` table (dashboard prefs: colors, names, custom categories, `asst:model`/`asst:effort`). |
| `src/assistantModels.js` | Shared client+server allowlist of assistant models + cost estimator. |
| `api/_lib/plaid.js` | Credential list parsing + capacity picker. |
| `api/_lib/supabase.js` | Service-role client + `requireUser` (JWT → householdId). |
| `supabase/migrations/` | Ordered SQL migrations (additive-only on live data). |
| `supabase/setup_all.sql` | One-paste fresh install — **DESTRUCTIVE, wipes all tables. Never run on live data. Never re-generate to include new migrations without that warning.** |

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
390×844). Screenshot new UI before pushing. Build:
`VITE_SUPABASE_URL=https://placeholder.supabase.co VITE_SUPABASE_ANON_KEY=placeholder npm run build`.

## Conventions

- Dashboard style: compact inline-styled JSX, CSS vars (--bg, --card, --text,
  --muted, --border), dark mode via prefers-color-scheme, accent #7F77DD.
  Mobile-first: verify at 390px; tab bar scrolls horizontally.
- Amounts follow Plaid: **positive = money out, negative = money in**.
- Effective category = `user_category || mapped_category` (user override wins).
- "Transfers and card payments" and "Return" (credit-card negatives) are never
  counted as spending; "Return" is never counted as income.
- Plaid sync upserts deliberately OMIT user-owned columns (nickname, color,
  hidden, user_category, user_description, excluded) so edits survive syncs.
- Account labels: `nickname || "name ··mask"`; badge color from `ACCOUNT_COLORS`
  by index when `color` is null.

### Two spending/income models (deliberate — don't "unify" without asking)
- **Purchase-based** (Categories tab, Overview headline, budgets, "vs last
  month" delta): `sumSpending` / `getSpending` count what was *bought* by
  category, excluding Transfers/Return.
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
  `api/_lib/spendingContext.js`), read-only, model/effort selectable.
- **Trends joint-budget cash-flow + Cash flow section** (see Conventions).

## Pending branches

- **`claude/csv-import-phase-1-ntq19j`** — CSV import, **both modes built**
  (branch name predates Phase 2). Accounts-tab action → pick a bank CSV (BECU
  preset) → pick a target account:
  - **Standalone** (new/existing manual target) → real transactions on a manual
    (non-Plaid) account.
  - **Comparison** (Plaid-linked target) → read-only reconciliation audit,
    inserts NOTHING (sync gaps / pending-timing / amount·date·category
    mismatches).
  Adds migration `20260722000001_csv_import.sql` (`accounts.is_manual`,
  `transactions.source` — both additive `not null default`; the importer
  degrades gracefully if they're absent so previews work before the SQL lands).
  New `src/csvImport.js` (pure core, incl. `reconcileCsv` max-matching) +
  `src/components/CsvImport.jsx` (modal). No cash-flow code change — imported
  depository rows flow through `getCashFlow` automatically (verified). Awaiting
  Mason's preview review + "merge csv-import". **Migration must be pasted before
  preview DB writes work.**

## Roadmap

**CSV import** — **both modes (standalone + comparison) built on
`claude/csv-import-phase-1-ntq19j`** (see Pending; awaiting merge). The build
spec below is retained as the as-built contract. Later (discussed, not committed):
net worth / debt-payoff tracker, auto-categorization rules, cash-flow forecast,
savings goals, CSV/PDF export, sign-out button. **`markInternalTransfers`
max-matching** — the current greedy nearest-gap matcher can strand one of two
interleaved equal-amount transfer pairs whose legs drift across the 4-day
window, leaving a genuine internal transfer counted (inflates Trends
`cashIncome` AND `cashSpending` by the same amount, so monthly **net** is
unaffected). Pre-existing, but CSV import's cross-bank personal↔joint legs (which
drift 1–3 days) make it more reachable — replace with earliest-unused-in
ordering or a small bipartite max-matching. (Surfaced by the Phase-1 adversarial
pass; deliberately NOT changed there — cash-flow model changes are out of that
scope.)

### CSV import — build spec
Goal: upload a bank CSV → reconcile against the household's real accounts. Two
**modes**, auto-selected by whether the target account is Plaid-linked:
- **Standalone** (target NOT linked — the personal accounts: Mason's checking,
  wife's checking + savings): create a manual account + real `transactions` so
  they flow into Transactions/Categories/Search/Assistant/Trends with no
  downstream special-casing (the transactions table is adapter-agnostic — the
  whole reason the old `synthetic_id` existed). **Primary value** — makes the
  un-synced personal-account paychecks visible. **BUILT** — see
  `src/csvImport.js` + `src/components/CsvImport.jsx`; the notes below record the
  as-built contract. Selecting a Plaid-linked target switches to comparison mode.
- **Comparison** (target IS Plaid-linked — the joint accounts): reconcile the
  CSV against what Plaid already synced; insert NOTHING (that's the double-count
  trap). Emit an audit — rows in CSV but not Plaid (sync gaps), rows in Plaid
  but not CSV (pending/timing), amount/date/category mismatches on matched
  pairs. Auto-detecting linkage is what makes this safe (turns the old "don't
  import a synced account" footgun into a feature). **BUILT** — `reconcileCsv`
  in `src/csvImport.js`: match on **exact amount + date within ±4 days**
  (description optional — Plaid rewrites it), a **maximum bipartite matching**
  (Kuhn's) so equal-amount clusters pair up fully with no greedy stranding
  (closest-date then description-similarity tie-breakers); a conservative 2nd
  pass pairs leftovers by strong description similarity (Jaccard ≥ 0.6) + window
  to surface likely same-txn **amount** discrepancies (misses are OK, false
  pairings that hide a gap are not). Plaid rows are fetched over the CSV's date
  span ± 7 days (`getAccountTransactionsInRange`). UI: four buckets + per-match
  date/category flags; `Close (nothing imported)`.

Feasibility (verified against schema + api/):
- **Client-side is sufficient.** The `*_all` RLS policies (`for all … with
  check (household_id = current_household_id())`) let the authenticated client
  INSERT into `institutions`/`accounts`/`transactions`; the WITH CHECK passes
  because `household_id` defaults to `current_household_id()` (resolves from the
  client — NOT in the SQL Editor, where `auth.uid()` is NULL). No new api/
  endpoint or policy required. A service-role `api/import-csv.js` is optional
  (only for server-side validation).
- **Sync won't clobber manual data.** `api/sync.js` only processes institutions
  that have a `plaid_tokens` row; a manual institution has none → skipped. This
  (not any flag) is what keeps manual data safe.

Data model (standalone mode — comparison mode inserts nothing):
- **Manual institution**, one per household. NOTE `institutions.adapter_id` was
  DROPPED in migration 2 — do NOT set it. Create with just `name='Imported'`
  (`plaid_credential_key` defaults to 'main'); find-or-create by `name` (or the
  `is_manual` flag below) so repeat imports don't spawn duplicates.
- **Manual account** per imported account: `type='depository'`,
  `subtype='checking'|'savings'`, synthetic `plaid_account_id='manual:'+uuid`
  (satisfies unique `institution_id,plaid_account_id`). `name` user-supplied;
  `mask`/balances nullable.
- **Transaction rows** — mirror `api/sync.js` `mapTransactionRow` for the exact
  insert contract (NOT NULL: `description` — the descriptor, Plaid's `name` maps
  here — plus `date`, `amount`, `account_id`, `plaid_tx_id`; `merchant_name`/
  `raw_category`/`pending` optional). Set:
  - `amount` — **sign flip.** BECU has separate Debit/Credit columns (positive
    magnitudes; strip $/commas; dates M/D/YYYY → ISO). Build
    `csvSignedValue = Credit − Debit` (positive = money in), then
    `amount = −csvSignedValue` (= Debit − Credit), matching the app's
    positive = out convention.
  - `mapped_category` — the FINAL app-category string. dataAdapter reads the
    stored `mapped_category` (`effectiveCategory = user_category ||
    mapped_category`); mapping happens at WRITE time, so set the resolved string
    here, NOT a raw Plaid code. Valid strings + the exact "Transfers and card
    payments" label are in `src/categoryMap.js` `ERA_CATEGORIES` (source of
    truth); unmatched rows → "Shopping and gear" (the effectiveCategory
    fallback). `guessCategory` is a small keyword map, **validated against
    `ERA_CATEGORIES` at module load** so it can't emit an invalid label, editable
    later. NOTE the taxonomy has **no** "Housing"/"Income" member: a mortgage
    (NEWREZ/SHELLPOINT) maps to **"Utilities"** (consistent with how Plaid's
    RENT_AND_UTILITIES already resolves); income/benefit lines (WA ST EMPLOY SEC,
    PAYROLL) are money-in so their category is cosmetic → **"Cash, checks, and
    misc"**; card issuers → "Transfers and card payments". Never emits "Return"
    (that's `applyAccountRules`, credit-only).
  - `raw_category` — set `'TRANSFER_IN'|'TRANSFER_OUT'` for "Online Banking
    Transfer To/from" lines so `markInternalTransfers` washes them; `''`
    otherwise (nothing requires it non-null).
  - `plaid_tx_id` — `'csv:'+hash(date, amount, normalized_desc)` plus a per-day
    occurrence ordinal ONLY to disambiguate genuinely identical
    date/amount/desc rows. Do NOT include the absolute file row-index (it shifts
    on the next export → same txn re-hashes → breaks the idempotent re-import).
    Upsert onConflict `account_id,plaid_tx_id`.

Trends impact — **no new field, `full` whole-household** (decided). Import a
personal account as an ordinary `depository` account (checking/savings) and
`getCashFlow` handles it automatically: inflows count as income, checking
outflows as spending, and personal↔joint transfers now WASH because both legs
exist (the CSV personal leg + the Plaid joint leg — `markInternalTransfers`
matches across sources, since it only cares about account type/amount/date).
Net: Trends becomes the true **whole-household** view — income = real paychecks
+ UI benefits, spending = all real bills, the personal→joint funding shuffle
cancels out. (Why `full` not income-only: income-only double-counts paychecks
unless you wash the transfers, and once washed you're already at full — so the
role field is unnecessary.) Two consequences: it **retroactively recomputes past
Trends months** (personal→joint transfers that currently inflate income get
replaced by real paychecks — the correction, not a regression), and import
**all** the personal accounts for a consistent picture, not just one.

Schema adds — **shipped** in `migration 20260722000001_csv_import.sql`:
`accounts.is_manual boolean not null default false` (UI "Imported" badge +
belt-and-suspenders sync-skip) and `transactions.source text not null default
'plaid'` (`'csv'` for a future undo/filter — nothing reads it yet). Both are
additive metadata-only adds (constant defaults → no table rewrite). The importer
**degrades gracefully** if they're absent (tries the column, drops it on a
"column not found" error and remembers) so previews work before the SQL is
pasted; the real sync-skip protection is the manual institution having no
`plaid_tokens` **and** `status='disabled'` (api/sync.js filters both). No
`cash_flow_role` — `full` is just the default type/subtype behavior.

UI: an action on the **Accounts tab** (file picker; don't add a bottom tab) →
pick the target account (**existing Plaid-linked → comparison mode; new/existing
manual → standalone mode**) → auto-detect the BECU header (may follow a
preamble; dates M/D/YYYY → ISO) or map columns → preview (standalone: dupes
greyed via the plaid_tx_id hash, guessed category, detected internal transfers;
comparison: the match/gap/mismatch audit) → confirm.

Caveats: per-bank formats differ (BECU preset first); no stable bank IDs (hash
dedup; prompt on identical rows); CSV is a manual periodic export (stale vs live
sync). The old double-count risk is handled by comparison mode auto-detecting a
linked target.

## Gotchas

- Supabase SQL Editor runs as service_role: `auth.uid()` is NULL, so
  `household_id` defaults DON'T resolve — admin inserts there must set it
  explicitly. (Client inserts are fine — `auth.uid()` resolves.)
- Vercel `VITE_*` vars are baked at BUILD time — changing them needs a redeploy
  (check Production AND Preview). Missing client config renders the
  ConfigErrorScreen (App.jsx), not white.
- The empty-institution count-query error must NOT fall back to the "connect
  your first account" screen (see App.jsx count handling).
- iOS PWA: apple-touch-icon must be PNG; service worker (`public/sw.js`) never
  caches `/api/*`; bump its CACHE_VERSION when changing it.
- One Claude session per line of work, branched from current main — two sessions
  off different bases once regressed production (the "iphone-app" incident).
- If pushes stop deploying and GitHub API calls 503, check githubstatus.com
  before debugging webhooks/Vercel — GitHub-side outages happen.
