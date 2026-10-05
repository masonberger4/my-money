// Category correction, applied backward and forward.
//
// Backward: the history-apply core (src/ruleHistory.js, extracted from
// dataAdapter's applyCategoryRuleToHistory) tested against a fake that
// implements PostgREST's actual contract — ilike semantics with escapes, and
// the PGRST103 out-of-range answer.
//
// Forward: write-time precedence through the real entry points both feeds use
// (classifyDescription / buildRows), plus the teach → apply → re-import
// sequence that would flip-flop if either side were wrong.
//
// txClassify.js unit coverage (merchantKey collapsing, prefix matching, the
// over-specific-key limit) already lives in test/txClassify.test.js — not
// duplicated here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRuleToHistory,
  bagWithRule,
  ilikeCandidatePattern,
  isRangeExhaustedError,
} from '../src/ruleHistory.js';
import { classifyDescription, matchLearnedRule, merchantKey } from '../src/txClassify.js';
import {
  getCategoryRules,
  setCategoryRule,
  deleteCategoryRule,
  listCategoryRules,
} from '../src/dataAdapter.js';
import { effectiveCategory } from '../src/spending.js';
import { analyzeCsv } from '../src/csvImport.js';
import { TRANSFER_CATEGORY, FALLBACK_CATEGORY } from '../src/categoryMap.js';

// --- The fake: PostgREST-shaped paging + ilike -------------------------------

// Real ilike semantics: % / _ wildcards, backslash escapes, case-insensitive.
// The fake must honor the escapes or the wildcard tests test nothing.
function ilikeToRegex(pat) {
  let out = '';
  const esc = c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '\\' && i + 1 < pat.length) {
      out += esc(pat[i + 1]);
      i++;
    } else if (c === '%') out += '[\\s\\S]*';
    else if (c === '_') out += '.';
    else out += esc(c);
  }
  return new RegExp(`^${out}$`, 'i');
}

function makeDb(rows) {
  const db = {
    rows: rows.map(r => ({ merchant_name: '', user_category: null, ...r })),
    updateBatches: [],
    fetchCalls: 0,
    patterns: [],
  };
  db.fetchPage = async (pat, from, to) => {
    db.fetchCalls++;
    db.patterns.push(pat);
    const re = ilikeToRegex(pat);
    const hits = db.rows
      .filter(r => re.test(r.description || '') || re.test(r.merchant_name || ''))
      .sort((a, b) => a.id - b.id)
      .map(r => ({
        id: r.id,
        description: r.description,
        merchant_name: r.merchant_name,
        mapped_category: r.mapped_category,
        // The real fetchPage selects amount too — an amount-scoped rule is
        // re-matched against the ROW's amount, so omitting it here would make
        // the scoped tests pass for the wrong reason.
        amount: r.amount,
      }));
    // PostgREST answers a Range starting past the last row with 416/PGRST103.
    if (from > 0 && from >= hits.length) {
      return { data: null, error: { code: 'PGRST103', message: 'Requested range not satisfiable' } };
    }
    return { data: hits.slice(from, to + 1), error: null };
  };
  db.updateBatch = async (ids, category) => {
    db.updateBatches.push([...ids]);
    for (const r of db.rows) if (ids.includes(r.id)) r.mapped_category = category;
    return { error: null };
  };
  return db;
}

const apply = (db, descriptor, category, opts = {}) =>
  applyRuleToHistory({
    descriptor,
    category,
    fetchPage: db.fetchPage,
    updateBatch: db.updateBatch,
    ...opts,
  });

// --- The PGRST103 paging contract --------------------------------------------

test('REGRESSION: a result set that is an EXACT multiple of the page terminates cleanly on PGRST103', () => {
  return (async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      description: `RUDYS SALON VISIT ${i}`,
      mapped_category: 'Uncategorized',
    }));
    const db = makeDb(rows);
    const count = await apply(db, 'RUDYS SALON', 'Health and fitness', { pageSize: 10 });
    assert.equal(count, 20);
    // Two full pages, then the out-of-range probe that must read as
    // end-of-data — not a throw folded into a broken preview.
    assert.equal(db.fetchCalls, 3);
    assert.ok(db.rows.every(r => r.mapped_category === 'Health and fitness'));
  })();
});

test('a partial last page terminates without the extra probe', async () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({
    id: i + 1,
    description: `RUDYS SALON VISIT ${i}`,
    mapped_category: 'Uncategorized',
  }));
  const db = makeDb(rows);
  assert.equal(await apply(db, 'RUDYS SALON', 'Health and fitness', { pageSize: 10 }), 15);
  assert.equal(db.fetchCalls, 2);
});

test('a REAL error still throws — never folded into a 0 count', async () => {
  // The thrown value is the raw PostgREST error object, exactly what
  // supabase-js reports — not an Error instance — so match on its shape.
  const db = makeDb([]);
  db.fetchPage = async () => ({ data: null, error: { code: '57014', message: 'canceling statement due to timeout' } });
  await assert.rejects(
    () => apply(db, 'RUDYS SALON', 'Health and fitness'),
    err => err.code === '57014'
  );

  // …and a failing WRITE throws too.
  const db2 = makeDb([{ id: 1, description: 'RUDYS SALON', mapped_category: 'Uncategorized' }]);
  db2.updateBatch = async () => ({ error: { code: '40001', message: 'serialization failure' } });
  await assert.rejects(
    () => apply(db2, 'RUDYS SALON', 'Health and fitness'),
    err => err.code === '40001'
  );
});

