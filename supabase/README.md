# Supabase setup

Cloud canonical data store for my-money. The SimpleFIN sync (server-side in
`api/sync.js`) writes here, as does CSV/PDF import from the browser; the React
app on Vercel + your phones read from here. The SimpleFIN access URL embeds
bank credentials and lives in a service-role-only table — browsers never see
it.

> **`docs/SETUP.md` is the authoritative install guide.** Fresh installs go
> through the Supabase CLI (`supabase db push`, replaying `migrations/` in
> order); `setup_all.sql` is the verified fallback. This README's env-var table
> below still uses the LEGACY Supabase key names — see CLAUDE.md's Gotchas for
> the current Publishable/Secret naming.

## Files

| File | Purpose |
|---|---|
| **`setup_all.sql`** | **TOMBSTONED — see the banner above.** One paste: wipes partial state, recreates the schema **only through `20260731000001_receipts.sql`**, auto-creates the household. Five later migrations must be pasted after it by hand (docs/SETUP.md Path B lists them). A convenience snapshot — `migrations/` is the source of truth. **Destructive: never run on a project with real data.** |
| `migrations/` | The source of truth for the schema. On an existing database, run every file in filename order (each is additive-safe on live data unless its header says otherwise). |
| `bootstrap_household.sql` | Links the household to the auth user, then prints a per-fact booleans SELECT verifying the install. Idempotent and **non-destructive** — run it as the last step of either install path, or any time as a health check. |
| `config.toml` | Supabase CLI config for the fresh-install `link` + `db push` path (docs/SETUP.md Path A). Its own header carries the current rehearsal status — read that rather than trusting a summary here. Never link the live project. |
| `seed.sql` | Optional sample data, **hand-paste only** — it carries a literal `<HOUSEHOLD_USER_UUID>` placeholder and its own household insert. `config.toml` disables the CLI's automatic seeding for exactly that reason. Real data arrives from the SimpleFIN feed on first sync, or from a CSV/PDF import. |
| `reset.sql` | Drops everything the migrations create. Dev resets only — **destructive, never run on live data.** |

## The secrets involved, and where each one goes

| Secret | Created | Goes in `.env.local` / Vercel? | Notes |
|---|---|---|---|
| Database password | Project creation form | **No — never in env** | Direct-Postgres access. Used ONCE by `supabase link` (the CLI prompts for it), and by any `psql`/GUI connection. Save in your password manager — the app itself never uses it. |
| anon / public key | Automatic | Yes — `VITE_SUPABASE_ANON_KEY` | Public by design; RLS + login gate all access. |
| service_role key | Automatic | Yes — `SUPABASE_SERVICE_ROLE_KEY` (server-side only) | Bypasses RLS. Never in client code, never committed. |
| Household email + password | You, in step 3 | **No** | Typed into the app's login screen on each device. Share with your wife. |
| SimpleFIN setup token | bridge.simplefin.org | **No** | Pasted into the app once (Accounts → ⚡ SimpleFIN). Claimed server-side into a durable access URL stored in `simplefin_access` — service-role only, never in env, never in the browser. |

## Setup (~15 min)

### 1. Create a Supabase project

1. <https://supabase.com> → New project (free tier is fine).
2. The creation form asks for:
   - **Project name** — anything you like (e.g. `my-money`). It's a cosmetic
     dashboard label; nothing in the app references it. The app connects via
     the project URL, which is a random ref regardless of name.
   - **Database password** — click **Generate a password** and save it in
     your password manager. **The app never uses this password.** It is the
     direct-Postgres password, needed once by `supabase link` and whenever
     you connect with `psql` or a database GUI. It does NOT go in
     `.env.local`, NOT in Vercel, and
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
4. The result at the bottom should show `household_linked = true`. Its built-in
   schema check raises if the script drifts from `migrations/` — but that check
   **stops at `20260731000001_receipts.sql` too**, so it passes green while the
   five later migrations are missing. Do not read it as "the schema is
   complete".
5. **Paste the five remaining migrations** (`20260801000001`,
   `20260804000001`, `20260804000002`, `20260805000001`, `20260805000002`),
   in filename order — see docs/SETUP.md Path B for the per-file re-run
   caveats.
6. **Paste `bootstrap_household.sql`** and require every boolean in its output
   to be `true`. That is the only check covering step 5.

That one file wipes any partial state, recreates the schema **as of the
receipts migration**, and automatically creates the household linked
to the auth user you made in step 2 — no UUID copy-pasting. It's safe to
re-run any time before you have real data in the project. If you forgot
step 2, it still creates the tables, prints "No auth user found", and you
just re-run it after creating the user.

Table Editor should now show: `households`, `household_members`,
`institutions`, `accounts`, `transactions`, `settings`, `budgets`,
`simplefin_access`, `category_rules`.

<details>
<summary>Alternative: run migrations individually</summary>

Paste and run every file in `migrations/`, in filename order. Then run
`bootstrap_household.sql` to create the household link and verify the result.
This path is REQUIRED for applying a NEW migration to a project that already
has real data — `setup_all.sql` is for fresh installs only and would wipe it.
(The CLI automates exactly this replay for fresh projects: docs/SETUP.md
Path A.)
</details>

**About RLS:** the migrations explicitly enable row-level security on every
table — there is no dashboard toggle you need to set, and any "enable RLS by
default for new tables" setting is fine but redundant (tables are only ever
created by these migrations). Just never *disable* RLS on any of these
tables. After running the migrations, Dashboard → **Advisors** should show
no RLS warnings (`simplefin_access` intentionally has RLS on with zero
policies — that's what keeps the credential-bearing access URL server-only).

### 4. Configure the app

Copy `.env.example` → `.env.local` and fill in:

- `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (browser)
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (api/ routes)

There is no bank-feed secret in env: SimpleFIN's access URL is claimed at
runtime and stored in the database.

On Vercel, set the same variables in Project Settings → Environment Variables.

### 5. Verify

Run in the SQL Editor after using the app (sign in → link an account → sync):

```sql
-- simplefin_org_id is the feed discriminator: not null => SimpleFIN-fed
select name, simplefin_org_id, status, last_successful_pull_at from institutions;

-- Accounts and balances arrived
select name, mask, type, current_balance from accounts;

-- Transactions arrived
select count(*) from transactions;
```

Security spot-checks:

```sql
-- simplefin_access has RLS enabled and NO policies → authenticated users get
-- nothing; only service_role (the API) can read. Should return rows here
-- (SQL Editor runs as service_role) …
select id, left(access_url, 12) || '…' as url_prefix, last_pulled_at from simplefin_access;
```

…but from the **browser console** on your deployed app (signed in!), this must
return an empty array:

```js
await window.supabase?.from('simplefin_access').select('*') // → { data: [] }
```

> Note: the SQL Editor runs as `service_role`, which bypasses RLS and has no
> `auth.uid()`. Admin inserts must set `household_id` explicitly; the app's
> inserts resolve it automatically via `current_household_id()`.

## Resetting during development

Re-run `setup_all.sql` — it wipes and rebuilds everything, including the
household link — then **re-paste the five later migrations and
`bootstrap_household.sql`**, exactly as in a fresh install. `setup_all.sql`
alone leaves the database five migrations short, and its own check won't say so.

The Auth user survives resets (it lives in `auth.users`). Re-claiming a
SimpleFIN setup token is required after a reset because the access URL is
dropped with `simplefin_access`. Any CSV/PDF-imported history is dropped too —
re-import the files.
