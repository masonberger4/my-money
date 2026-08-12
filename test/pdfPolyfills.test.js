// Tests for src/pdfPolyfills.js — the iOS-Safari polyfills PDF import stands
// on. The ReadableStream async-iteration shim is the load-bearing one: Safari
// (current versions included) has no ReadableStream[Symbol.asyncIterator], so
// without it pdf.js's `for await (const chunk of readable)` throws on EVERY
// iPhone — while CI's Chromium and local Node both have the natives, so a
// regression ships green everywhere except the household's actual phones.
//
// So the natives are DELETED here before the single installPdfPolyfills()
// call, forcing the polyfill implementations onto this process — the same
// emulation recipe the Gotcha prescribes. Safe because `node --test` runs
// each test file in its own process; nothing else sees the mutated globals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installPdfPolyfills } from '../src/pdfPolyfills.js';

delete ReadableStream.prototype[Symbol.asyncIterator];
delete ReadableStream.prototype.values;
delete globalThis.structuredClone;
delete Array.prototype.at;

// Prove the deletions took — defineIfMissing skips anything still present, so
// a failed delete would silently hand every test below to the native impl.
assert.equal(ReadableStream.prototype[Symbol.asyncIterator], undefined);
assert.equal(ReadableStream.prototype.values, undefined);
assert.equal(globalThis.structuredClone, undefined);
assert.equal(Array.prototype.at, undefined);

installPdfPolyfills();
installPdfPolyfills(); // single-shot guard: second call must be a harmless no-op

function chunkStream(chunks, onCancel) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
    cancel(reason) {
      if (onCancel) onCancel(reason);
    },
  });
}

test('installs replacements for every deleted native', () => {
  assert.equal(typeof ReadableStream.prototype[Symbol.asyncIterator], 'function');
  assert.equal(typeof ReadableStream.prototype.values, 'function');
  assert.equal(typeof globalThis.structuredClone, 'function');
  assert.equal(typeof Array.prototype.at, 'function');
  // Non-enumerable, like the natives — an enumerable `at` would leak into
  // for..in loops over arrays.
  assert.equal(Object.getOwnPropertyDescriptor(Array.prototype, 'at').enumerable, false);
});

test('for await drains a stream in order and releases the lock on completion', async () => {
  const stream = chunkStream(['a', 'b', 'c']);
  const seen = [];
  for await (const chunk of stream) seen.push(chunk);
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.equal(stream.locked, false, 'done must release the reader lock');
});

test('early break cancels the stream and releases the lock', async () => {
  let cancelled = false;
  const stream = chunkStream(['a', 'b', 'c'], () => {
    cancelled = true;
  });
  for await (const chunk of stream) {
    assert.equal(chunk, 'a');
    break; // triggers the iterator's return()
  }
  assert.equal(cancelled, true, 'break must cancel the underlying source');
  assert.equal(stream.locked, false, 'break must release the reader lock');
  stream.getReader(); // a stranded lock would make this throw
});

test('values({ preventCancel: true }) releases the lock without cancelling', async () => {
  let cancelled = false;
  const stream = chunkStream(['a', 'b'], () => {
    cancelled = true;
  });
  for await (const chunk of stream.values({ preventCancel: true })) {
    assert.equal(chunk, 'a');
    break;
  }
  assert.equal(cancelled, false, 'preventCancel must leave the source uncancelled');
  assert.equal(stream.locked, false);
  const reader = stream.getReader();
  assert.deepEqual(await reader.read(), { done: false, value: 'b' }, 'remaining chunks stay readable');
});

test('the iterator is its own async iterator (spec shape pdf.js relies on)', () => {
  const it = chunkStream([]).values();
  assert.equal(it[Symbol.asyncIterator](), it);
});

test('a stream error propagates out of the loop and releases the lock', async () => {
  const boom = new Error('boom');
  const stream = new ReadableStream({
    start(controller) {
      controller.error(boom);
    },
  });
  await assert.rejects(async () => {
    for await (const chunk of stream) void chunk;
  }, boom);
  assert.equal(stream.locked, false, 'a rejected read must still release the lock');
});

test('structuredClone: primitives, containers, and deep copies', () => {
  const src = {
    n: 1.5,
    s: 'x',
    d: new Date(1700000000000),
    re: /ab+c/gi,
    map: new Map([['k', { v: 1 }]]),
    set: new Set([1, 2]),
    arr: [1, [2, 3]],
  };
  const out = structuredClone(src);
  assert.notEqual(out, src);
  assert.deepEqual(out, src);
  assert.notEqual(out.map.get('k'), src.map.get('k'), 'container contents are cloned, not shared');
  out.arr[1].push(4);
  assert.deepEqual(src.arr[1], [2, 3], 'mutating the clone must not touch the source');
});

test('structuredClone: cyclic references survive and identity is preserved', () => {
  const a = { name: 'a' };
  a.self = a;
  a.pair = [a, a];
  const out = structuredClone(a);
  assert.equal(out.self, out, 'cycle points at the clone, not the source');
  assert.equal(out.pair[0], out);
  assert.equal(out.pair[0], out.pair[1], 'shared references stay shared, not duplicated');
  assert.notEqual(out, a);
});

test('structuredClone: DataView keeps its byteOffset and views share one cloned buffer', () => {
  const buf = new ArrayBuffer(16);
  const all = new Uint8Array(buf);
  for (let i = 0; i < 16; i++) all[i] = i * 3;
  const dv = new DataView(buf, 4, 8);
  const u8 = new Uint8Array(buf, 2, 6);

  const out = structuredClone({ dv, u8 });
  assert.equal(out.dv.byteOffset, 4, 'offset-0 rebuild would hand back the wrong bytes');
  assert.equal(out.dv.byteLength, 8);
  assert.equal(out.dv.getUint8(0), dv.getUint8(0));
  assert.equal(out.u8.byteOffset, 2);
  assert.deepEqual(Array.from(out.u8), Array.from(u8));
  assert.equal(out.dv.buffer, out.u8.buffer, 'views onto one buffer keep sharing its clone');
  assert.notEqual(out.dv.buffer, buf);

  all[6] = 255; // inside both windows
  assert.notEqual(out.dv.getUint8(2), 255, 'clone is detached from the source buffer');
});

test('Array.prototype.at: negative indexing pdf.js uses (.at(-1))', () => {
  const arr = ['a', 'b', 'c'];
  assert.equal(arr.at(-1), 'c');
  assert.equal(arr.at(0), 'a');
  assert.equal(arr.at(2), 'c');
  assert.equal(arr.at(3), undefined);
  assert.equal(arr.at(-4), undefined);
  assert.equal(arr.at(1.7), 'b', 'index truncates like the spec');
  assert.equal(arr.at(NaN), 'a', 'NaN reads as 0');
  assert.equal([].at(-1), undefined);
});
