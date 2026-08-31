# Claude routing setup (SETUP-NOTES, 2026-08-31)

What the 2026-08-31 configuration PR added, how to verify it, and how to
tune it. The decisions behind it are journaled in docs/decisions.md; the
memory restructure it rode with is described in
docs/memory/maintenance-contract.md.

## What was added

- **CLAUDE.md → ≤100-line index** (cap pinned by
  `test/claudeMdLockstep.test.js`); the full memory moved verbatim to
  `docs/memory/*.md`, and the lockstep test scans the concatenation.
- **`.claude/settings.json`** — permissions built from the real commands
  (allow: test/build/smoke/git flow; ask: `supabase *`, `vercel *`,
  force-push; deny: reading `.env`/`.env.local`), plus the PreToolUse hook
  wiring. Deliberately NO main-session `model` pin: per-agent routing does
  the tiering without touching the session model (which would invalidate
  the prompt cache mid-session).
- **Hooks** (`.claude/hooks/`, both executable, both degrade gracefully):
  - `test-digest.sh` — awk TAP digest; green → summary lines only, red →
    failing blocks verbatim + summary (exit 1), no-summary → full
    passthrough (exit 1, never hides a broken run). Needs only awk.
  - `pretooluse-test-guard.sh` — denies a BARE `npm test` with a pointer to
    the digest pipe / runner agent. Needs python3; missing python3 = allow.
- **`.claude/agents/`** — the routing table below.
- **`.claude/skills/`** — /pre-pr, /ship, /escalate, /cheap-pass,
  /migration, /memory-audit.
- **`.claude/rules/`** — path-scoped pointer checklists (api-server,
  migrations, dashboard-ui, pure-models, tests).
- **docs/decisions.md** — the append-only decision journal.
- **.gitignore** — `.claude/` un-ignored; `.claude/settings.local.json` and
  `.claude/memory/` stay local.

## Routing table

| Agent | Model | Effort | Trigger |
|---|---|---|---|
| Explore (overrides built-in) | haiku | low | any find/where/inventory sweep; first stop before reading big files |
| runner | haiku | low | every test/build/smoke execution |
| ui-verifier | sonnet | medium | diffs touching src/components/ or src/ui.css — walk + 390×844 screenshots |
| reviewer | sonnet | high | before every push — contract review of the diff |
| memory-auditor | sonnet | high | decision-settling diffs; periodic doc-rot sweeps |
| debugger | opus | xhigh | AFTER a failed fix / unclear failure / behavior contradicting recorded rules; not first-pass bugs |
| architect | opus | ultracode | schema/migration design, model-precedence changes, security-sensitive api/ design; not routine features |

Tiering principle: work that fails from lack of CAPABILITY gets a stronger
model (debugger, architect); work that fails from lack of DILIGENCE gets
higher effort on a mid model (reviewer, memory-auditor). Volume work runs
on haiku inside subagents so its context never enters the main window.

Note on `effort: ultracode` (architect): Mason's explicit choice — the
opus+max tier runs as ultracode (max reasoning + orchestration posture). If
a given Claude Code version rejects the value and falls back to default
effort, set it to `xhigh` and keep the body's instructions, which carry the
same posture.

## How to verify

1. `npm test 2>&1 | .claude/hooks/test-digest.sh` → green summary, incl.
   the lockstep suite (memory split + 100-line cap).
2. `echo '{"tool_name":"Bash","tool_input":{"command":"npm test"}}' | .claude/hooks/pretooluse-test-guard.sh`
   → deny JSON; the digest-pipe form → silence.
3. In a FRESH session (config loads at session start): ask "where is
   uncatBadge computed?" and confirm the Explore agent (haiku) handles it;
   run `/pre-pr` on a trivial diff and confirm runner/reviewer fire on
   their models (visible in the agent panel / transcript).
4. `wc -l CLAUDE.md` ≤ 100.

## Tuning guidance

- **Capability failure** (agent's answer is wrong/shallow) → raise its
  `model` one tier. **Diligence failure** (agent skipped files, bailed
  early) → raise its `effort`. Don't conflate the two.
- Start conservative; escalate only agents that underperform. The three to
  watch after a week of real use:
  1. **Explore on haiku** — if search conclusions miss things in
     Dashboard.jsx, try sonnet/low before abandoning the tier.
  2. **reviewer at sonnet/high** — if it misses contract violations the
     memory docs record, the fix is usually a sharper checklist item in its
     body, not a bigger model.
  3. **The npm-test guard** — if the deny annoys more than it saves,
     delete the hook entry from settings.json; the digest pipe and the
     runner agent still work without it.
- Path-scoped rules DROP OUT after compaction until a matching file is read
  again — rules that must always hold live in CLAUDE.md's Invariants, not
  in .claude/rules/. The Compact-instructions section tells the summary to
  record which memory docs were already read for the same reason.
- Deferred options (approved-by-silence as "not now"): a SessionStart hook
  running `npm ci` (~7–30s per session start, saves the first test run's
  stumble); a statusline surfacing context usage/model.

## Expected effect on token usage

- CLAUDE.md's always-loaded footprint drops from ~1,940 lines (~15–18k
  tokens in every session) to ~95 lines (~1k); the memory docs load only
  when their area is touched.
- A test run's ~5,700 TAP lines (~20k tokens) collapse to ~10 lines in the
  main context; red runs carry only the failures, verbatim.
- Dashboard.jsx exploration and check-running move to haiku subagents at a
  fraction of main-loop cost, and review loops run outside the main window.
