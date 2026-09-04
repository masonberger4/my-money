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

## 2026-08-31 — Dependabot review workflow (`dependabot-review.yml`)

Mason asked for the deferred Dependabot reviewer once the Claude GitHub App was
installed. **The mechanics live in docs/memory/workflow.md** — three verified
facts that each break it silently (Actions secrets withheld from Dependabot
runs, `allowed_bots` required, the stock plugin self-skipping automated PRs),
plus why `pull_request_target` was rejected. Not restated here; this entry is
the journal, that doc is the rulebook.

What was DECIDED, as opposed to discovered:

- **Its own prompt, not the stock `code-review` plugin** — and therefore no root
  `REVIEW.md`, which that plugin never reads. The 2026-08-31 deferral note above
  assumed both; both were wrong.
- **Scoped to what CI cannot see** rather than a generic review: browser-bundle
  reach, MAJOR-version jumps, browser-floor movement, pdf.js legacy build. It
  stays SILENT on a build-only patch bump, because a comment on every bump
  trains everyone to ignore the next one.
- **Advisory, never a gate.** It is not a required check and must not become
  one, so on a Dependabot PR whose auto-merge is armed the review can land
  after the merge. Accepted: the alternative is a rule that can block, which
  this repo's ruleset forbids.
- **Fails soft.** No secret in the Dependabot store leaves the job green with a
  notice rather than a red X, so it was safe to merge before setup finished.

## 2026-08-31 — The Plan tab collapses into group headings

Mason: the Plan tab should show "only the transaction group category names with
carrot next to them", and opening one reveals the categories in that group, each
with its spend as a progress bar against what has been assigned to it. It used
to render every envelope at once — around twenty-five three-line rows with every
editor visible and the group headings lost among them.

Decided:

- **One section per real group, plus ONE `Ungrouped` section** for every
  category with no `part of` link. Asked and answered by Mason directly, over
  the two alternatives offered: collapsing every top-level row uniformly, or
  collapsing only real groups and leaving the unnested ones as loose full rows.
- **Collapsed by default**, which forces the device pref (`mm:planOpen`) to
  store the OPEN sections — the inverse of `mm:acctCollapsed`. The rule behind
  both: the stored set holds the exceptions to a screen's default, so "no stored
  value" means the state the screen should open in. Its known cost is a CI blind
  spot, paid for with a `[data-mm-plan-group]` step in the smoke walk.
- **The rows themselves are untouched** — same `envRowNode`, same editors, same
  leaf-only assignment rule. Nothing here can move a dollar; only what is on
  screen at rest changed.
- **The `Ungrouped` rollup counts budgetable rows only.** Not a special case:
  a mechanism category can never be a parent or a child, so no group rollup has
  ever held one. An unbudgetable row still renders inside the section, and the
  heading says how many are in there.
- **The bar arithmetic became a pure `envelopeBar()`** in `src/envelopes.js`,
  because the same bar is now drawn at two levels. Rejected: recomputing it in
  the heading, which is how the two would eventually disagree about the same
  envelope on the same screen.
- **The rows inside `Ungrouped` are indented** like a group's children. They are
  not subcategories, but they are the section's contents, and an unindented row
  under an open caret reads as a sibling of the heading.


## 2026-09-04 — Token-usage guards on top of the routing setup

Mason: "Generate files to optimize the use of agents for the repository for
token usage." The mechanics live in docs/claude-routing.md (what was added,
the routing table with `maxTurns` and report caps, the token-cost ledger, the
tuning knobs) — not restated here.

Decided:

- **The bare-`npm test` hook now REWRITES instead of denying** (PreToolUse
  `updatedInput` + allow): a deny cost a refusal-and-retry round trip every
  time it fired, for the same outcome. The model is told, via
  `additionalContext`, that the digest ran.
- **Whole-file reads over 1,000 lines are hook-denied** — a Read with no
  `limit`, or a bare `cat` — with the real line count and the substitutes in
  the reason. The threshold sits above every memory doc on purpose: a memory
  doc that crosses it gets split, the knob does not move. Ranged reads,
  piped/redirected cats, and binaries pass. The guard fires inside subagents
  too (settings hooks do), so Explore is held to the same rule.
- **`.claude/hooks/outline.sh` is the cheap map** the deny points at (~290
  lines for Dashboard.jsx). It is generated on demand, never checked in: a
  checked-in map with line numbers would rot on the next edit.
- **Every agent carries `maxTurns` (a 2–3× backstop) and a report-length
  cap.** A partial return means "split the task", not "raise the number".
- **`test/claudeConfigGuards.test.js` pins all of it** by piping the same JSON
  Claude Code pipes: hooks, outline, digest, and the always-loaded size caps
  (agent bodies 70 lines, rules 40, skills 45, descriptions 320 chars). It
  skips the shell cases where `sh`/python3 are absent, because the hooks
  degrade to allow there by design.

Rejected (reasons in docs/claude-routing.md "Considered and rejected"):
persistent agent memory for Explore (a second, un-audited memory — the
phantom-reference shape); lowering `BASH_MAX_OUTPUT_LENGTH`; a build/smoke
digest (29 and ~3 lines, nothing to save); guarding `head`/`tail`/`sed`;
capping the GitHub Actions runs. The 2026-08-31 deferrals (SessionStart
npm-ci hook, statusline) stay deferred.
