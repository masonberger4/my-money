# Next-iteration plan — 2026-08-04 (findings + feedback guide)

Written the day the 2026-08-02 session plan spent itself (saved chats + search
refinement shipped; `docs/session-plan-2026-08-02.md` deleted per its own rule)
and the 2026-08-01 backlog closed except the one deliberate deferral. This doc
is the holding pen for what comes next. CLAUDE.md wins on any conflict; nothing
below relitigates a decided item.

## Low-hanging fruit

1. **The Pending data/ops tasks FIRST** — they're worth more than features
   right now, because every model above them (income, Trends, RTA) reads the
   same rows. All five live in CLAUDE.md's Pending section with full detail;
   in priority order:
   - ~~Rotate the Supabase service_role key~~ **DONE 2026-08-04**, verified by
     a successful assistant round trip (an answer proves `requireUser` passed
     on the service client). The Anthropic spend cap is DONE too ($25/mo,
     alert at $10).
   - **$2,200 payroll duplicate** — two distinct `sfin:` ids for the same
     2026-07-24 deposit on Cashback Debit (3481), so the
     `(account_id, plaid_tx_id)` upsert can't dedup. Verify against the
     Discover statement; `excluded=true` on one copy. July income reads
     ~$2,200 high until then (+ ~$34 of Venture X same-day dupes Jun+Jul).
   - **Discover it (7933) twins — UPDATED 2026-08-04 by Mason's inspection.**
     The `credit`-typed row (Discover org) turned out to hold **no
     transactions**, so Mason hid it and kept the sibling — which is the row
     typed **`depository/checking`** under the Capital One org. That inverts
     the earlier "keep the credit one" advice: the question is no longer
     which row to keep but **the TYPE on the row that holds the data**. A
     "Discover it" is a credit card, so that row must be retyped **Credit
     card** in the account-type editor before it is ever unhidden — while it
     is typed checking, every purchase on it counts as household CASH
     spending (the F2 failure the hidden-by-default rule exists for).
     **Mason's hypothesis, plausible and worth confirming: Capital One
     acquired Discover, so SimpleFIN pulling both the Capital One and
     Discover logins can surface the SAME card under two orgs.** Each row
     carries its own `sfin:` id, so the `(account_id, plaid_tx_id)` upsert
     cannot dedup them — with both visible, everything on that card
     double-counts. Confirm via the Accounts-tab Data coverage panel (it
     deliberately includes hidden accounts): overlapping date ranges + similar
     row counts ⇒ same card twice. Search cannot see them —
     `searchTransactions` inner-joins `accounts.hidden = false`.
   - **NEWREZ recategorization** (~$3.8k/mo in "Utilities") — counted once,
     just the wrong bucket. **Root cause is the keyword table**
     (`src/txClassify.js`: `/NEWREZ|SHELLPOINT|MORTGAGE|…/ → 'Utilities'`,
     because the taxonomy has no housing member). **Largely SUPERSEDED by the
     user-owned category system** (Harder §0): that work deletes both the
     keyword table and the taxonomy, so NEWREZ stops being mis-guessed by
     construction and gets whatever category Mason creates for it. Fix it by
     hand now only if the wrong bucket bothers him before that ships.
   - **Pre-May statement backfill** — BECU savings, Cashback Debit, the cards,
     via CSV/PDF import; the Data coverage panel (Accounts tab) shows each
     gap. First confirm the Checking 2644→5481 re-key theory (rows abut at
     2026-04-03 with no overlap) before treating 2644 as separate.

2. **Receipt OCR v1** — the upgrade path CLAUDE.md already reserved: a new
   `api/receipt-ocr` route on the existing `ANTHROPIC_API_KEY`, reading the
   stored image (signed URL server-side or Storage download under
   service_role), returning merchant/date/amount/category suggestions,
   **confirm-before-write** in the detail sheet (the confidently-wrong
   refusal applied to OCR). Plumbing exists end to end: `receipts` table,
   `ReceiptSection.jsx`, `getReceiptUrl`, `requireUser()`. No migration.

3. **Cash-flow forecast lite** — previously "later (discussed, not
   committed)", but Session 6 built the hard part: `expected_transactions`
   carries cadence + due dates, `projectFutureCycles`/`rollForwardDate`
   (`src/expectedTx.js`) already project forward. Projected end-of-month
   balance = current depository balances − remaining expected outflows
   (+ expected income if typed). Keep it a pure core + one Overview/Trends
   card; it inherits the DISPLAY-ONLY contract — never touches Available,
   the walk, or any total.

4. **Bundle trimming** — main chunk ~584 kB (pdf.js's ~1.8 MB is already
   lazy via `pdfExtract.js`, as are the modals). Next lever is tab-level
   `React.lazy` inside Dashboard.jsx (Tax/Debt/Trends render heavy pure
   cores). **Harness caveat:** the mock harness aliases
   dataAdapter/sync/db/apiClient by full-match regex — any split-out module
   must keep importing through `dataAdapter.js` or it escapes the mocks
   (same rule recorded for the decomposition, backlog Section 3).

