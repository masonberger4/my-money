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

const TRANSFER_CATEGORY = 'Transfers and card payments';
const RETURN_CATEGORY = 'Return';
export const UNCATEGORIZED = 'Uncategorized';

// Categories that exist for bookkeeping rather than budgeting. A budget on
// "Uncategorized" would be a budget on the classifier's ignorance.
export function isBudgetableCategory(category) {
  return category !== UNCATEGORIZED && category !== TRANSFER_CATEGORY;
}

const unmappedWarned = new Set();

export function mapPlaidCategory(primary, detailed) {
  const p = (primary || '').toUpperCase();
  const d = (detailed || '').toUpperCase();

  switch (p) {
    case 'FOOD_AND_DRINK':
      if (d.includes('GROCERIES')) return 'Groceries';
      if (d.includes('COFFEE')) return 'Coffee and snacks';
      if (d.includes('RESTAURANT') || d.includes('FAST_FOOD')) return 'Dining out';
      return 'Dining out';

    case 'TRANSPORTATION':
      if (d.includes('TAXIS_AND_RIDE_SHARES')) return 'Ride shares';
      if (d.includes('PUBLIC_TRANSIT')) return 'Public transit';
      if (
        d.includes('GAS') ||
        d.includes('PARKING') ||
        d.includes('TOLLS') ||
        d.includes('MAINTENANCE')
      )
        return 'Vehicle expenses';
      if (d.includes('FLIGHT') || d.includes('HOTEL') || d.includes('TRAVEL'))
        return 'Travel and vacation';
      return 'Vehicle expenses';

    case 'TRAVEL':
      return 'Travel and vacation';

    case 'ENTERTAINMENT':
    case 'RECREATION_SERVICES':
      return 'Entertainment and subscriptions';

    case 'GENERAL_MERCHANDISE':
      return 'Shopping and gear';

    case 'PERSONAL_CARE':
      return 'Health and fitness';

    case 'MEDICAL':
      return 'Healthcare and pharmacy';

    case 'HOME_IMPROVEMENT':
      return 'Home maintenance and improvement';

    case 'RENT_AND_UTILITIES':
      return 'Utilities';

    case 'GOVERNMENT_AND_NON_PROFIT':
    case 'GENERAL_SERVICES':
      return 'Cash, checks, and misc';

    case 'TRANSFER_IN':
    case 'TRANSFER_OUT':
    case 'LOAN_PAYMENTS':
    case 'BANK_FEES':
    case 'INCOME':
      return TRANSFER_CATEGORY;

    default: {
      const key = `${p}|${d}`;
      if (!unmappedWarned.has(key)) {
        unmappedWarned.add(key);
        console.warn(`[categoryMap] Unmapped Plaid category: ${key} → "${UNCATEGORIZED}"`);
      }
      // Was "Shopping and gear", for the same bad reason the keyword table used
      // it: an unmapped code is not shopping, it's unknown. Say so.
      return UNCATEGORIZED;
    }
  }
}

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
