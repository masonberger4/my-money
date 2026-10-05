// A service-worker harness for test/swRuntime.test.js: runs the REAL
// public/sw.js inside node:vm against a fake CacheStorage, a switchable
// network and a manual clock. Zero dependencies — Node's own Response/Request.
//
// Fidelity notes (the parts the worker's correctness depends on):
//  - Cache entries keep INSERTION ORDER and `put` on an existing key moves it
//    to the end (spec: delete, then append) — the prune's LRU-by-insertion is
//    exactly what the tests exercise. A `match` HIT never reorders.
//  - `match` returns a fresh clone each time, like the real Cache API.
//  - `addAll` is all-or-nothing: one failed/non-ok fetch rejects the batch.
//  - The network serves only the CURRENT deploy's files (no Vercel skew
//    protection), so a previous deploy's chunk is a 404.
import vm from 'node:vm';

export const ORIGIN = 'https://app.test';

const abs = r => new URL(typeof r === 'string' ? r : r.url, ORIGIN).href;

class FakeCache {
  constructor(net) { this.net = net; this.entries = new Map(); }
  async match(r) {
    const res = this.entries.get(abs(r));
    return res ? res.clone() : undefined;
  }
  async put(r, res) {
    const k = abs(r);
    this.entries.delete(k);
    this.entries.set(k, res);
  }
  async addAll(list) {
    const got = [];
    for (const u of list) {
      const res = await this.net.fetch(u);
      if (!res.ok) throw new TypeError(`addAll: ${u} → ${res.status}`);
      got.push([u, res]);
    }
    for (const [u, res] of got) await this.put(u, res);
  }
  async keys() { return [...this.entries.keys()].map(url => new Request(url)); }
  async delete(r) { return this.entries.delete(abs(r)); }
  // Test-side helpers (not part of the Cache API).
  paths() { return [...this.entries.keys()].map(u => new URL(u).pathname); }
  has(path) { return this.entries.has(abs(path)); }
}

class FakeCacheStorage {
  constructor(net) { this.net = net; this.stores = new Map(); }
  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache(this.net));
    return this.stores.get(name);
  }
  async keys() { return [...this.stores.keys()]; }
  async has(name) { return this.stores.has(name); }
  async delete(name) { return this.stores.delete(name); }
  peek(name) { return this.stores.get(name); }
  names() { return [...this.stores.keys()]; }
}

export function createNetwork() {
  const net = {
    mode: 'online', // 'online' | 'offline' | 'hang'
    files: new Map(), // pathname → { body, type, status }
    calls: new Map(), // pathname → count
    pending: [], // hung fetches: { path, resolve, reject }
    serve(path, body, type = 'text/javascript', status = 200) {
      net.files.set(path, { body, type, status });
    },
    async fetch(r) {
      const url = new URL(abs(r));
      net.calls.set(url.pathname, (net.calls.get(url.pathname) || 0) + 1);
      if (net.mode === 'offline') throw new TypeError('Failed to fetch');
      if (net.mode === 'hang') {
        return new Promise((resolve, reject) => net.pending.push({ path: url.pathname, resolve, reject }));
      }
      return net.respond(url.pathname);
    },
    respond(path) {
      const f = net.files.get(path);
      if (!f) return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
      return new Response(f.body, { status: f.status, headers: { 'content-type': f.type } });
    },
  };
  return net;
}

export function createClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms = 0) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) { timers.delete(id); t.fn(); }
      }
    },
    pendingCount: () => timers.size,
  };
}

export function createHarness() {
  const net = createNetwork();
  const caches = new FakeCacheStorage(net);
  const clock = createClock();

  function loadWorker(source) {
    const listeners = {};
    const self = {
      addEventListener: (type, fn) => (listeners[type] ||= []).push(fn),
      location: { origin: ORIGIN },
      skipWaiting() {},
      clients: { claim: async () => {} },
    };
    vm.runInNewContext(source, {
      self, caches, fetch: net.fetch, URL, Response, Request, Headers, console,
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    }, { filename: 'public/sw.js' });

    const lifecycle = type => {
      const waits = [];
      for (const fn of listeners[type] || []) fn({ waitUntil: p => waits.push(p) });
      return Promise.all(waits);
    };
    return {
      install: () => lifecycle('install'),
      activate: () => lifecycle('activate'),
      // Dispatches a fetch event. `responded` false = the worker let the
      // browser handle it (passthrough).
      fetch(pathOrUrl, { mode = 'no-cors', method = 'GET' } = {}) {
        const request = { url: abs(pathOrUrl), method, mode };
        let response;
        const waits = [];
        for (const fn of listeners.fetch || []) {
          fn({ request, respondWith: p => { response = Promise.resolve(p); }, waitUntil: p => waits.push(p) });
        }
        return { responded: response !== undefined, response, settled: () => Promise.all(waits) };
      },
    };
  }

  return { net, caches, clock, loadWorker };
}

// Drains pending microtasks/IO callbacks so async worker code reaches its
// next real wait (a timer or a hung fetch).
export async function flush(times = 5) {
  for (let i = 0; i < times; i++) await new Promise(r => setImmediate(r));
}

// 'pending' if the promise hasn't settled once the queue drains.
export async function state(p) {
  let done = null;
  p.then(v => { done = { v }; }, e => { done = { e }; });
  await flush();
  return done ?? 'pending';
}

// A response's body text, or 'ERR' for Response.error() / a rejected respondWith.
export async function bodyOf(p) {
  try {
    const res = await p;
    return res.type === 'error' ? 'ERR' : await res.text();
  } catch {
    return 'ERR';
  }
}
