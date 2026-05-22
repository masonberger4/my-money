# my-money — Build Brief for Claude Code

You are building a self-hosted personal finance dashboard for one person (the owner of this repo). This brief is the complete spec. Do not invent features beyond what's described here. When in doubt, prefer simpler implementations over clever ones. The goal is a working v1 that exactly matches the existing Phase 0 dashboard UI, powered by Plaid instead of Era.

---

## 1. Mission

Port the existing spending dashboard (`spending-dashboard.jsx` in this repo) from the Era MCP data source to a direct Plaid integration. Everything that is not the data source should stay visually and behaviorally identical.

**Critical constraints:**
- Bank accounts (checking, savings) and credit cards only. No investments, loans, mortgages, holdings, or liabilities views.
- No webhooks. On-open sync only.
- No user accounts, no auth, no multi-tenant. Single-user app.
- All transaction data lives in the browser via IndexedDB (Dexie). The Vercel backend is a stateless proxy to Plaid.
- Plaid access tokens are stored client-side in IndexedDB, not in any server-side database.

---

## 2. Stack

| Layer | Tool | Notes |
|---|---|---|
| Frontend | React 18 + Vite | |
| Local storage | Dexie (IndexedDB wrapper) | |
| Charts | Keep the hand-rolled SVG donut from the existing file. Don't add Recharts in v1. | |
| Plaid Link | `react-plaid-link` | |
| Date helpers | `date-fns` | |
| Backend | Vercel serverless functions in `/api/*.js` | Node 20 runtime |
| Plaid SDK | `plaid` (official Node SDK) | Used in serverless functions only |
| Local dev | `vercel dev` | Runs Vite + serverless functions together on one port |

Install command after scaffolding:
```
npm install react react-dom react-plaid-link dexie date-fns
npm install -D vite @vitejs/plugin-react
npm install plaid
npm install -g vercel
```

---

## 3. File tree

Create exactly this structure. Do not add files not listed unless they're standard scaffolding (`.gitignore`, etc.).

```
my-money/
├── api/
│   ├── create-link-token.js
│   ├── exchange-token.js
│   ├── sync-transactions.js
│   └── get-balances.js
├── src/
│   ├── main.jsx
│   ├── App.jsx
│   ├── db.js
│   ├── plaidClient.js
│   ├── sync.js
│   ├── categoryMap.js
│   ├── dataAdapter.js
│   └── components/
│       ├── Dashboard.jsx
│       ├── LinkAccount.jsx
│       └── EmptyState.jsx
├── index.html
├── vite.config.js
├── vercel.json
├── package.json
├── .gitignore
├── .env.local            (gitignored, user creates manually)
└── README.md
```

---

## 4. Environment variables

The user will create `.env.local` themselves. Do not commit it. Reference these names in code:

```
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_ENV=production
```

`PLAID_ENV=production` is correct. Plaid renamed the free tier "Trial" in their dashboard, but it still maps to the `production` environment in the API. Do not use `sandbox` or `development`.

Same three variables must be set in the Vercel dashboard (Settings → Environment Variables) for the deployed version. The user will do this themselves after first deploy.

Add to `.gitignore`:
```
node_modules/
.env.local
.vercel/
dist/
```

---

## 5. Data flow

```
User opens app
  → sync.js runs
    → For each institution in db.institutions:
        → POST /api/sync-transactions with { access_token, cursor }
        → /api/sync-transactions calls Plaid's /transactions/sync
        → Returns { added, modified, removed, next_cursor, has_more }
        → sync.js writes changes to db.transactions, updates cursor
    → POST /api/get-balances with { access_tokens: [...] }
        → Returns current balances for all accounts
        → sync.js updates db.accounts
  → Dashboard reads everything from db.* — never calls /api/* directly
```

Keep paginating `/transactions/sync` until `has_more === false` on each sync.

---

## 6. IndexedDB schema (src/db.js)

```js
import Dexie from 'dexie';

export const db = new Dexie('MyMoney');
db.version(1).stores({
  institutions: '++id, name, accessToken, cursor, lastSync',
  accounts: 'plaidAccountId, institutionId, name, officialName, type, subtype, currentBalance, availableBalance, mask, lastUpdated',
  transactions: 'plaidTxId, accountId, date, amount, merchantName, name, plaidCategory, mappedCategory, pending',
  settings: 'key',  // value-only: colors, names, custom categories
});
```

