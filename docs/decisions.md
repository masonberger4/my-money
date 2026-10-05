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

## 2026-09-08 — One typeface (Inter), and a near-black indigo dark theme

Mason's ask was "copy the font and color scheme to be used by the app", with a
reference screenshot of the Reflect tab. It was NOT the palette main ships: the
capture (Display P3, so sampled and converted to sRGB before use) reads
`#05050F` page / `#111227` card / pure-white ink / a bluer `#7482FF` accent, in
a Helvetica-SF grotesque with headings well past DM Sans's 600 ceiling.

- **Inter replaces DM Sans AND both DM Mono weights** — one variable file,
  400–800, self-hosted like its predecessors. Mason asked what a Dell in a
  browser would get: that question is what ruled OUT a `-apple-system` stack,
  which matches the screenshot only on Apple devices and resolves to Segoe UI
  on Windows. Inter is the same grotesque everywhere.
- **Money columns keep their alignment without a mono font**, through
  `font-variant-numeric: tabular-nums` at the ~95 sites that named DM Mono.
  The reference screenshot renders amounts in the same proportional face, so
  keeping a second family for them would have half-copied the design.
  `--font-mono` survives as the SYSTEM stack and is for RAW data only (the CSV
  importer's source columns, the SimpleFIN token, the PDF template overlay),
  where a monospace says "the file's text, not ours".
- **Both palettes come from screenshots** — the dark one first, then Mason's
  light reference the same day, sampled and converted the same way. Nothing was
  invented to fill the gap, which is why the two themes are tonally related
  rather than merely both-present. Ink got safer (text 14.21→18.43:1 on the card, muted
  6.52→10.74:1); the accent got bluer and therefore DARKER, so its ratio fell
  — 6.90→5.60:1 on the card, 7.73→6.16:1 on the page — which is the one number
  this re-theme spends rather than gains. It clears 4.5:1 on both surfaces, so
  accent text stays AA, but a future accent tweak has less headroom than the
  navy palette had.
- **The active nav pill moved from `--bg` to `--input-bg`.** Light-identical
  (the two tokens share a value there), and in dark it becomes the LIFTED pill
  the screenshot shows — a pill darker than the bar reads as a hole once the
  page is near-black.
- **Heading weight 700 is now reachable**, so the page `h1` and the Reflect
  headline take it. This retires the YNAB redesign's deferred "font weights
  past 600 (the variable font's ceiling)" item.
- **Light ink got a real fix, not a re-tint.** Text went near-black → black and
  muted #888780 → #51504D, which takes small light-mode labels from 3.61:1 to
  8.06:1 and RETIRES the "light small labels still fail AA — a palette
  decision, not a bug" note that stood in Conventions. Both themes pass now, so
  a low-contrast light label is a bug again.
- **`--light-input-bg` stopped equalling `--light-bg`.** It is the reference's
  inset surface (#EBEAE2) — input fills and the active nav pill — which is what
  lets ONE token express a pill that is LIFTED in dark and INSET in light.
  A session assuming the old equality (it made the nav change a light no-op
  when the dark half shipped) will now be wrong.
- **The active nav label stays `--text` in both themes**, and the surface that
  decides it is now the PILL, not the page: the new light accent clears 4.5:1
  on the page (4.57:1) but reaches only 4.24:1 on the pill. Both references
  show a blue active label; this is the one place the copy deliberately stops.
- **`manifest.webmanifest` follows `--light-bg`.** Its `theme_color` had been
  #1D9E75, a green from the DATA palette — the "manifest theme_color
  inconsistency" the YNAB redesign recorded as deferred. Fixed here because
  this PR is the one that moves every other colour that flanks it.

## 2026-09-08 — Writes that die on the wire are re-sent; network failures get a sentence

Mason's iPhone alerted "Couldn't save that change: TypeError: Load failed" when
he picked a category on a transaction. That is not a server error: it is
Safari's wording for a fetch that never got a response, and on iOS it is
overwhelmingly a PWA resuming from the background (or the phone hopping cells)
sending its first request on an HTTP/2 socket the OS already closed. The next
request works, which is why the same session's reads looked fine — supabase-js
re-sends GET/HEAD/OPTIONS for itself and nothing else, so only writes ever
reached the alert. The alert then showed the raw exception text, which tells a
person nothing they can act on.

Decided:
- **Retry PATCH/PUT/DELETE only.** A PostgREST write with the same filter and
  payload leaves the same row state however many times it lands, so re-sending
  one is free. Reads are already covered by postgrest-js's own
  `RETRYABLE_METHODS` budget and stacking a second budget on top would only
  multiply the wait on a phone that really is offline. POST is excluded on
  purpose: a plain insert sent twice is a duplicate row, and a re-sent auth
  refresh can burn a single-use refresh token.
- **Two short waits (400 ms, 1200 ms — ~1.6 s worst case.)** Long enough to
  cover a socket that died between screens, short enough that a genuinely
  offline phone still gets its answer promptly instead of appearing hung.
- **The retry lives in the fetch layer under supabase-js**, wired as
  `global.fetch` when the client is created, so every adapter write inherits it
  in one place.
- **`friendlyError` is the one error-to-alert-text mapping.** A network failure
  becomes "couldn't reach the server. Check the connection and try again."; any
  other error keeps its own message, which is the behaviour the alerts already
  had.

Rejected:
- **Retrying at each dataAdapter call site** — dozens of sites, and the next
  write added would silently not have it. The wrapper cannot be forgotten.
- **Retrying POST** — the two failure modes above (duplicate rows, a burnt
  refresh token) are worse than the alert the retry would prevent.

## 2026-09-08 — full-screen sheets pad for the iPhone status bar

Mason: the tx sheet's × close "does not work and is too high" on the iPhone.
`.overlay` is fixed/inset:0 and so escapes the body's safe-area padding; the ×
sat under the status bar, where iOS intercepts taps. `.sheet-full` now carries
`padding-top: env(safe-area-inset-top, 0px)` — zero on desktop, ~47–59px on
iPhones — which lowers the header by about one button height and puts the
close button back in tappable territory. Recorded in gotchas.md.

Rejected:
- **A fixed 36px margin on the button** — would shift desktop too and still
  leave the button partly under a 59px inset on the Pro models.

## 2026-09-08 — The header collapses into a gear menu; pull-to-refresh on every tab

The global header had grown a `＋` quick-add (Spending only), a tap-to-cycle
theme button, a refresh button, and a "Sign out" text button — four controls
at 390px, already crowding the `pageTitle` h1 before anyone asked for a fifth.
Mason's direction was to collapse them.

Decided:
- **One gear icon, every tab.** All four header controls are replaced by a
  single gear `.nbtn` (`data-mm-gear`) that opens `GearMenu`. The Add
  Transaction row inside it stays Spending-only (`tab==="transactions"`) —
  collapsing the chrome doesn't mean surfacing a control where it doesn't
  apply.
- **A small anchored panel, not a modal or a full sheet.** `GearMenu` is a
  260px panel anchored top-right under the gear — a menu of short actions
  reads as a menu, not a page takeover, and an anchored panel keeps the gear
  itself visible as the thing that opened it.
- **A picker, not a cycle.** The old theme control was tap-to-cycle
  (Auto → Light → Dark → Auto); it is replaced by a three-way Auto/Light/Dark
  segmented control that calls `useTheme`'s `setPref` directly. A cycle that
  only moves forward turns "I want Dark" into a guessing game of how many taps
  away it is; a picker reaches any of the three in one tap. See the Theme
  Convention and the removed tap-to-cycle helper's retirement in the
  `src/theme.js` Key-files row.
- **Refresh stays in the menu AS WELL AS the new gesture.** The menu's
  Refresh row (with its "updated HH:MM" watermark) is the pointer-device
  fallback — a mouse has no pull gesture — while pull-to-refresh (below)
  covers touch and wheel/trackpad. Both call the same `refreshNow`.
- **Sign out keeps its word and its confirm.** Icon-only sign-out on a shared
  household login is a mis-tap hazard neither collapsing the header nor an
  icon budget is worth risking.
- **`GearMenu` is a REGISTERED overlay** (`useEscClose` + `role="dialog"` /
  `aria-modal`, in both `anySheetOpen` and `closeAllSheets`), not an inline
  `searchOpen`-style disclosure, because it has a page-covering transparent
  backdrop (`data-mm-gear-close`) and is reachable by a back gesture — an
  unregistered flag would make it the app's first overlay a back gesture
  ignores and that `closeAllSheets` can't reach. The registration also pays
  for itself twice: pull-to-refresh's `blocked={anySheetOpen||loading}` gate
  gets "is any overlay open" for free instead of needing its own tracking.

Pull-to-refresh (`src/pullRefresh.js`, `createPullRefresh`) now runs on every
tab, not just Spending:
- **Thresholds**: `PULL_DEFAULTS` = 70px touch (the iOS/Android convention,
  roughly half a thumb's travel), 120px wheel (about two mouse-wheel notches,
  so one accidental notch shows progress but doesn't fire), 250ms wheel idle
  (about how long trackpad inertia takes to visibly stop).
- **`scrollY <= 0`, never `=== 0`**: iOS reports a negative scrollY during the
  rubber band, so an exact-zero check goes dead exactly where pulling feels
  most natural.
- **Touch fires on release**; a move away from the top disarms — that's a
  scroll, not a pull. **Wheel has no release event**, so it fires the instant
  a burst crosses threshold, but only when that burst was already at the top
  when it STARTED. That "burst-armed-at-start" rule is what stops a trackpad
  fling-to-top — one continuous burst that only reaches the top partway
  through — from firing a refresh nobody asked for.
- **Cooldown + quiet** guard against double-firing: `cooldown` blocks a
  second trigger until the caller's refresh actually finishes (`settle()`);
  a separate wheel-only `quiet` flag absorbs the trackpad's momentum tail,
  clearing only on a fresh burst that starts after cooldown is already off —
  without it, inertia that outlives a fast cached refresh would cross
  threshold again and fire a second time.
- **All five window listeners (touchstart/touchmove/touchend/touchcancel/
  wheel) are PASSIVE** and never call `preventDefault` or set `touch-action`:
  the indicator rides on top of the page's own scroll/rubber-band rather than
  owning or cancelling it.
- **`src/ui.css` gains `html, body { overscroll-behavior-y: contain }`** so
  Chrome Android's own native pull-to-refresh can't fire a second, competing
  reload underneath ours. It does NOT remove the iOS rubber-band bounce
  (WebKit ignores `overscroll-behavior` on the root, and the bounce is
  wanted) and has no effect on wheel/trackpad input.

Also settled: the segmented theme control's active-segment fill is `--card`,
not `--input-bg` — the 2026-09-08 light accent reaches only 4.24:1 on
`--input-bg` but clears AA on the card, the same contrast measurement already
recorded on `.bnav` in `src/ui.css`.

## 2026-09-08 — Transaction dates are editable (user_date + generated effective_date)

- **A transaction's date can be changed from the detail sheet** so a
  purchase that posts a day into the next month — or one the household
  simply wants counted elsewhere — moves months. The sheet's Date row is a
  blur-commit `<input type="date">` (the placed-in-service pattern) with a
  "Posted <bank date> · reset" line while an override is set.
- **Storage: `user_date` (user-owned, sync-omitted) + a STORED generated
  `effective_date = coalesce(user_date, date)`; `date` stays the bank's.**
  The month-bucketing reads range on `effective_date` and fold it into
  `date` via `withEffectiveDate()`; the feed-coverage / reconciliation /
  dedup reads keep the bank date. Rules in the two-dates Convention.
- **Rejected: a BEFORE trigger rewriting `date` in place** (architect
  review). It would have kept every query untouched, but by turning the
  bank date into the user's pick at exactly the reads that must mean "when
  the bank says it happened" (the CSV overlap boundary, reconciliation),
  and with two silent stale-`posted_date` branches. Rejected too: renaming
  `date` (destructive, inverts paste order) and a shape-time shift with no
  column (a row moved outside the fetched range never appears).
- Migration `20260908000001_transaction_user_date.sql` is additive: paste
  BEFORE the merge, when no sync is running (the STORED column rewrites the
  table under an ACCESS EXCLUSIVE lock). Verified by the
  `transactions_user_date` / `transactions_effective_date` booleans in
  `supabase/bootstrap_household.sql`.
## 2026-09-09 — screen roots are `.screen`, never `min-height: 100vh`

Mason: "the scroll bar appears while on a transaction page even if the screen
isn't scrolling because all information is already being shown." Cause:
index.html pads the body by the iPhone safe-area insets, and every screen root
declared `min-height: 100vh` INSIDE that padding, so the page was ~93px taller
than the PWA viewport on every screen; it only showed on a Spending month
short enough to fit. Settled: one `.screen` class in `src/ui.css`
(100dvh minus both insets) on all five roots — Dashboard, Login, EmptyState,
App's ConfigErrorScreen and StartupSkeleton. Rejected: patching Dashboard alone
(the four centered screens overflow identically) and dropping the min-height
(the four centered screens need it to center). The gotchas entry sits next to
the 2026-09-08 sheet-padding one — same blind spot, opposite direction.

## 2026-10-05 — Audit PR A: Dashboard state, refresh and screen fixes

Mason asked for a review: "review the app, fix bugs, look for refactoring
opportunities, easy app upgrades". **The findings — what each of the three
PRs ships, the buildable leftovers, and the questions that wait for him —
live in docs/next-iteration-plan-2026-08-04.md's "Improvement backlog
(2026-10-05 audit)"**; the rules are in the memory docs. This entry records
what PR A DECIDED, as opposed to fixed.

- **The load that wins `loadSeq` owns the spinner.** reloadData clears
  `loading` after each sequence guard it survives; fetchData only raises it.
  Rejected: clearing it in fetchData when its own reload won — a newer reload
  (the startup pull's follow-up, any post-write reload) superseded it and
  nothing cleared the flag. Rejected too: a smoke-walk repro of that race; it
  needs a pull to land mid-tap, which would make the required render gate
  flaky, so the rule is source-pinned.
- **Every reload after an await goes through `reloadViewed()`** (monthRef),
  never the closure's `reloadData(year,month)`. Rejected: a drop-if-the-month-
  moved guard inside reloadData — it would discard the post-write refresh
  instead of aiming it at the month on screen.
- **Plain month taps keep the lazy tab caches** (`invalidate:false`) —
  Recurring, Debt, Tax, Trends cash flow and the Accounts-tab panels depend
  on no viewed month. Extends the 2026-08-04 month-navigation caching ruling;
  every other reload still drops them.
- **The Accounts-tab panels refetch only while on screen, and never blank a
  good answer.** Expanded AND the account list showing; a refetch keeps the
  previous answer up, dimmed, until the new one lands. Rejected: bumping
  their epochs only on pulls, Refresh, foreground returns and imports —
  setting a listed near-miss pair to Transfer is a plain row edit, so the
  pair would stay listed, which is the F19 failure again.
- **`refreshing` spans the bank pull.** The pull chip, its gate and the
  gear's Refresh stay busy until the pull a refresh started (and its
  follow-up) settles. This amends the 2026-09-08 gear-menu entry's
  `blocked={anySheetOpen||loading}` gate (that entry stands as written; the
  operative rule is the Dashboard key row). Each hold lets go by itself after
  60s, because runSync has no client timeout and a PWA suspended mid-pull can
  leave it hung. Rejected: a client timeout or AbortController on runSync (it
  changes every caller — the forced re-sync after a type change, the link
  flows) and counting only an explicit Refresh (one that joins a hung startup
  pull would still strand the controls).
- **A foreground return more than an hour after this device last started a
  pull re-pulls, QUIETLY** — the 2026-09-08 deferred item, built under its
  recorded constraint: the hour-gated pull never paints the sync-failure
  banner, since nobody asked for it. Feed health is re-checked after it and a
  healthy answer clears the amber banner — so does a not-connected one
  (`feedHealthVerdict`; an early return there left a raised banner up after a
  disconnect) — so a dismissed feed banner returns on the next hourly
  re-check while the feed is still broken. An explicit Refresh still does not
  re-check feed health (unchanged).
- **A failed explicit Refresh keeps its banner**: the copy is one constant,
  re-asserted after the follow-up reload's clear without overwriting a load
  error that reload raised itself.
- **One expected-bill pass per foreground return, after its pull settles.**
  Rejected: an in-flight gate on the expected effect (the recorded Gotcha —
  in-flight gating is what lets the stale response win). Accepted residual: a
  foreground pull that never settles runs no pass on that return. The extra
  passes widen the stale-pass race that the status-guarded match write (F35)
  closes, so F35 and its prerequisites (F27, F33) were MOVED INTO this PR
  from PR B. Rejected: shipping the passes first and letting PR B follow —
  main would have run the extra passes over an id-only write in between.
- **The pipeline's decisions are pure and unit-tested** (`src/loadPipeline.js`);
  Dashboard keeps only wiring scans. Rejected: a React renderer in the test
  deps to test the loading rule behaviourally (zero test-framework deps).
- **The typed budget income is month-tagged** like the measured one. A tag
  mismatch shows the existing "set income" prompt until the next read.
  Rejected: a skeleton, which would stick with no retry path.
- **A Spending account filter on a hidden account is derived away at render,
  not cleared.** Rejected: clearing it when the account is hidden — transient
  state, blind to a hide made on the other phone, and `saveAccount` swallows
  failures so a clear would drop the filter on a failed hide. Accepted:
  unhiding the account revives the filter.
- **A date edit re-sorts the lists stably by date alone** — no id tiebreak
  (the reads have none, so one would reshuffle unmoved same-day rows) — and a
  date-filtered search keeps the edited row, as a renamed row stays in a text
  search.
- **Formatters and wall-clock dates live in `src/format.js`, one copy**, and
  an amount that rounds to zero prints unsigned. CsvImport's UTC `todayIso`
  stays out on purpose. Rejected: a Math.round pre-round (toLocaleString
  rounds half away from zero; pre-rounding turned −2.5 into −2).
- **Home's ring, its legend and Reflect's breakdown are one arrangement**: the
  top six positive groups plus All Others; refunded categories are left to
  the Categories tab. Rejected: the old renormalised top-seven ring beside a
  top-six legend (an unnamed seventh wedge, a refunded category with no
  wedge).
- **Overdue bills stay on Home**, labelled in the over ink beside the
  next-7-days count — nothing auto-dismisses, so the unmatched bill is the
  alarm. Rejected: dropping them. Names and a tap-through stay deferred (the
  Plan tab shows overdue rows only in the current month, so a tap needs month
  handling).
- **Plan rows follow the one category list.** Rejected: the walk's
  budgeted-first raw-label order (a row jumped on its first dollar, so the
  next tap hit another envelope) and re-sorting the walk itself (its other
  readers depend on that order).
- **The Plan headline target sums each row's ask for THIS month.** What a
  past-date by-date target should do stays the open Group 7 question.
- **`tax:maps` joins the read-merge-write set**, one entry per edit against the
  stored row. The 2026-09-08 entry calling `env:pace` "the last household
  settings row written as a whole map" was wrong: `tax:maps` still was.
- **Date EDIT inputs revert garbage on blur, never save it and never turn it
  into a clear**; 5- and 6-digit years are rejected; record edits keep a 1900
  floor (a placed-in-service date can predate 1990) while search keeps 1990.
- **A rule that saved is reported as saved** even when the history rewrite
  fails; choosing Always again is the retry. Rejected: a Retry button (a UX
  addition nobody ruled on).
- **All-digit payees teach by their description**; masked payees were already
  covered by the shaping layer's bank-name fallback, so only the empty-key
  case needed it.
- **Category add AND rename refuse a live category's display alias and a case
  variant of an in-use name**; the EXACT in-use name stays addable (re-adding
  that raw key is the retire-and-re-add path), and a retired category's
  leftover alias blocks nothing.
- **Quick-add excludes hidden accounts and defaults to cash.** Left unbuilt on
  purpose: an adapter-level guard against writing to a hidden account, which
  would also cover the other phone hiding the account while the sheet is open
  — a race nobody has hit, not worth widening the diff for.
- **A Budget-tab figure that is only looked at writes nothing.** That closes
  the no-op half of the two-phone envelope race; real concurrent edits still
  race last-writer-wins, which stays Mason's ruling.
- **`Swatch` commits on the native `change` event**, with blur as a fallback:
  the 2026-09-08 blur-only commit never fired on the laptop.
- **One `summarizeDebts`, one sparkline scale, one carry-forward fold.**
  `debtRate` stays despite having no reader, because dataAdapter's return
  shapes are kept stable (preferred over the verifier's drop-it-and-compute-
  at-render alternative).
- **The mileage footnote derives from the rate table for the viewed year**, and
  a drive saved outside that year says where it went. The date still defaults
  to today: defaulting into the viewed year is unruled.

## 2026-10-05 — Audit PR B: data layer, server and pure-core fixes

The second of the three PRs from the 2026-10-05 review (the item list: the
plan doc's "Improvement backlog (2026-10-05 audit)"; the rules: the memory
docs). F27, F33 and F35 were planned for this PR and moved into PR A — that
entry records them. What PR B DECIDED, as opposed to fixed:

- **A taught rule is written update-first, never delete-first.** Update the
  exact (merchant_key, amount) slot, insert only when no row came back, and on
  a 23505 (both phones taught the slot at once) re-run the update once — last
  writer wins, as before. Rejected: keeping delete-then-insert (a lost insert
  POST left the merchant with no rule); re-sending the POST (the never-retry-
  POST rule is global); an upsert (ON CONFLICT cannot infer the two partial
  unique indexes); a one-transaction database function (a migration, for a gap
  the update-first order already closes).
- **Every read that can pass 1000 rows pages, and every paged read is totally
  ordered.** The classifier and the Taught-rules screen share one rule read;
  api/sync.js mirrors it. The Taught-rules page grew from 500 to 1000 rows as
  a side effect of sharing. Rejected: loading the rules after sync's throttle
  decision — a load inside the pull runs after the throttle stamp, so a
  transient rules-read failure would burn the throttle window, all to save one
  query on a throttled call.
- **Multi-batch transaction writes invalidate from a `finally`**, like the
  sync hook: clearing is cheap and an upsert whose answer was lost may have
  landed. The error still reaches the caller unchanged.
- **No whole-map reader or writer for `env:pace` or `rec:ignore` is exported**
  from an adapter or the façade; the chains keep theirs internal. Nothing
  called them, and Dashboard's useState setters share the names, so one
  aliased import would re-open the stale-phone wipe.
- **apiClient opts its GET into the wire-death retry.** The 2026-09-08 read
  exclusion is the DEFAULT method set, sized for supabase-js, which re-sends
  reads itself; apiClient's plain fetch has no such budget. POST is still
  never re-sent. Rejected: widening the default (it would stack a second
  budget on supabase-js reads, the offline-wait multiplication 2026-09-08
  rejected).
- **An api/ error body is read once.** `detail` is the parsed JSON or
  undefined — never the raw text, which would put a whole HTML error page in
  an alert — and the first 500 characters ride on `err.body`.
- **The sync watermark is cleared before a first-sight bank's accounts are
  inserted.** Accepted behaviour shift: a pull that adds a bank AND carries a
  real feed error now leaves the watermark NULL (the next pull asks for the
  full window; upserts are idempotent) rather than at the old value. Rejected:
  resetting it in a catch (a killed invocation runs no catch). Not gated on
  the attempt-column degrade: pre-migration the throttle reads the watermark,
  but it never held after a failed pull anyway.
- **Sync's institution bookkeeping is conditional on not being disabled** —
  one atomic UPDATE, so a Remove-bank that lands mid-pull keeps its tombstone.
  Rejected: dropping `status: 'active'` from the patch — a legacy 'error'
  status would then never clear on a good pull, and a removed bank would still
  be stamped as freshly pulled. Out of scope, recorded: accounts re-created by
  an upsert that landed between a mid-pull PERMANENT delete and the disable
  stay under the tombstoned institution, which the next pull skips.
- **An account's type comes from its NAME; the institution is a fallback
  signal only**, for card-only issuers when the name says nothing. The finding
  as reported (accounts at a Savings and Loan typed as loans, at a credit union
  as cards) did NOT occur in production: the old code read an org field the
  normalized org lacks, so the real bug was a dead issuer rule — and the
  obvious fix, reading the org's label in the shared haystack, would have made
  the reported failure real. Production change: an account at a card-only
  issuer whose name says nothing now arrives typed credit instead of uncertain
  checking (still hidden until a human confirms it). Not added: a credit-union
  "share" savings rule and an investment-on-institution rule (optional extras,
  neither needed to fix F37); such accounts stay at the visible uncertain
  default.
- **A cross-origin redirect drops the Authorization header, and it stays
  dropped** (the Fetch standard's behaviour, restored by hand). Only
  Authorization: it is the standard's whole cross-origin list, and nothing here
  sends a cookie or proxy credential.
- **A `max_tokens` stop is surfaced in the reply, never shown as complete.**
  OPEN for Mason: raising `maxTokens` for the thinking models (for example 8000
  at high effort and 16000 at xhigh/max, plus the matching cost-estimate
  update). An Opus answer at max effort would go from roughly 16¢ to 46¢ per
  question at 16k, under the spend-cap ruling, and the non-streaming request
  runs longer with no `maxDuration` set in vercel.json; past ~21k the SDK
  forces streaming. Accepted, pre-existing: a long cut-off answer kept in the
  chat history can exceed the per-message character cap on the next turn.
- **Sonnet 5 is priced at its standard list price**, and every price is a list
  price pinned in a test, re-verified whenever a model changes. Display-only;
  the model lineup itself (F102) waits for Mason. Source: Anthropic's pricing
  page (platform.claude.com/docs/en/about-claude/pricing), read 2026-10-05. Its
  Sonnet 5 footnote says the $2/$10 announced at launch as intro pricing
  through 2026-08-31 is now the standard price, and the $3/$15 rise scheduled
  for 2026-09-01 will not happen. So $3/$15 never took effect; $2/$10 is not
  an expired intro price.
- **The reconciliation panel names date edits instead of reporting them as
  Unexplained.** A `dateMoved` timing line; the month rows stay effective-date
  reads (Overview parity, the panel's rule 3) plus ONE bank-date read for rows
  counted outside the span; a failed read fails the panel. The gross pin
  becomes `deltaLedger − dateMoved.impact === moneyIn − moneyOut`. Rejected:
  bank-date month reads (the panel would stop washing exactly what Overview
  washes and audit different numbers than it reports); falling back to an
  empty list when the extra read fails (the first-draft design — it would
  render the very residual the read exists to remove).
- **Every figure the reconciliation panel prints is rounded to the cent, and
  `unexplained` rounds the raw difference.** The two balance totals stay
  unrounded: the panel shows only their dates.
- **A >20% subscription price change reads as a price step.** The item keeps
  its key and reports the new price; the old price stays the creep baseline
  until new-price charges outnumber old ones (the moment the plain path's
  median would flip), and a settled step whose old-price tail is down to one
  or two charges is accepted too. Deliberate trade: one new charge can't tell
  a hike from a one-off spike on a variable bill, so a spike reads as a step
  for one cycle. Rejected: requiring a second new-price charge (it brings back
  the false overdue-at-the-old-price in every real hike month). Not built,
  because it adds a threshold and is preference-shaped: allowing a one-charge
  step only when the old price is fixed to within a percent or two.
- **A merchant that fails as a whole is split into amount clusters.** The
  oldest cluster keeps the plain key so ignore entries and seeded bills stay
  attached; extras get ` #n` in first-charge order. Rejected: keying extras by
  amount (a price step would re-key them). Known limits: the numbering can
  shift when the incumbent ages out, and a >20% hike on ONE of several
  subscriptions under one merchant string is read as a new cluster, so the
  hiked one can land on a ` #n` key — exact key stability needs persisted
  identity, i.e. a migration.

## 2026-10-05 — Audit PR C: statement import and PWA shell fixes

The last of the three PRs from the 2026-10-05 review: the statement-import
group and the PWA-shell group, plus a lockfile-only `npm audit fix` (F103) and
a follow-up that keeps sw.js's shell cache write inside the navigation's
waitUntil. PR A (#145) and PR B (#146) had already merged. The item list is
the plan doc's "Improvement backlog (2026-10-05 audit)"; the rules are in the
memory docs (the `src/csvImport.js`, `src/pdfImport.js`,
`src/components/CsvImport.jsx`, `src/theme.js`, `src/lazyWithReload.js`,
`src/components/ErrorBoundary.jsx`, `public/sw.js`, `src/ui.css` and
`vercel.json` key rows). What PR C DECIDED, as opposed to fixed:

- **A PDF's running Balance never takes a money role, and Amount beside
  Balance is one signed amount** (F06). Money columns are named by their
  header; a named Debit+Credit pair wins, a lone "Amount" is the signed
  amount, and the left = debit / right = credit guess applies only to
  unnamed columns. Templates already saved per account are not migrated (a
  bad saved layout is re-adjusted by hand), and rows already imported under
  one must be deleted by hand, since the hash includes the amount. Not built:
  inferring an auto-detected single column's sign from balance deltas. It
  still defaults to out_positive; a statement printing withdrawals negative
  needs the editor's sign select, and the totals line shows when it does.
- **Year-less MM/DD dates parse in PDFs only, with the year from the
  statement period and no guess without one** (F41). CSV `parseDate` stays
  strict, because a CSV has no statement period to take a year from.
- **Trailing CR, DR and minus are read** (F83). `parseMoney` keeps CR
  relative (the opposite of the column's unmarked values), which the PDF
  section flip depends on. After review, `buildRows`' single-amount path
  reads a CR/DR-marked CSV cell as printed, whatever `amountSign` says: the
  CSV default is in_positive, so "100.00 CR" had come in as money out. A
  second review found the same inversion in the PDF Debit/Credit pair:
  `normalizeDebitCredit` subtracted the credit cell, so a redundant
  "100.00 CR" printed in the Credit column netted to a $100 debit. It now
  reads a marked cell as printed in either column too (CR in, DR out; a
  marker contradicting its column is a reversal), which also flips the
  first build's pin that a "45.00 DR" in Credit was a credit. Rejected:
  auto-selecting out_positive for a marked file. `amountSign` is sticky
  across the files of one modal, so an automatic flip would silently carry
  into the next, unmarked file. Accepted residuals: a dated credit-balance
  summary line inside a PDF's table region ("Previous Balance … CR") now has
  a money shape and can import as a row, as unsigned balance lines already
  could, and the totals line exposes it.
  Reporting skipped PDF lines stays the deferred near-miss feature. Under
  out_positive, the section flip can turn a CR-marked deposit inside a
  Deposits section into money out, though auto mode usually declines the
  flip. CR cells were dropped before this, so no existing id moves.
- **CSV description synonyms run Description, Payee, Name, Details, Memo,
  then a generic Transaction column** (F44; Memo was second). Accepted with a
  dedup caveat: the hash includes the description, so a file with NO
  Description column whose description now comes from a different column
  double-inserts if it was already imported under the old order. Delete the
  old import first. The household's backfill files carry a Description column,
  so their ids don't move. Accepted because the old order took blank or
  boilerplate memos: a blank-memo file skipped every row, and a bank's
  boilerplate memo became every row's description. Not built: a
  mostly-blank-column fallback. The reorder covered both reproductions.
- **An Amount column beside one stray debit- or credit-worded column is not
  a pair** (F40). If at least 80% of its sampled cells are Debit/Credit
  markers, it becomes a per-row indicator. Otherwise it is dropped. A row
  with no readable marker is skipped, not signed through `amountSign`,
  because the toggle is hidden for this shape. The pair path needs both
  columns. "Payments" counts as a credit header only as the whole header.
  A detected file that builds no rows offers "Map columns by hand", which is
  never persisted (per-account column memory stays the deferred Group 6
  feature). Accepted residuals: a credit column worded "Payment Amount" no
  longer auto-detects and goes to the manual mapper, and a "Dr/Cr" header
  claims no role, so it reads as one signed Amount with the toggle shown.
- **The import modal adopts the account it creates** (F42). Rejected: name
  dedup inside `createManualAccount`. A name match can't tell this modal's
  own retry from a different account that happens to share the name.
  Adoption fixes the twin where it starts. Changed from the plan: an
  adopted account whose rows didn't land is reported to the parent on CLOSE,
  not at the failure. In the first-run EmptyState that refresh replaces the
  modal with the Dashboard, which drops the adopted target, and a fresh modal
  defaults to "new", so the twin comes back.
- **Reading an account's existing transactions fails closed** (F43), in the
  single-file path and on every batch file's refetch. The one-format check
  re-runs on each of those reads, and a batch read with no sources fails the
  file. After review, these decisions moved into pure helpers in
  `src/csvImport.js` and are tested as behaviour, not source text. Not added:
  a smoke-mock switch that makes the read reject. It would turn the CI render
  gate into a multi-step modal flow for a low-severity path. A second review
  found the single-file read stale after a write: F42's adoption moves the
  target before the write, so that read ran alongside it. It now re-runs
  once `confirm()` settles (success or throw, since earlier slices may have
  committed) and once a batch finishes, before "Open alone" can hand a file
  over.
- **One `useThemeToken` in theme.js** (F99). Two private copies drift on the
  next re-read change, and theme.js imports no component, so the single copy
  creates no cycle.
- **A theme choice storage refuses is held for the session** (F76). Changed
  from the plan, which held it only when the READ failed: old Safari private
  mode reads fine and throws only on the write, so the hold keys on the
  failed write.
- **A stale lazy chunk reloads the app once** (F45). A sessionStorage flag is
  the guard. With the flag already set, or with storage unreadable, the
  error is rethrown. Rejected: retrying without a bound, which loops a
  reload while offline. A second failure lands in `LazyModal`, a boundary
  scoped to the modal. Rejected: leaving it to App's boundary, which blanked
  the whole Dashboard and the nav. `LazyModal` stays in ErrorBoundary.jsx
  because, as its own module, it moved vendor-react's hash with app code
  (the shared-chunk Gotcha). The Vercel rewrite excludes assets/ so a
  missing chunk 404s, and sw.js refuses to cache HTML for an /assets path as
  a backstop. The card's copy ("Couldn't open this … Your data is fine —
  reloading usually fixes it.") was written in the build and is Mason's to
  re-word.
- **sw.js v8 keeps fingerprinted assets across a version bump** (F48). The
  asset cache is unversioned, precache paths are served from the shell
  cache, and activate migrates a legacy assets-v* cache. Rejected: versioned
  asset caches, which wiped every chunk on each bump. Skipped: warming the
  shell's /assets URLs at install, to keep the change small.
- **A navigation gives the network 3s when a cached shell exists** (F85) —
  an engineering default. Trade: on a slow network the previous deploy's
  shell is served more often. The reload-once, the kept assets and the
  background shell update cover that. With no cached shell it waits.
- **The prune spares every /assets URL the fresh shell references**, and it
  runs only after an ok navigation (F86). Cache hits never refresh insertion
  order, so the keep-set is what protects the byte-stable vendor chunks.
- **The shell's `cache.put` rides in waitUntil too** (the review follow-up).
  The lockstep pin now accepts the ternary that keeps the put's promise,
  and it still requires the `fresh.ok` guard.
- **Form controls are 16px on a coarse pointer through one `!important`
  media rule** (F49), and fixed-width fields moved to em so desktop is
  unchanged. Rejected: `maximum-scale=1`/`user-scalable=no`, which disables
  pinch-zoom (accessibility). Rejected too: per-site inline 16px edits,
  because there are dozens of sites and new ones would drift.
- **F103 shipped as a one-off lockfile-only `npm audit fix`.** No `--force`,
  package.json unchanged, dev-tree only (the dev server's express stack and
  eslint's brace-expansion), and nothing in the browser bundle. The
  2026-09-08 rejection was about a recurring `npm audit` CI gate, not about
  applying an in-range fix once.
- **Left for later, by design** (reasons in the plan doc's lists): F84's
  extra CSV date shapes, F87's error-mapping half, and the rulings on F46's
  update signal and F47's cold-start screen.

