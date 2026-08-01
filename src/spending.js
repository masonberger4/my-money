// The purchase-based spending model, extracted pure (no Supabase/React) so it
// is importable from plain Node — the same move that produced cashFlow.js,
// envelopes.js and taxReport.js. dataAdapter.js does the I/O and delegates
// here; it re-exports these helpers so existing importers keep working.
//
// IMPORTANT SCOPE NOTE: hidden-account exclusion is NOT here, deliberately.
// It lives at the QUERY level (`accounts!inner … .eq('accounts.hidden',
// false)` in dataAdapter.js), so this layer never sees hidden rows in
// production. Do not add a hidden check to isSpend — the decided design is
// that every read the totals are built from already receives only unhidden
// rows (test/helpers/ledger.js models that contract with visibleRows()).
//
// Rows are expected in the post-join query shape: the raw transaction columns
// plus `t.accounts = { type, subtype, … }` from the accounts join. toTxShape's
// `counted` needs accounts.type (see isLoanAccount); a row missing the join is
// treated as non-loan — every caller of toTxShape selects accounts.type.

import { isTransferCategory, UNCATEGORIZED } from './categoryMap.js';

// User override wins over the classifier's answer.
export function effectiveCategory(t) {
  return t.user_category || t.mapped_category || UNCATEGORIZED;
}

// Some banks send masked descriptors ("****** *********"). Treat those as
// empty so the UI falls through to something readable.
function looksMasked(s) {
  return !!s && /^[\s*·.xX_-]+$/.test(s);
}

// The bank's own name for the row, with no user override applied — the
// counterpart to mapped_category, and what "reset name" falls back to.
export function bankName(t) {
  const merchant = looksMasked(t.merchant_name) ? '' : t.merchant_name;
  const desc = looksMasked(t.description) ? '' : t.description;
  return merchant || desc || 'Card transaction';
}

export function displayName(t) {
  return t.user_description || bankName(t);
}

// A debit on a LOAN account is a loan payment, not a purchase — and the cash
// that paid it already counts when it leaves checking, so counting it here
// double-counts the mortgage. Plaid never surfaced this (its loan accounts
// carry sparse/no transactions), but SimpleFIN ships the servicer's real
// transaction list. Note this guards `loan` ONLY: credit-card *purchases* are
// exactly what purchase-based spending is supposed to measure.
export function isLoanAccount(t) {
  return t.accounts?.type === 'loan';
}

// The purchase-based spending test. getSpending(), sumSpending() and the
// envelope walk all go through this one predicate so a category's "Spent"
// can never disagree with the bar rendered next to it. Positive = money out;
// user edits win; transfers/card payments, credit-card returns and loan
// account postings never count.
export function isSpend(t) {
  if (t.excluded || isLoanAccount(t)) return false;
  if (t.amount <= 0) return false;
  return !isTransferCategory(effectiveCategory(t));
}

export function sumSpending(txs) {
  let total = 0;
  for (const t of txs) {
    if (isSpend(t)) total += t.amount;
  }
  return total;
}

// The Categories-tab bucketing: per-category amounts/counts over isSpend()
// rows, largest first. Exactly what getSpending() returns as `groups`.
export function spendingGroups(txs) {
  const buckets = new Map();
  let total = 0;

  for (const t of txs) {
    if (!isSpend(t)) continue;
    const cat = effectiveCategory(t);
    if (!buckets.has(cat)) buckets.set(cat, { amount: 0, count: 0 });
    const b = buckets.get(cat);
    b.amount += t.amount;
    b.count += 1;
    total += t.amount;
  }

  return Array.from(buckets.entries())
    .map(([label, b]) => ({
      label,
      amount: b.amount,
      transaction_count: b.count,
      percent_of_total: total ? (b.amount / total) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
}

export function toTxShape(t) {
  return {
    id: t.id,
    plaid_tx_id: t.plaid_tx_id,
    account_id: t.account_id,
    merchant_name: displayName(t),
    description: t.description,
    transaction_date: t.date,
    amount: t.amount,
    category: effectiveCategory(t),
    auto_category: t.mapped_category || UNCATEGORIZED,
    // The un-overridden name, so an optimistic rename (or its reset) can
    // recompute `merchant_name` locally the same way displayName() does.
    // Without it the collapse into `merchant_name` is lossy and a list that is
    // never refetched — search results, the account sheet — keeps the old name.
    auto_description: bankName(t),
    user_category: t.user_category || null,
    user_description: t.user_description || null,
    excluded: !!t.excluded,
    // The row's OWN rental assignment (null = inherit the account's default —
    // resolve against accounts.entity_id where the effective value matters).
    entity_id: t.entity_id ?? null,
    is_capital: !!t.is_capital,
    placed_in_service: t.placed_in_service ?? null,
    useful_life_years: t.useful_life_years ?? null,
    // Whether this row is one of the dollars a category bar / envelope Spent is
    // made of. It rides along rather than being re-derived in the UI so a
    // category drill-in's own total can never disagree with the number that was
    // tapped to open it — same reason getEnvelopeSpending aggregates on
    // isSpend() instead of its own copy of the rule. Every caller of toTxShape
    // selects accounts.type, which isLoanAccount() needs.
    counted: isSpend(t),
  };
}

// The envelope-spending fold: per-(category, month) spend sums over the same
// isSpend() predicate the Categories bars use, so an envelope's Spent can
// never disagree with the bar rendered beside it. Keyed 'YYYY-MM' + category,
// sliced at a fixed offset rather than split on a separator — category labels
// contain spaces ("Coffee and snacks"). getEnvelopeSpending() delegates here.
export function aggregateEnvelopeSpending(rows) {
  const byKey = new Map();
  for (const t of rows) {
    if (!isSpend(t)) continue;
    const key = `${(t.date || '').slice(0, 7)}${effectiveCategory(t)}`;
    byKey.set(key, (byKey.get(key) || 0) + t.amount);
  }
  const spending = [];
  for (const [key, amount] of byKey) {
    spending.push({ category: key.slice(7), month: key.slice(0, 7), spent: amount });
  }
  return spending;
}