test('isRangeExhaustedError recognizes exactly the end-of-range shapes', () => {
  assert.equal(isRangeExhaustedError({ code: 'PGRST103' }), true);
  assert.equal(isRangeExhaustedError({ message: 'Requested range not satisfiable' }), true);
  assert.equal(isRangeExhaustedError({ code: '57014', message: 'timeout' }), false);
  assert.equal(isRangeExhaustedError(null), false);
});

// --- dryRun / write discipline -----------------------------------------------

test('dryRun count equals the ids a wet run writes; wet run writes mapped_category ONLY', async () => {
  const mk = () =>
    makeDb([
      { id: 1, description: 'RUDYS SALON 0042', mapped_category: 'Uncategorized' },
      // Override present: included in the rewrite, but user_category untouched
      // — the override still wins at read time.
      { id: 2, description: 'RUDYS SALON 0099', mapped_category: 'Uncategorized', user_category: 'Dining out' },
      // Already at the target: skipped.
      { id: 3, description: 'RUDYS SALON 0100', mapped_category: 'Health and fitness' },
      // Unrelated: untouched.
      { id: 4, description: 'NORTH HARDWARE', mapped_category: 'Home maintenance and improvement' },
    ]);

  const dry = mk();
  const dryCount = await apply(dry, 'RUDYS SALON', 'Health and fitness', { dryRun: true });
  assert.equal(dryCount, 2);
  assert.equal(dry.updateBatches.length, 0, 'dryRun writes nothing');
  assert.equal(dry.rows[0].mapped_category, 'Uncategorized');

  const wet = mk();
  assert.equal(await apply(wet, 'RUDYS SALON', 'Health and fitness'), dryCount);
  assert.deepEqual(wet.updateBatches, [[1, 2]]);
  const byId = Object.fromEntries(wet.rows.map(r => [r.id, r]));
  assert.equal(byId[1].mapped_category, 'Health and fitness');
  assert.equal(byId[2].mapped_category, 'Health and fitness');
  assert.equal(byId[2].user_category, 'Dining out', 'the override column is never written');
  assert.equal(effectiveCategory(byId[2]), 'Dining out', 'the override still wins at read time');
  assert.equal(byId[4].mapped_category, 'Home maintenance and improvement');
});

test('matching runs against BOTH merchant_name and description', async () => {
  const db = makeDb([
    { id: 1, description: 'ELECTRONIC PAYMENT 4471', merchant_name: 'RUDYS SALON', mapped_category: 'Uncategorized' },
    { id: 2, description: 'RUDYS SALON 0042', merchant_name: '', mapped_category: 'Uncategorized' },
    { id: 3, description: 'ELECTRONIC PAYMENT 4472', merchant_name: '', mapped_category: 'Uncategorized' },
  ]);
  assert.equal(await apply(db, 'RUDYS SALON', 'Health and fitness'), 2);
  assert.deepEqual(db.rows.map(r => r.mapped_category), [
    'Health and fitness',
    'Health and fitness',
    'Uncategorized',
  ]);
});

test('an empty (all-numeric) descriptor is a no-op — no fetches at all', async () => {
  const db = makeDb([{ id: 1, description: '123', mapped_category: 'Uncategorized' }]);
  assert.equal(await apply(db, '#123 456', 'Groceries'), 0);
  assert.equal(db.fetchCalls, 0);
});

// --- Wildcards, stated precisely ---------------------------------------------

test('a %/_ in a DESCRIPTOR can never inject ilike wildcards — merchantKey strips them first', async () => {
  const db = makeDb([
    { id: 1, description: 'JUICE BAR DOWNTOWN', mapped_category: 'Uncategorized' },
    // Would match a leaked "%100%_JUICE%"-style pattern via wildcards, but
    // must NOT be a candidate for the real '%JUICE%' narrowing… it is, via
    // the literal substring — the point is the PATTERN carries no wildcards.
    { id: 2, description: 'ORANGE JUICE CO', mapped_category: 'Uncategorized' },
  ]);
  await apply(db, '100%_JUICE #55', 'Groceries', { dryRun: true });
  assert.deepEqual(db.patterns, ['%JUICE%'], 'the descriptor’s % and _ never reach the pattern');
});

test('the pattern-build escape is real under ilike semantics (crafted key, direct call)', () => {
  // Unreachable through the entry point (merchantKey strips %/_), but the
  // extracted core keeps the escape — so test it directly with a crafted key.
  assert.equal(ilikeCandidatePattern('AB%CD EF'), '%AB\\%CD%');
  assert.equal(ilikeCandidatePattern('A_B'), '%A\\_B%');
  const re = ilikeToRegex(ilikeCandidatePattern('AB%CD'));
  assert.equal(re.test('ABXCD STORE'), false, 'escaped % must not act as a wildcard');
  assert.equal(re.test('AB%CD STORE'), true, 'it matches the literal character');
});

// --- The narrowing is a superset of the exact match --------------------------

