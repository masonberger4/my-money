-- Per-month funding-target override. NULL = no override for that month —
-- targetNeed falls back to the category-level budgets.monthly_limit.
-- The zero-row-equivalence rule applies to ASSIGNED only: a row with
-- assigned = 0 and a non-null target_override is a real row and must not be
-- treated as (or deleted as) an empty one.
--
-- Timing caveat: until the new client deploys, the deployed setAssigned(…, 0)
-- DELETE can drop a row carrying only an override written from a preview.
-- Accepted — previews share prod, the window is minutes at merge time.
alter table budget_months add column if not exists target_override numeric(12, 2);
