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
  `updatedInput` + allow), and covers a bare `node --test` too: a deny cost a
  refusal-and-retry round trip every time it fired, for the same outcome. The
  model is told, via `additionalContext`, that the digest ran.
- **The guards run on node, not sh+python3.** Node is the one runtime this
  repo guarantees on every machine; a guard that silently allows on a Windows
  shell without python3 saves nothing exactly where Mason runs locally. The
  digest stays awk (sh is present wherever the smoke commands run).
- **Whole-file reads over 1,000 lines OR 64 KB are hook-denied** — a Read
  with no `limit`, or a bare `cat` — with the real size, the substitutes,
  and the deliberate form (`limit:<lines>`) in the reason. The byte
  threshold exists for key-files.md: a few lines but wide (`wc -lc` it), a
  per-file table every rule says to read one ROW of. Every other memory doc passes; a memory doc
  that crosses a threshold gets split, the knobs do not move. The guard
  fires inside subagents too (settings hooks do), so Explore is held to it.
- **`.claude/hooks/outline.sh` is the cheap map** the deny points at
  (declarations for code, headings and table rows for .md). Generated on
  demand, never checked in: a checked-in map with line numbers would rot on
  the next edit.
- **Every agent carries `maxTurns` (a 2–3× backstop) and a report-length
  cap.** A partial return means "split the task", not "raise the number".
  Explore's cap exempts call-site/inventory SWEEPS — a dropped call site
  during a rename is a correctness bug, not a token saving.
- **`test/claudeConfigGuards.test.js` pins all of it** by piping the same JSON
  Claude Code pipes: hooks and their settings.json wiring, outline, digest,
  the token report, the routing-table ↔ frontmatter lockstep, backticked
  paths in `.claude/**/*.md`, and the always-loaded size caps in lines and
  bytes. Shell cases skip where `sh` is absent (the helpers are sh scripts).
- **CI's `npm test` runs through the digest** (`set -o pipefail`), so a red
  job's log tail is the failures. Job names unchanged.
- **`.claude/hooks/session-tokens.mjs` is the measurement tool** — usage per
  model and the largest tool results from a transcript — so tuning is
  against measured numbers, not the dated estimates in the ledger.

Rejected (reasons in docs/claude-routing.md "Considered and rejected"):
persistent agent memory for Explore (a second, un-audited memory — the
phantom-reference shape); lowering `BASH_MAX_OUTPUT_LENGTH`; a build/smoke
digest (29 and ~3 lines, nothing to save); guarding `head`/`tail`/`sed`;
embedding the outline in the deny reason; a `git diff` digest; pinning the
ledger's numbers in a test; capping the GitHub Actions runs. The 2026-08-31
deferrals (SessionStart npm-ci hook, statusline) stay deferred.

## 2026-09-08 — The 2026-09-04 improvement audit, and Mason's pick

Mason asked for "creative ways to make improvements to this app … easier to use
UI, better features users would enjoy, or fixing bugs". **The findings live in
docs/next-iteration-plan-2026-08-04.md's "Improvement backlog (2026-09-04
audit)" section** — 52 curated items, the deferred list, the curator's cut list,
and six corrections to the 2026-08-13 backlog. Not restated here; that doc is
the rulebook, this is the journal.

What was DECIDED, as opposed to found:

- **Everything is documented; only ticked items get built** (Mason: "document
  everything that was mentioned. only move forward with implementing the items
  checked off"). The unticked ones are recorded as DEFERRED — "the rest can be
  addressed at another time" — never as refuted, so a later session re-finds
  them as known work with their evidence intact. This is the first time the
  refuted-list discipline has been used for *postponed* items rather than
  killed ones, and the distinction is deliberate: a refuted item carries a
  reason it must not come back, a deferred one carries its file references.
- **Mason kept the bug fixes and nothing else** (2026-09-08): 25 items in three
  waves — money/date arithmetic, statement import, and state that does not
  refresh as it looks. Features, phone-shell resilience, teaching ergonomics and
  every preference-shaped question wait.
- **The review surface was an interactive checklist**, not a markdown list: a
  published artifact with a real checkbox per item, saving each tick to its own
  document so the build step reads the picks back rather than transcribing them.
  Chosen after a plain checkbox list proved untickable in the plan view. The
  page is disposable scaffolding — this journal entry and the backlog section
  are the durable record, and neither depends on the page surviving.
- **Verification was PARTIAL and is labelled as such.** A session limit killed
  12 of the 13 adversarial verifier batches; the one that ran confirmed all four
  of its items at high confidence. The backlog section marks those four VERIFIED
  and says plainly that every other item is finder-reported, so the builder
  re-reads the cited code and drops anything whose premise does not hold. An
  audit that hides its own coverage gap is the confidently-wrong shape this
  codebase refuses; saying "12 of 13 batches did not run" costs one sentence.
- **The two card-payment regex findings do not move without the probe.** Both
  would widen or narrow the vocabulary that keeps card payments out of spending,
  and the standing ruling (docs/memory/ship-record.md, 2026-08-17) is that the
  regex is calibrated against the household's real descriptors — re-run the
  PR #101 SQL before touching it, never reason from invented samples.

## 2026-09-08 — The audit's bug fixes shipped in three waves

The 25 items Mason ticked landed as PRs #128 (twelve wrong numbers and dates),
#129 (three findings the reviewer returned after #128 had merged), #130 (five
statement-import bugs) and the Wave C PR (eight state bugs). **The findings and
their evidence live in docs/next-iteration-plan-2026-08-04.md's 2026-09-04
audit section**, now marked shipped. Not restated here.

