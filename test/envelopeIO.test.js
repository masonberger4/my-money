import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAssignmentsThrough,
  setAssigned,
  setTargetOverride,
  autoFillMonth,
  getExpectedTransactions,
  addExpected,
  dismissExpected,
  matchExpectedManually,
  isEnvelopeSchemaMissing,
} from '../src/dataAdapter.js';

// Adapter-level I/O decisions for the envelope follow-ups (Session 6), driven
// through a tiny recording fake client — the addManualTransaction/manualTx
// test pattern, not the service-role fakeSupabase (these are client-direct
// RLS writes with different chains: .is on delete, single-table upserts).
//
// ORDERING MATTERS in this file: dataAdapter holds module-level degrade flags
// (budgetMonthsHaveOverride, hasExpectedTx) that only ever flip true→false,
// exactly like the shared-preview reality they model. Every happy-path test
// runs first; the 42703 / missing-table fallback tests run LAST in their
// group, because after they flip the flag the module (correctly) stops
// sending the new column / querying the table. node --test runs this file's
// tests sequentially in one process, so the order is deterministic.

function fakeClient(script, calls = []) {
  return {
    from(table) {
      const q = {
        table,
        op: 'select',
        payload: null,
        filters: [],
        columns: null,
        onConflict: null,
        single: false,
      };
      const b = {
        select(cols) {
          if (q.op === 'select') q.columns = cols;
          return b;
        },
        insert(p) {
          q.op = 'insert';
          q.payload = p;
          return b;
        },
        update(p) {
          q.op = 'update';
          q.payload = p;
          return b;
        },
        upsert(p, opts) {
          q.op = 'upsert';
          q.payload = p;
          q.onConflict = opts?.onConflict ?? null;
          return b;
        },
        delete() {
          q.op = 'delete';
          return b;
        },
        eq(c, v) {
          q.filters.push(['eq', c, v]);
          return b;
        },
        is(c, v) {
          q.filters.push(['is', c, v]);
          return b;
        },
        gte(c, v) {
          q.filters.push(['gte', c, v]);
          return b;
        },
        lte(c, v) {
          q.filters.push(['lte', c, v]);
          return b;
        },
        order() {
          return b;
        },
        range() {
          return b;
        },
        single() {
          q.single = true;
          return b;
        },
        then(resolve, reject) {
          calls.push(q);
          if (!script.length) throw new Error(`fakeClient: unscripted ${q.op} on ${q.table}`);
          const next = script.shift();
          const out = typeof next === 'function' ? next(q) : next;
          return Promise.resolve(out ?? { data: null, error: null }).then(resolve, reject);
        },
      };
      return b;
    },
  };
}

const overrideMissingError = {
  code: '42703',
  message: 'column budget_months.target_override does not exist',
  details: null,
  hint: null,
};

// --- happy paths (flags still true) ------------------------------------------

test('getAssignmentsThrough selects target_override and maps it onto the rows', async () => {
  const calls = [];
  const client = fakeClient(
    [{ data: [{ category: 'Groceries', month: '2026-08-01', assigned: 50, target_override: 120 }], error: null }],
    calls
  );
  const rows = await getAssignmentsThrough('2026-08-01', { client });
  assert.match(calls[0].columns, /target_override/);
  assert.deepEqual(rows, [
    { category: 'Groceries', month: '2026-08-01', assigned: 50, targetOverride: 120 },
  ]);
});

test('setAssigned(0) preserves an override row: conditional delete, then assigned=0 update', async () => {
  const calls = [];
  const client = fakeClient([{ error: null }, { error: null }], calls);
  await setAssigned('Groceries', { year: 2026, month: 8 }, 0, { client });

  assert.equal(calls[0].op, 'delete');
  assert.deepEqual(
    calls[0].filters.find(f => f[0] === 'is'),
    ['is', 'target_override', null]
  );
  assert.equal(calls[1].op, 'update');
  assert.equal(calls[1].payload.assigned, 0);
  // The update never touches target_override — the row keeps it.
  assert.equal('target_override' in calls[1].payload, false);
});

test('setTargetOverride upserts target_override only — assigned never in the payload', async () => {
  const calls = [];
  const client = fakeClient([{ error: null }], calls);
  await setTargetOverride('Groceries', { year: 2026, month: 8 }, '75', { client });

  assert.equal(calls[0].op, 'upsert');
  assert.equal(calls[0].onConflict, 'household_id,category,month');
  assert.equal(calls[0].payload.target_override, 75);
  assert.equal(calls[0].payload.month, '2026-08-01');
  assert.equal('assigned' in calls[0].payload, false);
});

