// THE APP SHIPS NO CATEGORIES (Mason's decision, 2026-08-04).
//
// The user creates every category — the `dash:cats` registry is THE category
// system, carrying colours via `dash:colors` and rename aliases via
// `dash:names` — and teaches which merchants belong to it. `category_rules` +
// `merchantKey` (src/txClassify.js) turn that manual correction into an
// automatic rule for every later import and sync. The ~18 "taste" categories
// that used to be seeded here, and the descriptor→category keyword table that
// guessed against them, are BOTH deleted: a household never chose them, and
// forcing every merchant into one of them produced confidently-wrong answers
// (NEWREZ, a mortgage, landing in "Utilities" at ~$3.8k/mo) that read exactly
// like correct ones.
//
// ERA_CATEGORIES is therefore no longer a taxonomy. It is the MECHANISM set:
// the three internal categories the app's own models depend on, which must
// survive and must stay HIDDEN from the user's category picker. They are not
// taste and cannot be created, renamed or retired by the user.
export const ERA_CATEGORIES = [
  // Read by the linked-boundary spending model's card-payment veto
  // (`isCardPaymentRow`). Drop it and card payments count as spending.
  'Transfers and card payments',
  // Synthesised by applyAccountRules() for credit-card negatives (refunds,
  // statement credits, cashback): never spending, never income.
  'Return',
  // The "not taught yet" state, and this design needs it MORE than the old one
  // did — it is now where every transaction starts. It exists because the
  // previous fallback was "Shopping and gear", a category actually in use,
  // which made "we don't know" indistinguishable from "this is shopping" and
  // quietly inflated it (46% of a realistic merchant corpus landed there).
  // Uncategorized IS counted as spending — the money did leave — but it can't
  // be budgeted, and it shows up in the Categories tab so the size of the
  // unknown stays visible.
  'Uncategorized',
];

// Exported so csvImport/txClassify and the tests share one definition rather
// than each keeping a copy that can drift. These three names are internals —
// never offer them in the category picker and never let a user create one.
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
// "Uncategorized" would be a budget on the classifier's ignorance, and a
// budget on "Return" would be an envelope whose Spent can never move —
// Return rows are credit-card negatives, permanently excluded from spending.
export function isBudgetableCategory(category) {
  return (
    category !== UNCATEGORIZED && category !== TRANSFER_CATEGORY && category !== RETURN_CATEGORY
  );
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
