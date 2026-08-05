import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parentIndex, parentOf, hasChildren, eligibleParents, canSetParent,
  setRegistryParent, groupCategories, groupMembers, rollupFields,
} from '../src/categoryTree.js';
import { UNCATEGORIZED, TRANSFER_CATEGORY, RETURN_CATEGORY } from '../src/categoryMap.js';

const reg = (...entries) => entries.map((e, i) => ({ id: String(i), color: '#7F77DD', ...e }));

test('parentIndex links a child to its parent', () => {
  const ix = parentIndex(reg({ name: 'Transportation' }, { name: 'Gas', parent: 'Transportation' }));
  assert.equal(parentOf(ix, 'Gas'), 'Transportation');
  assert.equal(parentOf(ix, 'Transportation'), null);
  assert.equal(hasChildren(ix, 'Transportation'), true);
  assert.equal(hasChildren(ix, 'Gas'), false);
});

test('a dangling parent is dropped, not obeyed — the category stays top-level', () => {
  const ix = parentIndex(reg({ name: 'Gas', parent: 'Transportation' }));
  assert.equal(parentOf(ix, 'Gas'), null);
});

test('a parent retired from the registry but still carried by real data stays a parent', () => {
  const ix = parentIndex(reg({ name: 'Gas', parent: 'Transportation' }), ['Transportation']);
  assert.equal(parentOf(ix, 'Gas'), 'Transportation');
});

test('REGRESSION: one level only — a grandchild flattens rather than re-parenting', () => {
  const ix = parentIndex(reg(
    { name: 'Transportation' },
    { name: 'Gas', parent: 'Transportation' },
    { name: 'Premium', parent: 'Gas' },
  ));
  assert.equal(parentOf(ix, 'Gas'), 'Transportation');
  // NOT 'Transportation' — silently re-parenting would move money under a
  // heading the user never chose.
  assert.equal(parentOf(ix, 'Premium'), null);
});

test('mechanism categories can never be a parent or a child', () => {
  const ix = parentIndex(reg(
    { name: 'Transportation' },
    { name: UNCATEGORIZED, parent: 'Transportation' },
    { name: 'Gas', parent: UNCATEGORIZED },
    { name: 'Tolls', parent: TRANSFER_CATEGORY },
    { name: 'Refunds', parent: RETURN_CATEGORY },
  ));
  assert.equal(parentOf(ix, UNCATEGORIZED), null);
  assert.equal(parentOf(ix, 'Gas'), null);
  assert.equal(parentOf(ix, 'Tolls'), null);
  assert.equal(parentOf(ix, 'Refunds'), null);
});

test('self-parenting is ignored', () => {
  assert.equal(parentOf(parentIndex(reg({ name: 'Gas', parent: 'Gas' })), 'Gas'), null);
});

test('names are trimmed on both sides of the link', () => {
  const ix = parentIndex(reg({ name: ' Transportation ' }, { name: ' Gas ', parent: ' Transportation ' }));
  assert.equal(parentOf(ix, 'Gas'), 'Transportation');
});

test('eligibleParents: top-level, non-mechanism, never itself', () => {
  const ix = parentIndex(reg({ name: 'Transportation' }, { name: 'Gas', parent: 'Transportation' }));
  const list = ['Transportation', 'Gas', 'Groceries', UNCATEGORIZED];
  assert.deepEqual(eligibleParents(list, ix, 'Groceries'), ['Transportation']);
  // Creating a new category: nothing to exclude but the existing children.
  assert.deepEqual(eligibleParents(list, ix, null), ['Transportation', 'Groceries']);
  // A category can't be offered itself.
  assert.deepEqual(eligibleParents(list, ix, 'Transportation'), []);
});