test('ilike candidates that fail matchLearnedRule are NOT rewritten', async () => {
  // Rule taught from "COSTCO GAS #0117" → key "COSTCO GAS"; first-token
  // narrowing fetches every COSTCO row, the exact matcher keeps only the
  // gas-station ones ("COSTCO GAS" and "COSTCO WHSE" must stay distinct).
  const db = makeDb([
    { id: 1, description: 'COSTCO WHSE 55 LYNNWOOD', mapped_category: 'Shopping and gear' },
    { id: 2, description: 'COSTCO GAS SEATTLE', mapped_category: 'Uncategorized' },
    { id: 3, description: 'COSTCO GAS', mapped_category: 'Uncategorized' },
  ]);
  assert.equal(await apply(db, 'COSTCO GAS #0117', 'Vehicle expenses'), 2);
  assert.deepEqual(db.rows.map(r => r.mapped_category), [
    'Shopping and gear', // ilike hit, rule miss — untouched
    'Vehicle expenses',
    'Vehicle expenses',
  ]);
});

// --- Forward direction: write-time precedence --------------------------------

test('precedence at write time: learned rule → Uncategorized (the keyword table is gone)', () => {
  const rules = { 'SAFEWAY STORE': 'Coffee and snacks' };
  // A taught rule is the ONLY thing that assigns a category now.
  assert.equal(
    classifyDescription('SAFEWAY STORE 12', 45, 'depository', rules).mapped_category,
    'Coffee and snacks'
  );
  // Without one, the very same merchant is Uncategorized — nothing is guessed
  // (2026-08-04: the descriptor→category table was deleted with the taxonomy).
  assert.equal(
    classifyDescription('SAFEWAY STORE 12', 45, 'depository', null).mapped_category,
    FALLBACK_CATEGORY
  );
  // Fallback is the honest unknown.
  assert.equal(
    classifyDescription('TOTALLY UNKNOWN VENDOR 9', 45, 'depository', null).mapped_category,
    FALLBACK_CATEGORY
  );
  // A rule pointing at a CUSTOM category works — rules are household data,
  // not limited to the built-in taxonomy.
  assert.equal(
    classifyDescription('NORTH WALL CLIMBING', 55, 'depository', { 'NORTH WALL CLIMBING': 'Climbing Gym' })
      .mapped_category,
    'Climbing Gym'
  );
});

test('precedence through buildRows (the CSV/PDF write path)', () => {
  const text = [
    'Date,Description,Debit,Credit',
    '3/1/2026,SAFEWAY STORE 12,45.00,',
    '3/2/2026,TOTALLY UNKNOWN VENDOR 9,12.00,',
  ].join('\n');
  const withRules = analyzeCsv(text, { rules: { 'SAFEWAY STORE': 'Coffee and snacks' } });
  assert.deepEqual(withRules.rows.map(r => r.mapped_category), ['Coffee and snacks', FALLBACK_CATEGORY]);
  // With no rules at all, EVERY row imports Uncategorized — the import path
  // guesses nothing either.
  const withoutRules = analyzeCsv(text);
  assert.deepEqual(withoutRules.rows.map(r => r.mapped_category), [FALLBACK_CATEGORY, FALLBACK_CATEGORY]);
});

test('REGRESSION: a learned rule NEVER overrides the transfer/card-payment guards', () => {
  // "This card payment is Dining" loses — those guards protect spending
  // totals, and a rule that made card payments count as spending would
  // silently delete money from every total.
  const desc = 'CAPITAL ONE AUTOPAY PYMT';
  const rules = { [merchantKey(desc)]: 'Dining out' };
  assert.equal(merchantKey(desc), 'CAPITAL ONE AUTOPAY PYMT', 'fixture sanity: the rule keys the payment itself');
  const { mapped_category } = classifyDescription(desc, 400, 'depository', rules);
  assert.equal(mapped_category, TRANSFER_CATEGORY);

  const transfer = classifyDescription('ONLINE BANKING TRANSFER TO SAVINGS', 300, 'depository', {
    'ONLINE BANKING TRANSFER TO SAVINGS': 'Groceries',
  });
  assert.equal(transfer.mapped_category, TRANSFER_CATEGORY);
  assert.equal(transfer.raw_category, 'TRANSFER_OUT', 'the wash tagging is untouched by rules');
});

test('deleting a rule: the next classification falls back to Uncategorized; history is untouched', async () => {
  const db = makeDb([
    { id: 1, description: 'SAFEWAY STORE 12', mapped_category: 'Groceries' },
  ]);
  await apply(db, 'SAFEWAY STORE 12', 'Coffee and snacks');
  assert.equal(db.rows[0].mapped_category, 'Coffee and snacks');

  // Rule deleted → the rules map no longer carries it, and there is no keyword
  // table left to fall back to: new rows arrive Uncategorized, waiting to be
  // taught again…
  assert.equal(classifyDescription('SAFEWAY STORE 12', 45, 'depository', {}).mapped_category, FALLBACK_CATEGORY);
  // …while the rewritten history stays as the rule left it.
  assert.equal(db.rows[0].mapped_category, 'Coffee and snacks');
});

// --- The sequence that would flip-flop if either side were wrong -------------

