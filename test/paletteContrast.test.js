// Tests for the pure palette-contrast core (src/paletteContrast.js).
//
// The load-bearing one is "the palette sweep" below: the app's stored palette is
// user DATA whose hex values must never change, so the only thing standing
// between a user-picked colour and an unreadable chip on the opposite theme is
// this module. That test asserts the WCAG floors hold for the real palette AND
// for a synthetic sweep of the whole hue circle, on every surface the app
// paints chips on.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hexToRgb,
  rgbToHex,
  relativeLuminance,
  contrastRatio,
  compositeOver,
  readableInk,
  markColor,
  chipStyle,
} from '../src/paletteContrast.js';

// --- fixtures ----------------------------------------------------------------

// Mirrors ACCOUNT_COLORS in src/components/Dashboard.jsx.
const ACCOUNT_COLORS = ['#7F77DD', '#1D9E75', '#D85A30', '#378ADD', '#FAC775', '#D4537E', '#639922', '#E24B4A'];
// Every distinct value in DEFAULT_COLORS there, plus its "#888780" fallback.
const CATEGORY_COLORS = ['#7F77DD', '#1D9E75', '#D85A30', '#378ADD', '#FAC775', '#888780'];

// Surfaces a chip can sit on. These are TEST FIXTURES mirroring --bg/--card/
// --input-bg/--border in src/ui.css, which stays the single source of truth —
// the module itself hardcodes no surface; callers read them at runtime.
const LIGHT_SURFACES = ['#F7F6F2', '#FFFFFF', '#E4E2DC'];
// #6E6E76 is the dark --track: the mid-grey the budget rails, the 6-month bars
// and the cash-flow bars are painted on, and the only surface in the app with
// headroom in neither direction — so it is the one that exercises readableInk's
// direction choice hardest.
const DARK_SURFACES = ['#18181A', '#222224', '#2A2A2C', '#6E6E76'];
const SURFACES = [...LIGHT_SURFACES, ...DARK_SURFACES];

