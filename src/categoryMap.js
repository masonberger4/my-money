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
];

const TRANSFER_CATEGORY = 'Transfers and card payments';
const RETURN_CATEGORY = 'Return';

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
        console.warn(`[categoryMap] Unmapped Plaid category: ${key} → defaulting to "Shopping and gear"`);
      }
      return 'Shopping and gear';
    }
  }
}

export function isTransferCategory(category) {
  return category === TRANSFER_CATEGORY;
}

export function isReturnCategory(category) {
  return category === RETURN_CATEGORY;
}

// Moving money between the household's own accounts (BECU checking ↔ savings)
// or paying down a card/loan — never real spending or income. Checked against
// the stored `raw_category` (Plaid's `detailed` value, which is prefixed by its
// primary, e.g. TRANSFER_IN_ACCOUNT_TRANSFER, TRANSFER_OUT_SAVINGS,
// LOAN_PAYMENTS_CREDIT_CARD_PAYMENT). INCOME is deliberately NOT included: it
// lands in the same mapped "Transfers and card payments" bucket but is genuine
// income and must still count. Timing-independent, so a transfer whose two legs
// post on different days is still handled (unlike amount/date matching).
export function isInternalMovement(rawCategory) {
  const c = (rawCategory || '').toUpperCase();
  return (
    c.startsWith('TRANSFER_IN') ||
    c.startsWith('TRANSFER_OUT') ||
    c.startsWith('LOAN_PAYMENTS')
  );
}

// A negative amount on a credit-card account is a refund / statement credit /
// cashback — not income, not spending. Surface it as its own "Return" line.
// Depository negatives stay as-is (those are real deposits).
export function applyAccountRules(category, amount, accountType) {
  if (accountType === 'credit' && amount < 0) return RETURN_CATEGORY;
  return category;
}
