# Prompt: next build session (prepared 2026-08-11)

Process artifact, not a roadmap — per the maintenance contract, **the session
that completes this prompt's work deletes this file in its ship PR** (git
holds it). The roadmap stays `next-iteration-plan-2026-08-04.md`; CLAUDE.md is
authoritative when anything disagrees.

Paste everything below the rule into a fresh session started on current
`main`.

---

Ultracode. Read CLAUDE.md fully (it auto-loads; actually read it), then
`docs/next-iteration-plan-2026-08-04.md`. You operate in auto mode under the
ONE standard flow (Development workflow — pull → build → push → PR → merge),
with CI as the merge gate.

**State when this prompt was written (2026-08-11, session archived at
PR #71 + the archive-prep PR):** 759 tests green; CI render gate clicks all
ten tabs; every migration through `20260805000002` applied to PROD and
verified; no code items outstanding except the RLS-harness remainder (plan
doc item 6). Mason's live task is retraining
(post-wipe, every category is created and taught by hand). Open Mason-data
tasks: statement backfill (confirm the Checking 2644→5481 re-key FIRST —
Pending section), and the ~$34 Venture X same-day dupes. Another session may
have landed work since — trust `git log`, not this paragraph.

**Do, in order:**

1. **Sync and verify.** Fetch main; `npm test`; skim `git log` since commit
   `9c892a9` for other sessions' work. If anything above is stale, believe
   the repo and CLAUDE.md's Pending section over this file.

2. **Small chores, no ask needed:**
   - GitHub Actions majors: `actions/checkout@v4` / `setup-node@v4` /
     `cache@v4` target Node 20 and the runner forces Node 24 (deprecation
     warnings in every CI log). Bump to the current majors when available;
     the playwright pin and its cache key move TOGETHER (comment in
     `ci.yml`).
   - Anything `npm test` or the render gate newly flags.

3. **Then ask Mason which lane** (AskUserQuestion; do not pick silently):
   - **Backfill support** — if he has statements ready: PDF template
     teaching, the comparison audit, watch the one-format-per-account rule
     and the sectioned-signs machinery (`pdfImport.js` key row).
   - **Retraining ergonomics** — only if he reports friction; the teach-queue
     and Taught-rules screen are the working surfaces.
   - **Reconciliation** — needs HIS spec first (plan doc Harder 3; the
     mismatch-action half is undesigned).
   - **RLS harness remainder** (plan doc item 6) — the one self-serve item:
     storage-policy assertion + the pg_tables-vs-pg_policies diff, opt-in
     harness only, `npm test` stays zero-dep.
   - **Receipt OCR / cash-flow forecast** (plan doc items 2–3) — both carry a
     recorded DEFER-until-retraining-settles recommendation; build only if
     Mason overrides it.

4. **If Mason is absent**, the RLS remainder is the only justified self-serve
   work. Do not manufacture features; an honest "nothing needs doing" beats
   invented work.

**Standing cautions for this session specifically:** the Feed reach panel's
dismissibility is an OPEN Mason decision (device-vs-household ack storage) —
don't add a dismiss button on your own; `available_balance` on
never-re-pulled accounts may hold pre-#68 two-convention values (simplefin
key row) — treat null as unknown in anything you render; and the payroll
$2,200 twins are BOTH REAL (standing ruling) — do not "fix" them.