const GARBAGE = [null, undefined, '', 'red', '#12', '#7F77DD80', '12345678', '#GGG', '  ', 42, {}, []];

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: expected ${expected}±${tol}, got ${actual}`);

// Independent HSL, so the hue-preservation test doesn't check the module
// against its own conversion.
function hslOf(hex) {
  const { r, g, b } = hexToRgb(hex);
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  const l = (max + min) / 2;
  if (!d) return { h: null, s: 0, l }; // achromatic — hue is meaningless
  let h;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s: d / (1 - Math.abs(2 * l - 1)), l };
}

function hslHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  return rgbToHex({ r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 });
}

// The hue circle at several saturations and lightnesses — stands in for the
// arbitrary colours the Swatch <input type=color> lets the user pick.
function hueSweep() {
  const out = [];
  for (let h = 0; h < 360; h += 5) {
    for (const s of [0, 0.15, 0.4, 0.7, 1]) {
      for (const l of [0.04, 0.2, 0.35, 0.5, 0.65, 0.8, 0.96]) out.push(hslHex(h, s, l));
    }
  }
  return out;
}

const ALL_COLORS = [
  ...new Set([...ACCOUNT_COLORS, ...CATEGORY_COLORS, ...hueSweep(), '#000000', '#FFFFFF']),
];

// --- hexToRgb / rgbToHex -----------------------------------------------------

test('hexToRgb parses the forms the app actually stores', () => {
  assert.deepEqual(hexToRgb('#7F77DD'), { r: 127, g: 119, b: 221 });
  assert.deepEqual(hexToRgb('7F77DD'), { r: 127, g: 119, b: 221 });
  assert.deepEqual(hexToRgb(' #7f77dd '), { r: 127, g: 119, b: 221 });
  assert.deepEqual(hexToRgb('#abc'), { r: 170, g: 187, b: 204 });
});

test('hexToRgb returns null on garbage — including 8-digit #RRGGBBAA', () => {
  for (const bad of GARBAGE) assert.equal(hexToRgb(bad), null, `hexToRgb(${JSON.stringify(bad)})`);
});

test('rgbToHex is uppercase, clamped, and null on non-finite channels', () => {
  assert.equal(rgbToHex({ r: 127, g: 119, b: 221 }), '#7F77DD');
  assert.equal(rgbToHex({ r: -20, g: 300, b: 127.5 }), '#00FF80'); // clamped + rounded
  assert.equal(rgbToHex({ r: NaN, g: 0, b: 0 }), null);
  assert.equal(rgbToHex(null), null);
  assert.equal(rgbToHex('#7F77DD'), null); // takes rgb, not hex
});

// --- WCAG math against known-good references ---------------------------------

test('relativeLuminance hits the WCAG endpoints exactly', () => {
  assert.equal(relativeLuminance('#000000'), 0);
  assert.equal(relativeLuminance('#FFFFFF'), 1);
  assert.equal(relativeLuminance({ r: 255, g: 255, b: 255 }), 1);
  assert.equal(relativeLuminance('nope'), null);
});

test('contrastRatio matches known-good reference values', () => {
  // Spec endpoints.
  near(contrastRatio('#FFFFFF', '#000000'), 21, 1e-9, 'white on black');
  near(contrastRatio('#000000', '#FFFFFF'), 21, 1e-9, 'black on white (symmetric)');
  assert.equal(contrastRatio('#7F77DD', '#7F77DD'), 1); // identical colours

  // Widely published reference greys: #767676 is THE canonical "smallest grey
  // that passes AA on white" (4.54:1) and #949494 the 3:1 non-text one (3.03:1).
  near(contrastRatio('#767676', '#FFFFFF'), 4.5422, 0.001, '#767676 on white');
  near(contrastRatio('#949494', '#FFFFFF'), 3.0335, 0.001, '#949494 on white');

  // Two hand-checked colours from the app's own palette.
  near(contrastRatio('#7F77DD', '#FFFFFF'), 3.7599, 0.001, 'accent on white');
  near(contrastRatio('#1D9E75', '#FFFFFF'), 3.3872, 0.001, 'green on white');
});

test('contrastRatio returns null (never a misleading number) on garbage', () => {
  for (const bad of GARBAGE) {
    assert.equal(contrastRatio(bad, '#FFFFFF'), null);
    assert.equal(contrastRatio('#FFFFFF', bad), null);
    // The point of null: a `ratio >= target` guard reads false, the safe side.
    assert.equal(contrastRatio(bad, '#FFFFFF') >= 4.5, false);
  }
});

// --- compositeOver -----------------------------------------------------------

test('compositeOver: alpha 0 is the background, alpha 1 is the foreground', () => {
  assert.equal(compositeOver('#7F77DD', 0, '#F7F6F2'), '#F7F6F2');
  assert.equal(compositeOver('#7F77DD', 1, '#F7F6F2'), '#7F77DD');
});

test('compositeOver: known midpoint and the 0x22 chip tint', () => {
  assert.equal(compositeOver('#FFFFFF', 0.5, '#000000'), '#808080'); // 127.5 -> 128
  // 0.1333 ≈ 0x22/255 — what `color + "22"` used to paint on a white card.
  assert.equal(compositeOver('#7F77DD', 0.1333, '#FFFFFF'), '#EEEDFA');
});

test('compositeOver clamps alpha and degrades gracefully on garbage', () => {
  assert.equal(compositeOver('#FFFFFF', 2, '#000000'), '#FFFFFF');
  assert.equal(compositeOver('#FFFFFF', -1, '#000000'), '#000000');
  assert.equal(compositeOver('#FFFFFF', NaN, '#000000'), '#000000');
  assert.equal(compositeOver('nope', 0.5, '#000000'), '#000000'); // surface shows through
  assert.equal(compositeOver('#FFFFFF', 0.5, 'nope'), '#FFFFFF');
  assert.equal(compositeOver('nope', 0.5, 'nope'), null);
});

// --- THE PALETTE SWEEP: the property that proves the feature ------------------

test('chipStyle: every palette + swept colour clears 4.5:1 ink and 3:1 dot on every surface', () => {
  let checks = 0;
  const failures = [];
  for (const color of ALL_COLORS) {
    for (const surface of SURFACES) {
      const { bg, ink, dot } = chipStyle(color, surface);
      assert.ok(bg && ink && dot, `chipStyle(${color}, ${surface}) returned a null part`);
      const inkRatio = contrastRatio(ink, bg);
      const dotRatio = contrastRatio(dot, bg);
      if (inkRatio < 4.5) failures.push(`ink ${ink} on ${bg} (from ${color}/${surface}) = ${inkRatio.toFixed(3)}`);
      if (dotRatio < 3) failures.push(`dot ${dot} on ${bg} (from ${color}/${surface}) = ${dotRatio.toFixed(3)}`);
      checks++;
    }
  }
  assert.ok(checks > 2000, `sweep should be exhaustive, only ran ${checks} checks`);
  assert.deepEqual(failures.slice(0, 10), [], `${failures.length} contrast failures`);
});

test('chipStyle honours custom targets and tint alpha', () => {
  const { bg, ink, dot } = chipStyle('#1D9E75', '#FFFFFF', { target: 7, dotTarget: 4.5, tintAlpha: 0.25 });
  assert.equal(bg, compositeOver('#1D9E75', 0.25, '#FFFFFF'));
  assert.ok(contrastRatio(ink, bg) >= 7, `ink ${ink} on ${bg}`);
  assert.ok(contrastRatio(dot, bg) >= 4.5, `dot ${dot} on ${bg}`);
});

test('readableInk/markColor clear their targets directly against a surface too', () => {
  for (const color of [...ACCOUNT_COLORS, ...CATEGORY_COLORS]) {
    for (const surface of SURFACES) {
      assert.ok(contrastRatio(readableInk(color, surface), surface) >= 4.5, `ink ${color} on ${surface}`);
      assert.ok(contrastRatio(markColor(color, surface), surface) >= 3, `mark ${color} on ${surface}`);
    }
  }
});

test('a colour that already clears the target comes back untouched (just normalised)', () => {
  // #1D9E75 is 6.2:1 on the dark card — no fix-up needed.
  assert.ok(contrastRatio('#1D9E75', '#222224') >= 4.5);
  assert.equal(readableInk('#1d9e75', '#222224'), '#1D9E75');
  assert.equal(markColor('#1d9e75', '#222224'), '#1D9E75');
});

// --- hue preservation --------------------------------------------------------

test('readableInk preserves hue (achromatic inputs excepted, where hue is meaningless)', () => {
  const HUE_TOL = 3; // degrees, for a colour with room to express a hue
  const NEAR_GREY = 0.1; // below this, hue is numerically ill-conditioned (see below)
  // Hue lives in the SPREAD between the max and min channel. Each hue sector is
  // 60° wide and is located by the middle channel's position within that
  // spread, so rounding two channels by up to half a step each can move the
  // nominal hue by ~60/d degrees on a spread of d units. Precision therefore
  // degrades as a colour is pushed toward either end of
  // the lightness range — forcing a muted colour dark enough to clear a
  // mid-grey surface can leave a spread of only a few units. The tolerance
  // therefore scales with the spread actually available in the RESULT rather
  // than being a flat number the pathological cases have to be excused from.
  const spread = (hex) => {
    const c = hexToRgb(hex);
    return c ? Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) : 0;
  };
  let worst = 0;
  let worstCase = null;
  for (const color of ALL_COLORS) {
    for (const surface of SURFACES) {
      const before = hslOf(color);
      const inkHex = readableInk(color, surface);
      const after = hslOf(inkHex);
      if (before.h === null) {
        // Pure grey in, pure grey out — nothing to preserve, but it must not
        // sprout a hue.
        assert.equal(after.h, null, `${color} on ${surface} gained a hue`);
        continue;
      }
      assert.notEqual(after.h, null, `${color} on ${surface} went achromatic`);
      if (before.s < NEAR_GREY) {
        // A near-grey like #888780 spans ~7 of 256 steps between its channels,
        // so a single unit of rounding swings its nominal hue by degrees. What
        // actually matters there is that it stays a near-grey of the same cast.
        near(after.s, before.s, 0.02, `${color} on ${surface} saturation`);
        continue;
      }
      let d = Math.abs(after.h - before.h);
      if (d > 180) d = 360 - d; // hue is circular
      const tol = Math.max(HUE_TOL, 60 / Math.max(spread(inkHex), 1));
      assert.ok(d <= tol,
        `hue drifted ${d.toFixed(2)}° (tolerance ${tol.toFixed(2)}° for a ${spread(inkHex)}-unit channel spread): ${color} on ${surface} -> ${inkHex}`);
      // Headline number: the worst drift among results with enough spread that
      // the flat HUE_TOL is the binding constraint (60/d <= HUE_TOL, i.e.
      // d >= 20) — otherwise this would just restate the scaled tolerance.
      if (spread(inkHex) >= 60 / HUE_TOL && d > worst) { worst = d; worstCase = `${color} on ${surface} -> ${inkHex}`; }
    }
  }
  assert.ok(worst <= HUE_TOL, `hue drifted ${worst.toFixed(2)}° (${worstCase})`);
});

test('readableInk keeps saturation — only lightness moves', () => {
  // Yellow forced dark on white and pale on black is still recognisably yellow.
  for (const surface of ['#FFFFFF', '#18181A']) {
    const before = hslOf('#FAC775');
    const after = hslOf(readableInk('#FAC775', surface));
    near(after.s, before.s, 0.02, `saturation on ${surface}`);
  }
});

// --- direction, idempotence, stability ---------------------------------------

test('direction follows the surface: darken on light, lighten on dark', () => {
  // Only a mid-tone that fails 4.5:1 on BOTH surfaces proves the direction is
  // chosen rather than fixed — most colours already pass on one side and come
  // back untouched. These two sit in that narrow band.
  for (const mid of ['#7C7C7C', '#7A6BD0']) {
    assert.ok(contrastRatio(mid, '#FFFFFF') < 4.5 && contrastRatio(mid, '#18181A') < 4.5, `${mid} fixture`);
    assert.ok(relativeLuminance(readableInk(mid, '#FFFFFF')) < relativeLuminance(mid), `${mid} should darken on white`);
    assert.ok(relativeLuminance(readableInk(mid, '#18181A')) > relativeLuminance(mid), `${mid} should lighten on near-black`);
  }
});

test('when both directions reach the target, the smaller lightness move wins', () => {
  // #7C7C7C sits at luminance ~0.20, where BOTH black and white clear 3:1 — so
  // the direction is decided by the colour, not the surface. The lighter
  // colour goes lighter and the darker one goes darker; a fixed direction
  // would have to get one of them wrong.
  const bg = '#7C7C7C';
  assert.ok(contrastRatio('#000000', bg) >= 3 && contrastRatio('#FFFFFF', bg) >= 3, 'fixture: both sides reachable');
  const light = markColor('#7F77DD', bg); // HSL lightness .67 -> lighten
  const dark = markColor('#1D9E75', bg); // HSL lightness .37 -> darken
  assert.ok(relativeLuminance(light) > relativeLuminance('#7F77DD'), `#7F77DD should lighten, got ${light}`);
  assert.ok(relativeLuminance(dark) < relativeLuminance('#1D9E75'), `#1D9E75 should darken, got ${dark}`);
  assert.ok(contrastRatio(light, bg) >= 3 && contrastRatio(dark, bg) >= 3);
});

