import test from 'node:test';
import assert from 'node:assert/strict';
import {
  userCategoryList,
  missingCategories,
  isDuplicateCategoryName,
  isUserCategory,
  MECHANISM_CATEGORIES,
  rankByList,
} from '../src/categoryList.js';
import { readFileSync } from 'node:fs';
import { TRANSFER_CATEGORY, RETURN_CATEGORY, UNCATEGORIZED } from '../src/categoryMap.js';

// This module exists to fix Mason's bug: Categories, Budget and Transactions
// each answered "what categories exist" from a different expression. There is
// one answer now, and these tests pin the parts that could drift back.

test('the list is the registry plus anything real data still carries', () => {
  const list = userCategoryList({
    registry: ['Groceries', 'Date nights'],
    // Groceries repeats (spending + a budget); "Old rental" is a label that
    // survives only on rows — a retired registry entry, or a pre-wipe label.
    inUse: ['Groceries', 'Groceries', 'Old rental'],
  });
  assert.deepEqual(list, ['Date nights', 'Groceries', 'Old rental']);
});

test('REGRESSION: the three mechanism categories are never in the list', () => {
  const list = userCategoryList({
    registry: ['Groceries'],
    inUse: [TRANSFER_CATEGORY, RETURN_CATEGORY, UNCATEGORIZED],
  });
  // They are internals the spending model reads; the user cannot create,
  // rename, retire or budget them, so no picker may ever offer one.
  assert.deepEqual(list, ['Groceries']);
  for (const m of MECHANISM_CATEGORIES) assert.equal(isUserCategory(m), false);
});

test('blank and whitespace-only names are dropped, and names are trimmed', () => {
  assert.deepEqual(userCategoryList({ registry: ['  Kids  ', '', '   ', null, 7] }), ['Kids']);
});

test('sorting is by DISPLAY name, so a renamed category sits where its label reads', () => {
  const getName = (c) => (c === 'zzz-raw' ? 'Apples' : c);
  assert.deepEqual(
    userCategoryList({ registry: ['Bananas', 'zzz-raw'], getName }),
    ['zzz-raw', 'Bananas'],
  );
});

test('the order is stable and case-insensitive (a chip row must not reshuffle)', () => {
  const a = userCategoryList({ registry: ['pets', 'Auto', 'Books'] });
  const b = userCategoryList({ registry: ['Books', 'pets', 'Auto'] });
  assert.deepEqual(a, ['Auto', 'Books', 'pets']);
  assert.deepEqual(a, b);
});

test('missingCategories is what makes the Categories and Budget lists the same set', () => {
  const list = ['Auto', 'Books', 'Pets'];
  assert.deepEqual(missingCategories(list, new Set(['Books'])), ['Auto', 'Pets']);
  assert.deepEqual(missingCategories(list, ['Auto', 'Books', 'Pets']), []);
  assert.deepEqual(missingCategories(list, undefined), list);
});

test('duplicate guard is case-insensitive and also blocks the mechanism names', () => {
  assert.equal(isDuplicateCategoryName('groceries', ['Groceries']), true);
  assert.equal(isDuplicateCategoryName('  Groceries ', ['Groceries']), true);
  assert.equal(isDuplicateCategoryName('Groceries', ['Pets']), false);
  // A hand-made "Return" would collide with the retired mechanism label
  // mechanism label that stored rows may still carry.
  assert.equal(isDuplicateCategoryName('return', []), true);
  assert.equal(isDuplicateCategoryName('UNCATEGORIZED', []), true);
  assert.equal(isDuplicateCategoryName('transfers and card payments', []), true);
  // An empty name isn't a duplicate — it's just not addable (the caller's
  // canAdd checks emptiness), and reporting "already exists" would be a lie.
  assert.equal(isDuplicateCategoryName('   ', ['Pets']), false);
});

// --- 2026-10 audit: uniqueness covers DISPLAY names too ----------------------
// The guard checked only raw registry names: a new "Dining" beside Food-renamed-
// "Dining" passed, and the one list then rendered ['Dining','Dining'] with
// spending, budgets and envelopes split across two raw keys. Renames had no
// guard at all.
test('an existing category\'s display alias blocks an add', () => {
  assert.equal(isDuplicateCategoryName('dining', ['Food'], { aliases: { Food: 'Dining' } }), true);
  assert.equal(isDuplicateCategoryName('Dining', ['Food'], { aliases: { Food: '' } }), false, 'a cleared alias takes nothing');
  assert.equal(isDuplicateCategoryName('Dining', ['Food'], { aliases: { Gone: 'Dining' } }), false,
    'a retired category\'s leftover alias shows nowhere, so it blocks nothing');
  assert.equal(isDuplicateCategoryName('Dining', [], { aliases: { Old: 'Dining' }, inUse: ['Old'] }), true,
    'but an alias of a name rows still carry is on screen');
});