Notes:
- `transactions.amount` from Plaid is positive for outflows (spending) and negative for inflows (income/refunds). Keep this convention throughout the app — the existing dashboard already treats positive as spending.
- `transactions.date` is an ISO `YYYY-MM-DD` string.
- `mappedCategory` is the Era-style category name (see categoryMap.js) used by the existing dashboard UI.
- `plaidCategory` is the raw Plaid Personal Finance Category for debugging.

The `settings` table replaces `window.storage` from the existing dashboard. Keys to preserve:
- `dash:colors` → JSON object of category → hex color
- `dash:names` → JSON object of category → renamed string
- `dash:cats` → JSON array of custom category objects `{id, name, color}`

---

## 7. Backend endpoints

Each file in `/api/` becomes a Vercel serverless function. They all follow the same pattern: read JSON body, call Plaid via the official SDK, return JSON. No state, no database, no auth.

### `/api/create-link-token.js`
**POST** with empty body (or `{}`). Returns `{ link_token: "..." }`.

Calls Plaid's `linkTokenCreate` with:
```js
{
  user: { client_user_id: 'mason' },  // any stable string, single-user
  client_name: 'my-money',
  products: ['transactions'],
  country_codes: ['US'],
  language: 'en',
}
```

### `/api/exchange-token.js`
**POST** `{ public_token: "..." }`. Returns `{ access_token: "...", item_id: "..." }`.

Calls Plaid's `itemPublicTokenExchange`. The frontend stores the returned `access_token` in `db.institutions` and never sends it back to the server except in subsequent sync/balance calls.

### `/api/sync-transactions.js`
**POST** `{ access_token: "...", cursor: "..." | null }`. Returns the raw Plaid `/transactions/sync` response: `{ added, modified, removed, next_cursor, has_more, accounts }`.

Use Plaid's `transactionsSync`. On first sync, `cursor` will be `null` — Plaid returns all available history (up to 24 months) paginated.

### `/api/get-balances.js`
**POST** `{ access_token: "..." }`. Returns `{ accounts: [...] }` from Plaid's `accountsBalanceGet`.

Use this for the live "card balance" display in the summary card. Call it on every dashboard open. Cheap.

---

## 8. Category mapping (src/categoryMap.js)

Plaid returns Personal Finance Categories like `FOOD_AND_DRINK_RESTAURANT` and `TRANSPORTATION_GAS`. The existing dashboard expects Era-style names like `"Dining out"` and `"Vehicle expenses"`.

Build a mapping function `mapPlaidCategory(plaidPfcPrimary, plaidPfcDetailed) → string`. Use the existing dashboard's `DEFAULT_COLORS` keys as the target category names (they are the canonical set):

- Shopping and gear
- Health and fitness
- Entertainment and subscriptions
- Travel and vacation
- Dining out
- Childcare
- Groceries
- Pets
- Healthcare and pharmacy
- Coffee and snacks
- Vehicle expenses
- Ride shares
- Public transit
- Home maintenance and improvement
- Utilities
- Education
- Side hustles and business
- Cash, checks, and misc
- Transfers and card payments

