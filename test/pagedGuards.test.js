import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pagedRows, isMissingColumnError } from '../src/dataAdapter.js';
import { isRangeExhaustedError } from '../src/ruleHistory.js';

// ---- pagedRows: the ONE paged-loop discipline -------------------------------

function makePager(pages) {
  // pages: array of { data, error } responses, one per call.
  const calls = [];
  return {
    calls,
    fetchPage: async (from, to) => {
      calls.push([from, to]);
      return pages.shift() ?? { data: [], error: null };
    },
  };
}

test('pagedRows accumulates across full pages and stops on a short page', async () => {
  const p1 = Array.from({ length: 3 }, (_, i) => ({ id: i }));
  const p2 = [{ id: 3 }];
  const { fetchPage, calls } = makePager([{ data: p1, error: null }, { data: p2, error: null }]);
  const rows = await pagedRows(fetchPage, 3);
  assert.equal(rows.length, 4);
  assert.deepEqual(calls, [[0, 2], [3, 5]]);
});

test('pagedRows REGRESSION: exact page-multiple + 416/PGRST103 is end-of-data, not a failure', async () => {
  // An exact N×page result set makes the next request start past the end;
  // PostgREST answers 416/PGRST103 rather than an empty page. Before the
  // guard, fetchRawBetween / getExistingTxIds / getAccountTransactionsInRange
  // threw here — erroring the whole dashboard (the memo evicts on rejection)
  // and blocking CSV/PDF import once backfill pushed counts past 1000.
  const full = Array.from({ length: 2 }, (_, i) => ({ id: i }));
  const err416 = { code: 'PGRST103', message: 'Requested range not satisfiable' };
  assert.equal(isRangeExhaustedError(err416), true);
  const { fetchPage } = makePager([
    { data: full, error: null },
    { data: null, error: err416 },
  ]);
  const rows = await pagedRows(fetchPage, 2);
  assert.equal(rows.length, 2);
});

test('pagedRows still throws a REAL error', async () => {
  const boom = { code: '42501', message: 'permission denied' };
  const { fetchPage } = makePager([{ data: null, error: boom }]);
  await assert.rejects(() => pagedRows(fetchPage, 2), e => e === boom);
});

test('pagedRows treats a null/empty first page as done (no spin)', async () => {
  const { fetchPage, calls } = makePager([{ data: null, error: null }]);
  const rows = await pagedRows(fetchPage, 1000);
  assert.deepEqual(rows, []);
  assert.equal(calls.length, 1);
});

test('source scan: no unguarded paged loop remains in dataAdapter.js', () => {
  // Every `for (let from = 0; ; from += page)` loop must route through
  // pagedRows (which owns the isRangeExhaustedError contract). A bare
  // `if (error) throw error` inside such a loop is the unguarded shape.
  const src = readFileSync(fileURLToPath(new URL('../src/dataAdapter.js', import.meta.url)), 'utf8');
  const headers = [...src.matchAll(/for \(let from = 0; ; from \+= page\)/g)];
  assert.ok(headers.length >= 5, `scan regressed: found ${headers.length} paged loops`);
  for (const h of headers) {
    // The guard must appear within the loop body (well inside 1200 chars for
    // every loop in this file).
    const body = src.slice(h.index, h.index + 1200);
    assert.match(body, /isRangeExhaustedError/, `unguarded paged loop:\n${body.slice(0, 300)}`);
  }
});

// ---- isMissingColumnError: the name check -----------------------------------

test('isMissingColumnError matches only when the column NAME appears', () => {
  const missingSource = {
    code: 'PGRST204',
    message: "Could not find the 'source' column of 'transactions' in the schema cache",
  };
  assert.equal(isMissingColumnError(missingSource, 'source'), true);
  // REGRESSION: a DIFFERENT missing column must NOT flip this column's
  // degrade flag — before the name check, ANY 42703/PGRST204 read a feature
  // as "not installed" for the session (the missing-table/missing-column
  // conflation the CLAUDE.md gotcha forbids).
  assert.equal(isMissingColumnError(missingSource, 'entity_id'), false);
  const missingEntity = { code: '42703', message: 'column transactions.entity_id does not exist' };
  assert.equal(isMissingColumnError(missingEntity, 'entity_id'), true);
  assert.equal(isMissingColumnError(missingEntity, 'apr'), false);
});

test('isMissingColumnError: name + "column" wording matches without a code; null/none do not', () => {
  const worded = { message: 'column "is_manual" of relation "accounts" does not exist' };
  assert.equal(isMissingColumnError(worded, 'is_manual'), true);
  assert.equal(isMissingColumnError(worded, 'source'), false);
  assert.equal(isMissingColumnError(null, 'source'), false);
  assert.equal(isMissingColumnError({ code: '42703', message: '' }, 'source'), false);
  // Case-insensitive on the name.
  assert.equal(isMissingColumnError({ code: '42703', message: 'Column ENTITY_ID missing' }, 'entity_id'), true);
});
