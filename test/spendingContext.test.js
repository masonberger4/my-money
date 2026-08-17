// Byte-determinism tests for the assistant's context builder. CLAUDE.md
// requires byte-stable output per DB state (prompt caching stops hitting
// otherwise); formatSpendingContext is the pure formatter buildSpendingContext
// now delegates to after its two queries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSpendingContext } from '../api/_lib/spendingContext.js';

const ACCOUNTS = [
  { id: 'a-chk', name: 'Everyday Checking', nickname: null, mask: '1234', type: 'depository', subtype: 'checking', current_balance: 2500.5, hidden: false, institutions: { name: 'Synth CU' } },
  { id: 'a-card', name: 'Venture Card', nickname: 'Our Card', mask: '7885', type: 'credit', subtype: 'credit card', current_balance: 5127.97, hidden: false, institutions: { name: 'Capital Synth' } },
  { id: 'a-loan', name: 'Home Loan', nickname: null, mask: '', type: 'loan', subtype: 'loan', current_balance: 231550.12, hidden: false, institutions: { name: 'Synth Servicing' } },
  { id: 'a-hid', name: 'Hidden Card', nickname: null, mask: '9999', type: 'credit', subtype: 'credit card', current_balance: 42, hidden: true, institutions: { name: 'Capital Synth' } },
];

const TXS = [
  { account_id: 'a-chk', date: '2026-07-08', amount: 85.5, merchant_name: '', description: 'SAFEWAY 1467', mapped_category: 'Groceries', user_category: null, user_description: null, excluded: false },
  { account_id: 'a-chk', date: '2026-07-12', amount: 40, merchant_name: '', description: 'EXCLUDED ROW MARKER', mapped_category: 'Groceries', user_category: null, user_description: null, excluded: true },
  { account_id: 'a-card', date: '2026-07-19', amount: -35, merchant_name: '', description: 'RIVER GEAR REFUND', mapped_category: 'Uncategorized', user_category: null, user_description: null, excluded: false },
  { account_id: 'a-card', date: '2026-07-05', amount: 220, merchant_name: 'CAPITAL ONE TRAVEL', description: 'CAPITAL ONE TRAVEL PORTLAND', mapped_category: 'Travel and vacation', user_category: null, user_description: 'Portland trip', excluded: false },
  { account_id: 'a-chk', date: '2026-07-18', amount: 60, merchant_name: '', description: 'MYSTERY VENDOR LLC', mapped_category: 'Uncategorized', user_category: 'Dining out', user_description: null, excluded: false },
  { account_id: 'a-loan', date: '2026-07-15', amount: 800, merchant_name: '', description: 'ESCROW DISBURSEMENT', mapped_category: 'Uncategorized', user_category: null, user_description: null, excluded: false },
];

const clone = v => JSON.parse(JSON.stringify(v));

test('two runs over the same rows produce byte-identical text, without mutating the inputs', () => {
  const accounts = clone(ACCOUNTS);
  const txs = clone(TXS);
  const first = formatSpendingContext(accounts, txs);
  const second = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  assert.equal(typeof first, 'string');
  assert.equal(first, second, 'byte-identical or prompt caching stops hitting');
  assert.deepEqual(accounts, ACCOUNTS, 'accounts not mutated');
  assert.deepEqual(txs, TXS, 'transactions not mutated');
  // …and a third run on the SAME (already-used) arrays is still identical.
  assert.equal(formatSpendingContext(accounts, txs), first);
});

test('excluded rows and loan-account rows are skipped everywhere', () => {
  const text = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  assert.ok(!text.includes('EXCLUDED ROW MARKER'), 'excluded rows never reach the assistant');
  assert.ok(!text.includes('ESCROW DISBURSEMENT'), 'loan postings are not purchases');
  // The loan ACCOUNT still lists — only its transactions are dropped.
  assert.ok(text.includes('Home Loan'));
});

