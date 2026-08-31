## Conventions

- Dashboard style: compact inline-styled JSX, CSS vars, accent #7F77DD.
  Mobile-first: verify at 390px. Navigation is a FIXED 5-item bottom bar
  (`src/nav.js` owns the map, `.bnav` in ui.css owns the chrome, z-index 50
  under every `.overlay` at 100; the content column carries 96px bottom
  padding) — the old scrolling tab strip is gone (2026-08-15). The eleven
  internal `tab` state values are UNCHANGED: Home=`overview`, Plan=`budget`,
  Spending=`transactions`, Accounts=`accounts`+`debt` (segment chips), and
  Reflect=`reflect` (a hub of link cards) + `categories`/`trends`/`recurring`/
  `tax`/`ask` (each with a `‹ Reflect` back button).
- **Theme selection**: Auto/Light/Dark toggle in the header. The preference is
  `mm:theme` in **localStorage, NOT the `settings` table** — `settings` is
  household-shared under one login, so storing it there would flip the other
  person's phone; localStorage also reads synchronously, which is what lets
  index.html apply the theme pre-paint instead of flashing. **Device/visual
  prefs go in localStorage; account-level prefs go in `settings`.** The other
  localStorage device prefs: `mm:cardTile` (the Overview card-tile selection —
  a stale selection falls back credit-first; `getOverview` carries an additive
  `id` for it) and `mm:acctCollapsed` (the Accounts tab's COLLAPSED section
  labels — folding Credit on one phone must not fold it on the other, and
  storing the collapsed set rather than the open one keeps "no stored value"
  meaning every section open, which is also what CI's walk renders). No stored
  value ⇒ no `data-theme` ⇒ follow the OS. Every storage access is try/caught
  (Safari private mode throws on access). `src/theme.js` owns it; index.html
  carries a deliberate 3-line duplicate of read+apply that must stay in sync.
- **Theme tokens live ONLY in `src/ui.css`.** Never redeclare a token value in a
  component and never set one as an inline style — an inline custom property on
  a subtree root beats even `!important` on `:root` (that was the dark-mode bug).
  Use tokens, not literals, for anything themed. Two exceptions that must stay
  hardcoded and be changed in lockstep with `--bg`: index.html's `theme-color`
  metas and its pre-paint `html/body` background (parsed before CSS loads).
- `ACCOUNT_COLORS` / `DEFAULT_COLORS` (Dashboard.jsx) are **data, not theme** —
  user-overridable colors persisted in `settings`. Never tokenize them and
  **never change their stored hex values**. Same for the `#1D9E75`/`#D85A30`
  good/bad status pair and CsvImport/PdfTemplateEditor's bucket + role hues.
  What IS theme-dependent is how they **render**: `src/paletteContrast.js`
  holds hue fixed and moves lightness until the color clears 4.5:1 (text) or
  3:1 (marks) against the surface it actually sits on — which also covers the
  arbitrary colors the Swatch picker can produce, as a second fixed palette
  could not. Pass the surface read from the token at runtime (`readToken`), and
  re-read it on theme change or chips keep the old theme's contrast. Two things
  deliberately NOT corrected: the Swatch fill (it's the color picker — it must
  show the stored value truthfully) and the Donut's slice separation (the
  palette maps several categories to one hex, so adjacent slices can be a
  literal 1:1 — a `--card` stroke separates them instead). Known and
  deliberate: `--light-muted` #888780 is 3.61:1 on the card, so light-mode
  small labels still fail AA while dark passes — a palette decision, not a bug.
- Amounts: **positive = money out, negative = money in** — the app's own
  convention, inherited from Plaid and kept because every stored row already
  uses it. SimpleFIN is the opposite (positive = money *in*) and its amounts arrive as numeric
  *strings* ("-05.50" is real), so `api/_lib/simplefin.js` parses then negates.
