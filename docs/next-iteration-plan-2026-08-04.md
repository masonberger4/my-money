# Next-iteration plan — 2026-08-04 (findings + feedback guide)

> **Contract for AI sessions:** items here are live specs — the PR that ships
> (or supersedes) an item marks it shipped/refuted in that same PR, noting what
> shipped instead when the design diverged; an unmarked shipped item is a bug.
> When every item is resolved this doc is DELETED per the maintenance
> contract (docs/memory/maintenance-contract.md). The memory docs are authoritative wherever the two disagree.

**Where the live work is:** the **Improvement backlog (2026-09-04 audit)**
section is the newest list and the only one with a Mason ruling on it (he ticked
the bug fixes 2026-09-08 and deferred the rest); the **Improvement backlog
(2026-08-13)** section above it is still unbuilt and still live. Items 2/3/4
under Low-hanging fruit and 1/3/4/5 under Harder are the older live specs.
Everything struck through is a POINTER to a shipped thing, not work — git and
the named PRs hold the detail.

**THE single forward-looking doc** (the one exception is recorded in the
Roadmap doc inventory, docs/memory/ship-record.md). Both six-dimension audit backlogs (2026-08-01 and
2026-08-04) shipped out completely and were deleted 2026-08-05 per the
delete-when-spent rule — their decided rules live in the memory docs (docs/memory/), their history in
git, and the one thing worth carrying forward (what was refuted, so it doesn't
come back) is the Refuted section near the bottom. The memory docs win on any
conflict; nothing below relitigates a decided item.

## Decision queue for Mason

Every open ask in this doc, in one place. Each line points at the item that
carries the reasoning — deliberately no rationale here, so there is one copy to
keep true. None is blocked on a technical unknown.

1. **Ready to Assign as a move endpoint** — is a derived number a place money
   lives? (Budgeting ergonomics)
2. **Target-setting context** — show recent actual spend inside TargetSheet?
   (Budgeting ergonomics)
3. **Promote the teach queue as an onboarding surface** — the flashcard
   TeachSheet. ONE decision, referenced from both Harder 0 and Rapid teach mode.
4. **Month in review** — placement and tone of a completed-month summary.
   (Insights)
5. **Preparer package export** — one file or per-section files? (Tax)
6. **Rent roll** — do zero-income months get any visual emphasis? (Tax)
7. **Debt payoff plan persistence** — household (`settings`) or device
   (localStorage)? (Polish)
8. **Reconciliation's ACTION half** — what should a mismatch DO? (Harder 3; the
   CHECK shipped 2026-08-28)
9. **Taught-rules screen leftovers** — (a) a later "reclassify these rows
   without this rule" action; (b) whether `source` should always render.
   (Low-hanging fruit 7)
10. **Recurring Zelle deposits counted as income** — rent, or reimbursements
    that inflate income and Ready to Assign? Standing ruling in
    docs/memory/ship-record.md's Pending; surfaced 2026-08-17, unruled.
11. **The 2026-09-04 audit's eighteen Group-7 asks** — listed together in that
    backlog's "Needs a Mason ruling before code" paragraph rather than repeated
    here, since they arrived as one reviewed set and Mason deferred them as one.
    Two of them (the card-payment regex pair) are gated on re-running the PR #101
    vocabulary probe before any rule widens.

## Low-hanging fruit

1. ~~**The Pending data/ops tasks FIRST**~~ — **ALL FIVE RESOLVED** (last closed
   2026-08-12, the statement backfill). The resolutions survive as standing
   rulings in docs/memory/ship-record.md's Pending — payroll twins, same-day card dupes, the
   Discover 7933 twins' end state, the two-real-checking-accounts refutation,
   and backfill completeness — and those rulings GOVERN; this item is a pointer.
   Key rotation, the spend cap and NEWREZ closed earlier. Retraining is the only
   live data task.

2. **Receipt OCR v1** — *recommendation 2026-08-11 (Claude, not a Mason
   decision): DEFER until retraining settles — it competes for Mason's
   attention with teaching categories, and adds an LLM write path to an app
   whose current job is getting categories right.* Spec stays live.
   The upgrade path the memory docs already reserved: a new
   `api/receipt-ocr` route on the existing `ANTHROPIC_API_KEY`, reading the
   stored image (signed URL server-side or Storage download under
   service_role), returning merchant/date/amount/category suggestions,
   **confirm-before-write** in the transaction sheet — full-screen since PR #96,
   where `ReceiptSection` still renders (the confidently-wrong refusal applied
   to OCR). Plumbing exists end to end: `receipts` table, `ReceiptSection.jsx`,
   `getReceiptUrl`, `requireUser()`. No migration.

3. **Cash-flow forecast lite** — *recommendation 2026-08-11 (Claude, not a
   Mason decision): DEFER until retraining settles — a forward-looking number
   computed from a category set that is still mostly Uncategorized is wrong
   on arrival.* Session 6 built the hard part: `expected_transactions`
   carries cadence + due dates, `projectFutureCycles`/`rollForwardDate`
   (`src/expectedTx.js`) already project forward. Projected end-of-month
   balance = current depository balances − remaining expected outflows
   (+ expected income if typed). Keep it a pure core + one card on Home or on
   Trends (a Reflect report since the bottom-nav IA); it inherits the
   DISPLAY-ONLY contract — never touches Available, the walk, or any total.

4. **Bundle trimming** — *recommendation 2026-08-11 (Claude, not a Mason
   decision): DROP tab-level `React.lazy` — it overlaps the deliberately
   deferred Dashboard decomposition and every split module must thread the
   mock-alias needle, for a bundle win nobody has complained about.* Original
   item: main chunk ~584 kB when this was written. **Re-measured 2026-08-28 and
   the premise got WEAKER, not stronger**: `dist/assets/index-*.js` is ~339 kB,
   with React (~142 kB) and supabase-js (~215 kB) already split into their own
   vendor chunks — so the app code a tab-level split could defer is the
   smallest of the three pieces, and pdf.js (the genuinely large one, ~1.8 MB
   across its two chunks) is ALREADY lazy via `pdfExtract.js`, as are the
   modals. Re-derive with the placeholder-env build, then
   `ls -la dist/assets/*.js` — never quote a figure this doc froze. Next lever is tab-level
   `React.lazy` inside Dashboard.jsx (Tax/Debt/Trends render heavy pure
   cores). **Harness caveat:** any split-out module must keep importing
   through `dataAdapter.js` — the smoke harness aliases only the façade-level
   modules (see the dataAdapter façade key row in docs/memory/key-files.md; its fifth alias,
   `supabaseClient.js`, exists for App.jsx and is not a licence for
   components) — a module importing anywhere else either escapes the mocks or
   silently bypasses the façade while the gate stays green (same rule
   recorded for the decomposition, Harder 1).

5. ~~**Retire the Data coverage panel**~~ — **RESOLVED 2026-08-13: Mason ruled
   KEEP** ("i kinda like it"). Not a build item; revisit only if he asks. The
   removal recipe and the permanent/temporary split live in the `src/coverage.js`
   key row (docs/memory/key-files.md) and in git.

