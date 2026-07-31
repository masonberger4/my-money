# Prompt: build the full testing suite

Paste everything below the rule into a fresh Claude session started on current
`main`. It is written for a session that has CLAUDE.md loaded (any session in
this repo does). Designed 2026-07-31 against the state of the repo at that
date, then revised the same day after a multi-agent adversarial review
(5 lenses, 31 confirmed findings applied); if modules have moved since, the
phase goals still apply — re-verify the file-level claims before acting on
them.

---

Build a comprehensive testing suite for this app. Work on
`claude/feature-testing-suite` cut from current main. Read CLAUDE.md fully
first — it is load-bearing for this task: the Conventions and Gotchas sections
are a list of behaviors that are *decided*, and most of your job is pinning
them so they stay decided.

Deliver in phases, in the order below (they're ranked by value). One commit
per phase, `npm test` green at every commit. Phases 1 and 2–3 are each a
natural one-session unit; if the suite grows past what one session can do
well, stop at a phase boundary, push, and say what's left — don't rush the
later phases. Mason may choose to review and merge after Phase 2 or 3 rather
than holding all five phases on one long-lived branch.

**Resuming:** if `origin/claude/feature-testing-suite` already exists, a
previous session started this work. Check it out, read its commit log to see
which phases landed, merge `origin/main`, and continue from the next phase —
do not re-cut the branch from main and do not repeat a completed phase.

## Step 0 — baseline

Run `npm install`, then `npm test`, and confirm the existing suite is fully
green before writing anything. In a fresh environment `test/apiLoads.test.js`
fails with `ERR_MODULE_NOT_FOUND` for npm packages — that is missing
`node_modules`, not a repo bug; install dependencies rather than touching the
test, and never weaken or skip `apiLoads.test.js` to get green. Every later
green-at-every-commit check assumes this baseline.

## Ground rules

- **Test framework stays `node --test`, zero new dependencies.** No vitest, no
  jest, no fixture libraries. Helpers go in `test/helpers/` (plain modules —
  the `test/**/*.test.js` glob won't pick them up as suites).
- **Test pure modules in Node.** Where the behavior under test currently lives
  behind the Supabase client: `src/dataAdapter.js` technically imports in
  plain Node (`supabaseClient.js` deliberately degrades to a null client
  instead of throwing — read its header comment), but the spending logic is
  module-PRIVATE (`isSpend`/`sumSpending`/`toTxShape` are not exported) and
  every export is async and dead without a configured client — so don't fight
  that. Use the repo's established move: extract the pure logic into a
  plain-importable module and have dataAdapter delegate/re-export, exactly as
  `cashFlow.js`, `envelopes.js`, and `taxReport.js` were extracted. **Keep
  every existing dataAdapter export and return shape byte-for-byte stable** —
  the gitignored UI harness mocks that surface, and CLAUDE.md's workflow
  notes call out exactly this hazard.
- **All fixtures are synthetic.** Never commit text runs, descriptors, account
  numbers, or amounts taken from a real statement of Mason's. Model the
  *shapes* of the real cases CLAUDE.md documents (a Capital One card
  statement, a NewRez mortgage with a page-split table) with invented data.
- **Determinism**: no `Date.now()`, no unseeded `Math.random()` in tests. For
  property-style tests, reuse the seeded-PRNG pattern already in
  `test/cashFlow.test.js` (the brute-force parity test). Fixed seeds, modest
  iteration counts — the suite should stay fast.
- **Naming**: a test that pins a decided behavior is named `REGRESSION: …`,
  matching the existing convention.
- **If an invariant genuinely fails, that's a find, not an obstacle.** Keep
  the failing test, fix the code, and report it. Never weaken an invariant to
  get green. If the fix is non-obvious or touches a decided behavior, stop and
  surface it to Mason instead of deciding unilaterally.
- **Decided behaviors you must not "fix" while testing** (all in CLAUDE.md,
  repeated here because a test author will trip on them):
  - The two spending models (purchase-based vs joint-budget cash-flow)
    legitimately disagree. Never write a test asserting they match.
  - `Uncategorized` IS counted as spending, is a real taxonomy member, and is
    never budgetable.
  - A missing/zero `budget_months` row is NOT `monthly_limit` — no fallback.
  - The envelope walk has no date clamp.
  - The learned-rule over-specific-key limit is deliberate (already pinned).
  - Hidden accounts' transactions are excluded at the QUERY level
    (`accounts!inner … .eq('accounts.hidden', false)`) — every read the totals
    are built from already receives only unhidden rows. **Do NOT add a hidden
    check to `isSpend` or the extracted spending module** — hidden exclusion
    is decided to live at the query level; the pure layer never sees hidden
    rows in production.
  - `applyTemplate` deliberately drops lines outside the anchored region and
    on template-excluded pages without recording them in `skipped[]` — that
    is what anchors are for. Do not change `skipped[]` semantics.
  - `plaid_tx_id` / `plaid_account_id` keep their names (`test/noPlaid.test.js`
    guards this — keep it green).
- **Update CLAUDE.md in the same branch**, not just its `test/` row: add a
  Key-files row for each newly extracted module (`src/spending.js`,
  `src/ruleHistory.js`, and any `api/_lib` extraction) — the per-module rows
  for `cashFlow.js`/`envelopes.js`/`taxReport.js` are the precedent; amend the
  dataAdapter row's enumeration (it lists what dataAdapter holds and which
  pure helpers it re-exports, which Phases 2–3 change); and update the `test/`
  row to describe the new coverage.
- Push with `git push -u origin claude/feature-testing-suite`; fetch/absorb
  `origin/main` before every push. No PR unless Mason asks.

## Phase 1 — PDF importer, in depth (`test/pdfImport.test.js`)

`src/pdfImport.js` is ~730 lines of pure parsing with ZERO test coverage — the
biggest untested surface in the app. It was verified manually on two real
statements and never since. Everything below is plain-Node testable; only
`pdfExtract.js`/`pdfPolyfills.js` (browser) are out of scope until Phase 5.

Build `test/helpers/pdfFixtures.js` first: tiny builders for positioned text
runs (`run(text, x, y, w?, h?)`), lines, and whole synthetic statement pages —
one card-statement layout (Trans Date + Post Date + Description + Amount, a
start anchor like "TRANSACTIONS", a centred page footer) and one
mortgage-statement layout (Date + Description + Payments + Charges columns,
table split across two pages). Tests should read as row specs, not coordinate
soup. Remember pdfExtract delivers TOP-DOWN per-page y coordinates — page 2's
first line has a *smaller* y than page 1's last line; fixtures must model
that or several geometry tests pass vacuously (see the multi-page bullet).

Cover at minimum:

**Shape tests** — `looksLikeDate`, `looksLikeMoney`, `normalizeMoneyText`:
- Unicode minus (U+2212), en-dash, em-dash all normalize to ASCII `-` and
  survive as negative money (the comment in the source says why: a raw-string
  test would silently DROP such rows, not mis-sign them — pin that).
- `"(45.00)"`, `"- $69.31"`, `"$1,234.56"` are money; a bare `"2026"` is not
  (it's a year); a bare integer with no cents/`$`/`,`/sign is not.
- All five date forms in the header comment: `May 23`, `May 23, 2026`,
  `5/23/2026`, `2026-05-23`, `23 May`.

**CSV-side parsers on the same write path** — `parseMoney`, `parseDate`,
`detectHeader` in `src/csvImport.js` are only incidentally exercised through
`analyzeCsv` with easy inputs; pin them directly here since the PDF path
reuses them:
- `parseMoney`: `'$1,234.50'`, `'(45.00)'`, `'-45'`, `'+45'`, blank → 0,
  `'N/A'` → NaN — and pin the `'(-45.00)'` double-flip as documented current
  behavior, whatever it turns out to be.
- `parseDate`: the `12/31/69` vs `1/1/70` two-digit-year pivot,
  `'2026-02-30'` → null, `'5.23.26'` / `'5-23-2026'` separator variants,
  garbage → null.
- `detectHeader`: preamble junk rows skipped; a headerless file → null.

**Year inference** — `findStatementPeriod`, `collectYearContext`,
`resolveYearWindow`, `inferYear`, `parseFlexibleDate`:
- The billing-cycle span filter: a genuine statement period is found; an
  arbitrary pair of far-apart dates (e.g. a copyright line's year vs the due
  date) is rejected.
- The partial-range shorthand where only the closing date carries a year:
  `May 25 - Jun 23, 2026`.
- REGRESSION: **Dec→Jan wrap** — in a period `Dec 15, 2025 – Jan 14, 2026`, a
  row dated `Dec 28` resolves to 2025 and a row dated `Jan 3` resolves
  to 2026.
- Stale fine-print years (a 2023 revision date in a footer) do not widen the
  year window — the period anchors it.
- Two-digit years: `≥70` → 1900s, else 2000s.

**Geometry** — `groupIntoLines` (runs within the 3pt y-tolerance merge, runs
farther apart split), `splitLineIntoCells`/`lineCellStarts` (a run sitting
exactly on a boundary lands in a deterministic cell), `findHeaderLines`,
`suggestBoundaries` (minGap honored), `suggestRoles` — note the mechanism
before writing fixtures: roles come from CELL-CONTENT statistics (≥60% of
non-empty cells parsing as dates/money drives `date`/`date2` by column order
and the money roles), with header wording consulted only to break the
debit-vs-credit tie between two money columns; single money column →
`amount`. Target content-driven fixtures, not header-text-driven ones.

**`autoDetectTemplate`** on both synthetic layouts: finds the header, proposes
boundaries and roles, sets anchors; and returns something sane (not a throw)
on a page of prose with no table at all.

**`applyTemplate`** — the core. Test:
- Start/stop anchors: rows before the start anchor and after the stop anchor
  are excluded; a missing start anchor ⇒ `anchorFound: false` and
  `layoutSuspect: true`; an empty grid ⇒ `layoutSuspect: true` (this is the
  "statement no longer matches the saved template, re-confirm" signal — the
  modal depends on it). Pin the exclusion semantics as their own test: lines
  before the start anchor, after the stop anchor, on pages excluded by
  `template.pages`, and the anchor-matching lines themselves are deliberately
  dropped with NO `skipped[]` entry — that is decided behavior (see Ground
  rules), not a leak.
- Multi-page: the mortgage layout's page-split table yields all rows;
  crucially, a description-only line at the TOP of the next page is NOT glued
  to the last row of the previous page (`pg.page === lastPage` is
  load-bearing). **Constrain the fixture so deleting that check would
  actually flip the test** — with top-down y coordinates the next page's top
  line has a smaller y, so `line.y - lastY > 0` already rejects the glue in a
  naive fixture and the test pins nothing. Make page 1's last table row the
  page's LAST non-empty line (any trailing footer line gets skipped and
  resets the glue state), at a y slightly SMALLER than page 2's first
  description-only line's y and within 1.8×line-height of it (e.g. page 1's
  last row at y=100, page 2's line at y=110, line height 10), with the
  description cell at the same left edge.
- Description continuation: a genuine wrap (desc column only, within
  1.8×line-height, same left edge) is glued; the centred page footer that
  passes every geometric test EXCEPT the left-edge alignment is NOT glued —
  the source comment documents this exact failure; make it a REGRESSION test.
- `date2`: with `dateColumn: 'date2'`, the Post Date drives the transaction
  date (that's the matches-the-feed convention for card statements).
- Both `amountMode`s, and `amountSign` passing through to `buildOpts`.
- **Conservation, correctly scoped**: every non-empty line on a
  template-included page, strictly inside the anchor region, and not itself a
  start/stop anchor match, ends up in exactly one of `grid` (with a parallel
  `rowMeta` entry), a glued continuation, or `skipped[]`. Lines outside that
  scope are deliberately dropped (previous bullet) — do not fold them into
  this invariant, and do not "fix" `applyTemplate` to record them.

**`normalizeDebitCredit`** — the reversal netting:
- A NEGATIVE value in the debit column becomes a positive credit (the
  mortgage "back out an unapplied payment" case from the source comment), and
  vice versa; both-populated pairs net; a zero net empties both; unparseable
  input passes through untouched (so buildRows can drop it, not crash).

**`rowTotals`**: computed from buildRows OUTPUT (the source comment explains
why — pin it): out/in split, two-decimal rounding.

**Integration round-trip** (the point of the whole design): synthetic pages →
`applyTemplate` → `csvImport.buildRows` with `rules` and an `overlapFrom`:
- Categories, signs, and transfer flags come out per the shared classifier.
- Re-parsing the same statement yields IDENTICAL `plaid_tx_id`s (idempotent
  re-import — extends the CSV idempotency tests to the PDF path).
- Rows on/after the feed boundary are flagged overlap and excluded from the
  importable set.
- The same synthetic transaction worded CSV-style vs PDF-style produces
  DIFFERENT dedup ids — pin this as documentation of the one-format-per-
  account rule (the Gotcha exists because of it).

**The comparison audit** — `reconcileCsv`, `descSimilarity`, `csvDateRange`
in `src/csvImport.js` are ~160 lines of untested matching logic (their own
Kuhn's max-matching plus a second amount-mismatch pass), and every "audit"
and "both" statement import renders their output. Cover:
- Deterministic fixtures hitting each bucket: exact match; ±window date
  drift; category mismatch (via `user_category` winning in the effective-
  category comparison); an amount mismatch paired only when `descSimilarity`
  clears its threshold; csvOnly / feedOnly leftovers.
- A seeded brute-force max-matching parity test mirroring the
  `test/cashFlow.test.js` pattern.
- Input-order invariance — the pre-matching sort exists exactly for this;
  pin it.
- Counts conservation: matched + amountMismatches + csvOnly equals the CSV
  row total.
- `csvDateRange`: min/max, and rows with missing dates.

## Phase 2 — totals stress suite (multi-account, all transaction types)

The spending predicate is currently module-private: `isSpend`, `sumSpending`,
the `getSpending` bucketing, and `toTxShape`'s derived fields all live inside
`dataAdapter.js` (~lines 140–255) and are unexported. Extract them into a
pure, plain-importable `src/spending.js` (it may import
`categoryMap.js`/`accountBalance.js` — those are pure), and have dataAdapter
import from it. Include in the extraction the **envelope-spending fold** — a
pure `aggregateEnvelopeSpending(rows) -> [{category, month, spent}]`
mirroring what `getEnvelopeSpending` aggregates today, with
`getEnvelopeSpending` delegating to it — scenario test 4 below needs it, and
without it the test would pin a re-implementation while the shipped
aggregation stays private and free to drift. dataAdapter's async exports keep
their exact shapes; re-export the pure helpers like it already does for
`cashFlow.js`.

Then `test/spending.test.js` + `test/helpers/ledger.js` — a synthetic
household generator: joint checking, joint savings, two credit cards, a
mortgage `loan` account, a manual "Imported" account, and a hidden account;
transactions spanning every type — ordinary purchases across several
categories, card purchases, a card-payment pair (checking outflow + credit
inflow), a checking↔savings transfer pair, a credit-card refund (negative on
credit → `Return`), an excluded row, a `user_category` override, a custom
category, an `Uncategorized` fallback row, an entity-tagged rental expense,
and loan-servicer postings on the loan account.

**The ledger helper must hand rows to the pure suite the way the app's
queries and write path deliver them** — several behaviors the scenarios
exercise are produced by the fetch/write layers, not by `isSpend`, and a
ledger that skips this produces vacuous tests or tempts an unsanctioned
change to `isSpend`:
- Rows carry the post-join shape (`t.accounts = {type, subtype}`).
- Expose a `visibleRows()` view that filters out hidden-account rows,
  emulating the query's `.eq('accounts.hidden', false)`; ALL totals in these
  tests are computed over that view. The hidden account exists to pin that
  the fixture models the query contract (and Phase 5 reuses it for the
  on-screen check) — do NOT assert hidden exclusion through `isSpend`.
- Derive each row's `mapped_category` the way the write path does: through
  `classifyDescription` (with `accountType`), then `applyAccountRules` for
  the credit-negative → `Return` behavior.
- The checking↔savings transfer pair must be eligible for
  `markInternalTransfers`: raw_category `TRANSFER_OUT`/`TRANSFER_IN`,
  distinct `account_id`s, dates ≤4 days apart.

**Deterministic scenario tests** — hand-computed expected constants, then the
invariants:

1. `getSpending`-style group amounts sum exactly to `sumSpending` of the same
   rows, and to the hand-computed total.
2. The `loan` account contributes NOTHING to purchase-based spending; removing
   it changes no total (the double-counted-mortgage rule).
3. `counted` (from `toTxShape`) agrees with contribution: the sum of
   `counted:true` rows in a category equals that category's group amount —
   the CategorySheet contract ("the list's sum is the number that was
   tapped").
4. `aggregateEnvelopeSpending`'s output for the viewed month equals
   `getSpending`'s bucket amounts over the same rows — the shared-predicate
   guarantee CLAUDE.md promises, tested against the SHIPPED fold, not a
   test-local copy. Compare within a cent: the envelope walk rounds per month
   while the spending bucket sums do not, so exact float equality can fail on
   legitimate data.
5. `Return` rows count in NEITHER spending NOR income.
6. Transfers/card payments never count as spending — AND "CAPITAL ONE
   TRAVEL"-shaped purchases are NOT eaten by the card-payment guard (both
   guards from `txClassify.js`, exercised through the aggregation this time).
7. Toggling `excluded` on one row moves the total by exactly that row's
   amount; a `user_category` change moves money between buckets while the
   grand total is conserved.
8. On the SAME ledger, the cash-flow model (`cashFlow.js`) produces its own
   expected constants: the checking→savings pair washes, reducing income and
   spending equally; add a second, savings→checking pair and assert it
   reduces income only (savings outflows were never spending). The card
   payment IS cash spending but NOT purchase spending; do not assert the two
   models agree — assert each against its own constant.
9. `Uncategorized` rows count as spending and appear as a visible bucket.
10. Entity-tagged rows still count in every household total (lens, not
    exclusion).
11. **The accounts-join contract** (the real `counted` failure mode — after
    the extraction `toTxShape` literally sets `counted: isSpend(t)`, so
    "counted agrees with isSpend" is an identity; what can actually break is
    the join): a row with `accounts: {type:'loan'}` yields `counted:false`
    and contributes to no bucket; REGRESSION: a row MISSING the accounts join
    entirely is treated as non-loan (`counted:true` when it otherwise
    qualifies) — the silent failure behind dataAdapter's "Every caller of
    toTxShape selects accounts.type" comment. Optionally add a noPlaid-style
    source-scan asserting the three reads that feed `toTxShape`
    (`getTransactionsBetween`'s join string, `getAccountTransactions`,
    `searchTransactions`) select the accounts type — but do NOT scan every
    `.from('transactions')` call: `getExistingTxIds`, `getFeedCoverageStart`,
    `getAccountTransactionsInRange`, and the rule-history candidate scan
    legitimately select no accounts join.

**Property tests** (seeded PRNG, random ledgers, a few hundred rows). Skip
properties that are true by construction of a Map-based fold (partition,
positive buckets, percent≈100 — none of those can fail); use ones that can:
- Permutation invariance: shuffling input order preserves the bucket SET —
  compare keyed by label, never positionally (the amount-desc sort's tie
  order legitimately changes), and compare sums within a cent (float
  addition is non-associative).
- Metamorphic split: replacing one row with two same-category rows whose
  amounts sum to the original preserves every bucket total within a cent.
- Metamorphic exclude-toggle: toggling `excluded` on a random row moves the
  total by exactly that row's prior contribution — its amount when the
  un-excluded row satisfies `isSpend`, zero otherwise.
- Metamorphic retype: retyping a random row's account to `loan` changes the
  total by exactly that row's prior contribution (zero for rows that were
  not counted).

## Phase 3 — category correction, applied backward and forward

`txClassify.js` unit coverage already exists — don't duplicate it. What's
untested is the machinery around it.

**Extract the history-apply core.** `applyCategoryRuleToHistory`
(`dataAdapter.js:411`) contains real logic — first-token ilike narrowing,
ordered paging with the PGRST103 end-of-range contract, re-matching via
`matchLearnedRule`, skip-already-correct, dryRun — welded to the client.
Refactor it to delegate to a pure core (e.g. `src/ruleHistory.js`) that takes
a page-fetch function and a batch-update function; dataAdapter wraps it with
the real client. Then test the core with fakes:

- REGRESSION: a result set whose size is an EXACT multiple of the page (1000)
  terminates cleanly on the PGRST103 error instead of throwing (this failed
  silently once already — the Gotcha documents it).
- A real error still throws — and is never folded into a `0` count (`0` must
  mean "nothing matched", the source comment explains why).
- `dryRun` count equals the ids a wet run would write; wet run writes
  `mapped_category` ONLY (a row with a `user_category` override is included in
  the rewrite but the override still wins at read time — pin via
  `effectiveCategory`).
- Rows already at the target category are skipped; matching runs against BOTH
  `merchant_name` and `description`.
- Wildcard handling, stated precisely: a `%`/`_` in a DESCRIPTOR can never
  inject ilike wildcards, because `merchantKey` strips non-token characters
  before the pattern is built — pin that. The escape at the pattern-build
  site is unreachable belt-and-braces through the real entry point; if the
  extracted core keeps it, test it directly with a crafted token, not
  through a descriptor.
- The first-token narrowing is a superset of the exact match: generate rows
  where ilike hits but `matchLearnedRule` doesn't, and assert they're not
  rewritten.

**Forward direction (future transactions)** — precedence at write time,
through the real entry points both feeds use:
- `classifyDescription`/`buildRows` with a `rules` map: learned rule beats the
  keyword table; keyword table beats `Uncategorized`; a rule pointing at a
  custom category works.
- REGRESSION: a learned rule NEVER overrides the transfer/card-payment guards
  (a rule saying "this card payment is Dining" loses — the totals-protection
  rule).
- Deleting a rule: the next classification falls back to the keyword table;
  history is untouched.
- Sequence test: teach a rule → apply to history → re-import the same file →
  dedup drops the duplicates, so the rewrite is not undone and ids are
  stable. (This is the interaction that would flip-flop if either side were
  wrong.)

## Phase 4 — the rest of the uncovered surface

- **`test/recurring.test.js`** — `src/recurring.js` has zero coverage. Read
  the module, then pin: `normalizeMerchant` collapsing, monthly cadence
  detection with day jitter, amount drift tolerance, a skipped month,
  non-monthly cadences if supported, one-off purchases never flagged,
  deterministic output ordering. Pin the ACTUAL thresholds as documentation.
- **`test/accountBalance.test.js`** — `isDebtAccount`/`displayBalance`:
  credit/loan negate, depository/null type pass through, zero and null
  balances, and a note-test for the overpaid-card caveat (stored positive ⇒
  still displayed as owed; approximate by decision).
- **`test/categoryMap.test.js`** — direct coverage (today it's only exercised
  through csvImport): `applyAccountRules` (credit negative → `Return`,
  depository negative untouched, positives untouched), `isBudgetableCategory`
  (`Uncategorized` and the transfer bucket false, real + custom categories
  true), `ERA_CATEGORIES` sanity (no duplicates, `Uncategorized` present, no
  `Housing`/`Income` member).
- **SimpleFIN normalization — CLAUDE.md literally calls this "the fragile
  part", and it has zero coverage** (`test/simplefin.test.js` imports only
  the classifier/clamp/sanitize functions). Extend it, or add
  `test/simplefinNormalize.test.js`, covering:
  - `inferAccountType`: card product names carrying no card-ish word
    ("Venture X" shapes) resolve `credit`; REGRESSION pinning the rule
    ORDERING — "Platinum Savings" / "Preferred Checking" resolve deposit
    DESPITE "platinum"/"preferred" appearing in the card list (the deposit
    rules run first on purpose; a reorder silently turns a savings account
    into a card); card-only issuers; the negative-balance fallback → credit
    + uncertain flag; unknown → depository/checking + uncertain.
  - `normalizeTransaction`: string amounts ("-05.50") parse and the sign
    flips (SimpleFIN positive=in → app positive=out); `posted: 0` is a
    pending sentinel that falls through to `transacted_at` and never becomes
    1970; missing id/amount/date → null.
  - `normalizeBalance`: credit/loan negatives flip positive, deposits pass
    through, the overpaid-card case stays positive by decision.
- **SimpleFIN token/SSRF plumbing** — a security surface backed by two
  CLAUDE.md Gotchas, fully untested:
  - `decodeSetupToken`: a valid token decodes to its claim URL; a pasted
    access URL is recognized as such; whitespace and URL-safe base64
    tolerated; `http:` and private-host targets rejected — including
    `169.254.169.254`, `[::1]`, `[::ffff:127.0.0.1]` — and REGRESSION:
    ordinary public hosts that merely LOOK bank-internal ("fdic.gov",
    "fcu-bridge.example.com") are NOT blocked.
  - `splitAccessUrl`: credentials move into an Authorization header
    (percent-encoded creds decoded), trailing `/accounts` stripped,
    non-https rejected.
  - `claimAccessUrl` with a stubbed fetch: a 302 to a private host throws; a
    307 re-POSTs; a 302-on-POST refuses; more than 3 hops throws; a 403 maps
    to token-already-claimed.
- **`assistantModels.js`** — concrete module-level assertions (do NOT write
  "the allowlist matches what the server validates": `api/assistant.js`
  imports this same module, so a value-level comparison compares the list to
  itself): `estimateCostRange` returns null for unknown ids and `{low, high}`
  with `0 < low ≤ high` for every allowlisted model at every effort level;
  for effort-capable models the high bound is monotone non-decreasing across
  the EFFORT_LEVELS order (behaviorally pinning the internal per-effort
  output table — a level missing from it would silently collapse to the 2500
  default); models with `effort: false` return identical results at 'low'
  and 'max'; DEFAULT_MODEL is an allowlisted id and DEFAULT_EFFORT a member
  of EFFORT_LEVELS. Plus a noPlaid-style source-scan asserting
  `api/assistant.js` imports its model list from `../src/assistantModels.js`
  and declares no model-id literals of its own — that pins the drift that
  actually matters (someone forking a private server list).
- **`api/_lib/spendingContext.js` byte-determinism** — CLAUDE.md requires
  byte-stable output per DB state (prompt caching). The extraction shape is
  concrete, not optional: `buildSpendingContext`'s only I/O is its two
  queries plus the `new Date()` that computes the query cutoff — which never
  appears in the output text. Extract everything from the visible-rows
  filter down into a pure `formatSpendingContext(accounts, txs)` and have
  `buildSpendingContext` delegate to it after the queries. Then assert over
  a fixture: two runs produce identical strings; excluded rows are skipped;
  `user_category`/`user_description` are preferred; and the debt display
  matches `displayBalance` — it is the fourth display site and the one that
  silently drifts. Only report a gap if the delegation would change the
  function's output.
- **`api/sync.js` decision logic** — two parts:
  - The watermark decision: `test/simplefin.test.js` covers the classifier;
    what's unpinned is the sync-level consequence — advance `last_pulled_at`
    on advisories and capped ranges, hold it on real errors, report
    `coverage_shortfall`. If that decision is inline in `sync.js`, extract
    the decision function into `api/_lib/simplefin.js` and pin it; the
    deadlock this prevents had NO alarm anywhere, which is exactly why it
    needs a test.
  - `isMissingTableError` / `isMissingColumnError` are exported and directly
    importable — pin the documented Gotcha: (a) the adversarial case — a
    missing-COLUMN error whose message names the table ("column
    simplefin_access.last_attempt_at does not exist") returns FALSE from
    `isMissingTableError('simplefin_access')` and TRUE from
    `isMissingColumnError('last_attempt_at')`; (b) a DIFFERENT missing
    column does not match the named one; (c) a genuine missing-table error
    matches only the table test; (d) null/garbage errors return false.
    Conflating these two silently switches the whole feed off — that's the
    failure being pinned.
- **Static lockstep guards** (one file in the `noPlaid.test.js` mold — each
  is a few lines and turns a documented silent breakage into a red test):
  (a) the hex values in index.html's `theme-color` metas and pre-paint
  background equal `ui.css`'s corresponding `--bg` values (the documented
  lockstep rule); (b) `public/sw.js` contains the `/api/` passthrough guard
  and a `CACHE_VERSION` line; (c) every `pdfjs-dist` import in `src/`
  contains `/legacy/build/` (the modern build throws on real devices).

## Phase 5 — browser harness smoke pass (gitignored, recreate per CLAUDE.md)

Nothing here is committed except fixes it uncovers (each such fix is its own
commit with a REGRESSION test). Recreate the mock harness (Vite app rendering
`Dashboard.jsx`, full-match alias regexes swapping dataAdapter/sync/db/
apiClient for mocks, playwright-core with
`executablePath: '/opt/pw-browsers/chromium'`, 390×844). Note on tooling:
playwright-core is NOT installed in this repo and must not be added to
package.json — the zero-new-dependencies rule applies to committed files
only. `npm install playwright-core` inside the gitignored harness directory
(or use a preinstalled global playwright if the environment provides one),
and keep `executablePath` pointed at the preinstalled Chromium.

Run:

- **Totals cross-check on screen**: drive the harness mocks with the Phase 2
  ledger (serving its `visibleRows()` view, the same filtered view the real
  queries deliver) and verify the rendered Overview headline, Categories
  bars, Budget Spent, and CategorySheet split equal the pure-suite
  constants. This closes the loop between the pure tests and what the app
  displays — including that the hidden account's rows appear nowhere.
- **Optimistic-patch flows**: a category edit made from search results
  appears immediately; a rename appears in the account sheet; the
  learned-rule confirm shows the dry-run count (the `saveTx` Gotcha paths).
- **PDF pipeline in a real browser**: exercise `pdfExtract.js` on a minimal
  synthetic PDF (a tiny generated fixture PDF is fine — synthetic content,
  so the fixtures rule permits committing it if useful), including the
  Safari emulation CLAUDE.md prescribes —
  `delete ReadableStream.prototype[Symbol.asyncIterator]` — to prove the
  polyfill path still works. This is the layer Node tests cannot reach and
  where both real-device bugs (legacy build, async iteration) lived.
- Screenshot anything that changed at 390px.

Known unreachable from this harness, record it rather than forcing it: the
App.jsx institution-count Gotcha (a failed count query must not clobber a
KNOWN count back to the connect-your-first-account screen). The harness
renders `Dashboard.jsx` only, and App.jsx talks to `supabaseClient.js`
directly, which the alias list does not cover. Either extend the harness
with a fifth full-match alias for supabaseClient.js (mock
`auth.getSession`/`onAuthStateChange` plus a scriptable institutions count)
and assert a count error arriving AFTER a successful count keeps the
Dashboard mounted — or list it as a recorded gap in the final report. The
first-load case is different by design (an error with no prior value shows
EmptyState); pin it as current behavior or leave it alone — do not write a
test demanding otherwise without surfacing it to Mason.

**Definition of done for this phase**: a section of the final report listing
each of the four checks with pass/fail and the screenshots taken; any fix it
uncovered committed with its REGRESSION test.

## Out of scope (say so in the report, don't attempt silently)

- `receiptImage.js` and the receipt upload path — browser+Storage; verified
  on the real phone per CLAUDE.md.
- SQL/RLS tests (the local Postgres 16 stub) — worthwhile, but a separate
  line of work; list it as a follow-up unless everything above lands with
  room to spare.
- Live SimpleFIN / Supabase integration — never test against prod data.

## Acceptance

- `npm test` green; the placeholder-env build green
  (`VITE_SUPABASE_URL=https://placeholder.supabase.co VITE_SUPABASE_ANON_KEY=placeholder npm run build`).
- No new dependencies; no behavior changes except the sanctioned pure-core
  extractions (shapes stable) and real bug fixes, each carrying its own
  REGRESSION test.
- CLAUDE.md updated per the Ground rules bullet: Key-files rows for each
  extracted module, the dataAdapter row's enumeration amended, and the
  `test/` row describing the new coverage.
- The Phase 5 harness smoke pass was RUN and its results are in the final
  report (or the report states explicitly why it couldn't run in this
  environment) — Phase 5 produces no test files, so without this line it
  would be skippable while satisfying every other bullet.
- Final report: what's now covered, bugs found and fixed (with the failing
  test that caught each), and the deliberate gaps.
- Branch pushed; no PR, no merge — Mason reviews the preview and says
  "merge testing-suite".
