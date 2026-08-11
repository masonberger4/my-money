-- RLS assertions for test/rls.test.js. Runs after rls_stub.sql + every
-- migration in supabase/migrations/. Any failure raises, so psql
-- -v ON_ERROR_STOP=1 exits non-zero and the test fails with the message.
--
-- Impersonation mirrors PostgREST: set role authenticated (so RLS is not
-- bypassed the way it is for the superuser) + set_config('request.jwt.claims')
-- which the stub's auth.uid() reads.
--
-- Sections (1)-(6): cross-household denial + defaults, impersonated.
-- Section  (7):     receipts storage.objects policy ENFORCED, impersonated —
--                   the migration's DO block can no-op with only a NOTICE
--                   (invisible in the SQL Editor, the CLAUDE.md Gotcha), so a
--                   run of the migrations that silently dropped the policy
--                   must turn red HERE, not in production uploads.
-- Sections (8)-(10) run as admin, against the catalogs:
--   (8) the receipts_objects_all policy exists in pg_policies with the
--       expected scope (FOR ALL, authenticated, household path segment).
--   (9) pg_class vs pg_policies DIFF: every public table is RLS-enabled, and
--       every RLS-enabled table carries >= 1 policy unless it is on the
--       explicit zero-client-policies allowlist (which is itself asserted).
--  (10) current_household_id() stays public + security definer + executable
--       by authenticated (the addReceipt path breaks silently otherwise).

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------- seed (admin)
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'b@example.com');

insert into households (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'House A'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'House B');

insert into household_members (household_id, user_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222');

-- One institution/account/transaction/settings/expected row per household.
insert into institutions (id, household_id, name) values
  ('a0000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Bank A'),
  ('b0000000-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000002', 'Bank B');

insert into accounts (id, household_id, institution_id, plaid_account_id, name, type) values
  ('a0000000-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000a1', 'sfin:a', 'Checking A', 'depository'),
  ('b0000000-0000-0000-0000-0000000000b2', 'bbbbbbbb-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-0000000000b1', 'sfin:b', 'Checking B', 'depository');

insert into transactions (id, household_id, account_id, plaid_tx_id, date, amount, description) values
  ('a0000000-0000-0000-0000-0000000000a3', 'aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000a2', 'sfin:ta', '2026-08-01', 10, 'A COFFEE'),
  ('b0000000-0000-0000-0000-0000000000b3', 'bbbbbbbb-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-0000000000b2', 'sfin:tb', '2026-08-01', 20, 'B COFFEE');

insert into settings (household_id, key, value) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'dash:colors', '{"a":1}'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'dash:colors', '{"b":1}');

insert into expected_transactions (id, household_id, description, category, amount, due_date) values
  ('a0000000-0000-0000-0000-0000000000a4', 'aaaaaaaa-0000-0000-0000-000000000001', 'A RENT', 'Bills', 100, '2026-09-01'),
  ('b0000000-0000-0000-0000-0000000000b4', 'bbbbbbbb-0000-0000-0000-000000000002', 'B RENT', 'Bills', 200, '2026-09-01');

insert into simplefin_access (household_id, access_url) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'https://example.invalid/secret-a');

-- One household-B receipt object, inserted as admin (the table owner bypasses
-- RLS), so section (7) can prove household A never sees it. The receipts
-- bucket itself was created by the migration.
insert into storage.objects (bucket_id, name) values
  ('receipts', 'bbbbbbbb-0000-0000-0000-000000000002/b0000000-0000-0000-0000-0000000000b3/receipt-b.jpg');

-- --------------------------------------------------------- become household A
set role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false);