test('teach → apply to history → re-import the same file: dedup holds, the rewrite survives, ids are stable', async () => {
  const FILE = [
    'Date,Description,Debit,Credit',
    '3/1/2026,RUDYS COLUMBIA CITY,30.00,',
    '3/5/2026,RUDYS COLUMBIA CITY,45.00,',
    '3/6/2026,SAFEWAY 1467,52.00,',
  ].join('\n');

  // 1. First import, before any rule exists: RUDYS is an unknown merchant.
  const first = analyzeCsv(FILE);
  assert.deepEqual(first.rows.map(r => r.mapped_category), [FALLBACK_CATEGORY, FALLBACK_CATEGORY, FALLBACK_CATEGORY]);
  const db = makeDb(
    first.rows.map((r, i) => ({
      id: i + 1,
      plaid_tx_id: r.plaid_tx_id,
      description: r.description,
      mapped_category: r.mapped_category,
    }))
  );

  // 2. Teach the merchant and apply to history.
  const rules = { RUDYS: 'Health and fitness' };
  assert.equal(await apply(db, 'RUDYS', 'Health and fitness'), 2);
  assert.deepEqual(db.rows.map(r => r.mapped_category), ['Health and fitness', 'Health and fitness', FALLBACK_CATEGORY]);

  // 3. Re-import the same file with the rule now active: identical ids, every
  // row a duplicate, so the importable set is empty and the rewrite is not
  // undone by a fresh Uncategorized insert.
  const second = analyzeCsv(FILE, {
    rules,
    existingIds: new Set(db.rows.map(r => r.plaid_tx_id)),
  });
  assert.deepEqual(second.rows.map(r => r.plaid_tx_id), first.rows.map(r => r.plaid_tx_id));
  assert.ok(second.rows.every(r => r.isDuplicate));
  assert.equal(second.rows.filter(r => !r.isDuplicate && !r.isOverlap).length, 0, 'nothing to insert');
  assert.deepEqual(db.rows.map(r => r.mapped_category), ['Health and fitness', 'Health and fitness', FALLBACK_CATEGORY]);
});

// --- countAll: the Taught-rules screen's match count -------------------------
// The distinction this option exists for: dryRun counts rows the rule would
// still CHANGE, so a rule that is already applied everywhere counts 0. Shown
// in a "Taught rules" list as the rule's match count, that 0 reads as "this
// rule matches nothing" and talks a human into deleting a working rule.

test('countAll counts rows the rule matches even when they are ALREADY the target category', async () => {
  const db = makeDb([
    { id: 1, description: 'RUDYS SALON A', mapped_category: 'Health and fitness' },
    { id: 2, description: 'RUDYS SALON B', mapped_category: 'Health and fitness' },
    { id: 3, description: 'SAFEWAY 1', mapped_category: 'Groceries' },
  ]);
  // The dry run — "how many would change" — is 0: the rule is fully applied.
  assert.equal(await apply(db, 'RUDYS SALON', 'Health and fitness', { dryRun: true }), 0);
  // countAll — "how many does it match at all" — is the honest 2.
  assert.equal(await apply(db, 'RUDYS SALON', 'Health and fitness', { countAll: true }), 2);
});

test('countAll never writes, even when rows would otherwise be updated', async () => {
  const db = makeDb([
    { id: 1, description: 'RUDYS SALON A', mapped_category: 'Uncategorized' },
    { id: 2, description: 'RUDYS SALON B', mapped_category: 'Uncategorized' },
  ]);
  // updateBatch throwing would surface as a rejection; the count must come
  // back clean and the rows must be untouched.
  const n = await apply(db, 'RUDYS SALON', 'Health and fitness', { countAll: true });
  assert.equal(n, 2);
  assert.deepEqual(db.updateBatches, [], 'no write batches were issued');
  assert.deepEqual(db.rows.map(r => r.mapped_category), ['Uncategorized', 'Uncategorized']);
});

test('countAll still honours the PGRST103 end-of-range contract across pages', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    description: `RUDYS SALON VISIT ${i}`,
    mapped_category: 'Health and fitness',
  }));
  const db = makeDb(rows);
  assert.equal(await apply(db, 'RUDYS SALON', 'Health and fitness', { countAll: true, pageSize: 10 }), 20);
});

test('countAll of a rule that matches nothing is a real 0, distinct from a failure', async () => {
  const db = makeDb([{ id: 1, description: 'SAFEWAY 1', mapped_category: 'Groceries' }]);
  assert.equal(await apply(db, 'RUDYS SALON', 'Health and fitness', { countAll: true }), 0);
  // A broken page must still THROW rather than resolve to 0 — the silent
  // -failure distinction the whole module is built around.
  const broken = makeDb([]);
  broken.fetchPage = async () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } });
  await assert.rejects(() =>
    applyRuleToHistory({
      descriptor: 'RUDYS SALON',
      category: 'Health and fitness',
      countAll: true,
      fetchPage: broken.fetchPage,
      updateBatch: broken.updateBatch,
    })
  );
});

// --- Amount-scoped rules -----------------------------------------------------
//
// The pure precedence rules live in test/txClassify.test.js; what is pinned
// here is the HISTORY-APPLY and the ADAPTER I/O around them — the two places
// where an amount can silently go missing (a select that omits the column, a
// delete that takes out the wrong slot).

test('an amount-scoped apply rewrites only rows with that exact amount', async () => {
  const db = makeDb([
    { id: 1, description: 'ZELLE TRANSFER TO SMITH', amount: 1800, mapped_category: 'Uncategorized' },
    { id: 2, description: 'ZELLE TRANSFER TO SMITH', amount: 1800.0, mapped_category: 'Uncategorized' },
    { id: 3, description: 'ZELLE TRANSFER TO JONES', amount: 45, mapped_category: 'Uncategorized' },
  ]);
  const n = await apply(db, 'ZELLE TRANSFER', 'Rent', { amount: 1800 });
  assert.equal(n, 2);
  assert.deepEqual(db.rows.map(r => r.mapped_category), ['Rent', 'Rent', 'Uncategorized']);
});