6. ~~**SQL/RLS tests**~~ — **FULLY SHIPPED 2026-08-11 (PR #73)**, executed and
   mutation-tested on a real Postgres 16. The harness, its recipe and its one
   known limit (it proves the migration's policy SQL, not that PROD applied it —
   `bootstrap_household.sql` stays the prod-side check) live in
   docs/memory/workflow.md's Local-checks recipe and the `test/` key row
   (docs/memory/key-files.md).

7. ~~**Learned-rules review screen ("Taught rules")**~~ — **SHIPPED 2026-08-04**,
   no migration. `RulesSheet` + `listCategoryRules` (rows with metadata, null
   pre-migration) + `countCategoryRuleMatches`; the count-vs-dry-run and
   delete-changes-nothing semantics live in the `ruleHistory.js` key row
   (the memory docs). **Still open for Mason** (Decision queue 9):
   - (a) a later "reclassify these rows without this rule" action;
   - (b) whether `source` should always render (today it renders only when >1
     distinct value exists).

8. ~~**Surface `coverage_shortfall`**~~ — **SHIPPED 2026-08-06 (PR #62), but NOT
   as specced.** The spec assumed the sync response was the source; it isn't
   usable as one (the key is absent on every steady-state pull). What shipped
   derives the same fact from the LEDGER — `feedCoverageGaps` in
   `src/coverage.js` — so it survives reload and self-clears when a backfill
   lands. All five rules, plus the two refuted alternatives (persisting on
   `simplefin_access`; recomputing the shortfall server-side), live in the
   `src/coverage.js` key row. `pullWasClean` still ignores `coverage_shortfall`
   and `test/csvImport.test.js` pins that.

## Harder, high value

0. ~~**USER-OWNED CATEGORY SYSTEM**~~ — **SHIPPED 2026-08-05** (Mason's
   decision, reversing the seed taxonomy). Migration
   `20260805000001_user_owned_categories.sql` applied and verified against PROD;
   the app ships no categories, nothing is guessed, and a learned rule is the
   only categorizer. Every rule lives in docs/memory/conventions.md (the no-shipped-categories
   Convention + the `categoryMap.js` / `categoryList.js` key rows); the
   preserve-then-wipe design and the two deliberate deviations (rules wiped too;
   pasted AFTER the deploy) are in the migration header and PR.
   **Retraining is the live task.** One decision was deliberately left
   unclaimed and still is: **promoting the teach queue from a cleanup aid into
   an onboarding surface** — the flashcard TeachSheet specced under Budgeting
   ergonomics. That is Decision-queue item 3, and it is the same decision in
   both places.

1. **Dashboard.jsx decomposition** — deferred by Mason 2026-08-01 and STILL
   deferred; the file keeps growing (`wc -l src/components/Dashboard.jsx` —
   deliberately not frozen here; a pinned count goes stale the day the next
   feature merges). The staged plan (carried out of the deleted 2026-08-01
   backlog): sheets and formatters first → a shared TxRow → the read-only tabs,
   every new module importing through dataAdapter.js so it stays inside the
   harness aliases. First big investment when feature pace slows; not before
   Mason says so. Worth noting the redesign PRs (#92–#111) established the
   pure-core-extraction habit — `nav.js`, `txList.js`, `txType.js`,
   `reflect.js`, `reconciliation.js` — without touching the JSX, so the plan's
   "formatters first" step is half-happening by accident.

2. ~~**Deriving RTA income (the income wall)**~~ — **SHIPPED 2026-08-13 as the
   HYBRID income rule**: a COMPLETED month reads actual measured income, the
   month IN PROGRESS and future months stay hand-typed, uncovered months fall
   back to manual. Rules in docs/memory/conventions.md's envelope Conventions. Consequence: Age
   of Money is now buildable as its own decision.

3. **Reconciliation** — spec open (Roadmap). **PARTLY SHIPPED 2026-08-28**:
   the balance-vs-ledger CHECK is built (`src/reconciliation.js`, the Accounts
   tab's "Does it add up?" panel) after Mason asked whether the monthly
   spending/income totals match the money in the linked accounts. That answers
   "do the totals add up", NOT this item's question — what to DO about a
   mismatch is still unspecified, so the item stays open as written below.
   **Extended 2026-08-29** with a gross money-out/money-in classification view
   and `nearMissTransfers` (unpaired transfer legs counting as spending AND
   income). That one NAMES rows but still takes no action on them, so the
   action half below is untouched.
   Half the build exists:
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

What field reports are actually useful, now that both phones run everything.
Screen names below are what the bottom nav shows (Home / Plan / Spending /
Accounts / Reflect); the internal `tab` values behind them are unchanged, so
"Home" and the old "Overview" are the same screen.

- **Two-phone behaviors**: sign-out on one device affecting the other (it
  must NOT — `scope:'local'`); saved chats and the recurring ignore list
  (settings-table-backed, read-merge-write serialized) and expected bills
  (their own table; concurrent auto-match dup-gated) appearing/updating on
  the second phone; any edit that shows on one device and not the other.
- **Touch feel**: the Home card-tile swipe (horizontal-intent threshold — and
  the tile now always names the card, so a WRONG name there is itself a bug),
  the month jump picker, sheet scrolling — say WHICH sheet, since the
  transaction sheet and the category picker are full-screen pages while
  MoveSheet/TargetSheet are partial overlays. Anything that feels wrong at
  390px is a bug report.
- **Teaching misses**: a learned rule is the only CATEGORIZER, so a merchant
  that stayed `Uncategorized` after being taught, or a taught rule that
  grabbed the wrong rows, is the classic report. Send the VERBATIM descriptor
  string — the "Bank text:" line in the transaction sheet, which renders only
  when it differs from the display name. `merchantKey` works off exact tokens,
  and the known over-specific-key limit lives in the memory docs.
- **Classification misses beyond teaching** — categorizing is no longer the
  only classification in the code, so these are their own report classes:
  a transfer or card payment that started counting as spending (the
  write-time guards); a credit-card refund that did NOT net against the
  category it came from; a 4-type override that didn't stick, or a row that
  needed one and wasn't offered it; a row that vanished from the Uncategorized
  count because its type became its category. The precedence of record is
  `src/spending.js` — don't re-derive it from a screen.
- **Recurring report (under Reflect) and its 40-month window**: false
  positives (one-offs listed), false negatives (a real weekly/annual sub
  missing), wrong cadence suffixes, price-creep flags on long-settled changes.
- **Any two on-screen numbers disagreeing** — the ONE-model unification's
  whole point is that Home, Plan, Spending and the Reflect reports agree by
  construction, so a disagreement is always a real bug, never rounding. One
  carve-out since refund netting (2026-08-17): a NEGATIVE category, envelope
  or month total is expected when refunds outweigh purchases — that is the
  model working, not two screens disagreeing.
- **Feed health**: the amber banner appearing, or any account >1 day stale —
  with the bank name (per-bank failures arrive inside an HTTP 200).

## Improvement backlog (synthesized 2026-08-13; five lenses, adversarially vetted against main)

> **Provenance and status.** Mason asked for "new ideas on how we can make this
> app better". Five lens agents (budgeting, insights, phone-UX, tax/rental,
> reliability) generated 36 ideas against a survey of the real code; curation
> cut them to 25 and an adversarial pass verified each against main plus this
> doc's refuted list. **Seven shipped the same day** (PRs #86 and #88).
> **Everything below is the unbuilt remainder**, ranked (deliberately not
> counted — the first item to ship would falsify the number).
>
> **Premise re-verified 2026-08-28** against main, item by item, across every
> live item in this doc — nothing had silently shipped, and the corrections the
> redesign PRs (#92–#111) forced are folded in below. That date is the
> verification baseline: a session building one of these need only re-check
> what changed AFTER it, not the whole premise.

Sizes are S/M/L. "Needs Mason" means a preference, a metaphor, or a migration
paste — never a technical unknown. Every one of those is also listed in the
Decision queue at the top.

### Protect what exists (do these first)

- **Household data export — the disaster-recovery floor** — M. Every byte of
  the ledger, the hand-taught `category_rules` the whole retraining effort is
  producing, the `dash:cats` registry, budgets and envelope history exist ONLY
  in prod Supabase. The app's only exports are the Ask-chat markdown and the
  per-property Schedule E CSV (`grep -n 'downloadCsv(' src/components/Dashboard.jsx`
  — a count frozen here would break the day this very item ships). A
  lost account or a bad write class is total, permanent loss; statement
  re-import rebuilds transactions only if the source files were kept. Build: a
  "Download household data" action over a new pure `src/exportBundle.js`
  (versioned JSON, node --test), fed by **new whole-table reads behind the
  façade** — the existing adapter reads are per-transaction/per-year and
  `getExpectedTransactions` RUNS AND PERSISTS the auto-match, so an export
  calling it would write. **Placement, precisely**: a FOURTH pill in the
  Accounts page-actions row (Add Account · Import Statement · Manage Bank
  Connections) — an export is an errand, like those three. Do not say "at the
  bottom of the Accounts tab": the pills are followed by the Feed reach, Data
  coverage and "Does it add up?" diagnostics cards, so the bottom of that tab
  is read-only panels. Include `balance_snapshots` (net-worth history is real
  recovery data) and a full settings read added to `db.js` (preserving the
  no-direct-`from('settings')` rule). Receipt IMAGES excluded in v1, stated in
  the bundle with a count (the honest-absence rule). Pin `simplefin_access` out
  of the table allowlist by test. Needs Mason only for the optional automated
  tier (a Vercel Cron writing the same bundle to a private bucket — needs a
  bucket migration).

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
  --audit-level=high` on main. The failure email IS the alarm. Give it
  `permissions: contents: read` from the first commit — it needs no write
  scope, and a new workflow is the cheapest place to start that habit. Two
  limits to state in the workflow header: GitHub disables cron workflows after
  60 days of repo inactivity (the dead-man's switch can itself die quietly),
  and the audit will NOT cover playwright, which CI installs at runtime with
  `npm install --no-save` and which is therefore absent from `package-lock.json`.

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
  recover from. Add the table to the zero-client-policies allowlist in
  `test/fixtures/rls_assert.sql`, like the `legacy_*` archives.

### Budgeting ergonomics (the YNAB muscle-memory gaps)

> Note (2026-08-16): distinct from the YNAB-style VISUAL redesign, which
> shipped separately (rules in the memory docs). These items are budgeting
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
  are managed on Plan but can only be BORN on the Recurring report — the code
  says so itself — and a genuinely new bill has never hit the ledger, so
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
  and date ±`EXPECTED_WINDOW_DAYS[cadence]`. Both constants are exported from
  `src/expectedTx.js` but NOT yet imported by Dashboard — the tolerance is
  currently a hardcoded `0.2*r.amount` at the picker — so this fix also
  de-duplicates that literal. Not the refuted cross-month category browse — no
  `.or()` over synthesised rows, and the results are ephemeral picker state.

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
  run LOW while merchants are untaught. Honest scoping note: TargetSheet is
  handed only the viewed month's row, and the walk range may not cover four
  months — so either widen the props/fetch (a real query/cache-key change,
  name it in the spec) or scope v1 to history within the walk range and say so
  in the sheet.

- **Rapid teach mode — a flashcard sheet that walks the whole queue** — M.
  **Needs Mason: this IS the "promote the queue as an onboarding surface"
  decision Harder 0 leaves deliberately unclaimed** (Decision queue 3).
  Teaching costs ~5 taps per merchant through the general-purpose transaction
  sheet — and that went UP by one on 2026-08-28, when PR #110 moved category
  picking onto its own full-screen page. A `TeachSheet` iterating the FULL
  `teachQueue.spending` list (merchant key → its rows → the raw descriptor →
  pick a category → the existing dry-run count and scope toggle → Always/Skip →
  auto-advance), with one `reloadData` at close and a local `taughtKeys` set
  meanwhile. Per-merchant seq guard on the dry run (the movers month-tagging
  lesson). **Reuse, don't rebuild:** the picking UI is now `CategoryPickerSheet`
  (grouped tiles + ＋New + a docked search), and the dry-run count, the scope
  toggle and Always/Just-this-one already exist verbatim in the transaction
  sheet — lift them rather than writing a third copy of category-picking. What
  is genuinely NEW here is only the wrapper: queue iteration, the raw
  descriptor in view, auto-advance, and `taughtKeys`. Queue rows keep opening
  the full sheet as the secondary path (rename/entity/receipts live there).

### Insights the backfill made possible

- **Month in review — a Home summary for completed months** — M. **Needs
  Mason (placement and tone).** *Premise corrected 2026-08-13 by audit: the
  Budget half of the original idea is ALREADY SHIPPED — Dashboard branches on
  an "actual" income source, suppresses the editor with a "would be a trap"
  comment, and already renders "actual · planned $X" and "spent $X of $Y
  targeted". Do not re-propose it.* What is genuinely missing is the HOME side:
  paging back to a finished month shows the same donut and recent-6 layout with
  no "so what". Build one display-only card, rendered only when viewed <
  current month, off a pure `src/monthReview.js`: total vs prior, biggest
  mover, largest purchase (max `isSpend` row, tapping opens the existing
  full-screen transaction sheet), and net saved — `netSaved` OMITTED when
  `coverageStart` says the month isn't ledger-covered (the `resolveBudgetIncome`
  fallback discipline). One cost to expect rather than assume away:
  `biggestMovers` rides an effect gated on the Trends/Reflect tabs, so a Home
  card widens that gate. Keep the two spend SCOPES verbally distinct
  (budgeted-envelope spent vs household spent) or the card contradicts
  Categories at a glance.

- **Year view: 12-month Trends + per-category year card** — M. Backfill is
  complete to ~Feb 2026 but every trend surface is hard-capped at 6 months
  (one `getCashFlow({num_periods:6})` call), so a year of clean data has no
  surface. Add a 6mo/12mo chip (the parameter already exists) and a "Year by
  category" card. Three things the 2026-08-13 vetting could not know: that same
  6-month fetch now ALSO feeds the Reflect hub's Income-vs-Spending card, so
  the chip mutates two surfaces off one cached value — decide where the chip
  lives and whether Reflect follows it; the Trends card title hard-codes
  "6-month spending" and must become dynamic; and `getTransactionsBetween` is
  MODULE-PRIVATE to `dataAdapter.js`, so this item includes one new façade
  export (it must stay behind the façade — the harness rule in item 4).
  **The category card must pair per CALENDAR MONTH** — call that read once per
  month, each served by slicing the wider memoized fetch — so each month's
  marks match the Categories tab by construction; the cash-flow toggle may keep
  `getCashFlow`'s whole-window pairing, which is Trends' existing documented
  behavior. Months before the household's earliest visible row render "no
  data", never $0 (reuse `getActualIncome`'s earliest-row probe). Lazy-load on
  the toggle.

- **Merchant insights: top-merchants card + "history at this merchant"** — M.
  The app has no merchant-level view anywhere — `merchantKey` is used for
  teaching and (in `expectedTx.js`) as a bill-matching signal, never for
  aggregation — so "how much do we spend at Costco?" is unanswerable. New pure
  `src/merchantStats.js` folding `isSpend()` rows by display name collapsed
  through `merchantKey`, a `getMerchantStats({months:6})` riding the same range
  memo as `getCashFlow`, a Trends card, and one line in the transaction sheet.
  Tap through to the existing search with the name pre-filled (reusing search,
  not the refuted cross-month category browse) — and set `searchOpen` too, not
  just the query. The panel's own `searchActive` arm means results won't be
  stranded off-screen, but without `searchOpen` the magnifier renders closed
  and unlit, the account/category chip rows stay hidden, and the first tap on
  the magnifier re-opens the panel instead of clearing the search. Label the
  card "grouped by name" — the deliberate no-stemming rule keeps "COSTCO GAS"
  and "COSTCO WHSE" separate.

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
  amber must keep meaning "needs fixing". Two premise corrections from the
  2026-08-28 re-audit, both cheap but not free: `entityMonthly` is **sparse**
  (it skips months with no rows), so the strip must project the 12 calendar
  months and left-join, or a vacant month silently shifts the columns — which
  is exactly the question the strip exists to answer; and it classifies purely
  by stored SIGN, never `user_type`, so a returned-income row (money out typed
  Income) lands in its expenses column while the rest of the app counts it as
  reduced income. Either label the strip raw-cash and mean it, or route it
  through the type model — which is no longer "zero new computation".
  Needs Mason only on whether zero-income months get any emphasis at all.

- **Repeat-drive chips — one-tap mileage logging** — S. Rental drives repeat but
  every entry retypes miles and purpose with no frequency memory (the date
  already defaults to today and the entity to the first active property), and
  a thin log is a real lost deduction. Derive the 3–4 most frequent (purpose,
  entity, miles) combos from the already-loaded `mileage` state (pure
  `frequentDrives`, ≥2 occurrences or render nothing) and render them as
  chips. **The chip PREFILLS the form with Save as the confirming second tap
  — never an immediate write**: the date is the one field the chip's label
  doesn't assert, and the rate is date-dependent (2026 splits mid-year), so a
  wrong-dated drive is a wrong entry on a preparer-facing deduction log. The
  existing Save button already refuses a dateless or zero-mile drive, so a
  prefill lands in a form that cannot silently write garbage.

### Polish

- **Touch-first rename and color affordances** — S. The two edits retraining
  leans on are desktop-shaped on a phone-first app: `EditName` commits via
  `onDoubleClick` with a title tooltip (invisible on touch) and `Swatch` is a
  14px target adjacent to `DrillNum` taps. Wrap the swatch in a padded hit area
  (the visual stays truthful — it must show the stored hex), give `EditName` a
  coarse-pointer path via `matchMedia('(pointer: coarse)')`, and swap the hint
  wording per pointer type. **Scope, re-verified 2026-08-28:** there are FIVE
  `EditName` sites — Categories rows, Categories group headers, the account
  page header, the Tax tab's property list, and the transaction sheet's Payee —
  and only two carry any hint at all (the Categories footer and the Payee
  line). The account page header is the newest and least discoverable: PR #109
  moved rename + Swatch there off the account tile and deleted the Accounts
  tab's own hint footer in the same change. Two further Swatch-only sites (the
  Budget tab's envelope rows and group headings) have no rename and no hint. A
  fix that patches only Categories leaves four surfaces behind. Re-screenshot
  at 390px: category rows are dense.

- **Load-more past the account page's 500-row wall** — S.
  `getAccountTransactions` caps at 500 and the account page renders a dead end
  ("Showing the most recent 500 transactions") with `acctHasMore` true and
  nothing to tap — and post-backfill the shared checking carries the whole
  history. (Written when this was a sheet; PR #109 made it a page reached from
  a tile, with a `‹` back button. The cap and the query are unchanged.) Give it
  offset paging on the `searchTransactions` pattern: ordered `.range` with
  **date desc + id desc tiebreak** — the current query orders by date ONLY, so
  a page boundary inside a same-dated run drops or repeats a row — and the
  exact-page-multiple 416 read as end-of-data. The tiebreak matters more since
  #109: the page day-groups through `groupByDay`, which preserves caller order
  by contract, so a boundary defect now corrupts a visible day section rather
  than just the tail of a flat list.

- **Persist the Debt tab's payoff plan** — S. **Needs Mason (household vs
  device storage — the same open choice family as the coverage-gap ack).**
  `debtStrategy`/`debtExtra`/`debtInclude` are plain `useState`, so every
  launch re-opts loans into the payoff, retypes the extra, and re-picks the
  strategy. One settings key through `makeSerializedUpdater` (never a third
  hand-rolled copy), tolerant parse, loaded by appending one key to the
  existing `getStartupSettings` batch; stale account ids ignored harmlessly —
  the localStorage device-pref precedent is now two instances, `mm:cardTile`
  and `mm:acctCollapsed`.

### Added by the 2026-08-28 re-audit

Found while re-verifying the items above; each is small, evidenced, and needs
nothing from Mason.

- **The render gate never enters the account page, and two panels render for
  nobody** — S. CI's smoke walk clicks every `data-mm-*` hook in the app, and
  PR #110 correctly added four when it built the category picker page. Two gaps
  remain. (1) The account page — the whole per-account view PR #109 built,
  including the rename/Swatch header it moved there — is reached only by
  tapping an account tile, and the tile carries no hook, so nothing in CI ever
  renders it. Add a hook to the tile plus two uncounted walk steps (open, then
  the `‹` back button). (2) The Data coverage and "Does it add up?" cards are
  collapsed by default with no hook, so their expanded bodies render for
  nobody — and the reconciliation panel's mock data already exists in
  `test/smoke/mocks/dataAdapter.js`, written but never fetched during the walk.
  This is the `searchOpen` lesson (collapsed-by-default JSX renders for nobody
  in CI) applied to three more surfaces; the magnifier's own walk step is the
  precedent to copy.

- **CI hardening: token scope, plus a warning on the two check names** — S.
  `.github/workflows/ci.yml` declares no `permissions:` block, so both jobs
  inherit the repository default `GITHUB_TOKEN` scope while neither needs any
  write access (one runs tests and a build, the other boots a local vite
  server). Add `permissions: contents: read` at workflow level. Separately, the
  two job `name:` values — "tests + build" and "render check" — are the exact
  strings the branch ruleset requires, so renaming either silently disarms the
  merge gate with no local tell; put a comment beside each saying so. Optional
  consistency note: the workflow pins its playwright driver exactly and
  explains why, while the three `actions/*` uses float on major tags — the same
  argument would SHA-pin them, but that is housekeeping, not a new risk.

- ~~**Pin the Node version the gate actually uses**~~ — **SHIPPED 2026-08-31**
  with the Vite upgrade, which turned a stylistic pin into a real floor: Vite 8
  requires `^20.19.0 || >=22.12.0`, so the `">=22"` this item proposed would
  have been WRONG — it admits 22.0–22.11, which Vite 8 refuses. `package.json`
  now declares Vite's own range, so a contributor on an older Node fails
  loudly instead of diverging from the gate.
- **Doc rot inside the CI harness** — S. `ci.yml`'s comments and
  `test/smoke/render.mjs`'s header still describe Dashboard.jsx as a "~5,000
  line" component (it is thousands of lines past that) and still call the
  navigation a "tab bar", though the assertion has read the bottom nav since
  PR #94. And `render.mjs`'s 600ms settle is justified by a comment about lazy
  views (trends/recurring/debt/tax) that are not lazy — the wait is fine, its
  stated reason is fiction, and a future reader could conclude tab-level
  splitting already shipped (see item 4, which recommends against it).

### Added by the 2026-08-30 dependency pass — SHIPPED 2026-08-31

- ~~**vite 5 → 8 (and `@vitejs/plugin-react` 4 → 6)**~~ — **SHIPPED 2026-08-31**
  as a deliberate upgrade rather than the bot merge it arrived as; PR #117 is
  superseded. The advisory it clears is dev-server-only (a page visited while
  the dev server runs could read its responses; nothing in production runs
  one), which is why this was never urgent — but the upgrade was worth taking
  on its own terms rather than carrying an indefinite ignore.

  Two things the original framing did not anticipate, both now recorded as
  durable rules: Vite 6 had moved the default build target, so the jump
  silently raised the app's iOS floor from 14 to 16 until `vite.config.js`
  pinned it back (docs/memory/gotchas.md's browser-floor Gotcha — the finding that
  outlives this item); and Vite 8 ships Rolldown instead of Rollup, which made
  "the vendor chunk split still exists in the output" something to verify
  rather than assume. What the original framing got right: CI would have caught
  a hard break, so this was a scope call, not a risk call.

## Improvement backlog (2026-09-04 audit; Mason picked the bug fixes 2026-09-08)

> **Provenance and status.** Mason asked for "creative ways to make improvements
> to this app. Anything from easier to use UI, better features users would enjoy,
> or fixing bugs". Thirteen lens agents (per-screen UX, bug hunts over the pure
> cores / Dashboard state / the data layer, PWA resilience, product delight,
> first-run states) read the code and returned 112 findings against a
> re-verification of the 2026-08-13 backlog above; curation merged them to 52
> ranked items and cut 47. Adversarial verification is **PARTIAL** — a session
> limit killed 12 of 13 verifier batches. The one batch that ran CONFIRMED all
> four of its items at high confidence (they are marked VERIFIED below). Every
> other item carries file:line evidence but was not independently re-checked, so
> **the builder re-reads the cited code first and drops anything whose premise
> does not hold.** The audit run is `wf_968f56ab-407`.
>
> **Mason reviewed all 52 on an interactive checklist and ruled 2026-09-08: "I
> kept all the bug fixes. The rest can be addressed at another time."** The
> ticked 25 are the Building-now list; everything else is DEFERRED, not refuted
> — it is here so a future audit re-finds it as known work rather than as a new
> discovery. Only ticked items get built (Mason: "only move forward with
> implementing the items checked off").

Sizes S/M/L, same convention as the 2026-08-13 backlog. Dollar figures in the
descriptions are invented illustrations, never household numbers (public repo).

### Building now — ticked 2026-09-08, three PRs

> **ALL THREE WAVES SHIPPED 2026-09-08** — Wave A as PR #128, its review
> findings as #129, Wave B as #130, Wave C as the PR carrying this note. The
> item texts below are kept as the record of what was wrong and why, since
> every one of them is a failure shape worth recognising again; nothing here is
> unbuilt work any more. What each wave actually changed lives in its PR body
> and in the code comments the fixes carry.
>
> Four things the build learned that the audit could not:
> - **`envelopeBar`'s fix had to be NARROWED.** Two older tests pin that a ZERO
>   pot stays "no envelope" however much was spent against it, and they are
>   right: painting an unbudgetable category's spending as an overspend reports
>   the classifier's ignorance as a budgeting failure. Only a NEGATIVE pot is a
>   hole. Those tests going red is what caught the over-wide first draft.
> - **Two more mock/façade drifts surfaced** (`getBiggestMovers` missing its new
>   field, `getExistingTxIds` returning a bare Set where the real one returns
>   `{ids, sources}` — the latter crashed the whole app into the ErrorBoundary
>   inside the harness, which is why the overlap path had never been rendered).
>   `test/smokeMocks.test.js` asserts every needed export EXISTS but nothing
>   about the SHAPE it returns; closing that gap is unbuilt work, recorded here.
> - **The render gate earned its keep again.** The Wave C sheet re-resolve
>   assumed `transactions` was an array; it is a result object that starts null.
>   `npm test` and `vite build` both passed on that TypeError. Only the browser
>   walk failed it.
> - **The empty merchant key** (`merchantKey` drops numeric tokens, so `1234`
>   keys to `''`) could match two unrelated rows on `'' === ''`. Pre-existing,
>   doubled in exposure by Wave A's two-descriptor widening, closed in #129.

**Wave A — money and date bugs (pure cores first; each lands with a test that
was red before the fix).**

1. **`detectRecurring` ignores `counted`/`excluded`** — S. A row the household
   marked excluded, and a linked loan's own ledger postings, still become
   subscriptions, inflate the "/mo" headline, and can be seeded as Upcoming
   bills; the Ask tab's copy of the detector already omits them, so two Reflect
   surfaces disagree. The same function still falls back to a retired taxonomy
   name. Fix in the pure core so both callers inherit it; fallback becomes
   `UNCATEGORIZED`. `src/recurring.js:119-129,191-193`.
2. **`matchExpected` reads the raw bank payee, never the household's rename** —
   S. Rename a merchant, tap Expect on it, and the bill never auto-matches: it
   goes overdue and then "missed?" every cycle. Test BOTH descriptors the row
   carries (the `applyRuleToHistory` pattern). `src/expectedTx.js:58-60,90-91`.
3. **Trends month bars parse `YYYY-MM-01` through `new Date()`** — S. Date-only
   ISO parses as UTC midnight, so west of UTC the highlight sits on the wrong
   bar and tapping one opens the previous month. Derive year/month from the
   string as `shortDate` does; pin the derivation under a non-UTC `TZ`.
   `src/components/Dashboard.jsx:6622-6662`.
4. **QuickAddSheet defaults to the UTC day** — S. An evening cash entry is dated
   tomorrow (next month on the 31st), lands outside the viewed month and reads
   as "it didn't save". Add a local-today helper beside `shortDate`; CsvImport's
   UTC `todayIso` is deliberate and stays. `src/components/Dashboard.jsx:727-728`.
5. **The assistant's clock is UTC while every screen is local** — S. For the last
   hours of each month the Ask tab answers about the next month, contradicting
   the screen. Client passes its local day; the server validates it (strict
   regex, year floor, within ±2 days of UTC now) and derives the window and the
   envelope month from it, keeping the determinism contract.
   `api/_lib/spendingContext.js:149-151,185-195`, `api/assistant.js:108-120`.
6. **Biggest movers compares this month SO FAR against last month IN FULL** — S.
   Early in the month every category reads as a fall; the Home tile fixed this
   with same-day slicing and Trends did not. One shared slicer, and a sub-line
   that says which comparison is being drawn. `src/spending.js:264-287,332-360`.
7. **`envelopeBar` renders "—" when a carried-in overspend exceeds this month's
   assignment** — S. The same glyph an unbudgeted category gets, right after the
   user assigned money. Treat a non-positive pot with an assignment as "in the
   hole" and let the callers' existing over-colouring paint it.
   `src/envelopes.js:114-128`.
8. **Debt "Total owed over time" folds a 365-day-windowed snapshot fetch** — S.
   A hand-tracked loan nobody edits drops out of every point after a year while
   the headline above it still counts the balance — two numbers disagreeing on
   one screen. Fetch unwindowed and clamp through the existing `clampSeries`.
   `src/components/Dashboard.jsx:2572-2648`, `src/dataAdapter.js:562-575`.
9. **Negative utilization on a card in credit** — S. After a refund on a paid-off
   card the row prints a negative percentage and a negative bar width. A pure
   `utilization(balance, limit)` returning null / 0 / ratio, and "nothing owed"
   copy. `src/components/Dashboard.jsx:6217-6241`.
10. **"vs minimums only" prints "$0 saved · same timeline" when the baseline
    stalls** — S. When a typed minimum is below the monthly interest, minimums
    alone never pay the card off and the extra is the only reason a payoff date
    exists; the tile says the opposite. Render the `baselineStalled` the core
    already returns. `src/debtPayoff.js:207-218`, `Dashboard.jsx:6367-6376`.
11. **"vs last month" compares the first covered month against a $0 that means
    "no data"** — S. The first month after a backfill start reads as a large
    over-spend in the over-money ink. Treat the base as unknown when the prior
    month precedes `coverageStart` so the existing null branches render "—".
    `Dashboard.jsx:3417-3426`, `src/dataAdapter.js:308-337`.
12. **Home's card-balance tile prints "$0 · Linked account" on any non-current
    month** — S, and worse after a rollover: `reloadData` closes over a `now`
    frozen at mount, so the real new month gets the same until a relaunch. Take
    a fresh date inside the load, and render "—" rather than a fabricated
    balance when no account resolves. `Dashboard.jsx:2339-2362,3403-3410`.

**Wave B — statement import.**

13. **Single-Amount CSVs get no sign control** — S, **VERIFIED**. The batch guard
    tests `columns.debit == null` but the header mapper returns `-1` for an
    absent role, so a `Date,Description,Amount` card export (positive = charge)
    imports with every sign inverted and no toggle is ever shown; the
    single-file preview shows the inversion but offers nothing to flip it. A
    wrong-signed row hashes differently and can never be deduped away, which is
    what makes this the worst item in the wave. Pure
    `hasSingleAmountColumn(columns)` (`amount >= 0 && debit < 0 && credit < 0`),
    probe every file in a batch, and render the same sign select above the
    single-file preview with a concrete first-row example.
    `src/components/CsvImport.jsx:468-477,1137-1139`, `src/csvImport.js:140-164`.
14. **A manual account holding one quick-add row is permanently blocked from
    statement import** — S, **VERIFIED**. The mixed-source gate counts
    `'manual'` as a format conflict, so one hand-typed cash purchase disables
    Import forever, with a message that is false in both of its branches. A pure
    ALLOWLIST helper: `'manual'` never conflicts (uuid ids dedup against
    nothing); the legacy `'plaid'` default and unknown sources still do.
    `src/components/CsvImport.jsx:398-401,631-634,1052-1061`.
15. **Hand-adjusted PDF columns are discarded when the account is picked
    afterwards** — S, **VERIFIED**. The layout editor sits above the account
    picker, so the natural order loses the fix silently, and the auto layout is
    then saved as that account's template for every later statement. A pure
    `resolveTemplateForTarget({saved, auto, current, edited})` plus an edited
    flag reset per file. Keep the effect's original rationale: switching to an
    account with no saved template must still drop the PREVIOUS account's
    layout; offer, don't silently apply, when edits and a saved template collide.
    `src/components/CsvImport.jsx:568-590,674-676`.
16. **`parseDate` rejects ISO datetimes** — S. An export whose date column
    carries a time imports zero rows and no control changes the outcome. Accept
    a date followed by `T` or a space, keep the day (the dedup hash already uses
    the day, so ids stay stable). M/D/Y stays strict — no D/M/Y guessing.
    `src/csvImport.js:215-236`.
17. **Batch failures and skipped rows dead-end** — S. "Import this file on its
    own" means leaving the modal and re-finding the file; the boundary-error box
    says "close and retry" with no retry; skipped rows show three names and an
    ellipsis, so a real purchase with an odd date is indistinguishable from a
    memo line; and overlap rows are struck through with no label saying the feed
    already has them. `src/components/CsvImport.jsx:843-891,1260-1289,1641-1686`.

**Wave C — state that does not refresh or save as it looks (plus two ticked
Group-5 bugs).**

18. **`togglePace` persists the whole `env:pace` map from local state** — S. The
    other phone's opt-ins vanish on the first tap — the exact class the
    `rec:ignore` fix closed. Route it through `makeSerializedUpdater` and adopt
    the merged map. `Dashboard.jsx:4066-4071`, `src/adapters/envelopeIO.js:193-197`.
19. **`EditName` commits on every blur/Enter even when unchanged** — S. On the
    account page that stores the derived label, mask and all, as the nickname,
    which then cannot be cleared by any UI action; on the payee line it stores
    the bank's own text as a user override. `Dashboard.jsx:481-499,5916,7451-7457`.
20. **The account page is a frozen snapshot** — S. Refresh, the startup sync's
    follow-up, a foreground return and the other phone's writes all leave its
    balance, "as of" and transaction list stale until the page is closed and
    reopened, so it disagrees with the tile behind it. Derive the account from
    the id at render and refetch open lists. `Dashboard.jsx:2757-2766,5927-5952`.
21. **Every account edit refetches the whole 500-row list** — S, and the colour
    picker writes on every drag step while the feed-gap scan re-runs on each
    optimistic patch. Key the effects on ids and commit the swatch on close.
    `Dashboard.jsx:463-478,2796-2800,1827-1834`.
22. **Recurring and Debt still use the null-sentinel cache** — S. A reload landing
    during their first fetch caches a pre-sync snapshot (the documented
    invalidation gotcha); copy the Tax tab's epoch block.
    `Dashboard.jsx:2518-2530,2566-2583`.
23. **`selTx` is a snapshot: after teaching, the sheet's Reset link lies** — S. It
    still offers "back to Uncategorized" and tapping it leaves the sheet and the
    list showing different categories until reopened. Re-resolve the selected
    row by id on reload. `Dashboard.jsx:2384,7513-7524`.
24. **Day-one Plan tab hides its own "start here" hint** — S. The hint is gated on
    "no envelope rows", which is never true once Uncategorized has spending, so
    a household on day one sees a collapsed `Ungrouped · 0 categories · $0`
    heading over a full month of uncategorized spending and no guidance. Gate on
    the budgetable rows instead, and let a zero-count section render its note.
    `Dashboard.jsx:3690-3691,3907-3909,5052-5056`.
25. **The income editor cannot be cancelled on a phone** — S. There is no blur
    commit and no Cancel, and iOS has no Escape, so the only exits are a write
    or an empty commit that deletes the month's override. Mirror `AssignEdit`.
    `Dashboard.jsx:563-580`.

### Deferred by Mason 2026-09-08 — "the rest can be addressed at another time"

Not refuted and not cut: reviewed, understood, and postponed. Each carries its
evidence so a later session can build it without re-deriving the premise.

**Reliability and data-integrity (the rest of Wave C's original group).**
Teaching on a flaky connection reports a saved rule as unsaved and leaves the
taught-rules list stale (`Dashboard.jsx:3037-3059`); `setCategoryRule` deletes
the old rule before inserting the new one, so a failed insert leaves the
merchant with NO rule (`src/dataAdapter.js:660-694` — an update-first rewrite
also changes the recorded delete-then-insert rule in
docs/memory/conventions.md, same PR); two paged reads have no ORDER BY, so a
re-import can show stored rows as new (`src/dataAdapter.js:1416-1443,1479-1492`,
plus a `pagedGuards` extension); `category_rules` is read unpaged on both sides
of the wire and the assistant's and mileage caps exceed PostgREST's default, so
past ~1,000 taught rules the classifier silently stops seeing some of them
(`src/dataAdapter.js:521-524,624-652,717-755`, `api/sync.js:90-110`); the
expected-bill auto-match updates by id alone, so a stale pass can resurrect a
bill the other phone just stopped or mint a twin
(`src/dataAdapter.js:2030-2047,2108-2123`); and a crash after `api/sync.js`
inserts a first-sight bank's accounts strands that bank's history, because the
watermark is neither advanced nor reset (`api/sync.js:479-487,571-630`).

**Phone-shell resilience.** A stale chunk after a deploy turns Import or Manage
Bank Connections into the full-screen error card (`src/main.jsx:20-24`,
`Dashboard.jsx:31-35,7811-7836`); a resident PWA runs yesterday's bundle with no
update signal (`public/sw.js:29-47`); an offline launch waits on the OS fetch
timeout before serving the cached shell (`public/sw.js:92-105` — keep the
`fresh.ok` line verbatim, the lockstep test matches it, and bump
`CACHE_VERSION`); a foreground return after hours away never re-pulls the feed
or re-checks feed health (`Dashboard.jsx:1984,2452-2479`, **VERIFIED**, and the
hour-gated case must not paint the sync-failure banner); the load-failure banner
blames a local cache the app has not had since Dexie was removed, and a failed
cash-flow read renders as "not enough measured income" rather than an error
(`Dashboard.jsx:2407-2411,2488-2490,4224,4446-4451`); the sign-in bounce says
nothing about why (`src/App.jsx:104-113`, `src/components/Login.jsx:14-21`);
sub-16px inputs trigger Safari's focus zoom on roughly fourteen inputs (one
`@media (pointer: coarse)` rule in `src/ui.css`, then re-screenshot the filter,
add-debt and mileage rows, which will reflow); and every pre-Dashboard screen
overflows by the safe-area insets.

**Teaching and Plan ergonomics.** "Show all" when the Review filter empties the
list; a Recent row in the category picker; the taught-rules screen's copy still
promising "the app's own guess"; overspent/needs chips on collapsed Plan group
headings; a warning before Fund-targets writes past Ready to Assign; a tappable
"needs $X" that funds one envelope; MoveSheet's All chip, per-destination
balances and overspend-first ordering; Home's bills line split into overdue and
upcoming with names and a tap; a tappable Home donut; the Trends cash-flow
card's pre-unification wording; debt due-date roll-forward, the missing-APR
notice and a route from a loan's account page to its terms; the two screens
claiming the Checking/Savings split drives spending totals (it drives labels —
the Bank/Credit/Loan choice is what moves the three numbers); the hidden-accounts
cue explaining that a new account must be opened, type-checked and unhidden;
Sign out on the first-run screen; the account-chip search that reports "no
matches" above a Load-more button; and the tax tab's hand-typed mileage
footnote naming the wrong year.

**Features (Group 6).** Recurring rows tapping through to their charges; recent
searches and search-this-merchant; Ask-about-this entry points and data-derived
prompt chips; the assistant's blind spots (properties, expected bills) and its
90-day subscription window; a day heatmap over the Spending list; progress
deltas on the Debt and Net-worth cards; a moved-to-savings line off the existing
pairing; receipt glyphs and a With-receipt filter; per-account CSV column memory;
quick-add merchant memory; PDF near-miss reporting and per-file batch totals;
correcting a taught rule from the taught-rules screen; the trim-the-key preview
naming the merchants a shorter key would swallow; subscription price-hike
detection (a large hike currently makes the sub vanish for months); naming the
broken bank on its tile; and category colour dots in place of the retired
taxonomy's emoji on Home rows.

**Needs a Mason ruling before code (Group 7).** The two card-payment regex
findings — a loan payment worded like a card payment being vetoed out of
spending, and a transfer-worded card credit netting as a refund when its payer
leg is hidden — both gated on re-running the PR #101 vocabulary probe first, per
the standing ruling in docs/memory/ship-record.md. Whether "Always" should
release the taught row's hand pin. What a by-date target does after its date
passes. The monthly-target wording versus a real refill kind. Whether the
Income-vs-Spending verdict drops the half-finished month. The cold-start
count-error screen (a decision the refuted list already reserves for Mason).
Manual bank balances (today ignored by rule). Per-month scoping for the
reconciliation panel. The month-end bill drift (needs an anchor-day column).
The two-phone envelope write race (record as accepted, or add a database
function). An undo-this-import delete path against the soft-hide ruling. Peeling
one layer on the iOS back-swipe. Pull-to-refresh. The tax year default during
filing season. Home's cash and Ready-to-Assign tiles. A since-you-last-looked
changelog and a needs-a-look flag pair for two-phone coordination.

**First-run and empty states.** Uncovered months rendering confident $0s across
Home, Categories and Trends; the SimpleFIN success screen repeating the retired
subtype rule; the Plan income prompt talking about "the month in progress" on a
month that ended before coverage; and a second smoke-walk pass over the empty,
all-hidden and post-wipe states, whose mock knobs already exist and are consumed
by nothing.

### Cut by the curator before Mason saw the list

Kept so a future audit recognizes them rather than re-finding them as new:
Reflect's month-scoped breakdown against a hub with no month control; a cash-on-hand
tile and balance staleness; Home's budget silence; the Plan heading's dead-tap
available; MoveSheet destination signals; the two S-sized cuts of Rapid teach
mode (queue rows opening straight into the picker, and a Next-merchant note);
the trim-the-key merchant preview; correcting a rule from RulesSheet; the
back-swipe peel; debt due dates and dead-end debt account pages; per-bank feed
failure naming; imported checking accounts showing $0.00 with no way to type a
balance; PDF near-misses; per-account CSV maps; batch reopen and skipped-row
disclosure; quick-add memory; undo-this-import; the sw.js offline timeout;
safe-area insets; keyboard inset for docked inputs; pull-to-refresh; the Login
reason; the assistant's subscription window; the mileage footnote; and the
Group-6 features. Several were later ticked or deferred above; where an item
appears in both places, the Mason ruling governs.

### Corrections to the 2026-08-13 backlog above (re-verified 2026-09-04)

All 41 unbuilt items in this doc plus the deferred list in
docs/memory/ship-record.md were re-checked against main. **Nothing had silently
shipped.** Six premises moved and are corrected here rather than in place, so
the items keep their original text and its reasoning:

- **Cover overspending** — since PR #125 every leaf row sits behind a collapsed
  group heading, and the heading itself renders the rollup red with only a
  drill-in. The item should also decide what a red HEADING offers, since that is
  the red the user sees at rest.
- **Scheduled health workflow** — its line about being "the cheapest place to
  start" the permissions habit is moot: `claude.yml` and `dependabot-review.yml`
  both declare `permissions:`, and `ci.yml` is now the only workflow without one.
- **Persist the Debt payoff plan** — the localStorage device-pref precedent is
  now three keys, not two (`mm:planOpen` joined it in #125).
- **The render-gate gap** — half shipped: PR #113 added the reconciliation
  panel's hook and walk step. Still open: the account tile, its back button, and
  the Data coverage card.
- **Uncleared/pending banner** — `transactions.pending` exists end to end but the
  pull is posted-only by design, so the item is moot unless
  `SIMPLEFIN_INCLUDE_PENDING` is turned on; that is the decision, not the banner.
- **Memo field** — SimpleFIN's memo is normalized but never upserted, so a memo
  means either a new user-typed column or persisting the feed's.

## Refuted / decided — do NOT re-propose

Carried out of the deleted 2026-08-04 audit backlog plus later verification
passes. These are the ones a future audit would otherwise raise again.

- **"Android back closes the app"** — refuted as stated: the household is
  iPhone-only. Survives only as the iOS back-swipe sheet dismissal (shipped).
- **"Fonts blocked behind the JS parse"** — overstated: Vite emits the CSS as
  its own `<link>`, so fonts wait on CSS, not JS. Preload shipped anyway.
- **"RLS entirely untested"** — policy COVERAGE was hand-verified complete
  across all migrations; no missing policy exists. The opt-in harness shipped
  (Low-hanging fruit 6).
- **"The 2-char search gate is a decided rule"** — refuted: it was pre-existing
  activation behavior, never a recorded decision.
- **Assert the count-query ERROR path in the smoke harness** — killed in
  verification 2026-08-12 and still killed: asserting it means CHOOSING
  user-facing behavior for a cold-start count failure, which is Mason's call,
  not a test's. The narrower re-scope — the fifth `supabaseClient.js` alias and
  a real-App healthy-startup render — SHIPPED (PR #78); only the error-path
  half stays killed.
- **`paths-ignore` on `docs/**` so doc-only PRs skip CI** — refuted 2026-08-28.
  Both CI jobs are ruleset-REQUIRED checks, and a skipped required check
  reports as pending, never as passing: doc-only PRs would sit unmergeable and
  the armed-auto-merge flow would stall. This bites often, because the
  maintenance contract makes docs churn on nearly every feature PR. If CI cost
  ever justifies it, the only correct shape is a same-named no-op job on the
  filtered path — not a path filter alone.
- Anything relitigating the sign conventions, the unified linked-boundary
  model, hidden-by-default accounts, theme tokens, or the envelope walk was
  screened out against the memory docs' decided lists.

**Mason's 2026-08-04 decisions** (all executed; recorded here because the doc
that held them is gone): month-navigation caching **yes** (shipped); **no**
durable assistant throttle — the Anthropic spend cap is the control, and it is
set; the dataAdapter split got **its own quiet session** (shipped).

## Ship record

Pointers only. Every rule these shipped lives in the memory docs; every detail lives
in git and the named PRs.

- **Subcategories, one level (2026-08-05, Mason)** — totals at both the parent
  and the leaf, with no migration and no schema change: transactions still
  store one label (the leaf) and the parent link is a `dash:cats` field. Pure
  core `src/categoryTree.js`; rules in docs/memory/conventions.md's Category-nesting Convention,
  including the sort-by-the-number-you-render lesson and the deliberate
  non-decision (parent-level BUDGETING is a separate Mason call — don't
  propose it as a bug).
- **The sixteen-item self-serve backlog (synthesized 2026-08-11, ALL SHIPPED
  2026-08-12)** — three build waves plus an adversarial review, with two review
  catches fixed before merge. Recorded in docs/memory/ship-record.md's Merged features (PR #76);
  its one killed item is preserved in the Refuted section above. The
  identifiers those item texts named (e.g. the retired `FEED_LOOKBACK_DAYS`)
  were historical descriptions of fixed hazards, not live references.
