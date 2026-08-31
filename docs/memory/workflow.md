## Development workflow

1. `main` is the trunk and **Vercel's production branch** — pushes auto-deploy
   to production (`my-money-smoky.vercel.app`).
2. Features on `claude/feature-<name>` branches cut from main → Vercel Preview
   deploys (preview URLs need Mason's Vercel login; **previews share the PROD
   Supabase database** — schema-dependent branches need their migration landed
   first, and preview edits are real).
3. **Every session runs in AUTO MODE** — standing authorization from Mason
   (2026-07-31, reaffirmed 2026-08-01): Claude opens PRs and merges to main on
   its own, no per-merge ask. Every piece of work follows the ONE standard
   flow, always: **pull (fetch + absorb `origin/main`) → build (green
   `npm test` + the placeholder-env build; screenshots for UI work) → push the
   feature branch → open the pull request → ARM AUTO-MERGE (squash) the
   moment the PR opens → confirm the merge landed**. Auto-merge is Mason's
   ruling (2026-08-11, "keep build flow moving"): the branch ruleset requires
   `tests + build` + `render check`, so green CI merges itself with no
   polling gap — but arm it per-PR (`enable_pr_auto_merge`), it is NOT
   automatic, and a PR left unarmed sits green and unmerged (how PR #73
   stalled). Two boundaries: a PR meant to accumulate MORE commits before
   merging stays unarmed until its last push, and if the ruleset's required
   checks are ever removed, fall back to merging manually AFTER green — never
   before. An ARMED PR needs no babysitting (Mason, 2026-08-13: "no need for
   triggers"): don't schedule check-in timers/Routines for it — the merge
   event is the confirmation; only investigate if CI goes RED. Auto mode doesn't lower
   the bar: anything risky, preference-shaped, or migration-sequenced still
   goes past Mason first. Merged head branches auto-delete on PR merge (repo
   setting, confirmed 2026-08-01); unmerged branches are untouched, and a
   merged branch is finished — follow-up work restarts the branch from
   current main, never stacks on merged history. Shipping (or superseding) a
   plan-doc item edits the plan doc in the SAME PR, and a spec doc whose
   feature ships is deleted in that PR (the maintenance contract's
   history-compresses rule). GitHub MCP tools may
   transiently disconnect — retry before treating as fatal.
4. **`git fetch origin` and absorb main before EVERY feature-branch push, and
   again right before the merge to main.** Multiple sessions land features the
   same day, so main moves while a branch is in review — during the
   category-chips branch it moved twice (SimpleFIN deadlock fix, then the Tax
   tab), the second time touching the same Dashboard.jsx the branch edits. If
   `git rev-list --count HEAD..origin/main` isn't 0: `git merge origin/main`
   into the branch (MERGE, never rebase — the branch is pushed, and replaying
   other sessions' published commits manufactures the two-bases incident),
   re-run `npm test` + the build (+ re-screenshot if the moved code touches the
   UI; check whether main added dataAdapter exports the harness mocks must
   stub), then push. Otherwise the merge lands an untested combination built
   on a base that no longer exists.
5. **Migrations are additive-only** on live data (`alter table … add column`).
   Hand Mason the exact SQL to paste in the Supabase SQL Editor at merge time.
   **A migration that DROPS inverts the order**: additive SQL is safe to paste
   before the merge because old code ignores new columns, but a drop is only
   safe AFTER the new code is deployed and live — old code naming a dropped
   column 500s. `20260728000002_remove_plaid.sql` is the first of these and
   says so in its header. Confirm the deploy is actually serving the new build
   before pasting, and note that after pasting, Vercel's **Instant Rollback**
   button becomes a foot-gun rather than an escape hatch.
   **A migration that DROPS should VERIFY rather than trust** (lesson that
   recurs): "I removed everything I could see" ≠ "the database is empty" —
   three invisible `plaid_tokens` rows survived the remove-plaid pre-flight
   because `ALLOWED_TYPES` once filtered their accounts away.
   **Every migration must also stay safe on a FRESH, EMPTY database** — the
   fresh-install path replays all of `migrations/` in order via `supabase db
   push`, so a file that assumes rows, or an already-applied earlier state,
   breaks new installs while looking fine on prod.
   **PROD IS NEVER LINKED TO THE CLI.** Mason's live project keeps this
   paste-into-the-SQL-Editor workflow, permanently. `supabase link`/`db push`
   exist ONLY for building a new, empty project (`docs/SETUP.md` Path A): they
   can't express the inverted paste-after-deploy order above, and a push at a
   database holding data would replay `20260805000001`'s category wipe.

**Local checks** (gitignored; recreate as needed — EXCEPT `test/smoke/`, which
is CHECKED IN: CI's render gate runs it, and `test/smokeMocks.test.js` names
any export its mocks are missing. Extend `test/smoke/mocks/`, don't rebuild a
private harness; only the SCREENSHOT harness below stays personal):
SQL — local Postgres 16 stub
(create `auth` schema + `auth.users` + `auth.uid()` reading
`request.jwt.claims.sub`, the three roles, publication `supabase_realtime`; run
migrations in order, test triggers/RLS). UI — mock harness: a tiny Vite app
rendering the REAL `App.jsx` (since 2026-08-12) with `resolve.alias`
**full-match** regexes (`/^.*\/dataAdapter\.js$/`) swapping
dataAdapter/sync/db/apiClient PLUS `supabaseClient.js` (the fifth alias —
App sits above the façade and imports it directly) for mocks;
playwright-core screenshot (`executablePath:'/opt/pw-browsers/chromium'`,
390×844). The old harness gap is CLOSED for the HEALTHY startup path (auth →
count → Dashboard, canary-verified: an App-startup crash fails the gate);
the count-query ERROR paths stay untested by decision — asserting them means
choosing user-facing behavior, the call that killed the wider item.
Screenshot new UI before pushing. Tests (checked in, not gitignored):
`npm test` (node --test over `test/`). Build:
`VITE_SUPABASE_URL=https://placeholder.supabase.co VITE_SUPABASE_ANON_KEY=placeholder npm run build`.

**GitHub repo settings** live in the GitHub UI/API, not in this repo — there is
no settings-as-code file and adding one would be a second source of truth
nothing applies. So this paragraph records the SHAPE, the load-bearing REASONS,
and the commands that re-read it, never a frozen snapshot: `gh api
repos/{owner}/{repo}` (visibility, merge buttons, delete-branch-on-merge,
features, security_and_analysis, pull_request_creation_policy), `gh api
repos/{owner}/{repo}/rules/branches/main` (the rules actually in force — no
ruleset id needed), `gh api repos/{owner}/{repo}/rulesets/{id}` (adds
bypass_actors + conditions), `gh api repos/{owner}/{repo}/actions/permissions`
(+ `/workflow`), `gh api repos/{owner}/{repo}/vulnerability-alerts` (silent
204 = on, 404 = off). The hardening checklist was APPLIED 2026-08-30 —
Dependabot alerts + security updates, secret scanning + push protection,
Projects off, PR creation restricted to collaborators, fork-PR workflow
approval widened to all external contributors, and merge buttons narrowed to
squash at BOTH levels: the repo setting AND the ruleset's
allowed_merge_methods, since the "squash-only" wording that stood here
described PRACTICE, not configuration (all three buttons were enabled). The
Actions default token was already read-only.

**Three properties of the "Protect Main" ruleset are load-bearing** (it targets
`refs/heads/main`; the ruleset's own updated_at is the applied-date record):

- **bypass_actors is EMPTY and stays empty.** Sessions act with Mason's ADMIN
  token, so an admin bypass would make every rule below advisory for exactly
  the actor they exist to constrain. He can edit the ruleset itself in seconds
  if a hotfix ever needs it, so a standing bypass buys nothing.
- **No rule may ever be able to DEMAND an approval.** One account owns the repo
  and GitHub forbids approving your own PR, so an approval here is not slow, it
  is UNOBTAINABLE — any rule that can require one is a hard deadlock that only
  a ruleset edit clears. Hence 0 required approvals, no last-push approval, and
  no extra approval for unattributed changes (that last was ON until
  2026-08-30, and would have fired the first time a commit landed with an
  author email GitHub could not attribute). Review-thread resolution is off for
  the same family of reason: an unresolved bot thread would stall armed
  auto-merge.
- **Strict status checks** — a PR must be level with main to merge, which
  mechanizes workflow rule 4 instead of trusting discipline (the two-sessions-
  off-different-bases incident is what it prevents). It costs a fresh CI cycle
  per PR on multi-PR days, since each merge invalidates the others. Alongside
  it: deletion, non-fast-forward and linear-history protection.

The one machine-checkable coupling is unchanged: the ruleset's required checks
are the job `name:` STRINGS in `.github/workflows/ci.yml` ("tests + build",
"render check") — rename either and the gate silently stops gating, with
nothing local to catch it. DELIBERATELY not enabled: Actions' sha-pinning
requirement, which would break ci.yml immediately (it floats `actions/*` on
major tags). It unlocks only after the SHA-pinning backlog item ships — the two
are a coupled pair, in that order.

**Dependabot now opens PRs unprompted** — SECURITY updates only, since the repo
carries no Dependabot config file, so there is no routine version-bump noise. A
session may therefore find open PRs it did not create; they need no
babysitting (and since 2026-08-31 `dependabot-review.yml`, described below,
reads each one for the risk below automatically), but judge them like any
dependency change: only what reaches the
BROWSER bundle (today just `pdfjs-dist`) carries the iOS risk neither CI job
can see, while build-tooling bumps are covered by the two jobs. **A security PR
that jumps MAJOR versions is a project, not a merge** — the first batch
(2026-08-30) offered vite 5→8 to clear a dev-server-only advisory; the four
patch-level PRs merged and that one was done as its OWN change the next day,
not as a bot merge — see the browser-floor Gotcha for what that upgrade
silently moved and what now pins it.


**Two DIFFERENT Claude integrations touch this repo; don't confuse them** (verified
2026-08-31, not assumed). (1) The **account connection** sessions use: the GitHub
tools authenticate as Mason's own account — `get_me` returns `masonberger4`, which
is why every session-opened PR reads "opened by masonberger4" and why merges are
attributed to him. It is SESSION-SCOPED: it acts only while a session is running and
driving it, so a PR watch held by a session (`subscribe_pr_activity`, which takes one
PR number and has no repo-wide mode) dies with that session. (2) `.github/workflows/claude.yml`,
the repo-side half added 2026-08-31: anyone writing `@claude` in a PR or issue comment
gets a run, with no session anywhere. Four things about it are load-bearing:
- **It subscribes to THREE comment events, because they are three different ones.**
  `issue_comment` covers issue comments and a PR's top-level comments (GitHub models
  those as issue comments); `pull_request_review_comment` is an inline diff-line
  comment; `pull_request_review` is a submitted review's summary body, which neither
  of the others fires. Drop the third and a mention written in a review body is
  silently dropped — caught in review before this shipped.
- **The `if:` is a cost filter, NOT the trust boundary.** This repo is PUBLIC, so
  anyone can comment. The real gate is inside the action: it requires the TRIGGERING
  ACTOR to have write access before Claude starts, and rejects bot actors unless they
  are listed in `allowed_bots` (which is also why a Dependabot-PR reviewer would need
  that setting). A stranger's `@claude` therefore burns a few seconds of free
  public-repo runner time and is refused; it never reaches the write scope. Keep the
  comment body out of any `run:` block, where it WOULD be a script-injection vector —
  inside an `if:` expression it is data.
- **Its job name (`claude mention`) must never join the ruleset's required checks.**
  It runs only on a mention, and a required check that sometimes doesn't run reports
  pending forever — the mechanic that refuted `paths-ignore` on `docs/`.
- **It is the first WRITE-scoped workflow here** (ci.yml needs none). Claude pushes
  and comments when asked, so `contents`/`pull-requests`/`issues: write` is its real
  minimum; it is stated explicitly per the every-new-workflow-declares-permissions rule.
- **It passes no `github_token`.** GitHub doesn't trigger workflows on commits made with
  the default `GITHUB_TOKEN`, so passing it would leave Claude's pushes with no CI run —
  green by absence, on the repo whose merge gate IS CI. This is also why the job holds
  `id-token: write`: with no token passed, the action mints its GitHub App credential
  via OIDC instead of reusing the job's.
It needs the repo secret `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`; bills the
subscription, not the API) and the Claude GitHub App installed. Until both exist a mention
fails that one run — non-blocking, since it gates nothing. NOTE the Ask tab's
`ANTHROPIC_API_KEY` is a VERCEL runtime variable and is invisible to Actions; an Actions
secret is a separate thing. This is event-driven and does not reopen the "no need for
triggers" ruling: nothing here polls or schedules.

