-- Seed data for quick verification (optional — real data arrives via Plaid
-- on first sync, so you can skip this entirely).
--
-- Run AFTER both migrations AND after creating the household user in
-- Supabase Auth (see supabase/README.md).
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
  insert into institutions (household_id, name, display_name, plaid_credential_key, plaid_item_id)
  select hh.id, 'Test Bank', 'Test Bank (seed)', 'main', 'seed-item-001' from hh
  returning id, household_id
)
insert into accounts (household_id, institution_id, plaid_account_id, name, official_name, type, subtype, mask, current_balance, available_balance, last_balance_at)
select ins.household_id, ins.id, 'tb-chk-001', 'Test Checking', 'Test Bank Checking ****1234', 'depository', 'checking', '1234', 4231.07, 4231.07, now() from ins
union all
-- current_balance is stored POSITIVE = owed for credit/loan (see the
-- Conventions section of CLAUDE.md). $845.31 owed against a $5,000 limit
-- leaves $4,154.69 available. It was seeded negative, which the UI now renders
-- backwards — displayBalance negates a debt, so a card that owes money showed
-- as a positive balance.
select ins.household_id, ins.id, 'tb-cc-001',  'Test Credit',   'Test Bank Visa ****9012',     'credit',    'credit card','9012', 845.31, 4154.69, now() from ins;

-- ---- 3. Sample transactions -------------------------------------------------
with chk as (select id, household_id from accounts where plaid_account_id = 'tb-chk-001'),
cc  as (select id, household_id from accounts where plaid_account_id = 'tb-cc-001')
insert into transactions (household_id, account_id, plaid_tx_id, date, amount, merchant_name, description, raw_category, mapped_category)
select chk.household_id, chk.id, 'seed-tx-payroll', current_date - 2, -3200.00, 'Acme Corp',    'PAYROLL ACME CORP', 'INCOME_WAGES',              'Transfers and card payments' from chk
union all
select chk.household_id, chk.id, 'seed-tx-rent',    current_date - 1,  1800.00, 'Property LLC', 'RENT',              'RENT_AND_UTILITIES_RENT',   'Utilities' from chk
union all
select cc.household_id,  cc.id,  'seed-tx-coffee',  current_date,         4.75, 'Starbucks',    'STARBUCKS #1234',   'FOOD_AND_DRINK_COFFEE',     'Coffee and snacks' from cc;
