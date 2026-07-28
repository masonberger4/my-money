// Tests for the pure CSV-import core (src/csvImport.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv,
  analyzeCsv,
  invalidRuleCategories,
  transferRawCategory,
  guessCategory,
  CSV_TX_ID_PREFIX,
} from '../src/csvImport.js';
import { TRANSFER_CATEGORY, FALLBACK_CATEGORY } from '../src/categoryMap.js';

// --- parseCsv: the quoted/embedded-comma cases its own comment names --------

test('parseCsv handles quoted fields with embedded commas', () => {
  assert.deepEqual(parseCsv('a,"AMAZON, INC",b'), [['a', 'AMAZON, INC', 'b']]);
});

test('parseCsv handles escaped "" quotes inside quoted fields', () => {
  assert.deepEqual(parseCsv('"he said ""hi""",x'), [['he said "hi"', 'x']]);
});

test('parseCsv handles embedded newlines inside quoted fields', () => {
  assert.deepEqual(parseCsv('"line1\nline2",y\nz,w'), [['line1\nline2', 'y'], ['z', 'w']]);
});

test('parseCsv handles CRLF row breaks and a leading BOM', () => {
  assert.deepEqual(parseCsv('\ufeffa,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
});

// --- Dedup-id idempotency ----------------------------------------------------

const HEADER = 'Date,Description,Debit,Credit';
const LINES = [
  '3/1/2026,SAFEWAY #123,45.00,',
  '3/1/2026,SAFEWAY #123,45.00,', // genuinely identical → per-day ordinal
  '3/2/2026,"AMAZON, INC",12.34,',
  '3/3/2026,PAYROLL DEPOSIT,,1000.00',
];

test('re-importing the same file yields identical plaid_tx_ids (idempotent)', () => {
  const first = analyzeCsv([HEADER, ...LINES].join('\n'));
  const second = analyzeCsv([HEADER, ...LINES].join('\n'));
  const ids = first.rows.map(r => r.plaid_tx_id);
  assert.equal(ids.length, LINES.length);
  for (const id of ids) assert.match(id, new RegExp(`^${CSV_TX_ID_PREFIX}[0-9a-f]{16}:\\d+$`));
  assert.deepEqual(second.rows.map(r => r.plaid_tx_id), ids);
  // With the first import's ids as existingIds, every re-imported row is a dupe.
  const reimport = analyzeCsv([HEADER, ...LINES].join('\n'), { existingIds: new Set(ids) });
  assert.ok(reimport.rows.every(r => r.isDuplicate));
});

test('identical rows are distinguished only by ordinal, never the file row-index', () => {
  const { rows } = analyzeCsv([HEADER, ...LINES].join('\n'));
  const [a, b] = rows.filter(r => r.description === 'SAFEWAY #123').map(r => r.plaid_tx_id);
  assert.equal(a.replace(/:\d+$/, ''), b.replace(/:\d+$/, ''));
  assert.match(a, /:0$/);
  assert.match(b, /:1$/);
});

test('ids are independent of row order within the file (distinct rows)', () => {
  // The next export can prepend rows and shift every position; ids must not
  // depend on it. (Ordinals only order genuinely identical rows, so distinct
  // rows keep the same ids under any ordering.)
  const distinct = LINES.filter((_, i) => i !== 1);
  const forward = analyzeCsv([HEADER, ...distinct].join('\n'));
  const reversed = analyzeCsv([HEADER, ...[...distinct].reverse()].join('\n'));
  assert.deepEqual(
    new Set(forward.rows.map(r => r.plaid_tx_id)),
    new Set(reversed.rows.map(r => r.plaid_tx_id))
  );
});

// --- Category-rule validation ------------------------------------------------

test('invalidRuleCategories() is empty — every rule targets a real taxonomy member', () => {
  assert.deepEqual(invalidRuleCategories(), []);
});

// --- transferRawCategory / card-payment handling -----------------------------

test('a genuine transfer descriptor gets a TRANSFER_OUT/IN raw_category by sign', () => {
  assert.equal(transferRawCategory('ONLINE BANKING TRANSFER TO SAVINGS', 500), 'TRANSFER_OUT');
  assert.equal(transferRawCategory('Online Banking Transfer From Checking', -500), 'TRANSFER_IN');
  assert.equal(transferRawCategory('ONLINE BANKING TRANSFER TO SAVINGS', 0), '');
});

test('card-payment wording is NOT tagged as an internal transfer, but still categorizes as card payment', () => {
  // BECU words its own card payments as transfers ("Online Banking Transfer To
  // VISA") — washing must never remove them, so raw_category stays '' (counted
  // as cash spending), while guessCategory still maps them to the
  // transfer/card-payment category (excluded from purchase spending).
  for (const desc of ['ONLINE BANKING TRANSFER TO VISA 1234', 'CHASE CARD PAYMENT - THANK YOU']) {
    assert.equal(transferRawCategory(desc, 500), '');
    assert.equal(guessCategory(desc), TRANSFER_CATEGORY);
  }
});

test('an ordinary merchant string gets no transfer treatment', () => {
  assert.equal(transferRawCategory('SAFEWAY #1467 EVERETT WA', 45), '');
  assert.notEqual(guessCategory('SAFEWAY #1467 EVERETT WA'), TRANSFER_CATEGORY);
  assert.equal(guessCategory('TOTALLY UNKNOWN MERCHANT 42'), FALLBACK_CATEGORY);
});

// The assertion above is SYMBOLIC — it proves guessCategory and
// FALLBACK_CATEGORY agree, not what the value is, so it passes just as happily
// if both revert to a real category. That is precisely the regression that
// matters: making 'Shopping and gear' the fallback again would silently make
// "we don't recognise this merchant" indistinguishable from a confident answer,
// which is what Uncategorized exists to prevent. Pin the value itself.
test('the classifier fallback is the honest unknown, not a real category', () => {
  assert.equal(FALLBACK_CATEGORY, 'Uncategorized');
  assert.equal(guessCategory('TOTALLY UNKNOWN MERCHANT 42'), 'Uncategorized');
  // …while a merchant we DO recognise as shopping still says so.
  assert.equal(guessCategory('NORDSTROM RACK #12'), 'Shopping and gear');
});
