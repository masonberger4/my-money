# my-money — project memory (index)

Household spending dashboard for two users (Mason + wife), shared login,
laptop + iPhone PWA. Personal project; pragmatic > enterprise. The repo is
PUBLIC: no household PII in any checked-in text.

THIS FILE IS A ≤100-LINE INDEX (Mason's cap, 2026-08-31, pinned by
`test/claudeMdLockstep.test.js`). The rules live in docs/memory/ — read the
doc covering your work area BEFORE editing, and maintain it in the same PR
(the contract). Settled decisions also append to `docs/decisions.md`.

## Memory map

| Memory doc | Read it before |
|---|---|
| `docs/memory/maintenance-contract.md` | every session's first edit to any memory doc — the contract: same-PR upkeep, one source of truth, PII rules, history-compresses |
| `docs/memory/architecture.md` | touching data flow: Supabase, auth/RLS, sync, SimpleFIN, api/ |
| `docs/memory/key-files.md` | touching any src/api/test file — the per-file rules and invariants |
| `docs/memory/workflow.md` | pushing, merging, migrations, CI, repo settings |
| `docs/memory/conventions.md` | anything touching money math (spending/income model, categories, envelopes, tax, receipts) or UI conventions |
| `docs/memory/gotchas.md` | debugging anything surprising; before "fixing" odd-looking code |
| `docs/memory/ship-record.md` | history: merged features, standing data rulings, roadmap |
| `docs/decisions.md` | append-only decision journal (newest last) |
| `docs/claude-routing.md` | the delegation setup: agents, hooks, verification, tuning |

## Commands

- Tests: `npm test 2>&1 | .claude/hooks/test-digest.sh` — full TAP is 5,700+
  lines; the digest keeps the verdict and any failures verbatim.
- Build: `VITE_SUPABASE_URL=https://placeholder.supabase.co VITE_SUPABASE_ANON_KEY=placeholder npm run build`
- Smoke (renders all 11 views): `npm install --no-save playwright-core@1.62.1`,
  then `npx vite --config test/smoke/vite.config.js --port 5199 &`, then
  `CHROMIUM_PATH=/opt/pw-browsers/chromium node test/smoke/render.mjs`
- No lint, no typecheck. Node's built-in test runner, zero test deps.

## Invariants (always hold — reasons and detail live in docs/memory/)

- Amounts: POSITIVE = money out, negative = money in. SimpleFIN arrives
  opposite, as numeric strings; the server normalizes on the way in.
- ONE spending/income model: `isSpend` / `isIncome` / `displayCategory` are the
  only verdicts — never re-derive what a row shape already carries (`counted`).
- Never rename or drop `plaid_tx_id` / `plaid_account_id` — adapter-agnostic
  external ids (`sfin:` / `csv:` / `manual:`), both upsert conflict targets.
- Sync upserts OMIT user-owned columns (nickname, color, hidden, type on
  existing rows, `user_category`, `user_type`, `excluded`, debt columns) so
  edits survive pulls. Never restate them in a uniform upsert payload.
- Migrations: additive-only on live data; a DROP inverts paste order (paste
  AFTER deploy); every file must also replay on a fresh EMPTY database; PROD
  is NEVER linked to the Supabase CLI. Use the /migration skill.
- Sign-out stays `signOut({ scope: 'local' })` — the default global scope
  would revoke the shared user's other devices.
- Theme token values live ONLY in src/ui.css (plus index.html's deliberate
  pre-paint duplicate); never set a token as an inline style.
- Debt balances are stored positive and displayed through `displayBalance`.
  Hidden accounts are excluded at the QUERY level everywhere.

## Workflow (full rules: docs/memory/workflow.md)

AUTO MODE (Mason's standing authorization): pull → build (tests + build +
smoke; screenshots for UI work) → push `claude/feature-<name>` → open PR →
ARM AUTO-MERGE (squash) the moment it opens → confirm the merge landed.
Absorb `origin/main` (merge, NEVER rebase) before every push and again before
the merge. main auto-deploys to production. /ship runs the whole flow;
/pre-pr runs just the gate. Anything risky, preference-shaped, or
migration-sequenced still goes past Mason first.

## Delegation & routing

Route work to the cheapest agent that can do it (definitions in
.claude/agents/; full table + tuning in docs/claude-routing.md):

- Code search, "where is X", inventory sweeps → Explore agent. Never read
  Dashboard.jsx whole (7,900 lines) — search it.
- Running tests/build/smoke → runner agent (or the digest pipe above). Raw
  `npm test` output must not enter the main context.
- Diff touches src/components/ or src/ui.css → ui-verifier agent (smoke walk
  + 390×844 screenshots) before pushing.
- Before every push → reviewer agent on the full diff. A diff that settles a
  decision or changes workflow → memory-auditor agent (memory docs + lockstep).
- A fix attempt failed, or behavior contradicts the documented rules →
  debugger agent. Schema / model-precedence / security design → architect
  agent. Neither is for first-pass bugs or routine features.
- Skills: /pre-pr, /ship, /migration, /memory-audit, /escalate (stuck after
  two failed attempts), /cheap-pass (mechanical batch edits).
- At the end of a work slice, append settled decisions to `docs/decisions.md`;
  a decision that changes a recorded rule also fixes that rule in its memory
  doc, same PR.

## Compact instructions

A compaction summary MUST preserve: (1) the current task and its acceptance
criteria; (2) every touched file path; (3) failing tests with verbatim error
text; (4) decisions made AND rejected this session; (5) whether origin/main
was absorbed and the last green check run; (6) push / PR / auto-merge state;
(7) which docs/memory files were already read — path-scoped rules drop out
after compaction, so re-read the relevant memory doc before further edits.
