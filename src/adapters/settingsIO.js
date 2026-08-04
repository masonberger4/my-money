// Settings-backed household preferences with the serialized read-merge-write
// discipline: the recurring-charge ignore list and the saved Ask-tab chats.
// Split out of dataAdapter.js (2026-08-04 code-health session); INTERNAL:
// only dataAdapter.js imports this module and re-exports its API.
import { parseIgnoreList, toggleIgnoreKey } from '../recurring.js';
import { parseSavedChats, addSavedChat, removeSavedChat } from '../savedChats.js';
import { getSetting, setSetting } from '../db.js';
import { makeSerializedUpdater } from '../serializedUpdater.js';

// Recurring-charge ignore list — a HOUSEHOLD pref (settings table, NOT
// localStorage: muting a subscription should mute it on both phones — Mason's
// recorded ruling). ONE row keyed 'rec:ignore' holding a JSON array of the
// recurring items' group keys (detectRecurring's `key`); parsing is the pure
// parseIgnoreList in src/recurring.js. Display-only: detection stays
// unfiltered and the Recurring tab filters at render, so toggling never
// refetches (and never touches the lazy cache's null-means-refetch sentinel).
const REC_IGNORE_KEY = 'rec:ignore';

export async function getRecIgnore() {
  return parseIgnoreList(await getSetting(REC_IGNORE_KEY));
}

export async function setRecIgnore(keys) {
  const seen = new Set();
  const clean = [];
  for (const k of keys || []) {
    if (typeof k !== 'string' || !k || seen.has(k)) continue;
    seen.add(k);
    clean.push(k);
  }
  await setSetting(REC_IGNORE_KEY, JSON.stringify(clean));
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
// The chain mechanics (serialization, failed-read-aborts, swallowed
// rejections that never dam the queue) live in the shared
// makeSerializedUpdater (src/serializedUpdater.js, tested) — this binds it.
const runRecIgnoreUpdate = makeSerializedUpdater(getRecIgnore, setRecIgnore);
export function updateRecIgnore(key, ignored) {
  return runRecIgnoreUpdate(current => toggleIgnoreKey(current, key, ignored));
}

// Saved Ask-tab chats — HOUSEHOLD data (settings table, NOT device storage:
// a chat saved on the laptop should be openable on the phone). ONE row keyed
// 'asst:chats' holding a JSON array of {id,title,savedAt,msgs}; all parsing/
// trimming/eviction decisions are pure in src/savedChats.js. The WRITE is a
// read-merge-write serialized through a promise chain — the exact
// updateRecIgnore discipline: two quick saves must not interleave (read A,
// read B, write [A], write [B]) and drop one, and a failed mount-time read
// must never let a rebuilt-from-state array wipe the other phone's saves.
// A failed READ aborts before any write; the chain swallows rejections so one
// failed save never dams the queue, while callers still get the rejection.
const ASST_CHATS_KEY = 'asst:chats';

export async function getSavedChats() {
  return parseSavedChats(await getSetting(ASST_CHATS_KEY));
}

async function setSavedChats(list) {
  await setSetting(ASST_CHATS_KEY, JSON.stringify(list));
}

const updateSavedChats = makeSerializedUpdater(getSavedChats, setSavedChats);

// Both return the merged stored list so the caller can adopt entries the
// other phone added since its last read.
export function saveChatToApp(chat) {
  return updateSavedChats(current => addSavedChat(current, chat));
}

export function deleteSavedChat(id) {
  return updateSavedChats(current => removeSavedChat(current, id));
}
