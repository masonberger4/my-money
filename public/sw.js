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

const CACHE_VERSION = 'v4';
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

async function networkFirstShell(req) {
  try {
    const fresh = await fetch(req);
    const cache = await caches.open(SHELL_CACHE);
    if (fresh.ok) cache.put('/', fresh.clone());
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
