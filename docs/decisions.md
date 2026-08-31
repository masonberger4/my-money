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

## 2026-08-31 — Repo-side Claude PR watching (`.github/workflows/claude.yml`)

- **Two different Claude integrations touch this repo, and only one existed.**
  Verified rather than assumed: `get_me` returns `masonberger4`, so the GitHub
  tools sessions use authenticate as Mason's own account — that connection is
  what opens and merges PRs, and it is why they read "opened by masonberger4".
  It is SESSION-SCOPED. A PR watch a session holds dies with the session, and
  `subscribe_pr_activity` takes one PR number, so it has no repo-wide mode.
  Nothing in the repo woke Claude between sessions.
- **Added the repo-side half**: `.github/workflows/claude.yml`, so anyone can
  summon Claude with `@claude` on any PR or issue with no session running.
  Event-driven, so it does NOT reopen the "an armed PR needs no babysitting /
  no need for triggers" ruling — nothing polls or schedules.
- **Inert until used, deliberately**: the job is gated on the comment body, so
  it is safe to merge before the credential exists — no run, no check, no red X,
  no delay to armed auto-merge.
- Three constraints honored, recorded in docs/memory/workflow.md: the job name
  never joins the ruleset's required checks (a sometimes-skipped required check
  reports pending forever); it is the repo's first WRITE-scoped workflow and says
  why; and it passes no `github_token`, because commits made with the default
  token don't trigger workflows — which would leave Claude's pushes with no CI
  run on the repo whose merge gate is CI.
- **Chose subscription auth** (`CLAUDE_CODE_OAUTH_TOKEN`) over an API key: no
  separate API billing. The Ask tab's `ANTHROPIC_API_KEY` is a Vercel runtime
  variable and is invisible to Actions — an Actions secret is a separate thing.
- **Rejected**: managed Code Review (Team/Enterprise only, $15–25 per review);
  making Claude's check required or a required reviewer (the ruleset forbids any
  rule that can demand an approval, and one account cannot approve its own PR);
  a polling Routine over open PRs (the "no need for triggers" ruling).
- **Deferred, not built**: automatic review scoped to Dependabot PRs (`allowed_bots:
  "dependabot[bot]"` — the action rejects bot actors by default, and Dependabot
  authors most PRs here). Its value is the browser-bundle iOS risk neither CI job
  sees; its cost is that on session-opened PRs a review usually lands after armed
  auto-merge has merged them, making findings post-merge and advisory.
