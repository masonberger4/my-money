// ReceiptSection.jsx source pins (2026-10 audit) — the component has no pure
// core and the suite has no React renderer, so these follow the
// debtPayoff.test.js / netRetry.test.js source-scan precedent (comments
// stripped first, so a comment can't satisfy a pin).
//
// F23: closing the sheet mid-upload unmounted the section while onPick was
// still awaiting. A failure then hit setErr on an unmounted component and
// vanished (the user believed the receipt was attached), and a success minted
// a preview object URL AFTER the unmount cleanup had revoked the list, so it
// leaked for the life of the PWA session.
//
// F65: a receipt whose signed URL couldn't be minted rendered as a grey tile
// with no way into the viewer — which holds the only Delete — so a
// half-finished delete (object gone, row kept) left a permanent dead tile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/components/ReceiptSection.jsx', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const body = (start, end) => {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `${start} … ${end} not found`);
  return src.slice(i, j);
};

test('the mounted ref is set in the effect body and cleared in its cleanup', () => {
  assert.match(src, /const mounted = useRef\(false\);/);
  assert.match(src, /useEffect\(\(\) => \{\s*mounted\.current = true;\s*return \(\) => \{\s*mounted\.current = false;/,
    'set in the BODY (StrictMode re-runs it) and cleared before the URL revoke');
});

test('onPick checks for an unmount after its awaits and mints no preview URL once gone', () => {
  const pick = body('async function onPick(', 'async function onRetryUrl(');
  assert.match(pick, /const gone = \(\) => !mounted\.current \|\| s !== seq\.current;/);
  const add = pick.indexOf('await addReceipt(');
  const guard = pick.indexOf('if (gone()) { onChanged?.(); return; }');
  const mint = pick.indexOf('URL.createObjectURL(');
  assert.ok(add >= 0 && guard > add, 'the gone() check follows the upload');
  assert.ok(mint > guard, 'createObjectURL runs only on the still-mounted path');
});

test('a failure after the sheet closed alerts through friendlyError instead of a lost setErr', () => {
  const pick = body('async function onPick(', 'async function onRetryUrl(');
  const katch = pick.slice(pick.indexOf('} catch (e) {'));
  assert.match(katch, /const text = friendlyError\(e\);/);
  assert.match(katch, /if \(gone\(\)\) \{ window\.alert\(`Couldn't save the receipt photo: \$\{text\}`\); return; \}/);
  assert.ok(katch.indexOf('window.alert(') < katch.indexOf('setErr('), 'the unmounted path is checked first');
  assert.doesNotMatch(pick, /e\?\.message/);
});

test('an image-unavailable tile opens the viewer, which offers Retry when the photo can\'t load', () => {
  assert.match(src, /aria-label="Receipt \(image unavailable\)"[^>]*\n?\s*onClick=\{openViewer\(r\)\}/,
    'the placeholder tile must reach the viewer (and its Delete)');
  assert.doesNotMatch(src, /onClick=\{e => e\.stopPropagation\(\)\} \/>/, 'no inert tile');
  const viewer = body('{viewing && (', 'Delete receipt');
  assert.match(viewer, /\{urls\[viewing\.id\]\s*\?\s*<img/, 'the viewer branches on whether a URL exists');
  assert.match(viewer, /onRetryUrl\(viewing\)/);
  const retry = body('async function onRetryUrl(', 'const tile =');
  assert.match(retry, /await getReceiptUrl\(r\.storage_path\)/);
  assert.match(retry, /mounted\.current && s === seq\.current/, 'a late retry never writes into a closed or switched sheet');
});

// Reviewer repair (F65): the unavailable tile became role="button" with an
// onClick but no tabIndex or key handler, so on the laptop the keyboard could
// never reach the viewer's Retry/Delete — and the loaded thumbnail (an img
// with onClick) never could either. Both are focusable and open on
// Enter/Space; the key event stops at the tile, or the row around it (whose
// own Enter/Space means "add photo") would open the file picker too.
test('both thumbnail kinds are keyboard targets that open the viewer, not the picker', () => {
  for (const [label, re] of [
    ['loaded thumbnail', /<img key=\{r\.id\}[^>]*\/>/],
    ['unavailable tile', /<div key=\{r\.id\} role="button"[^>]*\/>/],
  ]) {
    const m = src.match(re);
    assert.ok(m, `fixture assumption: the ${label} renders`);
    assert.match(m[0], /role="button"/, `the ${label} is announced as a button`);
    assert.match(m[0], /tabIndex=\{0\}/, `the ${label} is in the tab order`);
    assert.match(m[0], /onClick=\{openViewer\(r\)\}/, `a ${label} click opens the viewer`);
    assert.match(m[0], /onKeyDown=\{openViewer\(r\)\}/, `Enter/Space on the ${label} opens the viewer`);
  }
  const open = body('const openViewer = r => e => {', 'return (');
  assert.match(open, /e\.key !== "Enter" && e\.key !== " "/, 'only Enter and Space open it');
  assert.match(open, /e\.stopPropagation\(\);/, 'the key event must not reach the add-photo row');
  assert.match(open, /setViewing\(r\);/);
});
