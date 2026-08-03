# Future-sessions plan — my-money remaining work

Source of truth: `docs/improvement-backlog-2026-08-01.md` Section 3 remainder (Mason's decisions inline) + CLAUDE.md Roadmap. Verified against code at c06b2fa: `Dashboard.jsx` is 3,787 lines (all sessions below touch it — sequence them, never parallel, per the one-session-per-line-of-work gotcha); `api/sync.js` already snapshots **all** usable accounts into `balance_snapshots` (not just debts — line 392, balance-moved gate), which changes the net-worth sizing. (The "no sign-out exists anywhere in `src/`" observation is spent — the header sign-out button shipped 2026-08-03.)

**Status 2026-08-03:** the Section 3 batch SHIPPED (card-cycling tile, Ask
persistence + Save chat, Uncategorized teach-queue, startup skeleton + month
jump picker) — that covers most of Session 1 (minus search refinement +
sign-out), the teach-queue half of Session 2, and Session 4's v1. Session 3
(recurring v2: weekly/annual cadences + household ignore list) SHIPPED
2026-08-03, as did Trends biggest movers (Session 2's second half) and the
sign-out button. Remaining: search refinement (needs a Mason spec), Session 5
(debt follow-ups), Session 6 (envelopes, Mason-gated), and the in-app
saved-chats sizing question.

All sessions follow the standard flow (fetch/absorb main → green `npm test` + placeholder-env build → screenshots at 390px for UI → branch → PR → merge, auto mode).

---

## Session 1 — "Dashboard UX polish + card-cycling tile" — **M**
The pure-UI cluster; runs first so the heaviest Dashboard.jsx churn lands before the tab-feature sessions branch off it.

**Items** (all Dashboard.jsx + small localStorage plumbing, no adapter changes):
- **Card-balance cycling tile** — Mason's decided spec (backlog line 34): cycle through unhidden credit accounts, click on desktop / swipe on iPhone; selection is a DEVICE pref in localStorage (the `mm:theme` precedent — settings-table would flip the other phone, and every access try/caught for Safari private mode); balance through `displayBalance`; account-name label stays in sync; swipe handler needs a horizontal-intent threshold so it doesn't fight page scroll.
- **Startup skeleton** (extend the existing `Sk` component to first paint).
- **Month jump picker** (replaces repeated month-arrow taps).
- **Client-side search refinement**.
- ~~**Sign-out button**~~ **SHIPPED 2026-08-03** — header placement via a dataAdapter `signOut()` passthrough, and `{ scope: 'local' }` is load-bearing (supabase-js v2's default `'global'` revokes the SHARED household user's every session — it would sign the other phone out too).

**Migration:** none. **Mason mid-session:** none — the tile spec is decided. **Post-merge:** Mason verifies the swipe gesture on the real iPhone (the receiptImage precedent: touch behavior isn't testable in the harness).

## Session 2 — "Spending insight: Uncategorized teach-queue + Trends biggest movers" — **M** — **SHIPPED** (teach-queue 2026-08-02, biggest movers 2026-08-03)
Both are "understand my categories" features sharing the `src/spending.js` / `isSpend()` lineage and its test fixtures.

**Items:**
- ~~**Uncategorized teach-queue**~~ **SHIPPED 2026-08-02** (Section 3 batch) — top-5 Uncategorized groups by `merchantKey` feeding the existing `learnMerchant` flow, derived in render from the month's rows (no cache).
- ~~**Trends biggest movers**~~ **SHIPPED 2026-08-03** — pure `biggestMovers` in `src/spending.js` (spendingGroups lineage) + tests against the ledger fixture; its own purchase-based card on the Trends tab, month-tagged state, never mixed with the cash-flow numbers.

**Migration:** none. **Mason mid-session:** none. **Order:** after Session 1 (both edit the Categories/Trends regions of Dashboard.jsx).

## Session 3 — "Recurring v2: weekly/annual cadences + ignore list" — **M** — **SHIPPED 2026-08-03**
Self-contained: `src/recurring.js` (pure) + the Recurring tab + one settings key (`rec:ignore`). See CLAUDE.md's "Recurring v2" Merged-features entry for the decided details (cadence bands, `monthlyEquivalent`, the 25-month candidate window, render-time ignore filter).

**Items:**
- Weekly and annual cadence detection alongside the existing monthly logic. Existing tests pin thresholds **as documentation — extend, don't loosen** (backlog line 30).
- Ignore list — a **household** pref, so `settings` table (not localStorage; Mason's ruling inline in the backlog). Add-to-ignore affordance on the recurring row + a way to un-ignore.
- Keep `dueStatus`/`priceCreep` (already shipped) working for the new cadences.

**Migration:** none (settings key). **Mason mid-session:** none.

## Session 4 — "Ask-tab persistence + save-chat" — **S/M**
**Items:**
- sessionStorage scrollback persistence (device-local ephemera; try/catch every access — Safari private mode throws).
- Explicit "save this chat" — a costly Opus answer shouldn't evaporate. **v1 default: export via the iOS share sheet** (the `scheduleECsv` precedent).

**Migration:** none for v1. **Mason mid-session: YES — the one open sizing question** (backlog line 35): should saved chats live IN the app (→ `settings`-table storage, slightly bigger build) or is share-sheet export enough? Ask at session start; build export-only if unreachable. **Order:** anytime after Session 1; smallest session, good gap-filler.

## Session 5 — "Debt follow-ups: manual debts + payoff schedules + net worth" — **L**
The `balance_snapshots` groundwork session. Snapshots have accrued for ALL accounts since 2026-08-01, so net worth needs no new capture machinery — but the history is only days deep; shipping later gives the chart something to show.

**Items:**
- **Manual debts** — reuse the `is_manual` machinery (`createManualAccount` + the account-type editor already handle manual `credit`; extend to `loan` with hand-typed balance). Verify `updateAccount`'s whitelist covers `current_balance` for manual accounts (a manual balance is typed by hand — the existing convention). Sync must keep skipping them.
- **Per-debt payoff schedules view** — a drill-in rendering the month-by-month amortization `src/debtPayoff.js` already computes; pure core exists, this is UI + maybe one exported helper.
- **Net worth over time** — assets − debts off `balance_snapshots` (debts negated via the `displayBalance` sign rule; snapshots store the raw stored-positive convention, per the sync comment at line 322).
- **Resolve the `accounts.available_balance` dual-convention note** (Roadmap): it holds SimpleFIN's raw value OR the normalized balance (`?? balance` fallback, sync.js line 387). The moment anything renders it, sort it out — and never run it through `displayBalance` (for a card it's available *credit*). If nothing in this session renders it, re-record the note and move on.

**Migration:** none expected (snapshots table + liability columns are live). If manual debts turn out to need a column, it's additive → paste before merge. **Mason mid-session:** a scope check on net worth (which accounts count; hidden accounts presumably excluded per the query-level rule) — preference-shaped, so ask.

## Session 6 — "Envelope follow-ups" — **L**, needs Mason's scoping FIRST
The four unbuilt envelope items (Roadmap). Least specified — open with a scoping conversation before writing code.

**Items** (Mason picks the subset):
- **Per-month target overrides** — a target is one setting per category today; per-month likely means an additive column on `budget_months` → **migration (additive, paste before merge)**.
- **Auto-fill next month's assignments from this month's** — pure `envelopes.js` + one write path; must respect the "missing row = 0, never fall back to target" REGRESSION-pinned rule.
- **Scheduled/expected transactions** — new table → **migration (additive)**; interacts with recurring detection (Session 3 lands first so cadences exist to seed expectations).
- **Reconciliation** — spec entirely open; may be its own later session.

**Migration:** yes, additive (safe order: paste before merge). **Mason mid-session: YES — scope selection up front**, plus the standing envelope don't-relitigate list constrains everything (no walk clamp, no derived income, `isSpend()` only).

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
