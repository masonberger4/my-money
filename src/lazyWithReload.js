// React.lazy with ONE automatic reload when the chunk import fails.
//
// Why: after a deploy, a phone still running the previous build asks for that
// build's fingerprinted chunk (/assets/CsvImport-<oldhash>.js), which the new
// deployment no longer serves. The import rejects, the lazy component throws
// during render, and without this the nearest boundary swaps out whatever it
// wraps. A reload fetches the new index.html, whose chunk names exist again.
//
// The guard is a sessionStorage flag, set before the reload and cleared by the
// next successful lazy import. A failure with the flag already set — or with
// storage unreadable (private mode, disabled storage) — rethrows instead, so a
// chunk that is genuinely unreachable (offline and never cached) can never
// reload-loop; it falls to the caller's scoped boundary (`LazyModal`).
//
// Every lazy() in src/ goes through this (test/lazyWithReload.test.js pins it).
import { lazy } from 'react';

export const CHUNK_RELOAD_KEY = 'mm:chunk-reload';

function sessionStore() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null; // storage disabled: the getter itself throws
  }
}

// The pure core: wraps an `() => import(...)` factory. Exported for the tests;
// the defaults are the browser's. A never-settling promise after the reload
// keeps the Suspense fallback up until the page actually goes away.
export function withChunkReload(
  importer,
  { storage = sessionStore, reload = () => globalThis.location.reload(), key = CHUNK_RELOAD_KEY } = {},
) {
  return () =>
    importer().then(
      mod => {
        try { storage()?.removeItem(key); } catch { /* best-effort */ }
        return mod;
      },
      err => {
        let tried;
        try {
          const s = storage();
          tried = s.getItem(key) === '1';
          if (!tried) s.setItem(key, '1');
        } catch {
          tried = true; // a flag we can't read or record counts as "already tried"
        }
        if (tried) throw err;
        reload();
        return new Promise(() => {});
      },
    );
}

export default function lazyWithReload(importer, opts) {
  return lazy(withChunkReload(importer, opts));
}
