-- Migration 11: envelope budgeting (YNAB rules 2 and 3, plus the per-month
-- grain rule 1 needs).
--
-- budget_months adds the per-(category, month) grain the flat budgets table
-- lacked: `assigned` is how many real dollars the household gave a category
-- in that month. A MISSING ROW MEANS assigned 0 — it is never a fallback to
-- budgets.monthly_limit. Falling back would make every month the user never
-- touched silently accrue (limit - spent) into the carry and manufacture a
-- phantom rolled-over balance on day one. Assignments are only ever created
-- by an explicit user action (typing one, or tapping "Fund targets"), so the
-- number on screen is always the number the walk rolls forward.
--
-- budgets keeps one row per category but its meaning shifts: monthly_limit is
-- now the rule-2 *funding target* (what you want to put in) rather than a
-- spending cap, and it gains:
--   rollover    — rule 3. Carry this category's leftover, or its overspend,
--                 into next month. On by default.
--   target_kind — 'monthly' (fund it every month) or 'by_date' (a sinking
--                 fund that should reach monthly_limit by target_date).
--   target_date — the deadline for a 'by_date' target.
-- monthly_limit becomes nullable so a category can carry rollover settings
-- without also having a target amount.
--
-- Additive on live data: one new table, three new columns, one relaxed NOT
-- NULL. Nothing is dropped or rewritten, and existing budget rows keep
-- working (an existing monthly_limit simply reads as a monthly target).
--
-- TIMING: paste at merge time, deploy-adjacent — not days early. Once this
-- runs, the branch's preview can write budgets rows with a NULL monthly_limit
-- (rollover/target edits), and the getBudgets DEPLOYED on main coerces NULL
-- to a $0.00 budget on the Categories tab. Old code never breaks (that is
-- what additive buys); it just misreads rows only the new code writes.

create table budget_months (
  household_id uuid not null default current_household_id() references households(id) on delete cascade,
  category text not null,
  -- Always the first of the month; the check keeps the primary key honest so
  -- two writers can't create '2026-07-01' and '2026-07-15' for one month.
  month date not null check (month = date_trunc('month', month)::date),
  assigned numeric(12, 2) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (household_id, category, month)
);

alter table budget_months enable row level security;

create policy budget_months_all on budget_months
  for all to authenticated
  using (household_id = current_household_id())
  with check (household_id = current_household_id());

alter table budgets add column rollover boolean not null default true;
alter table budgets add column target_kind text not null default 'monthly'
  check (target_kind in ('monthly', 'by_date'));
alter table budgets add column target_date date;
alter table budgets alter column monthly_limit drop not null;
