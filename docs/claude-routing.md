# Claude routing setup (SETUP-NOTES, 2026-08-31; token guards 2026-09-04)

What the 2026-08-31 configuration PR added, what the 2026-09-04 token-guard
PR added on top, how to verify it, and how to tune it. The decisions behind it are journaled in docs/decisions.md; the
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
  - `pretooluse-test-guard.sh` — REWRITES a bare `npm test` to the digest
    pipe (PreToolUse `updatedInput` + allow; it DENIED until 2026-09-04 —
    the deny cost a refusal-and-retry round trip every time). Needs
    python3; missing python3 = allow.
  - `pretooluse-read-guard.sh` (2026-09-04) — denies a WHOLE-FILE Read (no
    `limit`) or a bare `cat` of any text file over 1,000 lines, naming the
    real line count, a token estimate, and the substitutes (grep, the
    outline map, a ranged Read, the Explore agent). Ranged reads, piped or
    redirected cats, binaries, and every memory doc pass. Wired on BOTH
    the Read matcher and `Bash(cat *)`; settings hooks also fire inside
    subagents, so Explore is held to it too.
  - `outline.sh` (2026-09-04) — not a hook: the line-numbered structure
    map the read guard points at (functions at any depth, hook/arrow
    bindings, effects, `tab===` view branches, banners; headings for .md,
    DDL for .sql). Dashboard.jsx → ~290 lines instead of 8,000.
- **`.claude/agents/`** — the routing table below. Since 2026-09-04 every
  agent also carries `maxTurns` (a runaway backstop at 2–3× its expected
  turn count; hitting it returns the output marked partial, resumable) and
  a report-length cap in its body — the report is what lands in the main
  context. The reviewer reads `--stat` first and excludes
  `package-lock.json` from the diff it reads.
