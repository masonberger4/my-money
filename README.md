# Personal Finance App

A self-hosted, private personal finance dashboard. Connects to all your financial accounts — checking, savings, credit cards, 401k, brokerage, loans, mortgages — via Plaid. All data is cached locally on your device. No subscriptions. Your data stays yours.

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
- **All customizations persist** via artifact storage (migrating to IndexedDB in the full app)

During that process we also:
- Recategorized Costco from "Shopping and gear" → "Groceries" across 8 transactions
- Broke down the "Shopping and gear" category by merchant type (Sabai Design = furniture, Everlane = clothing, Target = department store, etc.)
- Identified a one-time $2,951 Sabai Design furniture purchase that was inflating the category

### Why we're moving off Era

Era connects to Plaid under the hood and charges a subscription to sit in the middle. Building directly on Plaid + Vercel replicates everything Era provides, costs nothing ongoing, and means we own the full stack and all the data. Era's historical data should be exported before canceling.

---

## Architecture

```
[Browser — laptop or either phone, signed in with the shared household login]
   │
   ├── reads data directly from Supabase (RLS-scoped to the household)
   │
   └── Vercel serverless functions  (/api/*)
         │   verify the caller's Supabase JWT
         │   hold the Plaid + Supabase service secrets
         │
         ├── Supabase Postgres (canonical store)
         │     ├── households / household_members
         │     ├── institutions   (which Plaid credential linked each bank)
         │     ├── plaid_tokens   (access tokens — service-role only, never
         │     │                   readable from a browser)
         │     ├── accounts       (balances, types)
         │     ├── transactions   (full history, upserted by plaid_tx_id)
         │     └── settings       (category colors, names, custom categories)
         │
         └── Plaid API (one or more developer accounts, see below)
               │
               └── Banks: Capital One, Chase, Fidelity, etc.
```

**Key decisions:**

- **Cloud-first**: Supabase Postgres is the single source of truth so the same data shows on the laptop and both phones. IndexedDB/Dexie was dropped.
- **Plaid access tokens never reach the browser.** They live in `plaid_tokens`, a table with RLS enabled and no client policies — only the serverless functions (service role) can read it.
- **Sync runs server-side** (`api/sync.js`): cursor-based `transactionsSync` per institution, upserts into Supabase, marks institutions `needs_reauth` when Plaid demands a re-login.
- **One shared household login** (email + password via Supabase Auth). All data is scoped to the household by row-level security.
- **Multiple Plaid developer accounts** are supported via the `PLAID_CREDENTIALS` env var — see "Multiple Plaid accounts" below.

---

## Tech stack

| Layer | Tool | Why |
|---|---|---|
| Bank connections | Plaid (Development tier) | Industry standard, free for personal use, supports all account types |
| Backend / hosting | Vercel (Hobby tier) | Free, serverless functions in `/api/`, deploys from GitHub |
| Database + auth | Supabase (free tier) | Postgres with row-level security, shared household login, multi-device |
| Frontend | React + Vite | Carries forward the existing dashboard; fast dev experience |
| Charts | Recharts | Replaces hand-rolled SVG donut chart with something maintainable |
| Date handling | date-fns | Lightweight, tree-shakeable |
| Bank auth UI | react-plaid-link | Plaid's official React component for the OAuth-style Link flow |

---

## Account types supported

| Type | Plaid product | What we show |
|---|---|---|
| Checking / savings | Transactions | Balance, transaction history, income detection |
| Credit cards | Transactions + Liabilities | Balance, APR, payment due, transaction history |
| 401k / brokerage | Investments | Holdings, allocation, gain/loss, total value |
| Loans | Liabilities | Balance, APR, minimum payment, payoff projection |
| Mortgages | Liabilities | Balance, rate, escrow, next payment |

All accounts feed into a **net worth view**: total assets minus total liabilities, computed live from IndexedDB.

---

## What a refresh looks like

1. User hits **Refresh** in the dashboard
2. Frontend POSTs `/api/sync` with the household JWT
3. The server, per institution: reads the access token from `plaid_tokens`,
   calls Plaid `transactionsSync` with the stored cursor, and upserts
   accounts + transactions into Supabase
4. Dashboard re-reads from Supabase and re-renders

First sync: Plaid returns up to 24 months of history per institution (we
request `days_requested: 730`). Subsequent syncs: delta only.

---

## Linking a new account

1. User clicks **+ Add Account**
2. `/api/create-link-token` picks the first Plaid credential with a free Item
   slot and returns a `link_token` + `credential_key`