test('idempotent: feeding the output back in does not drift', () => {
  for (const color of ALL_COLORS) {
    for (const surface of SURFACES) {
      const { bg } = chipStyle(color, surface);
      const once = readableInk(color, bg);
      const twice = readableInk(once, bg);
      assert.equal(twice, once, `readableInk drifted for ${color} on ${surface}`);
      assert.equal(readableInk(twice, bg), once, `readableInk drifted on the 3rd pass for ${color}`);
      const d1 = markColor(color, bg);
      assert.equal(markColor(d1, bg), d1, `markColor drifted for ${color} on ${surface}`);
    }
  }
});

test('deterministic: identical inputs give identical output', () => {
  for (const color of [...ACCOUNT_COLORS, '#123456', '#abc']) {
    for (const surface of SURFACES) {
      assert.deepEqual(chipStyle(color, surface), chipStyle(color, surface));
    }
  }
});

// --- the unreachable case ----------------------------------------------------

test('unreachable target returns the BEST achievable endpoint, not something worse', () => {
  // A mid-grey background has little headroom either way: at 7:1 neither black
  // nor white clears it, so the better of the two must come back.
  for (const bg of ['#808080', '#767676', '#949494']) {
    for (const target of [7, 10, 21]) {
      const ink = readableInk('#D85A30', bg, target);
      const best = Math.max(contrastRatio('#000000', bg), contrastRatio('#FFFFFF', bg));
      assert.ok(contrastRatio(ink, bg) >= best - 1e-9, `${ink} on ${bg} @${target} is below the best achievable ${best}`);
      assert.ok(contrastRatio(ink, bg) < target, 'this fixture is meant to be unreachable');
    }
  }
});

