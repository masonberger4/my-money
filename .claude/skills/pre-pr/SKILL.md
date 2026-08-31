---
name: pre-pr
description: The pre-push gate — absorb origin/main, run tests/build/smoke digested, review the diff, security- and memory-check when relevant. Run before every push; /ship runs this then pushes.
---

CRITICAL (the gate, in order — do not skip a step, do not push from this
skill):

1. **Absorb main**: `git fetch origin` then
   `git rev-list --count HEAD..origin/main`. If non-zero:
   `git merge origin/main` (MERGE, never rebase — the branch may be pushed),
   resolve, and only then continue. Other sessions land work mid-session.
2. **Tests**: `npm test 2>&1 | .claude/hooks/test-digest.sh` — must be green.
3. **Build**: `VITE_SUPABASE_URL=https://placeholder.supabase.co VITE_SUPABASE_ANON_KEY=placeholder npm run build` — must succeed.
4. **Smoke + screenshots**: if the diff touches src/components/ or
   src/ui.css, delegate to the **ui-verifier** agent (walk + 390×844
   screenshots) — otherwise delegate the smoke walk to the **runner** agent.
5. **Review**: delegate the full diff to the **reviewer** agent; fix real
   findings and re-run the affected steps.
6. **Security pass**: if the diff touches api/, vercel.json, or supabase/,
   additionally review against docs/memory/architecture.md (service-role
   boundary, sanitized 500s, SSRF) — the /security-review skill if
   available, otherwise a reviewer-agent pass focused on those files.
7. **Memory**: if the diff settles a decision or changes workflow, delegate
   to the **memory-auditor** agent and apply its proposed edits (memory doc
   + docs/decisions.md, same PR).

Report each step's verdict in one line. The gate passes only when every
step is green. This skill never pushes — /ship owns that.
