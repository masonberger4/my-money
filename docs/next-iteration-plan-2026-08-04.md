# Next-iteration plan — 2026-08-04 (findings + feedback guide)

> **Contract for AI sessions:** items here are live specs — the PR that ships
> (or supersedes) an item marks it shipped/refuted in that same PR, noting what
> shipped instead when the design diverged; an unmarked shipped item is a bug.
> When every item is resolved this doc is DELETED per the maintenance
> contract (docs/memory/maintenance-contract.md). The memory docs are authoritative wherever the two disagree.

**Where the live work is:** the **Improvement backlog (2026-08-13)** section is
the current unbuilt list. Items 2/3/4 under Low-hanging fruit and 1/3/4/5 under
Harder are the older live specs. Everything struck through is a POINTER to a
shipped thing, not work — git and the named PRs hold the detail.

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
11. **vite 5 → 8** — accept a dev-server-only esbuild advisory, or schedule
    the three-major toolchain upgrade as its own task? (2026-08-30 dependency
    pass; PR #117 left open)

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

- **Pin the Node version the gate actually uses** — S. `package.json` declares
  no `engines` and there is no `.nvmrc`; Node 22 is asserted only inside CI.
  `npm test` is `node --test` over a glob, whose semantics have moved across
  Node majors, so a contributor or a sandbox on an older Node can get a
  different verdict than the gate gives. Add `"engines": {"node": ">=22"}`.

- **Doc rot inside the CI harness** — S. `ci.yml`'s comments and
  `test/smoke/render.mjs`'s header still describe Dashboard.jsx as a "~5,000
  line" component (it is thousands of lines past that) and still call the
  navigation a "tab bar", though the assertion has read the bottom nav since
  PR #94. And `render.mjs`'s 600ms settle is justified by a comment about lazy
  views (trends/recurring/debt/tax) that are not lazy — the wait is fine, its
  stated reason is fiction, and a future reader could conclude tab-level
  splitting already shipped (see item 4, which recommends against it).

### Added by the 2026-08-30 dependency pass

- **vite 5 → 8 (and `@vitejs/plugin-react` 4 → 6)** — L. **Needs Mason
  (Decision queue 11).** Turning Dependabot on surfaced a dev-server-only
  esbuild advisory: a page visited while `npm run dev` is running can issue
  requests to the local dev server and read the responses. Nothing in
  production runs a dev server, so the exposure is one developer machine during
  local dev. The only patched path is a three-major jump of the build
  toolchain that both CI jobs and the smoke harness stand on —
  `test/smoke/vite.config.js`, the render check's `npx vite`, and the
  `manualChunks` split in `vite.config.js`. CI would catch a hard break rather
  than ship one, so this is a scope call, not a risk call: accept the advisory
  and ignore the major, or do the upgrade deliberately with the harness and the
  built app verified. PR #117 is left open as the record; its duplicate (#119,
  the same jump reached via esbuild) was closed. The four patch-level PRs in
  that batch merged — `pdfjs-dist` among them, the only one reaching the
  browser bundle, and the standing reason a pdf.js bump wants a real-device
  PDF import check that no CI job can supply.

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
