-- RLS assertions for test/rls.test.js. Runs after rls_stub.sql + every
-- migration in supabase/migrations/. Any failure raises, so psql
-- -v ON_ERROR_STOP=1 exits non-zero and the test fails with the message.
--
-- Impersonation mirrors PostgREST: set role authenticated (so RLS is not
-- bypassed the way it is for the superuser) + set_config('request.jwt.claims')
-- which the stub's auth.uid() reads.

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

reset role;
select 'RLS_OK' as result;
