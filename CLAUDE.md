# my-money — project memory

Household spending dashboard for two users (Mason + wife), shared login,
viewed on laptop + iPhones (PWA). Personal project; pragmatic > enterprise.

**Maintain this file.** Whenever a session settles an architecture decision,
changes the workflow, adds/merges a feature branch, learns a new gotcha, or
reverses anything written here, update this file in the same commit or PR as
the change — don't leave decisions stranded in conversation. Keep the
"Pending branches" and "Roadmap" sections current as branches merge. Mason
shouldn't have to ask.

## Architecture (decided, don't relitigate)

- **Cloud-first**: Supabase Postgres is the single source of truth. No local
  cache, no IndexedDB (Dexie was removed — don't reintroduce it).
- **React + Vite SPA** deployed on **Vercel**; thin serverless functions in
  `api/` hold all secrets. Client talks to Supabase directly for reads/writes
  (RLS-scoped) and to `api/` for anything involving Plaid or service secrets.
- **Plaid** is the bank-data source (a custom scraper was designed and
  explicitly abandoned — see git history if curious).
- **Multi-Plaid-credential support**: `PLAID_CREDENTIALS` env var is a JSON
  list of {key, client_id, secret}. Link-token creation picks the first
  credential with < 10 Items; each institution row records its
  `plaid_credential_key`. Legacy `PLAID_CLIENT_ID`/`PLAID_SECRET` fall back as
  key "main".
- **Auth**: one shared Supabase Auth user (email+password) for the household.
  `household_members` maps user → household; `current_household_id()` +
  RLS policies scope every table. `api/` routes verify the JWT via
  `requireUser()` (`api/_lib/supabase.js`).
- **Plaid access tokens** live in `plaid_tokens` — RLS enabled, ZERO client
  policies; only service_role (the api/ routes) can read. Never expose them.
- **Sync is server-side** (`api/sync.js`): cursor-based transactionsSync per
  institution, upserts accounts/transactions, `needs_reauth` on
  ITEM_LOGIN_REQUIRED.

## Key files

| File | Role |
|---|---|
| `src/components/Dashboard.jsx` | Almost the entire UI — single file, inline styles, tabs: overview/categories/transactions/accounts/trends. Shared mini-components: `Pill`, `Swatch`, `EditName`, `Sk` (skeleton), `Donut`. |
| `src/dataAdapter.js` | All Supabase reads + shapes consumed by Dashboard. Keep return shapes stable. |
| `src/categoryMap.js` | Plaid category → app category mapping; `applyAccountRules` (credit-card negatives → "Return", excluded from income); pure JS, imported by server code too. |
| `src/plaidClient.js` | Client → api/ fetch wrappers (JWT attached). |
| `src/sync.js` | Single-flight wrapper triggering server sync. |
| `src/db.js` | getSetting/setSetting on the Supabase `settings` table (dashboard prefs: colors, names, custom categories). |
| `api/_lib/plaid.js` | Credential list parsing + capacity picker. |
| `api/_lib/supabase.js` | Service-role client + requireUser (JWT → householdId). |
| `supabase/migrations/` | Ordered SQL migrations. |
| `supabase/setup_all.sql` | One-paste fresh install — **DESTRUCTIVE, wipes all tables. Never run on live data. Never re-generate it to include new migrations without that warning.** |

## Development workflow (agreed with Mason)

1. `main` is the trunk and **Vercel's production branch** — pushes to main
   auto-deploy to production (`my-money-smoky.vercel.app`).
2. Features go on `claude/feature-<name>` branches cut from main. Pushes get
   Vercel Preview deployments (preview URLs require Mason's Vercel login).
3. Mason reviews the preview, then says "merge <feature>" → merge to main.
4. **Migrations are additive-only** on live data (`alter table ... add
   column`). Hand Mason the exact SQL to paste in the Supabase SQL Editor at
   merge time. Test migrations locally first (see below).
5. Don't create PRs unless asked. Delete branches after merge (GitHub
   auto-delete may be enabled).

### Local verification patterns (used throughout; recreate as needed)

- **SQL**: local Postgres 16 is available (`sudo -u postgres pg_ctlcluster 16
  main start`). Stub Supabase: create `auth` schema + `auth.users` +
  `auth.uid()` reading `request.jwt.claims.sub`, roles
  authenticated/anon/service_role, publication supabase_realtime. Then run
  migrations in order and test triggers/RLS.
- **UI**: mock harness at `.claude/mockapp/` (gitignored) — a tiny Vite app
  that renders `Dashboard.jsx` with `resolve.alias` regex entries replacing
  `dataAdapter.js`, `sync.js`, `db.js`, `plaidClient.js` with mocks. Serve on
  :5199, screenshot with playwright-core (`executablePath:
  '/opt/pw-browsers/chromium'`, viewport 390×844). Always screenshot new UI
  before pushing.
- **Build check**: `VITE_SUPABASE_URL=https://placeholder.supabase.co
  VITE_SUPABASE_ANON_KEY=placeholder npm run build`.

## Conventions

- Dashboard style: compact inline-styled JSX, CSS vars (--bg, --card, --text,
  --muted, --border), dark mode via prefers-color-scheme. Accent #7F77DD.
- Amounts follow Plaid: **positive = money out, negative = money in**.
- Effective category = `user_category || mapped_category` (user override
  wins; `user_category`/`excluded`/`user_description` exist only on the
  transaction-editing branch until merged).
- "Transfers and card payments" and "Return" are never counted as spending;
  "Return" (credit-card negatives) never counted as income.
- Account labels: `nickname || "name ··mask"`; account badge colors from
  `ACCOUNT_COLORS` palette by index when `color` is null.
- Plaid sync upserts deliberately omit user-owned columns (nickname, color,
  hidden, user_category, user_description, excluded) so edits survive syncs.
- Mobile first: verify at 390px width; tab bar scrolls horizontally.

## Merged features (live on main)

- **Transaction editing** — tap transaction → detail sheet: recategorize
  (`user_category`), exclude from totals (`excluded`), rename
  (`user_description`), masked-descriptor fallback ("****" → "Card
  transaction"). Columns live on `transactions`.
- **Budgets** — per-category monthly limits on the Categories tab: progress
  bars (category color / #FAC775 / #D85A30 at <80 / 80–100 / >100%), inline
  "＋ budget" editor per row (empty = clear), zero-spend budgeted categories
  still listed, budgeted-vs-spent summary strip. `budgets` table + RLS;
  `getBudgets()` / `setBudget(category, limit)`.
- **Recurring** — "Recurring" tab: client-side subscription detection.
  `src/recurring.js` (pure: normalized-merchant grouping, ≥3 charges,
  median gap 28±4 days, amounts within ±20%); `getRecurringCandidates()`
  fetches 6 months. Lazy-computed on first tab open, recomputed after sync.
  No schema.
- **Search** — cross-month search box atop the Transactions tab (debounced
  300ms, min 2 chars, stale-response guard). `searchTransactions()` runs a
  Supabase `ilike` over description/merchant/user_description (wildcards
  escaped, `.or()`-unsafe chars stripped), newest-first, 200-match cap.
  No schema.
- **Assistant** — "Ask" tab: Claude-powered spending Q&A. `api/assistant.js`
  (claude-opus-4-8, adaptive thinking, prompt-cached context block) +
  `api/_lib/spendingContext.js` (deterministic 90-day snapshot). Read-only
  by design; conversations not persisted. **Requires `ANTHROPIC_API_KEY` in
  Vercel** — without it the tab shows an "assistant not configured" message.

## Pending branches (awaiting Mason's review)

_(none — all roadmap features merged)_
## Roadmap (agreed order + design notes)

1. **Budgets** — ✅ merged (see Merged features above).
2. **Recurring/subscription detection** — ✅ merged (see Merged features above).
3. **Transaction search** — ✅ merged (see Merged features above).
4. Later ideas (discussed, not committed): CSV export, net worth (needs
   Plaid Investments/Liabilities products — check per-call cost first),
   savings rate stat, notes/tags on transactions, sign-out button.

## Gotchas (learned the hard way)

- Supabase SQL Editor runs as service_role: `auth.uid()` is NULL, so
  `household_id` defaults DON'T resolve — admin inserts must set it
  explicitly.
- Vercel env vars: `VITE_*` are baked at BUILD time; adding/changing them
  requires a redeploy. Check Production AND Preview checkboxes. Missing
  client config renders the ConfigErrorScreen (App.jsx) instead of white.
- Preview deployments share the production Supabase database — migrations
  must land before previewing schema-dependent branches; edits made in
  previews are real.
- The empty-institution count query error must NOT fall back to the
  "connect your first account" screen (see App.jsx count handling).
- iOS PWA: apple-touch-icon must be PNG; service worker (`public/sw.js`)
  never caches `/api/*`; bump its CACHE_VERSION when changing it.
- One Claude session per line of work, branched from current main — two
  sessions once forked the app from different bases and production regressed
  (the "iphone-app branch" incident, since merged).
- GitHub outages happen: if pushes stop deploying and API calls 503,
  check githubstatus.com before debugging webhooks.
- This sandbox's git relay can push to branches but CANNOT delete remote
  branches; GitHub MCP tools may disconnect/reconnect — retry or fall back
  to asking Mason to click it in the UI.