do $$
declare n int;
begin
  -- current_household_id() resolves for the impersonated user
  if current_household_id() <> 'aaaaaaaa-0000-0000-0000-000000000001'::uuid then
    raise exception 'current_household_id() did not resolve for user A (got %)', current_household_id();
  end if;

  -- (1) cross-household SELECT is denied on every user-facing table
  select count(*) into n from transactions;
  if n <> 1 then raise exception 'transactions SELECT leaked % rows (expected 1)', n; end if;
  select count(*) into n from accounts;
  if n <> 1 then raise exception 'accounts SELECT leaked % rows (expected 1)', n; end if;
  select count(*) into n from settings;
  if n <> 1 then raise exception 'settings SELECT leaked % rows (expected 1)', n; end if;
  select count(*) into n from expected_transactions;
  if n <> 1 then raise exception 'expected_transactions SELECT leaked % rows (expected 1)', n; end if;
  select count(*) into n from institutions;
  if n <> 1 then raise exception 'institutions SELECT leaked % rows (expected 1)', n; end if;

  -- (2) simplefin_access is invisible to authenticated (zero client policies).
  -- RLS with no policy = deny; a leak here would expose bank credentials.
  begin
    select count(*) into n from simplefin_access;
    if n <> 0 then raise exception 'simplefin_access leaked % rows to authenticated', n; end if;
  exception when insufficient_privilege then
    null; -- grant-level denial is fine too
  end;

  -- (3) cross-household UPDATE hits no rows (invisible, not writable)
  update transactions set user_category = 'Groceries'
   where id = 'b0000000-0000-0000-0000-0000000000b3';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'cross-household transactions UPDATE touched % rows', n; end if;

  update settings set value = 'x'
   where household_id = 'bbbbbbbb-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'cross-household settings UPDATE touched % rows', n; end if;

  update expected_transactions set status = 'dismissed'
   where id = 'b0000000-0000-0000-0000-0000000000b4';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'cross-household expected_transactions UPDATE touched % rows', n; end if;

  update accounts set nickname = 'pwned'
   where id = 'b0000000-0000-0000-0000-0000000000b2';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'cross-household accounts UPDATE touched % rows', n; end if;

  -- (4) cross-household DELETE hits no rows
  delete from transactions where id = 'b0000000-0000-0000-0000-0000000000b3';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'cross-household transactions DELETE touched % rows', n; end if;
end $$;

-- (5) cross-household INSERT is rejected by the WITH CHECK, per table.
do $$
declare tbl text; stmt text; ok boolean;
begin
  foreach tbl in array array['transactions','accounts','settings','expected_transactions'] loop
    stmt := case tbl
      when 'transactions' then
        $q$insert into transactions (household_id, account_id, plaid_tx_id, date, amount, description)
           values ('bbbbbbbb-0000-0000-0000-000000000002','b0000000-0000-0000-0000-0000000000b2','manual:x','2026-08-02',5,'X')$q$
      when 'accounts' then
        $q$insert into accounts (household_id, institution_id, plaid_account_id, name, type)
           values ('bbbbbbbb-0000-0000-0000-000000000002','b0000000-0000-0000-0000-0000000000b1','sfin:x','X','depository')$q$
      when 'settings' then
        $q$insert into settings (household_id, key, value)
           values ('bbbbbbbb-0000-0000-0000-000000000002','pwn','1')$q$
      else
        $q$insert into expected_transactions (household_id, description, category, amount, due_date)
           values ('bbbbbbbb-0000-0000-0000-000000000002','X','Bills',1,'2026-09-01')$q$
    end;
    ok := false;
    begin
      execute stmt;
    exception
      when insufficient_privilege then ok := true;      -- 42501: RLS check violation
      when foreign_key_violation then ok := true;       -- FK to an invisible row
    end;
    if not ok then
      raise exception 'cross-household INSERT into % was ALLOWED', tbl;
    end if;
  end loop;
end $$;

-- (6) household_id defaults resolve for a client-role insert (the RLS shape
-- that lets the client INSERT its own rows without naming household_id).
do $$
declare hid uuid;
begin
  insert into settings (key, value) values ('rls:probe', '1');
  select household_id into hid from settings where key = 'rls:probe';
  if hid is distinct from 'aaaaaaaa-0000-0000-0000-000000000001'::uuid then
    raise exception 'settings.household_id default did not resolve (got %)', hid;
  end if;

  insert into expected_transactions (description, category, amount, due_date)
    values ('PROBE', 'Bills', 1, '2026-09-01');
  select household_id into hid from expected_transactions where description = 'PROBE';
  if hid is distinct from 'aaaaaaaa-0000-0000-0000-000000000001'::uuid then
    raise exception 'expected_transactions.household_id default did not resolve (got %)', hid;
  end if;

  insert into transactions (account_id, plaid_tx_id, date, amount, description)
    values ('a0000000-0000-0000-0000-0000000000a2', 'manual:probe', '2026-08-03', 7, 'PROBE');
  select household_id into hid from transactions where plaid_tx_id = 'manual:probe';
  if hid is distinct from 'aaaaaaaa-0000-0000-0000-000000000001'::uuid then
    raise exception 'transactions.household_id default did not resolve (got %)', hid;
  end if;
