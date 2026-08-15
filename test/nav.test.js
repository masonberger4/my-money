// The bottom-nav map (src/nav.js): every internal tab value must belong to
// exactly one of the five items, so the bar always has a highlight and the
// smoke harness's 11-view walk stays complete by construction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NAV_ITEMS, REFLECT_TABS, navForTab, pageTitle } from '../src/nav.js';

const ALL_TABS = [
  'overview', 'categories', 'budget', 'transactions', 'accounts',
  'debt', 'trends', 'recurring', 'tax', 'ask', 'reflect',
];

test('five items, unique ids, each owning a distinct primary tab', () => {
  assert.equal(NAV_ITEMS.length, 5);
  assert.equal(new Set(NAV_ITEMS.map(i => i.id)).size, 5, 'ids unique');
  assert.equal(new Set(NAV_ITEMS.map(i => i.tab)).size, 5, 'primary tabs unique');
  for (const i of NAV_ITEMS) {
    assert.ok(i.label && i.icon, `${i.id} has a label and an icon`);
    assert.equal(navForTab(i.tab), i.id, `${i.id} highlights for its own tab`);
  }
});

test('every internal tab value maps to exactly one nav item', () => {
  const ids = new Set(NAV_ITEMS.map(i => i.id));
  for (const t of ALL_TABS) {
    const id = navForTab(t);
    assert.ok(ids.has(id), `${t} -> ${id} is a real nav item`);
  }
  // The groupings the IA decided (spec §2): debt rides Accounts, the five
  // report tabs ride Reflect.
  assert.equal(navForTab('debt'), 'accounts');
  for (const t of REFLECT_TABS) assert.equal(navForTab(t), 'reflect', `${t} lives under Reflect`);
});

test('REFLECT_TABS is complete and disjoint from the primary tabs', () => {
  assert.deepEqual([...REFLECT_TABS].sort(), ['ask', 'categories', 'recurring', 'tax', 'trends']);
  const primaries = new Set(NAV_ITEMS.map(i => i.tab));
  for (const t of REFLECT_TABS) assert.ok(!primaries.has(t), `${t} is not a primary tab`);
});

test('unknown tab values degrade to Home (never a highlight-less bar)', () => {
  assert.equal(navForTab('nonsense'), 'home');
  assert.equal(navForTab(undefined), 'home');
});

test('every tab value has a non-empty page title', () => {
  for (const t of ALL_TABS) {
    assert.ok(pageTitle(t) && typeof pageTitle(t) === 'string', `title for ${t}`);
  }
  assert.equal(pageTitle('nonsense'), 'Home');
});
