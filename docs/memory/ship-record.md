## Merged features (live on main; details in code + PRs)

Ship record ONLY — every decided rule lives in Architecture / Key files /
Conventions / Gotchas. An entry here is a pointer, not a home for rules.

- **Transaction editing** — `user_category`/`excluded`/`user_description`
  columns; rules in the effective-category + sync-omit Conventions and the
  `saveTx` Gotcha.
- **Budgets** — per-category monthly limits; `budgets` table; envelope
  Conventions.
- **Recurring** — `src/recurring.js` key row.
- **Search** — cross-month `ilike` (`searchTransactions`); `searchFilters.js`
  key row.
- **Assistant ("Ask" tab)** — `api/assistant.js`; rules in the
  `spendingContext.js` key row + the assistant Convention.
- **Trends cash-flow section** — linked-boundary Conventions.
- **CSV import** (migration `20260722000001`) — rules in the `csvImport.js` +
  `CsvImport.jsx` key rows.
- **Internal-transfer max-matching** — Kuhn's, not greedy; linked-boundary
  Conventions.
- **Dark mode + Auto/Light/Dark toggle + palette contrast** — theme/palette
  Conventions.
- **PDF statement import** — no migration; rules in the `pdfImport.js` /
  `PdfTemplateEditor.jsx` key rows + the one-format-per-account Gotcha.
- **SimpleFIN feed phases 1–2, account-type editor, classifier rebuild,
  learned merchant rules** (migrations `20260724000001`, `20260728000001`) —
  rules in Architecture/Conventions.
- **Plaid removed** (migration `20260728000002`, DROPS — pasted AFTER deploy
  per workflow rule 5); `plaidClient.js` → `apiClient.js`.
- **Statement import mode derived from the file's date range** —
  `CsvImport.jsx` key row.
- **Envelope budgeting (YNAB 1–3)** (migration `20260729000001`) — envelope
  Conventions.
- **Category drill-in + one unified category list** — `counted`-split
  Convention + `categoryList.js` key row.
- **SimpleFIN advisory deadlock fixed** — the first Gotcha;
  `test/simplefin.test.js`.
- **Rental tracking + tax prep (Tax tab)** (migration `20260730000001`) — tax
  Conventions.
- **Category filter chips (Transactions tab)** — rules in the `Dashboard.jsx`
  key row + the cross-month-browse-refuted Convention.
- **Tax-linkage visibility** — `PropertySheet`/`entityLedger` (`taxReport.js`
  key row), hand-tagged-Pill rule in the tax Conventions, epoch invalidation
  per the `setState(null)` Gotcha.
- **Receipt capture v1** (migration `20260731000001`) — receipt Conventions;
  OCR upgrade path in Roadmap.
- **Comprehensive testing suite** — the `test/` key row is the live inventory;
  harness gap noted in Local checks.
- **Hardening batch (2026-08-01)** — sw.js `fresh.ok` guard, self-hosted
  fonts, `ErrorBoundary.jsx`, amber feed banner, `patchAllTxLists` (the
  `saveTx` Gotcha), NULL-safe throttle stamp (Architecture), FAB removed
  (Mason). PR #15.
- **Backlog sweep (2026-08-01)** — SSRF hardening (`fetchNoOpenRedirect`
  Gotcha), remove-bank soft-hide + Restore (`unlink.js` key row), manual
  quick-add (Convention), month memo (`monthMemo.js` key row), assistant
  recurring/envelope context (`spendingContext.js` key row), per-instance
  assistant throttle (assistant Convention), 416 fixes
  (`isRangeExhaustedError`).
- **Section-3 signals + assistant fence (2026-08-01)** — recurring badges;
  `env:pace` (`envelopes.js` key row); prompt-injection fence
  (`spendingContext.js` key row).
- **Section 3 batch (2026-08-03)** — card-balance tile (`mm:cardTile`
  Convention), Ask-tab persistence (`savedChats.js` key row), teach-queue
  (`teachQueue.js` key row), startup skeleton + month jump picker
  (`Dashboard.jsx` key row).