test('an amount-scoped rule matches on cents, not on sign or rounding luck', async () => {
  const db = makeDb([
    { id: 1, description: 'ZELLE TRANSFER', amount: 1800.0, mapped_category: 'Uncategorized' },
    { id: 2, description: 'ZELLE TRANSFER', amount: -1800, mapped_category: 'Uncategorized' },
    { id: 3, description: 'ZELLE TRANSFER', amount: 1800.01, mapped_category: 'Uncategorized' },
  ]);
  assert.equal(await apply(db, 'ZELLE TRANSFER', 'Rent', { amount: 1800 }), 1);
  assert.deepEqual(db.rows.map(r => r.mapped_category), ['Rent', 'Uncategorized', 'Uncategorized']);
});

test('numeric-as-string amounts (PostgREST) still match', async () => {
  const db = makeDb([
    { id: 1, description: 'ZELLE TRANSFER', amount: '1800.00', mapped_category: 'Uncategorized' },
  ]);
  assert.equal(await apply(db, 'ZELLE TRANSFER', 'Rent', { amount: '1800' }), 1);
});

test('an any-amount apply is unchanged by the new parameter', async () => {
  const db = makeDb([
    { id: 1, description: 'ZELLE TRANSFER', amount: 1800, mapped_category: 'Uncategorized' },
    { id: 2, description: 'ZELLE TRANSFER', amount: 45, mapped_category: 'Uncategorized' },
  ]);
  assert.equal(await apply(db, 'ZELLE TRANSFER', 'Transfers', {}), 2);
});

test('a scoped countAll counts only the matching amount and never writes', async () => {
  const db = makeDb([
    { id: 1, description: 'ZELLE TRANSFER', amount: 1800, mapped_category: 'Rent' },
    { id: 2, description: 'ZELLE TRANSFER', amount: 20, mapped_category: 'Rent' },
  ]);
  assert.equal(await apply(db, 'ZELLE TRANSFER', 'Rent', { amount: 1800, countAll: true }), 1);
  assert.equal(db.updateBatches.length, 0);
});

test('a scoped rule cannot see amounts if the page omits the column — so the page must carry it', async () => {
  // REGRESSION guard for the fetchPage contract: this is what a select that
  // forgot `amount` looks like, and it must fail loudly here rather than in
  // production as "the rule matches nothing".
  const db = makeDb([{ id: 1, description: 'ZELLE TRANSFER', amount: 1800, mapped_category: 'Uncategorized' }]);
  const inner = db.fetchPage;
  db.fetchPage = async (...a) => {
    const res = await inner(...a);
    if (res.data) res.data = res.data.map(({ amount, ...rest }) => rest);
    return res;
  };
  assert.equal(await apply(db, 'ZELLE TRANSFER', 'Rent', { amount: 1800 }), 0);
});

// --- Adapter I/O (recording fake — the envelopeIO pattern) -------------------
//
// ORDER MATTERS, as in test/envelopeIO.test.js: dataAdapter holds a
// module-level `rulesHaveAmount` degrade flag that only ever flips true→false,
// so the pre-migration fallback tests run LAST.

function fakeRulesClient(script, calls = []) {
  return {
    from(table) {
      const q = { table, op: 'select', payload: null, filters: [], columns: null, returning: null, orders: [], range: null };
      const b = {
        // .select() after a write is PostgREST's return=representation.
        select(cols) { if (q.op === 'select') q.columns = cols; else q.returning = cols; return b; },
        insert(p) { q.op = 'insert'; q.payload = p; return b; },
        update(p) { q.op = 'update'; q.payload = p; return b; },
        delete() { q.op = 'delete'; return b; },
        eq(c, v) { q.filters.push(['eq', c, v]); return b; },
        is(c, v) { q.filters.push(['is', c, v]); return b; },
        order(c, o) { q.orders.push([c, o ?? null]); return b; },
        range(f, t) { q.range = [f, t]; return b; },
        then(resolve, reject) {
          calls.push(q);
          if (!script.length) throw new Error(`fakeRulesClient: unscripted ${q.op} on ${q.table}`);
          const next = script.shift();
          const out = typeof next === 'function' ? next(q) : next;
          return Promise.resolve(out ?? { data: null, error: null }).then(resolve, reject);
        },
      };
      return b;
    },
  };
}

const amountMissingError = {
  code: '42703',
  message: 'column category_rules.amount does not exist',
  details: null,
  hint: null,
};

test('getCategoryRules groups multiple rows per key into { amount, category } entries', async () => {
  const calls = [];
  const client = fakeRulesClient([
    {
      data: [
        { merchant_key: 'ZELLE TRANSFER', category: 'Transfers', amount: null },
        // PostgREST hands numerics back as strings often enough to matter.
        { merchant_key: 'ZELLE TRANSFER', category: 'Rent', amount: '1800.00' },
        { merchant_key: 'SAFEWAY', category: 'Groceries', amount: null },
      ],
      error: null,
    },
  ], calls);
  const rules = await getCategoryRules({ client });
  assert.match(calls[0].columns, /amount/);
  assert.deepEqual(rules, {
    'ZELLE TRANSFER': [
      { amount: null, category: 'Transfers' },
      { amount: 1800, category: 'Rent' },
    ],
    SAFEWAY: [{ amount: null, category: 'Groceries' }],
  });
  // And the bag it produces is exactly what the matcher consumes.
  assert.equal(matchLearnedRule('ZELLE TRANSFER TO SMITH', rules, 1800), 'Rent');
  assert.equal(matchLearnedRule('ZELLE TRANSFER TO SMITH', rules, 45), 'Transfers');
});

