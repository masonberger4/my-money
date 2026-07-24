-- SimpleFIN migration, phase 2: run the SimpleFIN feed ALONGSIDE Plaid.
--
-- Additive only — safe to paste into the Supabase SQL Editor on live data.
-- Nothing here touches Plaid: a Plaid-fed institution keeps its plaid_tokens
-- row and behaves exactly as before.
--
-- ---------------------------------------------------------------------------
-- simplefin_access — the claimed SimpleFIN access URL(s).
--
-- SimpleFIN inverts Plaid's model: ONE access URL covers EVERY institution the
-- user linked at SimpleFIN Bridge, so this is household-scoped, not
-- institution-scoped (that's why it isn't a column on institutions).
--
-- The URL embeds HTTP Basic credentials that can read the household's bank
-- data, so it gets exactly the plaid_tokens treatment: RLS enabled with ZERO
-- policies. authenticated users get nothing; only service_role (the api/
-- routes) can read or write it. Never expose it to the client.
--
-- household_id has NO default on purpose. Every write happens from api/ under
-- service_role, where auth.uid() is NULL and current_household_id() would
-- resolve to NULL (see the Gotchas section of CLAUDE.md) — so the routes set it
-- explicitly and a missing value fails loudly instead of writing an orphan row.
--
-- Normally there is exactly one row per household. The table allows more (a
-- second Bridge account, a re-claim after rotating credentials) and the sync
-- pulls each in turn; unique (household_id, access_url) makes re-claiming the
-- same URL idempotent rather than duplicating the pull.
-- ---------------------------------------------------------------------------
create table if not exists simplefin_access (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  access_url text not null,
  -- Watermark for the incremental pull's start-date, and the input to the
  -- pull throttle (SimpleFIN refreshes bank data about once a day; hammering
  -- the Bridge gains nothing).
  last_pulled_at timestamptz,
  -- Last non-fatal problem reported by the feed: SimpleFIN returns per-bank
  -- trouble as free-text strings in the response's "errors" array rather than
  -- as an HTTP error, so it is recorded here instead of on institutions.
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, access_url)
);

-- RLS on, no policies: authenticated users get nothing; service_role bypasses.
alter table simplefin_access enable row level security;

drop trigger if exists simplefin_access_touch_updated_at on simplefin_access;
create trigger simplefin_access_touch_updated_at
  before update on simplefin_access
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- institutions.simplefin_org_id — which SimpleFIN "org" (bank) this row came
-- from: org.id, else its domain, else its name (see orgKey() in
-- api/_lib/simplefin.js). Set on find-or-create during the SimpleFIN pull.
--
-- It doubles as the feed discriminator:
--   simplefin_org_id is null      => Plaid-fed (or the manual "Imported" one)
--   simplefin_org_id is not null  => SimpleFIN-fed
-- api/sync.js skips SimpleFIN-fed institutions in the Plaid pass, so they never
-- produce a bogus "no access token" result, and the two feeds can never
-- double-write the same institution.
-- ---------------------------------------------------------------------------
alter table institutions add column if not exists simplefin_org_id text;

-- One institution row per (household, SimpleFIN org). Partial so the many
-- existing Plaid/manual rows with a NULL org id don't collide.
create unique index if not exists institutions_household_simplefin_org_idx
  on institutions (household_id, simplefin_org_id)
  where simplefin_org_id is not null;
