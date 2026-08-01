-- Debt tracker groundwork (spec: CLAUDE.md "Debt tracker — build spec" steps 1–2).
--
-- Adds:
--   * accounts liability columns — apr / minimum_payment / credit_limit /
--     statement_balance / next_payment_due_date / interest_rate /
--     original_balance. All nullable. Under SimpleFIN these are HAND-ENTERED in
--     the Debt view and NEVER written by the sync (user-owned, like nickname/
--     color/hidden), so they survive re-pulls. Rates are stored as PERCENT
--     (e.g. 24.99, not 0.2499); payoff math reads one normalized
--     debtRate = apr ?? interest_rate and divides by 100. Column names match
--     the original Plaid-Liabilities spec on purpose so a richer feed could
--     refill them later without another migration.
--   * balance_snapshots — one row per account per day the balance changed,
--     appended by api/sync.js. `balance` mirrors the STORED convention
--     (accounts.current_balance at capture time, so debts POSITIVE = owed);
--     the chart flips at render via displayBalance like everywhere else. Do
--     NOT store debts negative here to make a net-worth SUM() easier — mixing
--     both signs in one column is unrecoverable once rows accumulate. Powers
--     the debt-over-time chart AND seeds the future net-worth feature.
--
-- Everything here is additive, so it takes the normal order: safe to paste in
-- the Supabase SQL Editor BEFORE the merge (old code ignores new tables and
-- columns). Same RLS shape as budgets/entities: one for-all policy,
-- household_id defaulting to current_household_id() so authenticated client
-- writes can omit it. The sync writes snapshots as SERVICE_ROLE, where that
-- default resolves to NULL — so it sets household_id explicitly (see
-- api/sync.js), and the NOT NULL below makes forgetting that fail loudly.

alter table accounts add column if not exists apr numeric;
alter table accounts add column if not exists minimum_payment numeric;
alter table accounts add column if not exists credit_limit numeric;
alter table accounts add column if not exists statement_balance numeric;
alter table accounts add column if not exists next_payment_due_date date;
alter table accounts add column if not exists interest_rate numeric;
alter table accounts add column if not exists original_balance numeric;

create table if not exists balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  captured_on date not null,
  -- accounts.current_balance at capture time: stored convention, debts positive.
  balance numeric not null,
  created_at timestamptz not null default now(),
  unique (account_id, captured_on)
);

alter table balance_snapshots enable row level security;

drop policy if exists balance_snapshots_all on balance_snapshots;
create policy balance_snapshots_all on balance_snapshots
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());
