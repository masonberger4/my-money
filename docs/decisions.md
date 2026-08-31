# Decision journal (append-only, newest last)

The contract (Mason, 2026-08-31): settled decisions from each work slice are
APPENDED here — date, one short entry each — so CLAUDE.md stays a ≤100-line
index. This file is the JOURNAL, not the rulebook: the operative rules live
in docs/memory/*.md, and a decision that changes a recorded rule still fixes
that rule in its memory doc in the SAME PR (the maintenance contract,
docs/memory/maintenance-contract.md, is unchanged on that point). Never
rewrite or delete an entry; a reversed decision gets a NEW entry pointing at
the one it reverses.

---

## 2026-08-31 — Model/effort routing + memory restructure (Mason approved)

- **CLAUDE.md is capped at 100 lines** (pinned by
  `test/claudeMdLockstep.test.js`). The 1,942-line memory moved VERBATIM
  into `docs/memory/` (maintenance-contract, architecture, key-files,
  workflow, conventions, ship-record, gotchas); CLAUDE.md became the
  always-loaded index that routes sessions to the right doc. The lockstep
  test now scans the concatenation, so the phantom/anchor guards follow the
  content.
- **This journal exists** (Mason: "make the docs/decisions.md file and point
  to it in the claude.md file") — chosen over growing CLAUDE.md; the
  one-source-of-truth rule survives via the paragraph above.
- **Per-agent model/effort routing** shipped in `.claude/` — table and
  tuning guidance in docs/claude-routing.md. Key calls:
  - No main-session model pin in .claude/settings.json — a repo-level pin
    would silently override the session's chosen model; per-agent routing
    does the differentiation without invalidating the prompt cache.
  - The architect agent runs at effort **ultracode** (Mason's revision —
    anything that would have been opus+max uses ultracode instead).
  - `.claude/rules/` files are POINTERS into docs/memory plus hard-invariant
    checklists, never restatements (the one-source-of-truth rule).
  - Bare `npm test` is hook-denied in favor of
    `npm test 2>&1 | .claude/hooks/test-digest.sh` — 5,700+ TAP lines must
    not enter the main context.
- **Accepted indirection**: src/api code comments and applied migrations
  still say "see CLAUDE.md <section>" — they are untouched (source
  constraint / append-only history); the index's Memory map carries the
  reader onward. Doc-file references were updated where the meaning broke.
- **Deferred, not built** (offered, not approved): a SessionStart npm-ci
  hook; a statusline surfacing context usage.