test('canSetParent enforces the one-level rule in both directions', () => {
  const ix = parentIndex(reg({ name: 'Transportation' }, { name: 'Gas', parent: 'Transportation' }));
  assert.equal(canSetParent(ix, 'Groceries', 'Transportation').ok, true);
  // A child can't become a parent...
  assert.equal(canSetParent(ix, 'Groceries', 'Gas').ok, false);
  // ...and a parent can't become a child.
  assert.equal(canSetParent(ix, 'Transportation', 'Groceries').ok, false);
  assert.equal(canSetParent(ix, 'Gas', 'Gas').ok, false);
  assert.equal(canSetParent(ix, 'Gas', UNCATEGORIZED).ok, false);
  assert.equal(canSetParent(ix, UNCATEGORIZED, 'Transportation').ok, false);
  // Removing is always allowed.
  assert.equal(canSetParent(ix, 'Gas', null).ok, true);
  assert.equal(canSetParent(ix, 'Gas', '').ok, true);
  assert.equal(typeof canSetParent(ix, 'Transportation', 'Groceries').reason, 'string');
});

test('setRegistryParent sets, changes and removes without touching other entries', () => {
  const r = reg({ name: 'Transportation' }, { name: 'Gas' }, { name: 'Groceries' });
  const set = setRegistryParent(r, 'Gas', 'Transportation');
  assert.equal(set.find((c) => c.name === 'Gas').parent, 'Transportation');
  assert.equal('parent' in set.find((c) => c.name === 'Groceries'), false);
  assert.equal(r.find((c) => c.name === 'Gas').parent, undefined, 'input not mutated');

  const moved = setRegistryParent(set, 'Gas', 'Groceries');
  assert.equal(moved.find((c) => c.name === 'Gas').parent, 'Groceries');

  const removed = setRegistryParent(set, 'Gas', null);
  assert.equal('parent' in removed.find((c) => c.name === 'Gas'), false);
  // Color and id survive — removing a parent is not a re-creation.
  assert.equal(removed.find((c) => c.name === 'Gas').color, '#7F77DD');
});

test('groupCategories preserves the caller order for top-level rows', () => {
  const ix = parentIndex(reg(
    { name: 'Transportation' },
    { name: 'Gas', parent: 'Transportation' },
    { name: 'Apples' },
  ));
  // Biggest-spend-first, as the Categories tab hands them over.
  const groups = groupCategories(['Transportation', 'Apples', 'Gas'], ix, (c) => c);
  assert.deepEqual(groups.map((g) => g.name), ['Transportation', 'Apples']);
  assert.deepEqual(groups[0].children, ['Gas']);
});

test('groupCategories orders children by DISPLAY name', () => {
  const ix = parentIndex(reg(
    { name: 'Transportation' },
    { name: 'gas_raw', parent: 'Transportation' },
    { name: 'Parking', parent: 'Transportation' },
    { name: 'Apples' },
  ));
  const getName = (c) => (c === 'gas_raw' ? 'Gas' : c);
  const groups = groupCategories(['Transportation', 'gas_raw', 'Parking', 'Apples'], ix, getName);
  assert.deepEqual(groups.map((g) => g.name), ['Transportation', 'Apples']);
  assert.deepEqual(groups[0].children, ['gas_raw', 'Parking']);
});

test('a child whose parent is absent from the list renders top-level', () => {
  const ix = parentIndex(reg({ name: 'Transportation' }, { name: 'Gas', parent: 'Transportation' }));
  const groups = groupCategories(['Gas'], ix, (c) => c);
  assert.deepEqual(groups.map((g) => g.name), ['Gas']);
});

test('groupMembers includes the parent itself — rows tagged directly to it still count', () => {
  assert.deepEqual(groupMembers({ name: 'Transportation', children: ['Gas', 'Parking'] }),
    ['Transportation', 'Gas', 'Parking']);
  assert.deepEqual(groupMembers({ name: 'Apples' }), ['Apples']);
});

test('rollupFields sums own + children and treats a missing row as 0', () => {
  const rows = {
    Transportation: { amount: 20, transaction_count: 1 },
    Gas: { amount: 100, transaction_count: 4 },
    // Parking: no row this month
  };
  const got = rollupFields(['Transportation', 'Gas', 'Parking'], (n) => rows[n],
    ['amount', 'transaction_count']);
  assert.deepEqual(got, { amount: 120, transaction_count: 5 });
});

test('rollupFields ignores non-numeric values rather than producing NaN', () => {
  const got = rollupFields(['A', 'B'], (n) => ({ A: { v: 5 }, B: { v: null } })[n], ['v']);
  assert.deepEqual(got, { v: 5 });
});
