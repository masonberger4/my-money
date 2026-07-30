// Palette contrast core — PURE (no React, no DOM, no Supabase, zero imports),
// so it is importable from plain Node and testable in isolation, like
// cashFlow.js / csvImport.js.
//
// WHY THIS EXISTS
// The category + account palette (ACCOUNT_COLORS / DEFAULT_COLORS, and any hex
// the user picks with the Swatch colour input) is DATA, not theme: the stored
// values must never change. But a colour chosen to read on a near-white card is
// not automatically legible on a near-black one — a chip that was
// `background: color + "22"; color: color` on #FFFFFF becomes unreadable on
// #222224. So the palette stays fixed and the CONTRAST IS COMPUTED AT RENDER
// against whatever surface the chip actually sits on. That also covers arbitrary
// user-picked colours, which a second hardcoded palette never could.
//
// THE MODEL
// * WCAG 2.1 relative luminance / contrast ratio, verbatim from the spec.
// * To fix a colour up, convert it to HSL, HOLD THE HUE (and the saturation)
//   and move only the LIGHTNESS. Hue is what makes "the Groceries green" still
//   read as the Groceries green after the fix-up.
// * At a fixed hue+saturation, HSL lightness sweeps monotonically from pure
//   black (L=0, luminance 0) through the colour to pure white (L=1,
//   luminance 1) — every channel is non-decreasing in L, and 8-bit rounding
//   preserves that. Two consequences the code leans on:
//     1. luminance(L) is monotone, so a plain BISECTION finds the exact
//        lightness that just clears the target — no unbounded searching.
//     2. because the sweep reaches both endpoints, the target is reachable at
//        FIXED SATURATION for every real surface, so saturation is never
//        reduced. (The contract permits reducing it as a last resort; with this
//        search it is simply never needed. The genuinely unreachable case — a
//        mid-grey background at a high target, where neither black nor white
//        clears it — returns the better endpoint instead of throwing.)
// * Direction (darken vs lighten) is whichever side of the background can
//   actually reach the target; when both can, the one that moves lightness
//   LESS wins, so the colour stays recognisable as itself.
//
// NOTHING HERE MAY THROW. It runs during React render, and per CLAUDE.md the
// app has no error boundary outside the import modal — a render throw blanks
// the whole PWA. Every entry point returns null (or a sane fallback) on garbage
// input instead.
//
// Theme surfaces are NEVER hardcoded here: callers read --card / --bg at
// runtime with getComputedStyle and pass the value in, so src/ui.css stays the
// single source of truth for token values.

// 0x22/255 — reproduces the old `color + "22"` chip tint exactly.
const TINT_ALPHA = 0.1333;
// Bisection depth. 40 halvings take the lightness interval below 1e-12, far
// under one 8-bit step, so the search is exact for our purposes and — the point
// — strictly bounded.
const MAX_STEPS = 40;
// Absorbs the last float ulp, so a caller's `contrastRatio(ink, bg) >= target`
// can't fail by 1e-16 on a value we computed to be exactly on the line.
const EPS = 1e-9;

// --- parsing / formatting ----------------------------------------------------

// '#7F77DD' | '#abc' | '7F77DD' -> {r,g,b} 0-255. null for anything else,
// INCLUDING 8-digit #RRGGBBAA — this module reasons about opaque colours, and
// silently dropping an alpha channel would be a lie about the result.
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const s = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  if (s.length === 3) {
    return { r: byte(s[0] + s[0]), g: byte(s[1] + s[1]), b: byte(s[2] + s[2]) };
  }
  if (s.length === 6) {
    return { r: byte(s.slice(0, 2)), g: byte(s.slice(2, 4)), b: byte(s.slice(4, 6)) };
  }
  return null;
}

function byte(pair) { return parseInt(pair, 16); }
function clampByte(n) { return Math.max(0, Math.min(255, Math.round(n))); }

// {r,g,b} -> '#RRGGBB' (uppercase), channels clamped into 0-255.
export function rgbToHex(rgb) {
  if (!rgb || typeof rgb !== 'object') return null;
  const { r, g, b } = rgb;
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return (
    '#' +
    [r, g, b].map(n => clampByte(n).toString(16).padStart(2, '0')).join('').toUpperCase()
  );
}

// Accept either form everywhere a colour is taken.
function toRgb(value) {
  if (typeof value === 'string') return hexToRgb(value);
  if (value && typeof value === 'object') {
    const { r, g, b } = value;
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return { r: clampByte(r), g: clampByte(g), b: clampByte(b) };
    }
  }
  return null;
}

// --- WCAG 2.1 ----------------------------------------------------------------

function linearize(channel) {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// WCAG 2.1 relative luminance, 0..1. null on unparseable input.
export function relativeLuminance(rgbOrHex) {
  const rgb = toRgb(rgbOrHex);
  if (!rgb) return null;
  return 0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b);
}

function ratioOfLum(l1, l2) {
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// Contrast ratio 1..21 between two colours. null if either is unparseable —
// deliberately null rather than 1 or 21, so a caller's `ratio >= target` reads
// false (the safe direction) when it has been handed nonsense.
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  return ratioOfLum(la, lb);
}