test('user edits win: user_category in the sums and list, user_description as the name', () => {
  const text = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  assert.ok(text.includes('- 2026-07 Dining out: $60.00'), 'override category drives the monthly sum');
  assert.ok(text.includes('| Dining out |'), 'and the transaction line');
  assert.ok(text.includes('Portland trip'), 'user_description is the shown name');
});

test('debt balances match displayBalance — the fourth display site', () => {
  const text = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  assert.ok(text.includes('balance $-5127.97'), 'card shown as owed (negative)');
  assert.ok(text.includes('balance $-231550.12'), 'loan shown as owed');
  assert.ok(text.includes('balance $2500.50'), 'deposit positive');
});

test('hidden accounts appear nowhere', () => {
  const text = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  assert.ok(!text.includes('Hidden Card'));
  assert.ok(!text.includes('9999'));
});

test('a credit-card refund nets in its own category, and the context SAYS it does', () => {
  // REVERSED 2026-08-17: this used to assert the refund listed as "Return" and
  // never reached the spending sums. It nets now, so two things have to hold
  // together — the arithmetic AND the sentence that tells the model how to
  // read it. A context that still said "money in never counts" beside a
  // negative category line would make the Ask tab contradict the screen.
  const text = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  assert.ok(!text.includes('| Return |'), 'nothing synthesises a Return category any more');
  assert.ok(!/money in never counts/.test(text), 'the retired rule is not stated');
  assert.ok(/SUBTRACTS from its category/.test(text), 'the netting rule IS stated');
  // The −35 refund is the fixture's only Uncategorized row, so its bucket is
  // the refund itself — NEGATIVE, and present rather than dropped. That is the
  // whole change in one line: a month can now report a negative category, and
  // the assistant has to be able to see and explain it.
  assert.ok(text.includes('- 2026-07 Uncategorized: $-35.00'),
    `the refund nets into its own category:\n${text}`);
  // …and it still LISTS, unmarked: the "not counted as spending" suffix is for
  // money-OUT rows the rule excludes, and this row is counted.
  const row = text.split('\n').find(l => l.includes('RIVER GEAR REFUND'));
  assert.ok(row && !row.includes('not counted as spending'), row);
});

test('a DEBIT-card refund nets once marked, and the context says that too', () => {
  // 2026-08-17b: a depository inflow the household typed 'spending' is a
  // refund and subtracts. The sentence has to admit the exception or the model
  // reads "money into checking is never spending" beside a line where it was —
  // the same contradiction the credit half of this test guards.
  const rows = clone(TXS).concat([{
    account_id: 'a-chk', date: '2026-07-20', amount: -50, merchant_name: '',
    description: 'TARGET REFUND', mapped_category: 'Groceries', user_category: null,
    user_description: null, excluded: false, user_type: 'spending',
  }]);
  const text = formatSpendingContext(clone(ACCOUNTS), rows);
  // Groceries is 85.50 of purchases minus the 50 refund.
  assert.ok(text.includes('- 2026-07 Groceries: $35.50'), `the debit refund nets:\n${text}`);
  assert.ok(!/never counts as spending/.test(text), 'the retired absolute is gone');
  assert.ok(/marked that row a Refund/.test(text), 'the exception IS stated');
});

// --- Recurring + envelope sections -----------------------------------------

// A ~monthly subscription: 4 charges ~30 days apart, similar amounts, with the
// last one hiked >5% over the median → priceCreep must flag.
const SUB_TXS = [
  { account_id: 'a-card', date: '2026-04-14', amount: 19.99, merchant_name: 'STREAMFLIX', description: 'STREAMFLIX 8841', mapped_category: 'Entertainment and rec', user_category: null, user_description: null, excluded: false },
  { account_id: 'a-card', date: '2026-05-14', amount: 19.99, merchant_name: 'STREAMFLIX', description: 'STREAMFLIX 9013', mapped_category: 'Entertainment and rec', user_category: null, user_description: null, excluded: false },
  { account_id: 'a-card', date: '2026-06-13', amount: 19.99, merchant_name: 'STREAMFLIX', description: 'STREAMFLIX 0027', mapped_category: 'Entertainment and rec', user_category: null, user_description: null, excluded: false },
  { account_id: 'a-card', date: '2026-07-14', amount: 21.99, merchant_name: 'STREAMFLIX', description: 'STREAMFLIX 1152', mapped_category: 'Entertainment and rec', user_category: null, user_description: null, excluded: false },
];