- **Unified linked-boundary spending model (2026-08-03, Mason)** — replaced
  the two-model design after the F1/F2 double-count diagnosis (PR #32 carries
  the write-up and quarter-level figures). Its findings doc was spent and
  deleted 2026-08-13 once every row read RESOLVED — but the verified
  per-month before/after totals were in THAT FILE and nowhere else, so if
  they are ever wanted: `git show e6822d8:docs/double-count-diagnosis-2026-08-03.md`
  (checked — they are not in PR #32 or #33). All rules in the linked-boundary
  Conventions.
- **Manual debts (2026-08-03)** — `buildManualAccountRow`; rules in the
  debt-balances Convention (updateManualBalance, snapshots) + Architecture
  (manual institution `status='disabled'`). `test/manualDebt.test.js`.
- **Data coverage panel** — `coverage.js` key row; shipped TEMPORARY, ruled
  KEEP by Mason 2026-08-13.
- **Debt tracker v1** (migration `20260801000001`) — `debtPayoff.js` key row +
  debt-balances/sync-omit Conventions.
- **Recurring v2 (2026-08-03)** — `src/recurring.js` key row; never restore an
  unmarked fetch path (`getTransactionsBetween` ALWAYS runs the pairing —
  linked-boundary Conventions).
- **Trends biggest movers (2026-08-03)** — `biggestMovers` (`spending.js` key
  row); month-tagging lesson now in the `setState(null)` Gotcha.
- **Per-debt payoff schedule drill-in (2026-08-03)** — `debtPayoff.js` key row
  (ScheduleSheet rules).
- **Net worth over time (2026-08-03)** — `netWorth.js` key row.
- **Sign-out button (2026-08-03)** — `scope:'local'` rule in the Architecture
  Auth bullet.
- **In-app saved chats (2026-08-04)** — `savedChats.js` + `serializedUpdater.js`
  key rows.
- **Search refinement (2026-08-04)** — `searchFilters.js` key row.
- **Envelope follow-ups (Session 6)** (migrations `20260804000001`,
  `20260804000002`) — envelope Conventions + `expectedTx.js` key row.
- **Session A silent-failure guards (2026-08-04)** — paged-loop guards
  (`ruleHistory.js` key row), column name-check (missing-table/column Gotcha),
  optimistic-write rollback+alert, `{confirm:'disconnect'}` gate (`unlink.js`
  key row), sanitized api/ 500s (Convention).
- **Month-navigation cache reuse (2026-08-04, Mason)** — `monthMemo.js` key
  row (reuse + `refreshTick`).
- **Feed-reach shortfall surfaced (2026-08-06)** — `coverage.js` key row (all
  five rules incl. the refuted alternatives); `pullWasClean` note in the first
  Gotcha. `api/sync.js` still returns `coverage_shortfall`, read by nobody —
  transient, absent on steady-state pulls.
- **User-owned categories (2026-08-05, Mason — REVERSES the seed taxonomy)** —
  migration `20260805000001`, applied + verified 2026-08-05, pasted AFTER the
  deploy (its DEPLOY ORDER block says why); preserved-then-wiped with
  `legacy_*` archives gated on `legacy_categories_saved`. Rules in the
  no-shipped-categories Conventions + `categoryMap.js`/`categoryList.js` key
  rows; rule-wipe rationale in the categorization-precedence Convention
  (re-mints hazard). `test/userOwnedCategories.test.js`.
- **Honest category populations post-wipe (2026-08-05)** — teach-queue
  counted-split + card-level placement (`teachQueue.js` key row); Schedule E
  picker filtering (tax Conventions).
- **Taught-rules screen (2026-08-04)** — `RulesSheet`; `listCategoryRules`
  null pre-migration (`dataAdapter.js` key row); count semantics + delete
  semantics in the `ruleHistory.js` key row. Rules load on an EPOCH (not a
  null sentinel), seq-guarded, teaching bumps it; `rulesOpen` is registered in
  BOTH `anySheetOpen` and `closeAllSheets`.
- **Phone-first UX batch (Session B, 2026-08-04)** — unhide confirm
  (`src/unhideConfirm.js`), hit areas, filter-only search, `useEscClose`,
  back-gesture sheets — overlay rules in the `sheetHistory.js` key row.
- **Performance batch (Session C, 2026-08-04)** — vendor chunk split, sw.js
  prune + woff2 preloads (iOS PWA Gotcha), lazy Trends (`trendsSeq` rule in
  the `setState(null)` Gotcha).
- **Code-health batch (Session D, 2026-08-04)** — `serializedUpdater.js` +
  `db.js` + `dataAdapter.js` façade key rows.
- **Security + test-infrastructure batch (Session E, 2026-08-04)** —
  settingsChains coverage, CSP headers (vercel.json key row + Gotcha), opt-in
  RLS harness (`test/` key row).
- **Category subcategories — one level (2026-08-05, Mason, PR #56)** — no
  migration (the parent link lives in `dash:cats`); rules in the Category
  nesting Conventions + `categoryTree.js` key row.
- **Amount-scoped learned rules (2026-08-05, PR #57)** — migration
  `20260805000002` (inverted paste-AFTER-deploy; applied + verified, see
  Pending); rules in the amount-scoped Convention; the transaction sheet also
  gained the raw bank-text line and the honest reset-label wording.
- **CI on every PR (2026-08-05, PRs #54/#55; hardened #59/#60)** —
  `.github/workflows/ci.yml`: `npm test` + placeholder-env build + a Chromium
  render gate over the checked-in `test/smoke/` harness that mounts the REAL
  App (since 2026-08-12) and walks ALL ELEVEN views via the bottom nav's
  `data-mm-nav`/`data-mm-seg`/`data-mm-report` hooks (was: clicked all ten
  tabs, until the 2026-08-15 bottom-nav IA) (the TDZ class ships green past tests AND build — only a real render
  catches it); job timeouts, CDN-first bounded browser install, cached +
  pinned driver (bump pin and cache key TOGETHER — comment in the workflow),
  `cancel-in-progress` only on PRs. `test/smokeMocks.test.js` keeps the mocks
  honest.
- **Zero-caller predicates removed (2026-08-05, PR #61)** —
  `isTransferCategory`/`isReturnCategory`; a category-based second answer to
  what `isSpend()` answers structurally (the two-models hazard). Tombstone in
  `categoryMap.js`.
- **Self-hosting setup path (2026-08-08, PRs #64/#65; Windows install fixed
  2026-08-13, PR #83)** —
  `docs/SETUP.md` Path A (CLI `db push` — the verified DEFAULT since the
  2026-08-13 hosted rehearsal, run during Mason's fresh-install test; see the
  `config.toml` key row) / Path B
  (`setup_all.sql`, TOMBSTONED); rules in the `setup_all.sql` /
  `bootstrap_household.sql` / `config.toml` key rows. #83 added
  `.gitattributes` (LF enforcement — its own key row + Gotcha) and the Windows
  forms `docs/SETUP.md` was missing: `copy` for `cp`, `set`/`$env:` for the
  POSIX `VAR=value` build prefix, and `curl.exe` for the 401 probe (in
  PowerShell, bare `curl` aliases Invoke-WebRequest, which throws on the very
  401 the step asks you to confirm).
- **PDF sectioned-statement signs (2026-08-09, PRs #66/#67, other session)** —
  no migration; the Discover Cashback Debit shape; all rules in the
  `pdfImport.js` key row; May imports normally (standing ruling in Pending).
- **available_balance settled — ONE convention (2026-08-10, PR #68)** —
  `normalizeAvailableBalance` (`api/_lib/simplefin.js` key row); no migration,
  fed rows self-correct on the next pull; the Roadmap bullet is closed.
  Subtype chips read `ACCOUNT_SUBTYPES` instead of an inline copy.
- **Memory restructure + lockstep guard (2026-08-10, PRs #69/#70)** — the
  Maintenance contract and `test/claudeMdLockstep.test.js` ARE the record;
  doc-rot sweeps in #63/#69 (phantom `isCheckingAccount`/`visibleAtHide`
  class).
- **RLS harness finished (2026-08-11, PR #73)** — storage-policy assertions +
  the honest-allowlisted pg_class-vs-pg_policies diff; `test/` key row.
- **Auto-merge standing flow (2026-08-11, PR #74)** — Development workflow
  rule 3; the spent session prompt deleted per contract.
- **Multi-file statement import (2026-08-11, PR #75)** — `CsvImport.jsx` key
  row (batch rules); the 2644/5481 standing ruling rode along (Pending).
- **Sixteen-item self-serve backlog (2026-08-12, PR #76)** — audit → verify →
  build; ship record in the plan doc's Next-backlog banner; rules folded into
  their owning rows (registry updaters Convention, `FEED_OVERLAP_DAYS` one-copy,
  overlay discipline, `getStartupSettings`, config.toml rehearsal).
- **Hybrid budget income (2026-08-13, Mason)** — `resolveBudgetIncome`
  (`envelopes.js` key row) + `getActualIncome` (dataAdapter); all rules in the
  hybrid-income Convention. No migration (the typed figure keeps its settings
  keys). The coverage-panel KEEP ruling rode along (same-day decision).
- **Retraining ergonomics (2026-08-13, PR #86)** — the trim-the-key editor
  (the amount-scoped Convention's recorded honest fix, now shipped), the
  retraining progress meter + Show-more paging (`categorizedShare`,
  `teachQueue.js` key row), and the manual-delete confirm gate that PR #88
  then superseded with the soft-hide. The review catch that shaped `bagWithRule` is recorded in the `ruleHistory.js` key row.
- **Imported-institution remove is a soft-hide (2026-08-13, Mason)** —
  removing the "Imported" institution used to cascade away the whole statement
  backfill; both kinds now soft-hide, with the cascade behind the same
  permanent+confirm literals and a Restore strip on the Accounts tab. Rules in
  the `api/_lib/unlink.js` + `src/unlinkRestore.js` key rows.
- **Four under-surfaced numbers rendered (2026-08-13)** — the honest month
  pace (`spendingToDate`, Overview tile: the month in progress now compares
  against last month AT THE SAME DAY, with the full-month figure kept as the
  Total-spent sub-line), available credit (the settled `available_balance`,
  SimpleFIN-fed rows only, NEVER through `displayBalance`), balance staleness
  (`balanceAsOf`, plus `updateManualBalance` now stamping `last_balance_at`),
  and loan payoff progress (`payoffProgress` + a "starting" DebtNum editor).
  No migration — every column already existed and every rule lives in the
  owning key row.
- **YNAB-style redesign (2026-08-15/16, Mason — PRs #92/#94/#93/#95/#96 + the
  ship PR)** — navy re-theme, bottom 5-item nav, the 4-type
  `transactions.user_type` override (migration `20260815000001`, pasted +
  verified), day-grouped Spending list, full-screen tx sheet, grouped
  Accounts + Reflect hub. Rules in the owning key rows/Conventions; deferred
  list in Roadmap; spec doc deleted per contract.
- **Refund netting (2026-08-17, Mason)** — a credit-card negative keeps the
  classifier's category and SUBTRACTS from it, so a returned item nets to zero
  instead of leaving its purchase counted forever. The read-time `Return`
  synthesis is deleted (that label made a refund unfileable, which is what
  Mason's "the user can determine which category the return should be applied
  to" was asking to fix). No migration. Rules in the linked-boundary
  Convention's netting bullet + the `spending.js` / `txClassify.js` /
  `txType.js` / `reflect.js` / `teachQueue.js` key rows; the guard that had to
  exist first is `isCardPaymentReceived`.
- **Full-page category picker (2026-08-28, Mason)** — the tx sheet's Category
  field became a row opening `CategoryPickerSheet`, a grouped full-screen page
  with envelope Available per tile; the inline chip grid is gone. No migration
  and no new stored field (the "groups" are the existing one-level parent
  nesting; emoji live in the category/alias NAME the user types). Rode along:
  the `setPickingCat` ReferenceError fix + its case-insensitive guard (the
  Gotcha), and the smoke WALK's first steps that open the tx sheet at all.
  Rules in the `Dashboard.jsx` key row. DEFERRED, recorded so it is built as a
  decision: "Split Between Categories" (the screenshot's other action) — one
  transaction across several categories needs a schema change and touches
  every spending total, budgets and the tax worksheet.
- **Reflect income drill-in (2026-08-16, Mason)** — tapping the Income vs.
  Spending card's income average lists every transaction the model counts as
  income, month by month, over the cash-flow window. No migration and no new
  query: `isIncome` was extracted from `cashIncome`'s fold and `getCashFlow`
  now carries each period's rows beside its amount. Rules in the `cashFlow.js`
  / `reflect.js` / `dataAdapter.js` / `Dashboard.jsx` key rows + the
  linked-boundary Convention's income bullet.
- **Ledger-vs-balance reconciliation (2026-08-28, Mason's question)** — the
  Accounts tab's "Does it add up?" panel answers whether the monthly totals
  can be checked against the money actually in the linked accounts. They
  can't match directly, and the panel says why in named lines instead of
  leaving an unaccountable gap. No migration (`balance_snapshots` already
  existed; note it only starts ~2026-08-01 and nothing backfills, so months
  before that honestly report no balance coverage). Rules in the
  `src/reconciliation.js` key row. **Second PR 2026-08-29** (Mason: "it looks
  like spending and income are just being compared to each other"): the netted
  headline was demoted under a GROSS view — money out / money in split by
  class, so spending is measured against what actually left rather than against
  income, and `purchases − refunds` is visible for the first time — plus
  `nearMissTransfers`, the detector for the one over-count balances can never
  see. Same key row.

## Pending branches

None in code, and **no migration is outstanding**: every file in
`supabase/migrations/` is applied to PROD and verified through
`20260815000001_transaction_user_type.sql` (that one pasted + verified
2026-08-15 by the `transactions_user_type` boolean in
`bootstrap_household.sql` before its PR merged — the additive
paste-BEFORE-merge order its header records; the earlier files were each
verified 2026-08-04/05 by a readable SELECT with every boolean true — never
by trusting "Success. No rows returned"; both 20260805 files took the
inverted paste-AFTER-deploy order their headers record). Receipts storage policy settled + verified end-to-end
incl. cross-tenant denial (2026-07-31); Plaid fully closed (account deleted,
Items retired, `PLAID_*` env vars removed, 2026-08-01).

**(RESOLVED 2026-08-13)** The one open verification — the fresh-install CLI
path's hosted half — ran clean on a throwaway hosted project during Mason's
fresh-install test; the `config.toml` key row records it, and Path A is now
the default install.

**Open data tasks: NONE (backfill COMPLETE 2026-08-12).** Retraining is the
only live task. Eyeball the type on EVERY account at unhide time — the rule
outlives the incidents that minted it. Both decisions the backfill un-gated
were made 2026-08-13: the Data coverage panel is KEPT (Mason: "i kinda like
it" — `src/coverage.js` key row), and RTA income became the HYBRID rule
(typed current month, measured completed months — the hybrid-income
Convention).

**Standing data rulings:**

- (2026-08-17) **The card-payment veto is CALIBRATED against the household's
  real vocabulary**, not against invented samples. Every credit-account
  money-in descriptor was pulled from prod when refund netting shipped:
  10/10 payment/reward wordings are held out of spending (~$31k, the great bulk
  of it `CAPITAL ONE MOBILE PYMT`) and 21/21 merchant refunds net (~$3.7k).
  Both lists are pinned BY NAME in `test/txClassify.test.js`. The
  one bug that probe caught: an unanchored `PMT` matched inside "AMAZON
  MKTPLACE PMTS" and vetoed 18 genuine refunds — hence the word boundaries and
  the singular-only `PMT`. Re-run the probe (the PR #101 body has the SQL)
  before widening that regex. Also settled the same day: **no row anywhere
  stores `'Return'`** (0 `mapped_category`, 0 `user_category`), so retiring the
  synthesis needed no cleanup migration.
- (2026-08-17) **DEBIT-card refunds are effectively absent from this
  household's data, which is WHY netting them stays manual.** Of ~$240k of
  depository money-in, the only refund-shaped rows are a ~$25 cable credit, a
  $3 out-of-network ATM fee refund and $0.30 of brokerage
  account-verification micro-deposits — about $28 total. Everything else is
  payroll (three employers), state unemployment
  benefits, Zelle, interest/dividends, brokerage transfers, or an internal
  transfer. An automatic debit-refund rule would therefore risk a quarter of a
  million dollars of correctly-classified income to catch ~$28 — the evidence
  behind the linked-boundary Convention's "explicit verdict only" rule. Don't
  re-propose one without re-running the probe and finding a different answer.
- (2026-08-17) **OPEN, not a bug — recurring `Zelle Payment From <person>`
  deposits count as INCOME.** Several repeat monthly from the same senders
  (three of them, recurring ×7, ×5 and ×3 — deliberately unnamed here per the
  public-repo rule in the maintenance contract; Mason knows the senders, and
  the ledger has the descriptors). If they are
  rent, that is correct and there is nothing to do; if any are reimbursements
  or bill-splitting they inflate both income and the Budget tab's Ready to
  Assign. Surfaced to Mason 2026-08-17; he has not ruled. The fix, if he wants
  one, is per-row `user_type` — not a wording rule.

- (2026-08-12) **Statement backfill COMPLETE, all four accounts.** Checking
  5481 + BECU savings imported from their Feb-2026 CSV exports (both transfer
  legs present, so checking↔savings moves wash); Venture X from seven
  Capital One PDF statements (Jan 9 – Jul 24; every statement auto-detected,
  zero unreadable rows, parsed purchase totals reconciled to the penny
  against the printed totals — January's $395 delta is the ANNUAL FEE,
  printed outside Capital One's "Transactions" total but correctly imported
  as spending); 2644 imported against the coverage wall after the
  empty-fed-account fix (PR #79). Residual, accepted: history before the
  exports' start (~Feb 2026, Jan 9 for the card) is simply absent — import
  older statements any time; nothing depends on it.
- (2026-08-12) **Venture X same-day "dupes" RESOLVED — REAL, do NOT
  exclude.** Audited against the Jan–Jul statements: every same-day
  equal-amount group is distinguishable at the source (Alaska Air trios carry
  distinct ticket numbers, ORCA taps distinct ref codes, the two $51.95
  Amazons distinct order ids) or genuinely printed in multiple (four $3 Suds
  City car washes on 2026-07-24). Same failure shape as the payroll twins:
  real charges that merely look duplicated.

- (2026-08-09) The two equal-amount payroll ACH deposits on 2026-07-24 (same
  employer, same day, four figures each) are BOTH REAL — confirmed against the
  Discover July 2026 statement's printed totals. Do NOT exclude either copy.
- (2026-08-11, Mason) **Checking 2644/5481 re-key hypothesis REFUTED — they
  are TWO REAL, SEPARATE accounts**: 2644 is Mason's personal checking
  (rarely used); 5481 is the shared household checking that most spending and
  the savings transfers run through. The 2026-04-03 abutment that suggested a
  feed re-key was coincidence (a rarely-used account going quiet around the
  time the feed's window opens on the other). Consequence for backfill:
  statements import into their OWN account's row — putting 5481's history on
  2644 (the old hypothesis's advice) would file the household's spending
  under the wrong account. No overlap existed, so nothing double-counted
  under either reading.
- (2026-08-10, Mason confirmed) **Discover it (7933) twins RESOLVED**: the
  same real card surfaces under TWO orgs because Capital One acquired
  Discover, so the Bridge can pull it via either login. End state: the
  transaction-holding row (Capital One org, was mistyped depository/checking)
  is UNHIDDEN and retyped **Credit card**; the empty Discover-org row stays
  HIDDEN permanently — that hidden row is the guard, since the two orgs' rows
  carry different `sfin:` ids and can never dedup against each other. If the
  Discover-org feed ever starts delivering transactions they land on the
  hidden row, query-excluded — no double count — but if either feed DROPS the
  card, re-check which row is live before unhiding anything. The retype is
  read-time (`t.accounts.type`), so historical rows self-corrected with no
  re-sync.

Resolved for the record: the Anthropic spend cap and service_role key rotation
are DONE 2026-08-04 (decision in the assistant Convention; rotation
verification procedure in Gotchas); NEWREZ resolved by construction 2026-08-05
(the keyword rule is deleted — just a merchant to teach); no statements were
imported before the sectioned-sign fix (Mason, 2026-08-09), so May can import
normally — the permanent wrong-sign hazard lives in the `csvImport.js` key row.

## Roadmap

**The YNAB-style redesign SHIPPED COMPLETELY (2026-08-15/16, six PRs)** and
its build spec was deleted per the delete-when-spent rule (git holds it —
the spec doc's filename was `ynab-redesign-plan-2026-08-15.md`, grep-cleared
in the ship PR). Every durable rule lives in its owning section: navy palette
(ui.css key row), bottom nav (Mobile-first Convention + `src/nav.js`), the
4-type override (linked-boundary Convention + `src/txType.js`), the Spending
list + detail sheet + row-level signed amounts (Dashboard key row), the
Reflect hub (`src/reflect.js`). DELIBERATELY DEFERRED, recorded so a future
session builds them as decisions rather than rediscoveries: an
approved/reviewed column + "Approve" semantics; an "uncleared/pending" count
banner; two-line transfer payee (needs a pair link the pairing doesn't
store); date editing in the tx sheet; a memo field (`user_description` IS
the rename); font weights past 600 (the variable font's ceiling); the
manifest `theme_color` inconsistency (pre-existing, untested).

**The forward-looking doc is `docs/next-iteration-plan-2026-08-04.md`** — the
only one carrying UNBUILT work. It opens with a Decision queue rolling up every
open "Needs Mason" ask in it, and its backlog header carries the date its
premises were last re-verified against main (2026-08-28) — build off an item
only after re-checking what changed since that date, not the whole premise.
**One process doc is KEPT by exception:**
`docs/accounts-tab-redesign-2026-08-28.md`, the Accounts-tab redesign's
reasoning trail, saved at Mason's explicit request ("save the planning doc to
the repository") and therefore EXEMPT from the delete-when-spent rule — its
durable rules already live in the `Dashboard.jsx` key row and the localStorage
device-pref Convention, so read those first and treat that file as history,
never as a second source of truth.
(`docs/next-session-prompt.md` is a session STARTER, a process
artifact deleted by the session that spends it — not a second roadmap.
Spent + deleted 2026-08-11: its chores and its chosen lane, the RLS-harness
remainder, both shipped in PR #73.) Both six-dimension audit backlogs (2026-08-01, 2026-08-04) and the
2026-08-02 session plan shipped out completely and were deleted per the
delete-when-spent rule; what survived them — the refuted-don't-re-propose list
and Mason's recorded decisions — moved into that doc, and their decided rules
are in the memory docs. Git history holds the rest.

**Worklist status (2026-08-13):** the plan doc's **Improvement backlog
(2026-08-13)** section is the live list (count it there — a frozen number
here goes stale the first time an item ships), ranked, each adversarially
vetted against main at synthesis time and re-verified item by item
2026-08-28 (that date is the baseline the doc records — re-check only what
changed after it, then build; main moves). Seven of that survey's ideas shipped
the same day in PRs #86/#88. Ranked first, and the reason the section leads
with them: the household's ledger, its hand-taught rules and its category
registry exist ONLY in prod Supabase, with no export and no journal — so the
data-export floor, the scheduled health probes and the settings-history
journal are the three that protect what is already built. Everything from the
OLDER lists is shipped, deliberately deferred (the Dashboard.jsx
decomposition — keep the single file during active development), or gated on
Mason. The needs-Mason DATA work is ALL RESOLVED (backfill
complete + every dupe question ruled — see the standing rulings; spend cap,
key rotation and NEWREZ done earlier).
**Retraining is the live task**: post-wipe every category is created and taught
by hand, so the Uncategorized teach-queue and the Taught-rules screen are the
working surfaces.

Debt follow-ups: ALL THREE SHIPPED 2026-08-03 (manual debts, per-debt payoff
schedule drill-in, net worth over time — Mason's call recorded: net worth
EXCLUDES hidden accounts' balances, consistent with the query-level rule).
Later (discussed, not committed): cash-flow forecast, savings goals, CSV/PDF
export, receipt OCR (no OCR in v1 — the upgrade path is a later
`api/receipt-ocr` route on the existing Anthropic key, CONFIRM-BEFORE-WRITE). **Envelope follow-ups — ALL THREE SHIPPED 2026-08-03 (Session 6)** —
auto-fill from last month, per-month target overrides, expected transactions
(see Merged features; both 20260804 migrations applied to PROD and verified
2026-08-04). Still outside that scope: reconciliation's ACTION half (spec
open — the balance-vs-ledger CHECK shipped 2026-08-28 as the Accounts tab's
"Does it add up?" panel, `src/reconciliation.js`; what stays unspecified is
what to DO about a mismatch — YNAB's cleared/adjust flow, and the plan doc's
item 3 missing-row question; the 2026-08-29 near-miss list NAMES candidate rows
but takes no action on them), and Age of
Money — it wanted real *measured* income, which the hybrid income rule
(2026-08-13) now provides for completed months, so it is buildable as its own
decision. **`accounts.available_balance` RESOLVED (2026-08-10, PR #68)** — the old
two-convention state (raw feed value when sent, normalized owed-balance via
the `?? balance` fallback when not) is gone: `normalizeAvailableBalance`
(`api/_lib/simplefin.js` key row) gives it ONE meaning. Still true forever:
never run it through `displayBalance` — for a card it means available
*credit*, not a debt.

### Off-Plaid: SimpleFIN — COMPLETE (phases 1–4 shipped)
Decision (settled, executed): **SimpleFIN Bridge** replaced Plaid — ~$15/yr
flat, read-only, daily refresh, serverless-friendly (no daemon); coverage
verified for every household institution incl. NewRez / Launch / Jenius. End
state: **SimpleFIN + CSV/PDF import**, which is where the app now is. Caveats
traded: no categorization from the feed at all (since 2026-08-05 learned rules
are the only categorizer — nothing guesses); daily freshness, not real-time.

**Settled during the build** (verified against simplefin.org/protocol.md plus
independent Go/Rust/Python clients — don't relitigate):
- Claim: setup token is base64 of a **single-use** claim URL → POST it, no body,
  no auth → the response **body** is the durable access URL (plain text; trim).
- The access URL embeds Basic credentials and **Node's fetch refuses a URL with
  userinfo** — they must be split out into an `Authorization` header.
- `amount`/`balance`/`available-balance` are numeric **strings** ("-05.50" is
  real); `posted`/`transacted_at`/`balance-date` are epoch **seconds**, and
  `posted` may be **0** for a pending row (a sentinel, not 1970).
- **Two wire shapes** — v1 `errors` + a per-account `org`; v2 `errlist` (objects)
  + top-level `connections` joined by `conn_id`. **The server picks** when the
  request doesn't pin `version`, so `normalizeAccountSet` reads both and both
  resolve to the same org key (a flip must not fork institutions).
- Per-bank failures come back as **HTTP 200** with usable accounts *plus* error
  entries; 403 = credentials revoked, 402 = payment required. The protocol
  requires **sanitizing** feed messages before display.
- No cursor, no pagination, and **no "removed" signal** — idempotent upsert on
  `(account_id, plaid_tx_id)` is the only thing making a re-pull safe. Which is
  why **pending transactions are off by default** (`SIMPLEFIN_INCLUDE_PENDING=1`
  to try them): a pending row whose id changes when it posts would strand a
  duplicate forever with nothing to clean it up.
- Ids: `plaid_account_id = 'sfin:'+account.id`, `plaid_tx_id = 'sfin:'+tx.id`,
  `transactions.source = 'simplefin'` (deviates from the original spec's bare
  `tx.id` — the prefix matches the `csv:`/`manual:` precedent and keeps each
  adapter's id space self-describing).
- Unlinking a SimpleFIN institution **disables** it rather than deleting it: one
  access URL covers every bank, so a deleted row would just be recreated by the
  next pull. The disabled row is the tombstone that keeps it out — and the
  connect modal lists removed banks with a Restore button, because without one
  that tombstone is permanent and a mis-tap is unrecoverable.

**SETTLED against live data (2026-07, Capital One Venture X):** SimpleFIN
reports a credit/loan balance **NEGATIVE when money is owed**. The feed sent
-5127.97 for a card Plaid reported as +5127.97, so `normalizeBalance()`'s flip
is correct and the Debt tracker can rely on it. (Proof it was the raw feed
value: `normalizeBalance` can never *return* a negative for a credit account, so
a stored negative means the row was typed `depository` at sync time.) Still
approximate for an **overpaid** card — reported positive, left positive, i.e.
shown as owed. Rare and small.

**Account-type inference is the fragile part, not the balance.** Card *product*
names carry no card-ish word — a "Venture X" landed as `depository/checking`,
which would have mis-read all 348 of that card's rows the moment it was
unhidden (the three failure modes are in the account-type Convention; the
"counted them all as cash spending" phrasing that stood here was pre-unification
and wrong). `inferAccountType` now also matches product names
(venture/quicksilver/freedom/sapphire/…), card-only issuers, and falls back to
`credit` on a negative balance; the deposit rules still run first so
"Platinum Savings" and "Preferred Checking" stay deposits. **Always eyeball the
type on a new SimpleFIN account** — the sync logs a warning when it guessed.

**Statements via SimpleFIN: NOT POSSIBLE (investigated 2026-08-03, don't
re-propose).** The protocol has no statement concept — four endpoints, no
documents anywhere in the spec, changelog, Bridge docs or issue tracker; the
"can provide statements" wording on the link consent screen is MX's, whose
statement product the Bridge does not pass through. Manual CSV/PDF import
remains the mechanism and the only way to reach history older than the ~88-day
window. Re-check only if the Bridge changelog ever announces statements.

**Institution wording is MECHANISM in two places and cosmetic everywhere
else** — the open-source-posture note that stood here ("no total depends on
institution wording … never a wrong total") was migrated verbatim from the
2026-08-03 diagnosis and is WRONG as an absolute; it was reasoned from F2
being structurally washed, which only holds for a LINKED, VISIBLE card. The
two load-bearing lists: `CARD_ISSUER_RE`/`STANDALONE_PAYMENT_RE` in
`txClassify.js` (the card-payment veto — the ONE thing that keeps an unpaired
card payment out of spending when the card is unlinked or hidden; the
$1,109.57 BofA/Wells Fargo miss is pinned by name in `test/spending.test.js`)
and `inferAccountType`'s product names in `simplefin.js` (a mistype corrupts
the three numbers the account-type Convention enumerates). Neither degrades to
a visible `Uncategorized`. The BECU CSV preset and anything else naming a bank
IS cosmetic.

OUT (not now): **email-alert cron** (Vercel Cron → `api/` route polling Gmail,
parsing alerts, inserting service-role for minutes-fresh top-ups, reconciled
against the ledger). **Channel C home-IP scraper** — possible later build-out for
any servicer a feed can't cover: runs on a home Pi/NAS (residential IP,
outbound-only to Supabase, `household_id` set explicitly under service_role),
reusing the dormant `pull_jobs` / `mfa_prompts` / `pending_items` schema + the
24h `check_pull_job_constraints` rate limiter; real ToS/lockout risk → scoped
surgically, never the foundation.

