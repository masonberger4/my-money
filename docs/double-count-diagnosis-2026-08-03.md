# Double-count diagnosis — 2026-08-03 (archived session record)

Context: Mason attached ALL household accounts via SimpleFIN on 2026-08-01
(previously only the joint BECU accounts were synced) and monthly spending
totals inflated. A read-only diagnosis ran the app's own pure modules over the
live rows for May–Jul 2026 (651 rows, all `source='simplefin'`); every figure
below reproduced exactly and the three-month reconciliation closed to the cent.

## Findings (verified per-month dollars)

| # | Finding | Impact | Resolution |
|---|---|---|---|
| F1 | Cross-bank Discover→BECU self-transfers counted as spending AND income — the ACH legs carry no transfer wording, so the wording-gated wash missed them and the WITHDRAWAL keyword put them in "Cash, checks, and misc" | +$6.0k/5.7k/11.3k per month to BOTH purchase-model spending and cash-flow income+spending (~$23k/quarter) | **FIXED by PR #32** — structural pairing washes them regardless of wording |
| F2 | BofA/Wells Fargo card payments counted as purchases — `CARD_ISSUER_RE` lacked both issuers; `STANDALONE_PAYMENT_RE` lacked unspaced `CCPYMT` | $616.00 / $465.93 / $27.64 doubled | **FIXED by PR #32** (regexes + regression tests on the live descriptors; structurally washed anyway) |
| F3 | Feed delivered duplicate rows with DISTINCT `sfin:` ids — upsert dedup cannot catch them. Payroll −$2,200 ×2 on 2026-07-24 (Cashback Debit); small Venture X same-day dupes (~$34 Jun+Jul) | July income ~$2,200 high | **OPEN** — verify against statements, `excluded=true` one copy (CLAUDE.md Pending) |
| F4 | "Discover it (7933)" mistyped `depository/checking` under the Capital One org; twin exists as `credit` under the Discover org | $0 today (both hidden) | **OPEN** — resolve before unhiding (CLAUDE.md Pending) |
| F5 | NEWREZ mortgage in "Utilities" via keyword rule | ~$3.8k/mo mislabeled (counted once, correctly) | **OPEN** — recategorize at leisure |
| — | Checking (2644) history ends 2026-04-03 exactly where Checking (5481) starts — likely the same real account re-keyed by the feed | none (no overlap) | **OPEN** — confirm before importing history |

Corrected totals after PR #32 (recomputed on live data): May spending
$23,869→$17,176, income $29,050→$22,750; Jun $17,642→$11,986, $16,910→$11,210;
Jul $25,237→$13,924, $32,025→$20,725. Trends now equals Categories by
construction.

## What shipped from this session

- **PR #31** — temporary Data coverage panel (Accounts tab).
- **PR #32** — the unified linked-boundary spending model (Mason's decisions:
  loan payments count as spending; card payments never count; hidden =
  unlinked). Full doctrine in CLAUDE.md Conventions.

## Decisions researched and closed

- **Statements via SimpleFIN: NOT POSSIBLE.** The protocol has no statement
  concept (four endpoints, no documents anywhere in spec/changelog/Bridge
  docs/issue tracker; the "can provide statements" wording on the link consent
  screen is MX's, whose statement product the Bridge does not pass through).
  Manual CSV/PDF import remains the mechanism and the only way to fill the
  pre-88-day `coverage_shortfall`. Re-check only if the Bridge changelog ever
  announces statements.
- **Institution hardcoding**: after PR #32, totals depend on NO institution
  wording — the issuer/keyword lists in `txClassify.js`, the type-inference
  product names in `simplefin.js`, and the BECU CSV preset only affect display
  categorization / first-run defaults, and a miss degrades to visible
  `Uncategorized`, never a wrong total. This is the open-source posture.
