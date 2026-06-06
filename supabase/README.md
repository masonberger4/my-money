# Supabase setup

Cloud canonical data store for my-money. The local scraper writes here; the
React app on Vercel + your phones read from here.

## Files

| File | Purpose |
|---|---|
| `migrations/20260605000001_init.sql` | Tables, indexes, RLS, triggers, Realtime publication. Idempotent only if run on an empty database. |
| `seed.sql` | Sample household + institution + accounts + transactions for verification. |
| `reset.sql` | Drops everything from the init migration. For dev resets. |

## Quick test (one-time, ~15 min)

### 1. Create a Supabase project

1. Go to <https://supabase.com> → New project.
2. Region: pick one close to you (free tier is fine).
3. Save the project URL and `anon` key — you'll need them later when wiring up the React app.
4. Wait ~2 min for provisioning.

### 2. Run the init migration

1. Open the project → SQL Editor → New query.
2. Paste the entire contents of `migrations/20260605000001_init.sql`.
3. Click **Run**.
4. Expect: success, no rows returned.
5. Go to Table Editor — you should see 8 new tables: `households`, `household_members`, `institutions`, `accounts`, `transactions`, `pending_items`, `pull_jobs`, `mfa_prompts`.

### 3. Create the household user

1. Authentication → Users → **Add user** → **Create new user**.
2. Email: whatever shared address you want.
3. Password: pick a strong shared household password (this is what you, your wife, and the scraper will all use).
4. **Auto Confirm User: ON** (skip email verification).
5. Click Create. Copy the new user's **UID** (looks like `xxxxxxxx-xxxx-...`).

### 4. Seed sample data

1. Open `seed.sql`.
2. Replace `<HOUSEHOLD_USER_UUID>` with the UID from step 3.
3. Paste into SQL Editor → Run.
4. Expect: 1 household row, 1 institution, 3 accounts, 4 transactions inserted.

### 5. Verify it works

Run each of these in the SQL Editor and check the result.

**(a) Tables populated:**
```sql
select 'institutions' as t, count(*) from institutions
union all select 'accounts',     count(*) from accounts
union all select 'transactions', count(*) from transactions;
```
Expect: 1, 3, 4.

**(b) Possible-duplicate detection:**
```sql
select account_id, synthetic_id, count(*) as c
from transactions
group by 1, 2
having count(*) > 1;
```
Expect: one row (the two intentional Starbucks transactions sharing
`syn-starbucks-1234-475-today`).

> **Note on the queries below.** The SQL Editor runs as `service_role`, which
> bypasses RLS and has no `auth.uid()`. That means the `household_id` default
> (which calls `current_household_id()`) returns NULL, and the `not null`
> constraint will reject inserts that omit `household_id`. So in the admin
> inserts below we set `household_id` explicitly. The React app and scraper
> won't need to — they authenticate as the household user and the default
> resolves correctly.

**(c) Rate limit trigger blocks rapid re-pulls:**
```sql
-- First insert: queues a job
insert into pull_jobs (household_id, institution_id)
select household_id, id from institutions limit 1;

-- Mark it done so the rate limit kicks in
update pull_jobs set status = 'done', completed_at = now()
where status = 'queued';

-- Second insert: should error
insert into pull_jobs (household_id, institution_id)
select household_id, id from institutions limit 1;
```
Expect: the third statement errors with `rate_limit: institution ... already pulled successfully in the last 24 hours`.

**(d) `manual_override` bypasses the rate limit:**
```sql
insert into pull_jobs (household_id, institution_id, manual_override)
select household_id, id, true from institutions limit 1;
```
Expect: success.

**(e) "In-progress" guard blocks parallel pulls:**
```sql
-- The override row above is still queued; this should error
insert into pull_jobs (household_id, institution_id, manual_override)
select household_id, id, true from institutions limit 1;
```
Expect: errors with `pull_in_progress: institution ... already has an active pull job`.

**Note on RLS:** the SQL Editor runs as `service_role`, which bypasses RLS by
design — so you can't observe row-level isolation from there. RLS is fully
exercised once the React app reads/writes through the Supabase JS client with a
real JWT (next step). If you want to spot-check it now: run a query from a
browser console on a different Supabase project, against this project's URL,
using the anon key without signing in — you should get 0 rows / permission errors.

**(f) Realtime publication includes the right tables:**
```sql
select tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by tablename;
```
Expect: `accounts`, `mfa_prompts`, `pull_jobs`, `transactions`.

### 6. Done

If all of the above passed, the schema is working. Next steps (separate PRs):

1. Migrate the React app off Dexie onto Supabase, still using Plaid.
2. Build the scraper daemon skeleton with a fake adapter.
3. Replace Plaid with the scraper for one real bank.

## Resetting during development

If you mess up state and want to start over:
1. Paste `reset.sql` → Run.
2. Paste `migrations/20260605000001_init.sql` → Run.
3. Re-seed.

The Auth user from step 3 above is preserved across resets (it lives in `auth.users`, not in our tables).
