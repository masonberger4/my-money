---
paths:
  - "test/**"
---

The test suite is the repo's third memory channel — pins ARE documentation.
Read the `test/` row in `docs/memory/key-files.md` for the full inventory.

Hard invariants:
- Never delete or loosen a REGRESSION pin to get green — the pin records a
  bug that shipped. Understand what it guards first
  (docs/memory/gotchas.md usually has the story).
- `test/smoke/` is CHECKED IN and CI runs it: new dataAdapter exports need
  `test/smoke/mocks/` stubs (`test/smokeMocks.test.js` names what's
  missing); new views/controls need `data-mm-*` walk coverage.
- Source-scan guards grep case-INSENSITIVELY (`/name/i`) — the setter
  survives the getter's spelling (the `setPickingCat` gotcha).
- Repo-scan tests normalize paths to POSIX before comparing (the Windows
  backslash gotcha) and derive from the SOURCE OF TRUTH, never from the
  artifact they check.
- `test/claudeMdLockstep.test.js` scans CLAUDE.md + docs/memory/ — memory
  edits and identifier renames go together, same PR.
- `test/claudeConfigGuards.test.js` pins the `.claude/` hooks (by piping
  hook JSON at them), the outline helper, the digest, the agent/rule/skill
  size caps, and the routing table ↔ frontmatter lockstep — a hook, agent,
  or docs/claude-routing.md table edit and this test move together.
- Run everything through the digest: `npm test 2>&1 | .claude/hooks/test-digest.sh`.