const BUDGET = {
  year: 2026,
  month: 7,
  assignments: [
    { category: 'Groceries', month: '2026-06-01', assigned: 100 },
    { category: 'Groceries', month: '2026-07-01', assigned: 200 },
  ],
  settings: [{ category: 'Groceries', target: 250, targetKind: 'monthly', targetDate: null, rollover: true }],
  // Raw tx rows, exactly the columns fetchBudgetInputs selects: June spends 40
  // (carry 100−40=60), July spends 85.50 → available 200+60−85.50 = 174.50.
  // The loan row and the excluded row must not count.
  spendTxs: [
    { account_id: 'a-chk', date: '2026-06-10', amount: 40, mapped_category: 'Groceries', user_category: null, excluded: false },
    { account_id: 'a-chk', date: '2026-07-08', amount: 85.5, mapped_category: 'Groceries', user_category: null, excluded: false },
    { account_id: 'a-chk', date: '2026-07-12', amount: 40, mapped_category: 'Groceries', user_category: null, excluded: true },
    { account_id: 'a-loan', date: '2026-07-15', amount: 800, mapped_category: 'Groceries', user_category: null, excluded: false },
  ],
};

test('byte-determinism holds with the recurring and envelope sections included', () => {
  const args = () => [clone(ACCOUNTS), clone(TXS).concat(clone(SUB_TXS)), { budget: clone(BUDGET) }];
  const first = formatSpendingContext(...args());
  const second = formatSpendingContext(...args());
  assert.equal(first, second, 'byte-identical or prompt caching stops hitting');
  assert.ok(first.includes('## Recurring charges'));
  assert.ok(first.includes('## Budget envelopes (2026-07)'));
});

test('recurring section renders the subscription, its creep flag, and the tx-derived clock', () => {
  const text = formatSpendingContext(clone(ACCOUNTS), clone(TXS).concat(clone(SUB_TXS)));
  assert.ok(text.includes('newest transaction (2026-07-19)'), 'clock is the max tx date, not wall clock');
  assert.ok(/- STREAMFLIX: ~\$19\.99\/mo \(Entertainment and rec, every ~3\d days, last 2026-07-14, next ~2026-08-1\d\)/.test(text));
  assert.ok(text.includes('price increased: was $19.99, now $21.99'));
  // One-off merchants never read as recurring.
  assert.ok(!text.includes('- SAFEWAY'));
});

test('recurring section suffixes by cadence: a weekly item reads /wk, not /mo', () => {
  // 4 charges 7 days apart — detectRecurring's weekly band (recurring v2).
  const weekly = ['2026-06-22', '2026-06-29', '2026-07-06', '2026-07-13'].map(d => ({
    account_id: 'a-chk', date: d, amount: 12, merchant_name: 'WEEKLY BOX', description: 'WEEKLY BOX',
    mapped_category: 'Groceries', user_category: null, user_description: null, excluded: false,
  }));
  const text = formatSpendingContext(clone(ACCOUNTS), clone(TXS).concat(weekly));
  assert.ok(text.includes('- WEEKLY BOX: ~$12.00/wk'), text);
  // The monthly fixture keeps its /mo suffix untouched.
  const monthly = formatSpendingContext(clone(ACCOUNTS), clone(TXS).concat(clone(SUB_TXS)));
  assert.ok(monthly.includes('~$19.99/mo'));
});

test('recurring section says "None detected." rather than disappearing', () => {
  const text = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  assert.ok(text.includes('## Recurring charges'));
  assert.ok(text.includes('None detected.'));
});

test('envelope section walks assigned/carried/spent/available for the fixture month', () => {
  const text = formatSpendingContext(clone(ACCOUNTS), clone(TXS), { budget: clone(BUDGET) });
  assert.ok(
    text.includes('- Groceries: assigned $200.00, carried $60.00, spent $85.50, available $174.50, target $250.00/mo'),
    text
  );
  assert.ok(text.includes('Totals: assigned $200.00, carried $60.00, spent $85.50, available $174.50'));
});

