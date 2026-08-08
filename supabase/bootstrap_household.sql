-- ============================================================================
-- bootstrap_household.sql — the LAST step of a fresh install.
--
-- WHAT THIS IS
--   `supabase db push` replays supabase/migrations/ and gives you the schema.
--   It cannot give you a household: the row has to point at a real auth user,
--   and that user is created by hand in the Supabase Dashboard. This file
--   closes that gap, then PROVES the install is complete with a verification
--   SELECT you can actually read.
--
-- WHEN TO RUN IT
--   1. `supabase db push`               (all migrations applied)
--   2. Dashboard -> Authentication -> Users -> create the shared household user
--   3. paste THIS file into the SQL Editor and run it
--   Run it out of that order and the DO block simply reports that no auth user
--   exists — re-run after creating the user.
--
-- SAFETY
--   IDEMPOTENT and NON-DESTRUCTIVE. It creates a household only when
--   household_members is empty, and otherwise touches nothing. Safe to re-run
--   any number of times — including as a health check on a live database.
--   This is NOT supabase/setup_all.sql, which DROPS and recreates every table
--   and must never be run against live data.
--
-- READING THE OUTPUT
--   The SQL Editor does NOT display `raise notice`, so the DO block's messages
--   go nowhere. The verification SELECT at the bottom is the part you can see:
--   run it (it runs automatically as the last statement) and require EVERY
--   column to be true. A column named false tells you exactly what is missing.
-- ============================================================================


-- ============ AUTO-CREATE HOUSEHOLD ============
-- Links the household to the first (usually only) auth user. If you haven't
-- created the user yet, this is skipped — create the user and re-run this file.
do $$
declare
  u uuid;
  hh uuid;
begin
  select id into u from auth.users order by created_at limit 1;
  if u is null then
    raise notice 'No auth user found. Create one in Authentication -> Users, then re-run this file.';
  elsif exists (select 1 from household_members) then
    raise notice 'Household already linked — nothing to do.';
  else
    insert into households (name) values ('My Household') returning id into hh;
    insert into household_members (household_id, user_id, role) values (hh, u, 'owner');
    raise notice 'Household created and linked to user %.', u;
  end if;
end $$;


-- ============ VERIFICATION — every column must read TRUE ============
-- One boolean per fact, named so a false column identifies its own failure.
-- Facts chosen for the things a fresh install actually gets wrong: the
-- household link, all six migrations after the setup_all.sql snapshot's
-- cutoff (whose absence is invisible until a tab silently degrades), and the
-- two storage objects that the receipts
-- migration can fail to create WITHOUT raising (the 42501 path — the SQL
-- Editor's postgres role may not own storage.objects, and the migration turns
-- that into a NOTICE nobody sees).
select
  -- Step 3 above: a household row exists and points at an auth user.
  (select count(*) > 0 from household_members)                     as household_linked,

  -- Tables from the later migrations (a plain `db push` should have all three).
  to_regclass('public.balance_snapshots')     is not null          as balance_snapshots_table,
  to_regclass('public.expected_transactions') is not null          as expected_transactions_table,
  to_regclass('public.receipts')              is not null          as receipts_table,

  -- 20260804000001 — per-month target override.
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'budget_months'
            and column_name = 'target_override')                   as budget_months_target_override,

  -- 20260805000002 — amount-scoped learned rules. The column, BOTH partial
  -- unique indexes that replaced the primary key, and the ABSENCE of that old
  -- PK: if category_rules_pkey survives, the drop matched nothing and every
  -- amount-scoped insert will fail on it.
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'category_rules'
            and column_name = 'amount')                            as category_rules_amount_column,
  exists (select 1 from pg_indexes
          where schemaname = 'public'
            and indexname = 'category_rules_any_amount_key')        as idx_any_amount_key,
  exists (select 1 from pg_indexes
          where schemaname = 'public'
            and indexname = 'category_rules_amount_key')            as idx_amount_key,
  not exists (select 1 from pg_indexes
          where schemaname = 'public'
            and indexname = 'category_rules_pkey')                  as old_pk_dropped,

  -- 20260805000001 — the user-owned-categories wipe. The one migration whose
  -- absence is otherwise INVISIBLE: it wipes data rather than adding a feature,
  -- so every other boolean here can read true while it never ran. Its durable
  -- schema residue is the tell.
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'transactions'
            and column_name = 'legacy_categories_saved')          as category_wipe_applied,

  -- 20260731000001 — receipts Storage. The bucket row, and the storage.objects
  -- policy that can fail with 42501 and be downgraded to an unseen NOTICE.
  -- If receipts_objects_policy is false, create the policy by hand in
  -- Dashboard -> Storage -> Policies (bucket 'receipts', all operations,
  -- role authenticated, USING and WITH CHECK both
  --   (storage.foldername(name))[1] = current_household_id()::text
  -- ), then round-trip one real upload before believing receipts work.
  exists (select 1 from storage.buckets where id = 'receipts')      as receipts_bucket,
  exists (select 1 from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'receipts_objects_all')                as receipts_objects_policy;
