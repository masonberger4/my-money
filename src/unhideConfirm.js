// Unhide type-confirm — pure, zero imports.
//
// New SimpleFIN accounts arrive hidden, and unhiding is THE deliberate act
// that confirms the account's guessed TYPE (CLAUDE.md architecture rule): the
// type is inferred from the account name at first insert, and a credit card
// mistyped as a bank account miscounts at READ time: its refunds become income
// instead of netting, a purchase worded like a card payment is vetoed out of
// spending, and its balance counts as an asset (conventions.md, "Why the type
// matters"). Its purchases count either way. This module builds the confirm
// text the Unhide button shows, so the guess is surfaced at exactly the moment
// the rule says it must be eyeballed.
// Dashboard.jsx passes the result to window.confirm; the pure layer keeps the
// wording testable.

export const TYPE_LABELS = {
  depository: 'Bank account',
  credit: 'Credit card',
  loan: 'Loan',
};

// Human label for a stored type/subtype pair. Subtype refines depository
// ("checking" / "savings"); unknown types fall back to the raw string so a
// future type is never mislabeled as something confident.
export function typeLabel(type, subtype) {
  if (type === 'depository' && (subtype === 'checking' || subtype === 'savings')) {
    return subtype === 'checking' ? 'Checking account' : 'Savings account';
  }
  return TYPE_LABELS[type] || String(type || 'Unknown type');
}

// The confirm text for unhiding `account` ({ name, mask, nickname, type,
// subtype }). Always states the type it will be counted as and why a wrong
// type matters; the caller only shows it on the Unhide direction (hiding an
// account needs no type confirmation — hidden rows leave every total).
export function unhideConfirmMessage(account) {
  const a = account || {};
  const label = a.nickname || `${a.name || 'this account'}${a.mask ? ` ··${a.mask}` : ''}`;
  const t = typeLabel(a.type, a.subtype);
  return (
    `Unhide "${label}" as ${t}?\n\n` +
    `The type was guessed from the account name and decides how its money counts — ` +
    `a credit card mistyped as a bank account counts its refunds as income, can drop purchases that look like ` +
    `card payments, and shows its balance as money you have instead of money you owe.\n\n` +
    `If ${t} is wrong, fix the type on this screen first, then unhide.`
  );
}
