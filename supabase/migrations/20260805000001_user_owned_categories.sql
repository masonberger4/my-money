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
--   1. adds nullable `legacy_mapped_category` / `legacy_user_category` plus the
--      `legacy_categories_saved` marker to `transactions` and copies the
--      current values in;
--   2. archives `budgets`, `budget_months` and `category_rules` into
--      `legacy_budgets` / `legacy_budget_months` / `legacy_category_rules`
--      (full row copies, incl. household_id);
--   3. sets `mapped_category = 'Uncategorized'` and `user_category = null` on
--      every row EXCEPT the mechanism categories (below);
--   4. deletes the now-orphaned `budgets` / `budget_months` / `category_rules`
--      rows.
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
--   insert into category_rules select * from legacy_category_rules
--     on conflict do nothing;
--
-- (The legacy columns/tables are additive and can be dropped in a much later
-- migration, once retraining has settled and nobody wants the old labels back.
-- Per CLAUDE.md a DROP inverts the deploy order — that is a separate file.)
--
-- DEPLOY ORDER (CLAUDE.md, workflow rule 5)
-- ---------------------------------------------------------------------------
-- PASTE THIS **AFTER** THE DEPLOY IS CONFIRMED SERVING THE NEW BUILD.
--
-- The schema half is additive (columns and tables; nothing is dropped), so the
-- usual paste-before-merge rule would be fine for it. The DATA half is not:
-- the OLD build still contains the keyword classifier and derives
-- `mapped_category` at WRITE time (api/sync.js -> classifyDescription, same in
-- the CSV/PDF importer), and a server-side sync fires on an ordinary dashboard
-- load — which is exactly what an operator does right after pasting, to see
-- what happened. Any row written in that window lands with a taste label the
-- deployed-a-minute-later code no longer knows about, AND with
-- `legacy_categories_saved = false` but no legacy value, so it is neither
-- wiped nor preserved. It also makes this file's own `mapped_wiped` assertion
-- read false, indistinguishable from a failed wipe. The window does NOT
-- self-heal.
--
-- Nothing in the new code needs this migration to have run first: the new
-- build never reads the legacy columns or archive tables, and reads
-- 'Uncategorized' rows perfectly well. So the safe order is merge -> confirm
-- the deploy is live -> paste. If it was pasted early anyway, re-run steps 3
-- and 4 (the UPDATEs and DELETEs) once the deploy is live — but do NOT re-run
-- step 1: the `legacy_categories_saved` marker exists so a re-run cannot
-- launder post-wipe labels into the archive.
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
-- The marker, not column-nullness, is what says "this row's pre-wipe values are
-- recorded". A row whose mapped_category was legitimately NULL preserves as
-- NULL, so `legacy_mapped_category is null` cannot distinguish "nothing to
-- preserve" from "never processed" — and using it as the gate would let a
-- re-run write the POST-wipe 'Uncategorized' into the archive as if it were the
-- original value.
alter table transactions add column if not exists legacy_categories_saved boolean not null default false;

comment on column transactions.legacy_mapped_category is
  'Pre-wipe mapped_category, kept by 20260805000001 so the user-owned-category wipe is reversible. Read by nothing.';
comment on column transactions.legacy_user_category is
  'Pre-wipe user_category, kept by 20260805000001 so the user-owned-category wipe is reversible. Read by nothing.';

comment on column transactions.legacy_categories_saved is
  'True once 20260805000001 recorded this row''s pre-wipe categories. The idempotency gate — NULL legacy values are a legitimate preserved state. Read by nothing.';

-- Idempotent via the marker: a re-run skips every already-processed row, so it
-- can never overwrite a preserved value with the post-wipe 'Uncategorized'.
update transactions
   set legacy_mapped_category = mapped_category,
       legacy_user_category   = user_category,
       legacy_categories_saved = true
 where not legacy_categories_saved;

-- 2. Archive the envelope/budget rows ---------------------------------------

create table if not exists legacy_budgets (like budgets including defaults);
create table if not exists legacy_budget_months (like budget_months including defaults);
create table if not exists legacy_category_rules (like category_rules including defaults);

