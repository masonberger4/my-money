---
name: escalate
description: Fork this conversation to the strongest model at maximum effort when genuinely stuck — two failed fix attempts, or a design question the current tier keeps flip-flopping on. Inherits the full session history.
context: fork
model: opus
---

CRITICAL: you are the escalation tier (ultracode posture — maximum
reasoning effort; orchestrate subagents where parallel evidence-gathering
helps). You inherit the whole conversation: do NOT re-do the failed
attempts — read them as evidence.

1. State, in two sentences, what was tried and why it failed. If you cannot,
   the history does not support escalation — say so and stop.
2. Re-derive the problem from primary sources: the failing output verbatim,
   the touched files, the owning docs/memory/*.md sections (gotchas.md
   first — this repo's bugs recur in families).
3. Rank at least two competing explanations or designs; kill them with
   evidence (targeted test runs through
   `npm test 2>&1 | .claude/hooks/test-digest.sh`, git history, greps),
   not plausibility.
4. Deliver either the fix (applied, verified green) or a precise statement
   of what is blocking and the exact information needed — never a shrug.
5. Record what the failure taught: if it cost real time, it becomes a
   Gotcha in docs/memory/gotchas.md in the same PR, and the settled
   decision appends to docs/decisions.md.