5. **Retire the Data coverage panel** once backfill (item 1) settles — it was
   shipped as TEMPORARY (CLAUDE.md Merged features). Delete the card, keep
   `src/coverage.js` + `getDataCoverage()` only if something else has started
   reading them; otherwise remove all three plus `test/coverage.test.js`.

6. **SQL/RLS tests** — ~18 `create policy` statements across
   `supabase/migrations/`, zero tests; the testing-suite entry records this
   as the worthwhile follow-up. Use the Local-checks recipe in CLAUDE.md
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

8. **Surface `coverage_shortfall`** — size **S/M**, **no migration**.
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
     get a fourth hardcoded client copy (`CsvImport.jsx:193`'s
     `FEED_LOOKBACK_DAYS` is already one drifting copy of `OVERLAP_DAYS`).
     Cap the per-account scan at 25 + `truncated`; wrap the whole block in
     try/catch that **omits the `coverage` key** on any error (missing key =
     no notice — never render a gap you aren't sure of, and never 500 the
     Accounts tab). Client pure core is a **new `src/feedCoverage.js`**,
     deliberately not an addition to `src/coverage.js` — that's the TEMPORARY
     panel's core (item 5) and the tell must outlive it.
   - **Don't touch:** `api/sync.js` is unchanged, and **`pullWasClean` must
     keep ignoring `coverage_shortfall`** — `test/csvImport.test.js:262` is
     the REGRESSION keeping a shortfall from blocking the statement import
     that is the remedy.
   - **UI:** a quiet **neutral** strip, *not* a second variant of the amber
     feed-health banner — amber means the feed is broken, while a first-pull
     shortfall is the expected result of a first pull, and reusing amber
     trains it as noise. Ack via a stored ISO date, re-raising when
     `worst_from` moves past it.
   - **→ Mason decisions (flagged):** `GRACE_DAYS = 21` is a judgment call;
     and the spec names the ack key `feed:coverage-ack` but not its store —
     CLAUDE.md's rule points at `settings` (account-level fact, not a
     device/visual pref), confirm before building. The source spec's §4 (UI)
     is unfinished — settle the strip's exact placement and copy at build.

## Harder, high value

0. **USER-OWNED CATEGORY SYSTEM — Mason's decision 2026-08-04. This REVERSES
   recorded decisions; it is the next major line of work.** The app ships no
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
   it lets card payments count as spending), `Return` (synthesised by
   `applyAccountRules` for credit-card negatives; never spending, never
   income), and `Uncategorized` (the "not taught yet" state — this design
   needs it MORE, not less). Only the ~18 taste categories go.

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
   deferred; the file is now **4,983 lines** (`wc -l`, 2026-08-04). The
   staged plan is recorded in `docs/improvement-backlog-2026-08-01.md`
   Section 3: sheets/formatters first → shared TxRow → read-only tabs, every
   new module importing through dataAdapter.js (the harness-alias rule).
   First big investment when feature pace slows; not before Mason says so.

2. **Deriving RTA income (the income wall)** — CLAUDE.md's envelope section
   says exactly what unlocks it: every income account reliably fed. That's a
   data-quality gate, i.e. it sits BEHIND low-hanging items 1 (payroll dupe,
   backfill) — and it's **Mason's call, not an automatic upgrade**. Deriving
   income (via `cashIncome`, already pure) then unlocks honest RTA and Age
   of Money (Roadmap: "wants real *measured* income").

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
  must NOT — `scope:'local'`); saved chats, the recurring ignore list, and
  expected bills appearing/updating on the second phone (all
  settings-table-backed, read-merge-write serialized); any edit that shows
  on one device and not the other.
- **Touch feel**: the Overview card-tile swipe (horizontal-intent
  threshold), the month jump picker, sheet scrolling — anything that feels
  wrong at 390px is a bug report.
- **Classifier misses**: the VERBATIM descriptor string (from the detail
  sheet), what it was categorized as, what it should be. Verbatim matters —
  `merchantKey` and the keyword table both work off exact tokens.
- **Recurring tab under the 40-month window**: false positives (one-offs
  listed), false negatives (a real weekly/annual sub missing), wrong
  cadence suffixes, price-creep flags on long-settled changes.
- **Any two on-screen numbers disagreeing** — the ONE-model unification's
  whole point is that Categories/Overview/Budget/Trends agree by
  construction, so a disagreement is always a real bug, never rounding.
- **Feed health**: the amber banner appearing, or any account >1 day stale —
  with the bank name (per-bank failures arrive inside an HTTP 200).

## Next backlog

This doc is an interim holding pen, not a verified backlog. The mechanism
that supersedes it: a fresh **six-dimension audit** (UX, code health,
performance, security, testing/reliability, data insights — the
2026-08-01 shape), fed by this list plus Mason's field reports above, each
finding re-verified against the code before it becomes a work item. When
that audit lands, this file collapses to a one-line pointer or is deleted,
per the improvement-backlog precedent.
