# Supabase setup

Cloud canonical data store for my-money. The Plaid sync (server-side in
`api/sync.js`) writes here; the React app on Vercel + your phones read from
here. Plaid access tokens live in a service-role-only table — browsers never
see them.

## Files

| File | Purpose |
|---|---|
| `migrations/20260605000001_init.sql` | Base tables, RLS, Realtime publication. Run first on an empty database. |
| `migrations/20260606000001_plaid.sql` | Reshapes the schema for Plaid: drops scraper-era tables, adds `plaid_tokens` (service-role only), `plaid_credential_key` for multi-Plaid-account routing, `settings` for dashboard prefs. Run second. |
| `migrations/20260714000001_account_labels.sql` | Adds `nickname` + `color` to accounts for the per-account badges shown on transactions. Run third. |
| `seed.sql` | Optional sample data. Real data arrives via Plaid on first sync. |
| `reset.sql` | Drops everything from both migrations. For dev resets. |

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

### 2. Run the migrations

SQL Editor → New query. Paste and run, in order:

1. `migrations/20260605000001_init.sql`
2. `migrations/20260606000001_plaid.sql`
3. `migrations/20260714000001_account_labels.sql`

Table Editor should now show: `households`, `household_members`,
`institutions`, `accounts`, `transactions`, `plaid_tokens`, `settings`.

**About RLS:** the migrations explicitly enable row-level security on every
table — there is no dashboard toggle you need to set, and any "enable RLS by
default for new tables" setting is fine but redundant (tables are only ever
created by these migrations). Just never *disable* RLS on any of these
tables. After running the migrations, Dashboard → **Advisors** should show
no RLS warnings (`plaid_tokens` intentionally has RLS on with zero
policies — that's what keeps access tokens server-only).

### 3. Create the household user

1. Authentication → Users → **Add user** → **Create new user**.
2. Email + a strong shared household password (you and your wife both use this).
3. **Auto Confirm User: ON**. Copy the new user's **UID**.

### 4. Create the household

Replace the UUID and run in the SQL Editor (or run all of `seed.sql` if you
also want sample data):

```sql
with new_household as (
  insert into households (name) values ('My Household') returning id
)
insert into household_members (household_id, user_id, role)
select id, '<HOUSEHOLD_USER_UUID>'::uuid, 'owner' from new_household;
```

### 5. Configure the app

Copy `.env.example` → `.env.local` and fill in:

- `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (browser)
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (api/ routes)
- `PLAID_CREDENTIALS` (see root README section on Plaid accounts)

On Vercel, set the same variables in Project Settings → Environment Variables.

### 6. Verify

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

1. Paste `reset.sql` → Run.
2. Re-run both migrations.
3. Re-create the household (step 4).

The Auth user survives resets (it lives in `auth.users`). Re-linking every
institution through Plaid Link is required after a reset because access tokens
are dropped with `plaid_tokens`.
