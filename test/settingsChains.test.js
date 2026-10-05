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
import { readFileSync } from 'node:fs';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeSettingsChains } from '../src/adapters/settingsIO.js';
import { makeEnvPaceChain } from '../src/adapters/envelopeIO.js';

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

// --- tax:maps (2026-10 audit) ---------------------------------------------------
// The Tax tab wrote this row as a whole map rebuilt from component state: a
// failed Tax-tab read degraded state to "no mappings" and the first edit then
// wiped every stored Schedule E line + deduction pick, and a phone holding an
// older read erased the other phone's newer mapping with no error.

const taxMaps = (emap = {}, dmap = {}) => JSON.stringify({ emap, dmap });

test('WIPE-PREVENTION REGRESSION: a failed read aborts a tax-map edit, and the next edit merges over the stored maps — never a bare singleton', async () => {
  const t = makeSettingsTable({
    'tax:maps': taxMaps({ P: { Repairs: 14, Insurance: 9 }, Q: { Rent: 'rents' } }, { Gifts: 'charitable' }),
  });
  const { setTaxMapEntry } = makeSettingsChains(t.db);

  t.failNextRead = true;
  await assert.rejects(() => setTaxMapEntry('P', 'Utilities', 17), /read blip/);
  assert.deepEqual(t.writes, [], 'nothing may be written off a failed read');

  const merged = await setTaxMapEntry('P', 'Utilities', 17);
  const want = {
    emap: { P: { Repairs: 14, Insurance: 9, Utilities: 17 }, Q: { Rent: 'rents' } },
    dmap: { Gifts: 'charitable' },
  };
  assert.deepEqual(merged, want);
  assert.equal(t.writes.length, 1);
  assert.deepEqual(JSON.parse(t.writes[0].value), want, 'the write carries every stored mapping');
});

test('a tax-map edit adopts the other phone\'s mapping instead of erasing it', async () => {
  // Phone B already stored P.Repairs; phone A (holding an older read) maps
  // Insurance. The stored row must end with both.
  const t = makeSettingsTable({ 'tax:maps': taxMaps({ P: { Repairs: 14 } }) });
  const { setTaxMapEntry } = makeSettingsChains(t.db);
  const merged = await setTaxMapEntry('P', 'Insurance', 9);
  assert.deepEqual(merged.emap, { P: { Repairs: 14, Insurance: 9 } });
  assert.deepEqual(JSON.parse(t.rows['tax:maps']).emap, { P: { Repairs: 14, Insurance: 9 } });
});

test('two quick same-device tax-map edits serialize and both survive', async () => {
  const t = makeSettingsTable();
  t.readDelay = 5;
  const { setTaxMapEntry, setDeductionMapEntry } = makeSettingsChains(t.db);
  await Promise.all([
    setTaxMapEntry('P', 'Repairs', 14),
    setTaxMapEntry('P', 'Insurance', 9),
    setDeductionMapEntry('Gifts', 'charitable'),
  ]);
  assert.deepEqual(JSON.parse(t.rows['tax:maps']), {
    emap: { P: { Repairs: 14, Insurance: 9 } },
    dmap: { Gifts: 'charitable' },
  });
});

test('removing a tax mapping deletes only its own key; a dmap edit leaves emap alone and vice versa', async () => {
  const t = makeSettingsTable({
    'tax:maps': taxMaps({ P: { Repairs: 14, Insurance: 9 }, Q: { Taxes: 16 } }, { Gifts: 'charitable', Doctor: 'medical' }),
  });
  const { setTaxMapEntry, setDeductionMapEntry } = makeSettingsChains(t.db);
  const a = await setTaxMapEntry('P', 'Repairs', null);
  assert.deepEqual(a.emap, { P: { Insurance: 9 }, Q: { Taxes: 16 } });
  assert.deepEqual(a.dmap, { Gifts: 'charitable', Doctor: 'medical' }, 'an emap edit never touches dmap');
  const b = await setDeductionMapEntry('Doctor', null);
  assert.deepEqual(b.dmap, { Gifts: 'charitable' });
  assert.deepEqual(b.emap, { P: { Insurance: 9 }, Q: { Taxes: 16 } }, 'a dmap edit never touches emap');
});