**`.github/workflows/dependabot-review.yml` reviews Dependabot's PRs** (added
2026-08-31) — the only PRs nobody reads: a session reviews its own work before
pushing, but a bot PR can arrive, go green and merge unread. Three facts it is
built on, each verified against the primary source and each able to break it
SILENTLY if changed:
- **GitHub withholds Actions secrets from Dependabot runs.** Such a run is treated
  as if it came from a fork — "the only secrets available to the workflow are
  Dependabot secrets. GitHub Actions secrets are not available" — in every repo,
  public or private, since 2021-03-01. So `CLAUDE_CODE_OAUTH_TOKEN` must ALSO be
  entered in Settings → Secrets and variables → **Dependabot**, a different tab
  from the Actions one beside it: same name, same value, stored twice. Absent
  there it is the empty string and the review never runs. (`GITHUB_TOKEN` is the
  lone survivor, read-only by default — recoverable via `permissions:`, which the
  withheld secrets are not.)
- **`allowed_bots: "dependabot[bot]"` is required.** The action refuses bot actors
  unless allowlisted. Its other actor gate, the write-access check, passes any
  `[bot]` actor unconditionally, so this is the only one that matters here.
- **It passes its own `prompt` rather than the stock `code-review` plugin**, whose
  own first step stops when "the pull request does not need code review (e.g.
  automated PR)" — a Dependabot PR is precisely that, so the plugin would review
  nothing, quietly. For the same reason a root `REVIEW.md` would be dead weight:
  that plugin reads CLAUDE.md files only and never `REVIEW.md`.
NOT `pull_request_target`: the untrusted input in a Dependabot PR is the NEW
DEPENDENCY, whose code the job would run with the full secret set in scope —
the exfiltration path the fork treatment exists to close. The prompt asks only
what CI cannot: does the bump reach the BROWSER bundle, is it a MAJOR jump, could
it move the browser floor, is pdf.js still the legacy build. It comments only when
the answer matters — silence is the correct output for a build-only patch bump,
and a comment on every bump trains everyone to ignore the next one. A missing
secret leaves the job GREEN with a notice rather than a red X, so it was safe to
merge before the store was populated. **It is ADVISORY, not a gate**, and the
required-checks rule above is why it must stay that way: on a Dependabot PR
whose auto-merge is armed, the two required jobs can go green and merge before
this one finishes, so treat its comment as something to read after the fact as
often as before it. The job also needs `issues: write` to say anything at all —
a PR conversation comment is created through the ISSUES endpoint, so
`pull-requests: write` alone silently fails on the only run that found
something.
