# Prompt: build the full testing suite

Paste everything below the rule into a fresh Claude session started on current
`main`. It is written for a session that has CLAUDE.md loaded (any session in
this repo does). Designed 2026-07-31 against the state of the repo at that
date; if modules have moved since, the phase goals still apply — re-verify the
file-level claims before acting on them.

---

Build a comprehensive testing suite for this app. Work on
`claude/feature-testing-suite` cut from current main. Read CLAUDE.md fully
first — it is load-bearing for this task: the Conventions and Gotchas sections
are a list of behaviors that are *decided*, and most of your job is pinning
them so they stay decided.

Deliver in phases, in the order below (they're ranked by value). One commit
per phase, `npm test` green at every commit. If the suite grows past what one
session can do well, stop at a phase boundary, push, and say what's left —
don't rush the later phases.

## Ground rules

- **Test framework stays `node --test`, zero new dependencies.** No vitest, no
  jest, no fixture libraries. Helpers go in `test/helpers/` (plain modules —
  the `test/**/*.test.js` glob won't pick them up as suites).
- **Test pure modules in Node.** Where the behavior under test currently lives
  behind the Supabase client (`src/dataAdapter.js` imports
  `./supabaseClient.js`, which needs Vite's `import.meta.env` — it is NOT
  plain-Node importable, don't fight that), use the repo's established move:
  extract the pure logic into a plain-importable module and have dataAdapter
  delegate/re-export, exactly as `cashFlow.js`, `envelopes.js`, and
  `taxReport.js` were extracted. **Keep every existing dataAdapter export and
  return shape byte-for-byte stable** — the gitignored UI harness mocks that
  surface, and CLAUDE.md's workflow notes call out exactly this hazard.
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
  - Hidden accounts' transactions are excluded at the query level
    (`accounts!inner … .eq('accounts.hidden', false)`) — every read the totals
    are built from already receives only unhidden rows.
  - `plaid_tx_id` / `plaid_account_id` keep their names (`test/noPlaid.test.js`
    guards this — keep it green).
- Update CLAUDE.md's `test/` row in the Key files table in the same branch —
  it enumerates what the suite covers and must stay true.
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
soup.

Cover at minimum:

**Shape tests** — `looksLikeDate`, `looksLikeMoney`, `normalizeMoneyText`:
- Unicode minus (U+2212), en-dash, em-dash all normalize to ASCII `-` and
  survive as negative money (the comment in the source says why: a raw-string
  test would silently DROP such rows, not mis-sign them — pin that).
- `"(45.00)"`, `"- $69.31"`, `"$1,234.56"` are money; a bare `"2026"` is not
  (it's a year); a bare integer with no cents/`$`/`,`/sign is not.
- All five date forms in the header comment: `May 23`, `May 23, 2026`,
  `5/23/2026`, `2026-05-23`, `23 May`.

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
`suggestBoundaries` (minGap honored), `suggestRoles` (from header text:
Trans/Post Date → `date`/`date2`, Debit/Credit pair, single Amount).

**`autoDetectTemplate`** on both synthetic layouts: finds the header, proposes
boundaries and roles, sets anchors; and returns something sane (not a throw)
on a page of prose with no table at all.

**`applyTemplate`** — the core. Test:
- Start/stop anchors: rows before the start anchor and after the stop anchor
  are excluded; a missing start anchor ⇒ `anchorFound: false` and
  `layoutSuspect: true`; an empty grid ⇒ `layoutSuspect: true` (this is the
  "statement no longer matches the saved template, re-confirm" signal — the
  modal depends on it).
- Multi-page: the mortgage layout's page-split table yields all rows;
  crucially, a description-only line at the TOP of the next page is NOT glued
  to the last row of the previous page (`pg.page === lastPage` is
  load-bearing).
- Description continuation: a genuine wrap (desc column only, within
  1.8×line-height, same left edge) is glued; the centred page footer that
  passes every geometric test EXCEPT the left-edge alignment is NOT glued —
  the source comment documents this exact failure; make it a REGRESSION test.
- `date2`: with `dateColumn: 'date2'`, the Post Date drives the transaction
  date (that's the matches-the-feed convention for card statements).
- Both `amountMode`s, and `amountSign` passing through to `buildOpts`.
- **Conservation**: every non-empty input line ends up in exactly one of
  `grid` (with a parallel `rowMeta` entry), a glued continuation, or
  `skipped[]`. Nothing silently vanishes — this is the parser-wide invariant.

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

## Phase 2 — totals stress suite (multi-account, all transaction types)

The spending predicate is currently module-private: `isSpend`, `sumSpending`,
the `getSpending` bucketing, and `toTxShape`'s derived fields all live inside
`dataAdapter.js` (~lines 140–255) and cannot be imported in Node. Extract
them into a pure, plain-importable `src/spending.js` (it may import
`categoryMap.js`/`accountBalance.js` — those are pure), and have dataAdapter
import from it. dataAdapter's async exports keep their exact shapes;
re-export the pure helpers like it already does for `cashFlow.js`.

Then `test/spending.test.js` + `test/helpers/ledger.js` — a synthetic
household generator: joint checking, joint savings, two credit cards, a
mortgage `loan` account, a manual "Imported" account, and a hidden account;
transactions spanning every type — ordinary purchases across several
categories, card purchases, a card-payment pair (checking outflow + credit
inflow), a checking↔savings transfer pair, a credit-card refund (negative on
credit → `Return`), an excluded row, a `user_category` override, a custom
category, an `Uncategorized` fallback row, an entity-tagged rental expense,
and loan-servicer postings on the loan account.

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
4. Feeding the same rows through `envelopes.js`'s walk (spent aggregated via
   `isSpend`) gives a per-category Spent equal to the Categories-tab bucket —
   the shared-predicate guarantee CLAUDE.md promises.
5. `Return` rows count in NEITHER spending NOR income.
6. Transfers/card payments never count as spending — AND "CAPITAL ONE
   TRAVEL"-shaped purchases are NOT eaten by the card-payment guard (both
   guards from `txClassify.js`, exercised through the aggregation this time).
7. Toggling `excluded` on one row moves the total by exactly that row's
   amount; a `user_category` change moves money between buckets while the
   grand total is conserved.
8. On the SAME ledger, the cash-flow model (`cashFlow.js`) produces its own
   expected constants: the internal transfer pair washes (reducing income and
   spending equally), the card payment IS cash spending but NOT purchase
   spending, savings outflows are neither. Do not assert the two models
   agree — assert each against its own constant.
9. `Uncategorized` rows count as spending and appear as a visible bucket.
10. Entity-tagged rows still count in every household total (lens, not
    exclusion).

**Property tests** (seeded PRNG, random ledgers, a few hundred rows):
- Partition: every row contributes to exactly one bucket or to none, never
  two.
- Permutation invariance: shuffling input order changes no total and no
  bucket.
- Additivity: totals computed per-account sum to the whole-ledger total.
- All bucket amounts are positive; `percent_of_total` sums to ~100 when the
  total is nonzero.
- Round-trip with `toTxShape`: `counted` never disagrees with `isSpend` for
  any generated row.

## Phase 3 — category correction, applied backward and forward

`txClassify.js` unit coverage already exists — don't duplicate it. What's
untested is the machinery around it.

**Extract the history-apply core.** `applyCategoryRuleToHistory`
(`dataAdapter.js:411`) contains real logic — first-token ilike narrowing with
`%`/`_` escaping, ordered paging with the PGRST103 end-of-range contract,
re-matching via `matchLearnedRule`, skip-already-correct, dryRun — welded to
the client. Refactor it to delegate to a pure core (e.g.
`src/ruleHistory.js`) that takes a page-fetch function and a batch-update
function; dataAdapter wraps it with the real client. Then test the core with
fakes:

- REGRESSION: a result set whose size is an EXACT multiple of the page (1000)
  terminates cleanly on the PGRST103 error instead of throwing (this failed
  silently once already — the Gotcha documents it).
- A real error still throws — and is never folded into a `0` count (`0` must
  mean "nothing matched", the source comment explains why).
- `dryRun` count equals the ids a wet run would write; wet run writes
  `mapped_category` ONLY (a row with a `user_category` override is included in
  the rewrite but the override still wins at read time — pin via
  `effectiveCategory`).
- Rows already at the target category are skipped; descriptors with `%`/`_`
  are escaped into the ilike pattern; matching runs against BOTH
  `merchant_name` and `description`.
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
- **`assistantModels.js`**: the allowlist matches what the server validates,
  `estimateCostRange` is monotone in tokens and never negative, unknown model
  ids rejected.
- **`api/_lib/spendingContext.js` determinism**: CLAUDE.md requires
  byte-stable output per DB state (prompt caching). If the formatting core is
  extractable without contortion, extract and assert two runs over the same
  fixture produce identical strings, that excluded rows are skipped, and that
  `user_category`/`user_description` are preferred. Also assert its debt
  display matches `displayBalance` — it is the fourth display site and the one
  that silently drifts. If extraction isn't clean, leave it as a documented
  gap rather than forcing it.
- **Watermark decision logic in `api/sync.js`**: `test/simplefin.test.js`
  covers the classifier; what's unpinned is the sync-level consequence —
  advance `last_pulled_at` on advisories and capped ranges, hold it on real
  errors, report `coverage_shortfall`. If that decision is inline in
  `sync.js`, extract the decision function into `api/_lib/simplefin.js` and
  pin it; the deadlock this prevents had NO alarm anywhere, which is exactly
  why it needs a test.

## Phase 5 — browser harness smoke pass (gitignored, recreate per CLAUDE.md)

Nothing here is committed except fixes it uncovers. Recreate the mock harness
(Vite app rendering `Dashboard.jsx`, full-match alias regexes swapping
dataAdapter/sync/db/apiClient for mocks, playwright-core with
`executablePath: '/opt/pw-browsers/chromium'`, 390×844) and run:

- **Totals cross-check on screen**: drive the harness mocks with the Phase 2
  ledger and verify the rendered Overview headline, Categories bars, Budget
  Spent, and CategorySheet split equal the pure-suite constants. This closes
  the loop between the pure tests and what the app displays.
- **Optimistic-patch flows**: a category edit made from search results
  appears immediately; a rename appears in the account sheet; the
  learned-rule confirm shows the dry-run count (the `saveTx` Gotcha paths).
- **PDF pipeline in a real browser**: exercise `pdfExtract.js` on a minimal
  synthetic PDF (a hand-written one-page PDF with a few text ops is enough),
  including the Safari emulation CLAUDE.md prescribes —
  `delete ReadableStream.prototype[Symbol.asyncIterator]` — to prove the
  polyfill path still works. This is the layer Node tests cannot reach and
  where both real-device bugs (legacy build, async iteration) lived.
- Screenshot anything that changed at 390px.

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
- CLAUDE.md's Key files `test/` row updated to describe the new coverage.
- Final report: what's now covered, bugs found and fixed (with the failing
  test that caught each), and the deliberate gaps.
- Branch pushed; no PR, no merge — Mason reviews the preview and says
  "merge testing-suite".