test('override 0 is a real value and is written (distinct from clearing)', async () => {
  const calls = [];
  const client = fakeClient([{ error: null }], calls);
  await setTargetOverride('Groceries', { year: 2026, month: 8 }, 0, { client });
  assert.equal(calls[0].op, 'upsert');
  assert.equal(calls[0].payload.target_override, 0);
});

test('clearing an override null-updates, then deletes only an otherwise-empty row', async () => {
  const calls = [];
  const client = fakeClient([{ error: null }, { error: null }], calls);
  await setTargetOverride('Groceries', { year: 2026, month: 8 }, '', { client });

  assert.equal(calls[0].op, 'update');
  assert.equal(calls[0].payload.target_override, null);
  assert.equal(calls[1].op, 'delete');
  // Delete gated on BOTH: assigned = 0 and override now null — a row still
  // holding an assignment survives the clear.
  assert.deepEqual(
    calls[1].filters.find(f => f[0] === 'eq' && f[1] === 'assigned'),
    ['eq', 'assigned', 0]
  );
  assert.deepEqual(
    calls[1].filters.find(f => f[0] === 'is'),
    ['is', 'target_override', null]
  );
});

test('autoFillMonth: reads both months (never target_override), bulk-upserts the plan sent-columns-only', async () => {
  const calls = [];
  const client = fakeClient(
    [
      // previous month (source)
      {
        data: [
          { category: 'Groceries', assigned: 400 },
          { category: 'Fun money', assigned: 80 },
          { category: 'Zeroed', assigned: 0 },
        ],
        error: null,
      },
      // viewed month (existing): Fun money already set, a 0 row counts as absent
      {
        data: [
          { category: 'Fun money', assigned: 25 },
          { category: 'Groceries', assigned: 0 },
        ],
        error: null,
      },
      { error: null }, // the upsert
    ],
    calls
  );
  const plan = await autoFillMonth({ year: 2026, month: 8 }, { client });

  assert.equal(calls[0].columns, 'category, assigned');
  assert.equal(calls[1].columns, 'category, assigned');
  assert.deepEqual(calls[0].filters, [['eq', 'month', '2026-07-01']]);
  assert.deepEqual(calls[1].filters, [['eq', 'month', '2026-08-01']]);

  assert.equal(calls[2].op, 'upsert');
  assert.equal(calls[2].onConflict, 'household_id,category,month');
  assert.deepEqual(calls[2].payload.map(r => r.category), ['Groceries']);
  const row = calls[2].payload[0];
  assert.equal(row.assigned, 400);
  assert.equal(row.month, '2026-08-01');
  assert.ok(row.updated_at);
  // Sent-columns-only: a target_override on the existing 0 row must survive.
  assert.equal('target_override' in row, false);

  assert.deepEqual(plan.skipped, [{ category: 'Fun money', assigned: 80 }]);
  assert.equal(plan.total, 400);
});

test('autoFillMonth with nothing to copy performs no write and returns the empty plan', async () => {
  const calls = [];
  const client = fakeClient(
    [
      { data: [], error: null },
      { data: [], error: null },
    ],
    calls
  );
  const plan = await autoFillMonth({ year: 2026, month: 8 }, { client });
  assert.equal(calls.length, 2); // no upsert
  assert.deepEqual(plan.rows, []);
});

// --- expected transactions (happy paths before the missing-table flip) -------

test('getExpectedTransactions auto-matches, persists, and rolls the cycle forward', async () => {
  const pendingRow = {
    id: 'e1',
    recurring_key: 'NETFLIX',
    description: 'Netflix',
    category: 'Subscriptions',
    account_id: null,
    amount: 15.49,
    due_date: '2026-08-05',
    cadence: 'monthly',
    status: 'pending',
    matched_tx_id: null,
    created_at: 'x',
  };
  const nextRow = { ...pendingRow, id: 'e2', due_date: '2026-09-05' };
  const calls = [];
  const client = fakeClient(
    [
      { data: [pendingRow], error: null }, // pending read
      { data: [], error: null }, // this-month matched read
      { error: null }, // update → matched
      { data: [], error: null }, // roll-forward dup-gate read
      { data: nextRow, error: null }, // roll-forward insert
    ],
    calls
  );
  const fetchTxs = async () => [
    { id: 't9', date: '2026-08-04', amount: 15.49, account_id: 'a1', merchant_name: 'NETFLIX.COM', description: 'NETFLIX.COM' },
  ];
  const res = await getExpectedTransactions({ today: '2026-08-06' }, { client, fetchTxs });

  const upd = calls.find(c => c.op === 'update');
  assert.equal(upd.payload.status, 'matched');
  assert.equal(upd.payload.matched_tx_id, 't9');

  const ins = calls.find(c => c.op === 'insert');
  assert.equal(ins.payload.due_date, '2026-09-05');
  assert.equal(ins.payload.recurring_key, 'NETFLIX');
  assert.equal('status' in ins.payload, false); // defaults to pending

  assert.deepEqual(res.pending.map(r => r.id), ['e2']);
  assert.deepEqual(res.matched.map(r => r.id), ['e1']);
});

