import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManualTxRow, addManualTransaction, quickAddTargets } from '../src/dataAdapter.js';

// --- buildManualTxRow: pure id / sign / write-time category ------------------

test('mints a manual: plaid_tx_id (uuid, not the csv content hash)', () => {
  const a = buildManualTxRow({ date: '2026-08-01', amount: 12.5, description: 'X' });
  const b = buildManualTxRow({ date: '2026-08-01', amount: 12.5, description: 'X' });
  assert.match(a.plaid_tx_id, /^manual:[0-9a-f-]{36}$/i);
  // A hand-typed row has no file to re-import — identical inputs get DISTINCT
  // ids (uuid), unlike the csv: content hash which would collide.
  assert.notEqual(a.plaid_tx_id, b.plaid_tx_id);
});

test('never emits user_type — the 4-type override is user-owned, set only via updateTransaction', () => {
  const row = buildManualTxRow({ date: '2026-08-01', amount: 12.5, description: 'X' });
  assert.ok(!('user_type' in row), 'a writer emitting user_type would restate the override on insert');
});

test('stores the amount already-signed, positive = money out (no flip)', () => {
  // The form collects a positive "spent" figure, which already IS positive=out.
  assert.equal(buildManualTxRow({ date: '2026-08-01', amount: 40, description: 'Y' }).amount, 40);
  // A user recording money IN passes a negative amount; the helper never
  // reinterprets it.
  assert.equal(buildManualTxRow({ date: '2026-08-01', amount: -40, description: 'Y' }).amount, -40);
});

test('rejects a missing date or non-numeric amount', () => {
  assert.throws(() => buildManualTxRow({ amount: 1, description: 'x' }), /date/);
  assert.throws(() => buildManualTxRow({ date: '2026-08-01', amount: 'nope' }), /numeric/);
});

test('write-time category: a learned rule, or else Uncategorized', () => {
  // Nothing is guessed since the keyword table's deletion (2026-08-04):
  // STARBUCKS is just another untaught merchant.
  const untaught = buildManualTxRow({ date: '2026-08-01', amount: 5, description: 'STARBUCKS #123' });
  assert.equal(untaught.mapped_category, 'Uncategorized');

  // A learned rule for that merchant key is what assigns the category.
  const learned = buildManualTxRow(
    { date: '2026-08-01', amount: 5, description: 'STARBUCKS #123' },
    { rules: { STARBUCKS: 'Dining and drinks' } },
  );
  assert.equal(learned.mapped_category, 'Dining and drinks');

  // An unknown merchant with no rule -> the same visible Uncategorized.
  const unknown = buildManualTxRow({ date: '2026-08-01', amount: 5, description: 'ZZQ UNKNOWN VENDOR' });
  assert.equal(unknown.mapped_category, 'Uncategorized');
});

test('user_category is set only when the form explicitly picks one', () => {
  assert.equal('user_category' in buildManualTxRow({ date: '2026-08-01', amount: 1, description: 'x' }), false);
  const picked = buildManualTxRow({ date: '2026-08-01', amount: 1, description: 'x', category: 'Groceries' });
  assert.equal(picked.user_category, 'Groceries');
});

// --- addManualTransaction: account gate + insert + returned shape -----------

function fakeClient(account, capture = {}) {
  return {
    from(table) {
      if (table === 'accounts') {
        return {
          select() { return this; },
          eq() { return this; },
          single: async () => ({ data: account, error: account ? null : { message: 'not found' } }),
        };
      }
      // transactions
      return {
        insert(payload) { capture.payload = payload; return this; },
        select() { return this; },
        single: async () => ({
          data: {
            id: 'row-1',
            ...capture.payload,
            accounts: { hidden: false, type: account.type, subtype: account.subtype },
          },
          error: null,
        }),
      };
    },
  };
}

const manualAcct = { id: 'm1', plaid_account_id: 'manual:abc', is_manual: true, type: 'depository', subtype: 'checking' };
const sfinAcct = { id: 's1', plaid_account_id: 'sfin:xyz', is_manual: false, type: 'depository', subtype: 'checking' };

