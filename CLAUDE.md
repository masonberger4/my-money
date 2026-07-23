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
- **Plaid** is the *current* bank-data source (a custom scraper was designed then
  abandoned — hence scraper-era names like the original `synthetic_id` column,
  now `plaid_tx_id`). **Decided: migrating off Plaid to SimpleFIN** (cost — see
  the SimpleFIN migration spec in Roadmap); Plaid stays live until that ships.
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
  ITEM_LOGIN_REQUIRED. Syncs `depository`+`credit`+`loan` account types
  (`ALLOWED_TYPES`); loans carry sparse/no transactions — their debt data comes
  from the Liabilities product (see Debt tracker in Roadmap).

## Key files

| File | Role |
|---|---|
| `src/components/Dashboard.jsx` | Almost the entire UI — single file, inline styles, tabs: overview/categories/transactions/accounts/trends/recurring/ask. Shared mini-components: `Pill`, `Swatch`, `EditName`, `Sk` (skeleton), `Donut`. |
| `src/dataAdapter.js` | All Supabase reads + shapes consumed by Dashboard; the Trends cash-flow model lives here (see Conventions). Keep return shapes stable. |
| `src/categoryMap.js` | Plaid category → app category mapping; `applyAccountRules` (credit-card negatives → "Return", excluded from income); pure JS, imported by server code too. |
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
_(none)_

## Roadmap

**Next: CSV import** — make the un-synced personal-account income visible (spec
below; also the permanent coverage floor for the off-Plaid plan). **Then:
SimpleFIN migration** — replace Plaid as the bank feed (spec below; decided).
**Then: Debt tracker** — now **balance-only + hand-entered APR** under SimpleFIN
(spec below; the `loan` sync fix that unblocks it is already on main). Later
(discussed, not committed): net worth over time, auto-categorization rules,
cash-flow forecast, savings goals, CSV/PDF export, sign-out button.

### CSV import — build spec
Goal: upload a bank CSV → reconcile against the household's real accounts. Two
**modes**, auto-selected by whether the target account is Plaid-linked:
- **Standalone** (target NOT linked — the personal accounts: Mason's checking,
  wife's checking + savings): create a manual account + real `transactions` so
  they flow into Transactions/Categories/Search/Assistant/Trends with no
  downstream special-casing (the transactions table is adapter-agnostic — the
  whole reason the old `synthetic_id` existed). **Primary value** — makes the
  un-synced personal-account paychecks visible. Build FIRST.
- **Comparison** (target IS Plaid-linked — the joint accounts): reconcile the
  CSV against what Plaid already synced; insert NOTHING (that's the double-count
  trap). Emit an audit — rows in CSV but not Plaid (sync gaps), rows in Plaid
  but not CSV (pending/timing), amount/date/category mismatches on matched
  pairs. Auto-detecting linkage is what makes this safe (turns the old "don't
  import a synced account" footgun into a feature). Lower value (joint Plaid
  sync is solid) + needs a fuzzy matcher (exact amount, ±few days, description
  optional — Plaid rewrites descriptions and posted/pending dates drift) → build
  SECOND.

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
    payments" label are in `src/categoryMap.js` (source of truth); unmatched
    rows → "Shopping and gear" (the effectiveCategory fallback). Start a small
    keyword map (NEWREZ→Housing, WA ST EMPLOY SEC→Income, card issuers→"Transfers
    and card payments", …), editable later.
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

Schema adds (additive, both recommended): `accounts.is_manual boolean default
false` (UI badge + find-or-create + sync-skip belt-and-suspenders);
`transactions.source text default 'plaid'` ('csv' for undo/filter). No
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

### Off-Plaid: SimpleFIN migration — build spec
Decision (settled): replace Plaid with **SimpleFIN Bridge** as the primary bank
feed — ~$15/yr flat (no per-product / Item-slot billing), read-only, daily
refresh, **serverless-friendly (no daemon)**. Coverage verified for all
household institutions incl. NewRez / Launch / Jenius. Plan is capped at
**SimpleFIN + CSV import + (optional) email-alert cron**; a home-IP scraper
(Channel C) is a possible LATER build-out, not in scope. Migrate incrementally
alongside Plaid, then retire Plaid.

How SimpleFIN works (**verify against simplefin.org/protocol.md + SimpleFIN
Bridge docs at build** — the details below are the plan, not gospel):
- One-time link: user links banks at SimpleFIN Bridge's hosted page (SimpleFIN /
  MX handle login + MFA — so the dormant `mfa_prompts` back-channel stays unused
  here) → gets a base64 **setup token**. Server decodes it to a claim URL and
  **POSTs once** to exchange it for a durable **access URL** (embeds HTTP Basic
  creds, e.g. `https://user:pass@…/simplefin`).
- Pull: a single authenticated **GET `{access_url}/accounts?start-date=<epoch>`**
  returns ALL linked accounts + transactions as flat JSON — no cursor, no
  pagination, no per-product calls. Refreshes ~once/day; keep ≤24 pulls/day
  (fits the existing 24h rate-limit intent).

Key model change — **one access URL spans ALL institutions** (keyed off SimpleFIN
org + account id), inverting Plaid's one-token-per-institution model:
- Store the single access URL like `plaid_tokens` — **service-role only, ZERO
  client policies** (it contains bank creds). New `simplefin_access` table
  (household_id, access_url) or reuse the tokens table; never expose to client.
- Per SimpleFIN **org** → find-or-create an `institutions` row (by org
  domain/name). Per SimpleFIN **account** → an `accounts` row with
  `plaid_account_id = 'sfin:'+account.id` (reuse the column — adapter-agnostic
  external id; satisfies unique `institution_id,plaid_account_id`).
- Per SimpleFIN **transaction** → `plaid_tx_id = transaction.id` (SimpleFIN ids
  are stable → the dedup key; upsert onConflict `account_id,plaid_tx_id`).

Sync rewrite (`api/sync.js`, stays serverless):
- Replace the `transactionsSync` cursor loop with one GET to the stored access
  URL; drop cursor bookkeeping from `sync_state`. Map the JSON onto the existing
  row shapes (mirror `mapAccountRow` / `mapTransactionRow`).
- **Sign flip (verify).** SimpleFIN `amount` is a signed string where **positive
  = money INTO the account**; the app uses Plaid's opposite (positive = money
  out), so `amount = −simplefinAmount` (same flip as CSV import). Confirm against
  the protocol doc.
