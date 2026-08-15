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

// Which overrides the selector may WRITE for a row — the UI mirror of the
// model's sign-guard precedence (isSpend keeps amount <= 0 -> false ahead of
// the override read, cashIncome the inverse), so the menu can never offer a
// verdict the totals would silently ignore:
//   money-out rows: 'inflow' is inert   -> not offered;
//   money-in rows:  'spending' is inert -> not offered;
//   loan rows: the model ignores user_type entirely -> nothing offered.
// The sheet renders the missing option disabled with a one-line reason.
export function allowedUserTypes(t) {
  if (isLoanAccount(t)) return [];
  return t.amount > 0
    ? ['spending', 'transfer', 'card_payment']
    : ['inflow', 'transfer', 'card_payment'];
}