end $$;

-- (7) the receipts storage.objects policy is ENFORCED for the impersonated
-- user: own-household path uploads, foreign-household path is denied, and the
-- admin-seeded household-B object is invisible. This is the runtime half of
-- the DO-block/NOTICE gotcha check — section (8) asserts the policy's catalog
-- shape; this proves the qual actually scopes on the path's first segment.
do $$
declare n int;
begin
  -- upload under our own household prefix passes the WITH CHECK
  insert into storage.objects (bucket_id, name)
    values ('receipts', 'aaaaaaaa-0000-0000-0000-000000000001/a0000000-0000-0000-0000-0000000000a3/receipt-a.jpg');

  -- only our own household's objects are visible (the B seed row is not)
  select count(*) into n from storage.objects where bucket_id = 'receipts';
  if n <> 1 then
    raise exception 'storage.objects SELECT saw % receipts rows (expected 1 — cross-household receipt leaked, or own upload invisible)', n;
  end if;

  -- upload under ANOTHER household's prefix is an RLS violation
  begin
    insert into storage.objects (bucket_id, name)
      values ('receipts', 'bbbbbbbb-0000-0000-0000-000000000002/b0000000-0000-0000-0000-0000000000b3/evil.jpg');
    raise exception 'cross-household storage.objects INSERT was ALLOWED — the receipts policy does not scope on the household path segment';
  exception when insufficient_privilege then
    null; -- 42501: new row violates row-level security policy — the expected denial
  end;
end $$;

reset role;

-- ------------------------------------------------------- catalog checks (admin)

-- (8) the receipts storage policy EXISTS with the expected shape, read from
-- pg_policies (PG16 columns: schemaname/tablename/policyname/permissive/roles/
-- cmd/qual/with_check). The migration creates it inside a DO block that
-- downgrades insufficient_privilege to a NOTICE — invisible in the SQL Editor
-- (the Gotcha) — so "the migrations replayed cleanly" does NOT imply the
-- policy exists; only this SELECT does. The qual/with_check checks are
-- substring probes into the deparsed expression (deparse formatting is not
-- contractual across PG versions; section (7) is the behavioral proof).
do $$
declare pol record; n int; b record;
begin
  select count(*) into n from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname = 'receipts_objects_all';
  if n <> 1 then
    raise exception 'receipts_objects_all not found on storage.objects (pg_policies has % rows) — the receipts migration DO block silently no-opped (its only tell is a NOTICE the SQL Editor never shows); uploads would fail with an RLS violation', n;
  end if;

  select * into pol from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname = 'receipts_objects_all';

  if pol.cmd <> 'ALL' then
    raise exception 'receipts_objects_all cmd is % (expected ALL — one policy covers select/insert/update/delete)', pol.cmd;
  end if;
  if pol.permissive <> 'PERMISSIVE' then
    raise exception 'receipts_objects_all is % (expected PERMISSIVE)', pol.permissive;
  end if;
  if not ('authenticated' = any (pol.roles)) then
    raise exception 'receipts_objects_all does not apply to authenticated (roles: %)', pol.roles;
  end if;
  -- both arms must pin the bucket AND scope on path segment [1] = household id
  if pol.qual is null
     or pol.qual not like '%receipts%'
     or pol.qual not like '%foldername%'
     or pol.qual not like '%[1]%'
     or pol.qual not like '%current_household_id%' then
    raise exception 'receipts_objects_all USING does not scope on the household path segment: %', pol.qual;
  end if;
  if pol.with_check is null
     or pol.with_check not like '%receipts%'
     or pol.with_check not like '%foldername%'
     or pol.with_check not like '%[1]%'
     or pol.with_check not like '%current_household_id%' then
    raise exception 'receipts_objects_all WITH CHECK does not scope on the household path segment: %', pol.with_check;
  end if;

  -- the bucket the policy names must exist and stay PRIVATE (a public bucket
  -- would make every receipt path a permanent unauthenticated URL)
  select * into b from storage.buckets where id = 'receipts';
  if not found then
    raise exception 'storage bucket ''receipts'' was not created';
  end if;
  if b.public then
    raise exception 'storage bucket ''receipts'' is PUBLIC — receipts are financial documents, the bucket must stay private';
  end if;