- **Balance sign for debts.** Normalize so `current_balance` is positive = owed
  for credit/loan (SimpleFIN may report a card balance negative). `balance-date`
  epoch → ISO.
- **Categorization:** SimpleFIN emits little/no category → set `mapped_category`
  at WRITE time via the keyword→category map (the same one CSV import builds; do
  NOT call `mapPlaidCategory`). Unmatched → "Shopping and gear".

Link flow (`api/`): replace `create-link-token` / `exchange-token` with a
SimpleFIN connect flow — UI sends the user to SimpleFIN Bridge to link banks +
copy the setup token, posts it to an `api/simplefin-claim` route that claims the
access URL (service-role) and stores it. Adding banks later reuses the same
access URL (verify: re-claim vs portal-add).

Debt tracker under SimpleFIN — **balance-only + hand-entered APR** (decided):
SimpleFIN has no Liabilities equivalent, so the Plaid `/liabilities/get` steps in
the Debt-tracker spec are **superseded**. `current_balance` comes from the feed;
`apr` / `minimum_payment` are **hand-entered** (user-owned columns — keep them
OUT of the sync upsert payload so the feed never clobbers them, like
nickname/color). Payoff math runs on the hand-entered rate.

Phased migration (no big-bang):
1. **CSV import first** (already specced) — permanent coverage floor for the
   personal BECU accounts + anything a feed misses.
2. **SimpleFIN alongside Plaid** — diff SimpleFIN vs Plaid on the joint BECU
   accounts to validate the mapping before trusting it.
3. **Migrate institutions to SimpleFIN + retire Plaid Items** incrementally —
   `api/sync.js` already skips institutions with no `plaid_tokens` row, so
   SimpleFIN-fed and Plaid-fed institutions coexist with no flag.
4. Remove Plaid code paths + `PLAID_*` env once nothing depends on them; then
   rewrite the Architecture "Plaid" bullet → SimpleFIN.

OUT (not now): **email-alert cron** (Vercel Cron → `api/` route polling Gmail,
parsing alerts, inserting service-role for minutes-fresh top-ups, reconciled
against the ledger). **Channel C home-IP scraper** — possible later build-out for
any servicer a feed can't cover: runs on a home Pi/NAS (residential IP,
outbound-only to Supabase, `household_id` set explicitly under service_role),
reusing the dormant `pull_jobs` / `mfa_prompts` / `pending_items` schema + the
24h `check_pull_job_constraints` rate limiter; real ToS/lockout risk → scoped
surgically, never the foundation.

Caveats: verify the SimpleFIN protocol (claim flow, JSON shape, sign convention)
against current docs at build; weaker categorization than Plaid (lean on the
keyword map); daily freshness (not real-time — same as Plaid today); $15/yr flat.

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
(`is_manual`, manual institution) is NOT built yet — CSV import ships first. Once
it lands, a manual debt reuses it (`is_manual`, `type='credit'|'loan'`,
hand-entered balance/apr/min). **v1 is Plaid-linked debts only** — which is the
point (the household wants it automatic).

Caveats: Liabilities is a separate Plaid product (billing) with uneven
institution coverage; existing Items need re-linking to gain it; connecting many
debts eats Plaid Item slots (the multi-credential picker handles it). Debt
tracker is the liability half of the future net-worth feature — the
`balance_snapshots` table is shared groundwork.

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
