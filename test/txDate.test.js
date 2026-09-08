// Editable transaction dates (20260908000001): the user-owned `user_date`
// override + the generated `effective_date`, which the month reads range on;
// `date` stays the BANK's date. Pins: withEffectiveDate puts the effective
// date in `date` and parks the bank's in `bank_date`, the optimistic patch
// moves the row the way the generated column does, the client writes ONLY
// user_date, the month reads use effective_date while the bank-date reads
// don't, and no feed writer names either column (the user_type sync-omit
// precedent in txType.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toTxShape, patchTxShape, isSpend } from '../src/spending.js';
import { markInternalTransfers, INTERNAL_MATCH_WINDOW_DAYS } from '../src/cashFlow.js';
import { withEffectiveDate } from '../src/dataAdapter.js';
import { makeAccounts, makeTx } from './helpers/ledger.js';

const A = makeAccounts();
const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('withEffectiveDate + toTxShape: `date` becomes the effective date, the bank date rides as bank_date', () => {
  const plain = toTxShape(makeTx(A.checking, 'p1', '2026-08-01', 50, 'SAFEWAY 1467'));
  assert.equal(plain.transaction_date, '2026-08-01');
  assert.equal(plain.user_date, null);
  assert.equal(plain.bank_date, '2026-08-01', 'pre-migration rows read as posted on their date');

  const raw = makeTx(A.checking, 'p2', '2026-08-01', 50, 'SAFEWAY 1467', { user_date: '2026-07-31', effective_date: '2026-07-31' });
  const [row] = withEffectiveDate([raw]);
  assert.equal(row.date, '2026-07-31', 'the folds/pairing read the effective date through `date`');
  assert.equal(row.bank_date, '2026-08-01');
  const moved = toTxShape(row);
  assert.equal(moved.transaction_date, '2026-07-31');
  assert.equal(moved.user_date, '2026-07-31');
  assert.equal(moved.bank_date, '2026-08-01');
  // Pre-migration rows (no effective_date) pass through untouched.
  assert.deepEqual(withEffectiveDate([{ id: 'x', date: '2026-08-01' }]), [{ id: 'x', date: '2026-08-01' }]);
});

test('patchTxShape: a user_date edit moves transaction_date; null hands the bank date back', () => {
  const row = toTxShape(makeTx(A.checking, 'p3', '2026-08-01', 50, 'SAFEWAY 1467'));
  const moved = patchTxShape(row, { user_date: '2026-07-31' });
  assert.equal(moved.transaction_date, '2026-07-31');
  assert.equal(moved.user_date, '2026-07-31');
  assert.equal(moved.bank_date, '2026-08-01', 'the bank date survives the edit');
  const reset = patchTxShape(moved, { user_date: null });
  assert.equal(reset.transaction_date, '2026-08-01');
  assert.equal(reset.user_date, null);
});

