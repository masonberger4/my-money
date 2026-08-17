# Next-iteration plan — 2026-08-04 (findings + feedback guide)

> **Contract for AI sessions:** items here are live specs — the PR that ships
> (or supersedes) an item marks it shipped/refuted in that same PR, noting what
> shipped instead when the design diverged; an unmarked shipped item is a bug.
> When every item is resolved this doc is DELETED per CLAUDE.md's maintenance
> contract. CLAUDE.md is authoritative wherever the two disagree.

**Where the live work is:** the **Improvement backlog (2026-08-13)** section
is the current unbuilt list — adversarially-vetted items, ranked. The
"Shipped backlog (2026-08-11)" section near the bottom is a RECORD, fully
shipped; do not mine it for work. Items 2/3/4 under Low-hanging fruit and 1/3/4/5
under Harder are the older live specs.

**THE single forward-looking doc.** Both six-dimension audit backlogs
(2026-08-01 and 2026-08-04) shipped out completely and were deleted 2026-08-05
per the delete-when-spent rule — their decided rules live in CLAUDE.md, their
history in git, and the one thing worth carrying forward (what was refuted, so
it doesn't come back) is the last section here. CLAUDE.md wins on any conflict;
nothing below relitigates a decided item.

## Low-hanging fruit

1. ~~**The Pending data/ops tasks FIRST**~~ — **ALL FIVE RESOLVED (last
   closed 2026-08-12, the statement backfill).** CLAUDE.md's Pending now
   reads "Open data tasks: NONE"; the resolutions survive there as standing
   rulings, and retraining is the only live task. Struck sub-items kept
   below as the record; original priority order:
   - ~~Rotate the Supabase service_role key~~ **DONE 2026-08-04**, verified by
     a successful assistant round trip (an answer proves `requireUser` passed
     on the service client). The Anthropic spend cap is DONE too ($25/mo,
     alert at $10).
   - ~~**$2,200 payroll duplicate**~~ — **RESOLVED 2026-08-09, the OPPOSITE
     of this item's prescription: the verification happened and BOTH rows are
     REAL** (confirmed against the Discover July statement's printed totals).
     Do NOT set `excluded=true` on either copy — the standing ruling lives in
     CLAUDE.md's Pending and governs. July income was never overstated. The
     ~$34 Venture X same-day dupes were RESOLVED 2026-08-12 the same way —
     audited against the Jan–Jul statements, ALL REAL, do NOT exclude
     (standing ruling in CLAUDE.md Pending).
   - ~~**Discover it (7933) twins**~~ — **RESOLVED 2026-08-10, Mason
     confirmed**: the data-holding Capital One-org row is unhidden and retyped
     Credit card; the empty Discover-org row stays hidden permanently. The
     acquisition hypothesis below was right; full end-state ruling lives in
     CLAUDE.md's Pending standing rulings. History follows:
   - **Discover it (7933) twins — UPDATED 2026-08-04 by Mason's inspection.**
     The `credit`-typed row (Discover org) turned out to hold **no
     transactions**, so Mason hid it and kept the sibling — which is the row
     typed **`depository/checking`** under the Capital One org. That inverts
     the earlier "keep the credit one" advice: the question is no longer
     which row to keep but **the TYPE on the row that holds the data**. A
     "Discover it" is a credit card, so that row must be retyped **Credit
     card** in the account-type editor before it is ever unhidden — **that sentence's original
     justification — "while it is typed checking, every purchase counts as
     household CASH spending" — is PRE-UNIFICATION and WRONG** (CLAUDE.md's
     account-type Convention refutes it in as many words: `isSpend` needs only
     `amount > 0` on a non-loan account, so a card's purchases count either
     way). The retype still mattered, for the three reasons that Convention
     enumerates: refunds become income instead of NETTING (2026-08-17 —
     the wording here said "become income" back when a credit negative was a
     `Return` counting in nothing; the failure is the same, the mechanism
     moved), card-payment-worded purchases get vetoed, and the balance lands
     positive as an asset.
     **Mason's hypothesis, plausible and worth confirming: Capital One
     acquired Discover, so SimpleFIN pulling both the Capital One and
     Discover logins can surface the SAME card under two orgs.** Each row
     carries its own `sfin:` id, so the `(account_id, plaid_tx_id)` upsert
     cannot dedup them — with both visible, everything on that card
     double-counts. Confirm via the Accounts-tab Data coverage panel (it
     deliberately includes hidden accounts): overlapping date ranges + similar
     row counts ⇒ same card twice. Search cannot see them —
     `searchTransactions` inner-joins `accounts.hidden = false`.
   - ~~**NEWREZ recategorization**~~ — **RESOLVED BY CONSTRUCTION 2026-08-05.**
     Its root cause was the keyword table (`/NEWREZ|SHELLPOINT|MORTGAGE|…/ →
     'Utilities'`, because the taxonomy had no housing member); Harder §0
     deleted both the table and the taxonomy, and the applied wipe left those
     rows reading `Uncategorized`. Nothing to fix — it is one merchant to teach
     during retraining.
   - ~~**Pre-May statement backfill**~~ — **COMPLETE 2026-08-12, all four
     accounts** (5481 + savings CSVs, Venture X Jan–Jul PDFs reconciled to
     the penny, 2644 against the coverage wall after PR #79's
     empty-fed-account fix). Full record in CLAUDE.md's standing rulings.
     Consequence: item 5 (coverage-panel retirement) was un-gated and then
     RESOLVED 2026-08-13 — Mason ruled KEEP. ~~First confirm the Checking 2644→5481 re-key theory~~ — REFUTED
     2026-08-11 by Mason: two real, separate accounts (2644 personal/rarely
     used, 5481 the shared main checking); each backfills into its own row.
     Standing ruling in CLAUDE.md Pending.

2. **Receipt OCR v1** — *recommendation 2026-08-11 (Claude, not a Mason
   decision): DEFER until retraining settles — it competes for Mason's
   attention with teaching categories, and adds an LLM write path to an app
   whose current job is getting categories right.* Spec stays live below.
   The upgrade path CLAUDE.md already reserved: a new
   `api/receipt-ocr` route on the existing `ANTHROPIC_API_KEY`, reading the
   stored image (signed URL server-side or Storage download under
   service_role), returning merchant/date/amount/category suggestions,
   **confirm-before-write** in the detail sheet (the confidently-wrong
   refusal applied to OCR). Plumbing exists end to end: `receipts` table,
   `ReceiptSection.jsx`, `getReceiptUrl`, `requireUser()`. No migration.

3. **Cash-flow forecast lite** — *recommendation 2026-08-11 (Claude, not a
   Mason decision): DEFER until retraining settles — a forward-looking number
   computed from a category set that is still mostly Uncategorized is wrong
   on arrival.* Previously "later (discussed, not committed)", but Session 6 built the hard part: `expected_transactions`
   carries cadence + due dates, `projectFutureCycles`/`rollForwardDate`
   (`src/expectedTx.js`) already project forward. Projected end-of-month
   balance = current depository balances − remaining expected outflows
   (+ expected income if typed). Keep it a pure core + one Overview/Trends
   card; it inherits the DISPLAY-ONLY contract — never touches Available,
   the walk, or any total.

4. **Bundle trimming** — *recommendation 2026-08-11 (Claude, not a Mason
   decision): DROP tab-level `React.lazy` — it overlaps the deliberately
   deferred Dashboard decomposition and every split module must thread the
   mock-alias needle, for a bundle win nobody has complained about.* Original
   item: main chunk ~584 kB (pdf.js's ~1.8 MB is already
   lazy via `pdfExtract.js`, as are the modals). Next lever is tab-level
   `React.lazy` inside Dashboard.jsx (Tax/Debt/Trends render heavy pure
   cores). **Harness caveat:** any split-out module must keep importing
   through `dataAdapter.js` — the smoke harness aliases only the façade-level
   modules (see the dataAdapter façade key row in CLAUDE.md; its fifth alias,
   `supabaseClient.js`, exists for App.jsx and is not a licence for
   components) — a module importing anywhere else either escapes the mocks or
   silently bypasses the façade while the gate stays green (same rule
   recorded for the decomposition, backlog Section 3).

5. ~~**Retire the Data coverage panel**~~ — **RESOLVED 2026-08-13: Mason
   ruled KEEP** ("i kinda like it"), so the panel stays and drops its
   TEMPORARY tag. Not a build item any more; revisit only if he asks. The
   removal recipe stays recorded for that day: `src/coverage.js` ALSO holds
   the PERMANENT feed-reach tell (`FEED_REACH_DAYS`/`feedCoverageGaps`,
   imported by `api/_lib/simplefin.js`) — delete the CARD and
   `aggregateCoverage`/`getDataCoverage()` only; the file and
   `test/coverage.test.js` stay.

6. ~~**SQL/RLS tests**~~ — **FULLY SHIPPED 2026-08-11 (PR #73)**: the
   storage-policy assertions (behavioral + catalog), the honest-allowlisted
   pg_class-vs-pg_policies coverage diff, and the `current_household_id()`
   catalog pins joined the earlier cross-household/invisibility/defaults
   coverage. Executed and mutation-tested on a real Postgres 16 (fourteen
   sabotages, all caught). Known limit, in the test header: it proves the
   migration's policy SQL is correct, not that PROD applied it —
   `bootstrap_household.sql` stays the prod-side check. Original item
   follows. Use the Local-checks recipe in CLAUDE.md
   (local Postgres 16 stub: `auth` schema + `auth.uid()` reading
   `request.jwt.claims.sub`, three roles, run migrations in order), then
   assert: cross-household SELECT/INSERT denial per table,
   `simplefin_access` invisible to `authenticated`, `household_id` default
   filling on client insert, the receipts storage policy. Keep it a
   gitignored local check or a separate opt-in script — `npm test` must stay
   zero-dep and Postgres-free.

*Items 7–8 came out of the **2026-08-04 code sweep** — neither appears in any
prior backlog. Both are S/M with no blockers and no migration.*

7. ~~**Learned-rules review screen ("Taught rules")**~~ — **SHIPPED
   2026-08-04**, no migration. A learned rule used to be an invisible,
   unremovable write-time authority (`deleteCategoryRule` had zero callers,
   `category_rules.source` was read by nothing). What was built:
   - **`RulesSheet` in Dashboard.jsx** (a component, not a 10th tab): one row
     per rule — `merchant_key`, its category with the shared colour dot, and a
     free `N in {month}` derived **in render** from the month rows already in
     memory via `matchLearnedRule` (no fetch, no cache, so the `setState(null)`
     gotcha never applies). `source` renders only when >1 distinct value
     exists (Mason decision (b) left as specced). `useEscClose` inside the
     component; `rulesOpen` wired into `anySheetOpen` **and** `closeAllSheets`
     so Escape and the back gesture work.
   - **Two entry points:** `Taught rules (N) ›` under the Categories list, and
     `See what you've taught ›` in the Uncategorized teach-queue block.
   - **`listCategoryRules()`** (dataAdapter façade) returns ROWS with metadata
     and **`null`, not `[]`, when the table is missing** (the `getReceiptTxIds`
     sentinel, latching `hasCategoryRules`); both entry links key on
     `rules !== null`, so pre-migration the feature is absent rather than
     showing an empty list that claims nothing was taught. Ordered paging with
     the `isRangeExhaustedError` end-of-range contract. `getCategoryRules()`'s
     `{}` map is untouched — it's on the hot write path.
   - **`countCategoryRuleMatches()` + `applyRuleToHistory({countAll})`** — the
     on-demand "Count all" per rule. **Deliberately NOT the dry run:** dryRun
     counts only rows it would still *change*, so a healthy, fully-applied rule
     reads 0, which in a list reads as "matches nothing" and talks a human into
     deleting a working rule. `countAll` drops the `mapped_category !==
     category` clause and returns before any write (its `updateBatch` throws by
     construction). A FAILED count stays null and renders as an error with a
     Retry, never as a real 0 (the `offerToLearn` distinction).
   - **Delete semantics:** forgetting a rule changes **zero existing
     transactions** — `mapped_category` is written at classify time and nothing
     recomputes it at read time — so there is nothing to patch or reload, only
     the list. The confirm says so in as many words. **No undo, no
     auto-reclassify** (v1, as specced). Teaching a merchant also bumps the
     rules epoch, so the screen opened straight after a teach shows the new row.
   - **Still open for Mason:** (a) a later "reclassify these rows without this
     rule" action; (b) whether `source` should always render. The category
     picker's precedence restatement (learned rules never override the
     transfer/card-payment guards) was not needed — the picker was untouched.
   4 `countAll` tests in `test/categoryRules.test.js`.

8. **Surface `coverage_shortfall`** — ~~size **S/M**, **no migration**~~
   **SHIPPED 2026-08-06 (PR #62), but NOT the way this item specced it.** The
   spec below assumed the sync response was the source. It isn't usable as
   one: the key is absent on every steady-state pull (this item says so itself,
   two paragraphs down, and then proposes reading it anyway), so a client
   watching sync responses sees it once and never again. What shipped derives
   the same fact from the LEDGER instead — `feedCoverageGaps` in
   `src/coverage.js`, flagging an account whose oldest stored row sits inside
   the window its first pull could have reached. No migration, survives
   reload, and self-clears when a backfill lands. `pullWasClean` still ignores
   `coverage_shortfall`. Kept below as the reasoning that led there.
   **Why:** `api/sync.js:669` returns `coverage_shortfall`
   (`{wanted_from, served_from}`, built by `coverageShortfall` in
   `api/_lib/simplefin.js:871`) and **nothing reads it** — `runSync`
   (`src/sync.js:34`) hands the whole body back and all four callers drop it
   (`Dashboard.jsx:1687`/`2329`, `CsvImport.jsx:518`,
   `SimpleFinConnect.jsx:103`). The app holds ~3 months where
   `FIRST_PULL_DAYS` says it wants 2 years, and the user is never told which
   account to backfill. The key is also **absent on every steady-state pull**
   (pinned, `test/syncOrchestration.test.js:332`), so a client listening to
   sync responses would see it once and never again — the same
   absence-has-no-alarm shape as the SimpleFIN deadlock.
   - **Decided approach: derive from the LEDGER in `/api/simplefin-status`**,
     not from the sync's transient value. Persisting on `simplefin_access`
     was considered and **rejected**: it's per-*access-URL* so it can never
     name the account to import into, it **becomes a lie** once a CSV/PDF
     backfill fills the gap, and the client can't read that table anyway — it
     would be the status route *plus* a migration *plus* a second source of
     truth. (Same reasoning as "the `receipts` TABLE is the source of truth —
     never `storage.list()`".) Also do **not** just recompute
     `coverageShortfall(now − FIRST_PULL_DAYS, now)` server-side: 730 > 88
     always, so that's a permanent banner unrelated to reality.
   - **The derivation** (all inputs exist today): per visible account on an
     active SimpleFIN-fed institution, flag when its `first_any` (min tx
     date, **any source**, one indexed `limit 1` query) falls inside
     `[accounts.created_at − MAX_LOOKBACK_DAYS, + GRACE_DAYS]`. The lower
     bound makes the notice **self-clear** the moment a pre-wall backfill row
     lands (no invalidation machinery); the upper bound stops a genuinely new
     account nagging. Accepted false negatives recorded in the spec (a quiet
     stretch right after the wall; an account whose first pull failed).
   - **Constraints:** new pure `api/_lib/coverageGaps.js` (the
     `api/_lib/unlink.js` decisions-pure pattern) + `feedReachWindow()` beside
     `coverageShortfall`, so copy renders from the **server's** constants —
     `FIRST_PULL_DAYS`/`MAX_LOOKBACK_DAYS` are env-overridable and must never
     get a fourth hardcoded client copy (`CsvImport.jsx`'s `FEED_LOOKBACK_DAYS`
     was one drifting copy of `OVERLAP_DAYS` — closed 2026-08-12:
     `FEED_OVERLAP_DAYS` in `src/coverage.js` is now the one copy).
     Cap the per-account scan at 25 + `truncated`; wrap the whole block in
     try/catch that **omits the `coverage` key** on any error (missing key =
     no notice — never render a gap you aren't sure of, and never 500 the
     Accounts tab). Client pure core is a **new `src/feedCoverage.js`**,
     deliberately not an addition to `src/coverage.js` — at spec time that
     was the TEMPORARY panel's core (item 5) and the tell had to outlive it.
     (Overtaken twice: what shipped put the tell in `src/coverage.js` anyway
     — see the ship note atop this item — and item 5 was RESOLVED KEEP
     2026-08-13, so both halves now stay; the separation reasoning is
     historical, and `src/feedCoverage.js` was never created.)
   - **Don't touch:** `api/sync.js` is unchanged, and **`pullWasClean` must
     keep ignoring `coverage_shortfall`** — `test/csvImport.test.js:262` is
     the REGRESSION keeping a shortfall from blocking the statement import
     that is the remedy.
   - **UI:** a quiet **neutral** strip, *not* a second variant of the amber
     feed-health banner — amber means the feed is broken, while a first-pull
     shortfall is the expected result of a first pull, and reusing amber
     trains it as noise. Ack via a stored ISO date, re-raising when
     `worst_from` moves past it (NOT built — see the flagged bullet).
   - **→ Mason decisions (flagged):** MOOT since the 2026-08-06 ship:
     `FEED_GRACE_DAYS` shipped as 7 (src/coverage.js), not the flagged 21,
     and no ack key was ever built — the notice is read-only by decision, NO
     dismiss/ack (CLAUDE.md's coverage.js key row). Original flags: `GRACE_DAYS
     = 21` is a judgment call; and the spec names the ack key
     `feed:coverage-ack` but not its store — CLAUDE.md's rule points at
     `settings` (account-level fact, not a device/visual pref), confirm
     before building. The source spec's §4 (UI)
     is unfinished — settle the strip's exact placement and copy at build.

## Harder, high value

0. **USER-OWNED CATEGORY SYSTEM — SHIPPED 2026-08-05.** What landed, against
   the spec below: `ERA_CATEGORIES` reduced to the mechanism three
   (`src/categoryMap.js`); the descriptor→category keyword table deleted from
   `src/txClassify.js` while every transfer/card-payment guard stayed
   (`guessCategory` is now transfer guards → learned rule → Uncategorized);
   `DEFAULT_SCHEDULE_E_MAP` emptied to `{}` (the export survives as the
   callers' fallback) so tax mapping is fully user-driven through
   `tax:maps`; `dash:cats` became THE category system, surfaced through the new
   pure `src/categoryList.js` so the Categories tab, the Budget tab, the
   Transactions chips and every picker read ONE list (which also retired the
   Budget tab's "budget another category" picker — that set is empty by
   construction once the list is topped up); and migration
   `20260805000001_user_owned_categories.sql` preserves-then-wipes.
   Two deviations from the spec as written, both deliberate:
   `category_rules` is wiped and archived too (with the keyword table gone,
   rules are the only categorizer, so a surviving rule re-mints a deleted
   category onto the next synced row), and the migration is pasted **after**
   the deploy rather than before, because the old build derives
   `mapped_category` at write time.
   **The migration is APPLIED — pasted and verified against PROD 2026-08-05**,
   every boolean column of its verification SELECT reading true. Live state:
   every `mapped_category` is `Uncategorized` except the mechanism labels,
   `user_category` is null except those, and `budgets` / `budget_months` /
   `category_rules` are empty (archived to `legacy_*`). **Retraining is now the
   live task.** The teach-queue remainder is RESOLVED in two parts: the queue
   POPULATION was rebuilt 2026-08-05 (counted-split, `src/teachQueue.js`) and
   the row-height re-sizing shipped 2026-08-12 (PR #76, `TEACH_ROW`
   minHeight:32); the retraining PROGRESS METER (`categorizedShare`) and
   Show-more paging shipped 2026-08-13 (PR #86), retiring the dead-end
   "N more behind these" sentence that hid merchants 11+. Any larger
   "promote the queue as an onboarding surface" redesign — the flashcard
   TeachSheet specced in the 2026-08-13 backlog below — remains a separate
   Mason decision, deliberately unclaimed. Original
   spec kept below as the record.

   **Mason's decision 2026-08-04. This REVERSES recorded decisions.** The app ships no
   categories at all: the user creates every category, teaches which
   transactions belong to it (manual at first), and the learned-rule machinery
   makes it automatic thereafter. `category_rules` + `merchantKey` +
   `applyCategoryRuleToHistory` ALREADY implement "manual then automatic" —
   what changes is deleting the seed taxonomy and the guessing.

   **Mason's three decisions (2026-08-04), verbatim in effect:**
   - **Existing history: WIPE to Uncategorized and retrain.** Chosen with the
     downsides stated (orphaned budgets/envelopes, empty past-month category
     views, a lot of teaching). Claude's safety amendment, applied unless
     Mason objects: the wipe **preserves the old values in a legacy column**
     rather than overwriting in place — same end state, but the destructive
     step stops being a one-way door on four years of live financial data.
     `user_category` is wiped too (its labels come from the taxonomy being
     removed) and is preserved the same way; orphaned `budgets` /
     `budget_months` rows are cleaned up, not left dangling.
   - **The keyword classifier is DELETED entirely** (`src/txClassify.js`'s
     descriptor→category table). Nothing is guessed; a transaction is
     Uncategorized until a learned rule matches. This kills the
     NEWREZ→Utilities class of confidently-wrong guesses at the root.
   - **Sequencing: the learned-rules screen ships FIRST** (spec in
     Low-hanging fruit), because training becomes the ONLY path to a category
     and a bad rule must be reviewable//fixable/deletable before it is the
     sole mechanism. **That prerequisite is now MET — the Taught-rules screen
     SHIPPED 2026-08-04** (item 7): rules are listable, countable and
     deletable, so this work is unblocked on that count.

   **The structural catch — three built-ins are MECHANISM, not taste, and must
   survive as internals hidden from the picker:** `Transfers and card
   payments` (the card-payment veto in `isCardPaymentRow` reads it — dropping
   it lets card payments count as spending), `Return` (**historical, as of
   2026-08-17**: it WAS synthesised by `applyAccountRules` for credit-card
   negatives and counted in neither total. That synthesis is deleted — a
   refund now keeps the classifier's category and SUBTRACTS from it — and the
   label survives in the mechanism set only so stored values stay inert), and
   `Uncategorized` (the "not taught yet" state — this design needs it MORE,
   not less). Only the ~18 taste categories go.

   **Surface to change:** `ERA_CATEGORIES` in `src/categoryMap.js` (5
   importers: Dashboard.jsx, txClassify.js, categoryMap.js + 2 tests); the
   `dash:cats` registry becomes THE category system (it already carries
   colours via `dash:colors` and rename aliases via `dash:names`);
   `DEFAULT_SCHEDULE_E_MAP` in `src/taxReport.js` (only 2 entries) must go —
   category→line mapping becomes fully user-driven through the existing
   `tax:maps` key; `isBudgetableCategory` keeps gating the mechanism three.
   The Uncategorized teach-queue (Categories tab) becomes the primary
   onboarding surface rather than a cleanup aid — worth re-sizing as part of
   this. **Migration: yes, additive + a data step; paste before merge.**

1. **Dashboard.jsx decomposition** — deferred by Mason 2026-08-01 and STILL
   deferred; the file keeps growing (`wc -l src/components/Dashboard.jsx` —
   deliberately not frozen here; a pinned count goes stale the day the next
   feature merges). The
   staged plan (carried out of the deleted 2026-08-01 backlog): sheets and
   formatters first → a shared TxRow → the read-only tabs, every new module
   importing through dataAdapter.js so it stays inside the harness aliases.
   First big investment when feature pace slows; not before Mason says so.

2. ~~**Deriving RTA income (the income wall)**~~ — **SHIPPED 2026-08-13 as
   the HYBRID income rule** (Mason's call, made after backfill completed):
   a COMPLETED month reads actual measured income (`resolveBudgetIncome` /
   `getActualIncome`, the shared `cashIncome` model); the month IN PROGRESS
   and future months stay hand-typed (their paychecks haven't all landed);
   uncovered/pre-backfill months fall back to manual. Rules in CLAUDE.md's
   envelope Conventions. Consequence: Age of Money (Roadmap: "wants real
   *measured* income") is now buildable as its own decision.

3. **Reconciliation** — spec open (Roadmap). Half the build exists:
   `reconcileCsv` (`src/csvImport.js`) already max-matches statement rows
   against the ledger and CsvImport.jsx renders the comparison. The open
   half is what to DO with a mismatch: a missing-row insert path (dangerous —
   the overlap/double-count rules), an excluded-flag suggestion, or
   report-only. Needs a Mason spec before code.

4. **Real per-person Auth accounts** — ends the shared-login gotcha class
   (`scope:'local'` sign-out, localStorage-vs-settings prefs, "the other
   phone"). Invasive: `household_members` already maps user→household, so
   the RLS shape survives, but it means a second Auth user, invite flow,
   per-user prefs, and re-verifying every `current_household_id()` path +
   the receipts storage policy. Only worth it if Mason wants per-person
   attribution or separate prefs; otherwise the shared login keeps winning
   on pragmatism.

5. **Email-alert cron for freshness** — previously OUT (Roadmap: Vercel Cron
   → api/ route polling Gmail, service-role inserts, reconciled against the
   ledger). Revisit ONLY if SimpleFIN's ~daily refresh demonstrably hurts —
   i.e. if the feedback below keeps reporting >1-day staleness that matters.

## How Mason reports back (the feedback guide)

What field reports are actually useful, now that both phones run everything:

- **Two-phone behaviors**: sign-out on one device affecting the other (it
  must NOT — `scope:'local'`); saved chats and the recurring ignore list
  (settings-table-backed, read-merge-write serialized) and expected bills
  (their own table; concurrent auto-match dup-gated) appearing/updating on
  the second phone; any edit that shows
  on one device and not the other.
- **Touch feel**: the Overview card-tile swipe (horizontal-intent
  threshold), the month jump picker, sheet scrolling — anything that feels
  wrong at 390px is a bug report.
- **Teaching misses** (no classifier to miss any more — post-2026-08-05 the
  only categorizer is a learned rule): a merchant that stayed `Uncategorized`
  after being taught, or a taught rule that grabbed the wrong rows. Send the
  VERBATIM descriptor string from the detail sheet — `merchantKey` works off
  exact tokens, and the known over-specific-key limit lives in CLAUDE.md.
  Also worth reporting: a transfer or card payment that started counting as
  spending, since those guards are the only classification left in the code.
- **Recurring tab under the 40-month window**: false positives (one-offs
  listed), false negatives (a real weekly/annual sub missing), wrong
  cadence suffixes, price-creep flags on long-settled changes.
- **Any two on-screen numbers disagreeing** — the ONE-model unification's
  whole point is that Categories/Overview/Budget/Trends agree by
  construction, so a disagreement is always a real bug, never rounding.
- **Feed health**: the amber banner appearing, or any account >1 day stale —
  with the bank name (per-bank failures arrive inside an HTTP 200).

## Improvement backlog (synthesized 2026-08-13; five lenses, adversarially vetted against main)

> **Provenance and status.** Mason asked for "new ideas on how we can make this
> app better". Five lens agents (budgeting, insights, phone-UX, tax/rental,
> reliability) generated 36 ideas against a survey of the real code; curation
> cut them to 25 and an adversarial pass verified each against main plus this
> doc's refuted list. **Seven shipped the same day** (PRs #86 and #88 — the
> trim-the-key editor, the retraining progress meter + queue paging, the
> manual-delete confirm gate that became the imported soft-hide + Restore, the
> honest month pace, available credit, balance staleness, loan payoff
> progress). **Everything below is the unbuilt remainder**, ranked (deliberately
> not counted here — the first item to ship would falsify the number). Every
> one was verified to be a real gap at synthesis time — but main has moved
> since, so re-verify the premise before building, and mark the item shipped
> in the SAME PR per this doc's contract.

Sizes are S/M/L. "Needs Mason" means a preference, a metaphor, or a migration
paste — never a technical unknown.

### Protect what exists (do these first)

- **Household data export — the disaster-recovery floor** — M. Every byte of
  the ledger, the hand-taught `category_rules` the whole retraining effort is
  producing, the `dash:cats` registry, budgets and envelope history exist ONLY
  in prod Supabase. The app's only exports are the Ask-chat markdown and the
  per-property Schedule E CSV (`grep -n 'downloadCsv(' src/components/Dashboard.jsx`
  — a count frozen here would break the day this very item ships). A
  lost account or a bad write class is total, permanent loss; statement
  re-import rebuilds transactions only if the source files were kept. Build: a
  "Download household data" action on the Accounts tab (the established ops
  surface) over a new pure `src/exportBundle.js` (versioned JSON, node --test),
  fed by **new whole-table reads behind the façade** — the existing adapter
  reads are per-transaction/per-year and `getExpectedTransactions` RUNS AND
  PERSISTS the auto-match, so an export calling it would write. Include
  `balance_snapshots` (net-worth history is real recovery data) and a full
  settings read added to `db.js` (preserving the no-direct-`from('settings')`
  rule). Receipt IMAGES excluded in v1, stated in the bundle with a count (the
  honest-absence rule). Pin `simplefin_access` out of the table allowlist by
  test. Needs Mason only for the optional automated tier (a Vercel Cron writing
  the same bundle to a private bucket — needs a bucket migration).

- **Scheduled health workflow: daily prod probes + weekly bit-rot CI** — S.
  Several documented failure shapes have no alarm but a human noticing: a
  deploy whose `api/sync.js` dies at module load (the Gotcha's own remedy —
  probe `POST /api/sync`, require **401** — is a manual discipline), the
  `vercel.json` schema-rejection class where the site keeps serving the old
  deploy while every push dies, CSP served only by Vercel, and the in-app feed
  banner that stays silent for three days and only evaluates when someone opens
  the app. `.github/workflows/ci.yml` triggers only on pull_request and push to
  main — between sessions nothing runs anywhere. Build: `health.yml` with a
  daily unauthenticated curl probe (200 + a `content-security-policy` header on
  `/`; exactly 401 on `POST /api/sync` and `GET /api/simplefin-status`) and a
  weekly `npm ci` + test + placeholder build + `npm audit --omit=dev
  --audit-level=high` on main. The failure email IS the alarm. Note in the
  workflow header that GitHub disables cron workflows after 60 days of repo
  inactivity — the dead-man's switch can itself die quietly.

- **Settings-history journal: an undo for the wipe-shaped failure class** — S,
  **migration**. `dash:cats` / `dash:colors` / `dash:names` / `tax:maps` /
  `rec:ignore` are each ONE JSON row overwritten in place. A wipe-shaped bug
  already happened once (now guarded by `serializedUpdater` +
  `test/settingsChains.test.js`), but guards prevent KNOWN bugs and nothing
  provides recovery from the next unknown one — and the registry is exactly
  what retraining is hand-building. Build: additive `settings_history` +
  an AFTER UPDATE OR DELETE trigger capturing OLD for an allowlisted key set
  (EXCLUDING `asst:chats`, which runs to 300k chars per save), trimmed to ~20
  versions per key. Zero client code; recovery is a documented SQL-Editor
  SELECT. **The trigger MUST be SECURITY DEFINER with a pinned search_path**
  (the `current_household_id` pattern) — a plain trigger runs with the
  invoker's rights, so an authenticated phone's settings UPDATE would be denied
  by RLS on the zero-client-policy history table and ABORT the settings write
  itself, i.e. the guard would cause the catastrophe class it exists to
  recover from. Add the table to `rls_assert.sql`'s zero-client-policies
  allowlist like the `legacy_*` archives.

### Budgeting ergonomics (the YNAB muscle-memory gaps)

> Note (2026-08-16): distinct from the YNAB-style VISUAL redesign, which
> shipped separately (six PRs; rules in CLAUDE.md). These items are budgeting
> BEHAVIOR gaps and remain open.

- **Cover overspending — start the move from the red envelope** — S. An
  overspent envelope renders red (`envRowNode`'s `over`), but its only money
  affordance is ⇄, which moves money OUT of the envelope already negative.
  Covering it means knowing which envelope has room, finding that donor row,
  and picking the red one out of its destination chips. Add a "Cover" next to
  the red available on leaf rows only: opens the existing `MoveSheet` in
  reverse — `to` pinned, amount pre-filled with the shortfall, and a chip grid
  picking the SOURCE. Note two things the first draft of this item got wrong:
  MoveSheet's `rows` prop (`assignableRows`) drives the DESTINATION list only
  (`rows.filter(r=>r.category!==from)`), while the source is `from`/`srcRow`
  and is not filtered — so reversing the sheet means adding a source pool, not
  reusing that binding. And a parent must stay ELIGIBLE as a source: the
  Category-nesting Convention keeps it a legal move SOURCE precisely so a
  pre-nesting balance can get out; it is DESTINATIONS that exclude parents.
  Filter the source pool on available > 0, not on parenthood. No new write
  path, no model change.

- **Hand-add an expected bill from the Budget tab** — M. Expected transactions
  are managed on Budget but can only be BORN on Recurring — the code says so
  itself — and a genuinely new bill has never hit the ledger, so
  `detectRecurring` can never offer it. The pure core was explicitly built for
  this: `addExpected` inserts `recurring_key`-null rows and
  `isDuplicateRollForward` exists solely to protect hand-typed bills. Add
  "+ Add a bill" to the Upcoming-bills card over a small sheet (description,
  amount, due date **committed on blur with a year floor** — the
  `<input type="date">` gotcha, cadence chips, a picker filtered by
  `isBudgetableCategory`). Copy `QuickAddSheet`; ship the full overlay
  contract (`useEscClose` + role/aria + both sheet registries). Display-only
  contract untouched.

- **Cross-month Mark-paid picker** — S. The picker filters the viewed month's
  in-memory rows, so a bill due the 31st and paid the 1st is invisible while
  viewing the due month: the picker says "no similar transaction", the bill
  goes red "missed?", and trust erodes on exactly the month-boundary bills
  (rent, mortgage) the feature exists for. Fetch by the BILL's window instead:
  `searchTransactions` in filter-only mode with amount ±`EXPECTED_AMOUNT_TOL_PCT`
  and date ±`EXPECTED_WINDOW_DAYS[cadence]`, both imported from
  `src/expectedTx.js`. Not the refuted cross-month category browse — no `.or()`
  over synthesised rows, and the results are ephemeral picker state.

- **Ready to Assign as a first-class move endpoint** — M. **Needs Mason (a
  metaphor call).** Money flows into envelopes ergonomically but pulling it
  back means mentally computing `assigned − n`; and when RTA goes negative
  there is no guided path at all, because `planMove` keeps total assigned
  constant — no sequence of moves can fix it. Add an RTA chip to `MoveSheet`
  as both source and destination, committing as a single `setAssigned` (the
  conditional-delete path already handles landing on 0 with a live
  `target_override`). Presenting a derived number as a place money lives is
  the decision; also whether a pull-back may drive `assigned` negative.

- **Target-setting context: recent actual spend inside TargetSheet** — S.
  **Needs Mason.** Post-wipe every target is typed into a blank sheet with no
  memory of what the household actually spends, and the per-(category, month)
  history is already computed for the envelope walk and thrown away. Render an
  info line ("Jun $412 · Jul $388 · Aug so far $190") plus an optional
  tap-to-fill chip — never auto-written. Label the current month "so far" (the
  partial-month rule) and say "based on categorized spending", since figures
  run LOW while merchants are untaught. Honest scoping note: the walk range
  may not cover four months, so either widen the fetch (a real query/cache-key
  change — name it in the spec) or scope v1 to history within the walk range
  and say so in the sheet.

- **Rapid teach mode — a flashcard sheet that walks the whole queue** — M.
  **Needs Mason: this IS the "promote the queue as an onboarding surface"
  decision item 0 leaves deliberately unclaimed.** Teaching costs ~4 taps
  through the general-purpose tx sheet per merchant. A `TeachSheet` iterating
  the FULL `teachQueue.spending` list (merchant key → its rows → the raw
  descriptor → chips + ＋New → the existing dry-run count and scope toggle →
  Always/Skip → auto-advance), with one `reloadData` at close and a local
  `taughtKeys` set meanwhile. Per-merchant seq guard on the dry run (the
  movers month-tagging lesson). Queue rows keep opening the full sheet as the
  secondary path (rename/entity/receipts live there).

### Insights the backfill made possible

- **Month in review — an Overview summary for completed months** — M. **Needs
  Mason (placement and tone).** *Premise corrected 2026-08-13 by audit: the
  Budget half of the original idea is ALREADY SHIPPED — Dashboard branches on
  `incomeResolved.source==="actual"`, suppresses the editor with a
  "would be a trap" comment, and already renders "actual · planned $X" and
  "spent $X of $Y targeted". Do not re-propose it.* What is genuinely missing
  is the OVERVIEW side: paging back to a finished month shows the same donut
  and recent-6 layout with no "so what". Build one display-only card, rendered
  only when viewed < current month, off a pure `src/monthReview.js`: total vs
  prior, biggest mover, largest purchase (max `isSpend` row, tapping opens the
  existing tx sheet), and net saved — `netSaved` OMITTED when `coverageStart`
  says the month isn't ledger-covered (the `resolveBudgetIncome` fallback
  discipline). Every input is already fetched or one memo-ride away. Keep the
  two spend SCOPES verbally distinct (budgeted-envelope spent vs household
  spent) or the card contradicts Categories at a glance.

- **Year view: 12-month Trends + per-category year card** — M. Backfill is
  complete to ~Feb 2026 but every trend surface is hard-capped at 6 months
  (`getCashFlow({num_periods:6})`), so a year of clean data has no surface.
  Add a 6mo/12mo chip (the parameter already exists) and a "Year by category"
  card. **The category card must pair per CALENDAR MONTH** — call
  `getTransactionsBetween` once per month, each served by slicing the wider
  memoized fetch — so each month's marks match the Categories tab by
  construction; the cash-flow toggle may keep `getCashFlow`'s whole-window
  pairing, which is Trends' existing documented behavior. Months before the
  household's earliest visible row render "no data", never $0 (reuse
  `getActualIncome`'s earliest-row probe). Lazy-load on the toggle.

- **Merchant insights: top-merchants card + "history at this merchant"** — M.
  The app has no merchant-level view anywhere — `merchantKey` is used for
  teaching and (in `expectedTx.js`) as a bill-matching signal, never for
  aggregation — so "how much do we spend at Costco?" is unanswerable. New pure
  `src/merchantStats.js` folding `isSpend()` rows by display name collapsed
  through `merchantKey`, a `getMerchantStats({months:6})` riding the same range
  memo as `getCashFlow`, a Trends card, and one line in the tx sheet. Tap
  through to the existing search with the name pre-filled (reusing search, not
  the refuted cross-month category browse). Label it "grouped by name" — the
  deliberate no-stemming rule keeps "COSTCO GAS" and "COSTCO WHSE" separate.

### Tax, rental, and record-keeping

- **One-tap preparer package export** — S. January handoff is N separate taps
  (one worksheet CSV per property), and the personal-deduction buckets and the
  mileage log export NOWHERE — `scheduleECsv` is the only CSV builder in
  `src/taxReport.js`. Add a pure `taxYearPackageCsv` reusing `csvCell` (the
  formula-injection guard) and the sectioned pattern: every property worksheet,
  each deduction bucket WITH its backing rows, and the mileage rows plus the
  per-rate breakdown. Everything it needs is already loaded by the tab's lazy
  effect. Needs Mason only for one-file vs per-section preference.

- **Rent roll: render the per-month strip `entityMonthly` already computes** —
  S. `entityMonthly` is called per property and reduced to year totals only;
  the month-by-month P&L it returns is never shown, so "did rent land every
  month?" needs a manual count. Render a 12-slot strip (390px-safe grid),
  zero-income months visually distinct but NEUTRAL — vacancy is legitimate and
  amber must keep meaning "needs fixing". Zero new computation, zero I/O.
  Needs Mason only on whether zero-income months get any emphasis at all.

- **Repeat-drive chips — one-tap mileage logging** — S. Rental drives repeat but
  every entry retypes miles and purpose with no frequency memory (the date
  already defaults to today and the entity to the first active property), and
  a thin log is a real lost deduction at 76¢/mi. Derive the 3–4 most frequent (purpose, entity,
  miles) combos from the already-loaded `mileage` state (pure
  `frequentDrives`, ≥2 occurrences or render nothing) and render them as
  chips. **The chip PREFILLS the form with Save as the confirming second tap
  — never an immediate write**: the date is the one field the chip's label
  doesn't assert, and the rate is date-dependent (2026 splits mid-year
  72.5¢→76¢), so a wrong-dated drive is a wrong entry on a preparer-facing
  deduction log.

### Polish

- **Touch-first rename and color affordances** — S. The two edits retraining
  leans on are desktop-shaped on a phone-first app: `EditName` commits via
  `onDoubleClick` with a title tooltip (invisible on touch), both hint footers
  say "Double-click a name", and `Swatch` is a 14px target adjacent to
  `DrillNum` taps. Wrap the swatch in a padded hit area (the visual stays
  truthful — it must show the stored hex), give `EditName` a coarse-pointer
  path via `matchMedia('(pointer: coarse)')`, and swap the hint wording per
  pointer type. Re-screenshot at 390px: category rows are dense.

- **Load-more past the account sheet's 500-row wall** — S.
  `getAccountTransactions` caps at 500 and the sheet renders a dead end
  ("Showing the most recent 500 transactions") with `acctHasMore` true and
  nothing to tap — and post-backfill the shared checking carries the whole
  history. Give it offset paging on the `searchTransactions` pattern:
  ordered `.range` with **date desc + id desc tiebreak** (the current query
  orders by date ONLY, so a page boundary inside a same-dated run drops or
  repeats a row) and the exact-page-multiple 416 read as end-of-data.

- **Persist the Debt tab's payoff plan** — S. **Needs Mason (household vs
  device storage — the same open choice family as the coverage-gap ack).**
  `debtStrategy`/`debtExtra`/`debtInclude` are plain `useState`, so every
  launch re-opts loans into the payoff, retypes the extra, and re-picks the
  strategy. One settings key through `makeSerializedUpdater` (never a third
  hand-rolled copy), tolerant parse, loaded via `getStartupSettings`; stale
  account ids ignored harmlessly (the `mm:cardTile` precedent).

## Refuted / decided — do NOT re-propose

Carried out of the deleted 2026-08-04 audit backlog. Six of its 39 findings
were refuted in the adversarial pass; these are the ones a future audit would
otherwise raise again.

- **"Android back closes the app"** — refuted as stated: the household is
  iPhone-only. Survives only as the iOS back-swipe sheet dismissal (shipped).
- **"Fonts blocked behind the JS parse"** — overstated: Vite emits the CSS as
  its own `<link>`, so fonts wait on CSS, not JS. Preload shipped anyway.
- **"RLS entirely untested"** — policy COVERAGE was hand-verified complete
  across all 16 migrations; no missing policy exists. The opt-in harness
  shipped; the fuller spec is item 6 above.
- **"The 2-char search gate is a decided rule"** — refuted: it was pre-existing
  activation behavior, never a recorded decision.
- Anything relitigating the sign conventions, the unified linked-boundary
  model, hidden-by-default accounts, theme tokens, or the envelope walk was
  screened out against CLAUDE.md's decided lists.

**Mason's 2026-08-04 decisions** (all executed; recorded here because the doc
that held them is gone): month-navigation caching **yes** (shipped); **no**
durable assistant throttle — the Anthropic spend cap is the control, and it is
set; the dataAdapter split got **its own quiet session** (shipped).

## Shipped since this doc was written

- **Subcategories, one level (2026-08-05, Mason's decision)** — "we want totals
  for both": a parent ("Transportation") and its children ("Gas", "Parking"),
  with spending totals at both levels. **No migration and no schema change** —
  transactions still store exactly one label, the LEAF, and the parent link is
  an optional `parent` field in the `dash:cats` registry, so every learned
  rule, budget row, tax mapping and envelope kept working untouched. Money is
  owned at the leaf (`available = assigned + carry − spent` needs one owner per
  dollar); a parent shows a read-only rollup and takes no assignment or target.
  Pure core `src/categoryTree.js` + `test/categoryTree.test.js`; the decided
  rules are in CLAUDE.md's Conventions.
  - **Parent-level BUDGETING is deliberately NOT built** and is a separate
    decision for Mason — assignments at both levels make "Transportation has
    $400 available" ambiguous and let the walk double-count a dollar. Don't
    propose it as a bug.
  - Review fix worth remembering: `groupCategories` preserves the caller's
    order, which is right for a leaf and wrong for a heading — a parent with no
    rows of its own sorted into the appended zero-spend tail while rendering a
    large rollup, dragging its children to the bottom of a biggest-spend-first
    list. Groups are re-ranked after grouping (`orderGroups`). Any future
    grouped list has the same trap: **sort by the number the row displays.**

## Shipped backlog — synthesized 2026-08-11, ALL 16 SHIPPED 2026-08-12 (ship record, not live work)

> **ALL 16 ITEMS BELOW SHIPPED 2026-08-12, in the same PR that wrote this
> section** (three build waves + adversarial review; two review catches — the
> sanitize-order truthiness bug and the Refresh-button staleness regression —
> fixed before merge). Retained as the ship record; the killed list below
> still governs. Identifiers named in the item texts (e.g. the retired
> `FEED_LOOKBACK_DAYS`) are historical description of the fixed hazards, not
> live references.

Ranked for a two-user household app in its retraining/backfill phase: correctness risk removed > dev-loop reliability > user-visible polish > cleanliness. Each item records why it needs nothing from Mason — no migration, no env change, no preference call, no data only he holds.

### Do next

- **Category-registry settings writes: adopt the serializedUpdater discipline and stop swallowing failures** — M. `saveCats` (Dashboard.jsx:1713-1715) writes the WHOLE `dash:cats`/`dash:colors`/`dash:names` registry from component state inside `catch{}`, with a mount read that degrades to `[]` (Dashboard.jsx:1666, :1500) — so one failed read plus one category add wipes the household's registry, byte-for-byte the `rec:ignore` hazard CLAUDE.md already records, and a silently failed write loses a just-created category while its taught rules persist. Route the three keys through `makeSerializedUpdater`-bound read-merge-write updaters (behind the façade in `settingsIO.js`, which has the two existing call sites to copy) and give handlers the `saveTaxMaps` rollback+alert shape (Dashboard.jsx:1754-1762). Needs nothing from Mason: it applies two already-shipped disciplines (serializedUpdater, Session A rollback+alert) to stragglers that predate them; two-phone last-write-wins stays the accepted convention. Highest-value item on the list — `dash:cats` is THE data structure of the live retraining task, written from both phones.

- **Teach-queue rows are 22px-tall tap targets on the primary retraining surface** — S. `TEACH_ROW` (Dashboard.jsx:890-891, `padding:"4px 0"`, no minHeight) renders full-width merchant rows measured 292×22 with zero separation; a mis-tap opens the WRONG merchant's sheet and invites a wrong learned rule — the confidently-wrong failure this codebase refuses, on the surface Mason and his wife tap daily. Raise the row to the 32px floor (one shared constant; sibling buttons in the same card already use `minHeight:32`). Git blame shows TEACH_ROW landed the day AFTER the Session B hit-area batch — an omission, not a decision. No migration, no taste call: the 32px floor is the file's own shipped precedent; verify by re-measurement + the recorded 390px screenshot workflow.

- **Sub-32px hit targets that escaped the Session B pass** — S. The per-envelope ⏱/⇄/⟳ buttons (Dashboard.jsx:3103-3119, plus 4005) measure ~14×13px, 2px apart — and ⟳ is a settings WRITE (rollover toggle), so a fat-finger silently changes envelope carry behavior; the amber-banner ✕ (Dashboard.jsx:3396-3397, 15×18) sits beside "Check connection"; `.nbtn` is 30×30 (ui.css:189). Apply the file's own recipe (minWidth/minHeight 32, negative margins — Dashboard.jsx:3905, 5195, 6044), sizing the negative margins so the three adjacent hit boxes abut rather than overlap. Purely mechanical extension of the recorded Session B discipline; no redesign, no migration.

- **CSV formula-injection guard in scheduleECsv's csvCell** — S. `csvCell` (src/taxReport.js:343-346) only quote-escapes; feed-supplied bank text (`c.description`, :376) and user text flow into a file explicitly built to be handed to a tax preparer and opened in Excel, where a leading `=`/`+`/`@` (add tab too — it's free) executes. Neutralize text cells only (prefix `'`), excluding `-` so `toFixed` amounts stay byte-identical and the pinned positive=out sign rule (test/taxReport.test.js:325) is untouched; extend the existing csvCell test block. Pure function + unit test in an existing zero-dep core — no migration, no decision, standard hardening in line with the repo's CSP/SSRF/sanitized-500 posture.

- **One-copy FEED_LOOKBACK_DAYS: retire the OVERLAP_DAYS client mirror** — S. CsvImport.jsx:209 hardcodes `FEED_LOOKBACK_DAYS = 30` mirroring `OVERLAP_DAYS` (api/_lib/simplefin.js:51); an operator setting `SIMPLEFIN_OVERLAP_DAYS` silently desynchronizes the import-boundary math and two user-facing sentences (:1169, :1279) from what the sync actually re-reads — risking the exact CSV/feed double-count the overlap rule prevents. Export `FEED_OVERLAP_DAYS = 30` beside `FEED_REACH_DAYS` in the PERMANENT half of src/coverage.js, make it the `envInt` default, import it in CsvImport.jsx, and pin the lockstep in test/coverage.test.js exactly like the existing `MAX_LOOKBACK_DAYS === FEED_REACH_DAYS` assertion (:71). CLAUDE.md's CsvImport.jsx key row itself prescribes this exact fix "when touched next" — update that hazard sentence in the same PR per the maintenance contract. No env change (the override keeps working, same accepted residual as FEED_REACH_DAYS).

- **Summary-tile grid overflows the 390px viewport and wraps the Card-balance minus sign** — S. The three header tiles use `repeat(3,1fr)` (Dashboard.jsx:3418) but the card items keep `min-width:auto`, so the nowrap sub lines (:3444) inflate tracks to a measured 141/100/124px in a 358px box — the page body scrolls sideways ~11px on 8 of 10 tabs and the minus sign wraps, re-manifesting the exact bug the comment at 3421-3423 says was fixed. Fix: `minWidth:0` on the card style at :3430 (the idiom already appears ~20× in the file), which lets the existing ellipsis engage; while re-screenshotting, check the 20px value line (:3443) for overflow on five-figure balances. One-line change restoring documented intent, verified by the recorded 390px screenshot workflow.

### Then

- **Node regression test for src/pdfPolyfills.js** — S. The ReadableStream async-iteration polyfill is what makes PDF import work on EVERY iPhone, yet no test exists and CI's Chromium has the natives, so a regression ships green everywhere except the household's actual phones — during the live statement-backfill task, with "no alarm anywhere". New `test/pdfPolyfills.test.js` using CLAUDE.md's own prescribed recipe (delete `ReadableStream.prototype[Symbol.asyncIterator]`, plus `values`, `structuredClone`, and `Array.prototype.at` — all BEFORE the single-shot `installPdfPolyfills()` call, safe because node --test isolates each file); cover iteration/lock-release/early-break, DataView byteOffset preservation, cyclic clones. Zero-dep test addition; add it to CLAUDE.md's test/ inventory row same-PR.

- **vercel.json top-level-key allowlist assertion in test/securityHeaders.test.js** — S. An unknown top-level key kills every deploy BEFORE it builds while the site silently serves the old one, and nothing local catches it — this shipped once (PR #45's `_csp_derivation`). The test already parses vercel.json (line 22) but pins only outputDirectory/rewrites (:99-104); assert `Object.keys(config)` is exactly `{buildCommand, outputDirectory, rewrites, headers}`. ~10 lines in an existing zero-dep file; CLAUDE.md's Gotcha explicitly names this mechanism and this file as wanted — update that "missing mechanism" sentence in the same PR.

- **Sanitize the client-visible sync failure messages (raw err.message inside a 200)** — S. api/sync.js:735 and :773 push raw `err?.message` into `results[].error`, which SimpleFinConnect.jsx:107 renders verbatim in the connect modal — while the IDENTICAL string is sanitized three lines earlier for `last_error` "because last_error is rendered in the connect modal". Wrap both sites in the already-imported `sanitizeFeedMessage` (keeping the `'Unknown error'` fallback applied first so the error stays truthy) and add a targeted test pin — the general apiErrorSanitize scan covers only `.status(500).json(` and would false-positive if widened. Two one-line wraps + a test; parity with the code's own precedent, no behavior decision (consumers only truthiness-test `.error`).

- **Three overlays missing the recorded Escape + role=dialog/aria-modal discipline** — M. CLAUDE.md rules EVERY overlay ships all three; the CsvImport modal (CsvImport.jsx:1035-1036), SimpleFinConnect modal (SimpleFinConnect.jsx:199-200), and ReceiptSection full-size viewer (ReceiptSection.jsx:124-137) have none — and worse, Escape with a receipt open falls through to Dashboard's capture-phase handler (Dashboard.jsx:2306-2316) and closes the whole tx sheet underneath, inverting the documented topmost-layer-wins rule. Add role/aria + Escape gated exactly like each modal's existing backdrop-click guard (`busy||batchRunning` / `busy`); for the receipt viewer, note the naive stopImmediatePropagation approach fails (Dashboard's earlier-registered capture listener fires first) — Dashboard's handler must yield to the viewer via lifted state/ref or a DOM marker check. Mechanical application of a recorded mandatory rule; gating semantics are copied, not invented.

- **Take the first-load runSync off the first-paint critical path** — M. fetchData awaits `runSync()` to completion before a single data query (Dashboard.jsx:1926-1936) — so first paint waits out the full serverless round trip, and hourly, the whole Bridge pull. Start `reloadData` immediately (painting DB state is existing behavior on every sync failure and every other-device sync), run the sync concurrently, and chain one follow-up reload off the runSync promise INSIDE fetchData (never a second `setSyncCompletionHook` — that slot is single and already held by dataAdapter, dataAdapter.js:861), skipped when every result is `skipped:'throttled'`; keep the feed-health status check (:1954-1964) after the sync resolves. Client-only reordering, freshness semantics preserved, pullWasClean/CSV gating untouched; the only visible change is the startup skeleton clearing seconds sooner.

- ~~**Rehearse the Path A migration replay locally via `supabase db push --db-url` and narrow the PENDING flag**~~ **SHIPPED 2026-08-12; hosted half completed 2026-08-13** (Mason's fresh-install test ran `link` + `db push` clean against a throwaway hosted project — config.toml's header records the full status; Path A is now the default install). Original text: S. config.toml:10 flagged the 18-file CLI replay as never rehearsed, but the raw-SQL half is already answered (the rls harness replays every migration on empty PG16) — and verification of this item actually RAN the full non-dry-run push against a throwaway local cluster: all 18 applied cleanly, `schema_migrations` populated. Re-run it in scratch for the session's own log, then same-PR narrow config.toml's STATUS block and CLAUDE.md's config.toml key row to the honest residue: rehearsed = the CLI runner on a local PG16 stub; still unrehearsed = `supabase link`, hosted PG17, real auth/storage schemas — Path B stays the verified path. Never touches PROD (which is never linked, per workflow rule 5); no Mason account needed.

### Whenever

- **Make the envelope spend cache range-keyed so month navigation actually reuses it** — S. `spendCache` is one slot keyed on the exact walk range (dataAdapter.js:843, :864-865), and getEnvelopes moves `end` with the viewed month (:899-901) — so every month tap refetches the household's ENTIRE budgeting history (rangeMemo deliberately bypassed, :206-209), inside reloadData on every navigation whatever tab is open (Dashboard.jsx:1890). Replace with a small bounded Map keyed by range, cleared by the same `invalidateEnvelopeSpending`; do NOT slice a narrower month from a wider entry (the pairing runs over the whole window on purpose — only exact-key reuse is honest). Implements Mason's recorded 2026-08-04 month-navigation-caching ruling more completely, not a new policy; same-PR, update test/invalidationMatrix.test.js:75-76's source-scan literals (`spendCache = null`, `spendGen++`) and the comments at dataAdapter.js:201/:837. Value grows with budget history.

- **Batch the seven startup settings reads into one getSettings round trip** — S. The mount effect fires seven single-key settings queries (Dashboard.jsx:1663-1671) and `ready` — which gates the entire fetchData chain (:1938-1939) — waits on all seven; db.js:25-37 already exports the batch `getSettings(keys)` built for exactly this, and getBudgetIncome already uses it. Honest sizing: the seven run in parallel over one connection, so the win is request count and radio jitter, not a full RTT — small but free. Expose the batch through the adapter/db façade for the two adapter-owned keys (getEnvPace's inline parse, getRecIgnore in settingsIO) rather than Dashboard calling getSettings directly; test/smokeMocks.test.js names any mock to add. Zero behavior change.

- **Render per-debt interest and calendar payoff months in the payoff projection footer** — S. The footer renders only "clears month N" (Dashboard.jsx:4747) — a raw index — while `perDebt[].interest` is computed on every render (debtPayoff.js:142, :199) and read by nothing, and it's the number that explains why avalanche beats snowball. Render e.g. "Venture X clears Mar 2027 · $234 interest" — `startMonth`/`addMonths`/`monthYear` are all live at the call site, and the calendar idiom is the tab's own convention (the Debt-free tile at :4735). Use the same conversion as `debtFreeMonth` so the last debt's footer matches the headline tile. Display-only, no test pins the current string, nothing on any refuted/deferred list.

- **Surface the envelope walk's total Available in the Budget header** — S. `walkEnvelopes` computes budget-wide totals (envelopes.js:254-269) but the header renders only `totals.assigned` (Dashboard.jsx:3746) — total Available, the model's own answer to "how much budgeted money is left", is computed on every walk and shown nowhere (RTA is income − assigned, a different number). Add "$X sitting in envelopes" (optionally "spent $Y of $Z targeted") to the existing RTA card from `envelopes.totals`, already in component state. Label it as covering budgeted envelopes only — the totals deliberately exclude the read-only unbudgeted rows (Uncategorized), or the sum reads as a discrepancy against the visible chips. No I/O change, no assignment mechanics, no income derivation — distinct from the open Mason decisions in this area.

### Killed in verification (don't re-propose)

- **Fifth supabaseClient.js smoke-harness alias + render App.jsx through the CI render gate** — its central acceptance criterion is falsified by current code: App.jsx:121-131 handles a cold-start count failure as `setCount(prev => prev ?? 0)`, so the "must never show EmptyState on error" assertion fails against main, and fixing that is a user-facing UX decision for Mason. A narrower re-scope (alias + healthy-count render only) may be viable as a NEW item, but not this one as specced. **That narrower re-scope SHIPPED 2026-08-12 (PR #78)**: the fifth alias + real-App healthy-startup render are live in `test/smoke/` (canary-verified); the count-error-path assertion stays killed by decision (asserting it chooses user-facing behavior). The kill governs only the error-path half.