test('setCategoryRule writes the exact slot: update .eq(amount), insert only when 0 rows came back', async () => {
  const calls = [];
  const client = fakeRulesClient([{ data: [], error: null }, { error: null }], calls);
  await setCategoryRule('Zelle Transfer to Smith', 'Rent', 1800, { client });

  assert.equal(calls[0].op, 'update');
  assert.deepEqual(calls[0].filters, [
    ['eq', 'merchant_key', 'ZELLE TRANSFER TO SMITH'],
    ['eq', 'amount', 1800],
  ]);
  assert.equal(calls[0].payload.category, 'Rent');
  assert.ok(calls[0].returning, 'the update must return rows, or 0-matched is unknowable');
  assert.equal(calls[1].op, 'insert');
  assert.equal(calls[1].payload.amount, 1800);
  assert.equal(calls[1].payload.category, 'Rent');
  // Never an upsert: ON CONFLICT cannot infer a partial unique index.
  assert.equal(calls.some(c => c.op === 'upsert'), false);
  // And never a delete: a delete whose follow-up insert dies leaves no rule.
  assert.equal(calls.some(c => c.op === 'delete'), false);
});

test('an any-amount setCategoryRule scopes its update with .is(amount, null)', async () => {
  const calls = [];
  const client = fakeRulesClient([{ data: [], error: null }, { error: null }], calls);
  await setCategoryRule('Safeway #1234', 'Groceries', null, { client });
  assert.deepEqual(calls[0].filters, [
    ['eq', 'merchant_key', 'SAFEWAY'],
    ['is', 'amount', null],
  ]);
  assert.equal('amount' in calls[1].payload, false);
});

test('re-teaching an existing slot is ONE update — no insert, no delete', async () => {
  const calls = [];
  const client = fakeRulesClient([{ data: [{ merchant_key: 'SAFEWAY' }], error: null }], calls);
  assert.equal(await setCategoryRule('Safeway', 'Household', null, { client }), 'SAFEWAY');
  assert.deepEqual(calls.map(c => c.op), ['update']);
});

test('insert 23505 (another phone taught the same slot first) re-runs the update once', async () => {
  const dup = { code: '23505', message: 'duplicate key value violates unique constraint "category_rules_any_amount_key"' };
  const calls = [];
  const client = fakeRulesClient([
    { data: [], error: null },
    { data: null, error: dup },
    { data: [{ merchant_key: 'SAFEWAY' }], error: null },
  ], calls);
  assert.equal(await setCategoryRule('Safeway', 'Groceries', null, { client }), 'SAFEWAY');
  assert.deepEqual(calls.map(c => c.op), ['update', 'insert', 'update']);
  assert.deepEqual(calls[2].filters, calls[0].filters, 'the retry is the same slot-scoped update');

  // The retry still matching nothing is a real failure — surfaced, not swallowed.
  const calls2 = [];
  const c2 = fakeRulesClient([{ data: [], error: null }, { data: null, error: dup }, { data: [], error: null }], calls2);
  await assert.rejects(() => setCategoryRule('Safeway', 'Groceries', null, { client: c2 }), e => e === dup);
});

test('an update error that is not a missing column throws and never inserts', async () => {
  const denied = { code: '42501', message: 'permission denied for table category_rules' };
  const calls = [];
  const client = fakeRulesClient([{ data: null, error: denied }], calls);
  await assert.rejects(() => setCategoryRule('Safeway', 'Groceries', null, { client }), e => e === denied);
  assert.equal(calls.length, 1);
});

// A stateful category_rules table (the datalayer repro shape): filters really
// select rows, writes really change them, and `failInsert` models the insert
// POST dying on the wire — the one write netRetry never re-sends.
function makeRulesTable(rows, { failInsert = false, failUpdate = false } = {}) {
  const t = { rows: rows.map(r => ({ amount: null, ...r })), ops: [] };
  t.client = {
    from() {
      const q = { op: 'select', payload: null, preds: [] };
      const b = {
        select() { return b; },
        insert(p) { q.op = 'insert'; q.payload = p; return b; },
        update(p) { q.op = 'update'; q.payload = p; return b; },
        delete() { q.op = 'delete'; return b; },
        eq(c, v) { q.preds.push(r => r[c] === v); return b; },
        is(c, v) { q.preds.push(r => (r[c] ?? null) === v); return b; },
        order() { return b; },
        range() { return b; },
        then(resolve, reject) {
          t.ops.push(q.op);
          const hit = r => q.preds.every(p => p(r));
          const loadFailed = { message: 'TypeError: Load failed', details: '', hint: '', code: '' };
          let out;
          if (q.op === 'select') out = { data: t.rows.filter(hit), error: null };
          else if (q.op === 'delete') { t.rows = t.rows.filter(r => !hit(r)); out = { data: null, error: null }; }
          else if (q.op === 'update') {
            if (failUpdate) out = { data: null, error: loadFailed };
            else {
              const matched = t.rows.filter(hit);
              for (const r of matched) Object.assign(r, q.payload);
              out = { data: matched.map(r => ({ merchant_key: r.merchant_key })), error: null };
            }
          } else if (q.op === 'insert') {
            if (failInsert) out = { data: null, error: loadFailed };
            else { t.rows.push({ amount: null, ...q.payload }); out = { data: null, error: null }; }
          }
          return Promise.resolve(out).then(resolve, reject);
        },
      };
      return b;
    },
  };
  return t;
}

