-- Amount-scoped learned categorization rules.
--
-- WHAT THIS DOES
-- ---------------------------------------------------------------------------
-- Today a learned rule is (household_id, merchant_key) -> category: teach
-- "ZELLE TRANSFER" once and EVERY Zelle transfer takes that category. The
-- household needs a narrower assertion — "Zelle Transfer for exactly $1,800.00
-- is Rent" — that lives BESIDE the generic rule for the same merchant instead
-- of replacing it.
--
-- So `category_rules` gains a nullable `amount`:
--   • amount IS NULL     -> the any-amount rule (every pre-existing row).
--   • amount IS NOT NULL -> matches only rows with that exact amount, in the
--                           app's sign convention (positive = money out).
-- src/txClassify.js gives an amount-scoped rule precedence over every
-- any-amount rule; length only breaks ties within a tier.
--
-- WHY TWO PARTIAL UNIQUE INDEXES AND NOT A 3-COLUMN PRIMARY KEY
-- ---------------------------------------------------------------------------
-- A PRIMARY KEY cannot contain a nullable column, and `amount` must be
-- nullable — NULL is what "any amount" means, and it is what every existing
-- row already is. The alternatives were both worse:
--
--   • NOT NULL with a sentinel (0, or NaN as "any"). `numeric` does accept
--     'NaN', but PostgREST round-trips it through JSON as the STRING "NaN",
--     which arrives in the client as a non-number that quietly fails every
--     `typeof === 'number'` guard in the matcher — a rule that silently stops
--     matching, the confidently-wrong failure shape this codebase refuses. 0 is
--     worse still: it is a legal (if useless) transaction amount.
--   • A single unique index over (household_id, merchant_key, amount). NULLs
--     are distinct in a unique index by default, so it would permit unlimited
--     duplicate any-amount rules for one merchant — exactly the uniqueness the
--     old PK provided. (NULLS NOT DISTINCT is PG15+; partial indexes work
--     everywhere and say what they mean.)
--
-- Two PARTIAL unique indexes express both rules exactly:
--   • one any-amount rule per (household, merchant_key);
--   • one rule per (household, merchant_key, amount) for scoped rules.
--
-- DEPLOY ORDER (CLAUDE.md, workflow rule 5) — INVERTED
-- ---------------------------------------------------------------------------
-- PASTE THIS **AFTER** THE DEPLOY IS CONFIRMED SERVING THE NEW BUILD.
--
-- The `add column` half is additive and harmless early, but this migration
-- also DROPS the primary key `category_rules_pkey`, and the OLD build teaches
-- a merchant with
--     upsert(..., { onConflict: 'household_id,merchant_key' })
-- which needs exactly that constraint to exist. Paste before the deploy and
-- every "teach this merchant" tap on the still-live old build fails with
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification" — while retraining is the household's daily task. The new
-- build does not use ON CONFLICT here at all (a partial index cannot be
-- inferred by ON CONFLICT either): it deletes the exact (merchant_key, amount)
-- slot and inserts, so it works both before and after this file is pasted.
--
-- Confirm the deploy is actually serving the new build first, and note that
-- after pasting, Vercel's Instant Rollback is a foot-gun rather than an escape
-- hatch.

alter table category_rules
  add column if not exists amount numeric;

comment on column category_rules.amount is
  'NULL = any-amount rule (the original shape). Non-null = matches only rows with this exact amount, app sign convention (positive = money out).';

-- Replace the PK with the two partial unique indexes. The PK's name is the
-- Postgres default for `primary key (household_id, merchant_key)`.
alter table category_rules
  drop constraint if exists category_rules_pkey;

create unique index if not exists category_rules_any_amount_key
  on category_rules (household_id, merchant_key)
  where amount is null;

create unique index if not exists category_rules_amount_key
  on category_rules (household_id, merchant_key, amount)
  where amount is not null;

-- VERIFICATION — run this as a SEPARATE statement and READ the booleans.
-- The SQL Editor does not surface `raise notice` and reports "Success. No rows
-- returned" for a DO block that quietly gave up (CLAUDE.md gotcha), so the
-- assertion has to be a SELECT a human can look at. Every column must be true.
select
  (select count(*) from information_schema.columns
     where table_name = 'category_rules' and column_name = 'amount') = 1
                                                   as amount_column_exists,
  (select count(*) from pg_indexes
     where tablename = 'category_rules'
       and indexname = 'category_rules_any_amount_key') = 1
                                                   as any_amount_index_exists,
  (select count(*) from pg_indexes
     where tablename = 'category_rules'
       and indexname = 'category_rules_amount_key') = 1
                                                   as scoped_amount_index_exists,
  -- the old PK really is gone (its presence would mean the drop silently
  -- matched nothing and duplicate-key behaviour is not what the code expects)
  (select count(*) from pg_constraint
     where conrelid = 'category_rules'::regclass and contype = 'p') = 0
                                                   as old_pk_dropped,
  -- every pre-existing rule stayed an any-amount rule
  (select count(*) from category_rules where amount is not null) = 0
                                                   as existing_rules_unscoped;