test('missing envelope schema (budget: null / absent) omits the section cleanly', () => {
  const withNull = formatSpendingContext(clone(ACCOUNTS), clone(TXS), { budget: null });
  const absent = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  assert.ok(!withNull.includes('## Budget envelopes'));
  assert.equal(withNull, absent, 'null budget and no extras render identically');
});

// --- The unified spending model (REGRESSION) --------------------------------
// The context used to compute spending with its own fold ("every positive row
// on a non-loan account"), which never ran markInternalTransfers and never
// applied isSpend's card-payment veto. Washed cross-bank self-transfers and
// card payments therefore counted as spending in the assistant's answers while
// every screen excluded them — exactly what CLAUDE.md forbids for this file
// ("must match or the Ask tab contradicts the screen"). Post-category-wipe this
// section is the assistant's ONLY spending figure, so the divergence was the
// whole story.

const BOUNDARY_ACCOUNTS = ACCOUNTS.concat([
  { id: 'a-sav', name: 'Savings', nickname: null, mask: '4410', type: 'depository', subtype: 'savings', current_balance: 9000, hidden: false, institutions: { name: 'Synth CU' } },
]);

const row = (o) => ({
  merchant_name: '', description: '', mapped_category: 'Uncategorized',
  user_category: null, user_description: null, excluded: false, ...o,
});

// One real purchase, plus the two shapes the private fold got wrong:
// a matched cross-bank self-transfer (both legs) and a card payment paid out of
// checking to a card that is not linked here (so nothing can wash it).
const BOUNDARY_TXS = [
  row({ account_id: 'a-chk', date: '2026-07-08', amount: 85.5, description: 'SAFEWAY 1467' }),
  row({ account_id: 'a-chk', date: '2026-07-02', amount: 500, description: 'ONLINE BANKING TRANSFER TO SAVINGS' }),
  row({ account_id: 'a-sav', date: '2026-07-03', amount: -500, description: 'ONLINE BANKING TRANSFER FROM CHECKING' }),
  row({ account_id: 'a-chk', date: '2026-07-11', amount: 250, description: 'CAPITAL ONE - PAYMENT' }),
];

test('REGRESSION: a washed transfer pair and a card payment stay out of the spending total', () => {
  const text = formatSpendingContext(clone(BOUNDARY_ACCOUNTS), clone(BOUNDARY_TXS));
  const spendLines = text
    .split('\n')
    .filter(l => /^- 2026-07 /.test(l));
  // Only the purchase survives the shared isSpend(): 500 (paired both ways) and
  // 250 (card payment) are gone, and the total is the purchase alone.
  assert.deepEqual(spendLines, ['- 2026-07 Uncategorized: $85.50'], text);
  assert.ok(!text.includes(': $835.50'), 'the old private fold summed all three');
  assert.ok(!text.includes(': $585.50') && !text.includes(': $335.50'), text);
});

test('REGRESSION: the excluded rows still LIST, marked, so re-adding the list matches the total', () => {
  const text = formatSpendingContext(clone(BOUNDARY_ACCOUNTS), clone(BOUNDARY_TXS));
  const listed = text.split('\n').filter(l => /^2026-07-\d\d \| /.test(l));
  assert.equal(listed.length, 4, 'every row is still visible to the assistant');
  const marked = listed.filter(l => l.endsWith('| not counted as spending'));
  assert.equal(marked.length, 2, listed.join('\n'));
  assert.ok(marked.every(l => /TRANSFER TO SAVINGS|CAPITAL ONE - PAYMENT/.test(l)), marked.join('\n'));
  // The purchase is unmarked, and so is the money-IN leg (a negative amount is
  // already money in — marking it would just cost context).
  assert.ok(!listed.find(l => l.includes('SAFEWAY')).endsWith('| not counted as spending'));
  assert.ok(!listed.find(l => l.includes('TRANSFER FROM CHECKING')).endsWith('| not counted as spending'));
});

