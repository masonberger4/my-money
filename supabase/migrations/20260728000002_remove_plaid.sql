-- SimpleFIN migration, phase 4: remove Plaid entirely.
--
-- The end state is SimpleFIN + CSV/PDF import, no Plaid. Phase 3 is done: every
-- Plaid account has already been removed from the live app, so nothing in the
-- database still depends on anything dropped here.
--
-- ===========================================================================
-- PASTE THIS *AFTER* THE CODE DEPLOY, NOT BEFORE.
-- ===========================================================================
-- Every other migration in this folder is ADDITIVE, so the usual order is
-- "SQL first, then merge". This one DROPS, which inverts the rule:
--
--   * New (Plaid-free) code against the OLD schema  -> fine. The dropped
--     columns are simply never referenced, and plaid_credential_key's
--     `not null default 'main'` fills itself in on any institution insert.
--   * Old (Plaid-aware) code against the NEW schema -> 500s. api/sync.js,
--     api/create-link-token.js, api/exchange-token.js and
--     api/unlink-institution.js all name plaid_credential_key in a select or
--     insert; PostgREST answers 42703 and the whole request fails, which takes
--     the SimpleFIN pass down with it because the institutions select runs
--     before both passes.
--
-- So: merge to main, wait for the Vercel production deploy to go green, THEN
-- paste this. The gap in that direction is inert (dead columns sitting unused).
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY *NOT* TOUCHED
-- ---------------------------------------------------------------------------
-- transactions.plaid_tx_id and accounts.plaid_account_id keep their names.
-- They are Plaid-named but ADAPTER-AGNOSTIC: they were born in the scraper era
-- as transactions.synthetic_id / accounts.adapter_account_id (20260605000001)
-- and merely renamed by 20260606000001. Today they hold every feed's external
-- id -- 'sfin:' (api/sync.js), 'csv:' (src/csvImport.js, for BOTH CSV and PDF --
-- there is no 'pdf:' namespace; the two are told apart by transactions.source) and
-- 'manual:' (src/dataAdapter.js) -- and they carry the two upsert conflict
-- targets that make a re-pull idempotent:
--   accounts     unique (institution_id, plaid_account_id)
--   transactions transactions_account_plaid_tx_unique (account_id, plaid_tx_id)
-- Renaming or dropping them would break every feed at once. Leave them alone.
--
-- institutions.sync_state also stays: it is a generic jsonb bag that
-- api/unlink-institution.js still resets, not a Plaid-shaped column.

-- ---------------------------------------------------------------------------
-- 0. PRE-FLIGHT: refuse to run while any Plaid Item is still live.
--
--    THIS HAS FIRED IN PRACTICE (2026-07-29, three rows), so the notes below
--    are what was actually learned rather than what was assumed.
--
--    Why it matters is NOT primarily billing. A Transactions Item is a live,
--    recurring, credentialed pull: Plaid keeps checking those institutions one
--    to four times a day for as long as the Item exists, independent of whether
--    any code calls it. Items never expire, never go dormant and are never
--    auto-reaped. So an Item left behind by a migration is a standing
--    authorisation to read the household's bank data, held on behalf of an
--    application that no longer exists.
--
--    Billing is real but usually $0 here: Transactions is a SUBSCRIPTION
--    product, so the fee accrues while the Item exists and /item/remove is what
--    ends it — but a team on the pre-2026-04-15 Limited Production tier accrues
--    it against nothing. Check the Plaid Dashboard usage page rather than
--    assuming either way.
--
--    An EXCEPTION, not a notice, because a notice cannot be acted on: by the
--    time this file is pasted the Plaid-free code is deployed, so nothing in
--    this repo can call itemRemove any more. Aborting is free — Plaid-free code
--    against the un-migrated schema is completely inert, so the database can
--    sit in this state indefinitely while the rows are dealt with.
--
--    CORRECTION to this file's original claim that dropping the table leaves
--    "nothing able to reach them": the access token is the CLEANEST route, not
--    the only one. Three others survive the drop —
--      * revoke at my.plaid.com (also ends subscription billing),
--      * delete the Plaid team, which removes its Items,
--      * a Plaid Support ticket, which can return the access_token list for a
--        client_id.
--    So this guard protects convenience and a clean exit, not recoverability.
--    Still: copy the tokens out and call /item/remove BEFORE deleting the
--    PLAID_* env vars, which is much easier than any of the above.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  if to_regclass('public.plaid_tokens') is null then return; end if;
  execute 'select count(*) from plaid_tokens' into n;
  if n > 0 then
    raise exception 'STOP: % plaid_tokens row(s) still exist. Those Plaid Items are still LIVE: Plaid keeps pulling those banks 1-4x a day on a standing authorisation, and Items never expire. Nothing has been changed. Copy the tokens out (select * from plaid_tokens), call POST /item/remove on each while the PLAID_* env vars still exist, then re-run this file.', n;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. plaid_tokens -- the access-token vault. Nothing else references it, so no
