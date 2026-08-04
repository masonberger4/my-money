-- User-owned category system: preserve-then-wipe the stored categories.
--
-- WHAT THIS DOES
-- ---------------------------------------------------------------------------
-- The app is moving to a model where it ships NO built-in categories: the user
-- creates every category (the `dash:cats` registry) and teaches which
-- transactions belong to it (`category_rules` + merchantKey). The seed taxonomy
-- (`ERA_CATEGORIES`) and the descriptor->category keyword table in
-- src/txClassify.js are deleted in the same PR, so every stored category label
-- that came from guessing now names a category that no longer exists anywhere
-- in the code. Mason's decision (2026-08-04): WIPE history to Uncategorized and
-- retrain.
--
-- This migration implements that wipe with the recorded safety amendment:
-- it PRESERVES the pre-wipe values instead of overwriting them in place.
--
--   1. adds nullable `legacy_mapped_category` / `legacy_user_category` to
--      `transactions` and copies the current values in;
--   2. archives `budgets` and `budget_months` into `legacy_budgets` /
--      `legacy_budget_months` (full row copies, incl. household_id);
--   3. sets `mapped_category = 'Uncategorized'` and `user_category = null` on
--      every row EXCEPT the mechanism categories (below);
--   4. deletes the now-orphaned `budgets` / `budget_months` rows.
--
-- REVERSIBLE
-- ---------------------------------------------------------------------------
-- Nothing is destroyed. To restore the pre-wipe state exactly:
--
--   update transactions
--      set mapped_category = legacy_mapped_category,
--          user_category   = legacy_user_category
--    where legacy_mapped_category is not null
--       or legacy_user_category is not null;
--
--   insert into budgets select * from legacy_budgets
--     on conflict do nothing;
--   insert into budget_months select * from legacy_budget_months
--     on conflict do nothing;
--
-- (The legacy columns/tables are additive and can be dropped in a much later
-- migration, once retraining has settled and nobody wants the old labels back.
-- Per CLAUDE.md a DROP inverts the deploy order — that is a separate file.)
--
-- DEPLOY ORDER (CLAUDE.md, workflow rule 5)
-- ---------------------------------------------------------------------------
-- This migration is ADDITIVE in schema terms (it adds columns and tables; it
-- drops nothing), so the normal rule applies: PASTE IT BEFORE THE MERGE, in
-- the Supabase SQL Editor. Old code ignores the new columns. But note the data
-- step is not order-neutral in the way a pure column-add is: between the paste
-- and the deploy, the OLD code renders a dashboard where everything reads
-- Uncategorized. That window is cosmetic and self-heals on deploy; do the
-- paste and the merge back to back.
--
-- MECHANISM CATEGORIES THAT MUST SURVIVE THE WIPE
-- ---------------------------------------------------------------------------
-- Three labels are mechanism, not taste, and are preserved on the rows that
-- carry them. Verified against src/spending.js and src/categoryMap.js:
--
--   * 'Transfers and card payments' (TRANSFER_CATEGORY). src/spending.js's
--     `isCardPaymentRow` reads it directly:
--         if (t.user_category) return t.user_category === TRANSFER_CATEGORY;
--     so an explicit user_category of this label is the user's own "this is a
--     card payment" verdict, and it VETOES the row out of `isSpend`. Wiping it
--     to null would hand those rows back to the descriptor test, and any row
--     whose wording doesn't look like a payment would start counting as
--     spending. CONCLUSION: preserving it is required — wiping it changes the
--     linked-boundary spending model's output.
--
--   * 'Return' (RETURN_CATEGORY). This one is SYNTHESISED at read time by
--     `applyAccountRules(category, amount, accountType)` — a credit-account row
--     with a negative amount returns 'Return' regardless of what is stored — so
--     in principle no stored value is load-bearing here. It is preserved anyway,
--     defensively and for symmetry: any row that does carry it stored keeps
--     agreeing with the synthesised value, and preserving costs nothing.
--     (`isSpend` never counts it either way: amount <= 0 returns false.)
--
--   * 'Uncategorized' is the wipe TARGET, so it survives trivially. This design
--     needs it more, not less: it is the honest "not taught yet" state.
--
-- Nothing else is mechanism. Every other stored label is taste and goes.
--
-- ORPHANED BUDGETS / BUDGET_MONTHS — DELETED, NOT LEFT (explicit choice)
-- ---------------------------------------------------------------------------
-- Both tables key on the RAW category label, and after the wipe every taste
-- label they name is gone from the taxonomy and from every transaction. Left in
-- place they would be invisible-but-live: the envelope walk starts at a
-- category's own first assignment, so a stale `budget_months` row would keep
-- the category walking (and carrying) forever, while the Budget tab could not
-- show it because the label is in no registry. That is exactly the
-- phantom-balance shape the "a missing budget_months row means assigned 0" rule
-- exists to prevent. So they are archived and deleted rather than left.
-- Rows keyed to the mechanism three are deleted too — `isBudgetableCategory`
-- has always refused them, so any such row is junk by definition.
-- ===========================================================================

