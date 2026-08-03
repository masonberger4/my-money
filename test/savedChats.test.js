import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trimChatMsgs, parseSavedChats, defaultChatTitle, buildSavedChat,
  addSavedChat, removeSavedChat,
  CHAT_MAX_TURNS, CHAT_MSG_CHARS, CHAT_TOTAL_CHARS, MAX_SAVED_CHATS, MAX_STORE_CHARS,
} from '../src/savedChats.js';

const u = c => ({ role: 'user', content: c });
const a = c => ({ role: 'assistant', content: c });

test('trimChatMsgs: drops garbage, caps per-message and turn count, never assistant-first', () => {
  const msgs = [null, { role: 'system', content: 'x' }, u('q'), { role: 'user' }, a('r')];
  assert.deepEqual(trimChatMsgs(msgs), [u('q'), a('r')]);

  const long = trimChatMsgs([u('x'.repeat(CHAT_MSG_CHARS + 5))]);
  assert.equal(long[0].content.length, CHAT_MSG_CHARS);

  // 40 turns -> at most CHAT_MAX_TURNS-1 survive (so [...restored, new user]
  // stays under the server's MAX_TURNS)
  const many = [];
  for (let i = 0; i < 20; i++) { many.push(u('q' + i)); many.push(a('r' + i)); }
  const out = trimChatMsgs(many);
  assert.ok(out.length <= CHAT_MAX_TURNS - 1);
  assert.equal(out[0].role, 'user'); // leading assistant turn dropped after slice

  // total-chars cap sheds oldest first
  const big = [u('a'.repeat(20000)), a('b'.repeat(20000)), u('c'.repeat(20000))];
  const t = trimChatMsgs(big);
  assert.ok(t.reduce((s, m) => s + m.content.length, 0) <= CHAT_TOTAL_CHARS);
  assert.equal(t[t.length - 1].content[0], 'c'); // newest kept
});

test('parseSavedChats: tolerant of garbage, dedups ids, trims msgs, drops empty', () => {
  assert.deepEqual(parseSavedChats(null), []);
  assert.deepEqual(parseSavedChats(''), []);
  assert.deepEqual(parseSavedChats('not json'), []);
  assert.deepEqual(parseSavedChats('{"a":1}'), []);

  const raw = JSON.stringify([
    { id: 'a', title: 'T', savedAt: '2026-08-03T00:00:00Z', msgs: [u('hi'), a('yo')] },
    { id: 'a', title: 'dup', msgs: [u('x')] },              // duplicate id dropped
    { id: 'b', title: '', savedAt: 5, msgs: [a('orphan')] },// trims to empty -> dropped
    { id: 'c', msgs: [u('q')] },                            // missing title -> 'Chat'
    'junk', null, { msgs: [u('no id')] },
  ]);
  const out = parseSavedChats(raw);
  assert.deepEqual(out.map(c => c.id), ['a', 'c']);
  assert.equal(out[0].title, 'T');
  assert.equal(out[1].title, 'Chat');
  assert.equal(out[1].savedAt, '');
});

test('parseSavedChats round-trips what addSavedChat/buildSavedChat store', () => {
  const chat = buildSavedChat([u('how much on groceries?'), a('$412')], new Date('2026-08-03T12:00:00Z'));
  const stored = JSON.stringify(addSavedChat([], chat));
  const back = parseSavedChats(stored);
  assert.equal(back.length, 1);
  assert.deepEqual(back[0].msgs, chat.msgs);
  assert.equal(back[0].id, chat.id);
});

test('defaultChatTitle: first USER message truncated + date; fallback', () => {
  const now = new Date(2026, 7, 3); // Aug 3 local
  const t = defaultChatTitle([a('ignored'), u('  how   much\ndid I spend? ')], now);
  assert.ok(t.startsWith('how much did I spend?'));
  assert.ok(/Aug/.test(t));
  const long = defaultChatTitle([u('x'.repeat(200))], now);
  assert.ok(long.includes('…'));
  assert.ok(long.length < 80);
  assert.ok(defaultChatTitle([], now).startsWith('Chat'));
});

test('buildSavedChat: null on empty/garbage, unique ids, ISO savedAt', () => {
  assert.equal(buildSavedChat([]), null);
  assert.equal(buildSavedChat([a('assistant only')]), null);
  const now = new Date('2026-08-03T12:00:00Z');
  const c1 = buildSavedChat([u('q')], now);
  const c2 = buildSavedChat([u('q')], now);
  assert.equal(c1.savedAt, '2026-08-03T12:00:00.000Z');
  assert.notEqual(c1.id, c2.id);
});

test('addSavedChat: newest first, evicts OLDEST past MAX_SAVED_CHATS', () => {
  let list = [];
  for (let i = 0; i < MAX_SAVED_CHATS + 3; i++) {
    list = addSavedChat(list, { id: 'c' + i, title: 't', savedAt: '', msgs: [u('q' + i)] });
  }
  assert.equal(list.length, MAX_SAVED_CHATS);
  assert.equal(list[0].id, 'c' + (MAX_SAVED_CHATS + 2)); // newest first
  assert.equal(list[list.length - 1].id, 'c3');          // oldest three evicted
});

test('addSavedChat: size cap evicts oldest but never the chat being saved', () => {
  const fat = n => ({ id: 'f' + n, title: 't', savedAt: '', msgs: [u('x'.repeat(45000))] });
  let list = [];
  for (let i = 0; i < 9; i++) list = addSavedChat(list, fat(i));
  assert.ok(JSON.stringify(list).length <= MAX_STORE_CHARS);
  assert.ok(list.length < 9); // size cap bit before the count cap
  assert.equal(list[0].id, 'f8'); // the just-saved chat survives
  // one enormous chat alone is still kept (never evict below 1)
  const solo = addSavedChat([], { id: 's', title: 't', savedAt: '', msgs: [u('x'.repeat(48000)), u('y'.repeat(48000))] });
  assert.equal(solo.length, 1);
});

test('addSavedChat re-save of the same id replaces, not duplicates', () => {
  const c = { id: 'same', title: 'v1', savedAt: '', msgs: [u('q')] };
  const list = addSavedChat(addSavedChat([], c), { ...c, title: 'v2' });
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'v2');
});

test('removeSavedChat: removes by id, tolerant of garbage', () => {
  const list = [{ id: 'a' }, null, { id: 'b' }];
  assert.deepEqual(removeSavedChat(list, 'a').map(c => c.id), ['b']);
  assert.deepEqual(removeSavedChat(null, 'a'), []);
});