--    CASCADE: if some hand-made view in the SQL Editor does depend on it, this
--    should fail loudly rather than drop it silently.
-- ---------------------------------------------------------------------------
drop table if exists plaid_tokens;

-- ---------------------------------------------------------------------------
-- 2. institutions.plaid_credential_key -- which Plaid developer account linked
--    the Item. Meaningless without Plaid; the SimpleFIN orgs and the manual
--    "Imported" institution only ever carried its 'main' default.
-- ---------------------------------------------------------------------------
alter table institutions drop column if exists plaid_credential_key;

-- ---------------------------------------------------------------------------
-- 3. institutions.plaid_item_id -- the Plaid Item id, written once by
--    api/exchange-token.js and read by nothing. Dropping it also removes the
--    institutions_plaid_item_id_key UNIQUE index that came with it.
-- ---------------------------------------------------------------------------
alter table institutions drop column if exists plaid_item_id;

-- ---------------------------------------------------------------------------
-- 4. The 'needs_reauth' status VALUE.
--
--    Note this is NOT a column -- there has never been an
--    institutions.needs_reauth. 'needs_reauth' is one of four values allowed by
--    the institutions_status_check CHECK created inline in 20260605000001, and
--    api/sync.js is the only thing that ever wrote it (on Plaid's
--    ITEM_LOGIN_REQUIRED).
--
--    Dropping a column is a catalog-only change. RE-ADDING a CHECK is not: it
--    scans the table and ABORTS if any row violates it. institutions holds a
--    handful of rows so the scan is free, but the abort is real -- hence the
--    normalizing UPDATE below, which must run BEFORE the new constraint. It is
--    also why this step goes last: if it does abort, the SQL Editor's implicit
--    transaction rolls back steps 1-3 with it, leaving the database exactly as
--    it was rather than half-migrated.
--
--    A stranded 'needs_reauth' row would otherwise be unclearable forever --
--    the reconnect affordance that cleared it is being deleted with Plaid.
--    'error' is the honest replacement: it is still non-disabled, so sync.js
--    keeps picking the institution up.
--
--    Two drops, so the whole file stays safe to paste twice. The named drop is
--    what makes a RE-paste work (on the second run the constraint no longer
--    mentions 'needs_reauth', so a definition-based lookup alone would find
--    nothing and the add below would collide on the name). The lookup loop then
--    catches any differently-named check that still permits the value.
-- ---------------------------------------------------------------------------
alter table institutions drop constraint if exists institutions_status_check;

do $$
declare
  c text;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'institutions'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%needs_reauth%'
  loop
    execute format('alter table public.institutions drop constraint %I', c);
    raise notice 'dropped institutions check constraint %', c;
  end loop;
end $$;

update institutions set status = 'error' where status = 'needs_reauth';

alter table institutions
  add constraint institutions_status_check
  check (status in ('active', 'disabled', 'error'));

-- ---------------------------------------------------------------------------
-- 5. Self-check. Raises instead of reporting a green no-op if any step above
--    silently did nothing (e.g. an IF EXISTS that matched nothing because the
--    object was named differently than expected).
-- ---------------------------------------------------------------------------
do $$
declare
  leftover text[] := '{}';
begin
  if to_regclass('public.plaid_tokens') is not null then
    leftover := array_append(leftover, 'plaid_tokens table');
  end if;
  if exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'institutions'
        and column_name = 'plaid_credential_key') then
    leftover := array_append(leftover, 'institutions.plaid_credential_key');
  end if;
  if exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'institutions'
        and column_name = 'plaid_item_id') then
    leftover := array_append(leftover, 'institutions.plaid_item_id');
  end if;
  if exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'institutions'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%needs_reauth%'
  ) then
    leftover := array_append(leftover, e'\'needs_reauth\' still allowed by a CHECK');
  end if;
  if exists (select 1 from institutions where status = 'needs_reauth') then
    leftover := array_append(leftover, 'institutions rows still status=needs_reauth');
  end if;

  -- The two adapter-agnostic id columns must have SURVIVED.
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'transactions'
        and column_name = 'plaid_tx_id') then
    leftover := array_append(leftover, 'transactions.plaid_tx_id was DROPPED -- restore it');
  end if;
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'accounts'
        and column_name = 'plaid_account_id') then
    leftover := array_append(leftover, 'accounts.plaid_account_id was DROPPED -- restore it');
  end if;

  if array_length(leftover, 1) > 0 then
    raise exception 'remove_plaid migration incomplete: %', array_to_string(leftover, ', ');
  end if;
  raise notice 'Plaid removed: plaid_tokens, plaid_credential_key, plaid_item_id, needs_reauth status.';
end $$;
