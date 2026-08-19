// The 4-type transaction model's UI-facing half (2026-08-15, Mason — the
// YNAB-style redesign). The derivations live in src/spending.js, which owns
// isCardPaymentRow/isLoanAccount (one predicate family, one home — this file
// re-exports them); THIS module holds the vocabulary and the selector policy
// the detail sheet renders. Pure, zero I/O, plain-Node importable.
//
// transactions.user_type ('spending'|'inflow'|'transfer'|'card_payment',
// null = automatic) is USER-OWNED like user_category: only updateTransaction
// writes it, every feed writer omits it, and the models read it through
// isSpend/cashIncome/markInternalTransfers — never a second predicate.

import { isLoanAccount } from './spending.js';

export { TX_TYPES, deriveTxType, effectiveTxType } from './spending.js';

// Display labels — YNAB's vocabulary, except 'inflow' reads "Income" (Mason,
// 2026-08-17: "inflows should be renamed income"). DISPLAY ONLY: the stored
// value stays 'inflow', which is what the DB CHECK constraint allows
// (20260815000001_transaction_user_type.sql) and what every read in the model
// compares against — renaming the column value would need a migration and
// would break every row already stored. 'loan' is the display-only fifth value
// deriveTxType can return; it is never storable.
//
// Accepted wrinkle of the rename: a DEPOSITORY negative is income and reads
// "Income" honestly, but deriveTxType also returns 'inflow' for money-in
// shapes the model does not count as income (a loan-account negative is 'loan'
// first, so the live case is narrow) — the label is the type's name, not a
// claim about the income total. The one money-in row that never says "Income"
// is a credit-card refund, which derives 'spending' and relabels to "Refund"
// below. Pinned byte-exact in test/txType.test.js so a partial rename is red.
//
// 'inflow' on a money-OUT row (returned income) reads plain "Income" too
// (Mason, 2026-08-19: "this should be just income, not returned income. the
// negative value is what informs if the income is increasing or decreasing").
// A "Returned income" relabel shipped for a few hours and was reverted: the
// row already renders its amount signed, so the direction is on screen, and a
// second name for the same verdict makes the menu read as five types.
export const TX_TYPE_LABELS = {
  spending: 'Spending',
  inflow: 'Income',
  transfer: 'Transfer',
  card_payment: 'Credit Card Payment',
  loan: 'Loan',
};

// The label a row's type renders under. Identical to TX_TYPE_LABELS except for
// ONE case: a money-IN row that counts as spending is a REFUND (2026-08-17).
// deriveTxType has to call it 'spending' so the rendered type and the totals
// agree — it subtracts from a category — but printing "Spending" on money
// coming back reads as a bug. Display-only, exactly like 'loan': the stored
// vocabulary stays the four TX_TYPES.
//
// Deliberately NOT symmetric, and the asymmetry is the point (Mason,
// 2026-08-19). The mirror case — 'inflow' on money OUT, income given back —
// keeps the plain "Income" label, because there the SIGN already carries the
// whole story: the sheet headlines −$960.00, so "Income" plus a negative
// amount reads as income going down, which is exactly what the row is. On the
// refund side the sign cannot do that job: "Spending" on −$52.10 would have to
// be read as spending going down, and the word people actually use for it is
// Refund. One relabel where the number is ambiguous, none where it isn't.
export function txTypeLabel(type, amount) {
  if (type === 'spending' && amount < 0) return 'Refund';
  return TX_TYPE_LABELS[type] || type;
}

// Which overrides the selector may WRITE for a row — the UI mirror of the
// model's precedence, so the menu can never offer a verdict the totals would
// silently ignore:
//   money-out rows: 'inflow' is the returned-income verdict (it LOWERS the
//     month's income rather than counting as spending) -> offered, labelled
//     plain "Income" beside the row's own negative amount;
//   money-in rows: every verdict lands. 'spending' means "this is a refund,
//     net it" — automatic on a credit negative, and on a DEPOSITORY one it is
//     the only way a debit-card refund can ever net (Mason, 2026-08-17b),
//     because nothing structural tells a debit refund from a paycheck. That
//     makes it the one option a mis-tap could use to subtract a salary from
//     spending, so the sheet must keep labelling it "Refund" (txTypeLabel)
//     rather than "Spending" — the label is what makes the choice legible;
//   loan rows: the model ignores user_type entirely -> nothing offered.
// The sheet renders the missing option disabled with a one-line reason.
export function allowedUserTypes(t) {
  if (isLoanAccount(t)) return [];
  // All four on EITHER direction since 2026-08-19. 'inflow' on a money-OUT row
  // used to be withheld as inert; it is now the returned-income verdict, which
  // subtracts from the month's income instead of counting as spending — the
  // mirror of 'spending' on a money-in row meaning "refund, net it". Only the
  // refund side is relabelled (see txTypeLabel): money out under "Income" is
  // legible from its own negative amount, money in under "Spending" is not.
  return ['spending', 'inflow', 'transfer', 'card_payment'];
}