- **SimpleFIN sends no account type/subtype/mask/category.** Type is *inferred
  from the account name* at first insert and is **user-owned thereafter** — the
  sync writes it on INSERT only, and the Accounts tab lets it be corrected
  (that's why the account write splits into insert-new / update-balances).
  **Why the type matters, corrected 2026-08-06** — the old wording here ("it
  decides whether an account's outflows count as household spending") is a
  survival from the pre-unification two-model design and is WRONG under the
  linked-boundary model, where `isSpend` needs only `amount > 0` on a non-loan
  account, so a card's purchases count whether it is typed `credit` or
  `checking`. It misled a session into telling Mason the opposite of the truth.
  What a card mistyped as `depository` actually breaks, all three reading
  `t.accounts.type` at READ time, so every row inherits the mistake:
  1. **Refunds become income instead of netting.** Only a CREDIT negative
     nets against its category (`isSpend`); typed `depository`, a refund is an
     unpaired depository inflow, which is exactly `isIncome`'s definition of
     money in. (Same corruption, new mechanism: the wording here used to name
     `applyAccountRules` synthesising `Return`, which no longer exists.)
  2. **Some purchases vanish from spending.** `isCardPaymentRow` exits false for
     a credit-account POSITIVE (a positive on a card IS a purchase) — the exit
     is SIGN-scoped, not a blanket credit exit; the wording that stood here,
     "early-returns false for `type === 'credit'`", was stale from 2026-08-17,
     when the credit branch had to start running `isCardPaymentReceived` on
     negatives so refund netting could tell a merchant refund from a payment
     received. The bullet's CONCLUSION is unaffected. Typed
     `depository`, that exit is gone and any purchase worded like a card
     payment gets vetoed — the "Capital One Travel" / "Discover Tire and Auto"
     class.
  3. **The balance counts as an asset, not a debt.** `displayBalance` negates
     only `credit`/`loan`, and `normalizeBalance` only flips the sign for
     those — so the balance lands positive and net worth is overstated by
     roughly twice it, while the Debt tab never sees the account.
  Net direction: spending is UNDER-counted, income and net worth OVER-stated.
  The editor covers MANUAL accounts too: their type
  is written once at creation and never again, so a mistyped import would
  otherwise be uncorrectable forever. (It used to be SimpleFIN-only because a
  Plaid sync rewrote both columns on every pull and an edit would silently
  revert — a reason that died with Plaid.) Crossing the debt boundary re-syncs
  only FED accounts; a manual balance was typed by hand and no pull restates it.
- **Debt-tab reads degrade pre-migration**: `getDebts()`/`getBalanceSnapshots()`
  return empty shapes, with missing-COLUMN vs missing-TABLE checked SEPARATELY
  (the conflation Gotcha — conflated, a column problem silently disables the
  whole tab).
- **Debt balances: stored positive, displayed negative.** `accounts.current_balance`
  is POSITIVE = money owed for `credit`/`loan` (SimpleFIN reports negative and
  `normalizeBalance` flips it on the way in). Every place a balance is shown to a human runs it
  through `displayBalance(balance, type)` (`src/accountBalance.js`), which
  negates debts — a card reads −$5,127.97. Keeping storage positive is what
  keeps payoff amortization and utilization (`current_balance / credit_limit`)
  natural; only presentation flips.
  Display sites (grep `displayBalance(`): Overview headline, accounts list,
  account sheet, and the Debt tab's total / per-debt cards / sparkline endpoints
  in Dashboard.jsx, plus the assistant context in
  `api/_lib/spendingContext.js`, which must match or the Ask tab contradicts the
  screen. (An earlier "exactly four" count went stale the day the Debt tab
  merged — count with grep, don't trust a number here.) `fmtX` renders
  negatives as −$1,234.56.
  Manual-debt balance edits go through `updateManualBalance(account, balance)`
  — NEVER `updateAccount`, whose column whitelist DELIBERATELY omits
  `current_balance` (a fed balance is restated by every pull; adding the
  column would look like a harmless generalization and silently let edits
  fight the sync). The manual path takes the whole account ROW so the pure
  `manualBalanceUpdate` gate can prove is_manual; negative balance input is
  rejected, and the balance is ignored for depository kinds.
  `balance_snapshots` is appended from BOTH sides with OPPOSITE household_id
  conventions: the sync appends server-side with household_id EXPLICIT under
  service_role, and ONLY on balance change; a moved/first-typed manual balance
  appends CLIENT-side with household_id OMITTED so the RLS default fills it —
  per-day upsert, best-effort.
- Effective category = `user_category || mapped_category` (user override wins).
- **Effective TYPE = `user_type ??` the structural derivation** (same shape,
  2026-08-15): `transactions.user_type` is the 4-type override — see the
  linked-boundary Convention's override paragraph for the semantics and
  `src/txType.js` for the vocabulary. Client reads carry a 42703 degrade
  (`transactionsHaveUserType` in dataAdapter, the `transactionsHaveEntity`
  pattern) because a bare 42703 through `getEnvelopes` would trip
  `isEnvelopeSchemaMissing` and kill the Budget tab; the server context
  deliberately has none (a loud Ask-tab failure beats a silent fork).
- **THE APP SHIPS NO CATEGORIES (Mason, 2026-08-04; shipped 2026-08-05).** The
  user creates every category and teaches which merchants belong to it;
  `category_rules` + `merchantKey` make that automatic for every later import
  and sync. There is no seed taxonomy and no keyword guessing. This REVERSES
  the old "ERA_CATEGORIES is the taxonomy source of truth" rule: a household
  never chose those ~18 names, and forcing every merchant into one produced
  confidently-wrong answers that read exactly like correct ones (NEWREZ, a
  mortgage, in "Utilities" at ~$3.8k/mo).
- **`dash:cats` IS that system** — a NAME REGISTRY, so a category with no
  spending yet is still offered in the pickers; its `color` is only the seed
  chosen at creation, while **`dash:colors` is the one mutable colour store**,
  which is what keeps a category the same colour on the Categories tab, the
  Budget tab, the donut and every pill. Renaming is a DISPLAY ALIAS in
  `dash:names`, never a rewrite of the registry name: that raw label is what
  `user_category` / `budgets` / `budget_months` are all keyed by, and rewriting
  it orphans every one of them. Adding and retiring live in the "+ Add
  category" sheet rather than on the rows, and `src/categoryList.js` derives
  the ONE list every tab reads. All three registry rows
  (`dash:cats`/`dash:colors`/`dash:names`) are written through serialized
  read-merge-write updaters in `settingsIO.js` (the `updateRecIgnore`
  discipline; `test/settingsChains.test.js`) with rollback+alert at the
  Dashboard handlers — never a whole value rebuilt from component state, which
  let a failed mount read wipe the household's registry on the first edit. There is no "custom category" any more — no
  built-in kind survives to contrast one with.
- **ONE LEVEL of subcategories (Mason, 2026-08-05)** — "Transportation" is a
  parent, "Gas"/"Parking" are its children; totals render at BOTH levels.
  `src/categoryTree.js` is the pure core (`test/categoryTree.test.js`).
  - **A transaction stores exactly ONE label, and it is the LEAF.** The parent
    link lives ONLY in `dash:cats`, as an optional `parent` field holding the
    PARENT'S NAME. That is the whole feature's cost: **no migration, no schema
    change**, and every learned rule, `budgets`/`budget_months` row, `tax:maps`
    mapping and envelope keeps working untouched because all of them are keyed
    on the same leaf label as before. Deleting the `parent` fields returns the
    app to pre-nesting behaviour and loses nothing. Corollary: the Transactions
    chips stay leaf-level — rows only ever carry leaf labels.
  - **A parent's total = its own rows + its children's** (`groupMembers`
    includes the parent). A user who tagged rows straight to "Transportation"
    before "Gas" existed still has them; a rollup that dropped them would make
    money vanish off the tab.
  - **Money is owned at the LEAF; the parent shows a read-only rollup.**
    `available = assigned + carry − spent` needs exactly one owner per dollar —
    if both levels could hold an assignment, "Transportation has $400
    available" is ambiguous and the walk double-counts. So a parent gets no
    assignment and no target, and is skipped by Fund targets and move
    DESTINATIONS (it stays a legal move SOURCE, so a pre-nesting balance can
    get out). Mason asked for TOTALS at both levels, which the rollup gives;
    parent-level BUDGETING is a separate future decision.
  - **One level only, and never a mechanism category.** A child can't have
    children; 'Transfers and card payments' / 'Return' / 'Uncategorized' are
    neither parent nor child. Names stay globally unique
    (`isDuplicateCategoryName`) because the leaf label is what rows store — two
    "Gas" under different parents would be one category to the ledger. An
    illegal or dangling parent is DROPPED, never obeyed: the category renders
    top-level (same degrade instinct as the one-list rule).
  - **A group sorts by the number it RENDERS, not by the parent's own row**
    (review fix): `groupCategories` preserves the caller's order, so a heading
    parent with no rows of its own lands in the appended zero-spend tail and
    dragged its children below every tiny leaf. `orderGroups` re-ranks after
    grouping — by rollup on the Categories tab, by `earliestMemberRank` (the
    earliest member's walk position) on the Budget tab, whose list isn't
    ordered by magnitude. Bars divide by the largest TOP-LEVEL value, since a
    rollup can exceed every single leaf.
- **`toTxShape` stamps `counted`** = the shared `isSpend()` verdict for that
  row. Anything that lists transactions behind a total (the category drill-in)
  must split on it rather than re-deriving the rule, or the list's own sum
  drifts from the number that was tapped to open it. Same reasoning as
  `getEnvelopeSpending` aggregating through `isSpend()`.
- **A credit-card negative NETS against its category (Mason, 2026-08-17).**
  This REVERSES the rule that stood here — "'Return' (credit-card negatives) is
  never spending and never income" — which left a returned $200 jacket's
  purchase counted forever and made the refund unfileable, because the
  read-time synthesis forced it into a mechanism category hidden from every
  picker. A refund now keeps the classifier's category and SUBTRACTS from it:
  a taught merchant's refund cancels its own purchase, an untaught one lands in
  Uncategorized where the teach queue asks. It is still NEVER income (income
  counts depository inflows only). The row that must not net is money the
  household SENT the card — structural pairing washes the linked case, and
  `isCardPaymentReceived` (`txClassify.js`) vetoes the unpaired one. A
  DEBIT-card refund nets too, but ONLY through an explicit `user_type` of
  `'spending'` (Mason, 2026-08-17b) — never automatically, because nothing
  structural separates one from a paycheck (both are unpaired depository
  inflows) and an automatic rule that guessed wrong would subtract a salary
  from spending AND erase it from the Budget tab's measured income in the same
  pass. The human saying so is the discriminator the data does not carry;
  `allowedUserTypes` offers it and `txTypeLabel` renders it "Refund", which is
  what makes the choice legible rather than a mis-tap.
- **Returned income (Mason, 2026-08-19)** is the mirror on the INCOME side:
  `'inflow'` on a money-OUT depository row counts as NEGATIVE income — money
  that arrived as income and was sent back (an overpayment returned to its
  sender) lowers the month's income instead of counting as spending, which is
  what it was doing before. `cashIncome` folds `-t.amount` rather than
  `Math.abs`, so both directions sign themselves; `isIncome` admits a money-out
  row ONLY on that explicit verdict, for the same reason the debit-refund case
  needs one — nothing structural separates a returned payment from an ordinary
  outflow. It renders as plain **"Income"**, and the asymmetry with the refund
  side is deliberate (Mason, 2026-08-19: "this should be just income, not
  returned income. the negative value is what informs if the income is
  increasing or decreasing"): the sheet headlines the row's own −$960.00, so
  the SIGN already says which way income moved. A "Returned income" relabel
  shipped for a few hours and was reverted — the wording that stood here,
  "`txTypeLabel` renders it 'Returned income', never plain 'Income' on money
  leaving", is WRONG, and the lesson is that a second name for one verdict makes
  a four-type menu read as five. The refund relabel stays precisely because the
  sign CANNOT do that job there: "Spending" on −$52.10 would have to be read as
  spending going down. One relabel where the number is ambiguous, none where it
  isn't. **Income is no longer DEPOSITORY-only (Mason, 2026-08-19b: "Why is
  income depository only? Income is simply a category name that tracks
  transactions as 'income'")** — the wording that stood here, "Income stays
  DEPOSITORY-only in both directions", lasted one day. The gate landed with the
  unified model on 2026-08-03 and `user_type` did not exist until 2026-08-15, so
  the override was threaded in UNDERNEATH it; that ordering was never a decision
  about explicit verdicts, and it made income the ONE type where saying so out
  loud did nothing. `deriveTxType` has no account gate, so a credit row typed
  Income rendered the word "Income" and landed in NO total — a shipped
  label/total disagreement the agreement property test could not see, because
  its own income decomposition restated the gate (both now widened to non-loan).
  The AUTOMATIC path keeps the gate and that is the half the original reason
  defends: with no override a credit account's money-in is exhaustively
  {payment received, merchant refund}, and guessing otherwise would put $31k of
  card payments into the income line.
  `allowedUserTypes` now offers all four on EVERY non-loan row of either
  direction: with both mirrors built, no verdict is inert anywhere. "Transfers and card
  payments" is NO LONGER a blanket spending exclusion (2026-08-03): internal
  is decided by STRUCTURE (the pairing), and the category's only remaining
  totals role is the card-payment veto — see the linked-boundary model below.
- **`Uncategorized` is where every transaction STARTS**, and this design needs
  it more, not less: nothing guesses, so an untaught merchant stays there until
  a rule is learned and the size of that bucket IS the retraining backlog. It
  IS counted as spending (the money left) but is never budgetable and is never
  offered in the picker — the way to undo a wrong pick is "Reset to automatic".
  The lesson it encodes: an earlier build made "Shopping and gear" — a category
  actually in use — the fallback, so "we don't know" was indistinguishable from
  a confident answer. Never make a real category the fallback, and never
  reintroduce a guess to avoid showing this one.
- **Three "categories" are MECHANISM, not taste** — `Transfers and card
  payments` (the card-payment veto reads it; drop it and card payments count as
  spending), `Return` (the retired credit-negative label — nothing synthesises
  it since 2026-08-17; it stays in the set so any value still STORED on a row
  keeps rendering as an internal), `Uncategorized`.
  They are internals: hidden from every picker, never created/renamed/retired
  by the user, and `isBudgetableCategory` is exactly their complement.
- **CSV history must never overlap a live feed.** `csv:` and `sfin:` dedup ids
  are separate namespaces and cannot see each other, so a CSV covering dates the
  feed already has double-counts every transaction in the overlap, with nothing
  downstream able to catch it. Importing into a SimpleFIN account excludes every
  row dated on or after that account's earliest synced transaction
  (`getFeedCoverageStart` → `overlapFrom` → `isOverlap`). The boundary day
  itself belongs to the feed. This is what makes "rebuild history from CSV" safe.
- **Manual quick-add** (`QuickAddSheet`) mints `plaid_tx_id='manual:'+uuid` —
  NOT a CSV-style content hash, because a hand-typed row has no file to
  re-import against (a session "unifying" dedup ids would break this) — with
  `source='manual'` and the shared `classifyDescription` precedence. Gated to
  manual + non-SimpleFIN accounts, and EXCLUDES loan-typed manual accounts
  (`isLoanAccount` — a cash purchase parked on a loan account would vanish
  from every total, since loan rows never count as spending).
  `test/manualTx.test.js`.
- **Cross-month category browse is deliberately NOT built** (refuted, don't
  re-propose): it would add a fourth never-refetched list for
  `patchAllTxLists` to patch, and filtering by a parent needs an OR over its
  children this codebase already declines. (The ORIGINAL reason — PostgREST
  `.or()` cannot express the synthesised `Return`, present in no column —
  EXPIRED on 2026-08-17 when the synthesis was deleted. Recorded so the item
  isn't re-proposed on the strength of a dead premise.)
- **Categorization precedence at WRITE time:** transfer/card-payment guards
  (`src/txClassify.js`) → learned rule (`category_rules`) → `Uncategorized`.
  **A learned rule is the ONLY categorizer** — nothing is guessed, so an
  untaught merchant stays Uncategorized however obvious its name looks. At READ
  time `user_category` still wins over all of it. Learned rules do NOT override
  the transfer/card-payment guards — those protect spending totals, and a rule that
  made card payments count as spending would be a footgun. Both write paths
  (SimpleFIN sync and CSV import) must pass `rules`, or a corrected merchant
  reverts on the next pull. `merchantKey` drops numeric tokens only, so
  "SAFEWAY #1234" and "SAFEWAY 8892" collapse but "COSTCO GAS" and
  "COSTCO WHSE" stay distinct; matching is exact or whole-token prefix,
  longest rule wins. Because rules are the ONLY categorizer, a SURVIVING rule
  re-mints a deleted category onto the next synced row — any category
  wipe/retire must delete its `category_rules` too (why the 20260805 wipe
  cleared the rule table).
- **A learned rule may be scoped to an exact AMOUNT (2026-08-05, Mason's
  case).** `category_rules.amount` is null for the ordinary merchant-wide rule
  and a number — app convention, positive = money out — for a rule that only
  claims rows at that exact amount. The case that forced it: "Zelle Transfer"
  is rent at $1,800.00 and a dozen unrelated things at every other amount, so
  the merchant-wide rule is WRONG for most of the merchant's rows and teaching
  it would silently recategorize them. **An amount-scoped rule outranks EVERY
  any-amount rule, even one with a longer key** — key length only breaks ties
  within a tier. The narrow rule is a deliberate assertion about one recurring
  payment and must survive beside the generic rule for the same merchant, which
  would otherwise shadow it depending on how the descriptor happened to be
  worded. Amounts compare at cent precision and **the sign is significant**.
  A rules bag therefore maps key → EITHER a category string (the legacy
  any-amount shape, still read everywhere) OR an array of `{amount, category}`;
  no loader had to be rewritten. The rule table's PK could not hold a nullable
  column, so it is TWO partial unique indexes — which is also why
  `setCategoryRule` is a slot-scoped delete-then-insert rather than an upsert
  (ON CONFLICT cannot infer a partial index). Migration
  `20260805000002_category_rule_amounts.sql`, **inverted deploy order — paste
  AFTER the deploy**, since it drops the PK the old build's upsert names.
  **Known limit, pinned by a REGRESSION test in `test/txClassify.test.js`:** the
  prefix runs rule→row, so a rule is only general if the descriptor it was
  taught from was ALREADY the short form. Teach from "COSTCO GAS #0117 SEATTLE
  WA" and the key becomes `COSTCO GAS SEATTLE WA`, which matches that store and
  nothing else — not even "COSTCO GAS #0117". Every automatic fix (stem to N
  tokens, strip a trailing city/state, match both directions) trades false
  misses for false MERGES, and a confidently wrong category is the failure mode
  this codebase repeatedly refuses. The honest fix SHIPPED 2026-08-13 (the
  wording that stood here — "left as-is deliberately … if it starts to
  matter" — was retired by retraining making it matter): the learn confirm's
  **trim-the-key editor** renders the key as tap-able tokens; tapping one
  drops it and everything after it (TRAILING trim only — `isKeyPrefix` in
  `src/txClassify.js` rejects mid-key subsets, which the rule→row prefix
  match would never fire on), each trim re-runs the dry-run count through the
  same `previewSeq` guard, and Always teaches the trimmed key (passed as the
  descriptor — `merchantKey` is idempotent on its own output, so zero adapter
  changes). Generalizing stays an EXPLICIT user choice with a live match
  count — never automatic stemming. A scope toggle re-offer passes the
  current key through, so a trim survives switching Any-amount/Only-$X.
- **A card PURCHASE can never be classified as a card payment.** "Transfers and
  card payments" is excluded from spending, so a false positive there deletes
  money from every total silently. Two guards in `src/txClassify.js`: an issuer
  name (CAPITAL ONE / AMEX / DISCOVER…) must co-occur with payment wording, and
  a positive amount on a `credit` account skips the transfer rules entirely — a
  payment arrives as money *in*. Always pass `accountType` to
  `classifyDescription` where it's known. Before this, "Capital One Travel" and
  "Discover Tire and Auto" vanished from the dashboard.
- Sync upserts deliberately OMIT user-owned columns (nickname, color, hidden,
  type/subtype on existing rows, user_category, user_description, excluded,
  user_type, and the hand-entered debt columns APR / minimum payment /
  credit_limit / due-date) so edits survive syncs. For `user_type` the
  omission is pinned by a source scan in `test/txType.test.js` (sync + CSV;
  the manual writer's pin lives in `test/manualTx.test.js`).
- `api/` 500 handlers return a GENERIC string + a stable code — never raw
  error bodies (no error leakage; `test/apiErrorSanitize.test.js`).
- Account labels: `nickname || "name ··mask"`; badge color from `ACCOUNT_COLORS`
  by index when `color` is null.

### ONE spending/income model: linked-boundary (Mason, 2026-08-03 — replaces the two-model design)
Mason explicitly relitigated the old "two models, don't unify" and "keep the
depository↔depository wash restriction tight" doctrines after the 2026-08-01
mass account attach invalidated their premise: the "personal" accounts got
linked, and the wording-gated wash let $23k/quarter of cross-bank
self-transfers count as spending AND income (the F1 double count — see PR #32).
Every surface — Categories tab, Overview headline, budgets, envelopes,
`toTxShape.counted`, AND Trends — now reads ONE model, so Trends and
Categories agree on spending by construction.

- **Internal is decided by STRUCTURE, not wording.** `markInternalTransfers`
  (`src/cashFlow.js`) pairs a positive (money out) row with an equal-amount
  negative (money in) row on a DIFFERENT visible linked account within 4 days —
  across ALL account-type combinations EXCEPT loan accounts, which never
  participate (so a mortgage/auto payment's depository leg stays unpaired and
  counts as spending — Mason's decision: loan payments ARE spending even though
  the loan is linked). No `raw_category`/`TRANSFER_RE` gate anymore. A matched
  pair is `_internal`: excluded from income and spending. Pairing is still a
  maximum bipartite matching (Kuhn's, per equal-amount bucket, sorted inputs,
  brute-force parity pinned in `test/cashFlow.test.js` across mixed types).
- **Spending** = `isSpend()` (`src/spending.js`, the ONE predicate): unpaired
  positive rows on non-loan accounts — card purchases, depository outflows,
  transfers that LEAVE the boundary (to an unlinked or **hidden** account;
  hidden = unlinked for boundary purposes, their own rows stay query-excluded)
  — MINUS card payments: `isCardPaymentRow` vetoes an unpaired
  card-payment-worded row (`isCardPaymentDescriptor` in txClassify, or an
  explicit `user_category` of the transfer bucket), because card payments never
  count even when the card is unlinked (Mason). This NARROWS the transfer
  category's meaning: an unpaired transfer-WORDED row counts (it crossed the
  boundary); only the card-payment verdict excludes. Loan accounts' own ledger
  rows never count (`isLoanAccount` — the counted leg is the depository
  payment).
- **Income** = `isIncome()` (`src/cashFlow.js`, the ONE income predicate —
  `isSpend`'s counterpart). AUTOMATICALLY: unpaired depository inflows (checking
  or savings), money in from outside the boundary; an un-overridden credit
  negative is a refund or a payment received, never income (since 2026-08-17 a
  refund is negative SPENDING while a payment received is vetoed out of both).
  BY EXPLICIT VERDICT (2026-08-19b): `'inflow'` counts on ANY non-loan account
  and in either direction — see the returned-income Convention for why the gate
  moved below the override. The two paths must stay distinguishable: widening
  the AUTOMATIC one is what would put card payments in the income line. `cashIncome`
  is the fold over it and the ONLY thing that sums; every surface needing the
  verdict for one ROW — the Reflect income drill-in — asks the predicate rather
  than restating the rule, the same discipline `isSpend`/`sumSpending`/`counted`
  enforce on the spending side.
- **`cashSpending` delegates to `sumSpending`** — kept under its old name for
  importers. Trends' Cash flow section = income − spending per month.
- **The pairing is part of the row pipeline**: `getTransactionsBetween` always
  runs `markInternalTransfers` (the envelope walk included — it no longer skips
  it; per-amount bucketing + binary-searched windows keep it near-linear).
  `counted` is stamped where the month's rows are assembled; single-account
  reads (account sheet, search) can't pair and may over-report `counted` on a
  transfer leg — their lists don't render it.
- **The 4-type override (2026-08-15, Mason — YNAB vocabulary):**
  `transactions.user_type` ∈ `spending|inflow|transfer|card_payment`, null =
  automatic. It routes THROUGH the shared model, never beside it: rows with a
  non-null override are DROPPED from `markInternalTransfers`' candidate pool
  (an explicit verdict never pairs — which is the false-wash fix: override one
  leg and the former partner re-derives structurally), and `isSpend` /
  `cashIncome` read the column directly (NOT via an `_internal` stamp —
  `_internal` only exists on row sets that went through pairing, and the
  account sheet / search never pair). Precedence: `excluded` > loan > SIGN >
  `user_type` > structure. On money-in the sign no longer ANSWERS, it ROUTES
  (2026-08-17): an EXPLICIT verdict decides first, so `'spending'` on a
  money-in row means "this is a refund, net it" on EITHER account type — and
  on a depository row that override is the ONLY way a debit-card refund can
  ever net (Mason, 2026-08-17b). Without an override, only a CREDIT negative
  nets automatically; a depository inflow defaults to income. (The wording here
  used to read "the sign guards outrank the override, `'spending'` on money-in
  is never honored"; both halves of that are now retired.) Loan rows ignore the
  override entirely (a later retype to loan must not resurrect it), and a
  non-null override beats BOTH card-payment vetoes. `'inflow'` on a credit negative
  used to keep the row out of BOTH totals — "this is not a refund" — and since
  2026-08-19b it counts as income instead; that escape hatch survives intact via
  `'transfer'` and `'card_payment'`, which behave identically and, for a payment
  received, say it more accurately. `allowedUserTypes` needed no change: it
  already offered all four on every non-loan row, which is precisely how the
  label/total disagreement arose. Display: derived type restates these verdicts
  (`deriveTxType`), with one refinement — a PAIRED leg on a credit account or
  with payment wording displays Card payment, not Transfer (display-only;
  totals identical). `user_type` is user-owned (sync-omit Convention) and
  written only through `updateTransaction` (null = reset to automatic, the
  `user_category` shape). Every read feeding the model selects it —
  `TX_COLUMNS`/`SPEND_TX_COLUMNS` + both `spendingContext.js` selects; the
  agreement property test in `test/txType.test.js` is what makes a missed
  select a red test instead of a silently forked surface.
- **A Transfer / Card-payment row's category IS its type (Mason, 2026-08-17):**
  "Transfer and credit card payment transactions can't have an additional
  category." Enforced as ONE READ — `displayCategory` (`src/spending.js`),
  minted into every row shape by `toTxShape`/`patchTxShape` and mirrored
  post-pairing in the assistant context — so the rule lands on the Review
  badge, the teach queue, the chips, the category drill-in, recurring detection
  and the tax worksheet at once, instead of each surface re-deciding. It reads
  the EFFECTIVE type, so it covers both a structurally paired leg and a
  hand-typed one. **Nothing is written**: `user_category` survives untouched,
  because null-equals-automatic has to stay reversible (reset the type and the
  category comes back), because clearing could not have achieved the rule
  anyway (`mapped_category` carries a real category on a hand-typed transfer —
  the write-time guard only fires on transfer WORDING, and
  `applyRuleToHistory` rewrites that column with no guard), and because
  `isCardPaymentRow` reads `user_category` as a VERDICT, so clearing it
  mid-save would move the derivation the stored override is compared against.
  Loan rows are deliberately OUT of the lock (they never count either way and
  keep an editable category), and a credit-card REFUND is out too — it derives
  `'spending'` and nets against the category it is locked out of otherwise.
- The OPPOSITE failure — a genuine pair that did NOT wash, so its legs count as
  spending AND income at once — is what `nearMissTransfers` (`src/reconciliation.js`
  key row) surfaces; no balance check can see it, because the money really moved.
- Accepted trade, deliberate: an accidental equal-amount coincidence within 4
  days across two accounts washes falsely. Judged rarer and cheaper than the
  wording-dependence it replaces. Since refund netting (2026-08-17) that trade
  costs TWO numbers rather than one: a refund enters the pairing pool as an
  "in", so a false wash both deletes the unrelated outflow AND silently
  suppresses the netting. Still accepted; narrowing the pool is its own
  decision. (A purchase and its refund on the SAME card can never wash each
  other — `markInternalTransfers` refuses a same-account pair — which is what
  makes the jacket case net at all.)
- **Assistant model/effort** is user-selectable; `src/assistantModels.js` is the
  shared allowlist (Haiku 4.5 / Sonnet 5 / Opus 4.8) + `estimateCostRange`. The
  server validates the choice and only sends `thinking`/`effort` to models that
  support them (Haiku 4.5 predates both — sending them 400s). Requires
  `ANTHROPIC_API_KEY` in Vercel (else the Ask tab shows "not configured").
  Burn-rate control (Mason, 2026-08-04): the in-code throttle stays BEST-EFFORT
  PER-INSTANCE — the $25/mo console spend cap (email alert at $10) REPLACES a
  durable limiter; don't build one. The ALERT is the load-bearing half: a
  silent cap just reads as "the Ask tab stopped working".

### Category nesting (one level — decided 2026-08-05, don't relitigate)
- **A transaction stores ONE label and it is the LEAF.** A gas purchase is
  tagged `Gas`, never `Transportation/Gas` and never both. The parent lives
  ONLY in the `dash:cats` registry, as an optional `parent` field holding the
  PARENT'S NAME. That is why the feature needed **no migration and no schema
  change**, and why every learned rule, `budgets`/`budget_months` row, tax
  mapping and envelope kept working untouched — all of them are keyed on the
  same leaf label as before. Deleting every `parent` field returns the app to
  its pre-nesting behaviour and loses nothing.
- **Totals at BOTH levels is the feature.** A parent's total is own + children
  (`groupMembers` includes the parent, so rows tagged to it before its children
  existed still count — dropping them would make money vanish off the tab), and
  tapping a parent's number drills into ALL of those rows: the tap-a-number
  rule, unchanged.
- **Budgets/envelopes are assigned at the LEAF; a parent shows a read-only
  rollup.** `available = assigned + carry − spent` needs exactly one owner per
  dollar — with assignments at both levels, "Transportation has $400 available"
  is ambiguous and the walk double-counts. A parent takes no assignment, no
  target and is no move DESTINATION (it stays a legal move SOURCE, so a
  pre-nesting balance can be moved out rather than stranded; that balance still
  renders, read-only, inside the group). **Parent-level budgeting is a separate
  future decision, not an oversight.**
- **One level only, and mechanism categories are never a parent or a child.**
  Names stay globally unique (`isDuplicateCategoryName`) because the leaf label
  is what transactions store.
- **The Transactions chips stay LEAF-level** — rows carry leaf labels, so a
  chip row derived from the rows in view can only contain leaves. Filtering by a
  parent would need an OR over its children: the same cross-month browse this
  codebase already declines.
- Nesting adds NO second answer to "what categories exist": `userCategoryList`
  is unchanged and nesting only decides how those same names are ARRANGED,
  which is what keeps Categories, Budget and the chips in agreement.

### Envelope budgeting (decided — don't relitigate)
The Budget tab's model. `available = assigned + carry − spent`, walked from each
category's own first assignment; the pure core is `src/envelopes.js`.

- **A missing `budget_months` row means `assigned` 0. Never fall back to
  `monthly_limit`.** Falling back makes every month nobody touched accrue
  `(limit − spent)` into the carry and manufactures a phantom balance on day
  one. Assignments only ever come from an explicit user action, so the number on
  screen always equals the number the walk rolls forward. (Caught in review
  before it shipped; pinned by a named REGRESSION test in
  `test/envelopes.test.js`.) A **zero** assignment is likewise not an envelope —
  `moveMoney` can leave a 0 row behind, and a 0 row must stay equivalent to no
  row, or the category would start walking from there and turn its earlier
  ordinary spending into rolled-over debt.
- **Envelopes use the shared `isSpend()`** (the unified linked-boundary
  predicate, including the loan-account guard) — the same fold the Categories
  bars read, so Spent can never disagree with the bar beside it.
- **`Uncategorized` (and the transfer bucket) can't be budgeted** —
  `isBudgetableCategory` gates assignments, targets, moves and the picker; its
  spending still renders read-only so the size of the unknown stays visible.
- **Overspend carries the category negative.** Real YNAB instead docks next
  month's Ready to Assign on *cash* overspending and only rolls credit-covered
  overspend negative. With no cash-vs-credit envelope split, carrying negative
  is the only coherent choice — a simplification, not fidelity.
- `assigned` / targets are plain positive dollars, **outside** the
  `positive = money out` sign convention (only Spent carries the sign).
- Envelope tables key on the **raw** category label, like `budgets`.
- **Don't put a date clamp on the walk.** A rolling balance is every assignment
  and every dollar spent since the envelope opened, so the walk starts at each
  category's *own* first assignment, however old. A 24-month window was tried
  and reverted: it froze a long-running sinking fund at a stale balance that
  drifted further every month. `budget_months` is paginated for the same
  reason — a row cap would silently drop real dollars. `MAX_WALK_MONTHS` is
  only a runaway guard on the loop, and tripping it sets `truncated` rather than
  quietly returning nothing.
- **RTA income is per-month and never carried between months.** A carry-forward
  would compound every month the user left blank. One month in, one month out.
  Since 2026-08-13 the figure is HYBRID, not purely hand-entered — see the
  hybrid-income Convention below (typed for the month in progress, measured for
  a completed covered month).
- The walk reads only the columns `isSpend()` needs (now incl. `account_id` +
  descriptors) and, since 2026-08-03, RUNS `markInternalTransfers` — the
  unified `isSpend()` reads `_internal`. Per-amount bucketing keeps the
  matching near-linear over the budgeting history.
- A by-date target **forces rollover on** — a sinking fund only reaches its
  number because leftovers carry; with rollover off it would ask for the full
  share forever and never converge.
- **Per-month target override (Session 6):** `budget_months.target_override`;
  effective target = `target_override ?? budgets.monthly_limit`
  (`effectiveTarget`). The zero-row-equivalence rule applies to ASSIGNED only:
  **a row with `assigned = 0` and a non-null `target_override` is a REAL row**
  — `setAssigned(…, 0)`'s delete is conditional so it can't drop one. Targets
  never enter the carry walk (containment pinned by the byte-identity test).
  Pre-migration: a 42703 naming `target_override` retries the old columns
  inside `getAssignmentsThrough` and must NEVER trip `isEnvelopeSchemaMissing`
  (which reads 42703 as "envelopes not installed" and would kill the tab).
- **Auto-fill copies ASSIGNED only** (`planAutoFill`): pull viewed−1 into the
  viewed month, skip zeros (0 row ≡ no row) and categories already assigned —
  never `monthly_limit`, never targets. Two-step (plan → confirm), and the
  preview is month-key-guarded so a stale promise can't render the old month
  pair's plan under new labels (the movers month-tagging lesson).
- **Expected transactions are DISPLAY-ONLY** (the `envelopePace` contract):
  never in Available, the walk, or any spending/income total — a matched row
  just points at its real transaction. Opt-in seeding (Recurring "Expect"),
  never automatic; nothing auto-dismisses (the unmatched bill IS the alarm).
  Roll-forwards are dup-gated on BOTH keyed rows (`isDuplicateExpected`) and
  null-key hand-typed rows (`isDuplicateRollForward`) so two devices'
  concurrent auto-match passes can't double a bill. The ✕ on a recurring
  expectation opens Skip-this-cycle / Stop-expecting — the stop path
  (`dismissExpected {stop:true}`) must stay reachable or a cancelled
  real-world bill is permanent (the pre-Restore-unlink mis-tap shape). Reads
  return null pre-migration (`getReceiptTxIds` pattern); the Dashboard cache
  is an epoch counter, and a failed load RETURNS the epoch (seq-guarded) so a
  transient error retries on the next tab visit instead of hiding the feature
  for the session.

**The HYBRID income rule (Mason, 2026-08-13 — opens the old "income wall"
halfway; the pure hand-entered rule that stood here is superseded):** Ready to
Assign needs trustworthy income, and the two halves of a month's timeline earn
trust differently. The month IN PROGRESS (and any future month) budgets on the
HAND-TYPED figure — its paychecks haven't all landed, so a measured number is
guaranteed-low exactly while it's the one being budgeted against. A COMPLETED
month switches to ACTUAL income measured from the ledger, automatically:
`resolveBudgetIncome` (src/envelopes.js, pure, `todayKey` = wall clock — the
paceToday pattern) picks the figure; `getActualIncome` (dataAdapter) measures
via the shared `cashIncome` model over the CALENDAR-MONTH pairing (the
Overview/Categories window — it can diverge from Trends' income for the same
month only on a window-edge transfer pair, the documented honest edge, since
`getCashFlow` pairs across its whole 6-month fetch). The typed figure survives
as the PLAN, rendered beside the actual ("actual · planned $X"); a completed
measured month is READ-ONLY — offering the editor would be a trap (an edit
that visibly changes nothing). The old wall's honesty survives as the
fallbacks, both pinned in `test/envelopes.test.js`: a completed month derives
ONLY when the ledger covers it (coverageStart — the earliest visible
depository row — on/before the month's 1st; else missing history would read as
$0 income), and a failed/absent actual read falls back to manual rather than
blanking RTA. Pre-backfill months (before ~Feb 2026) therefore stay manual
forever. The Dashboard's `actualInc` state is MONTH-TAGGED (`{y,m,…}` — the
movers month-tagging lesson).

### Rental tracking + tax lens (Tax tab — decided, don't relitigate)
- **Entities are a LENS, not an exclusion.** A transaction tagged to a rental
  property still counts in household spending — the Tax tab re-reads the same
  rows through a Schedule E mapping. Don't "fix" rental spend showing in
  Categories by filtering entity rows out of the spending model (singular
  since 2026-08-03 — the "purchase-based AND cash-flow" phrasing that stood
  here was the pre-unification two-model design); if that's ever wanted it's a deliberate decision
  for Mason, taken separately.
- **Effective entity at READ time = `tx.entity_id ?? account.entity_id`.**
  The account column is the default for a dedicated rental account; the row
  column is the override for rental expenses paid from a shared account. Both
  are USER-OWNED like `user_category` — the sync and the importers never write
  them, which is what makes assignments survive re-pulls. Copied from Monarch's
  design: entity attribution is orthogonal to categories (no recategorizing
  needed, and category edits never move a row between properties). Display
  rule: a property `Pill` renders ONLY on rows tagged BY HAND (`t.entity_id`);
  rows inheriting the account-level default are DELIBERATELY unmarked — don't
  "fix" the inconsistency by marking inherited rows.
- **Capital expenses never reach a Schedule E expense line.** `is_capital`
  pulls a row out of the mapped lines into its own list (improvements are
  depreciated, not deducted — line 18 is deliberately not mappable); the flag
  plus `placed_in_service`/`useful_life_years` are user-owned columns on
  `transactions`, edited in the detail sheet.
- **Unmapped money is VISIBLE, never guessed** — same philosophy as
  `Uncategorized`: the worksheet shows an amber "not on any line yet" bucket
  instead of silently dropping rows (Quicken's tax export drops unmapped rows;
  that is the bug not to copy). Unmapped money IN on an entity counts as rents
  received by default. Category→line mappings live per entity under the ONE
  `tax:maps` settings key (`{emap:{entityId:{cat:line|'rents'}},dmap:{...}}`)
  and are **entirely user-made** — `DEFAULT_SCHEDULE_E_MAP` was EMPTIED to
  `{}` with the taxonomy (2026-08-05): the constant survives as the callers'
  `??` fallback meaning "no mappings"; no category is pre-mapped to a line. The Schedule E
  category→line PICKER filters on `isBudgetableCategory` PLUS any category
  already carrying an explicit mapping — a pre-wipe mapping stays visible and
  REMOVABLE rather than becoming an invisible authority over line totals
  (mapping `Uncategorized`, the app saying it does not know, would assert
  something false on a preparer's worksheet). The amber bucket itself is
  deliberately NOT filtered — narrowing a PICKER must never make money vanish
  from the WORKSHEET; mechanism labels there just get a sentence saying they
  need a real category first.
- The whole tab is **record-keeping for the preparer, not tax math**: no AGI
  floors, no depreciation schedules, no estimated-tax computation. The UI says
  "not tax advice" and it should stay true. `MILEAGE_RATES` in
  `src/taxReport.js` is effective-dated DATA that goes stale — verify against
  irs.gov each January (2026 split mid-year: 72.5¢ → 76¢ on Jul 1).
- The `entities` table allows `kind='business'` (schema only) so a future
  side-business/Schedule C build can reuse all of this without a migration;
  the UI is rental-first on purpose. CSV export goes through the share sheet
  on iOS (blob-anchor downloads are unreliable in the installed PWA).
- **No learned rule sets an entity — deferred, not forgotten.** A
  merchant→property rule would false-merge on mixed merchants (HOME DEPOT is
  both the rental's roof and the household's shelves), and a silently
  mis-attributed expense on a tax worksheet is the confidently-wrong failure
  this codebase repeatedly refuses. Account-level default + per-row tagging is
  the deliberate v1; revisit only as its own decision.
- **Two review lows live unfixed in the applied migration** (append-only
  history, so recorded here instead): `mileage_log.entity_id` CASCADEs on
  entity delete while `transactions.entity_id` SET NULLs — unreachable today
  because the UI archives entities and nothing deletes them; if deletion ever
  gets a path, first ship a migration flipping the mileage FK to `set null`.
  And `transactions_entity_idx`'s comment credits the tax-year scan, but the
  client filters entities in JS — the index's real work is backing the FK's
  SET NULL lookup.

### Receipt capture (decided, don't relitigate)
The app's ONLY use of Supabase **Storage** — everything else is Postgres.

- **PRIVATE bucket `receipts`, signed URLs minted per render, never stored.**
  Receipts are financial documents; a public bucket would make every path a
  permanent unauthenticated URL. 1h expiry outlives any open sheet. Object
  paths are `<household_id>/<transaction_id>/<uuid>.<ext>` — the leading
  household segment is what the storage policy scopes on.
- **The `receipts` TABLE is the source of truth — never `storage.list()`.**
  Listing a bucket is not a query, and the row carries the transaction link.
- **The storage object does NOT cascade with the row.** Storage objects aren't
  foreign-keyable, so the UI deletes the OBJECT FIRST, then the row: a
  half-finished delete leaves a listed receipt whose image 404s until retried,
  never an invisible orphan. Rare orphans (~200 KB) are accepted rather than
  reconciliation machinery.
- **User-owned by construction** — sync and the importers never touch receipts,
  so attachments survive re-pulls without needing an omit-from-upsert rule.
- **`getReceiptTxIds()` returns `null`, not an empty Set, pre-migration**, so
  the Tax tab can tell "no receipts yet" from "the feature isn't installed" and
  switch the "no receipt" nag + the CSV column OFF instead of flagging every
  capital expense. Same reasoning as the `Uncategorized` visible-unknown rule
  applied in reverse: don't assert an absence you can't see.
- **`ReceiptSection` is deliberately OUTSIDE the `saveTx` optimistic-patch
  discipline.** Receipts aren't a `transactions` column, so no tx list renders
  them and there is nothing to patch — the sheet is the single reader. It
  reports `onChanged` → `invalidateTax` only because the Tax tab's nag reads
  the id set.
- **No `capture` attribute on the file input.** Its mere presence makes iOS open
  the camera directly and skip the Take Photo / Photo Library chooser — but a
  receipt snapped at the store and attached at home is the common case. Also
  never list `image/heic` in `accept`: withheld, iOS transcodes to JPEG itself;
  listed, it hands over a real HEIC that canvas can't decode.
- **`addReceipt` is the app's only `supabase.rpc()` call** — it needs the
  household id to build the storage path, which the client otherwise never
  holds (RLS defaults fill it on table inserts). `current_household_id()` is a
  public security-definer function, so PostgREST exposes it; the value is
  cached per session. A future schema tidy that moves that function out of
  `public` or revokes execute would break uploads ONLY, and silently.
- **The `storage.objects` policy may not be creatable from the SQL Editor** —
  on hosted Supabase that table is owned by `supabase_storage_admin`, so
  `create policy` can fail with 42501. The migration wraps it in a DO block
  that raises a NOTICE with Dashboard instructions instead of half-applying.
  **But the SQL Editor doesn't SHOW notices** (see Gotchas) — verify with a
  `pg_policies` SELECT, don't trust "Success", and round-trip one real upload
  before believing receipts work. On THIS project the Editor's `postgres` role
  turned out to hold the privilege (the bare DDL succeeded, 2026-07-31, so the
  DO block's 42501 guard had likely never fired) — keep the guard anyway; a
  fresh install elsewhere can still hit it.

