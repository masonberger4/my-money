-- Rental-property tracking + tax prep groundwork.
--
-- Adds:
--   * entities            — rental properties (kind='rental'; 'business' is
--                           allowed by the CHECK so a future side-business can
--                           reuse the machinery without another migration, but
--                           the UI is rental-first for now).
--   * accounts.entity_id  — account-level default: every transaction on this
--                           account belongs to the entity unless the row says
--                           otherwise. For a dedicated rental checking/card.
--   * transactions.entity_id — per-transaction override for rental expenses
--                           paid from a shared household account. USER-OWNED:
--                           written only by the UI, never by sync or import,
--                           so it survives re-pulls the same way user_category
--                           does. Effective entity at READ time is
--                           tx.entity_id ?? account.entity_id.
--   * transactions.is_capital / placed_in_service / useful_life_years —
--                           capital-expense flag: improvements are depreciated,
--                           not deducted, so the Schedule E report must keep
--                           them OUT of the expense lines and list them
--                           separately for the preparer. Also user-owned.
--   * mileage_log         — hand-entered rental drives (SimpleFIN obviously
--                           has no mileage; a PWA has no background GPS).
--                           Valued at the IRS standard rate in src/taxReport.js.
--
-- Everything here is additive, so it takes the normal order: paste in the
-- Supabase SQL Editor BEFORE the merge (old code ignores new tables/columns).
-- It takes the budgets/category_rules RLS shape: one for-all policy per table,
-- household_id defaulting to current_household_id() so authenticated client
-- writes can omit it. (Service-role code must set household_id explicitly —
-- the default resolves to NULL there — but nothing server-side writes these.)

create table if not exists entities (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  name text not null,
  kind text not null default 'rental' check (kind in ('rental', 'business')),
  created_at timestamptz not null default now(),
  -- Archive, don't delete: transactions.entity_id references this row, and a
  -- year-end tax report must still resolve entities archived mid-year.
  archived_at timestamptz
);

alter table entities enable row level security;

drop policy if exists entities_all on entities;
create policy entities_all on entities
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

alter table accounts
  add column if not exists entity_id uuid references entities(id) on delete set null;

alter table transactions
  add column if not exists entity_id uuid references entities(id) on delete set null;

alter table transactions
  add column if not exists is_capital boolean not null default false;

alter table transactions
  add column if not exists placed_in_service date;

alter table transactions
  add column if not exists useful_life_years integer;

-- Tax reads scan a calendar year for entity-tagged rows; almost every row is
-- untagged, so a partial index keeps this cheap without bloating the common
-- writes.
create index if not exists transactions_entity_idx
  on transactions (entity_id)
  where entity_id is not null;

create table if not exists mileage_log (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  entity_id uuid references entities(id) on delete cascade,
  on_date date not null,
  miles numeric(7, 1) not null check (miles > 0),
  purpose text,
  created_at timestamptz not null default now()
);

alter table mileage_log enable row level security;

drop policy if exists mileage_log_all on mileage_log;
create policy mileage_log_all on mileage_log
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());
