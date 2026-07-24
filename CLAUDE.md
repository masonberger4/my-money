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
| `src/components/Dashboard.jsx` | Almost the entire UI — single file, inline styles, tabs: overview/categories/transactions/accounts/trends/recurring/ask. Shared mini-components: `Pill`, `Swatch`, `EditName`, `Sk` (skeleton), `Donut`. |
| `src/dataAdapter.js` | All Supabase reads + shapes consumed by Dashboard; the Trends cash-flow model lives here (see Conventions). Keep return shapes stable. Also holds the CSV-import writes (`findOrCreateManualInstitution`, `createManualAccount`, `getExistingTxIds`, `importCsvTransactions`, `isManualAccount`), the comparison-mode read `getAccountTransactionsInRange`, and exports the cash-flow helpers (`markInternalTransfers`/`cashIncome`/`cashSpending`) for the dry-run harness. |
| `src/categoryMap.js` | Plaid category → app category mapping; `applyAccountRules` (credit-card negatives → "Return", excluded from income); pure JS, imported by server code too. `ERA_CATEGORIES` is the taxonomy source of truth (no "Housing"/"Income" member). |
| `src/csvImport.js` | Pure CSV-import core (no React/Supabase): `parseCsv`, `detectHeader`, `parseMoney`/`parseDate`, transfer flagging, dedup `plaid_tx_id` hashing, `buildRows`/`analyzeCsv`. Also the comparison-mode core: `reconcileCsv` (max-matching audit), `descSimilarity`, `csvDateRange`. Testable in isolation. |
| `src/txClassify.js` | The shared descriptor→category rule table + internal-transfer tagging (`guessCategory`, `transferRawCategory`, `classifyDescription`), validated against `ERA_CATEGORIES` at load. Lifted out of `csvImport.js` when SimpleFIN became a second caller: both feeds get a descriptor and no category, so both derive `mapped_category` at WRITE time from this one table. Pure JS — imported by server code too. |
| `api/_lib/simplefin.js` | SimpleFIN protocol layer: setup-token decode, claim POST, access-URL split (creds → Authorization header), the `/accounts` GET, and `normalizeAccountSet` (reads BOTH wire shapes). Also `inferAccountType`, `normalizeBalance`, the sign flip, and the env knobs. Server-only — handles bank credentials. |
| `src/components/SimpleFinConnect.jsx` | Accounts-tab modal replacing Plaid Link: link banks at SimpleFIN Bridge → paste the setup token → claim + first sync. Shows connection status and a disconnect action. |
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
- **CSV import** — Accounts-tab modal, two modes by target account
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

## Pending branches

- `claude/simplefin-build-start-ijj2fa` — **SimpleFIN migration phase 2**
  (SimpleFIN feed alongside Plaid). Migration to paste at merge:
  `supabase/migrations/20260724000001_simplefin.sql` (additive: `simplefin_access`
  table + `institutions.simplefin_org_id`). No new env vars are required —
  `SIMPLEFIN_*` knobs in `.env.example` are all optional. After merge: connect
  at Accounts → ⚡ SimpleFIN, then do the phase-3 diff (below) before unhiding
  anything.

## Roadmap

**Next: SimpleFIN phase 3** — diff SimpleFIN against Plaid on the joint BECU
accounts, then unhide + retire the Plaid Items bank by bank (spec below; phases
1–2 are **built**, pending branch above). **Then: Debt tracker** —
**balance-only + hand-entered APR** under SimpleFIN (spec below; the `loan` sync
fix that unblocks it is already on main). Later (discussed, not committed): net worth over time,
auto-categorization rules, cash-flow forecast, savings goals, CSV/PDF export,
sign-out button. **`markInternalTransfers` max-matching** — the greedy
nearest-gap matcher can strand one of two interleaved equal-amount transfer
pairs whose legs drift across the 4-day window, leaving a genuine internal
transfer counted (inflates Trends `cashIncome` AND `cashSpending` by the same
amount, so monthly **net** is unaffected). CSV import's cross-bank personal↔joint
legs (drift 1–3 days) make it more reachable — replace with earliest-unused-in
ordering or a small bipartite max-matching. (Surfaced by the CSV adversarial
pass; deliberately NOT changed there — cash-flow model changes were out of scope.)

### Off-Plaid: SimpleFIN migration — phases 1–2 BUILT, phase 3 next
Decision (settled): replace Plaid with **SimpleFIN Bridge** as the bank feed —
~$15/yr flat (no per-product / Item-slot billing), read-only, daily refresh,
**serverless-friendly (no daemon)**. Coverage verified for all household
institutions incl. NewRez / Launch / Jenius. The plan is capped at
**SimpleFIN + CSV import + (optional) email-alert cron**.

Phases: 1. **CSV import** — permanent coverage floor. **SHIPPED** (Merged
features). 2. **SimpleFIN alongside Plaid** — **BUILT** (pending branch above).
3. **Diff, then migrate bank by bank** ← *next*. 4. **Remove Plaid** code paths
and `PLAID_*` env once nothing depends on them, then rewrite the Architecture
feed bullets → SimpleFIN only.

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
  next pull. The disabled row is the tombstone that keeps it out.

**OPEN — must be settled against live data:** how SimpleFIN **signs a credit /
loan balance** when money is owed. Nothing in the spec, any client library, or
the demo fixture answers it (the demo only exposes positive deposit accounts).
`normalizeBalance()` currently assumes a negative reported balance means "owed"
and flips it, which gets an overpaid card wrong under either convention;
`api/sync.js` logs the raw feed value next to the stored one for every debt
account so a real card settles it. **The Debt tracker must not trust this until
it's checked.**

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
   outstanding balance (positive = owed). These are **Plaid-owned** (refreshed
   each sync). Optional `liabilities_raw jsonb` to keep overdue/last-payment/YTD
   fields without column sprawl (recommended).
4. **Balance history:** `balance_snapshots (id, account_id, household_id,
   captured_on date, balance numeric, unique(account_id, captured_on))` — same
   RLS shape as other tables. Sync appends a row only when the balance changed
   (≤ one/day; upsert on the unique key) and — running as **service_role** —
   must set `household_id` explicitly (the `current_household_id()` default is
   NULL there; see Gotchas). Powers the debt-over-time chart AND seeds net worth.
5. **`src/debtPayoff.js`** (pure, like `recurring.js`): month-by-month
   amortization from `current_balance` + `apr` + `minimum_payment`; **snowball**
   (smallest balance first) vs **avalanche** (highest APR first) vs extra-$/mo
   what-if → debt-free date, total interest, interest saved.
6. **`getDebts()` in dataAdapter:** accounts where `type in ('credit','loan')`
   with the liability fields + computed totals (total debt, total minimums).
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
but `sumSpending`/`getSpending` have NO type filter, so guard `type === 'loan'`
specifically if any loan-account transactions appear — never guard out `credit`,
whose *purchases* must still count. Card *payments* from checking stay transfers.

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
- Only institutions holding a `plaid_tokens` row consume a Plaid Item slot.
  `create-link-token` counts those, not all institutions — the manual "Imported"
  institution and every SimpleFIN org also carry the `plaid_credential_key`
  default of 'main' and would otherwise burn phantom capacity.
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
- One Claude session per line of work, branched from current main — two sessions
  off different bases once regressed production (the "iphone-app" incident).
- If pushes stop deploying and GitHub API calls 503, check githubstatus.com
  before debugging webhooks/Vercel — GitHub-side outages happen.
