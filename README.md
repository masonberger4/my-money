# Personal Finance App

A self-hosted, private personal finance dashboard. Connects to your financial accounts — checking, savings, credit cards, loans, mortgages — via SimpleFIN, with CSV/PDF statement import for anything a feed can't reach. All data lives in the household's own Supabase Postgres (cloud-first, no local cache). No subscriptions. Your data stays yours.

---

## Background

This project started as a spending dashboard built on top of Era Context (a financial data MCP) connected to a Capital One Venture X card. We built:

- Monthly spending breakdown by category with a donut chart
- Category bar chart with percentages
- Recent transactions list with merchant, date, and category
- 4-month cash flow and income vs. spending trends
- Month navigation (‹ ›) to browse any month of history
- Click-through from trends bar chart to that month's detail
- **Color picker per category** — click the swatch to change it, persists across sessions
- **Inline category renaming** — double-click any category name to edit it
- **Custom categories** — add your own with name and color via a modal
- **All customizations persist** via artifact storage (now the Supabase `settings` table in the full app)

During that process we also:
- Recategorized Costco from "Shopping and gear" → "Groceries" across 8 transactions
- Broke down the "Shopping and gear" category by merchant type (Sabai Design = furniture, Everlane = clothing, Target = department store, etc.)
- Identified a one-time $2,951 Sabai Design furniture purchase that was inflating the category

### Why we're moving off Era

Era charges a subscription to sit between you and your banks. Building directly on a bank feed + Vercel replicates everything Era provides for ~$15/yr, and means we own the full stack and all the data. Era's historical data should be exported before canceling.

---

## Architecture

```
[Browser — laptop or either phone, signed in with the shared household login]
   │
   ├── reads data directly from Supabase (RLS-scoped to the household)
   │
   └── Vercel serverless functions  (/api/*)
         │   verify the caller's Supabase JWT
         │   hold the SimpleFIN + Supabase service secrets
         │
         ├── Supabase Postgres (canonical store)
         │     ├── households / household_members
         │     ├── institutions      (one per SimpleFIN org, + the manual
         │     │                      "Imported" one)
         │     ├── simplefin_access  (the access URL — it embeds bank
         │     │                      credentials; service-role only, never
         │     │                      readable from a browser)
         │     ├── accounts          (balances, types)
         │     ├── transactions      (full history, upserted by plaid_tx_id)
         │     ├── category_rules    (learned merchant → category)
         │     └── settings          (category colors, names, custom categories)
         │
         └── SimpleFIN Bridge
               │
               └── Banks: Capital One, Chase, BECU, NewRez, etc.
```

**Key decisions:**

- **Cloud-first**: Supabase Postgres is the single source of truth so the same data shows on the laptop and both phones. IndexedDB/Dexie was dropped.
- **The SimpleFIN access URL never reaches the browser.** It embeds HTTP Basic credentials for every linked bank, and lives in `simplefin_access` — RLS enabled, zero client policies, readable only by the serverless functions.
- **Sync runs server-side** (`api/sync.js`): one pull per access URL (one URL covers every bank), upserted into Supabase. Incremental via a `last_pulled_at` watermark minus a 30-day overlap, throttled to one pull an hour.
- **One shared household login** (email + password via Supabase Auth). All data is scoped to the household by row-level security.
- **`transactions.plaid_tx_id` / `accounts.plaid_account_id` are historical names, not Plaid columns.** They hold every source's external id (`sfin:`, `csv:`, `manual:`) and are the upsert conflict targets. Plaid itself was removed; these stayed.

---

## Tech stack

| Layer | Tool | Why |
|---|---|---|
| Bank connections | SimpleFIN Bridge | ~$15/yr flat, read-only, no per-connection billing, and serverless-friendly (no daemon). Replaced Plaid, whose per-Item pricing was the reason to move. |
| Backend / hosting | Vercel (Hobby tier) | Free, serverless functions in `/api/`, deploys from GitHub |
| Database + auth | Supabase (free tier) | Postgres with row-level security, shared household login, multi-device |
| Frontend | React + Vite | Carries forward the existing dashboard; fast dev experience |
| Charts | Hand-rolled inline SVG (incl. the `Donut` component) | No chart library — small, styleable, no bundle weight |
| Bank auth UI | none — a pasted setup token | SimpleFIN has no SDK: you link banks on Bridge's own site and paste the token it prints. One less dependency in the bundle. |
| Statement import | Hand-rolled CSV + PDF parsing (`pdfjs-dist`) | The coverage floor for banks a feed can't reach, and the way to recover history older than the feed provides |

---

## Account types supported

| Type | Where it comes from | What we show |
|---|---|---|
| Checking / savings | Transactions | Balance, transaction history, income detection |
| Credit cards | Transactions | Balance, transaction history |
| Loans / mortgages | Transactions | Balance (APR / minimum payment / payoff projection is the planned Debt tracker — see CLAUDE.md Roadmap) |

Only `depository`, `credit`, and `loan` account types are synced — no investments support. A **net worth view** (assets minus liabilities, computed from Supabase) is a possible later feature, not built.

---

## What a refresh looks like

1. User hits **Refresh** in the dashboard
2. Frontend POSTs `/api/sync` with the household JWT
3. The server reads the stored access URL, splits its embedded credentials into
   an `Authorization` header (Node's `fetch` refuses a URL containing
   credentials), and GETs `/accounts` — one request covering every linked bank,
   with no cursor and no pagination
