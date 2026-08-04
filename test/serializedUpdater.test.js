// makeSerializedUpdater — the shared read-merge-write chain extracted from
// updateRecIgnore/updateSavedChats. Pins the three comment-only invariants
// the call sites rely on: same-device serialization, failed-read-aborts, and
// swallowed rejections that never dam the queue.
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeSerializedUpdater } from '../src/serializedUpdater.js';

// A tiny fake settings row with controllable read latency/failure.
function makeStore(initial = []) {
  const store = {
    value: initial,
    reads: 0,
    writes: [],
    failNextRead: false,
    readDelay: 0,
  };
  store.read = async () => {
    store.reads += 1;
    if (store.readDelay) await new Promise(r => setTimeout(r, store.readDelay));
    if (store.failNextRead) {
      store.failNextRead = false;
      throw new Error('read blip');
    }
    return store.value.slice();
  };
  store.write = async next => {
    store.writes.push(next.slice());
    store.value = next;
  };
  return store;
}

test('resolves with the merged value that was written', async () => {
  const store = makeStore(['a']);
  const update = makeSerializedUpdater(store.read, store.write);
  const result = await update(cur => [...cur, 'b']);
  assert.deepEqual(result, ['a', 'b']);
  assert.deepEqual(store.value, ['a', 'b']);
});

test('SERIALIZATION: two quick updates run in order — the second read sees the first committed write', async () => {
  const store = makeStore([]);
  store.readDelay = 5; // wide enough that unserialized calls would interleave
  const update = makeSerializedUpdater(store.read, store.write);
  const [a, b] = await Promise.all([
    update(cur => [...cur, 'A']),
    update(cur => [...cur, 'B']),
  ]);
  assert.deepEqual(a, ['A']);
  assert.deepEqual(b, ['A', 'B'], 'second merge must start from the first write, not the shared base');
  assert.deepEqual(store.value, ['A', 'B']);
  assert.deepEqual(store.writes, [['A'], ['A', 'B']]);
});

test('FAILED READ ABORTS: read rejection reaches the caller and nothing is written', async () => {
  const store = makeStore(['keep-me']);
  const update = makeSerializedUpdater(store.read, store.write);
  store.failNextRead = true;
  await assert.rejects(() => update(() => []), /read blip/);
  assert.deepEqual(store.writes, [], 'a failed read must never let a rebuilt value wipe the store');
  assert.deepEqual(store.value, ['keep-me']);
});

test('NO DAM: a failed update does not block the next one, which still sees the true stored value', async () => {
  const store = makeStore(['x']);
  const update = makeSerializedUpdater(store.read, store.write);
  store.failNextRead = true;
  await assert.rejects(() => update(cur => [...cur, 'lost']));
  const next = await update(cur => [...cur, 'y']);
  assert.deepEqual(next, ['x', 'y']);
  assert.deepEqual(store.value, ['x', 'y']);
});

test('a throwing merge rejects the caller, writes nothing, and does not dam the queue', async () => {
  const store = makeStore(['x']);
  const update = makeSerializedUpdater(store.read, store.write);
  await assert.rejects(
    () =>
      update(() => {
        throw new Error('bad merge');
      }),
    /bad merge/,
  );
  assert.deepEqual(store.writes, []);
  assert.deepEqual(await update(cur => [...cur, 'z']), ['x', 'z']);
});

test('an async merge is awaited before the write', async () => {
  const store = makeStore([]);
  const update = makeSerializedUpdater(store.read, store.write);
  const out = await update(async cur => {
    await new Promise(r => setTimeout(r, 1));
    return [...cur, 'async'];
  });
  assert.deepEqual(out, ['async']);
  assert.deepEqual(store.value, ['async']);
});