// Flatten `fgHex` at `alpha` over the opaque `bgHex` (what a browser does with
// an rgba fill) so the result can be reasoned about as an opaque colour.
export function compositeOver(fgHex, alpha, bgHex) {
  const fg = toRgb(fgHex);
  const bg = toRgb(bgHex);
  if (!fg && !bg) return null;
  if (!fg) return rgbToHex(bg); // nothing to lay over -> the surface shows through
  if (!bg) return rgbToHex(fg);
  const a = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 0;
  return rgbToHex({
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  });
}

// --- HSL (hue-preserving lightness moves) ------------------------------------

function rgbToHsl({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  const l = (max + min) / 2;
  if (!d) return { h: 0, s: 0, l }; // achromatic — hue is meaningless
  // 1 - |2l-1| >= d always, so s lands in (0,1].
  const s = Math.min(1, d / (1 - Math.abs(2 * l - 1)));
  let h;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  return { r: clampByte((r + m) * 255), g: clampByte((g + m) * 255), b: clampByte((b + m) * 255) };
}

// Largest lightness whose (8-bit-quantised) luminance is still <= maxLum.
// lumAt is monotone non-decreasing, so plain bisection is exact; `lo` always
// satisfies the bound, which is what makes the returned colour provably clear
// the contrast target rather than land near it.
function darkestSideL(lumAt, maxLum) {
  if (maxLum < 0) return null;      // unreachable even at pure black
  if (lumAt(1) <= maxLum) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < MAX_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (lumAt(mid) <= maxLum) lo = mid; else hi = mid;
  }
  return lo;
}

// Smallest lightness whose luminance is >= minLum. Mirror image of the above;
// `hi` always satisfies.
function lightestSideL(lumAt, minLum) {
  if (minLum > 1) return null;      // unreachable even at pure white
  if (lumAt(0) >= minLum) return 0;
  let lo = 0, hi = 1;
  for (let i = 0; i < MAX_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (lumAt(mid) >= minLum) hi = mid; else lo = mid;
  }
  return hi;
}

// --- the public fix-ups ------------------------------------------------------

// A hex with >= `target` contrast against `bgHex`, same hue and saturation as
// `hex`, only the lightness moved. Returns `hex` untouched (normalised) when it
// already clears the target — which also makes this idempotent.
export function readableInk(hex, bgHex, target = 4.5) {
  const own = toRgb(hex);
  const bg = toRgb(bgHex);
  if (!bg) return own ? rgbToHex(own) : null; // no surface to reason about
  // Garbage colour on a real surface: fall back to a neutral ink derived from
  // the surface itself, so the caller still gets something legible.
  const base = own || bg;
  const goal = Number.isFinite(target) && target > 1 ? target : 1;

  const lbg = relativeLuminance(bg);
  const lBase = relativeLuminance(base);
  if (ratioOfLum(lBase, lbg) >= goal) return rgbToHex(base);

  const { h, s, l } = rgbToHsl(base);
  const lumAt = L => relativeLuminance(hslToRgb(h, s, L));
  const goalEps = goal * (1 + EPS);

  // Luminance a darker ink must stay under / a lighter ink must reach, straight
  // from the WCAG ratio definition.
  const darkL = darkestSideL(lumAt, (lbg + 0.05) / goalEps - 0.05);
  const lightL = lightestSideL(lumAt, (lbg + 0.05) * goalEps - 0.05);

  let pick = null;
  if (darkL !== null && lightL !== null) {
    // Both sides have headroom — take the smaller move, so the colour stays
    // recognisable as itself.
    pick = Math.abs(darkL - l) <= Math.abs(lightL - l) ? darkL : lightL;
  } else if (darkL !== null) pick = darkL;
  else if (lightL !== null) pick = lightL;

  if (pick === null) {
    // Real case: a mid-grey background at a high target has no room on either
    // side. Return the BEST ACHIEVABLE endpoint — never something worse.
    return rgbToHex(hslToRgb(h, s, ratioOfLum(0, lbg) >= ratioOfLum(1, lbg) ? 0 : 1));
  }
  return rgbToHex(hslToRgb(h, s, pick));
}

// Same fix-up for non-text marks — donut segments, bar fills, legend dots —
// where WCAG's non-text contrast minimum is 3:1 rather than 4.5:1.
export function markColor(hex, bgHex, target = 3) {
  return readableInk(hex, bgHex, target);
}

// The whole chip in one call: the tinted background the chip paints, the label
// ink that reads on it, and the dot/mark colour.
//   bg  = the palette colour laid over the surface at tintAlpha
//   ink = >= target (4.5:1) against that bg
//   dot = >= dotTarget (3:1) against that bg
export function chipStyle(hex, surfaceHex, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const target = Number.isFinite(o.target) ? o.target : 4.5;
  const dotTarget = Number.isFinite(o.dotTarget) ? o.dotTarget : 3;
  const tintAlpha = Number.isFinite(o.tintAlpha) ? o.tintAlpha : TINT_ALPHA;
  const bg = compositeOver(hex, tintAlpha, surfaceHex);
  return { bg, ink: readableInk(hex, bg, target), dot: markColor(hex, bg, dotTarget) };
}
