-- Migration 4: per-category monthly budgets.
-- One row per (household, category); monthly_limit is the dollar cap for a
-- calendar month. No row = no budget for that category. Same RLS pattern as
-- the settings table. Additive-only: safe to run on live data.

create table budgets (
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  category text not null,
  monthly_limit numeric(12, 2) not null,
  updated_at timestamptz not null default now(),
  primary key (household_id, category)
);

alter table budgets enable row level security;

create policy budgets_all on budgets
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());
