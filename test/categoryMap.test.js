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
  isTransferCategory,
  isReturnCategory,
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

test('ERA_CATEGORIES sanity: no duplicates, Uncategorized IS a member, no Housing/Income', () => {
  assert.equal(new Set(ERA_CATEGORIES).size, ERA_CATEGORIES.length, 'no duplicates');
  assert.ok(ERA_CATEGORIES.includes(UNCATEGORIZED), 'Uncategorized is a real taxonomy member');
  assert.ok(ERA_CATEGORIES.includes(TRANSFER_CATEGORY));
  assert.ok(ERA_CATEGORIES.includes(RETURN_CATEGORY));
  assert.ok(!ERA_CATEGORIES.includes('Housing'), 'no Housing member — mortgage maps to Utilities');
  assert.ok(!ERA_CATEGORIES.includes('Income'), 'no Income member');
});

test('the predicate helpers agree with the constants', () => {
  assert.equal(isTransferCategory(TRANSFER_CATEGORY), true);
  assert.equal(isTransferCategory(RETURN_CATEGORY), false);
  assert.equal(isReturnCategory(RETURN_CATEGORY), true);
  assert.equal(isReturnCategory(TRANSFER_CATEGORY), false);
  // The fallback is the honest unknown (also pinned by value in
  // test/csvImport.test.js — keep both).
  assert.equal(FALLBACK_CATEGORY, UNCATEGORIZED);
});