test('rejects insertion onto a SimpleFIN-fed account (id-space overlap rule)', async () => {
  const capture = {};
  await assert.rejects(
    addManualTransaction(
      { accountId: 's1', date: '2026-08-01', amount: 10, description: 'x' },
      { client: fakeClient(sfinAcct, capture), getRules: async () => ({}) },
    ),
    /manual account/,
  );
  assert.equal(capture.payload, undefined); // never attempted the insert
});

test('inserts on a manual account: manual: id, source=manual, account_id, no household_id', async () => {
  const capture = {};
  const shaped = await addManualTransaction(
    { accountId: 'm1', date: '2026-08-01', amount: 25, description: 'STARBUCKS' },
    { client: fakeClient(manualAcct, capture), getRules: async () => ({ STARBUCKS: 'Coffee and snacks' }) },
  );
  assert.match(capture.payload.plaid_tx_id, /^manual:/);
  assert.equal(capture.payload.source, 'manual');
  assert.equal(capture.payload.account_id, 'm1');
  assert.equal(capture.payload.amount, 25);
  assert.equal('household_id' in capture.payload, false); // RLS default fills it
  // Returned shape is a getTransactions row (toTxShape).
  assert.equal(shaped.id, 'row-1');
  assert.equal(shaped.category, 'Coffee and snacks');
  assert.equal(shaped.amount, 25);
  assert.equal(shaped.counted, true); // a checking-account purchase is spending
});

test('a learned rule reaches the persisted mapped_category at write time', async () => {
  const capture = {};
  await addManualTransaction(
    { accountId: 'm1', date: '2026-08-01', amount: 25, description: 'STARBUCKS' },
    { client: fakeClient(manualAcct, capture), getRules: async () => ({ STARBUCKS: 'Dining and drinks' }) },
  );
  assert.equal(capture.payload.mapped_category, 'Dining and drinks');
});

// --- quickAddTargets: which accounts QuickAddSheet may offer -------------------
// A row on a HIDDEN account is inserted, shows optimistically, then vanishes on
// the reload (hidden accounts are excluded at the query level) — it reads as
// "it didn't save". The sheet defaults to the first target, so order matters
// too: getAccounts sorts type ascending, which put a card ahead of cash.
const acct = (id, over = {}) => ({ id, plaid_account_id: `manual:${id}`, is_manual: true, type: 'depository', hidden: false, ...over });

test('quickAddTargets: excludes hidden, loan and SimpleFIN accounts', () => {
  const ids = quickAddTargets([
    acct('cash'),
    acct('old-visa', { type: 'credit', hidden: true }),
    acct('mortgage', { type: 'loan' }),
    { id: 'feed', plaid_account_id: 'sfin:abc', type: 'depository', hidden: false },
    { id: 'feed-flagged', plaid_account_id: 'sfin:def', is_manual: true, type: 'depository', hidden: false },
    acct('hidden-cash', { hidden: true }),
  ]).map(a => a.id);
  assert.deepEqual(ids, ['cash']);
});

test('quickAddTargets: depository before credit, stable within each group', () => {
  // getAccounts' order: type ascending (credit < depository), then name.
  const ids = quickAddTargets([
    acct('visa-a', { type: 'credit' }),
    acct('visa-b', { type: 'credit' }),
    acct('cash'),
    acct('envelope-jar'),
  ]).map(a => a.id);
  assert.deepEqual(ids, ['cash', 'envelope-jar', 'visa-a', 'visa-b']);
});

test('quickAddTargets: nothing offerable is [] (the create-an-Imported-account path)', () => {
  assert.deepEqual(quickAddTargets([acct('a', { hidden: true }), acct('b', { type: 'credit', hidden: true })]), []);
  assert.deepEqual(quickAddTargets([]), []);
  assert.deepEqual(quickAddTargets(null), []);
});

test('QuickAddSheet is fed quickAddTargets and defaults to its first entry', async () => {
  const { readFileSync } = await import('node:fs');
  const dash = readFileSync(new URL('../src/components/Dashboard.jsx', import.meta.url), 'utf8');
  assert.match(dash, /const manualAccounts=quickAddTargets\(accounts\);/,
    'the quick-add account list must come from quickAddTargets, not an inline filter that can drift (it missed hidden)');
  assert.match(dash, /const \[acctId,setAcctId\]=useState\(manualAccounts\[0\]\?\.id\|\|""\);/,
    'the default target is the first offered account (depository first)');
});