test('addExpected dup-gates the same recurring_key cycle instead of inserting a twin', async () => {
  const existing = {
    id: 'e1',
    recurring_key: 'NETFLIX',
    status: 'pending',
    due_date: '2026-08-05',
  };
  const calls = [];
  const client = fakeClient([{ data: [existing], error: null }], calls);
  const res = await addExpected(
    { recurring_key: 'NETFLIX', description: 'Netflix', category: 'Subscriptions', amount: 15.49, due_date: '2026-08-07', cadence: 'monthly' },
    { client }
  );
  assert.equal(res.duplicate, true);
  assert.equal(calls.length, 1); // no insert
});

test('dismissExpected rolls forward; { stop: true } does not', async () => {
  const row = {
    id: 'e1',
    recurring_key: null,
    description: 'Rent',
    category: 'Rent',
    account_id: null,
    amount: 2000,
    due_date: '2026-08-01',
    cadence: 'monthly',
    status: 'pending',
  };
  // Without stop: read, update, insert (recurring_key null skips the dup read).
  let calls = [];
  let client = fakeClient(
    [{ data: row, error: null }, { error: null }, { data: { ...row, id: 'e2', due_date: '2026-09-01' }, error: null }],
    calls
  );
  const { next } = await dismissExpected('e1', {}, { client });
  assert.equal(calls[1].payload.status, 'dismissed');
  assert.equal(next.due_date, '2026-09-01');

  // With stop: no insert at all.
  calls = [];
  client = fakeClient([{ data: row, error: null }, { error: null }], calls);
  const stopped = await dismissExpected('e1', { stop: true }, { client });
  assert.equal(stopped.next, null);
  assert.equal(calls.length, 2);
});

test("matchExpectedManually marks the row and rolls forward; 'once' never rolls", async () => {
  const row = {
    id: 'e1',
    recurring_key: null,
    description: 'Plumber',
    category: 'Home',
    account_id: null,
    amount: 300,
    due_date: '2026-08-10',
    cadence: 'once',
    status: 'pending',
  };
  const calls = [];
  const client = fakeClient([{ data: row, error: null }, { error: null }], calls);
  const { next } = await matchExpectedManually('e1', 't5', { client });
  assert.equal(calls[1].payload.status, 'matched');
  assert.equal(calls[1].payload.matched_tx_id, 't5');
  assert.equal(next, null); // once → rollForwardDate null → no insert
});

// --- degrade paths LAST (they flip the module flags) --------------------------

test('getAssignmentsThrough: 42703 naming target_override retries with the old columns and never escapes', async () => {
  const calls = [];
  const client = fakeClient(
    [
      { data: null, error: overrideMissingError },
      { data: [{ category: 'Groceries', month: '2026-08-01', assigned: 50 }], error: null },
    ],
    calls
  );
  // Must NOT throw — a thrown 42703 would reach the Budget tab's gate, and
  // isEnvelopeSchemaMissing reads any 42703 as "envelopes not installed".
  const rows = await getAssignmentsThrough('2026-08-01', { client });
  assert.equal(isEnvelopeSchemaMissing(overrideMissingError), true); // the trap is real
  assert.doesNotMatch(calls[1].columns, /target_override/);
  assert.deepEqual(rows, [
    { category: 'Groceries', month: '2026-08-01', assigned: 50, targetOverride: null },
  ]);
});

test('setAssigned(0) pre-migration: falls back to the old unconditional delete', async () => {
  // The flag is now false (flipped by the previous test) — the old delete
  // shape, no .is filter, no follow-up update.
  const calls = [];
  const client = fakeClient([{ error: null }], calls);
  await setAssigned('Groceries', { year: 2026, month: 8 }, 0, { client });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, 'delete');
  assert.equal(calls[0].filters.some(f => f[0] === 'is'), false);
});

test('getExpectedTransactions: missing table → null, and stays null without re-querying', async () => {
  const missingTable = {
    code: 'PGRST205',
    message: "Could not find the table 'public.expected_transactions' in the schema cache",
  };
  const calls = [];
  const client = fakeClient([{ data: null, error: missingTable }], calls);
  assert.equal(await getExpectedTransactions({ today: '2026-08-06' }, { client }), null);
  // Flag remembered: no further queries, addExpected degrades too.
  assert.equal(await getExpectedTransactions({ today: '2026-08-06' }, { client }), null);
  assert.equal(await addExpected({ description: 'x', category: 'y', amount: 1, due_date: '2026-08-07' }, { client }), null);
  assert.equal(calls.length, 1);
});
