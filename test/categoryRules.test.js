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
  ilikeCandidatePattern,
  isRangeExhaustedError,
} from '../src/ruleHistory.js';
import { classifyDescription, merchantKey } from '../src/txClassify.js';
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

test('precedence at write time: learned rule → keyword table → Uncategorized', () => {
  const rules = { 'SAFEWAY STORE': 'Coffee and snacks' };
  // Learned beats the keyword table (which says Groceries).
  assert.equal(
    classifyDescription('SAFEWAY STORE 12', 45, 'depository', rules).mapped_category,
    'Coffee and snacks'
  );
  // Keyword table beats Uncategorized.
  assert.equal(
    classifyDescription('SAFEWAY STORE 12', 45, 'depository', null).mapped_category,
    'Groceries'
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
  const withoutRules = analyzeCsv(text);
  assert.deepEqual(withoutRules.rows.map(r => r.mapped_category), ['Groceries', FALLBACK_CATEGORY]);
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

test('deleting a rule: the next classification falls back to the keyword table; history is untouched', async () => {
  const db = makeDb([
    { id: 1, description: 'SAFEWAY STORE 12', mapped_category: 'Groceries' },
  ]);
  await apply(db, 'SAFEWAY STORE 12', 'Coffee and snacks');
  assert.equal(db.rows[0].mapped_category, 'Coffee and snacks');

  // Rule deleted → rules map no longer carries it: new rows classify by the
  // keyword table again…
  assert.equal(classifyDescription('SAFEWAY STORE 12', 45, 'depository', {}).mapped_category, 'Groceries');
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
  assert.deepEqual(first.rows.map(r => r.mapped_category), [FALLBACK_CATEGORY, FALLBACK_CATEGORY, 'Groceries']);
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
  assert.deepEqual(db.rows.map(r => r.mapped_category), ['Health and fitness', 'Health and fitness', 'Groceries']);

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
  assert.deepEqual(db.rows.map(r => r.mapped_category), ['Health and fitness', 'Health and fitness', 'Groceries']);
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
