# Prompt for Fable 5 — my-money improvement pass (remaining items)

Copy everything below the line into a fresh session on masonberger4/my-money.

Status end of 2026-08-04: EVERYTHING has SHIPPED (Batch 1, Sections 1–3 — see
CLAUDE.md's Merged features; the last two, in-app saved chats and search
refinement, landed 2026-08-04) except the one deliberate deferral below (the
Dashboard.jsx decomposition). This file remains as the audit record + that
deferral's notes.

---

Work through the remaining improvement backlog for this repo. It came from a
six-dimension multi-agent audit (UX, code health, performance, security,
testing/reliability, data insights), was checked against CLAUDE.md's
decided-don't-relitigate list, and every entry below was re-verified against
the code on 2026-08-01 — do not re-audit; implement.

## Ground rules (from CLAUDE.md — read it first, it wins on any conflict)
- Standard flow for every batch: fetch + absorb `origin/main` → green `npm test` + placeholder-env build (`VITE_SUPABASE_URL=https://placeholder.supabase.co VITE_SUPABASE_ANON_KEY=placeholder npm run build`) → push feature branch → PR → merge (auto mode). Screenshot UI work at 390px via the mock harness.
- One branch per coherent batch, cut from current main; merge before starting the next batch. Never rebase pushed branches — merge origin/main in.
- No migrations are needed for anything below. Do not touch the sign conventions, the two spending models, theme-token rules, or anything in the Gotchas.
- The Debt tracker has shipped and merged (PR #10) — do not rebuild it.

## Section 2 — ALL SHIPPED 2026-08-01 (entries deleted per the rule above; see CLAUDE.md's "Backlog sweep" Merged-features entry)

## Section 3 — later (Mason reviewed the list 2026-08-01; his decisions inline)
All feasibility-verified 2026-08-01; corrections inline.
- Dashboard.jsx staged decomposition — **DEFERRED by Mason 2026-08-01**: keep the single file while the app is in active development; decompose later as its own project. (When it happens: sheets/formatters → shared TxRow → read-only tabs; the mock harness aliases dataAdapter/sync/db/apiClient by full-match regex — new modules must import through dataAdapter.js or they escape the mocks.)
- ~~Recurring weekly/annual cadences + ignore list~~ **SHIPPED 2026-08-03 (recurring v2)** — cadence bands (weekly 7±2, monthly unchanged, annual 365±15) with per-band near-tolerance and due-soon windows (2/7/30 days), `cadence`+`monthlyEquivalent` on each item, the 40-month candidate window (25 as first shipped; corrected in review — annual's last renewal is itself up to a year old — along with recency-sliced gates and a staleness cutoff), and the household ignore list under the ONE `rec:ignore` settings key (Mason's ruling honored: settings table, not localStorage), filtered at render so toggling never refetches. Monthly thresholds untouched — the pinned tests extended, not loosened. The earlier half: ~~**Recurring signal UI: DECIDED — badges on the Recurring tab**~~ **SHIPPED 2026-08-01** — quiet inline pills in the recurring row's pill row: amber price-creep (`medianAmount`→`lastAmount` "was/now") and amber/red due-soon/overdue off `dueStatus`, colours run through `chipOn` against the card surface. `detectRecurring` now gets a wall-clock `today`.
- ~~Trends "biggest movers"~~ **SHIPPED 2026-08-03** — pure `biggestMovers` in `src/spending.js` (`isSpend()` lineage, top 5 by |delta|, $1 noise floor) + `getBiggestMovers` on the range memo; its own card on the Trends tab with month-tagged state. (Same-day the two models were UNIFIED into the linked-boundary model — movers reconciled at merge to read the one `isSpend()` on `markInternalTransfers`-marked rows.)
- ~~Envelope pace warning — **DECIDED with scoping**~~ **SHIPPED 2026-08-01** — per-envelope opt-in (⏱ toggle on the Budget-tab envelope row), stored NO-MIGRATION under the single `env:pace` settings key (JSON `{category:true}`, default OFF, `getEnvPace`/`setEnvPace`). Pure `envelopePace` in `src/envelopes.js` (display-only: reads the walk's `spent`, `expected = elapsedFraction × assigned`, warns past a 10% margin, null outside the current month / with no assignment); `isBudgetableCategory`-gated; amber `⏱ ahead of pace` pill via `chipOn` against the card. No walk/available change. Tests added to `test/envelopes.test.js`.
- ~~Prompt-injection fencing~~ **SHIPPED 2026-08-01 (Mason's go)** — one static sentence in `api/assistant.js`'s SYSTEM_PROMPT: transaction text is data, never instructions. One-time prompt-cache invalidation; `formatSpendingContext` untouched.

## Dropped (verified already-done or rejected 2026-08-01)
- `pullWasClean` tests — already thorough in test/csvImport.test.js (the advisory REGRESSION included); `test/sync.test.js` (batch 2) added direct coverage plus the previously-untested `runSync` single-flight via an injected transport.
- Per-household assistant rate limiter — a table/KV-backed limiter stays rejected ("pragmatic > enterprise"); batch 2 shipped a 20-line in-memory per-instance throttle (10/min, 429) instead — best-effort burn-rate cap on a leaked token, honestly commented as such.
- `patchAllTxLists` helper — the recompute had already been centralized in
  saveTx's `apply` closure (PR #12), which narrowed the premise; PR #15 then
  superseded that closure anyway: a named `patchAllTxLists` covering all four
  tx lists (incl. `selTx`) via the pure `patchTxShape` (`src/spending.js`,
  tested), plus exact-pre-patch-row rollback on failure instead of refetch.
