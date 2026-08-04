// Minimal service worker for my-money PWA.
//
// Strategy:
//   - App shell (HTML navigations): network-first, fall back to cached "/" so
//     the home-screen app still launches offline.
//   - Static assets (same-origin GETs to /assets/* and the icons/manifest):
//     cache-first. Vite fingerprints these, so stale entries are harmless.
//   - /api/* and everything cross-origin: passthrough (no caching). Financial
//     data must never be stored by the worker.
//
// Bump CACHE_VERSION on any change to this file or the precache list.

const CACHE_VERSION = 'v6';
const SHELL_CACHE = `shell-${CACHE_VERSION}`;
const ASSET_CACHE = `assets-${CACHE_VERSION}`;

const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/fonts/dm-sans.woff2',
  '/fonts/dm-mono-400.woff2',
  '/fonts/dm-mono-500.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE)
          .map((k) => caches.delete(k)),
      ),
    ),
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
    event.respondWith(networkFirstShell(req));
    return;
  }

  if (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname)) {
    event.respondWith(cacheFirst(req));
  }
});

// Cap on fingerprinted /assets/* entries. Vite fingerprints mean stale
// entries are harmless but NOT free: every deploy (several/day) mints new
// names, so without a prune the cache grows ~0.7–2.5 MB per deploy until iOS
// evicts the PWA's storage — and the whole offline shell with it. One built
// app is well under 20 files; 40 keeps the live set plus one previous deploy.
const MAX_ASSET_ENTRIES = 40;

async function pruneAssetCache() {
  try {
    const cache = await caches.open(ASSET_CACHE);
    // Only fingerprinted /assets/* entries are prunable. ASSET_CACHE also
    // holds the stable-URL precache paths (fonts/icons/manifest) served by
    // cacheFirst — cache hits never refresh insertion order, so they'd be
    // the OLDEST entries after a few deploys and a whole-cache prune would
    // evict exactly the fonts the offline shell depends on.
    const keys = (await cache.keys()) // insertion order: oldest first
      .filter((key) => new URL(key.url).pathname.startsWith('/assets/'));
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSET_ENTRIES))) {
      await cache.delete(key);
    }
  } catch {
    // Pruning is best-effort; never let it break a navigation response.
  }
}

async function networkFirstShell(req) {
  try {
    const fresh = await fetch(req);
    const cache = await caches.open(SHELL_CACHE);
    if (fresh.ok) cache.put('/', fresh.clone());
    // A successful navigation means a (possibly new) deploy just loaded —
    // prune old fingerprinted assets in the background.
    pruneAssetCache();
    return fresh;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    return (await cache.match('/')) || Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const fresh = await fetch(req);
  if (fresh.ok) cache.put(req, fresh.clone());
  return fresh;
}
