-- Local Supabase stub for the RLS harness (test/rls.test.js).
-- Recreates just enough of the hosted platform for supabase/migrations to apply:
-- the three roles, the auth schema + auth.users + auth.uid(), a minimal storage
-- schema (buckets/objects/foldername), and the supabase_realtime publication.
-- NOT a Supabase replica — no GoTrue, no storage API, no grants beyond what the
-- migrations name.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text
);

-- The hosted auth.uid() reads the JWT claims GUC; the harness sets that GUC
-- directly with set_config('request.jwt.claims', ...) to impersonate a user.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  created_at timestamptz not null default now()
);
alter table storage.objects enable row level security;

-- Hosted storage.foldername returns every path segment EXCEPT the last (the
-- filename) — string_to_array minus its final element — so a single-segment
-- name has NO folder and (foldername(name))[1] is NULL. The receipts policy
-- scopes on segment [1]; keep these semantics or the harness tests a policy
-- hosted Supabase doesn't enforce.
create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1 : cardinality(string_to_array(name, '/')) - 1]
$$;

do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

grant usage on schema public, auth, storage to anon, authenticated, service_role;
-- Hosted Supabase grants the client roles table privileges on the storage
-- schema (the storage API queries as the requester's role); RLS on
-- storage.objects is what actually scopes access. Without this grant an
-- impersonated INSERT would die at the grant layer and the harness could
-- never exercise the receipts storage policy.
grant all on all tables in schema storage to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
