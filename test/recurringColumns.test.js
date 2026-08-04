// The recurring candidate fetch is the app's largest query (~40 months —
// CANDIDATE_WINDOW_MONTHS), so it selects RECURRING_TX_COLUMNS instead of the
// wide TX_COLUMNS + tax columns (2026-08-04 perf session). These tests pin the
// narrow list against what the consumers actually read, so a future field
// added to detectRecurring's reads fails HERE instead of silently arriving
// undefined on every candidate row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RECURRING_TX_COLUMNS } from '../src/dataAdapter.js';

const cols = RECURRING_TX_COLUMNS.split(',').map(s => s.trim());

test('recurring columns carry every input of the toTxShape fields detection reads', () => {
  // detectRecurring (src/recurring.js) reads, off shaped rows:
  //   amount, category, transaction_date, merchant_name, description,
  //   account_id — plus the excluded/_internal inputs of `counted`.
  // Their raw-column inputs (toTxShape/effectiveCategory/displayName/isSpend):
  for (const need of [
    'id', // pagination tiebreaker order
    'account_id', // grouping + the transfer pairing
    'date', // transaction_date
    'amount',
    'description', // bankName fallback + card-payment veto
    'merchant_name', // bankName + normalizeMerchant key
    'user_description', // displayName — a renamed sub keeps its display name
    'mapped_category', // effectiveCategory
    'user_category', // effectiveCategory override
    'excluded', // isSpend
  ]) {
    assert.ok(cols.includes(need), `RECURRING_TX_COLUMNS missing ${need}`);
  }
});

test('recurring columns stay narrow — no tax/wide-only columns', () => {
  for (const wide of ['plaid_tx_id', 'raw_category', 'pending', 'entity_id', 'is_capital']) {
    assert.ok(!cols.includes(wide), `RECURRING_TX_COLUMNS should not carry ${wide}`);
  }
});

test('getRecurringCandidates actually passes the narrow columns', () => {
  // Source scan (the assistantModels/noPlaid precedent): the option is easy
  // to lose in a refactor, and losing it silently restores the wide read.
  const src = readFileSync(new URL('../src/dataAdapter.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function getRecurringCandidates'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /columns:\s*RECURRING_TX_COLUMNS/);
});
