import test from 'node:test';
import assert from 'node:assert/strict';
import {
  userCategoryList,
  missingCategories,
  isDuplicateCategoryName,
  isUserCategory,
  MECHANISM_CATEGORIES,
} from '../src/categoryList.js';
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
