---
paths:
  - "supabase/**"
---

Database work. Use the /migration skill checklist; full rules in
`docs/memory/workflow.md` (rule 5) and the touched file's row in
`docs/memory/key-files.md`.

Hard invariants:
- Applied migration files are APPEND-ONLY history — never edit one that has
  been pasted to prod.
- Additive-only on live data; a DROP inverts the paste order (AFTER deploy).
- Every file must replay on a fresh EMPTY database, in order.
- PROD IS NEVER LINKED TO THE CLI — `db push` would replay the category
  wipe on live data.
- `setup_all.sql` is a TOMBSTONED destructive snapshot — never run on live
  data, never quote its self-check as schema evidence
  (`bootstrap_household.sql` is the real check).
- Verify with a readable SELECT; "Success. No rows returned" and `raise
  notice` prove nothing in the SQL Editor.
