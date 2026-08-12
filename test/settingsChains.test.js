// Settings read-merge-write chains at the CALL-SITE level (backlog 2026-08-04
// Session E item 1): updateRecIgnore / saveChatToApp / deleteSavedChat — and,
// since 2026-08-11, the category-registry rows (dash:cats / dash:colors /
// dash:names) — driven through the REAL binding code (makeSettingsChains in
// src/adapters/settingsIO.js) against a fake settings table with controllable
// latency and failure — the envelopeIO recording-fake pattern. The chain
// PRIMITIVE is pinned in test/serializedUpdater.test.js; this file pins what
// each site layers on top: per-key JSON round-tripping, the pure merges
// (toggleIgnoreKey / addSavedChat / removeSavedChat) running against the
// STORED value rather than component state, and the two rows' independence.
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeSettingsChains } from '../src/adapters/settingsIO.js';

// Fake settings table: key → raw string value, exactly db.js's surface
// (getSetting returns the stored string or null; setSetting stores a string).
function makeSettingsTable(initial = {}) {
  const t = {
    rows: { ...initial },
    reads: [], // keys read, in order
    writes: [], // { key, value } in order
    readDelay: 0,
    failNextRead: false,
  };
  t.db = {
    async getSetting(key) {
      t.reads.push(key);
      if (t.readDelay) await new Promise(r => setTimeout(r, t.readDelay));
      if (t.failNextRead) {
        t.failNextRead = false;
        throw new Error('settings read blip');
      }
      return Object.prototype.hasOwnProperty.call(t.rows, key) ? t.rows[key] : null;
    },
    async setSetting(key, value) {
      t.writes.push({ key, value });
      t.rows[key] = value;
    },
  };
  return t;
}

const chat = (id, q = 'question') => ({
  id,
  title: `${id} title`,
  savedAt: '2026-08-04T00:00:00.000Z',
  msgs: [
    { role: 'user', content: q },
    { role: 'assistant', content: 'answer' },
  ],
});

// --- rec:ignore ---------------------------------------------------------------

test('two quick ignore toggles keep BOTH keys (serialized, not last-array-wins)', async () => {
  const t = makeSettingsTable();
  t.readDelay = 5; // wide enough that unserialized read-merge-writes interleave
  const { updateRecIgnore } = makeSettingsChains(t.db);
  const [a, b] = await Promise.all([
    updateRecIgnore('netflix', true),
    updateRecIgnore('spotify', true),
  ]);
  assert.deepEqual(a, ['netflix']);
  assert.deepEqual(b, ['netflix', 'spotify'], 'second toggle must merge over the first COMMITTED write');
  assert.deepEqual(JSON.parse(t.rows['rec:ignore']), ['netflix', 'spotify']);
  assert.equal(t.writes.length, 2);
});

test('a failed read ABORTS the toggle before any write — the other phone\'s ignores survive', async () => {
  const t = makeSettingsTable({ 'rec:ignore': JSON.stringify(['hulu', 'gym']) });
  const { updateRecIgnore } = makeSettingsChains(t.db);
  t.failNextRead = true;
  await assert.rejects(() => updateRecIgnore('netflix', true), /read blip/);
  assert.deepEqual(t.writes, [], 'nothing may be written off a failed read');
  assert.deepEqual(JSON.parse(t.rows['rec:ignore']), ['hulu', 'gym']);
});

test('the chain survives a rejected toggle and the next one sees the true stored value', async () => {
  const t = makeSettingsTable({ 'rec:ignore': JSON.stringify(['hulu']) });
  const { updateRecIgnore } = makeSettingsChains(t.db);
  t.failNextRead = true;
  await assert.rejects(() => updateRecIgnore('lost-toggle', true));
  const next = await updateRecIgnore('netflix', true);
  assert.deepEqual(next, ['hulu', 'netflix'], 'the queue must not be dammed by one failure');
});

