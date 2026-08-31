## Maintenance contract (the memory docs are memory for an AI coder)

Nearly all work here is done by AI sessions (Mason's direction). **The memory
is CLAUDE.md plus the docs/memory/ files** (restructured 2026-08-31, Mason:
CLAUDE.md capped at 100 lines): CLAUDE.md is the ONLY guaranteed-loaded piece —
a ≤100-line index whose job is routing a session to the right memory doc BEFORE
it edits — while these docs/memory/ files hold the rules and are read on
demand (the index's Memory map and the path-scoped `.claude/rules/` files both
point here); grep and `test/` are the other two channels. git history is
effectively invisible to a fresh session. Durable knowledge lives in a memory
doc or in a test, nowhere else. **Settled decisions are also APPENDED to
`docs/decisions.md`** (Mason, 2026-08-31 — the journal that keeps CLAUDE.md
from growing); the journal never replaces correcting the operative rule in its
memory doc. Deep history lives in git log, GitHub PRs, and the Vercel
dashboard — don't duplicate it.

- **Maintain the memory docs (and the CLAUDE.md index) in the same PR** as any change that settles a decision,
  changes the workflow, merges a branch, or adds a gotcha. When a code change
  makes a recorded rule false, correcting the rule is part of the SAME PR —
  rules rot exactly when the code moves.
- **Every rule carries its REASON and a greppable anchor that EXISTS** (a file,
  test, or constant) — `test/claudeMdLockstep.test.js` (built alongside this
  contract) asserts key-row anchors resolve. Never name a deleted identifier as
  current; past-tense names belong in ship-record sections (Merged features /
  Pending / Roadmap) only. (A key row named `visibleAtHide`, an export that
  never existed, until 2026-08-10 — see the phantom-reference Gotcha.)
- **One source of truth per fact.** Restating is how contradictions are born —
  point at the Key-files row or Convention instead. Record grep commands, never
  the numbers or lists they return: a frozen count goes stale the day the next
  feature merges (the `displayBalance` "exactly four" lesson).
- **A PR that replaces a decided model must same-PR grep for the retired
  design's VOCABULARY** — list the literal terms in the PR body ("purchase-based",
  "two models", old function names) and fix or annotate every hit across
  the memory docs, src comments, docs/ and test names; add the retired phrasing to
  the plan doc's refuted list. A rule whose premise died is worse than no rule:
  the pre-unification account-type wording stood three days and misled a
  session into telling Mason the opposite of the truth. Keep corrections
  visible IN the text ("the old wording here … is WRONG") so the next reader
  learns the failure shape.
- **History compresses.** A Merged-features entry collapses to a 1–3 line
  pointer once its rules are migrated to a durable section. The PR that ships
  (or supersedes) a plan-doc item marks it shipped/refuted in that SAME PR,
  noting what shipped instead when the design diverged (the item-8 lesson). A
  fully-spent process doc is DELETED in the ship PR (git holds it) after its
  durable reasoning migrates here; deleting any doc requires a same-PR grep for
  its filename so no referrer dangles. Delete scaffolding, tombstone decisions.
  **Mason can rule a spent doc KEPT** — every exemption is listed in Roadmap's
  doc inventory, which is the ONLY place that can license one, so a session
  applying this rule checks there before deleting.
- **The repo is PUBLIC — checked-in text carries no household PII.** No
  third-party personal names, no employer names, no exact household dollar
  figures in prose: use a role ("Zelle sender A", "employer C") and a rounded
  figure (~$31k), which is all any recorded ruling actually needs. What STAYS
  because it is load-bearing: real merchant/bank/issuer descriptors (the
  card-payment vocabulary pinned in `test/txClassify.test.js` is calibrated
  against them), bank-mask last-4s (they identify an account in an ops
  ruling), and any amount a test asserts on — round a comment, never a
  fixture. Scrubbed 2026-08-28; git history keeps the pre-scrub text and a
  history rewrite was declined that day, so the rule is about what NEW text
  says, not about the past.
- **A misstep that cost a session real time becomes a Gotcha in the same
  session**, while the cost is still known.
- **Session protocol**: the ONE standard flow lives in docs/memory/workflow.md —
  pull → build (tests + build + smoke, screenshots for UI) → push → PR →
  merge; absorb `origin/main` before every push AND before the merge (other
  sessions land work mid-session — verified again 2026-08-10).

