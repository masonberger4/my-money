// Direct coverage for src/categoryMap.js — until now exercised only through
// csvImport/txClassify tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ERA_CATEGORIES,
  TRANSFER_CATEGORY,
  RETURN_CATEGORY,
  UNCATEGORIZED,
  FALLBACK_CATEGORY,
  isBudgetableCategory,
} from '../src/categoryMap.js';
import * as categoryMap from '../src/categoryMap.js';

// REGRESSION (2026-08-17, refund netting): the read-time "Return" synthesis is
// GONE. applyAccountRules rewrote every credit-account negative's category to
// the mechanism label 'Return', which is hidden from every picker — so a
// refund could never be filed against the purchase it reverses, and it counted
// in neither total. Mason's ruling made refunds categorizable and netting, and
// this pins that nothing resurrects the rewrite: a second copy would silently
// re-hide every refund on whichever read path called it.
test('nothing synthesises Return any more — applyAccountRules is retired', () => {
  assert.equal(categoryMap.applyAccountRules, undefined,
    'applyAccountRules must stay deleted (tombstoned in categoryMap.js)');
  // The LABEL survives on purpose: migration 20260805000001 spared stored
  // 'Return' values from the category wipe, so any that remain must keep
  // rendering as a mechanism category — unpickable and non-budgetable —
  // rather than reappearing as a real one.
  assert.equal(isBudgetableCategory(RETURN_CATEGORY), false);
  assert.ok(ERA_CATEGORIES.includes(RETURN_CATEGORY));
});

test('isBudgetableCategory: the bookkeeping categories are not budgetable; real + custom ones are', () => {
  assert.equal(isBudgetableCategory(UNCATEGORIZED), false);
  assert.equal(isBudgetableCategory(TRANSFER_CATEGORY), false);
  assert.equal(isBudgetableCategory(RETURN_CATEGORY), false);
  assert.equal(isBudgetableCategory('Groceries'), true);
  assert.equal(isBudgetableCategory('Climbing Gym'), true, 'a custom category is a category');
});

// The app ships NO categories (Mason, 2026-08-04): the user creates every one
// of them in the `dash:cats` registry and teaches it. ERA_CATEGORIES is no
// longer a taxonomy — it is exactly the three MECHANISM categories the app's
// own models depend on, and they must stay hidden from the user's picker.
test('ERA_CATEGORIES is the MECHANISM set: exactly the three internals, no taste categories', () => {
  assert.equal(new Set(ERA_CATEGORIES).size, ERA_CATEGORIES.length, 'no duplicates');
  assert.deepEqual(
    new Set(ERA_CATEGORIES),
    new Set([TRANSFER_CATEGORY, RETURN_CATEGORY, UNCATEGORIZED]),
    'only the three internals'
  );
});

test('REGRESSION: the deleted built-in taxonomy never comes back as a seed', () => {
  // Re-seeding any of these would resurrect the confidently-wrong guess this
  // change exists to kill (NEWREZ, a mortgage, landing in "Utilities").
  for (const gone of [
    'Groceries', 'Dining out', 'Utilities', 'Shopping and gear', 'Coffee and snacks',
    'Vehicle expenses', 'Travel and vacation', 'Healthcare and pharmacy',
    'Health and fitness', 'Entertainment and subscriptions', 'Childcare', 'Pets',
    'Ride shares', 'Public transit', 'Home maintenance and improvement', 'Education',
    'Side hustles and business', 'Cash, checks, and misc',
  ]) {
    assert.ok(!ERA_CATEGORIES.includes(gone), `${gone} is user-created now, never shipped`);
    // …and each is a perfectly ordinary budgetable category if a user makes it.
    assert.equal(isBudgetableCategory(gone), true);
  }
  assert.ok(!ERA_CATEGORIES.includes('Housing'), 'no Housing member');
  assert.ok(!ERA_CATEGORIES.includes('Income'), 'no Income member');
});

test('the fallback category is the honest unknown', () => {
  // The fallback is the honest unknown (also pinned by value in
  // test/csvImport.test.js — keep both).
  assert.equal(FALLBACK_CATEGORY, UNCATEGORIZED);
});