- **`test/claudeConfigGuards.test.js`** (2026-09-04) — pins all of the
  above by exercising it: pipes hook JSON at both guards (rewrite / deny /
  silent cases), runs the outline helper and the digest on synthetic TAP,
  and caps agent bodies (70 lines), rules (40), skills (45), descriptions
  (320 chars — every description rides in every session's system prompt).
- **`.claude/skills/`** — /pre-pr, /ship, /escalate, /cheap-pass,
  /migration, /memory-audit.
- **`.claude/rules/`** — path-scoped pointer checklists (api-server,
  migrations, dashboard-ui, pure-models, tests).
- **docs/decisions.md** — the append-only decision journal.
- **.gitignore** — `.claude/` un-ignored; `.claude/settings.local.json` and
  `.claude/memory/` stay local.

## Routing table

| Agent | Model | Effort | maxTurns | Report cap | Trigger |
|---|---|---|---|---|---|
| Explore (overrides built-in) | haiku | low | 30 | 20 lines | any find/where/inventory sweep; first stop before reading big files |
| runner | haiku | low | 30 | <10 lines green; failures verbatim | every test/build/smoke execution |
| ui-verifier | sonnet | medium | 60 | 30 lines | diffs touching src/components/ or src/ui.css — walk + 390×844 screenshots |
| reviewer | sonnet | high | 60 | 40 lines | before every push — contract review of the diff |
| memory-auditor | sonnet | high | 60 | exact edits only | decision-settling diffs; periodic doc-rot sweeps |
| debugger | opus | xhigh | 100 | 60 lines | AFTER a failed fix / unclear failure / behavior contradicting recorded rules; not first-pass bugs |
| architect | opus | ultracode | 80 | 80 lines | schema/migration design, model-precedence changes, security-sensitive api/ design; not routine features |

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
   the lockstep suite (memory split + 100-line cap) and the config-guards
   suite (hooks, outline, digest, size caps — it pipes the hook JSON
   itself, so the manual echo checks below are only for a live look).
2. `echo '{"tool_name":"Bash","tool_input":{"command":"npm test"}}' | .claude/hooks/pretooluse-test-guard.sh`
   → allow JSON carrying `updatedInput` with the digest pipe; the piped
   form → silence.
   `echo '{"tool_name":"Read","tool_input":{"file_path":"'$PWD'/src/components/Dashboard.jsx"}}' | .claude/hooks/pretooluse-read-guard.sh`
   → deny JSON naming 8,0xx lines and the outline command; add
   `"limit":80` → silence. `.claude/hooks/outline.sh src/components/Dashboard.jsx | wc -l` → ~290.
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
  3. **The npm-test guard** — since 2026-09-04 it rewrites rather than
     denies, so there is nothing to annoy; the only reason to delete its
     settings.json entry is a CLI without `updatedInput` (next section).
     The digest pipe and the runner agent work without it either way.
- **Test-guard rewrite** relies on PreToolUse `updatedInput` (documented,
  no version gate). If a bare `npm test` ever dumps full TAP in a session,
  the CLI running it predates the field: the `additionalContext` note is
  the tell (absent), and the fix is the pre-2026-09-04 deny form of the
  hook (git history), not removing the hook.
- **Read-guard threshold**: `BIG_LINES` at the top of
  `.claude/hooks/pretooluse-read-guard.sh` (default 1,000; per-machine
  override `MM_READ_GUARD_LINES`). It sits above every docs/memory file on
  purpose — conventions.md (760+ lines) is meant to be read whole when
  working on money math. If a memory doc ever crosses it, split the doc,
  don't raise the knob. A deny on a file you truly need whole: two ranged
  Reads cost the same tokens; the guard only removes the accidental case.
- **maxTurns**: a partial return means the backstop fired — first ask
  whether the task was too big for one agent (split it), and only then
  raise the number. The caps are 2–3× the observed need, not tight.
- **Report caps** are prompt instructions, not enforced; an agent that
  overruns is a prompt-sharpening problem (see the reviewer note above).
- **Size caps in the config test** are the always-loaded budget; raise one
  only with a reason in the same PR, never to fit a body that should have
  been a memory-doc pointer.
- Path-scoped rules DROP OUT after compaction until a matching file is read
  again — rules that must always hold live in CLAUDE.md's Invariants, not
  in .claude/rules/. The Compact-instructions section tells the summary to
  record which memory docs were already read for the same reason.
- Deferred options (approved-by-silence as "not now"): a SessionStart hook
  running `npm ci` (~7–30s per session start, saves the first test run's
  stumble); a statusline surfacing context usage/model.

## Token-cost ledger (2026-09-04)

Each known sink, what it costs when it happens, and the cheap substitute
the setup now steers to (or enforces). Estimates are bytes/4; measure a
real session from its transcript (`/cost`, or the per-tool-result sizes
in `~/.claude/projects/<project>/<session>.jsonl`) before tuning further.

| Sink | Cost per occurrence | Substitute | Enforced? |
|---|---|---|---|
| Bare `npm test` | ~20k tokens (5,700 TAP lines) | digest pipe: ~10 lines green, failures verbatim red | yes — rewritten by hook |
| Whole-file Read of Dashboard.jsx | ~30k (the 2,000-line default cap; ~125k in full) | grep -n / outline.sh (~290 lines, ~4k) then a ranged Read | yes — read guard |
| Whole-file Read of package-lock.json, dataAdapter.js, CsvImport.jsx | ~20–25k each | `git diff --stat`, `npm ls <pkg>`, grep, ranged Read | yes — read guard |
| Bare `cat` of any of the above | same as the Read | pipe it (`cat f \| grep`) or `sed -n 'A,Bp'` | yes — read guard on `Bash(cat *)` |
| Reviewer reading a lockfile diff | thousands of lines | `--stat` + `package.json` diff; exclude the lockfile | prompt (reviewer body) |
| A subagent's report | unbounded → main context | per-agent line cap (table above) | prompt + config test pins the text exists |
| A runaway subagent | unbounded turns | `maxTurns` backstop, partial + resumable | yes — frontmatter |
| Always-loaded config | ~1k (CLAUDE.md) + every agent/skill description | 100-line index; 320-char descriptions; bodies ≤70/45/40 lines | yes — lockstep + config test |
| `npm run build` output | ~30 lines | none needed (measured 2026-09-04: 29 lines, 1.6 KB) | — |
| Smoke walk output | ~3 lines | none needed; the vite log already goes to a file | — |

## Considered and rejected (2026-09-04)

- **Persistent agent memory** (`memory: project` on Explore, a
  `.claude/agent-memory/` directory): it would cache Dashboard.jsx
  knowledge across sessions, but it is a second, un-audited memory that
  the maintenance contract forbids (durable knowledge lives in a memory
  doc or a test, nowhere else) and the exact shape the phantom-reference
  Gotcha warns about: a confident stale note ends the search that would
  falsify it. The outline helper gives the same map, fresh, for ~4k tokens.
- **Lowering `BASH_MAX_OUTPUT_LENGTH`** via settings `env`: the 30,000-char
  default is the ceiling on a red digest with many failures; cutting it
  would truncate exactly the output that must stay verbatim.
- **A build/smoke digest**: measured at 29 and ~3 lines — nothing to save.
- **A guard on `head`/`tail`/`sed`**: `head -n 40 f` and `sed -n 'A,Bp'`
  are the ranged reads the guard steers TO; policing their arguments would
  be more code than tokens saved. `cat` is the only bare dump worth a rule.
- **Capping the GitHub Actions runs** (`--max-turns` on claude.yml): a
  mention run cut off mid-fix is worse than a long one; left alone.
- Still deferred, unchanged from 2026-08-31: the SessionStart npm-ci hook
  and the statusline.

## Expected effect on token usage

- CLAUDE.md's always-loaded footprint drops from ~1,940 lines (~15–18k
  tokens in every session) to ~95 lines (~1k); the memory docs load only
  when their area is touched.
- A test run's ~5,700 TAP lines (~20k tokens) collapse to ~10 lines in the
  main context; red runs carry only the failures, verbatim.
- Dashboard.jsx exploration and check-running move to haiku subagents at a
  fraction of main-loop cost, and review loops run outside the main window.
- (2026-09-04) A whole-file read of a big file can no longer happen by
  accident in any context, main or subagent; a bare `npm test` costs the
  digest, not a refusal plus a retry; every subagent report is bounded;
  and the config test turns a silent regression of any of it into a red
  test.
