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
  - `pretooluse-test-guard.mjs` — REWRITES a bare `npm test` or `node
    --test` to the digest pipe (PreToolUse `updatedInput` + allow; the
    2026-08-31 form DENIED, and the deny cost a refusal-and-retry round
    trip every time). Node, not sh+python3, since 2026-09-04: node is the
    one runtime this repo guarantees, and the python3 form was silently
    inert on a Windows shell without python3.
  - `pretooluse-read-guard.mjs` (2026-09-04) — denies a WHOLE-FILE Read (no
    `limit`) or a bare `cat` of any text file over 1,000 lines OR 64 KB,
    naming the real size, a token estimate, the substitutes (grep, the
    outline map, a ranged Read, the Explore agent) and the deliberate form
    (`limit:<line count>`). Ranged reads, piped or redirected cats,
    binaries, and every memory doc except key-files.md pass — that one is
    a few lines but wide (`wc -lc docs/memory/key-files.md`), a per-file
    table every rule says to read one ROW of. Wired on
    BOTH the Read matcher and `Bash(cat *)`; settings hooks also fire
    inside subagents, so Explore is held to it too.
  - `outline.sh` (2026-09-04) — not a hook: the line-numbered structure
    map the read guard points at (functions at any depth, hook/arrow
    bindings, effects, `tab===` view branches, banners; headings and
    backticked-path table rows for .md, DDL for .sql). Run it on
    Dashboard.jsx or key-files.md and Read the range you need.
  - `session-tokens.mjs` (2026-09-04) — not a hook: the measurement tool.
    `node .claude/hooks/session-tokens.mjs <transcript.jsonl>` prints turns
    and tokens per model plus the ten largest tool results with the tool and
    its target — the numbers to tune the guards against.
- **`.claude/agents/`** — the routing table below. Since 2026-09-04 every
  agent also carries `maxTurns` (a runaway backstop at 2–3× its expected
  turn count; hitting it returns the output marked partial, resumable) and
  a report-length cap in its body — the report is what lands in the main
  context. The reviewer reads `--stat` first and excludes
  `package-lock.json` from the diff it reads.
- **`test/claudeConfigGuards.test.js`** (2026-09-04) — pins all of the
  above by exercising it: pipes hook JSON at both guards (rewrite / deny /
  silent cases), runs the outline helper, the digest (synthetic TAP) and
  the token report (fixture transcript); pins the settings.json wiring
  (matchers + `if:` filters, the one part a piped test cannot exercise);
  locksteps the routing table below to each agent's frontmatter (model,
  effort, maxTurns — exact, with an injection self-check); asserts every
  backticked repo path in `.claude/**/*.md` exists; and caps the
  always-loaded footprint in lines AND bytes (agent bodies 70 lines with a
  report cap present, rules 40, skills 45, descriptions 320 chars each /
  3,500 total, CLAUDE.md 7,000 bytes and no line over 200 chars).
- **`.github/workflows/ci.yml`** (2026-09-04) — the `tests + build` job runs
  `npm test` through the digest under `set -o pipefail`, so a red job's log
  tail (what `get_job_logs` returns) is the failures, not the last 500 of
  5,700 `ok` lines. Job names unchanged; the ruleset still gates on them.
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
| Explore (overrides built-in) | haiku | low | 30 | 20 lines (lookup) / every hit, grouped (sweep) | any find/where/inventory sweep; first stop before reading big files |
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
2. `echo '{"tool_name":"Bash","tool_input":{"command":"npm test"}}' | node .claude/hooks/pretooluse-test-guard.mjs`
   → allow JSON carrying `updatedInput` with the digest pipe; the piped
   form → silence.
   `echo '{"tool_name":"Read","tool_input":{"file_path":"'$PWD'/src/components/Dashboard.jsx"}}' | node .claude/hooks/pretooluse-read-guard.mjs`
   → deny JSON naming the line count and the outline command; add
   `"limit":80` → silence. `.claude/hooks/outline.sh src/components/Dashboard.jsx | wc -l`
   → a few hundred, not thousands.
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
  the tell (absent), and the fix is the 2026-08-31 deny form of the hook
  (git history), not removing the hook.
- **Read-guard thresholds**: `BIG_LINES` (1,000) and `BIG_BYTES` (64 KB) at
  the top of `.claude/hooks/pretooluse-read-guard.mjs`; per-machine
  overrides `MM_READ_GUARD_LINES` / `MM_READ_GUARD_BYTES`. Both sit above
  every docs/memory file EXCEPT key-files.md, on purpose: conventions.md
  is meant to be read whole for money math, while key-files.md is a
  per-file table read one row at a time (the outline lists its rows; the
  reason text names the deliberate form, `limit:<line count>`, which the
  memory-auditor's table audit needs). `wc -lc docs/memory/*.md` shows
  each doc's margin; if conventions.md ever crosses a knob, split it,
  don't raise the knob.
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
real session before tuning further:
`node .claude/hooks/session-tokens.mjs ~/.claude/projects/<project>/<session>.jsonl`
(add its `subagents/*.jsonl` to see the agents), or `/cost` for the total.

| Sink | Cost per occurrence | Substitute | Enforced? |
|---|---|---|---|
| Bare `npm test` | ~20k tokens (5,700 TAP lines) | digest pipe: ~10 lines green, failures verbatim red | yes — rewritten by hook |
| Whole-file Read of Dashboard.jsx | ~30k (the 2,000-line default cap; ~125k in full) | grep -n / outline.sh (~290 lines, ~4k) then a ranged Read | yes — read guard |
| Whole-file Read of package-lock.json, dataAdapter.js, CsvImport.jsx | ~20–25k each | `git diff --stat`, `npm ls <pkg>`, grep, ranged Read | yes — read guard |
| Whole-file Read of docs/memory/key-files.md (few lines, wide) | bytes/4 — `wc -c` it | `.claude/hooks/outline.sh docs/memory/key-files.md` lists the rows; Read the touched file's row with offset+limit:1 | yes — read guard (byte threshold) |
| CI logs of a red `tests + build` job | tail of 5,700 TAP lines, failures possibly above the tail | the job now logs the digest: failures verbatim, ~10 lines green | yes — ci.yml |
| Bare `cat` of any of the above | ~7.5k (the Bash tool truncates at 30,000 chars) plus a wasted, truncated turn | pipe it (`cat f \| grep`) or `sed -n 'A,Bp'` | yes — read guard on `Bash(cat *)` |
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
- **Embedding the outline in the deny reason** (no second round trip): it
  would spend ~4k tokens on every deny, including the ones where the model
  goes on to grep; the pointer costs ~150 and leaves the choice.
- **A `git diff` digest** in the main context: the reviewer agent reads
  diffs by range with the lockfile excluded; a main-context diff is a
  deliberate choice, and rewriting it would hide what was asked for.
- **Pinning the ledger's numbers in a test**: the contract says record
  commands, never the numbers they return; the numbers here are dated
  estimates, and the config test pins the MECHANISMS instead.
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
  accident wherever the hooks run — main context or subagent, on any
  machine with node; a bare `npm test` costs the digest, not a refusal
  plus a retry; every subagent report is bounded; a red CI log is its
  failures; and the config test turns a silent regression of any of it
  into a red test.
