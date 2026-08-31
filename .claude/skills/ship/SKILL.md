---
name: ship
description: The ONE standard flow end to end — pre-PR gate, push the feature branch, open the PR, arm auto-merge (squash), confirm the merge. Mason's standing auto-mode authorization.
disable-model-invocation: true
---

CRITICAL: this is the repo's standard flow (docs/memory/workflow.md rules
3–5). Run it exactly; skipping the absorb or the gate is how untested
combinations reach main.

1. Run the full **/pre-pr** gate (it absorbs origin/main and runs
   tests/build/smoke/review). Do not continue on any red.
2. Push: `git push -u origin <branch>` (branch = `claude/feature-<name>`,
   cut from current main). On network failure retry with backoff 2s/4s/8s/16s.
3. Open the PR (ready for review, not draft). No PR template exists; write a
   clear body. If the change replaces a decided design, list the retired
   VOCABULARY terms in the PR body (maintenance contract).
4. **Arm auto-merge (squash) immediately** — it is per-PR, not automatic;
   an unarmed green PR sits unmerged (the PR #73 lesson). Exception: a PR
   meant to accumulate more commits stays unarmed until its last push.
5. Confirm the merge landed (the required checks are "tests + build" and
   "render check"). An ARMED PR needs no babysitting — investigate only if
   CI goes red.

Migration PRs: hand Mason the exact SQL and the paste order FIRST —
additive SQL pastes BEFORE the merge; a DROP pastes only AFTER the deploy
is confirmed live (probe `POST /api/sync` for 401, not a 404). See
/migration for the full checklist.

Boundaries that survive auto mode: anything risky, preference-shaped, or
migration-sequenced still goes past Mason before merging.