test('REGRESSION: a re-teach on a flaky connection never leaves the merchant with no rule', async () => {
  // The delete-then-insert shape deleted COSTCO's rule, then lost the insert:
  // "rules left for COSTCO: []", every new COSTCO row Uncategorized.
  const t = makeRulesTable([{ merchant_key: 'COSTCO', category: 'Groceries' }], { failInsert: true });
  await setCategoryRule('COSTCO', 'Household', null, { client: t.client });
  assert.deepEqual(t.rows.filter(r => r.merchant_key === 'COSTCO').map(r => r.category), ['Household'],
    'the existing slot is rewritten in place — the insert is never needed');
  assert.deepEqual(t.ops, ['update']);
});

// postgrest-js hands up a plain object, not an Error — match the message.
const isLoadFailed = e => /Load failed/.test(e?.message);

test('a failed write leaves the prior rule exactly as it was', async () => {
  // The update itself dies: the old rule stands, the teach reports failure.
  const t1 = makeRulesTable([{ merchant_key: 'COSTCO', category: 'Groceries' }], { failUpdate: true });
  await assert.rejects(() => setCategoryRule('COSTCO', 'Household', null, { client: t1.client }), isLoadFailed);
  assert.deepEqual(t1.rows, [{ merchant_key: 'COSTCO', category: 'Groceries', amount: null }]);

  // A NEW scoped slot whose insert dies: the any-amount sibling is untouched.
  const t2 = makeRulesTable([{ merchant_key: 'COSTCO', category: 'Groceries' }], { failInsert: true });
  await assert.rejects(() => setCategoryRule('COSTCO', 'Household', 160, { client: t2.client }), isLoadFailed);
  assert.deepEqual(t2.rows, [{ merchant_key: 'COSTCO', category: 'Groceries', amount: null }]);
  assert.deepEqual(t2.ops, ['update', 'insert']);
});

test('deleteCategoryRule removes only the matching slot', async () => {
  const calls = [];
  const client = fakeRulesClient([{ error: null }, { error: null }], calls);
  await deleteCategoryRule('ZELLE TRANSFER', 1800, { client });
  assert.deepEqual(calls[0].filters, [
    ['eq', 'merchant_key', 'ZELLE TRANSFER'],
    ['eq', 'amount', 1800],
  ]);
  await deleteCategoryRule('ZELLE TRANSFER', null, { client });
  assert.deepEqual(calls[1].filters, [
    ['eq', 'merchant_key', 'ZELLE TRANSFER'],
    ['is', 'amount', null],
  ]);
});

test('listCategoryRules returns amount on the rows, coerced to a number', async () => {
  const calls = [];
  const client = fakeRulesClient([
    { data: [{ merchant_key: 'ZELLE TRANSFER', category: 'Rent', amount: '1800.00', source: 'user', updated_at: 'x' }], error: null },
  ], calls);
  const rows = await listCategoryRules({ client });
  assert.match(calls[0].columns, /amount/);
  assert.equal(rows[0].amount, 1800);
});

test('listCategoryRules pages in a TOTAL order: merchant_key, then amount nulls first', async () => {
  // merchant_key alone ties once amount-scoped rules exist (several rows per
  // key), and an OFFSET page boundary inside a tie can list one rule twice
  // and hide another.
  const calls = [];
  const client = fakeRulesClient([{ data: [], error: null }], calls);
  await listCategoryRules({ client });
  assert.deepEqual(calls[0].orders, [
    ['merchant_key', { ascending: true }],
    ['amount', { ascending: true, nullsFirst: true }],
  ]);
  assert.ok(calls[0].range, 'paged');
});

// --- pre-migration degrade (flips the module flag — keep LAST) ---------------

test('getCategoryRules degrades when the amount COLUMN is missing', async () => {
  const calls = [];
  const client = fakeRulesClient([
    amountMissingError && { data: null, error: amountMissingError },
    { data: [{ merchant_key: 'SAFEWAY', category: 'Groceries' }], error: null },
  ], calls);
  const rules = await getCategoryRules({ client });
  assert.match(calls[0].columns, /amount/);
  assert.doesNotMatch(calls[1].columns, /amount/);
  assert.deepEqual(rules, { SAFEWAY: [{ amount: null, category: 'Groceries' }] });
});

test('with the column missing, writes stop sending and filtering on it', async () => {
  const calls = [];
  const client = fakeRulesClient([{ data: [], error: null }, { error: null }], calls);
  await setCategoryRule('Safeway', 'Groceries', 1800, { client });
  // no .is/.eq on amount at all, and the insert omits the column
  assert.equal(calls[0].op, 'update');
  assert.deepEqual(calls[0].filters, [['eq', 'merchant_key', 'SAFEWAY']]);
  assert.equal('amount' in calls[1].payload, false);

  const calls2 = [];
  const c2 = fakeRulesClient([{ error: null }], calls2);
  await deleteCategoryRule('SAFEWAY', 1800, { client: c2 });
  assert.deepEqual(calls2[0].filters, [['eq', 'merchant_key', 'SAFEWAY']]);
});