test('the listed category of a transfer leg / card payment IS its type, not Uncategorized', () => {
  // displayCategory, mirrored server-side (2026-08-17). It has to be computed
  // AFTER the per-month pairing pass — before it, no leg carries `_internal`
  // and both of these would still print "Uncategorized", which is what the
  // teach queue means by "tell me what this is".
  const text = formatSpendingContext(clone(BOUNDARY_ACCOUNTS), clone(BOUNDARY_TXS));
  const listed = text.split('\n').filter(l => /^2026-07-\d\d \| /.test(l));
  for (const desc of ['TRANSFER TO SAVINGS', 'TRANSFER FROM CHECKING', 'CAPITAL ONE - PAYMENT']) {
    assert.ok(
      listed.find(l => l.includes(desc)).includes('| Transfers and card payments |'),
      `${desc} should read as its type: ${listed.join('\n')}`
    );
  }
  // The ordinary purchase is untouched.
  assert.ok(listed.find(l => l.includes('SAFEWAY')).includes('| Uncategorized |'), text);
});

test('a hand-typed transfer drops out of the recurring section (it was never a charge)', () => {
  // detectRecurring excludes by CATEGORY, and the category it now reads is the
  // type-locked one — so a monthly self-transfer the user typed as Transfer
  // stops being announced to the assistant as a recurring subscription.
  const monthly = ['2026-05-04', '2026-06-04', '2026-07-04'].map((date, i) =>
    row({ account_id: 'a-chk', date, amount: 900, description: 'ZELLE TO LANDLORD', id: `z${i}` })
  );
  const withType = monthly.map(t => ({ ...t, user_type: 'transfer' }));
  const before = formatSpendingContext(clone(BOUNDARY_ACCOUNTS), clone(monthly));
  const after = formatSpendingContext(clone(BOUNDARY_ACCOUNTS), clone(withType));
  // The recurring section prints a prettified merchant name, so match loosely.
  const LANDLORD = /zelle to landlord/i;
  const recurringOf = text => text.split('## Recurring charges')[1].split('\n##')[0];
  assert.match(recurringOf(before), LANDLORD, 'fixture sanity: untyped, it IS detected');
  assert.doesNotMatch(recurringOf(after), LANDLORD, recurringOf(after));
  assert.match(after, LANDLORD, 'the rows themselves still list');
});

test('the 4-type override moves the assistant totals the way every screen moves (user_type rides the context)', () => {
  // An override on the purchase pulls it out of the total AND flips its list
  // marker; a 'spending' override on the unlinked card payment forces it in.
  // The context reads the SHARED model, so this must track isSpend exactly —
  // a context that ignored user_type would contradict the screens.
  const txs = clone(BOUNDARY_TXS);
  txs.find(t => t.description === 'SAFEWAY 1467').user_type = 'transfer';
  txs.find(t => t.description === 'CAPITAL ONE - PAYMENT').user_type = 'spending';
  const text = formatSpendingContext(clone(BOUNDARY_ACCOUNTS), txs);
  const spendLines = text.split('\n').filter(l => /^- 2026-07 /.test(l));
  assert.deepEqual(spendLines, ['- 2026-07 Uncategorized: $250.00'], text);
  const listed = text.split('\n').filter(l => /^2026-07-\d\d \| /.test(l));
  assert.ok(
    listed.find(l => l.includes('SAFEWAY')).endsWith('| not counted as spending'),
    'the overridden-out purchase gains the marker'
  );
  assert.ok(
    !listed.find(l => l.includes('CAPITAL ONE - PAYMENT')).endsWith('| not counted as spending'),
    'the forced-in payment loses it'
  );
});