4. The response fans out into institutions (one per SimpleFIN org), accounts and
   transactions, all upserted idempotently
5. Dashboard re-reads from Supabase and re-renders

Every request is clamped to ~88 days (`SIMPLEFIN_MAX_LOOKBACK_DAYS`), because
SimpleFIN serves at most 90 days per call and reports a longer request as a
"date range was capped" notice in the response body. `SIMPLEFIN_FIRST_PULL_DAYS`
(730) stays the reach we'd *like* on a first pull; the gap between the two is
reported as a `coverage_shortfall` rather than silently dropped, and CSV/PDF
statement import is how anything older gets in. The cap is SimpleFIN's, not the
banks'. Later pulls start from the last successful pull minus a 30-day overlap,
and are throttled to one an hour — SimpleFIN refreshes about daily, so more
often would just re-fetch the same rows.

---

## Linking a new account

1. User clicks **⚡ Connect with SimpleFIN** (Accounts tab, the empty state, or
   the floating button)
2. They open **SimpleFIN Bridge**, link their banks there, and press *Create
   Setup Token*
3. They paste that token into the modal
4. `/api/simplefin-claim` base64-decodes it to a single-use claim URL and POSTs
   it; the response body is the durable access URL, stored server-side. The
   browser never sees it.
5. A first sync runs immediately

**New accounts arrive hidden.** SimpleFIN sends no account type, so it is
inferred from the account name and then owned by you — and the checking/savings
distinction decides whether an account's outflows count as household spending.
Unhiding an account is how you confirm the guess. Check it before you do.

### When a bank isn't supported

Use **⤓ Import statement** instead: a CSV or PDF becomes real transactions on a
manual account. The same importer also backfills history *older* than the feed
reaches, onto a fed account — it will only insert rows dated before the feed's
own coverage begins, because the two id spaces can't dedup against each other.

---

## Carry-forward from Era dashboard

Everything already built was ported in with minimal changes. Storage swapped from `window.storage` (artifact API) to the Supabase `settings` table. Everything else was UI code that transferred directly:

- [x] Month navigation with ‹ › arrows
- [x] Overview tab: donut chart + top categories + recent transactions
- [x] Categories tab: color swatches, inline renaming, custom categories, bar chart
- [x] Transactions tab: full list with category pills
- [x] Trends tab: 6-month bar chart (clickable), income vs. spending comparison
- [x] Summary cards: total spent, balance, month-over-month delta

---

## New views to build

- [x] **Account list**: all linked accounts, grouped by type, with current balances
- [ ] **Net worth**: assets vs. liabilities summary at top, breakdown by account type (discussed, not committed)
- [ ] **Debt tracker**: each loan/mortgage/card with payoff projection and minimum payment tracker (specced in CLAUDE.md Roadmap)
- [ ] **Multi-account filter**: "All accounts" default, filter to one account or one account type

---

## Mobile

The dashboard is responsive from the start (carried from artifact code). Additional polish planned:

- [x] **PWA manifest**: lets you "Add to Home Screen" on iOS/Android — runs full-screen like a native app
- [ ] **Touch targets**: larger swatches and buttons for fat fingers
- [ ] **Swipe to navigate months**: swipe left/right on the month header
- [ ] **Pull to refresh**: standard mobile pattern for syncing

### Install on iPhone

1. Open the deployed URL in **Safari** (not Chrome — only Safari can install PWAs on iOS).
2. Tap the **Share** button.
3. Scroll down and tap **Add to Home Screen**.
4. Confirm — "my-money" now appears on your home screen and launches full-screen with its own icon, no Safari chrome.

The app shell is cached by a service worker, so the home-screen app opens instantly and still launches when offline (the latest cached data renders; new transactions need a network to sync). `/api/*` requests are never cached.

---

## Cost

| Service | Tier | Cost |
|---|---|---|
| SimpleFIN Bridge | Standard | ~$15/year, flat |
| Vercel | Hobby | $0 |
| Domain (optional) | — | ~$0.85/mo |
| Supabase (primary data store) | Free tier | $0 |
| Anthropic API (the Ask tab) | Pay-as-you-go | Only what you spend; the model is selectable |

SimpleFIN charges per *user*, not per connection, so adding banks costs nothing.
That is why the app moved off Plaid, whose free tier capped connections and
whose paid tier billed per Item — the same bank linked twice counted twice.

---

## Build phases

| Phase | Description | Status |
|---|---|---|
| 0 | Era dashboard — spending breakdown, categories, trends, month nav | ✅ Done (as artifact) |
| 1 | Bank feed connected (Plaid originally; now SimpleFIN) | ✅ Done |
| 2 | Project scaffold — Vite, dependencies, folder structure, git | ✅ Done |
| 3 | Vercel serverless functions — link token, exchange, sync | ✅ Done |
| 4 | Supabase schema + server-side sync (replaced the original IndexedDB/Dexie plan) | ✅ Done |
| 5 | Frontend — port Era dashboard, multi-account accounts view | ✅ Done |
| 6 | Deploy to Vercel, environment variables, live URL | ✅ Done |
| 7 | Mobile polish — PWA install | ✅ Done (further polish tracked in Mobile section) |
| 8 | Supabase as the primary store (promoted from optional sync layer) | ✅ Done |

---

## Working approach

Code is written phase by phase on request. Each phase is one conversation turn to avoid burning tokens on code that may need reworking if an earlier phase hits a snag. When stuck, stop and discuss before continuing.