end $$;

-- (9) pg_class vs pg_policies DIFF. Two halves, because each alone is
-- vacuous: a policy-less table passes "has RLS enabled" checks, and a table
-- with RLS DISABLED passes "every RLS table has a policy" checks. A future
-- migration that adds a public table cannot ship policy-less without turning
-- one of these red.
do $$
declare
  -- Tables with RLS ON and deliberately ZERO client policies (RLS with no
  -- policy = deny-all for client roles; api/ reads them under service_role,
  -- which bypasses RLS). Explicit allowlist, never a silent skip — and (c)
  -- below asserts each entry still exists and still has zero policies, so a
  -- stale or wrong entry is itself a failure.
  --   simplefin_access — the access URL embeds the household's bank
  --     credentials; CLAUDE.md: zero client policies, only api/ reads it.
  --   legacy_budgets / legacy_budget_months / legacy_category_rules /
  --     legacy_wipe_counts — 20260805000001's pre-wipe archives: an operator
  --     restore source, not app data ("the simplefin_access shape" per that
  --     migration's own comment).
  allowlist constant text[] := array[
    'simplefin_access',
    'legacy_budgets',
    'legacy_budget_months',
    'legacy_category_rules',
    'legacy_wipe_counts'
  ];
  bad text;
  t text;
begin
  -- (a) every table in public has RLS ENABLED (relrowsecurity via pg_class)
  select string_agg(c.relname, ', ' order by c.relname) into bad
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public'
     and c.relkind in ('r', 'p')
     and not c.relrowsecurity;
  if bad is not null then
    raise exception 'public tables with RLS DISABLED (client can read/write every household''s rows): %', bad;
  end if;

  -- (b) every RLS-enabled public table carries at least one policy, or is
  -- explicitly allowlisted as service-role-only
  select string_agg(c.relname, ', ' order by c.relname) into bad
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public'
     and c.relkind in ('r', 'p')
     and c.relrowsecurity
     and c.relname <> all (allowlist)
     and not exists (select 1 from pg_policies p
                      where p.schemaname = 'public' and p.tablename = c.relname)
  ;
  if bad is not null then
    raise exception 'public tables with RLS enabled but ZERO policies (deny-all — the client cannot use them; add a policy or add them to the allowlist in rls_assert.sql with a reason): %', bad;
  end if;

  -- (c) the allowlist stays honest: every entry exists and still has zero
  -- policies (a policy appearing on simplefin_access would expose bank
  -- credentials — that must be as loud as a missing policy elsewhere)
  foreach t in array allowlist loop
    if to_regclass('public.' || t) is null then
      raise exception 'zero-policy allowlist names a table that does not exist: % (remove it from rls_assert.sql)', t;
    end if;
    if exists (select 1 from pg_policies p
                where p.schemaname = 'public' and p.tablename = t) then
      raise exception 'allowlisted service-role-only table % now HAS a policy — if that is intended, remove it from the allowlist; if not, a client-visible policy on it is a leak', t;
    end if;
  end loop;
end $$;

-- (10) current_household_id() stays in public, SECURITY DEFINER, and
-- executable by authenticated. addReceipt is the app's only supabase.rpc()
-- call and needs exactly this (Receipt Conventions): a schema tidy that moves
-- or revokes the function breaks uploads ONLY, and silently. Section (1)
-- already proved it RUNS while impersonated; these pin the catalog facts a
-- tidy would change.
do $$
declare n int; secdef boolean;
begin
  select count(*) into n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'current_household_id';
  if n <> 1 then
    raise exception 'expected exactly one public.current_household_id() (found %) — PostgREST exposes rpc from public only', n;
  end if;

  select p.prosecdef into secdef
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'current_household_id';
  if not secdef then
    raise exception 'current_household_id() is not SECURITY DEFINER — it must read household_members regardless of RLS';
  end if;

  if not has_function_privilege('authenticated', 'public.current_household_id()', 'execute') then
    raise exception 'authenticated cannot EXECUTE current_household_id() — every RLS policy and the addReceipt rpc depend on it';
  end if;
end $$;

select 'RLS_OK' as result;
