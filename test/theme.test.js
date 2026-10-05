// Behavioural tests for src/theme.js's preference plumbing when storage is
// blocked (2026-10 import audit, F76).
//
// The bug: with localStorage blocked (site data off — "Block All Cookies" on
// iOS), setThemePref swallowed the failed write and applied the explicit
// choice, but nothing KEPT it. initTheme's OS listener re-reads the stored
// preference, which reads 'system' when storage throws — so at sunset the page
// flipped to light while the gear menu still showed Dark selected. The
// file's own comment promised "the choice still applies for this session".
//
// setThemePref is module-private (theme.js's export rule), so the choice is
// made the way the app makes it: through useTheme's setPref. The hook is
// rendered with react-dom/server — no DOM needed, and the setter it hands back
// is the real one. Each case imports a FRESH copy of theme.js (a distinct
// query string is a distinct ES module), because the preference state is
// module-level.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

// A fake <html>, an OS appearance query we can flip, and a storage whose
// behaviour each case chooses. Installed before theme.js is imported.
function installEnv({ storage, osDark = false }) {
  const attrs = new Map();
  const listeners = new Set();
  const mql = {
    matches: osDark,
    addEventListener: (type, fn) => { if (type === 'change') listeners.add(fn); },
    removeEventListener: (type, fn) => listeners.delete(fn),
  };
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define('localStorage', storage);
  define('window', { matchMedia: () => mql });
  define('document', {
    documentElement: {
      getAttribute: k => (attrs.has(k) ? attrs.get(k) : null),
      setAttribute: (k, v) => attrs.set(k, String(v)),
      removeAttribute: k => attrs.delete(k),
    },
    querySelectorAll: () => [],
  });
  define('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  return {
    htmlTheme: () => attrs.get('data-theme') ?? null,
    flipOs(dark) {
      mql.matches = dark;
      for (const fn of [...listeners]) fn({ matches: dark });
    },
  };
}

const blocked = () => { throw new Error('SecurityError: storage is disabled'); };
const THROWING_STORAGE = { getItem: blocked, setItem: blocked, removeItem: blocked };

let fresh = 0;
async function loadTheme() {
  fresh++;
  return import(`../src/theme.js?case=${fresh}`);
}

// The gear menu's setter, exactly as useTheme hands it out.
function themeSetter(theme) {
  let api = null;
  function Probe() { api = theme.useTheme(); return null; }
  renderToString(createElement(Probe));
  return api.setPref;
}

test('storage BLOCKED: an explicit Dark survives the next OS appearance change', async () => {
  const env = installEnv({ storage: THROWING_STORAGE, osDark: true });
  const theme = await loadTheme();
  theme.initTheme();
  const setPref = themeSetter(theme);

  setPref('dark');
  assert.equal(env.htmlTheme(), 'dark');
  env.flipOs(false); // sunset in reverse: the OS goes light
  assert.equal(env.htmlTheme(), 'dark', 'the explicit choice must hold for the session');

  setPref('light');
  env.flipOs(true);
  assert.equal(env.htmlTheme(), 'light');
});

test('storage BLOCKED: choosing Auto again follows the OS', async () => {
  const env = installEnv({ storage: THROWING_STORAGE, osDark: false });
  const theme = await loadTheme();
  theme.initTheme();
  const setPref = themeSetter(theme);

  setPref('dark');
  setPref('system');
  env.flipOs(true);
  assert.equal(env.htmlTheme(), 'dark');
  env.flipOs(false);
  assert.equal(env.htmlTheme(), 'light');
});

test('storage READABLE but not WRITABLE (old Safari private mode): the session choice still wins', async () => {
  // getItem answers null while setItem throws a quota error — a read that
  // "succeeds" must not silently mean 'system' either.
  const env = installEnv({
    storage: { getItem: () => null, setItem: blocked, removeItem: () => {} },
    osDark: false,
  });
  const theme = await loadTheme();
  theme.initTheme();
  const setPref = themeSetter(theme);

  setPref('dark');
  env.flipOs(true);
  env.flipOs(false);
  assert.equal(env.htmlTheme(), 'dark');
});

test('storage WORKING: the stored preference stays the source of truth', async () => {
  const store = new Map();
  const env = installEnv({
    storage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
    osDark: false,
  });
  const theme = await loadTheme();
  theme.initTheme();
  const setPref = themeSetter(theme);

  setPref('dark');
  assert.equal(store.get('mm:theme'), 'dark');
  env.flipOs(true);
  env.flipOs(false);
  assert.equal(env.htmlTheme(), 'dark');

  setPref('system');
  assert.equal(store.has('mm:theme'), false, "'system' is stored as no value");
  env.flipOs(true);
  assert.equal(env.htmlTheme(), 'dark');
  env.flipOs(false);
  assert.equal(env.htmlTheme(), 'light');
});