test('the client writes ONLY user_date — never `date` — and the sheet edits through it', () => {
  const adapter = read('../src/dataAdapter.js');
  const fn = adapter.slice(adapter.indexOf('export async function updateTransaction('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(body.includes("if ('user_date' in fields) allowed.user_date = fields.user_date;"));
  assert.ok(!/allowed\.date\b/.test(body), 'updateTransaction must not write `date` — it is the bank\'s');
  assert.ok(!/allowed\.effective_date\b/.test(body), 'effective_date is generated, never written');
  const dash = read('../src/components/Dashboard.jsx');
  assert.ok(dash.includes('saveTx({user_date:v===selTx.bank_date?null:v})'),
    'the sheet date input saves through user_date (and picking the bank date is a reset)');
  assert.ok(dash.includes('saveTx({user_date:null})'), 'the reset link exists');
  // The wide AND narrow reads carry both columns: the sheet shows/resets from
  // any list, and the envelope walk buckets on the effective date.
  assert.ok(/const TX_COLUMNS =\n\s*'[^']*user_date, effective_date'/.test(adapter), 'TX_COLUMNS reads both');
  assert.ok(/const SPEND_TX_COLUMNS =\n\s*'[^']*user_date, effective_date'/.test(adapter), 'SPEND_TX_COLUMNS reads both');
});

test('month reads range on effective_date; the bank-date reads deliberately do not', () => {
  const adapter = read('../src/dataAdapter.js');
  const fn = name => {
    const i = adapter.indexOf(`function ${name}(`);
    assert.ok(i >= 0, `${name} exists`);
    const rest = adapter.slice(i);
    return rest.slice(0, rest.indexOf('\n}\n'));
  };
  for (const name of ['fetchRawBetween', 'searchTransactions', 'getAccountTransactions']) {
    const body = fn(name);
    assert.ok(body.includes('txDateCol()'), `${name} ranges/sorts on the effective date`);
    assert.ok(!/\.(gte|lte|order)\('date'/.test(body), `${name} must not range on the bank date`);
    assert.ok(body.includes('withEffectiveDate('), `${name} folds the effective date into \`date\``);
  }
  for (const name of ['getFeedCoverageStart', 'getAccountTransactionsInRange', 'getActualIncome']) {
    const body = fn(name);
    assert.ok(!body.includes('effective_date') && !body.includes('txDateCol'), `${name} stays a bank-date read`);
  }
  const ctx = read('../api/_lib/spendingContext.js');
  assert.ok(!/\.(gte|lt|lte|order)\('date'/.test(ctx), 'the assistant context buckets on effective_date');
  assert.equal((ctx.match(/date:effective_date/g) || []).length, 2, 'both context reads alias effective_date into `date`');
});

test('no feed writer names user_date / effective_date (user-owned — they must survive re-pulls)', () => {
  for (const rel of ['../api/sync.js', '../src/csvImport.js', '../src/pdfImport.js', '../src/manualTx.js']) {
    let src;
    try { src = read(rel); } catch { continue; }
    assert.ok(!src.includes('user_date'), `${rel} must not write user_date`);
    assert.ok(!src.includes('effective_date'), `${rel} must not name effective_date`);
  }
});

test('the migration installs user_date AND the generated effective_date; bootstrap checks both', () => {
  const sql = read('../supabase/migrations/20260908000001_transaction_user_date.sql');
  assert.ok(sql.includes('add column if not exists user_date date'));
  assert.ok(sql.includes('generated always as (coalesce(user_date, date)) stored'));
  assert.ok(!/create trigger/.test(sql), 'no trigger — `date` is never rewritten');
  const boot = read('../supabase/bootstrap_household.sql');
  assert.ok(boot.includes('transactions_user_date'));
  assert.ok(boot.includes('transactions_effective_date'));
});

test('accepted trade: the transfer pairing sees the EFFECTIVE date — re-dating a leg out of the window un-pairs it', () => {
  // Two legs of a real transfer, bank-dated a day apart: they wash.
  // No transfer WORDING on purpose (the F1 case): the pairing must be the
  // only reason the out leg is washed, or the test proves nothing.
  const out = makeTx(A.checking, 'w1', '2026-08-01', 500, 'WITHDRAWAL 88213');
  const inn = makeTx(A.savings, 'w2', '2026-08-02', -500, 'DEPOSIT 88213');
  assert.equal(isSpend(out), true, 'unpaired, the out leg is plain spending');
  const paired = withEffectiveDate([out, inn]);
  markInternalTransfers(paired);
  assert.equal(isSpend(paired[0]), false, 'the out leg is washed');
  // The household moves the out leg well past the window: the pairing
  // follows the effective date (the row lives where it was put), so both
  // legs stand alone — documented in the two-dates Convention.
  const far = `2026-07-${String(31 - INTERNAL_MATCH_WINDOW_DAYS - 1).padStart(2, '0')}`;
  // Fresh rows: markInternalTransfers stamps `_internal` in place above.
  const out2 = makeTx(A.checking, 'w1', '2026-08-01', 500, 'WITHDRAWAL 88213', { user_date: far, effective_date: far });
  const inn2 = makeTx(A.savings, 'w2', '2026-08-02', -500, 'DEPOSIT 88213');
  const moved = withEffectiveDate([out2, inn2]);
  assert.equal(moved[0].date, far);
  markInternalTransfers(moved);
  assert.equal(isSpend(moved[0]), true, 'the re-dated leg counts as spending on its own');
});
