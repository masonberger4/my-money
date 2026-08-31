---
name: memory-audit
description: The recurring doc-rot sweep over the memory docs — phantom references, retired vocabulary, ship-record compression, plan-doc re-verification, PII scan. Run periodically or before a doc-heavy PR.
---

CRITICAL: the contract is docs/memory/maintenance-contract.md — read it
first. The memory is CLAUDE.md (≤100-line index, cap pinned by
`test/claudeMdLockstep.test.js`) + docs/memory/*.md + docs/decisions.md.

Delegate the sweep to the **memory-auditor** agent, then apply its proposed
edits here. The sweep covers:

1. **Phantoms**: every backticked identifier in the durable sections must
   have a greppable definition; a confident reference to a deleted name
   terminates exactly the search that would falsify it. The lockstep test
   automates the scanned sections — the audit extends it to the rest of
   docs/.
2. **Retired vocabulary**: designs replaced since the last audit whose old
   terms still appear in memory docs, src comments, docs/, or test names.
3. **History compresses**: Merged-features entries whose rules have
   migrated to a durable section collapse to 1–3 line pointers; spent
   process docs are deleted (grep for the filename first so no referrer
   dangles; check the Roadmap doc inventory for Mason's KEPT exemptions).
4. **Plan doc**: re-verify docs/next-iteration-plan-2026-08-04.md item
   premises against current main; mark shipped/refuted items.
5. **PII**: the repo is public — no third-party personal names, employer
   names, or exact household dollar figures in prose (roles + rounded
   figures). New text only; git history stays.
6. Finish: `npm test 2>&1 | .claude/hooks/test-digest.sh` green (lockstep
   included), settled decisions appended to docs/decisions.md, everything
   in the SAME PR.
