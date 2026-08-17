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

// Display labels — YNAB's vocabulary exactly. 'loan' is the display-only
// fifth value deriveTxType can return; it is never storable.
export const TX_TYPE_LABELS = {
  spending: 'Spending',
  inflow: 'Inflow',
  transfer: 'Transfer',
  card_payment: 'Credit Card Payment',
  loan: 'Loan',
};

// The label a row's type renders under. Identical to TX_TYPE_LABELS except for
// one case: a money-IN row that counts as spending is a REFUND (2026-08-17).
// deriveTxType has to call it 'spending' so the rendered type and the totals
// agree — it subtracts from a category — but printing "Spending" on money
// coming back reads as a bug. Display-only, exactly like 'loan': the stored
// vocabulary stays the four TX_TYPES.
export function txTypeLabel(type, amount) {
  if (type === 'spending' && amount < 0) return 'Refund';
  return TX_TYPE_LABELS[type] || type;
}

// Which overrides the selector may WRITE for a row — the UI mirror of the
// model's precedence, so the menu can never offer a verdict the totals would
// silently ignore:
//   money-out rows: 'inflow' is inert   -> not offered;
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
  if (t.amount > 0) return ['spending', 'transfer', 'card_payment'];
  return ['spending', 'inflow', 'transfer', 'card_payment'];
}
