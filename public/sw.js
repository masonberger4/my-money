// Minimal service worker for my-money PWA.
//
// Strategy:
//   - App shell (HTML navigations): network-first, fall back to cached "/" so
//     the home-screen app still launches offline. With a cached shell, the
//     network gets SHELL_TIMEOUT_MS before the cached copy is served (lie-fi
//     must not hold the launch on the OS fetch timeout); the fetch keeps going
//     under waitUntil, so the shell still updates for next launch.
//   - Static assets: cache-first. The precache paths (icons/manifest/fonts)
//     are served from SHELL_CACHE, where install put them; fingerprinted
//     /assets/* live in ASSET_CACHE. Vite fingerprints those, so stale entries
//     are harmless.
//   - /api/* and everything cross-origin: passthrough (no caching). Financial
//     data must never be stored by the worker.
//
// Bump CACHE_VERSION on any change to this file or the precache list. A bump
// replaces SHELL_CACHE only: ASSET_CACHE is deliberately UNVERSIONED, because
// fingerprinted URLs never need invalidating — a versioned asset cache was
// wiped by every bump, so the first offline launch after one painted only the
// background (the new shell's own chunks were gone).

const CACHE_VERSION = 'v8';
const SHELL_CACHE = `shell-${CACHE_VERSION}`;
const ASSET_CACHE = 'assets';

const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/fonts/inter.woff2',
];

// How long a navigation waits on the network before serving the cached shell.
const SHELL_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Up to v7 the asset cache was versioned (`assets-v7`); carry its
      // fingerprinted entries over, oldest first, so the bump that retires it
      // doesn't recreate the very wipe it fixes.
      const assets = await caches.open(ASSET_CACHE);
      for (const k of keys.filter((name) => name.startsWith('assets-'))) {
        try {
          const legacy = await caches.open(k);
          for (const req of await legacy.keys()) {
            if (!new URL(req.url).pathname.startsWith('/assets/')) continue;
            if (await assets.match(req)) continue;
            const res = await legacy.match(req);
            if (res) await assets.put(req, res);
          }
        } catch {
          // Best-effort: a lost entry only re-downloads on the next online use.
        }
      }
      await Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE)
          .map((k) => caches.delete(k)),
      );
    })(),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    const { response, background } = networkFirstShell(req);
    event.respondWith(response);
    // The shell write and the prune outlive the response (and, on a
    // timeout, the race) — iOS may kill an idle worker mid-loop otherwise.
    event.waitUntil(background);
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(req, ASSET_CACHE));
  } else if (PRECACHE.includes(url.pathname)) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
  }
});

// Cap on the /assets/* entries the CURRENT shell does not reference. Vite
// fingerprints mean stale entries are harmless but NOT free: every deploy
// (several/day) mints new names, so without a prune the cache grows
// ~0.7–2.5 MB per deploy until iOS evicts the PWA's storage — and the whole
// offline shell with it. Everything the freshly fetched shell references (its
// entry, CSS and modulepreloaded vendor/runtime chunks) is spared outright:
// those are byte-stable across most deploys, so by insertion order they are
// the OLDEST entries and a plain cap evicted the live deploy's vendor chunks.
// 40 is the room left for lazy chunks and the previous deploy.
const MAX_ASSET_ENTRIES = 40;

// Absolute URLs of every /assets/* file a shell HTML references.
function shellAssetUrls(html) {
  const keep = new Set();
  for (const m of html.matchAll(/["'](\/assets\/[^"'?#\s]+)/g)) {
    keep.add(new URL(m[1], self.location.origin).href);
  }
  return keep;
}

async function pruneAssetCache(keep) {
  try {
    const cache = await caches.open(ASSET_CACHE);
    // Only fingerprinted /assets/* entries are prunable, and never one the
    // live shell references. ASSET_CACHE holds nothing else since v8, but
    // cache HITS never refresh insertion order, so a stable-URL entry here
    // would be the oldest — keep the filter as the guard it always was.
    const keys = (await cache.keys()) // insertion order: oldest first
      .filter((key) => new URL(key.url).pathname.startsWith('/assets/') && !keep.has(key.url));
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSET_ENTRIES))) {
      await cache.delete(key);
    }
  } catch {
    // Pruning is best-effort; never let it break a navigation response.
  }
}

function networkFirstShell(req) {
  const net = fetch(req).then(async (fresh) => {
    const cache = await caches.open(SHELL_CACHE);
    if (fresh.ok) cache.put('/', fresh.clone());
    // Read the copy for the prune NOW, before `fresh` goes to the page and
    // its body is consumed.
    const html = fresh.ok ? fresh.clone().text() : null;
    return { fresh, html };
  });
  // A successful navigation means a (possibly new) deploy just loaded —
  // prune old fingerprinted assets, sparing everything this shell uses.
  const background = net
    .then(({ html }) => html && html.then((text) => pruneAssetCache(shellAssetUrls(text))))
    .catch(() => {});
  const live = net.then(({ fresh }) => fresh);
  // Handled below, but only after the cache lookup — an offline fetch can
  // reject first, and would log as an unhandled rejection on every launch.
  live.catch(() => {});

  const response = (async () => {
    let cached;
    try {
      cached = await (await caches.open(SHELL_CACHE)).match('/');
    } catch {
      cached = undefined;
    }
    // No shell to fall back on: wait for the network, however long it takes.
    if (!cached) return live.catch(() => Response.error());
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(cached), SHELL_TIMEOUT_MS);
    });
    try {
      return await Promise.race([live.catch(() => cached), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  })();

  return { response, background };
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const fresh = await fetch(req);
  // A fingerprinted path answered with HTML is a rewrite's index.html, never
  // the chunk (vercel.json excludes assets/ from it now; this is the backstop).
  const htmlForAsset = cacheName === ASSET_CACHE
    && (fresh.headers.get('content-type') || '').includes('text/html');
  if (fresh.ok && !htmlForAsset) cache.put(req, fresh.clone());
  return fresh;
}