test('a target below 1 (or nonsense) never makes things worse', () => {
  for (const target of [0, -5, NaN, null, 'x']) {
    const ink = readableInk('#7F77DD', '#FFFFFF', target);
    assert.ok(hexToRgb(ink), `readableInk returned ${ink} for target ${target}`);
  }
});

// --- nothing throws (a render throw blanks the PWA) --------------------------

test('no entry point throws on garbage, and results stay usable', () => {
  for (const bad of GARBAGE) {
    for (const surface of [...SURFACES, ...GARBAGE]) {
      assert.doesNotThrow(() => {
        relativeLuminance(bad);
        contrastRatio(bad, surface);
        compositeOver(bad, 0.5, surface);
        readableInk(bad, surface);
        markColor(bad, surface);
        chipStyle(bad, surface);
      }, `threw for ${JSON.stringify(bad)} / ${JSON.stringify(surface)}`);
    }
  }
});

test('a garbage colour on a real surface still yields legible ink', () => {
  for (const bad of GARBAGE) {
    for (const surface of SURFACES) {
      const { bg, ink, dot } = chipStyle(bad, surface);
      assert.equal(bg, surface, 'no colour to tint with -> the surface shows through');
      assert.ok(contrastRatio(ink, bg) >= 4.5, `fallback ink ${ink} on ${bg}`);
      assert.ok(contrastRatio(dot, bg) >= 3, `fallback dot ${dot} on ${bg}`);
    }
  }
});

test('a real colour on a garbage surface keeps the colour rather than mangling it', () => {
  for (const bad of GARBAGE) {
    assert.equal(readableInk('#7F77DD', bad), '#7F77DD');
    const { bg, ink, dot } = chipStyle('#7F77DD', bad);
    assert.equal(bg, '#7F77DD'); // nothing to composite over
    assert.ok(contrastRatio(ink, bg) >= 4.5, `ink ${ink} on ${bg}`);
    assert.ok(contrastRatio(dot, bg) >= 3, `dot ${dot} on ${bg}`);
  }
});

test('garbage on both sides returns nulls, not junk hex', () => {
  assert.deepEqual(chipStyle('nope', 'nope'), { bg: null, ink: null, dot: null });
  assert.equal(readableInk(null, null), null);
});