What was DECIDED, as opposed to fixed:

- **A zero-pot envelope stays "no envelope", and that is not a bug.** The
  overspend fix was written wide (`pot <= 0`) and two older tests refused it.
  They are right and the rule is now stated where it can be found: painting an
  unbudgetable category's spending as an overspend reports the classifier's
  ignorance as a budgeting failure, which is the same reasoning that keeps the
  Ungrouped rollup to budgetable rows. Only a NEGATIVE pot is a hole.
- **A client-supplied date may shape a server query, bounded.** The assistant
  now takes the caller's calendar day so it stops answering about next month
  for the last hours of every month. It is validated to a date-only shape
  within a day of the server's UTC day — wide enough for every real timezone,
  narrow enough that the body cannot name an arbitrary month. Date-only keeps
  the determinism contract: same DB state plus the same caller day, same bytes.
- **The account page holds an ID and derives its account.** Holding the object
  made it a snapshot that no refresh reached AND made every rename re-fetch 500
  rows. Deriving fixes both, and removes the second optimistic copy that
  `saveAccount` had to keep in step.
- **`env:pace` joins the serialized read-merge-write set.** It was the last
  household settings row written as a whole map rebuilt from local state — the
  shape that let one phone erase the other's opt-ins, which `rec:ignore` had
  already been fixed for. Its chain is a factory over an injectable db, like
  `makeSettingsChains`, so the concurrency is testable without a network.
- **Recurring and Debt moved off the null sentinel** to the epoch counter the
  Tax tab uses, and the in-flight flag came OUT of the effect guard — gating on
  it is what makes the stale response win, which the gotcha already records.

Recorded because they cost real time, and because the next audit should expect
them:

- **`test/smokeMocks.test.js` checks that mock exports EXIST, not what they
  RETURN.** Two shape drifts surfaced in one session; the second crashed the
  app inside the harness and had hidden the import modal's overlap path from
  every previous walk. A shape guard is unbuilt work, deliberately not bolted
  onto a bug-fix PR.
- **The render gate is still the only check that evaluates the Dashboard in a
  browser.** It caught a TypeError that `npm test` and `vite build` both
  passed. That is the third time this failure shape is on the record.

## 2026-09-08 — Free static checks join CI (no Claude tokens)

Mason asked for "more CI checks that won't use Claude tokens … nothing
redundant. Just … as much free code checking as possible." The audit of what
was ALREADY covered did most of the work: the RLS harness replays every
migration on a throwaway Postgres inside `npm test`, and Dependabot alerts,
secret scanning and push protection have been on since 2026-08-30 — so a
migration job, `npm audit` and a secret scanner were all rejected as duplicates
before anything was written.

Decided:
- **A third REQUIRED check, `static checks`** in ci.yml: `npm run lint`,
  shellcheck over the `.claude/hooks/*.sh` pair, and actionlint over the
  workflows (which also pipes every `run:` block through shellcheck). Mason
  adds the name to the ruleset by hand; until he does it runs and reports but
  gates nothing.
- **Every job in ci.yml is a required check; advisory work lives in its own
  workflow file.** Makes the gate readable at a glance, and is why CodeQL and
  dependency review are separate files rather than ci.yml jobs.
- **CodeQL and dependency review are ADVISORY and must stay so** — a false
  positive must not hold a merge that CI proved. CodeQL gets no cron: its
  purpose is re-scanning UNCHANGED code as query packs improve, and main moves
  most days. It is also mutually exclusive with GitHub's "default setup".
- **The eslint config is a bug tool, not a style tool.** Recommended rules plus
  ONE hooks rule; no formatting rules, no Prettier, and `eslint-plugin-react`
  is unnecessary because core eslint already tracks JSX identifiers. Globals
  are declared per runtime so `process` in src/ stays a real error.
- **exhaustive-deps stays OFF by design**, not "for now": effects here key on
  epoch counters and signatures (the Wave C fixes), so its "fix" would restore
  the bug the epochs exist to prevent. Its three stale disable comments were
  deleted — a directive for a rule that cannot fire is a lie the next reader
  believes, so unused directives are themselves an error.
- **The baseline was fixed, never suppressed** (24 findings). The one that
  justified the whole change: a `useMemo` called BELOW an early return in the
  PDF template editor — a "rendered more hooks than during the previous render"
  crash, in a file whose own comment already said hooks must stay above that
  return. Unreachable today only because every reset path happens to clear the
  template and the editor's visibility in the same batch. `npm test` and `vite
  build` both passed it, and the render gate never opened that editor.
- Also shipped, from the 2026-08-04 backlog: ci.yml declares
  `permissions: contents: read`, and each required job `name:` carries a
  comment saying the ruleset matches on that exact string. SHA-pinning the
  actions is still NOT done and stays a backlog item.

Rejected: `npm audit` and gitleaks (Dependabot alerts, secret scanning and push
protection already cover both); Prettier (style, not bugs, and it would rewrite
every file); a typecheck (nothing is typed); `eslint-plugin-react` (core covers
JSX identifiers); the hooks plugin's `recommended` preset (it bundles
React-Compiler rules that flag legitimate patterns here); zizmor (would re-flag
claude.yml's documented, deliberate write scopes); OSSF Scorecard (nags on
decisions already recorded here); a `dependabot.yml` (security-only remains the
standing ruling); a weekly CodeQL cron; a migration-replay job (`test/rls.test.js`
already is one); and SHA-pinning `actions/*`, which stays coupled to the ruleset
switch it would unlock.