-- Archives are service_role-only: RLS on, zero policies (the simplefin_access
-- shape). They are a restore source for an operator, not app data.
alter table legacy_budgets enable row level security;
alter table legacy_budget_months enable row level security;
alter table legacy_category_rules enable row level security;

-- The DELETE below is the one irreplaceable step in this file (budget_months
-- holds every month's `assigned` and `target_override`, reconstructible from
-- nothing). A raw archive count can't tell "archived 0 rows" from "there were
-- no envelopes", so record the pre-delete counts and let the verification
-- assert archived = pre as a BOOLEAN. Same reasoning as the transactions half's
-- preserved_all_mapped, applied to the half that actually destroys rows.
create table if not exists legacy_wipe_counts (
  step        text primary key,
  pre_count   bigint not null,
  recorded_at timestamptz not null default now()
);
alter table legacy_wipe_counts enable row level security;

insert into legacy_wipe_counts (step, pre_count)
select 'budgets', count(*) from budgets
on conflict (step) do nothing;
insert into legacy_wipe_counts (step, pre_count)
select 'budget_months', count(*) from budget_months
on conflict (step) do nothing;
insert into legacy_wipe_counts (step, pre_count)
select 'category_rules', count(*) from category_rules
on conflict (step) do nothing;

insert into legacy_budgets select * from budgets;
insert into legacy_budget_months select * from budget_months;
insert into legacy_category_rules select * from category_rules;

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

-- category_rules goes too, and it is NOT optional. Each rule maps a merchantKey
-- to a taste label from the taxonomy this migration is deleting, and with the
-- keyword table gone learned rules are the ONLY categorizer left: leave one in
-- place and the next sync writes 'Groceries' back onto a fresh SAFEWAY row.
-- That label then re-enters the app through the one category list (Dashboard's
-- userCategoryList admits any non-mechanism name observed on a row), so a
-- category the user never created reappears in Categories, Budget, every picker
-- and the Tax mapping selects — with no budget row behind it, and with the same
-- merchant's wiped history sitting in Uncategorized beside it. The rules were
-- also taught FROM the user_category values this file wipes, so keeping them
-- while wiping their source is incoherent in both directions. "Wipe and
-- retrain" (Mason, 2026-08-04) means the rules retrain too; they are archived
-- in legacy_category_rules, so the old mappings are readable if a merchant list
-- is wanted as a teaching aid.
delete from category_rules;

-- ===========================================================================
-- VERIFICATION — run this as a separate statement and READ THE ROW.
-- The SQL Editor hides `raise notice`, and "Success. No rows returned" is not
-- evidence of anything, so the assertion has to be something you can see.
-- Every BOOLEAN column must read true. The three trailing `archived_*` counts
-- are informational only — their assertion is the `*_archived_ok` booleans
-- above, so a zero there is never something to eyeball and judge.
-- ===========================================================================
select
  -- nothing lost: every row has been through step 1. The marker is the test,
  -- not `legacy_mapped_category is null` — a row whose mapped_category was
  -- legitimately NULL preserves as NULL, and reading that as data loss would
  -- fire this alarm on a perfectly healthy run.
  (select count(*) from transactions where not legacy_categories_saved
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
  -- budgets/rules archived before deletion, and now empty
  (select count(*) from budgets) = 0                    as budgets_cleared,
  (select count(*) from budget_months) = 0              as budget_months_cleared,
  (select count(*) from category_rules) = 0             as rules_cleared,
  -- ...and the archive really captured them. Booleans, because "archived 0" and
  -- "there were none" are the same row otherwise, and the DELETE has already run.
  (select count(*) from legacy_budgets)
    = (select pre_count from legacy_wipe_counts where step = 'budgets')
                                                        as budgets_archived_ok,
  (select count(*) from legacy_budget_months)
    = (select pre_count from legacy_wipe_counts where step = 'budget_months')
                                                        as budget_months_archived_ok,
  (select count(*) from legacy_category_rules)
    = (select pre_count from legacy_wipe_counts where step = 'category_rules')
                                                        as rules_archived_ok,
  -- Informational, printed alongside so the numbers are visible too.
  (select count(*) from legacy_budgets)                 as archived_budgets,
  (select count(*) from legacy_budget_months)           as archived_budget_months,
  (select count(*) from legacy_category_rules)          as archived_category_rules;