test('listCategoryRules drops the amount column rather than reading it as a missing table', async () => {
  const calls = [];
  const client = fakeRulesClient([
    { data: [{ merchant_key: 'SAFEWAY', category: 'Groceries', source: 'user', updated_at: 'x' }], error: null },
  ], calls);
  const rows = await listCategoryRules({ client });
  assert.doesNotMatch(calls[0].columns, /amount/);
  // The amount ORDER goes with the column — ordering on it would fail the
  // same way selecting it does.
  assert.deepEqual(calls[0].orders, [['merchant_key', { ascending: true }]]);
  assert.equal(rows[0].amount, null);
  assert.notEqual(rows, null);
});

// --- Full-bag precedence in the history apply (the trim-editor's guard) ------
// applyRuleToHistory used to re-match rows against a bag containing ONLY the
// rule being taught, so an apply could clobber rows a previously taught
// amount-scoped or longer-key rule owns — and the next sync, classifying with
// the FULL bag, would flip the re-pulled rows back: a permanent split. The
// trim-the-key editor makes overlapping prefix keys the mainline flow, so the
// rewrite paths now take `rules` and only touch rows the taught rule WINS.

test('an existing amount-scoped rule keeps its rows through an overlapping prefix apply', async () => {
  const rules = { 'ZELLE TRANSFER': [{ amount: 1800, category: 'Rent' }] };
  const db = makeDb([
    { id: 1, description: 'ZELLE TRANSFER JOHN SMITH', amount: 1800, mapped_category: 'Rent' },
    { id: 2, description: 'ZELLE TRANSFER JOHN SMITH', amount: 50, mapped_category: 'Uncategorized' },
    { id: 3, description: 'ZELLE TO MOM', amount: 200, mapped_category: 'Uncategorized' },
  ]);
  // The trimmed teach: ZELLE → Personal, any amount, with the household bag.
  const dry = await apply(db, 'ZELLE', 'Personal', { dryRun: true, rules });
  assert.equal(dry, 2, 'the $1,800 rows the scoped rule wins must not be counted');
  const wet = await apply(db, 'ZELLE', 'Personal', { rules });
  assert.equal(wet, 2);
  assert.equal(db.rows.find(r => r.id === 1).mapped_category, 'Rent',
    'the scoped rule keeps its history — write-time precedence and the apply agree');
  assert.equal(db.rows.find(r => r.id === 2).mapped_category, 'Personal');
  assert.equal(db.rows.find(r => r.id === 3).mapped_category, 'Personal');
  // No flip-flop left: write-time classification of row 1 with the post-teach
  // bag still answers Rent, which is exactly what the apply preserved.
  const after = bagWithRule(rules, 'ZELLE', 'Personal', null);
  assert.equal(matchLearnedRule('ZELLE TRANSFER JOHN SMITH', after, 1800), 'Rent');
});

test('an existing longer-key rule keeps its rows through a shorter prefix apply', async () => {
  const rules = { 'COSTCO GAS': 'Transportation' };
  const db = makeDb([
    { id: 1, description: 'COSTCO GAS #0117 SEATTLE', amount: 45, mapped_category: 'Transportation' },
    { id: 2, description: 'COSTCO WHSE #0552', amount: 160, mapped_category: 'Uncategorized' },
  ]);
  const n = await apply(db, 'COSTCO', 'Shopping', { rules });
  assert.equal(n, 1, 'only the row the short rule actually wins');
  assert.equal(db.rows.find(r => r.id === 1).mapped_category, 'Transportation');
  assert.equal(db.rows.find(r => r.id === 2).mapped_category, 'Shopping');
});

test('re-teaching a key replaces its own slot in the bag — legacy string shape included', async () => {
  // The bag's old any-amount entry for the SAME key must be displaced by the
  // taught one (setCategoryRule's slot-scoped write), not shadow it.
  const rules = { ZELLE: 'Shopping' }; // legacy string shape, still read everywhere
  const db = makeDb([
    { id: 1, description: 'ZELLE TO MOM', amount: 200, mapped_category: 'Shopping' },
  ]);
  const n = await apply(db, 'ZELLE', 'Personal', { rules });
  assert.equal(n, 1, 'the row must follow the re-taught category');
  assert.equal(db.rows.find(r => r.id === 1).mapped_category, 'Personal');
});

test('countAll DELIBERATELY ignores the bag — it states the rule\'s reach, not who wins', async () => {
  const rules = { 'ZELLE TRANSFER': [{ amount: 1800, category: 'Rent' }] };
  const db = makeDb([
    { id: 1, description: 'ZELLE TRANSFER JOHN SMITH', amount: 1800, mapped_category: 'Rent' },
    { id: 2, description: 'ZELLE TO MOM', amount: 200, mapped_category: 'Personal' },
  ]);
  const n = await apply(db, 'ZELLE', 'Personal', {
    countAll: true,
    rules,
    updateBatch: () => { throw new Error('countAll must never write'); },
  });
  assert.equal(n, 2, 'countAll counts every row the rule matches AT ALL, scoped winners included');
});
