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
[Browser — laptop or phone]
   │
   ├── IndexedDB (all financial data, local & private per device)
   │     ├── institutions   (linked banks, Plaid access tokens)
   │     ├── accounts       (balances, types, all institutions)
   │     ├── transactions   (full history, grows forever)
   │     ├── holdings       (401k, brokerage positions)
   │     ├── liabilities    (loans, mortgages, credit detail)
   │     └── settings       (category colors, names, custom categories)
   │
   └── Vercel serverless functions  (/api/*)
         │   stateless — never stores your data
         │   only exists to keep Plaid secret off the client
         │
         └── Plaid API
               │
               └── Banks: Capital One, Chase, Fidelity, etc.
```

**Key decisions:**

- Plaid access tokens are stored in IndexedDB (browser), not on the server. The backend is a thin, stateless Plaid proxy. If you wipe browser data, you re-link accounts — that's the trade for full privacy.
- Data accumulates locally forever. Plaid sends only new transactions on each sync (cursor-based), so refreshes are fast after the first full pull.
- Cross-device sync is out of scope for v1. Each device (laptop, phone) maintains its own IndexedDB. To get data onto a second device without re-linking, **export a backup on the first device and import it on the second** (see [Mirroring to another device](#mirroring-to-another-device-export--import)). The export carries the Plaid access token, so the second device reuses the same connection rather than consuming another. A Supabase sync layer can be added in v2 if managing multiple caches becomes annoying.

---

## Tech stack

| Layer | Tool | Why |
|---|---|---|
| Bank connections | Plaid (free trial → Production) | Industry standard, supports all account types. See [Cost](#cost) for the connection-based pricing. |
| Backend / hosting | Vercel (Hobby tier) | Free, serverless functions in `/api/`, deploys from GitHub |
| Local cache | IndexedDB via Dexie | Private, persistent, fast, works offline, no server needed |
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
2. For each institution in IndexedDB:
   - Frontend sends that institution's `access_token` to `/api/transactions`
   - Vercel forwards to Plaid using the stored cursor (only fetches new transactions)
   - Plaid returns new/modified/removed transactions
   - Frontend writes them into IndexedDB
3. Repeat for accounts, investments, liabilities
4. Dashboard re-renders from updated IndexedDB

First sync: Plaid returns up to 24 months of history per institution. Subsequent syncs: delta only.

---

## Linking a new account

1. User clicks **+ Add Account**
2. `react-plaid-link` opens Plaid Link — an iframe served by Plaid on Plaid's domain
3. User logs into their bank via Plaid (credentials never touch our code), completes 2FA
4. Plaid returns a short-lived `public_token` to our app
5. Frontend sends `public_token` to `/api/exchange-token`
6. Vercel exchanges it with Plaid for a permanent `access_token`
7. `access_token` is returned to browser and stored in `db.institutions`
8. First sync runs automatically

---

## Mirroring to another device (export / import)

Each device keeps its own local cache. To put your data on a second device (e.g. your phone) **without re-linking the bank and without using another Plaid connection**, copy the cache over:

1. On the device that already has your data (e.g. desktop), click **⤓ Export data** (bottom-right controls). This downloads `my-money-backup-YYYY-MM-DD.json`.
2. Move the file to the other device — AirDrop, a private cloud folder, etc.
3. On the new device, open the app. On the empty "Connect your first account" screen, tap **⤒ Import data** and pick the file. (You can also re-import later from the bottom-right controls.)
4. The dashboard renders immediately from the imported data, and a normal **Refresh** will pull anything new from Plaid.

The export includes each institution's Plaid `accessToken` and sync `cursor`, so the importing device reuses the **same** Plaid connection — no extra connection slot is consumed.

> ⚠️ **Security:** the backup file contains live Plaid access tokens. Treat it like a password — transfer it over a private channel and delete it once imported. Don't email it or leave it in shared storage.
>
> This is a manual, one-way copy, not live sync. Changes made on one device after import don't propagate to the other. Continuous cross-device sync is the optional Phase 8 (Supabase) work.

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

- [x] **PWA manifest**: lets you "Add to Home Screen" on iOS/Android — runs full-screen like a native app
- [ ] **Touch targets**: larger swatches and buttons for fat fingers
- [ ] **Swipe to navigate months**: swipe left/right on the month header
- [ ] **Pull to refresh**: standard mobile pattern for syncing

### Install on iPhone

1. Open the deployed URL in **Safari** (not Chrome — only Safari can install PWAs on iOS).
2. Tap the **Share** button.
3. Scroll down and tap **Add to Home Screen**.
4. Confirm — "my-money" now appears on your home screen and launches full-screen with its own icon, no Safari chrome.

The app shell is cached by a service worker, so the home-screen app opens instantly and still launches when offline (the latest cached data renders; new transactions need a network to sync). Plaid API calls and `/api/*` requests are never cached.

---

## Cost

| Service | Tier | Monthly cost |
|---|---|---|
| Plaid | Free trial (10 connections) → Production | $0 during trial; paid after |
| Vercel | Hobby | $0 |
| Domain (optional) | — | ~$0.85/mo |
| Supabase (optional, v2 cross-device sync) | Free tier | $0 |

### Plaid connections

Plaid retired the old free "Development" tier. The current model is a **free trial capped at 10 connections**, then a paid Production plan. API calls against those connections are unlimited.

A **connection** is one bank login (Plaid calls it an *Item*), even if that login exposes several accounts. Two things to know:

- **The same bank linked twice = two connections.** Plaid can't tell it's the same person.
- **Each device that links independently consumes a connection per bank.** Linking your bank on both laptop and phone = 2 connections for one bank.

To avoid burning connections across devices, use [export/import](#mirroring-to-another-device-export--import) instead of re-linking — the backup carries the access token, so the second device shares the original connection.

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
| 7.5 | Cross-device mirror via export/import (manual, shares Plaid connection) | ✅ Done |
| 8 | (Optional) Supabase sync layer for live cross-device consistency | ⬜ Backlog |

---

## Working approach

Code is written phase by phase on request. Each phase is one conversation turn to avoid burning tokens on code that may need reworking if an earlier phase hits a snag. When stuck, stop and discuss before continuing.
