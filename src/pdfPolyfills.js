// Polyfills required by pdf.js on older iOS Safari.
//
// pdf.js ships core-js polyfills in its legacy build, but not for everything it
// uses: `Array.prototype.at` (for `.at(-1)`) and `structuredClone` (used when
// cloning messages between the main thread and the worker) are both assumed to
// exist. Both landed in Safari 15.4, so on an older iPhone pdf.js throws
// "undefined is not a function" the moment a PDF is opened — verified by
// deleting each global in Node and re-running a real statement through the
// legacy build.
//
// Everything here is feature-detected and installed as a non-enumerable,
// writable property, so a browser that already has these is untouched.

function defineIfMissing(target, name, value) {
  if (!target || typeof target[name] === 'function') return;
  Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
}

function atImpl(index) {
  const len = this.length;
  let i = Math.trunc(index) || 0;
  if (i < 0) i += len;
  return i < 0 || i >= len ? undefined : this[i];
}

function cloneValue(value, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const out = new Array(value.length);
    seen.set(value, out);
    for (let i = 0; i < value.length; i++) out[i] = cloneValue(value[i], seen);
    return out;
  }
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof Map) {
    const out = new Map();
    seen.set(value, out);
    value.forEach((v, k) => out.set(cloneValue(k, seen), cloneValue(v, seen)));
    return out;
  }
  if (value instanceof Set) {
    const out = new Set();
    seen.set(value, out);
    value.forEach(v => out.add(cloneValue(v, seen)));
    return out;
  }
  if (typeof ArrayBuffer !== 'undefined') {
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) {
      // Typed arrays and DataViews get their own copy of the buffer.
      if (typeof DataView !== 'undefined' && value instanceof DataView) {
        return new DataView(value.buffer.slice(0), 0, value.byteLength);
      }
      return new value.constructor(value);
    }
  }
  if (typeof ImageData !== 'undefined' && value instanceof ImageData) {
    return new ImageData(new Uint8ClampedArray(value.data), value.width, value.height);
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.slice(0, value.size, value.type);

  const out = {};
  seen.set(value, out);
  for (const key of Object.keys(value)) out[key] = cloneValue(value[key], seen);
  return out;
}

let installed = false;

export function installPdfPolyfills() {
  if (installed) return;
  installed = true;

  defineIfMissing(Array.prototype, 'at', atImpl);
  defineIfMissing(String.prototype, 'at', atImpl);
  // %TypedArray%.prototype — reached through any concrete typed array.
  const typedArrayProto = Object.getPrototypeOf(Int8Array.prototype);
  defineIfMissing(typedArrayProto, 'at', atImpl);

  if (typeof globalThis.structuredClone !== 'function') {
    // The `transfer` option is intentionally ignored: it is an optimization,
    // and copying is always a valid implementation of it.
    globalThis.structuredClone = value => cloneValue(value, new Map());
  }
}