Reasonable mappings (use Plaid's `personal_finance_category.primary` as the main lever, fall back to `.detailed` for ambiguous cases):

| Plaid primary | → Era category |
|---|---|
| FOOD_AND_DRINK (detailed contains RESTAURANT/FAST_FOOD) | Dining out |
| FOOD_AND_DRINK (detailed contains GROCERIES) | Groceries |
| FOOD_AND_DRINK (detailed contains COFFEE) | Coffee and snacks |
| TRANSPORTATION (GAS, PARKING, TOLLS, MAINTENANCE) | Vehicle expenses |
| TRANSPORTATION (TAXIS_AND_RIDE_SHARES) | Ride shares |
| TRANSPORTATION (PUBLIC_TRANSIT) | Public transit |
| TRANSPORTATION (TRAVEL/FLIGHTS/HOTELS) | Travel and vacation |
| TRAVEL | Travel and vacation |
| ENTERTAINMENT, RECREATION_SERVICES | Entertainment and subscriptions |
| GENERAL_MERCHANDISE | Shopping and gear |
| PERSONAL_CARE | Health and fitness |
| MEDICAL | Healthcare and pharmacy |
| HOME_IMPROVEMENT | Home maintenance and improvement |
| RENT_AND_UTILITIES | Utilities |
| GOVERNMENT_AND_NON_PROFIT, GENERAL_SERVICES | Cash, checks, and misc |
| TRANSFER_IN, TRANSFER_OUT, LOAN_PAYMENTS, BANK_FEES | Transfers and card payments |
| INCOME | Transfers and card payments (income shows up positive in cash flow regardless) |

Anything unmapped defaults to `"Shopping and gear"`. Add a console.warn for unmapped categories so the user can refine later.

---

## 9. Data adapter (src/dataAdapter.js)

The existing dashboard expects specific data shapes (the shapes Era returned). Build pure functions that read from Dexie and produce these shapes so the dashboard component requires no changes other than the import.

Functions needed:

```js
// All accept an optional { year, month } scope. Default: current month.

getOverview() → {
  accounts: [{ balance: { current: number } }],
  last_month: { spending: { amount: number } }
}

getSpending({ year, month }) → {
  groups: [{
    label: string,           // Era category name
    amount: number,
    transaction_count: number,
    percent_of_total: number
  }]
}

getTransactions({ year, month }) → {
  transactions: [{
    plaid_tx_id: string,
    merchant_name: string,
    description: string,     // map from Plaid's `name`
    transaction_date: string, // YYYY-MM-DD
    amount: number,           // positive = spending
    category: string          // Era category name (mappedCategory)
  }]
}

getCashFlow({ num_periods: 6 }) → {
  periods: [{
    label: string,            // "May 2026"
    start: string,            // YYYY-MM-DD of first day of month
    spending: { amount: number },
    income: { amount: number }
  }],
  averages: {
    spending: { amount: number }
  }
}
```

Spending = sum of positive `amount` for non-transfer categories in the period.
Income = sum of absolute value of negative `amount` for the period (or the INCOME category specifically — choose the simpler one and document it).

---

## 10. Dashboard component port

Source file: `spending-dashboard.jsx` (in the repo root, copied from the Phase 0 artifact).

Required changes:

1. **Remove the `ERA_MCP`, `MODEL`, `callEra`, and `parseToolResult` constants/functions entirely.** They will be replaced.
2. **Replace all `callEra(...)` calls** with calls to the new `dataAdapter.js` functions:
   - `callEra("knowledge__get_financial_context_and_overview", ...)` → `getOverview()`
   - `callEra("insights__analyze_spending", ...)` → `getSpending({year, month})`
   - `callEra("transactions__list_transactions", ...)` → `getTransactions({year, month})`
   - `callEra("insights__get_cash_flow", ...)` → `getCashFlow({num_periods: 6})`
3. **Replace `window.storage.get/set/...` calls** with Dexie reads/writes to `db.settings`. Keep the same key names (`dash:colors`, `dash:names`, `dash:cats`) so future migrations are easy.
4. **Keep the entire visual layer unchanged** — same CSS variables, same DM Sans / DM Mono fonts, same layout, same animations, same icons, same color palette.
5. **Add a sync trigger**: when the user clicks the refresh button (top right, the ↻ icon), call `runSync()` from `sync.js` before re-reading from Dexie. Also call `runSync()` once on initial mount.
6. **Bottom-of-screen attribution**: change `"Capital One Venture X · Era Context"` to just `"my-money"`.

Move the modified file to `src/components/Dashboard.jsx`. The original `spending-dashboard.jsx` in the repo root is a reference — leave it in place.

---

## 11. Plaid Link flow (src/components/LinkAccount.jsx)

A button labeled "+ Add account" that opens Plaid Link via `react-plaid-link`.

```js
import { usePlaidLink } from 'react-plaid-link';
```

Flow:
1. On mount or button click, fetch a link_token from `/api/create-link-token`.
2. Use `usePlaidLink({ token, onSuccess })`.
3. `onSuccess(public_token, metadata)`:
   - POST `public_token` to `/api/exchange-token`
   - Get back `{ access_token, item_id }`
   - Write a new row to `db.institutions` with `name: metadata.institution.name`, `accessToken: access_token`, `cursor: null`, `lastSync: null`
   - Trigger a sync immediately
   - Close the modal / refresh dashboard

Style it to match the existing dashboard's button style (the `.ibtn` class).

---

## 12. Empty state (src/components/EmptyState.jsx)

When `db.institutions` is empty, the Dashboard should not render its tabs — instead render `<EmptyState />`, which shows a centered card with:
- Header: "Connect your first account"
- One-line description: "Link a bank or card via Plaid to start seeing your spending."
- The `<LinkAccount />` button

Match the existing visual style (same fonts, same card styling).

---

## 13. App shell (src/App.jsx)

```js
- On mount: subscribe to db.institutions count.
- If 0 → render <EmptyState />
- Else → render <Dashboard />
- Always render a "+ Add account" button in the corner so the user can add more institutions later (use the same LinkAccount component).
```

---

## 14. Vite + Vercel config

### `vite.config.js`
Standard React Vite setup. Proxy `/api/*` to `http://localhost:3000` is NOT needed if using `vercel dev` (which serves both on one port).

### `vercel.json`
```json
{
  "buildCommand": "vite build",
  "outputDirectory": "dist",
  "rewrites": [
    { "source": "/((?!api/).*)", "destination": "/index.html" }
  ]
}
```

This routes everything except `/api/*` to the SPA so the React app handles routing.

### `index.html`
Standard Vite entry pointing to `/src/main.jsx`. Title: "my-money".

---

## 15. Local development workflow

After files are in place, the user will run:
```
npm install
vercel dev
```

`vercel dev` serves the Vite frontend AND the `/api/*` serverless functions on a single localhost port (usually 3000). On first run, `vercel dev` will prompt to link the project — they'll create a new Vercel project named `my-money`.

If `vercel dev` complains about missing env vars, they need to either:
- Create `.env.local` with the three PLAID_* variables (recommended)
- Or run `vercel env pull .env.local` after configuring vars in the Vercel dashboard

---

## 16. Deployment workflow

```
git init
git add .
git commit -m "Initial scaffold"
gh repo create my-money --private --source=. --push   # or push to a manually-created repo
```

Then on vercel.com:
1. Import the new GitHub repo
2. Framework preset: **Vite**
3. Add the three env vars (PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV=production)
4. Deploy

Every subsequent `git push` to main auto-deploys.

---

## 17. Out of scope for v1 (do NOT build)

- Investment / brokerage / 401k views
- Loans, mortgages, liabilities
- Webhooks (Plaid → app real-time push)
- ITEM_LOGIN_REQUIRED re-auth flow (Update Mode) — show a basic error if it occurs and leave a TODO
- PWA / iOS install manifest
- Cross-device sync (Supabase or otherwise)
- Net worth view
- Multi-account selector / filter
- User accounts / auth / multi-tenant
- CSV import/export
- Anything not explicitly in the existing Phase 0 dashboard

---

## 18. Definition of done

- [ ] `npm install` completes without errors
- [ ] `vercel dev` starts a local server
- [ ] Opening localhost shows the empty state if no institutions are linked
- [ ] "+ Add account" opens Plaid Link, connects a real bank (try Capital One first — the user's primary card), and stores the access token in IndexedDB
- [ ] First sync pulls historical transactions and they appear in the dashboard
- [ ] All four tabs (Overview, Categories, Transactions, Trends) work with real data
- [ ] Month navigation works
- [ ] Color picker, category rename, and custom categories persist after refresh (now via Dexie)
- [ ] Refresh button triggers a delta sync
- [ ] Deployed to Vercel and accessible at `my-money.vercel.app` (or chosen subdomain)

---

## 19. When stuck

If you hit ambiguity not covered here, prefer:
1. **Simpler over cleverer** — this is a single-user app, not enterprise software
2. **Match the existing dashboard's visual language** — same fonts, spacing, colors, animations
3. **Add a `// TODO:` comment** rather than inventing a feature

Do not add: testing frameworks, state management libraries (Redux/Zustand), CSS frameworks (Tailwind), TypeScript, or any other tooling not listed in section 2. The user is a beginner and the surface area should stay small.
