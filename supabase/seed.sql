-- Seed data for quick verification.
-- Run this AFTER the init migration AND after you've created the household
-- user via Supabase Auth (see supabase/README.md).
--
-- Replace these two placeholders before running:
--   <HOUSEHOLD_USER_UUID> = the UUID of the user you created in Auth > Users
--   <HOUSEHOLD_ID>        = leave this; it's set automatically below.

-- ---- 1. Create the household and link the user ------------------------------
with new_household as (
  insert into households (name) values ('My Household') returning id
)
insert into household_members (household_id, user_id, role)
select id, '<HOUSEHOLD_USER_UUID>'::uuid, 'owner' from new_household;

-- From here on, queries running as the household user will automatically scope
-- via current_household_id(). The inserts below run as service_role (SQL editor
-- default), so we set household_id explicitly.

-- ---- 2. Sample institution + accounts ---------------------------------------
with hh as (select id from households limit 1),
ins as (
  insert into institutions (household_id, adapter_id, name, display_name)
  select hh.id, 'localhost-test-bank', 'Test Bank', 'Test Bank (seed)' from hh
  returning id, household_id
)
insert into accounts (household_id, institution_id, adapter_account_id, name, official_name, type, subtype, mask, current_balance, available_balance, last_balance_at)
select ins.household_id, ins.id, 'tb-chk-001', 'Test Checking', 'Test Bank Checking ****1234', 'depository', 'checking', '1234', 4231.07, 4231.07, now() from ins
union all
select ins.household_id, ins.id, 'tb-sav-001', 'Test Savings',  'Test Bank Savings ****5678',  'depository', 'savings',  '5678', 12010.42, 12010.42, now() from ins
union all
select ins.household_id, ins.id, 'tb-cc-001',  'Test Credit',   'Test Bank Visa ****9012',     'credit',    'credit card','9012', -845.31, 4154.69, now() from ins;

-- ---- 3. Sample transactions -------------------------------------------------
-- The two Starbucks rows share a synthetic_id on purpose: they're a "possible
-- duplicate" pair the UI should surface. The conservative-dedup model means
-- we keep both rows and let the user decide.
with chk as (select id, household_id from accounts where adapter_account_id = 'tb-chk-001'),
cc  as (select id, household_id from accounts where adapter_account_id = 'tb-cc-001')
insert into transactions (household_id, account_id, synthetic_id, date, amount, merchant_name, description, raw_category, mapped_category)
select chk.household_id, chk.id, 'syn-payroll-1',                current_date - 2, -3200.00, 'Acme Corp',    'PAYROLL ACME CORP', 'transfer_in', 'Income'  from chk
union all
select chk.household_id, chk.id, 'syn-rent-1',                   current_date - 1,  1800.00, 'Property LLC', 'RENT JUN',          'rent',        'Housing' from chk
union all
select cc.household_id,  cc.id,  'syn-starbucks-1234-475-today', current_date,        4.75,  'Starbucks',    'STARBUCKS #1234',   'coffee',      'Dining'  from cc
union all
select cc.household_id,  cc.id,  'syn-starbucks-1234-475-today', current_date,        4.75,  'Starbucks',    'STARBUCKS #1234',   'coffee',      'Dining'  from cc;

-- ---- 4. Verification queries ------------------------------------------------
-- These run as service_role in the SQL Editor, which means auth.uid() is NULL
-- and the household_id default cannot resolve itself. Specify household_id
-- explicitly in admin inserts. (Real React/scraper inserts go through a user
-- JWT, so the default works there.)
--
-- See supabase/README.md for the full verification walkthrough.
