// Static guards for the gear-menu header consolidation (90ba5c6): the four
// top-right buttons (quick-add / theme cycle / refresh / sign-out) collapsed
// into ONE gear button that opens GearMenu, an overlay that must be a
// REGISTERED sheet (anySheetOpen + closeAllSheets) or the back gesture and
// Escape ignore it. Pull-to-refresh shares refreshNow with the gear menu's
// Refresh row.
//
// In the test/userOwnedCategories.test.js mold: source-text assertions,
// because these are cross-artifact rules (a hook JS file, a React source
// file) that no unit test can reach, and every assertion derives from the
// SOURCE, never from a copy of the strings pasted into this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

const DASH = 'src/components/Dashboard.jsx';
const THEME = 'src/theme.js';
const RENDER = 'test/smoke/render.mjs';

// --- The gear overlay is registered, not a fourth untracked panel -----------
// An overlay left out of anySheetOpen is one the back gesture and Escape
// can't see; left out of closeAllSheets, a stray back-pop or Escape on a
// DIFFERENT sheet leaves the gear menu's own state open underneath it.
test('gearOpen is part of anySheetOpen and is cleared by closeAllSheets', () => {
  const dash = read(DASH);
  const sheetLine = dash.split('\n').find(l => l.includes('const anySheetOpen='));
  assert.ok(sheetLine && sheetLine.includes('gearOpen'),
    'gearOpen must be part of anySheetOpen or the back gesture/Escape ignore the gear menu');

  const ca = dash.indexOf('const closeAllSheets=useCallback');
  assert.ok(ca > 0, 'closeAllSheets moved — update this test\'s anchor string');
  const closer = dash.slice(ca, dash.indexOf('},[]);', ca));
  assert.ok(closer.includes('setGearOpen(false)'),
    'closeAllSheets must clear gearOpen or a stray back-pop/Escape leaves the gear menu open underneath the next sheet');
});

// --- TDZ: gearOpen must be declared before it is read ------------------------
// `const anySheetOpen=` reads gearOpen at the moment it runs; if the
// [gearOpen,setGearOpen] declaration sits BELOW that line, the read throws a
// ReferenceError on every render. This is invisible to a check that only
// confirms gearOpen's NAME appears somewhere in the anySheetOpen line — it
// has to also pass this ordering check.
test('the [gearOpen,setGearOpen] declaration sits above anySheetOpen (TDZ)', () => {
  const dash = read(DASH);
  const declIdx = dash.indexOf('const [gearOpen,setGearOpen]');
  const sheetIdx = dash.indexOf('const anySheetOpen=');
  assert.ok(declIdx > 0, 'the gearOpen state declaration moved — update this test\'s anchor string');
  assert.ok(sheetIdx > 0, 'the anySheetOpen declaration moved — update this test\'s anchor string');
  assert.ok(declIdx < sheetIdx,
    'gearOpen must be declared BEFORE anySheetOpen reads it, or every render throws a TDZ ReferenceError');
});

// --- The header picks a theme now; a surviving cycler is a second control ---
test('cycleTheme is gone from both the header and src/theme.js', () => {
  const dash = read(DASH);
  const theme = read(THEME);
  // Case-INSENSITIVE deliberately (the recorded setPickingCat lesson): a
  // renamed helper like `CycleTheme` or a stray `cycletheme` string would
  // walk right past a case-sensitive guard.
  assert.doesNotMatch(dash, /cycleTheme/i,
    'the theme control is now a three-way segmented control (setThemePref) — a surviving cycleTheme is a second way to change the same preference');
  assert.doesNotMatch(theme, /cycleTheme/i,
    'cycleTheme was deleted from src/theme.js — a surviving export is dead code advertising a removed control');
});

// --- Pull-to-refresh must be blocked while a sheet is open or already busy --
test('<PullRefresh> is gated on anySheetOpen||loading', () => {
  const dash = read(DASH);
  const line = dash.split('\n').find(l => l.includes('<PullRefresh'));
  assert.ok(line, 'the <PullRefresh render line moved — update this test\'s anchor string');
  assert.ok(line.includes('blocked={anySheetOpen||loading}'),
    'sheets scroll internally (the gesture would fight that scroll) and a refresh already in flight must not be stacked by a second pull');
});

