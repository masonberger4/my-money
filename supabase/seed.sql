-- Seed data for quick verification (optional — real data arrives from the
-- SimpleFIN feed on first sync, or from a CSV/PDF import, so you can skip this
-- entirely).
--
-- Run AFTER every migration in migrations/ AND after creating the household
-- user in Supabase Auth (see supabase/README.md).
--
-- Replace <HOUSEHOLD_USER_UUID> with the UUID from Auth > Users before running.

-- ---- 1. Create the household and link the user ------------------------------
with new_household as (
  insert into households (name) values ('My Household') returning id
)
insert into household_members (household_id, user_id, role)
select id, '<HOUSEHOLD_USER_UUID>'::uuid, 'owner' from new_household;

-- The SQL Editor runs as service_role: auth.uid() is NULL there, so the
-- household_id defaults can't resolve themselves. Admin inserts must set
-- household_id explicitly. App inserts (React/API with a user JWT) don't.

-- ---- 2. Sample institution + accounts ---------------------------------------
with hh as (select id from households limit 1),
ins as (
  -- plaid_credential_key / plaid_item_id were dropped by 20260728000002.
  -- simplefin_org_id is the feed discriminator: not null => SimpleFIN-fed.
  -- Left NULL here so the seed institution behaves like the manual "Imported"
  -- one and the SimpleFIN pull never tries to reconcile it against a real org.
  insert into institutions (household_id, name, display_name, status)
  select hh.id, 'Test Bank', 'Test Bank (seed)', 'disabled' from hh
  returning id, household_id
)
-- plaid_account_id is the ADAPTER-AGNOSTIC external id, not a Plaid column —
-- hence the 'manual:' prefix, matching what src/dataAdapter.js writes.
insert into accounts (household_id, institution_id, plaid_account_id, name, official_name, type, subtype, mask, current_balance, available_balance, last_balance_at, is_manual)
select ins.household_id, ins.id, 'manual:tb-chk-001', 'Test Checking', 'Test Bank Checking ****1234', 'depository', 'checking', '1234', 4231.07, 4231.07, now(), true from ins
union all
-- current_balance is stored POSITIVE = owed for credit/loan (see the
-- Conventions section of CLAUDE.md). $845.31 owed against a $5,000 limit
-- leaves $4,154.69 available. It was seeded negative, which the UI now renders
-- backwards — displayBalance negates a debt, so a card that owes money showed
-- as a positive balance.
select ins.household_id, ins.id, 'manual:tb-cc-001',  'Test Credit',   'Test Bank Visa ****9012',     'credit',    'credit card','9012', 845.31, 4154.69, now(), true from ins;

-- ---- 3. Sample transactions -------------------------------------------------
-- Amounts follow the app's convention: positive = money out, negative = in.
-- raw_category is left NULL: it held Plaid's taxonomy, and with Plaid gone
-- mapped_category is derived at WRITE time by src/txClassify.js instead.
-- markInternalTransfers still reads raw_category, so seeding a Plaid-only
-- string like 'INCOME_WAGES' would only be misleading.
with chk as (select id, household_id from accounts where plaid_account_id = 'manual:tb-chk-001'),
cc  as (select id, household_id from accounts where plaid_account_id = 'manual:tb-cc-001')
insert into transactions (household_id, account_id, plaid_tx_id, date, amount, merchant_name, description, mapped_category, source)
select chk.household_id, chk.id, 'manual:seed-tx-payroll', current_date - 2, -3200.00, 'Acme Corp',    'PAYROLL ACME CORP', 'Transfers and card payments', 'csv' from chk
union all
select chk.household_id, chk.id, 'manual:seed-tx-rent',    current_date - 1,  1800.00, 'Property LLC', 'RENT',              'Utilities',                   'csv' from chk
union all
select cc.household_id,  cc.id,  'manual:seed-tx-coffee',  current_date,         4.75, 'Starbucks',    'STARBUCKS #1234',   'Coffee and snacks',           'csv' from cc;