3. `react-plaid-link` opens Plaid Link — an iframe served by Plaid on Plaid's domain
4. User logs into their bank via Plaid (credentials never touch our code), completes 2FA
5. Plaid returns a short-lived `public_token` to our app
6. Frontend sends `public_token` + `credential_key` to `/api/exchange-token`
7. The server exchanges it for a permanent `access_token`, stores it in
   `plaid_tokens`, and records the institution with its `credential_key`
8. First sync runs automatically

---

## Multiple Plaid accounts

Plaid's free tier caps how many Items (bank connections) one developer account
can hold. When you hit the cap, create another Plaid developer account and add
it to the app — no code changes:

1. Sign up at <https://dashboard.plaid.com> with a new email, request
   production access, and copy the new `client_id` + `secret`.
2. Append an entry to the `PLAID_CREDENTIALS` env var (Vercel → Project
   Settings → Environment Variables, and your local `.env.local`):

   ```json
   [
     {"key": "main",       "client_id": "...", "secret": "..."},
     {"key": "overflow-1", "client_id": "...", "secret": "..."}
   ]
   ```

   The `key` is any stable label you choose — it's recorded on each
   institution so syncs route through the credential that owns the Item.
   **Don't change a key after institutions are linked under it.**
3. Redeploy (Vercel) / restart the dev server.

New links automatically go to the first credential with a free slot
(`PLAID_MAX_ITEMS_PER_CREDENTIAL`, default 10). When every credential is
full, **+ Add account** shows a message telling you to add the next one.
Existing institutions keep syncing through whichever credential linked them.

---

## Carry-forward from Era dashboard

Everything already built should be ported in with minimal changes. Storage swaps from `window.storage` (artifact API) to `db.settings` (Dexie). Everything else is UI code that transfers directly:

- [ ] Month navigation with ‹ › arrows
- [ ] Overview tab: donut chart + top categories + recent transactions
- [ ] Categories tab: color swatches, inline renaming, custom categories, bar chart
- [ ] Transactions tab: full list with category pills
- [ ] Trends tab: 6-month bar chart (clickable), income vs. spending comparison
- [ ] Summary cards: total spent, balance, month-over-month delta

---

## New views to build

- [ ] **Account list**: all linked accounts, grouped by type, with current balances and institution logos
- [ ] **Net worth**: assets vs. liabilities summary at top, breakdown by account type
- [ ] **Investments**: holdings table, allocation donut, total value and gain/loss
- [ ] **Liabilities**: each loan/mortgage/card with payoff projection and minimum payment tracker
- [ ] **Multi-account filter**: "All accounts" default, filter to one account or one account type

---

## Mobile

The dashboard is responsive from the start (carried from artifact code). Additional polish planned:

- **PWA manifest**: lets you "Add to Home Screen" on iOS/Android — runs full-screen like a native app
- **Touch targets**: larger swatches and buttons for fat fingers
- **Swipe to navigate months**: swipe left/right on the month header
- **Pull to refresh**: standard mobile pattern for syncing

---

## Cost

| Service | Tier | Monthly cost |
|---|---|---|
| Plaid | Development (≤100 institutions) | $0 |
| Vercel | Hobby | $0 |
| Domain (optional) | — | ~$0.85/mo |
| Supabase (optional, v2 cross-device sync) | Free tier | $0 |

---

## Build phases

| Phase | Description | Status |
|---|---|---|
| 0 | Era dashboard — spending breakdown, categories, trends, month nav | ✅ Done (as artifact) |
| 1 | Plaid developer account, credentials, enable products | ⬜ Not started |
| 2 | Project scaffold — Vite, dependencies, folder structure, git | ⬜ Not started |
| 3 | Vercel serverless functions — link token, exchange, transactions, accounts, investments, liabilities | ⬜ Not started |
| 4 | IndexedDB schema + sync logic via Dexie | ⬜ Not started |
| 5 | Frontend — port Era dashboard, add multi-account views, net worth, investments, liabilities | ⬜ Not started |
| 6 | Deploy to Vercel, environment variables, live URL | ⬜ Not started |
| 7 | Mobile polish — PWA, touch targets, swipe nav, pull to refresh | ⬜ Not started |
| 8 | (Optional) Supabase sync layer for cross-device consistency | ⬜ Backlog |

---

## Working approach

Code is written phase by phase on request. Each phase is one conversation turn to avoid burning tokens on code that may need reworking if an earlier phase hits a snag. When stuck, stop and discuss before continuing.