test('per-key merge: a toggle adopts keys the other phone stored since mount, and un-ignore removes only its own key', async () => {
  // This device mounted with [] (or a stale list); the other phone has since
  // stored ['gym']. The single-key merge runs against the STORED row.
  const t = makeSettingsTable({ 'rec:ignore': JSON.stringify(['gym']) });
  const { updateRecIgnore } = makeSettingsChains(t.db);
  assert.deepEqual(await updateRecIgnore('netflix', true), ['gym', 'netflix']);
  assert.deepEqual(await updateRecIgnore('gym', false), ['netflix'], 'un-ignore drops only the toggled key');
});

// --- asst:chats -----------------------------------------------------------------

test('two quick saves keep BOTH chats, newest first, JSON round-tripped through the row', async () => {
  const t = makeSettingsTable();
  t.readDelay = 5;
  const { saveChatToApp } = makeSettingsChains(t.db);
  const [a, b] = await Promise.all([
    saveChatToApp(chat('first')),
    saveChatToApp(chat('second')),
  ]);
  assert.deepEqual(a.map(c => c.id), ['first']);
  assert.deepEqual(b.map(c => c.id), ['second', 'first'], 'second save must merge over the first committed write');
  assert.deepEqual(JSON.parse(t.rows['asst:chats']).map(c => c.id), ['second', 'first']);
});

test('a failed read aborts a save AND a delete — a rebuilt-from-state array can never wipe the other phone\'s saves', async () => {
  const stored = [chat('keep-a'), chat('keep-b')];
  const t = makeSettingsTable({ 'asst:chats': JSON.stringify(stored) });
  const { saveChatToApp, deleteSavedChat } = makeSettingsChains(t.db);

  t.failNextRead = true;
  await assert.rejects(() => saveChatToApp(chat('new')), /read blip/);
  t.failNextRead = true;
  await assert.rejects(() => deleteSavedChat('keep-a'), /read blip/);

  assert.deepEqual(t.writes, []);
  assert.deepEqual(JSON.parse(t.rows['asst:chats']).map(c => c.id), ['keep-a', 'keep-b']);

  // ...and the chain continues: the delete after the blips still works and
  // removes ONLY its id.
  const after = await deleteSavedChat('keep-a');
  assert.deepEqual(after.map(c => c.id), ['keep-b']);
});

// --- dash:cats / dash:colors / dash:names -----------------------------------------

const entry = (id, name, extra = {}) => ({ id, name, color: '#7F77DD', ...extra });

test('WIPE-PREVENTION REGRESSION: a failed read aborts a category add, and the NEXT add merges over the stored registry — never a bare singleton', async () => {
  // The Dashboard.jsx hazard this replaces: mount read degraded to [], the
  // whole array was rebuilt from component state, and the first add wrote a
  // one-entry registry over the household's list.
  const stored = [entry('1', 'Groceries'), entry('2', 'Dining out')];
  const t = makeSettingsTable({ 'dash:cats': JSON.stringify(stored) });
  const { addRegistryEntry } = makeSettingsChains(t.db);

  t.failNextRead = true;
  await assert.rejects(() => addRegistryEntry(entry('3', 'Gas')), /read blip/);
  assert.deepEqual(t.writes, [], 'nothing may be written off a failed read');
  assert.deepEqual(JSON.parse(t.rows['dash:cats']).map(c => c.name), ['Groceries', 'Dining out']);

  const merged = await addRegistryEntry(entry('3', 'Gas'));
  assert.deepEqual(merged.map(c => c.name), ['Groceries', 'Dining out', 'Gas']);
  assert.equal(t.writes.length, 1);
  assert.deepEqual(
    JSON.parse(t.writes[0].value).map(c => c.name),
    ['Groceries', 'Dining out', 'Gas'],
    'the recovery write must carry the whole stored registry, not a rebuilt singleton'
  );
});

