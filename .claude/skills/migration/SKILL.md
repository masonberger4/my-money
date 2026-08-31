---
name: migration
description: The Supabase migration checklist — additive-only rules, paste order vs deploy order, fresh-install replay safety, and the visible verification SELECT. Use for any change under supabase/migrations/.
disable-model-invocation: true
---

CRITICAL rules (full reasoning: docs/memory/workflow.md rule 5 +
docs/memory/gotchas.md):

1. **Additive-only on live data** (`alter table … add column if not exists`).
   Never add a column to an already-published `create table if not exists`
   body — that is a no-op on a database that already ran it.
2. **Paste order**: additive SQL pastes BEFORE the merge (old code ignores
   new columns). A migration that DROPS inverts the order — paste only
   AFTER the deploy is confirmed live, because old code naming a dropped
   column 500s, and Vercel Instant Rollback then becomes a foot-gun. Confirm
   the deploy by probing `POST /api/sync` for a **401** (a 404 proves
   nothing; a module-load failure is a 500).
3. **Fresh-install safety**: every file must replay in order on a fresh
   EMPTY database (`supabase db push` — docs/SETUP.md Path A). No file may
   assume rows or an already-applied state.
4. **PROD IS NEVER LINKED TO THE CLI.** Mason pastes into the SQL Editor,
   permanently. `supabase link`/`db push` exist only for building a new
   empty project.
5. **Verify with a readable SELECT, never trust "Success"**: the SQL Editor
   hides `raise notice`, and the Editor runs as service_role (auth.uid() is
   NULL — defaults don't resolve). `supabase/bootstrap_household.sql` is the
   per-fact boolean check; extend it when a migration adds objects it should
   cover.
6. Applied migration files are **append-only history** — never edit one
   that has been pasted; corrections go in the memory docs.
7. Hand Mason the exact SQL and the paste order in the PR/summary — the
   architect agent designs anything schema-shaped first.
