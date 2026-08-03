# Future-sessions plan — my-money remaining work

Source of truth: `docs/improvement-backlog-2026-08-01.md` Section 3 remainder (Mason's decisions inline) + CLAUDE.md Roadmap. Verified against code at c06b2fa: `Dashboard.jsx` is 3,787 lines (all sessions below touch it — sequence them, never parallel, per the one-session-per-line-of-work gotcha); `api/sync.js` already snapshots **all** usable accounts into `balance_snapshots` (not just debts — line 392, balance-moved gate), which changes the net-worth sizing. (The "no sign-out exists anywhere in `src/`" observation is spent — the header sign-out button shipped 2026-08-03.)

**Status 2026-08-03 (second update):** the household attached ALL accounts,
which surfaced a $24k/quarter double count; the diagnosis session shipped the
**unified linked-boundary spending model** (PR #32 — replaces the two-model
design; loan payments count as spending, card payments never, hidden =
unlinked) and the temporary **Data coverage panel** (PR #31). Outstanding
data/ops tasks are in CLAUDE.md → Pending; the full diagnosis is archived in
`docs/double-count-diagnosis-2026-08-03.md`.

**Status 2026-08-03:** the Section 3 batch SHIPPED (card-cycling tile, Ask
persistence + Save chat, Uncategorized teach-queue, startup skeleton + month
jump picker) — that covers most of Session 1 (minus search refinement +
sign-out), the teach-queue half of Session 2, and Session 4's v1. Session 3
(recurring v2: weekly/annual cadences + household ignore list) SHIPPED
2026-08-03, as did Trends biggest movers (Session 2's second half) and the
sign-out button. **Session 5 (debt follow-ups) SHIPPED 2026-08-03** — all
three items plus the available_balance note re-recorded; Mason's fresh
decisions the same day: net worth excludes hidden accounts; **in-app saved
chats: BUILD** (settings-table storage — the Session 4 sizing question is
answered, needs its own session); **search refinement spec DECIDED**:
amount-range filter + date-range filter + load-more past the 200 cap (needs
its own session); **Session 6 scope DECIDED: all three** (see Session 6).
**Session 6 SHIPPED 2026-08-03** (all three items — see the Session 6 section).
Remaining: saved chats, search refinement. When both ship, this plan is spent —
delete it.

All sessions follow the standard flow (fetch/absorb main → green `npm test` + placeholder-env build → screenshots at 390px for UI → branch → PR → merge, auto mode).

---

## Session 1 — "Dashboard UX polish + card-cycling tile" — **M**
The pure-UI cluster; runs first so the heaviest Dashboard.jsx churn lands before the tab-feature sessions branch off it.

**Items** (all Dashboard.jsx + small localStorage plumbing, no adapter changes):
- **Card-balance cycling tile** — Mason's decided spec (backlog line 34): cycle through unhidden credit accounts, click on desktop / swipe on iPhone; selection is a DEVICE pref in localStorage (the `mm:theme` precedent — settings-table would flip the other phone, and every access try/caught for Safari private mode); balance through `displayBalance`; account-name label stays in sync; swipe handler needs a horizontal-intent threshold so it doesn't fight page scroll.
- **Startup skeleton** (extend the existing `Sk` component to first paint).
- **Month jump picker** (replaces repeated month-arrow taps).
- **Client-side search refinement** — **spec DECIDED by Mason 2026-08-03**: amount-range filter + date-range filter + load-more past the 200 cap. Decided, unbuilt — needs its own session.
- ~~**Sign-out button**~~ **SHIPPED 2026-08-03** — header placement via a dataAdapter `signOut()` passthrough, and `{ scope: 'local' }` is load-bearing (supabase-js v2's default `'global'` revokes the SHARED household user's every session — it would sign the other phone out too).

**Migration:** none. **Mason mid-session:** none — the tile spec is decided. **Post-merge:** Mason verifies the swipe gesture on the real iPhone (the receiptImage precedent: touch behavior isn't testable in the harness).

## Session 2 — "Spending insight: Uncategorized teach-queue + Trends biggest movers" — **M** — **SHIPPED** (teach-queue 2026-08-02, biggest movers 2026-08-03)
Both are "understand my categories" features sharing the `src/spending.js` / `isSpend()` lineage and its test fixtures.

**Items:**
- ~~**Uncategorized teach-queue**~~ **SHIPPED 2026-08-02** (Section 3 batch) — top-5 Uncategorized groups by `merchantKey` feeding the existing `learnMerchant` flow, derived in render from the month's rows (no cache).
- ~~**Trends biggest movers**~~ **SHIPPED 2026-08-03** — pure `biggestMovers` in `src/spending.js` + tests against the ledger fixture; its own card on the Trends tab, month-tagged state. (Same-day model unification: movers reconciled at merge to the one `isSpend()` predicate over `markInternalTransfers`-marked rows.)

**Migration:** none. **Mason mid-session:** none. **Order:** after Session 1 (both edit the Categories/Trends regions of Dashboard.jsx).

## Session 3 — "Recurring v2: weekly/annual cadences + ignore list" — **M** — **SHIPPED 2026-08-03**
Self-contained: `src/recurring.js` (pure) + the Recurring tab + one settings key (`rec:ignore`). See CLAUDE.md's "Recurring v2" Merged-features entry for the decided details (cadence bands, `monthlyEquivalent`, the 40-month candidate window, render-time ignore filter).

**Items:**
- Weekly and annual cadence detection alongside the existing monthly logic. Existing tests pin thresholds **as documentation — extend, don't loosen** (backlog line 30).
- Ignore list — a **household** pref, so `settings` table (not localStorage; Mason's ruling inline in the backlog). Add-to-ignore affordance on the recurring row + a way to un-ignore.
- Keep `dueStatus`/`priceCreep` (already shipped) working for the new cadences.

**Migration:** none (settings key). **Mason mid-session:** none.

## Session 4 — "Ask-tab persistence + save-chat" — **S/M**
**Items:**
- sessionStorage scrollback persistence (device-local ephemera; try/catch every access — Safari private mode throws).
- Explicit "save this chat" — a costly Opus answer shouldn't evaporate. **v1 default: export via the iOS share sheet** (the `scheduleECsv` precedent).

**Migration:** none for v1. ~~**Mason mid-session: YES — the one open sizing question** (backlog line 35): should saved chats live IN the app (→ `settings`-table storage, slightly bigger build) or is share-sheet export enough?~~ **ANSWERED 2026-08-03: BUILD in-app saved chats, `settings`-table storage** — decided, unbuilt, needs its own session. (v1 — sessionStorage scrollback + share-sheet export — shipped 2026-08-02.)

## Session 5 — "Debt follow-ups: manual debts + payoff schedules + net worth" — **L** — **SHIPPED 2026-08-03**
The `balance_snapshots` groundwork session. As built (see CLAUDE.md's three Merged-features entries for the decided details):

**Items:**
- ~~**Manual debts**~~ **SHIPPED** — `createManualAccount` gained kind `'loan'` + optional hand-typed balance (pure `buildManualAccountRow`; stored POSITIVE = owed); Debt-tab "+ Add manual debt" form + a balance editor on manual debts only. One deliberate deviation from the sketch above: the balance edit is a dedicated `updateManualBalance(account, balance)` path with an is_manual gate (`manualBalanceUpdate`), NOT a widening of `updateAccount`'s whitelist — a fed balance is restated by every pull, so the whitelist keeps omitting `current_balance`. Balance changes append `balance_snapshots` client-side (RLS default fills household_id). QuickAdd excludes loan-typed manual accounts. `test/manualDebt.test.js`. No migration.
- ~~**Per-debt payoff schedules view**~~ **SHIPPED** — "Schedule ›" drill-in (`ScheduleSheet`) off the new pure `amortizationSchedule` in `src/debtPayoff.js`, months/totalInterest test-pinned identical to `amortizeOne`; stall renders the honest banner, remaining balances through `displayBalance`.
- ~~**Net worth over time**~~ **SHIPPED** — pure `netWorthSeries` (`src/netWorth.js`) folds snapshots carrying each account's last value forward; totals signed via `displayBalance` inside the fold; Debt-tab card + sparkline. **Mason's scope answer (2026-08-03): hidden accounts' balances are EXCLUDED**, consistent with the query-level rule — filtered in `getNetWorthSeries` so the pure fold never sees them. `test/netWorth.test.js`.
- ~~**Resolve the `accounts.available_balance` dual-convention note**~~ **DONE** — nothing in the session rendered it (grep-verified); the Roadmap note re-recorded accurately, dual convention stands until something shows utilization/available credit.

**Migration:** none, as expected.

## Session 6 — "Envelope follow-ups" — **SHIPPED 2026-08-03** (all three; reconciliation stayed out)

What actually shipped (truthful against the diffs):
- ~~**Per-month target overrides**~~ **SHIPPED** — additive `budget_months.target_override`
  (`20260804000001`); month scope in the `TargetSheet`, `effectiveTarget` in
  `envelopes.js` resolves override → `budgets.monthly_limit`. `setAssigned(…, 0)`'s
  delete is now conditional so it can't drop a row carrying only an override; a
  42703 naming `target_override` retries with the old columns and never trips
  `isEnvelopeSchemaMissing` (pre-migration the whole Budget tab must stay up).
- ~~**Auto-fill from last month**~~ **SHIPPED** — pure `planAutoFill` (`envelopes.js`):
  copies ASSIGNED only (never targets), skips zeros (0 row ≡ no row) and
  categories already assigned in the viewed month; two-step confirm in the
  Budget tab, write via `autoFillMonth`. Direction is pull viewed−1 → viewed.
- ~~**Scheduled/expected transactions**~~ **SHIPPED** — `expected_transactions`
  table (`20260804000002`), pure core `src/expectedTx.js`. DISPLAY-ONLY (the
  `envelopePace` contract — never in Available/the walk/any total); opt-in
  seeding from the Recurring tab ("Expect"); greedy nearest-date auto-match →
  status lifecycle pending/matched/dismissed ('overdue' derived); roll-forward
  dup-gated on both keyed AND null-key rows; ✕ on a recurring row offers
  Skip-this-cycle / Stop-expecting; reads return null pre-migration
  (`getReceiptTxIds` pattern).
- **Reconciliation** — still OUT; spec open, its own later session if ever.

**Migrations:** the TWO 20260804 files are additive and the code degrades
gracefully without them — **paste BOTH in the Supabase SQL Editor BEFORE the
merge** (workflow rule 5).

---

## Sequencing summary
1 (UI polish cluster) → 2 (spending insight) → 3 (recurring v2) → 4 (Ask persistence; movable, needs one Mason ping) → 5 (debt/net-worth; benefits from snapshot history accruing) → 6 (envelopes; gated on Mason scoping, and 3 before 6 because scheduled-transactions can lean on cadence detection). Hard dependencies are only 3→6 and "5 late"; 2/3/4 can reorder freely. Every session cuts from current main — never stacks on a merged branch.

## Explicitly NOT planned
- **Dashboard.jsx decomposition** — DEFERRED by Mason 2026-08-01; keep the single file while development is active. (When it happens: sheets/formatters → shared TxRow → read-only tabs; new modules must import through dataAdapter.js or they escape the mock harness's full-match aliases.)
- **Age of Money** — gated on the income wall: needs real *measured* income; deriving income is a decision for Mason, not an automatic upgrade.
- **Channel C home-IP scraper** — OUT per Roadmap (ToS/lockout risk; scoped-surgical if ever).
- **Email-alert cron** — OUT per Roadmap.
- **Receipt OCR** (`api/receipt-ocr`) — noted upgrade path, not committed.
- **Cash-flow forecast, savings goals, CSV/PDF export** — "discussed, not committed" (Roadmap); need Mason to commit before they earn a session. (Savings goals may already be mostly covered by by-date sinking-fund targets — worth raising when he asks.)
- **Deriving RTA income from the feed** — the income wall stands until every income account is reliably fed; Mason's call, separately.
