// Settings-backed household preferences with the serialized read-merge-write
// discipline: the recurring-charge ignore list, the saved Ask-tab chats, and
// the category registry rows (dash:cats / dash:colors / dash:names).
// Split out of dataAdapter.js (2026-08-04 code-health session); INTERNAL:
// only dataAdapter.js imports this module and re-exports its API.
import { parseIgnoreList, toggleIgnoreKey } from '../recurring.js';
import { parseSavedChats, addSavedChat, removeSavedChat } from '../savedChats.js';
import { setRegistryParent } from '../categoryTree.js';
import { getSetting, setSetting } from '../db.js';
import { makeSerializedUpdater } from '../serializedUpdater.js';

// Recurring-charge ignore list — a HOUSEHOLD pref (settings table, NOT
// localStorage: muting a subscription should mute it on both phones — Mason's
// recorded ruling). ONE row keyed 'rec:ignore' holding a JSON array of the
// recurring items' group keys (detectRecurring's `key`); parsing is the pure
// parseIgnoreList in src/recurring.js. Display-only: detection stays
// unfiltered and the Recurring tab filters at render, so toggling never
// refetches (and never touches the lazy cache's null-means-refetch sentinel).
// Exported for the startup batch read (getStartupSettings in dataAdapter.js).
export const REC_IGNORE_KEY = 'rec:ignore';

// Saved Ask-tab chats — HOUSEHOLD data (settings table, NOT device storage:
// a chat saved on the laptop should be openable on the phone). ONE row keyed
// 'asst:chats' holding a JSON array of {id,title,savedAt,msgs}; all parsing/
// trimming/eviction decisions are pure in src/savedChats.js.
const ASST_CHATS_KEY = 'asst:chats';

// The category registry and its two sibling rows — HOUSEHOLD data written from
// both phones (the live retraining task's core structure): 'dash:cats' (the
// name registry, [{id,name,color,parent?}]), 'dash:colors' (the one mutable
// colour store), 'dash:names' (display aliases). Same discipline as
// rec:ignore: every write merges against the STORED row — persisting a value
// rebuilt from component state let a failed mount-time read (state degraded to
// []/{}) wipe the household's registry on the first edit, while the taught
// rules naming those categories survived. Two-phone races stay the accepted
// per-ROW last-write-wins.
const CATS_KEY = 'dash:cats';
const COLORS_KEY = 'dash:colors';
const NAMES_KEY = 'dash:names';

// Tolerant parses (the parseIgnoreList idiom): a CORRUPT row reads as empty,
// matching what every renderer of these rows already shows for it — distinct
// from a FAILED read, which rejects inside db.getSetting and aborts the
// updater before any write.
function parseCatRegistry(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(c => c && typeof c === 'object') : [];
  } catch {
    return [];
  }
}

function parseCatMap(raw) {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// Toggle ONE key with a read-merge-write: re-read the stored row at toggle
// time and change only the toggled key (pure toggleIgnoreKey). Rebuilding the
// whole array from component state let a failed mount-time read (recIgnore=[]
// after a network blip) wipe every previously ignored charge for BOTH phones
// on the first ✕ tap — and made the ordinary two-phone race last-array-wins.
// A failed READ aborts before any write. Returns the merged list so the
// caller can adopt keys the other phone added since mount.
//
// SAME-DEVICE toggles are serialized through a promise chain: two quick ✕
// taps otherwise interleave (read A, read B, write [A], write [B]) and the
// last write silently drops the first key — then the caller's
// .then(setRecIgnore) reverts it on screen too. Chaining makes B's read see
// A's committed write. The chain swallows rejections so one failed toggle
// never dams the queue; callers still receive the real rejection. The
// two-PHONE race stays the accepted single-key last-write-wins.
//
// The saved-chats writes follow the exact same discipline against their own
// row: a failed mount-time read must never let a rebuilt-from-state array
// wipe the other phone's saves.
//
// The chain mechanics (serialization, failed-read-aborts, swallowed
// rejections that never dam the queue) live in the shared
// makeSerializedUpdater (src/serializedUpdater.js, tested).
//
// makeSettingsChains binds BOTH sites to a settings backend. Exported so the
// race tests (test/settingsChains.test.js) can run the REAL site code against
// a fake settings table — the envelopeIO injectable-deps pattern; the app
// uses the module-level binding below against db.js. Each call mints fresh,
// independent chains (one per settings row).
export function makeSettingsChains(db) {
  const getRecIgnore = async () =>
    parseIgnoreList(await db.getSetting(REC_IGNORE_KEY));

  const setRecIgnore = async keys => {
    const seen = new Set();
    const clean = [];
    for (const k of keys || []) {
      if (typeof k !== 'string' || !k || seen.has(k)) continue;
      seen.add(k);
      clean.push(k);
    }
    await db.setSetting(REC_IGNORE_KEY, JSON.stringify(clean));
  };

  const runRecIgnoreUpdate = makeSerializedUpdater(getRecIgnore, setRecIgnore);
  const updateRecIgnore = (key, ignored) =>
    runRecIgnoreUpdate(current => toggleIgnoreKey(current, key, ignored));

  const getSavedChats = async () =>
    parseSavedChats(await db.getSetting(ASST_CHATS_KEY));

  const setSavedChats = async list => {
    await db.setSetting(ASST_CHATS_KEY, JSON.stringify(list));
  };

  const updateSavedChats = makeSerializedUpdater(getSavedChats, setSavedChats);

  const bindRow = (key, parse) =>
    makeSerializedUpdater(
      async () => parse(await db.getSetting(key)),
      next => db.setSetting(key, JSON.stringify(next)),
    );
  const updateCats = bindRow(CATS_KEY, parseCatRegistry);
  const updateColors = bindRow(COLORS_KEY, parseCatMap);
  const updateNames = bindRow(NAMES_KEY, parseCatMap);

  const trimmedName = c => (c?.name || '').trim();

  return {
    getRecIgnore,
    setRecIgnore,
    updateRecIgnore,
    getSavedChats,
    // Both return the merged stored list so the caller can adopt entries the
    // other phone added since its last read.
    saveChatToApp: chat => updateSavedChats(current => addSavedChat(current, chat)),
    deleteSavedChat: id => updateSavedChats(current => removeSavedChat(current, id)),
    // Registry writes: each merge runs against the STORED value, never a
    // component-state rebuild, and resolves with the merged value written so
    // the caller can adopt the other phone's edits. Dedup by trimmed name —
    // the same comparison the Dashboard's customCatNames memo makes.
    addRegistryEntry: entry =>
      updateCats(current =>
        current.some(c => trimmedName(c) === trimmedName(entry)) ? current : [...current, entry]),
    updateRegistryParent: (name, parent) =>
      updateCats(current => setRegistryParent(current, name, parent)),
    removeRegistryEntry: id => updateCats(current => current.filter(c => c?.id !== id)),
    updateCategoryColor: (cat, color) => updateColors(current => ({ ...current, [cat]: color })),
    updateCategoryAlias: (cat, alias) => updateNames(current => ({ ...current, [cat]: alias })),
  };
}

// The app's one real binding, against the Supabase-backed settings table.
const bound = makeSettingsChains({ getSetting, setSetting });

export const {
  getRecIgnore,
  setRecIgnore,
  updateRecIgnore,
  getSavedChats,
  saveChatToApp,
  deleteSavedChat,
  addRegistryEntry,
  updateRegistryParent,
  removeRegistryEntry,
  updateCategoryColor,
  updateCategoryAlias,
} = bound;
