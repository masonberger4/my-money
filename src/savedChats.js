// In-app saved chats for the Ask tab — the PURE side (no React, no Supabase).
// Storage is ONE settings-table row ('asst:chats' in dataAdapter) holding a
// JSON array of {id, title, savedAt, msgs} — household-shared by nature, both
// phones see the same list. dataAdapter serializes the read-merge-write; this
// module owns parsing, trimming, titles and the merge/evict decisions so they
// test in plain Node.
//
// Saved chats are KEEPSAKES: opening one loads a COPY into the scrollback and
// never mutates the stored entry; re-saving after a continuation saves a NEW
// entry (the Dashboard's decision, noted there too).

// The chat trim caps — moved here from Dashboard.jsx so the sessionStorage
// scrollback and the saved-chat store share ONE discipline. Sit comfortably
// under api/assistant.js's caps (MAX_TURNS 30, MAX_MSG_CHARS 8000,
// MAX_TOTAL_CHARS 60000) so a restored/reopened history can always ride the
// next send without a 400: at most CHAT_MAX_TURNS-1 messages survive (so
// [...restored, new user] is ≤ MAX_TURNS and the server's slice(-MAX_TURNS)
// drops nothing), and the result always starts with a USER turn (Anthropic
// rejects an assistant-first history with a 400).
export const CHAT_MAX_TURNS = 30;
export const CHAT_MSG_CHARS = 8000;
export const CHAT_TOTAL_CHARS = 48000;

export function trimChatMsgs(msgs) {
  let out = (Array.isArray(msgs) ? msgs : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, CHAT_MSG_CHARS) }))
    .slice(-(CHAT_MAX_TURNS - 1));
  let total = out.reduce((s, m) => s + m.content.length, 0);
  while (out.length > 1 && total > CHAT_TOTAL_CHARS) { total -= out[0].content.length; out.shift(); }
  // Never keep an assistant-first history — drop leading assistant turns.
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// Caps on the stored list. MAX_SAVED_CHATS bounds the count; MAX_STORE_CHARS
// bounds the serialized row (10 × a maximally-long chat would be ~½MB of
// settings value — legal for Postgres text, rude to refetch on a phone).
// When either cap is exceeded the OLDEST saved chats are evicted (the
// decided policy — evict, don't refuse: a full list silently blocking new
// saves is the invisible-failure shape this codebase avoids), but the chat
// being saved right now is never evicted by the size cap alone.
export const MAX_SAVED_CHATS = 10;
export const MAX_STORE_CHARS = 300000;

// Tolerant parse of the stored settings value — the parseIgnoreList spirit.
// Anything that isn't a well-shaped entry is dropped, never thrown on.
export function parseSavedChats(raw) {
  if (raw == null || String(raw).trim() === '') return [];
  let arr;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const c of arr) {
    if (!c || typeof c !== 'object') continue;
    if (typeof c.id !== 'string' || !c.id || seen.has(c.id)) continue;
    const msgs = trimChatMsgs(c.msgs);
    if (!msgs.length) continue;
    seen.add(c.id);
    out.push({
      id: c.id,
      title: typeof c.title === 'string' && c.title.trim() ? c.title.slice(0, 120) : 'Chat',
      savedAt: typeof c.savedAt === 'string' ? c.savedAt : '',
      msgs,
    });
  }
  return out;
}

// Default title: first user message truncated + the save date.
export function defaultChatTitle(msgs, now = new Date()) {
  const first = (Array.isArray(msgs) ? msgs : []).find(m => m && m.role === 'user' && typeof m.content === 'string');
  const q = (first ? first.content : '').replace(/\s+/g, ' ').trim();
  const head = q ? (q.length > 60 ? q.slice(0, 57).trimEnd() + '…' : q) : 'Chat';
  const d = now.toLocaleDateString('default', { month: 'short', day: 'numeric' });
  return `${head} — ${d}`;
}

// Build the entry to store. Returns null when nothing survives the trim
// (an empty or garbage scrollback must not mint a blank keepsake).
export function buildSavedChat(msgs, now = new Date()) {
  const trimmed = trimChatMsgs(msgs);
  if (!trimmed.length) return null;
  return {
    id: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: defaultChatTitle(trimmed, now),
    savedAt: now.toISOString(),
    msgs: trimmed,
  };
}

// Merge one new chat into a freshly-read list: newest FIRST, then evict from
// the tail (oldest) past MAX_SAVED_CHATS, then keep evicting oldest while the
// serialized size exceeds MAX_STORE_CHARS — but never below the one chat just
// saved. Pure; dataAdapter runs it inside the serialized read-merge-write.
export function addSavedChat(list, chat) {
  const base = (Array.isArray(list) ? list : []).filter(c => c && c.id !== chat.id);
  let out = [chat, ...base].slice(0, MAX_SAVED_CHATS);
  while (out.length > 1 && JSON.stringify(out).length > MAX_STORE_CHARS) out.pop();
  return out;
}

export function removeSavedChat(list, id) {
  return (Array.isArray(list) ? list : []).filter(c => c && c.id !== id);
}
