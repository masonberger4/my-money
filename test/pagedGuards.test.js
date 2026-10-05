import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { pagedRows, isMissingColumnError, getMileage } from '../src/dataAdapter.js';
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

test('source scan: every paged read in dataAdapter.js is TOTALLY ordered', () => {
  // OFFSET paging over an unordered — or ties-ordered — result set lets
  // Postgres return rows in a different order per request, so a page
  // boundary can drop or repeat rows (stored rows shown as "new" in the
  // import preview, a Compare count off by one, a taught rule listed twice
  // and another hidden). Every chain that ends in .range( must order, and an
  // order on ONE column must be on a unique one; anything else needs a
  // tiebreak .order( after it.
  const src = readFileSync(fileURLToPath(new URL('../src/dataAdapter.js', import.meta.url)), 'utf8');
  const UNIQUE = new Set(["'id'", "'plaid_tx_id'"]);
  const def = src.indexOf('export async function pagedRows(');
  const defEnd = src.indexOf('\n}\n', def);
  const starts = [
    ...[...src.matchAll(/for \(let from = 0; ; from \+= page\)/g)].map(m => m.index),
    ...[...src.matchAll(/\bpagedRows\(/g)].map(m => m.index),
  ].filter(i => i < def || i > defEnd); // the generic loop itself orders nothing
  assert.ok(starts.length >= 8, `scan regressed: found ${starts.length} paged reads`);
  for (const start of starts) {
    const body = src.slice(start, src.indexOf('\n}\n', start));
    const chains = body.split('.range(').slice(0, -1);
    assert.ok(chains.length, `paged read without a .range(:\n${body.slice(0, 300)}`);
    for (const chain of chains) {
      const orders = [...chain.matchAll(/\.order\(([^,)]+)/g)].map(m => m[1].trim());
      assert.ok(orders.length, `unordered paged read:\n${chain.slice(-400)}`);
      if (orders.length === 1) {
        assert.ok(UNIQUE.has(orders[0]), `paged read ordered only by non-unique ${orders[0]}:\n${chain.slice(-400)}`);
      }
    }
  }
});

// ---- PostgREST's max-rows cap ------------------------------------------------
// Every read is clamped at max-rows (1000) server-side, whatever .limit() asks
// for — so a .limit(1500) silently returns 1000. Past the cap, page.

const root = fileURLToPath(new URL('..', import.meta.url));
function sourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(js|jsx|mjs)$/.test(e.name)) out.push(rel);
  }
  return out;
}

test('source scan: no .limit() above PostgREST max-rows anywhere in src/ or api/', () => {
  const files = [...sourceFiles('src'), ...sourceFiles('api')];
  assert.ok(files.length > 20, `scan regressed: ${files.length} files`);
  for (const f of files) {
    const src = readFileSync(join(root, f), 'utf8');
    for (const m of src.matchAll(/\.limit\(\s*(\d+)\s*\)/g)) {
      assert.ok(Number(m[1]) <= 1000, `${f}: .limit(${m[1]}) is clamped to 1000 by PostgREST — page it`);
    }
  }
});

test('source scan: every category_rules READ pages, on both sides of the wire', () => {
  let reads = 0;
  for (const f of ['src/dataAdapter.js', 'api/sync.js']) {
    const src = readFileSync(join(root, f), 'utf8');
    for (const m of src.matchAll(/from\('category_rules'\)\s*\.select\(/g)) {
      reads++;
      const chain = src.slice(m.index, m.index + 600);
      assert.match(chain, /\.range\(/, `${f}: unpaged category_rules read:\n${chain.slice(0, 300)}`);
    }
  }
  assert.ok(reads >= 2, `scan regressed: found ${reads} category_rules reads`);
});

test('getMileage pages past max-rows in a total order', async () => {
  const calls = [];
  const client = {
    from() {
      const q = { orders: [], range: null };
      const b = {
        select() { return b; },
        gte() { return b; },
        lte() { return b; },
        order(c, o) { q.orders.push([c, o]); return b; },
        range(f, t) { q.range = [f, t]; return b; },
        limit(n) { q.range = [0, n - 1]; return b; },
        then(resolve, reject) {
          calls.push(q);
          const [f, t] = q.range;
          const n = Math.max(0, Math.min(t + 1, 1200) - f);
          const data = Array.from({ length: Math.min(n, 1000) }, (_, i) => ({ id: f + i }));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return b;
    },
  };
  const { mileage } = await getMileage(2026, { client });
  assert.equal(mileage.length, 1200);
  assert.deepEqual(calls.map(c => c.range), [[0, 999], [1000, 1999]]);
  assert.deepEqual(calls[0].orders, [['on_date', { ascending: false }], ['id', { ascending: false }]]);
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
