---
paths:
  - "api/**"
---

Server-side code (service_role, bank credentials). Read the touched file's
row in `docs/memory/key-files.md` and the Architecture section
(`docs/memory/architecture.md`) BEFORE editing.

Hard invariants:
- `simplefin_access` is never exposed to the client; RLS gives it zero
  client policies.
- 500 handlers return a GENERIC string + stable code, never raw error
  bodies (`test/apiErrorSanitize.test.js`).
- User-supplied URLs go through `fetchNoOpenRedirect` — plain fetch follows
  redirects into the metadata endpoint (docs/memory/gotchas.md).
- Nothing in the repo loads `api/*.js` except `test/apiLoads.test.js` — a
  dangling import ships green and 500s in prod. Run
  `node --test test/apiLoads.test.js` after ANY api/ edit.
- The SQL Editor / service_role has NULL `auth.uid()` — `household_id`
  defaults do not resolve server-side; set it explicitly.
- Design-level changes here (auth boundary, sync semantics, RLS) go to the
  architect agent first.