// --- The gesture must be additive on top of native scrolling ----------------
// A non-passive listener (or one that calls preventDefault, or CSS that sets
// touch-action) makes the browser wait to see if the handler cancels the
// scroll before it can start scrolling AT ALL — jank on every touch on the
// whole page, not just during a pull.
// The reasoning for these rules lives in comments RIGHT NEXT TO the code they
// govern (this repo's house style), so a scan asserting a token is ABSENT has
// to look at code only — the same stripComments discipline
// test/invalidationMatrix.test.js uses for exactly this reason.
const stripComments = src =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('usePullRefresh listens passively and never blocks native scrolling', () => {
  const dash = read(DASH);
  const start = dash.indexOf('function usePullRefresh(');
  const end = dash.indexOf('function PullRefresh(');
  assert.ok(start > 0 && end > start,
    'usePullRefresh/PullRefresh moved — update this test\'s anchor strings');
  const slice = stripComments(dash.slice(start, end));

  assert.match(slice, /passive:true/,
    'the touch/wheel listeners must be {passive:true} — the gesture is additive on top of native scrolling');
  // A call, not the bare word — the slice's own comment says "never
  // preventDefault" in prose, which a bare-word match would trip on.
  assert.doesNotMatch(slice, /preventDefault\(/,
    'preventDefault on any of these listeners would block the page\'s native scroll for everyone, not just during a pull');
  // camelCase: the inline-style form is the only way this file could set it
  // (the prose form lives in comments, which stripComments already removed).
  assert.doesNotMatch(slice, /touchAction\s*:/,
    'a touch-action override here would fight ui.css\'s overscroll-behavior-y:contain, which is what stops the browser\'s own pull-to-refresh underneath this one');

  // Every window listener bound must also be unbound, or it outlives the
  // component (a duplicate handler on the next mount, firing against stale
  // closures / a torn-down DOM).
  for (const name of ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'wheel']) {
    assert.match(slice, new RegExp(`addEventListener\\("${name}"`),
      `${name} must be bound with addEventListener or the gesture can't hear it`);
    assert.match(slice, new RegExp(`removeEventListener\\("${name}"`),
      `${name} must be unbound in the cleanup or a window listener outlives the component`);
  }
});

// --- Shared household login: sign-out stays a confirmed, labelled row -------
// An icon-only sign-out on a shared login is a mis-tap hazard; the confirm()
// is the safety net that catches the mis-tap before it actually signs out.
test('sign-out keeps its confirm string and its "Sign out" label', () => {
  const dash = read(DASH);
  assert.match(dash, /Sign out on this device/,
    'the confirm() copy is the safety net for a shared household login — a stray tap must not silently sign the whole household out');
  assert.match(dash, /Sign out\s*<\/button>/,
    'the gear menu\'s sign-out row must still render the word "Sign out", not just an icon');
});

// --- New overlay controls need both the source hooks and the smoke walk -----
// A hook/selector that exists only on one side of this pair is invisible in
// CI: JSX that never renders for the smoke walk (the recorded searchOpen
// lesson) is dead in production monitoring, and a walk selector with nothing
// in the DOM to match silently no-ops instead of failing.
test('the gear open/close hooks exist in both Dashboard.jsx and the smoke walk', () => {
  const dash = read(DASH);
  const render = read(RENDER);

  assert.match(dash, /data-mm-gear=""/, 'the gear button must carry data-mm-gear=""');
  assert.match(dash, /data-mm-gear-close=""/, 'the overlay backdrop must carry data-mm-gear-close=""');
  assert.match(render, /\[data-mm-gear\]/, 'the smoke walk must click the gear button open');
  assert.match(render, /\[data-mm-gear-close\]/, 'the smoke walk must close the gear menu again');
  assert.match(render, /EXPECTED_VIEWS\s*=\s*11/,
    'the gear walk steps are uncounted (per the ship note) — EXPECTED_VIEWS must still be 11');
});

// --- One meaning of "refresh" -------------------------------------------------
// Two call sites each computing their own fetchData(...) would drift the
// moment the sync contract (e.g. sync:"refresh") changes in only one place.
test('refreshNow is defined once and shared by PullRefresh and GearMenu', () => {
  const dash = read(DASH);
  const defCount = (dash.match(/const refreshNow=/g) || []).length;
  assert.equal(defCount, 1,
    'refreshNow must be defined exactly once — a second definition is a second place the refresh contract can drift');
  assert.match(dash, /<PullRefresh\b[^>]*onTrigger={refreshNow}/,
    'the pull-to-refresh gesture must trigger the same refreshNow the gear menu uses');
  assert.match(dash, /onRefresh={refreshNow}/,
    'the gear menu\'s Refresh row must call the same refreshNow the pull gesture uses');
});
