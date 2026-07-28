export const ERA_CATEGORIES = [
  'Shopping and gear',
  'Health and fitness',
  'Entertainment and subscriptions',
  'Travel and vacation',
  'Dining out',
  'Childcare',
  'Groceries',
  'Pets',
  'Healthcare and pharmacy',
  'Coffee and snacks',
  'Vehicle expenses',
  'Ride shares',
  'Public transit',
  'Home maintenance and improvement',
  'Utilities',
  'Education',
  'Side hustles and business',
  'Cash, checks, and misc',
  'Transfers and card payments',
  'Return',
  // Not a real spending category — the honest answer when the classifier does
  // not recognise a merchant. It exists because the previous fallback was
  // "Shopping and gear", a category actually in use, which made "we don't know"
  // indistinguishable from "this is shopping" and quietly inflated it (46% of a
  // realistic merchant corpus landed there). Uncategorized IS counted as
  // spending — the money did leave — but it can't be budgeted, and it shows up
  // in the Categories tab so the size of the unknown is visible.
  'Uncategorized',
];

// Exported so csvImport/txClassify and the tests share one definition rather
// than each keeping a copy that can drift.
export const TRANSFER_CATEGORY = 'Transfers and card payments';
export const RETURN_CATEGORY = 'Return';
export const UNCATEGORIZED = 'Uncategorized';

// The classifier's fallback. It is UNCATEGORIZED, not 'Shopping and gear' —
// that was the whole point of introducing Uncategorized, and this alias exists
// only so csvImport/txClassify and test/csvImport.test.js name one thing.
// Note test/csvImport.test.js asserts guessCategory(x) === FALLBACK_CATEGORY,
// which is SYMBOLIC: it proves they agree, not what the value is. The explicit
// value assertion in that file is what stops a silent revert to a real
// category. Don't remove either.
export const FALLBACK_CATEGORY = UNCATEGORIZED;

// Categories that exist for bookkeeping rather than budgeting. A budget on
// "Uncategorized" would be a budget on the classifier's ignorance.
export function isBudgetableCategory(category) {
  return category !== UNCATEGORIZED && category !== TRANSFER_CATEGORY;
}

// mapPlaidCategory lived here until Plaid was removed. It translated Plaid's
// Personal Finance Category codes (FOOD_AND_DRINK / TRANSPORTATION / …) into
// this taxonomy, and nothing produces those codes any more: SimpleFIN sends no
// category at all, and both surviving write paths — the SimpleFIN pass in
// api/sync.js and CSV/PDF import — derive `mapped_category` from the descriptor
// via src/txClassify.js instead.
//
// Historical rows keep whatever `mapped_category` was written at the time; the
// function was never called at READ time, so deleting it changes nothing that
// is already in the database.

export function isTransferCategory(category) {
  return category === TRANSFER_CATEGORY;
}

export function isReturnCategory(category) {
  return category === RETURN_CATEGORY;
}

// A negative amount on a credit-card account is a refund / statement credit /
// cashback — not income, not spending. Surface it as its own "Return" line.
// Depository negatives stay as-is (those are real deposits).
export function applyAccountRules(category, amount, accountType) {
  if (accountType === 'credit' && amount < 0) return RETURN_CATEGORY;
  return category;
}
