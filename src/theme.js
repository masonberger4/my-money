// Theme selection + application (the plumbing; the toggle UI lives in Dashboard).
//
// WHERE THE PREFERENCE LIVES: localStorage, deliberately NOT the Supabase
// `settings` table. `settings` is household-shared under one shared login, so a
// stored theme would flip the other person's phone; and localStorage reads
// synchronously, which lets index.html apply the theme BEFORE first paint
// instead of flashing the wrong one.
//
// Every localStorage access is try/caught: Safari private mode and
// storage-disabled browsers THROW on access, and this runs at boot.
//
// NOTE: index.html carries a deliberate 3-line duplicate of the read+apply
// logic in a pre-paint inline <script> (it has to run before any bundle
// loads). If THEME_STORAGE_KEY or the data-theme values change, change it too.

import { useCallback, useEffect, useState } from 'react';

// Everything below except the five public exports (THEME_PREFS, readToken,
// subscribeTheme, initTheme, useTheme) is deliberately MODULE-PRIVATE:
// exporting setThemePref/applyTheme invited a future caller to change the
// theme while bypassing useTheme's subscription, leaving its state stale.
const THEME_STORAGE_KEY = 'mm:theme';

/** Preference values, in toggle-cycle order. Default is 'system'. */
export const THEME_PREFS = ['system', 'light', 'dark'];

const DARK_QUERY = '(prefers-color-scheme: dark)';

const listeners = new Set();

function darkMql() {
  try {
    return typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(DARK_QUERY)
      : null;
  } catch {
    return null;
  }
}

/** Stored preference: 'system' | 'light' | 'dark' (never throws). */
function getThemePref() {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return THEME_PREFS.includes(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Persist + apply a preference. Returns the resolved theme. */
function setThemePref(pref) {
  const next = THEME_PREFS.includes(pref) ? pref : 'system';
  try {
    if (next === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Private mode / storage disabled: the choice still applies for this
    // session, it just won't survive a reload.
  }
  return applyTheme(next);
}

/** 'system' | 'light' | 'dark' -> 'light' | 'dark'. */
function resolveTheme(pref = getThemePref()) {
  if (pref === 'light' || pref === 'dark') return pref;
  const m = darkMql();
  return m && m.matches ? 'dark' : 'light';
}

/** The theme currently on <html>, falling back to resolving the preference. */
function getResolvedTheme() {
  if (typeof document !== 'undefined') {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
  }
  return resolveTheme();
}

/**
 * Read a theme token off <html> at runtime, e.g. readToken('--card').
 * ui.css stays the single source of truth for the value; JS never hardcodes it.
 */
export function readToken(name, fallback = '') {
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

// --bg for a given theme, measured from ui.css rather than hardcoded here.
// Toggling the attribute forces a style recalc but no paint (same task), so
// there is nothing to flicker.
function bgFor(theme) {
  const root = document.documentElement;
  const prev = root.getAttribute('data-theme');
  root.setAttribute('data-theme', theme);
  const v = readToken('--bg');
  if (prev === null) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', prev);
  return v;
}

// index.html declares two <meta name="theme-color"> with light/dark media
// queries. Those follow the OS, so a FORCED theme would leave the browser
// chrome wrong: when the preference is explicit, point BOTH at the resolved
// --bg (whichever one the OS matches is then correct); when it is 'system',
// restore the per-media values.
function syncBrowserChrome(pref, resolved) {
  let metas;
  try {
    metas = document.querySelectorAll('meta[name="theme-color"]');
  } catch {
    return;
  }
  if (!metas || !metas.length) return;
  const forced = pref === 'system' ? '' : bgFor(resolved);
  metas.forEach((meta) => {
    const media = meta.getAttribute('media') || '';
    const value = forced || bgFor(/dark/.test(media) ? 'dark' : 'light');
    if (value) meta.setAttribute('content', value);
  });
}

/**
 * Apply a preference: sets <html data-theme="light|dark"> to the RESOLVED
 * theme and keeps the browser chrome in sync. Returns the resolved theme.
 */
function applyTheme(pref = getThemePref()) {
  const resolved = resolveTheme(pref);
  if (typeof document === 'undefined') return resolved;
  document.documentElement.setAttribute('data-theme', resolved);
  syncBrowserChrome(pref, resolved);
  listeners.forEach((fn) => {
    try {
      fn(resolved, pref);
    } catch {
      // one bad listener must not break theme application
    }
  });
  return resolved;
}

/**
 * Fire handler(resolved, pref) whenever a theme is applied — an explicit
 * change OR a live OS change while the preference is 'system'. Use this to
 * re-read tokens (getComputedStyle) after the theme moves. Returns an
 * unsubscribe function.
 */
export function subscribeTheme(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

/**
 * Low-level: fire handler('light'|'dark') on OS theme changes.
 * Returns an unsubscribe function.
 */
function subscribeSystemTheme(handler) {
  const m = darkMql();
  if (!m) return () => {};
  const onChange = (e) => handler(e.matches ? 'dark' : 'light');
  if (m.addEventListener) m.addEventListener('change', onChange);
  else if (m.addListener) m.addListener(onChange); // older Safari
  return () => {
    if (m.removeEventListener) m.removeEventListener('change', onChange);
    else if (m.removeListener) m.removeListener(onChange);
  };
}

/**
 * Apply the stored preference and keep it live: while the preference is
 * 'system', an OS theme change re-applies immediately; when it is explicit,
 * OS changes are ignored. Returns a teardown function.
 */
export function initTheme() {
  applyTheme();
  return subscribeSystemTheme(() => {
    if (getThemePref() === 'system') applyTheme('system');
  });
}

/**
 * React binding: { pref, resolved, setPref, cycleTheme }.
 *   pref     — 'system' | 'light' | 'dark' (what the user chose)
 *   resolved — 'light' | 'dark' (what is actually rendered)
 */
export function useTheme() {
  const [pref, setPrefState] = useState(getThemePref);
  const [resolved, setResolved] = useState(getResolvedTheme);

  useEffect(() => {
    setResolved(applyTheme(pref));
    if (pref !== 'system') return undefined;
    return subscribeSystemTheme(() => setResolved(applyTheme('system')));
  }, [pref]);

  const setPref = useCallback((next) => {
    const v = THEME_PREFS.includes(next) ? next : 'system';
    setPrefState(v);
    setResolved(setThemePref(v));
  }, []);

  // Cycle from the STATE, not from storage: when localStorage is unavailable
  // (Safari private mode) the write is a no-op, so reading it back would return
  // the same preference forever and the toggle would be stuck.
  const cycleTheme = useCallback(() => {
    setPref(THEME_PREFS[(THEME_PREFS.indexOf(pref) + 1) % THEME_PREFS.length]);
  }, [pref, setPref]);

  return { pref, resolved, setPref, cycleTheme };
}