-- 1. Preserve the transaction values ----------------------------------------

alter table transactions add column if not exists legacy_mapped_category text;
alter table transactions add column if not exists legacy_user_category text;

comment on column transactions.legacy_mapped_category is
  'Pre-wipe mapped_category, kept by 20260805000001 so the user-owned-category wipe is reversible. Read by nothing.';
comment on column transactions.legacy_user_category is
  'Pre-wipe user_category, kept by 20260805000001 so the user-owned-category wipe is reversible. Read by nothing.';

-- Idempotent: only fill legacy columns that are still empty, so re-running
-- this file after the wipe cannot overwrite the preserved values with
-- 'Uncategorized'/null.
update transactions
   set legacy_mapped_category = coalesce(legacy_mapped_category, mapped_category),
       legacy_user_category   = coalesce(legacy_user_category, user_category)
 where legacy_mapped_category is null
    or legacy_user_category is null;

-- 2. Archive the envelope/budget rows ---------------------------------------

create table if not exists legacy_budgets (like budgets including defaults);
create table if not exists legacy_budget_months (like budget_months including defaults);

-- Archives are service_role-only: RLS on, zero policies (the simplefin_access
-- shape). They are a restore source for an operator, not app data.
alter table legacy_budgets enable row level security;
alter table legacy_budget_months enable row level security;

insert into legacy_budgets select * from budgets;
insert into legacy_budget_months select * from budget_months;

-- 3. The wipe ----------------------------------------------------------------

update transactions
   set mapped_category = 'Uncategorized'
 where mapped_category is distinct from 'Uncategorized'
   and coalesce(mapped_category, '') not in ('Transfers and card payments', 'Return');

update transactions
   set user_category = null
 where user_category is not null
   and user_category not in ('Transfers and card payments', 'Return');

-- 4. Drop the orphans (already archived above) --------------------------------

delete from budget_months;
delete from budgets;

-- ===========================================================================
-- VERIFICATION — run this as a separate statement and READ THE ROW.
-- The SQL Editor hides `raise notice`, and "Success. No rows returned" is not
-- evidence of anything, so the assertion has to be something you can see.
-- Every column must read true.
-- ===========================================================================
select
  -- nothing lost: every row that had a category has it preserved
  (select count(*) from transactions
     where legacy_mapped_category is null and mapped_category is not null
   ) = 0                                                as preserved_all_mapped,
  -- the wipe landed: no taste labels left in mapped_category
  (select count(distinct mapped_category) from transactions
     where mapped_category not in
       ('Uncategorized', 'Transfers and card payments', 'Return')
   ) = 0                                                as mapped_wiped,
  -- ...nor in user_category
  (select count(*) from transactions
     where user_category is not null
       and user_category not in ('Transfers and card payments', 'Return')
   ) = 0                                                as user_category_wiped,
  -- mechanism rows survived
  (select count(*) from transactions
     where mapped_category = 'Transfers and card payments'
        or user_category   = 'Transfers and card payments'
   ) = (select count(*) from transactions
     where legacy_mapped_category = 'Transfers and card payments'
        or legacy_user_category   = 'Transfers and card payments'
   )                                                    as transfers_preserved,
  -- budgets archived before deletion, and now empty
  (select count(*) from budgets) = 0                    as budgets_cleared,
  (select count(*) from budget_months) = 0              as budget_months_cleared,
  (select count(*) from legacy_budgets)                 as archived_budgets,
  (select count(*) from legacy_budget_months)           as archived_budget_months;
