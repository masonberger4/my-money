import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parentIndex, parentOf, hasChildren, eligibleParents, canSetParent,
  setRegistryParent, groupCategories, groupMembers, rollupFields,
  orderGroups, earliestMemberRank,
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


// ── GROUP ORDERING ─────────────────────────────────────────────────────────
// REGRESSION (review, 2026-08-05): groupCategories preserves the CALLER's
// top-level order, so a heading parent with no rows of its own arrives in the
// zero-spend tail the Categories tab appends — and rendered its (large) rollup
// below every tiny leaf, children in tow.

test('REGRESSION: a heading-only parent sorts by its ROLLUP, not by its own row', () => {
  const ix = parentIndex(reg(
    { name: 'Everyday' },
    { name: 'Groceries', parent: 'Everyday' },
    { name: 'Dining out', parent: 'Everyday' },
  ));
  // What the Categories tab hands over: spending rows biggest-first, then the
  // zero-spend top-ups appended. 'Everyday' has no rows of its own.
  const rows = {
    Groceries: { amount: 200 },
    'Dining out': { amount: 109 },
    Coffee: { amount: 12 },
    Everyday: { amount: 0 },
  };
  const list = ['Groceries', 'Dining out', 'Coffee', 'Everyday'];
  const grouped = groupCategories(list, ix, (c) => c).map((node) => ({
    ...node,
    roll: rollupFields(groupMembers(node), (n) => rows[n], ['amount']),
  }));
  // Before the fix: Coffee ($12) rendered above the $309 Everyday group.
  assert.deepEqual(grouped.map((g) => g.name), ['Coffee', 'Everyday']);
  const ordered = orderGroups(grouped, (g) => -g.roll.amount);
  assert.deepEqual(ordered.map((g) => g.name), ['Everyday', 'Coffee']);
  assert.deepEqual(ordered.map((g) => g.roll.amount), [309, 12]);
});

test('orderGroups is stable for equal keys and leaves a flat list untouched', () => {
  const gs = [{ name: 'A', v: 5 }, { name: 'B', v: 5 }, { name: 'C', v: 9 }];
  assert.deepEqual(orderGroups(gs, (g) => -g.v).map((g) => g.name), ['C', 'A', 'B']);
  assert.deepEqual(orderGroups(gs, () => 0).map((g) => g.name), ['A', 'B', 'C']);
  assert.deepEqual(orderGroups([], (g) => g.v), []);
});

test('orderGroups sorts a non-numeric key last instead of corrupting the order', () => {
  const gs = [{ name: 'A', v: undefined }, { name: 'B', v: 3 }, { name: 'C', v: 1 }];
  assert.deepEqual(orderGroups(gs, (g) => g.v).map((g) => g.name), ['C', 'B', 'A']);
});

test('REGRESSION: on the Budget tab a group takes its earliest member position', () => {
  // envRows is walk order followed by appended empty rows; the parent has no
  // budget_months row, so it is appended last.
  const order = ['Groceries', 'Rent', 'Dining out', 'Everyday'];
  const pos = new Map(order.map((n, i) => [n, i]));
  const node = { name: 'Everyday', children: ['Groceries', 'Dining out'] };
  assert.equal(earliestMemberRank(node, (n) => pos.get(n)), 0);
  assert.equal(earliestMemberRank({ name: 'Rent', children: [] }, (n) => pos.get(n)), 1);
  // So the group sits where its children already sat, not after every envelope.
  const groups = orderGroups(
    [{ name: 'Rent', children: [] }, node],
    (g) => earliestMemberRank(g, (n) => pos.get(n)),
  );
  assert.deepEqual(groups.map((g) => g.name), ['Everyday', 'Rent']);
});

test('earliestMemberRank returns Infinity when no member is in the list', () => {
  assert.equal(earliestMemberRank({ name: 'X', children: ['Y'] }, () => undefined), Infinity);
});