test('an UNPAIRED transfer out still counts — structure decides, not wording', () => {
  // Same transfer, but the receiving account is not in the row set (money left
  // the linked boundary). The linked-boundary model counts it; the old
  // category-name rule would have dropped it.
  const oneLeg = clone(BOUNDARY_TXS).filter(t => t.amount !== -500 && t.amount !== 250);
  const text = formatSpendingContext(clone(BOUNDARY_ACCOUNTS), oneLeg);
  assert.ok(text.includes('- 2026-07 Uncategorized: $585.50'), text);
  const listed = text.split('\n').filter(l => /^2026-07-\d\d \| /.test(l));
  assert.ok(listed.length && listed.every(l => !l.endsWith('| not counted as spending')), text);
});

test('the stale "never count the transfer category" instruction is gone from the context', () => {
  const text = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  assert.ok(
    !/"Transfers and card payments" and "Return" are not real spending/.test(text),
    'that stopped being true when the linked-boundary model shipped (2026-08-03)'
  );
  assert.ok(text.includes('positive is money out'), 'the sign convention is still stated');
});

test('byte-determinism holds through the pairing pass, which must not mutate the inputs', () => {
  const accounts = clone(BOUNDARY_ACCOUNTS);
  const txs = clone(BOUNDARY_TXS);
  const first = formatSpendingContext(accounts, txs);
  assert.equal(first, formatSpendingContext(clone(BOUNDARY_ACCOUNTS), clone(BOUNDARY_TXS)));
  assert.deepEqual(txs, BOUNDARY_TXS, 'markInternalTransfers stamped copies, not the caller rows');
  // A second run over the SAME arrays would double-mark if the rows carried
  // `_internal` out of the first call.
  assert.equal(formatSpendingContext(accounts, txs), first);
});

// --- The pairing WINDOW must be the month, not the 90-day slice (REGRESSION) --
// getSpending / getOverview reach the DB through getMonthTransactions: one
// calendar month fetched, markInternalTransfers run over exactly those rows.
// This section once paired the whole 90-day slice at once, which is not the
// same window — and the difference is one-directional, because a wider window
// can only wash MORE. An end-of-month sweep was therefore washed for the Ask
// tab and counted on the screen, while the header sentence told the model the
// totals were "the same one the dashboard uses".

// $3,000 leaves checking on 07-31 and lands in savings on 08-02: 3 days apart,
// inside INTERNAL_MATCH_WINDOW_DAYS, so a 90-day pairing pass matches them.
const STRADDLE_TXS = [
  row({ account_id: 'a-chk', date: '2026-07-10', amount: 85.5, description: 'SAFEWAY 1467' }),
  row({ account_id: 'a-chk', date: '2026-07-31', amount: 3000, description: 'ONLINE BANKING TRANSFER TO SAVINGS' }),
  row({ account_id: 'a-sav', date: '2026-08-02', amount: -3000, description: 'ONLINE BANKING TRANSFER FROM CHECKING' }),
];

test('REGRESSION: a transfer pair straddling a month boundary is NOT washed — each leg counts, as in the month views', () => {
  const text = formatSpendingContext(clone(BOUNDARY_ACCOUNTS), clone(STRADDLE_TXS));
  const julyLines = text.split('\n').filter(l => /^- 2026-07 /.test(l));
  assert.deepEqual(julyLines, ['- 2026-07 Uncategorized: $3085.50'], text);
  // The exact number the 90-day pairing produced, and the exact contradiction:
  // the Overview headline for July reads $3,085.50.
  assert.ok(!text.includes('- 2026-07 Uncategorized: $85.50'), 'the 90-day window washed the out-leg');
  // The in-leg is money in, so August contributes no spending line either way.
  assert.ok(!/^- 2026-08 /m.test(text), text);
});

test('REGRESSION: the assistant\'s per-month total equals the same month fetched alone (the month view\'s window)', () => {
  // Simulates getMonthTransactions: July's rows and nothing else. Whatever the
  // surrounding window, the month's own line must be byte-identical — that IS
  // the parity the header sentence promises.
  const wide = formatSpendingContext(clone(BOUNDARY_ACCOUNTS), clone(STRADDLE_TXS));
  const julyOnly = formatSpendingContext(
    clone(BOUNDARY_ACCOUNTS),
    clone(STRADDLE_TXS).filter(t => t.date.startsWith('2026-07'))
  );
  const july = t => t.split('\n').filter(l => /^- 2026-07 /.test(l));
  assert.deepEqual(july(wide), july(julyOnly), 'the surrounding window changed a month total');
});

