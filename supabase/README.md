# Supabase setup

Cloud canonical data store for my-money. The Plaid sync (server-side in
`api/sync.js`) writes here; the React app on Vercel + your phones read from
here. Plaid access tokens live in a service-role-only table — browsers never
see them.

## Files

| File | Purpose |
|---|---|
| **`setup_all.sql`** | **Start here for a FRESH install.** One paste: wipes partial state, recreates the full schema, auto-creates the household. A convenience snapshot of the migrations — `migrations/` is the source of truth. **Destructive: never run on a project with real data.** |
| `migrations/` | The source of truth for the schema. On an existing database, run every file in filename order (each is additive-safe on live data unless its header says otherwise). |
| `seed.sql` | Optional sample data. Real data arrives via Plaid on first sync. |
| `reset.sql` | Drops everything the migrations create. For dev resets. |

## The secrets involved, and where each one goes

| Secret | Created | Goes in `.env.local` / Vercel? | Notes |
|---|---|---|---|
| Database password | Project creation form | **No — goes nowhere** | Direct-Postgres access only. Save in password manager, then forget about it. |
| anon / public key | Automatic | Yes — `VITE_SUPABASE_ANON_KEY` | Public by design; RLS + login gate all access. |
| service_role key | Automatic | Yes — `SUPABASE_SERVICE_ROLE_KEY` (server-side only) | Bypasses RLS. Never in client code, never committed. |
| Household email + password | You, in step 3 | **No** | Typed into the app's login screen on each device. Share with your wife. |
| Plaid client_id + secret | plaid.com dashboard | Yes — `PLAID_CREDENTIALS` (server-side only) | See root README for the multi-account format. |

## Setup (~15 min)

### 1. Create a Supabase project

1. <https://supabase.com> → New project (free tier is fine).
2. The creation form asks for:
   - **Project name** — anything you like (e.g. `my-money`). It's a cosmetic
     dashboard label; nothing in the app references it. The app connects via
     the project URL, which is a random ref regardless of name.
   - **Database password** — click **Generate a password** and save it in
     your password manager. **The app never uses this password.** It is the
     direct-Postgres password, only needed if you ever connect with `psql`
     or a database GUI. It does NOT go in `.env.local`, NOT in Vercel, and
     it is NOT the household login password (that's created in step 3).
   - **Region** — pick the one closest to you.
3. After the project provisions (~2 min), note down from **Project
   Settings → API** (or "Data API" / "API Keys" depending on dashboard
   version):
   - **Project URL** (`https://xxxx.supabase.co`)
   - **anon / public key** (safe to expose; the browser uses it — access is
     still gated by login + RLS)
   - **service_role key** (secret; server-side api/ routes only — this key
     bypasses RLS, so it must never be in client code or committed to git)

### 2. Create the household user (do this BEFORE the SQL)

1. Authentication → Users → **Add user** → **Create new user**.
2. Email + a strong shared household password.
3. **Auto Confirm User: ON** → Create.

### 3. Run the SQL — one paste

1. SQL Editor (left sidebar, `>_` icon) → **New query**.
2. Open **`setup_all.sql`** (in this folder), select ALL of it, copy.
3. Paste into the editor → **Run** (or Cmd/Ctrl+Enter).
4. The result at the bottom should show `household_linked = true` (a built-in
   schema check raises an error if the script is out of sync with
   `migrations/` — if it does, the file needs regenerating, not your setup).

That one file wipes any partial state, recreates the full schema (everything
in `migrations/`, in order), and automatically creates the household linked
to the auth user you made in step 2 — no UUID copy-pasting. It's safe to
re-run any time before you have real data in the project. If you forgot
step 2, it still creates the tables, prints "No auth user found", and you
just re-run it after creating the user.

Table Editor should now show: `households`, `household_members`,
`institutions`, `accounts`, `transactions`, `plaid_tokens`, `settings`,
`budgets`.

<details>
<summary>Alternative: run migrations individually</summary>

Paste and run every file in `migrations/`, in filename order. Then create
the household manually (step 4 below). This path is REQUIRED for applying a
NEW migration to a project that already has real data — `setup_all.sql` is
for fresh installs only and would wipe it.
</details>

**About RLS:** the migrations explicitly enable row-level security on every
table — there is no dashboard toggle you need to set, and any "enable RLS by
default for new tables" setting is fine but redundant (tables are only ever
created by these migrations). Just never *disable* RLS on any of these
tables. After running the migrations, Dashboard → **Advisors** should show
no RLS warnings (`plaid_tokens` intentionally has RLS on with zero
policies — that's what keeps access tokens server-only).

### 4. Configure the app

Copy `.env.example` → `.env.local` and fill in:

- `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (browser)
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (api/ routes)
- `PLAID_CREDENTIALS` (see root README section on Plaid accounts)

On Vercel, set the same variables in Project Settings → Environment Variables.

### 5. Verify

Run in the SQL Editor after using the app (sign in → link an account → sync):

```sql
-- Institutions show which Plaid credential linked them
select name, plaid_credential_key, status, last_successful_pull_at from institutions;

-- Accounts and balances arrived
select name, mask, type, current_balance from accounts;

-- Transactions arrived
select count(*) from transactions;
```

Security spot-checks:

```sql
-- plaid_tokens has RLS enabled and NO policies → authenticated users get
-- nothing; only service_role (the API) can read. Should return rows here
-- (SQL Editor runs as service_role) …
select institution_id, left(access_token, 12) || '…' as token_prefix from plaid_tokens;
```

…but from the **browser console** on your deployed app (signed in!), this must
return an empty array:

```js
await window.supabase?.from('plaid_tokens').select('*') // → { data: [] }
```

> Note: the SQL Editor runs as `service_role`, which bypasses RLS and has no
> `auth.uid()`. Admin inserts must set `household_id` explicitly; the app's
> inserts resolve it automatically via `current_household_id()`.

## Resetting during development

Just re-run `setup_all.sql` — it wipes and rebuilds everything, including the
household link.

The Auth user survives resets (it lives in `auth.users`). Re-linking every
institution through Plaid Link is required after a reset because access tokens
are dropped with `plaid_tokens`.