test('a case variant of a row-only name blocks; the exact name re-registers', () => {
  assert.equal(isDuplicateCategoryName('dining', [], { inUse: ['Dining'] }), true);
  assert.equal(isDuplicateCategoryName('Dining', [], { inUse: ['Dining'] }), false,
    'the exact name re-adds the same raw key — the retire-and-re-add path');
  assert.equal(isDuplicateCategoryName(' Dining ', [], { inUse: ['Dining'] }), false);
});

test('a rename may keep or re-case its own name, never another category\'s raw or display name', () => {
  assert.equal(isDuplicateCategoryName('food', ['Food', 'Pets'], { self: 'Food' }), false);
  assert.equal(isDuplicateCategoryName('Meals', ['Food'], { aliases: { Food: 'Meals' }, self: 'Food' }), false,
    'its own current alias is not a collision');
  assert.equal(isDuplicateCategoryName('Dining', ['Food', 'Eats'], { aliases: { Eats: 'Dining' }, self: 'Food' }), true);
  assert.equal(isDuplicateCategoryName('groceries', ['Food', 'Groceries'], { self: 'Food' }), true);
  assert.equal(isDuplicateCategoryName('Uncategorized', ['Food'], { self: 'Food' }), true, 'never a mechanism name');
});

test('the add sheet and saveName both run the full guard', () => {
  const dash = readFileSync(new URL('../src/components/Dashboard.jsx', import.meta.url), 'utf8');
  assert.match(dash, /isDuplicateCategoryName\(newName,customCatNames,\{aliases:customNames,inUse:userCats\}\)/);
  const save = dash.slice(dash.indexOf('async function saveName(cat,alias){'), dash.indexOf('async function addCustomCat('));
  assert.match(save, /isDuplicateCategoryName\(alias,\[\.\.\.customCatNames,\.\.\.userCats\],\{aliases:customNames,self:cat\}\)/);
  assert.ok(save.indexOf('window.alert(') < save.indexOf('updateCategoryAlias('), 'a refused rename never writes');
});

// --- rankByList: the Plan tab's row order ----------------------------------

test('REGRESSION: a Plan row keeps its place when it gets its first dollar', () => {
  // The Plan list ranked rows by the WALK's order — rows with an assignment,
  // setting or spending first, sorted by RAW label, then the empty top-up
  // rows. Assigning to Coffee moved it from the tail to the top, so the next
  // tap hit a different envelope; the alias (dining → Restaurants) sat out of
  // display order, and Uncategorized landed mid-list.
  const getName = (c) => (c === 'dining' ? 'Restaurants' : c);
  const userCats = userCategoryList({ registry: ['Pets', 'dining', 'Coffee', 'Groceries', 'Auto'], getName });
  assert.deepEqual(userCats, ['Auto', 'Coffee', 'Groceries', 'Pets', 'dining'], 'display-name order');
  const envRowsFor = (walk) => [...walk, ...missingCategories(userCats, new Set(walk))];
  const before = envRowsFor(['Groceries', UNCATEGORIZED, 'dining']);
  const after = envRowsFor(['Coffee', 'Groceries', UNCATEGORIZED, 'dining']);
  assert.notDeepEqual(before.indexOf('Coffee'), after.indexOf('Coffee'), 'walk order moves Coffee — the bug');
  const want = ['Auto', 'Coffee', 'Groceries', 'Pets', 'dining', UNCATEGORIZED];
  assert.deepEqual(rankByList(before, userCats), want);
  assert.deepEqual(rankByList(after, userCats), want, 'assigning Coffee moves nothing');
});

test('rankByList: names off the list keep their incoming order after every listed one; nothing dropped', () => {
  assert.deepEqual(
    rankByList([TRANSFER_CATEGORY, 'B', UNCATEGORIZED, 'A'], ['A', 'B']),
    ['A', 'B', TRANSFER_CATEGORY, UNCATEGORIZED],
  );
  assert.deepEqual(rankByList(['B', 'A'], ['A', 'A', 'B']), ['A', 'B'], 'a duplicate in the list ranks at its first spot');
  assert.deepEqual(rankByList(['X', 'B'], ['A', 'A', 'B']), ['B', 'X'], 'unlisted always after listed');
  assert.deepEqual(rankByList([], ['A']), []);
  assert.deepEqual(rankByList(null, null), []);
  assert.deepEqual(rankByList(['B', 'A'], null), ['B', 'A'], 'no list → incoming order');
});

test('the Plan tab ranks its envelopes by userCats, not by envRows\' walk order', () => {
  const dash = readFileSync(new URL('../src/components/Dashboard.jsx', import.meta.url), 'utf8');
  const start = dash.indexOf('const envRowByCat=');
  const block = dash.slice(start, dash.indexOf('const envGroups=', start) + 200);
  assert.ok(start > 0, 'found the Plan ordering block');
  assert.match(block, /const envOrder=rankByList\(envRows\.map\(r=>r\.category\),userCats\);/);
  assert.match(block, /const envPos=new Map\(envOrder\.map\(/);
  assert.match(block, /groupCategories\(envOrder,/);
  assert.doesNotMatch(block, /envRows\.map\(\(r,i\)/, 'positions no longer come from the walk order');
});