test('the transaction list\'s "not counted" marker follows the SAME per-month pairing as the totals', () => {
  // The marker exists so a model re-adding the rows lands on the totals above,
  // not beside them — so it must never be judged over a different window.
  const text = formatSpendingContext(clone(BOUNDARY_ACCOUNTS), clone(STRADDLE_TXS));
  const listed = text.split('\n').filter(l => /^2026-0[78]-\d\d \| /.test(l));
  assert.equal(listed.length, 3, text);
  const marked = listed.filter(l => l.endsWith('| not counted as spending'));
  assert.deepEqual(marked, [], 'nothing is washed once the pairing is per-month');
  // Re-adding the money-out rows reproduces the July total exactly.
  const out = listed
    .map(l => Number(l.slice(l.lastIndexOf('$') + 1).split(' ')[0]))
    .filter(n => n > 0);
  assert.equal(out.reduce((a, b) => a + b, 0).toFixed(2), '3085.50');
});

// --- The oldest month of a rolling window is PARTIAL -------------------------

test('the partial oldest month is marked on the rows AND announced, so it is not quoted as a full month', () => {
  const partialTxs = [
    row({ account_id: 'a-chk', date: '2026-05-20', amount: 310, description: 'SAFEWAY 1467' }),
    row({ account_id: 'a-chk', date: '2026-07-10', amount: 85.5, description: 'SAFEWAY 1467' }),
  ];
  const text = formatSpendingContext(clone(BOUNDARY_ACCOUNTS), clone(partialTxs), { since: '2026-05-06' });
  assert.ok(
    text.includes('- 2026-05 Uncategorized: $310.00 (partial month: 2026-05-06 onward only)'),
    text
  );
  assert.ok(text.includes('2026-05 is INCOMPLETE'), 'and it is announced before the list');
  // Only the oldest month is partial — a complete month must stay unqualified.
  assert.ok(text.includes('- 2026-07 Uncategorized: $85.50\n'), text);
  assert.ok(!/- 2026-07 [^\n]*partial/.test(text), 'a complete month must not be marked');
});

test('a window that starts on the 1st has no partial month, and no marker is emitted', () => {
  const txs = [row({ account_id: 'a-chk', date: '2026-05-20', amount: 310, description: 'SAFEWAY 1467' })];
  const text = formatSpendingContext(clone(BOUNDARY_ACCOUNTS), clone(txs), { since: '2026-05-01' });
  assert.ok(text.includes('- 2026-05 Uncategorized: $310.00'), text);
  assert.ok(!text.includes('partial month'), 'nothing is partial when the window starts on the 1st');
  assert.ok(!text.includes('INCOMPLETE'), text);
});

test('byte-determinism holds with the partial-month marker, and `since` stays optional', () => {
  const args = () => [clone(BOUNDARY_ACCOUNTS), clone(STRADDLE_TXS), { since: '2026-05-06' }];
  assert.equal(formatSpendingContext(...args()), formatSpendingContext(...args()));
  // Absent `since` claims nothing rather than guessing a boundary.
  const noSince = formatSpendingContext(clone(BOUNDARY_ACCOUNTS), clone(STRADDLE_TXS));
  assert.ok(!noSince.includes('partial month') && !noSince.includes('INCOMPLETE'), noSince);
});

test('monthly sums are emitted in sorted-key order (order-independent above the transaction list)', () => {
  // The transaction list itself follows input order (the query orders it);
  // everything above it — accounts and the monthly category sums — must not
  // depend on row order at all.
  const head = t => t.slice(0, t.indexOf('## Transactions'));
  const a = formatSpendingContext(clone(ACCOUNTS), clone(TXS));
  const b = formatSpendingContext(clone(ACCOUNTS), clone(TXS).reverse());
  assert.equal(head(a), head(b));
});
