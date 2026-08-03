-- Expected/scheduled transactions: display-only forward-looking rows seeded
-- from recurring detection or typed by hand. NEVER counted as spending, never
-- touch the envelope walk — a matched expectation just points at the real row.
create table expected_transactions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default current_household_id()
    references households(id) on delete cascade,
  -- Provenance: the recurring group key (normalizeMerchant output) when seeded
  -- from the Recurring tab; null for a hand-entered expectation. NOT unique —
  -- each cycle mints a new row for the same key.
  recurring_key text,
  description text not null,
  category text not null,            -- raw category label, like budgets/budget_months
  account_id uuid references accounts(id) on delete set null,
  amount numeric(12,2) not null,     -- app convention: positive = money out
  due_date date not null,
  cadence text check (cadence in ('weekly','monthly','annual','once')) not null default 'once',
  status text not null default 'pending'
    check (status in ('pending','matched','dismissed')),
  matched_tx_id uuid references transactions(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table expected_transactions enable row level security;

create policy expected_transactions_all on expected_transactions
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

create index expected_tx_household_due_idx
  on expected_transactions (household_id, status, due_date);
-- Backs the "does a pending row for this key+cycle already exist" seed check.
create index expected_tx_key_idx
  on expected_transactions (household_id, recurring_key, due_date);
