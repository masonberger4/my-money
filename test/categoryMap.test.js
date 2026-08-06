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
  applyAccountRules,
} from '../src/categoryMap.js';

test('applyAccountRules: a credit-card negative becomes Return; everything else is untouched', () => {
  assert.equal(applyAccountRules('Groceries', -35, 'credit'), RETURN_CATEGORY);
  assert.equal(applyAccountRules(UNCATEGORIZED, -0.01, 'credit'), RETURN_CATEGORY);
  // Depository negatives are real deposits — never Return.
  assert.equal(applyAccountRules('Groceries', -35, 'depository'), 'Groceries');
  // Positives are untouched on every account type.
  assert.equal(applyAccountRules('Groceries', 35, 'credit'), 'Groceries');
  assert.equal(applyAccountRules('Groceries', 35, 'depository'), 'Groceries');
  // Zero is not negative.
  assert.equal(applyAccountRules('Groceries', 0, 'credit'), 'Groceries');
  // Unknown account type passes through.
  assert.equal(applyAccountRules('Groceries', -35, undefined), 'Groceries');
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