test('Dashboard writes tax:maps only through the chain, and its load adopts the stored row', () => {
  const src = readFileSync(new URL('../src/components/Dashboard.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /setSetting\(\s*["']tax:maps["']/, 'no whole-map write from component state');
  assert.match(src, /setTaxMapEntry\(/);
  assert.match(src, /setDeductionMapEntry\(/);
  assert.doesNotMatch(src, /getSetting\(\s*["']tax:maps["']\s*\)\.catch\(\s*\(\)\s*=>\s*null\s*\)/,
    'a FAILED read must not masquerade as "no mappings"');
  assert.doesNotMatch(src, /if\(prev\)return prev; \/\/ don't clobber/,
    'a refetch must take up the stored value (the other phone\'s mappings)');
});

test('a CORRUPT tax:maps row reads as empty (tolerant parse), unlike a FAILED read', async () => {
  const t = makeSettingsTable({ 'tax:maps': '{not json' });
  const { setTaxMapEntry } = makeSettingsChains(t.db);
  assert.deepEqual(await setTaxMapEntry('P', 'Repairs', 14), { emap: { P: { Repairs: 14 } }, dmap: {} });
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

test('tax:maps is its own row: its chain never touches the dash:* registry rows', async () => {
  const t = makeSettingsTable({ 'dash:names': JSON.stringify({ Food: 'Dining' }) });
  const { setTaxMapEntry, updateCategoryAlias } = makeSettingsChains(t.db);
  await Promise.all([setTaxMapEntry('P', 'Food', 14), updateCategoryAlias('Gas', 'Fuel')]);
  assert.deepEqual(t.writes.map(w => w.key).sort(), ['dash:names', 'tax:maps']);
  assert.deepEqual(JSON.parse(t.rows['dash:names']), { Food: 'Dining', Gas: 'Fuel' });
  assert.deepEqual(JSON.parse(t.rows['tax:maps']).emap, { P: { Food: 14 } });
});

// --- 2026-09-04 audit: env:pace needed the same discipline as rec:ignore ----
// The pace toggle persisted the whole map rebuilt from LOCAL state, so a phone
// holding a stale read (a blipped mount, or simply loading before the other
// phone's opt-ins) wrote that map back over everything on its first tap. The
// other phone's warnings vanished on its next launch with nothing to say so.
// This is the failure updateRecIgnore already fixed for its own key.
test('updateEnvPace merges one key at a time and never writes a stale whole map', async () => {
  const store = new Map([['env:pace', JSON.stringify({ Groceries: true, Gas: true, Fun: true })]]);
  const db = {
    getSetting: async k => store.get(k) ?? null,
    setSetting: async (k, v) => { store.set(k, v); },
  };
  const chains = makeEnvPaceChain(db);

  // A phone that mounted BEFORE those three opt-ins existed still holds {}.
  // Its tap must add one key, not replace the map with its own view.
  const merged = await chains.updateEnvPace('Dining', true);
  assert.deepEqual(
    merged,
    { Groceries: true, Gas: true, Fun: true, Dining: true },
    'the other phone\'s opt-ins survive'
  );
  assert.deepEqual(JSON.parse(store.get('env:pace')), merged, 'and that is what was stored');

  const off = await chains.updateEnvPace('Gas', false);
  assert.deepEqual(off, { Groceries: true, Fun: true, Dining: true }, 'turning one off removes only it');
});

test('concurrent updateEnvPace calls serialize rather than clobbering', async () => {
  const store = new Map();
  let reads = 0;
  const db = {
    getSetting: async k => { reads++; await new Promise(r => setTimeout(r, 1)); return store.get(k) ?? null; },
    setSetting: async (k, v) => { store.set(k, v); },
  };
  const chains = makeEnvPaceChain(db);
  await Promise.all([
    chains.updateEnvPace('A', true),
    chains.updateEnvPace('B', true),
    chains.updateEnvPace('C', true),
  ]);
  assert.deepEqual(JSON.parse(store.get('env:pace')), { A: true, B: true, C: true });
  assert.ok(reads >= 3, 'each update re-read rather than reusing one snapshot');
});

// --- No whole-map / whole-list writer is handed out ---------------------------
// setRecIgnore / setEnvPace persisted a map or list REBUILT FROM LOCAL STATE —
// the stale-phone overwrite updateRecIgnore / updateEnvPace were built to end.
// Nothing called them, and Dashboard names its useState setters the same, so
// an aliased import was one autocomplete away from re-opening the wipe. The
// chains keep them internal; the façade exports only the single-key writers.

test('makeSettingsChains hands out no whole-list rec:ignore reader or writer', () => {
  const chains = makeSettingsChains(makeSettingsTable().db);
  assert.equal('setRecIgnore' in chains, false);
  assert.equal('getRecIgnore' in chains, false);
  assert.equal(typeof chains.updateRecIgnore, 'function');
});

test('source scan: no adapter or the façade exports setEnvPace / setRecIgnore (or their whole-map getters)', () => {
  const read = rel => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const names = ['setEnvPace', 'getEnvPace', 'setRecIgnore', 'getRecIgnore'];
  for (const rel of ['src/dataAdapter.js', 'src/adapters/envelopeIO.js', 'src/adapters/settingsIO.js']) {
    const src = read(rel);
    for (const n of names) {
      assert.doesNotMatch(src, new RegExp(`export\\s+(async\\s+)?function\\s+${n}\\b`), `${rel} exports ${n}`);
    }
    // Re-export lists and destructured exports: `export { … name, … }` / `export const { … name, … }`.
    for (const m of src.matchAll(/export\s+(?:const\s+)?\{([^}]*)\}/g)) {
      for (const n of names) {
        assert.doesNotMatch(m[1], new RegExp(`\\b${n}\\b`), `${rel} exports ${n}`);
      }
    }
  }
});