test('two quick category adds keep BOTH entries, and a re-add of a stored name is a no-op merge', async () => {
  const t = makeSettingsTable();
  t.readDelay = 5;
  const { addRegistryEntry } = makeSettingsChains(t.db);
  const [a, b] = await Promise.all([
    addRegistryEntry(entry('1', 'Gas')),
    addRegistryEntry(entry('2', 'Parking')),
  ]);
  assert.deepEqual(a.map(c => c.name), ['Gas']);
  assert.deepEqual(b.map(c => c.name), ['Gas', 'Parking'], 'second add must merge over the first COMMITTED write');
  // Dedup runs against the STORED registry (trimmed-name match), so a re-add
  // from a device whose mount predates the entry cannot duplicate it.
  const again = await addRegistryEntry(entry('9', ' Gas '));
  assert.deepEqual(again.map(c => c.id), ['1', '2']);
});

test('parent set/remove and retire merge against the stored registry and touch only their own entry', async () => {
  const stored = [entry('1', 'Transportation'), entry('2', 'Gas')];
  const t = makeSettingsTable({ 'dash:cats': JSON.stringify(stored) });
  const { updateRegistryParent, removeRegistryEntry } = makeSettingsChains(t.db);

  const linked = await updateRegistryParent('Gas', 'Transportation');
  assert.deepEqual(linked, [entry('1', 'Transportation'), entry('2', 'Gas', { parent: 'Transportation' })]);

  const unlinked = await updateRegistryParent('Gas', null);
  assert.deepEqual(unlinked, stored, 'removing the link deletes the field, nothing else');

  const retired = await removeRegistryEntry('1');
  assert.deepEqual(retired, [entry('2', 'Gas')], 'retire filters by id only');
});

test('a colour/alias edit adopts the other phone\'s keys, and a failed read aborts before a singleton-map write', async () => {
  const t = makeSettingsTable({
    'dash:colors': JSON.stringify({ Groceries: '#1D9E75' }),
    'dash:names': JSON.stringify({ Groceries: 'Food' }),
  });
  const { updateCategoryColor, updateCategoryAlias } = makeSettingsChains(t.db);

  assert.deepEqual(await updateCategoryColor('Gas', '#378ADD'), { Groceries: '#1D9E75', Gas: '#378ADD' });
  assert.deepEqual(await updateCategoryAlias('Gas', 'Fuel'), { Groceries: 'Food', Gas: 'Fuel' });

  t.failNextRead = true;
  await assert.rejects(() => updateCategoryColor('Dining out', '#D85A30'), /read blip/);
  assert.deepEqual(
    JSON.parse(t.rows['dash:colors']),
    { Groceries: '#1D9E75', Gas: '#378ADD' },
    'the other phone\'s colours survive the blip'
  );
});

test('a CORRUPT registry row reads as empty (tolerant parse), unlike a FAILED read', async () => {
  // Every renderer of these rows already degrades corrupt JSON to nothing, so
  // merging over empty matches what the app shows; only a read FAILURE aborts.
  const t = makeSettingsTable({ 'dash:cats': '{not json', 'dash:colors': '[]' });
  const { addRegistryEntry, updateCategoryColor } = makeSettingsChains(t.db);
  assert.deepEqual((await addRegistryEntry(entry('1', 'Gas'))).map(c => c.name), ['Gas']);
  assert.deepEqual(await updateCategoryColor('Gas', '#378ADD'), { Gas: '#378ADD' });
});

// --- row independence -------------------------------------------------------------

test('the two sites are independent rows: each chain touches only its own key', async () => {
  const t = makeSettingsTable({ 'asst:chats': JSON.stringify([chat('saved')]) });
  const { updateRecIgnore, saveChatToApp } = makeSettingsChains(t.db);
  await updateRecIgnore('netflix', true);
  await saveChatToApp(chat('another'));
  assert.deepEqual(
    t.writes.map(w => w.key),
    ['rec:ignore', 'asst:chats'],
  );
  assert.deepEqual(JSON.parse(t.rows['rec:ignore']), ['netflix']);
  assert.deepEqual(JSON.parse(t.rows['asst:chats']).map(c => c.id), ['another', 'saved']);
});
