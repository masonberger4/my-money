// Source pins for Dashboard.jsx's small inline editors (EditName, BudgetEdit,
// AssignEdit, IncomeEdit, Swatch) — wiring that lives in JSX and DOM event
// order, which no Node unit test can drive. In the test/headerMenu.test.js
// mold: assertions read the SOURCE (comments stripped, so prose about a token
// can't satisfy or trip a scan), never a pasted copy of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dash = readFileSync(join(root, 'src/components/Dashboard.jsx'), 'utf8');
const stripComments = src =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// The body of a top-level `function Name(` up to the next top-level function.
function fnBody(name) {
  const start = dash.indexOf(`\nfunction ${name}(`);
  assert.ok(start > 0, `function ${name} moved — update this test's anchor`);
  const next = dash.indexOf('\nfunction ', start + 1);
  return stripComments(dash.slice(start, next > 0 ? next : undefined));
}

// --- Escape inside an inline editor cancels the EDIT, not the tx sheet -------
// The tx-sheet Escape handler listens in the CAPTURE phase, which runs before
// any React onKeyDown — so EditName's Escape-cancel (the sheet's Payee rename)
// never ran and the press closed the whole sheet. It must yield to a target
// inside [data-mm-esc-local], and every editor that consumes Escape itself
// must carry the marker.
test('the tx-sheet Escape capture yields to [data-mm-esc-local] inline editors', () => {
  const at = dash.indexOf('if(!(selTx||addingCat||catPickerFor))return;');
  assert.ok(at > 0, 'the tx-sheet Escape effect moved — update this test\'s anchor');
  const handler = stripComments(dash.slice(at, dash.indexOf('},[selTx,addingCat,catPickerFor]);', at)));
  const yieldAt = handler.search(/closest\("\[data-mm-esc-local\]"\)\)\s*return;/);
  assert.ok(yieldAt > 0, 'the capture handler must return early for a target inside [data-mm-esc-local]');
  assert.ok(yieldAt < handler.indexOf('stopImmediatePropagation()'),
    'the yield must come BEFORE stopImmediatePropagation, or the editor never hears the press');
  assert.ok(yieldAt < handler.indexOf('setSelTx(null)'),
    'the yield must come before the sheet closes');
  for (const name of ['EditName', 'BudgetEdit', 'AssignEdit', 'IncomeEdit']) {
    const body = fnBody(name);
    assert.match(body, /e\.key==="Escape"\)\{e\.stopPropagation\(\)/,
      `${name} no longer cancels on Escape itself — drop its marker too`);
    const input = body.slice(body.indexOf('<input '), body.indexOf('/>', body.indexOf('<input ')));
    assert.ok(input.length > 0, `${name} has no <input> — update this test`);
    assert.match(input, /data-mm-esc-local=""/,
      `${name}'s input consumes Escape itself, so it must carry data-mm-esc-local=""`);
  }
});

// --- Swatch commits when the picker closes — on the NATIVE change event ------
// The picker opens via a programmatic click() on a pointer-events:none input,
// which is never focused and so never blurs: a blur-only commit previewed the
// new colour and wrote nothing (the laptop's every Swatch site). React's
// onChange on a colour input follows `input` (each drag step), so the close
// has to be heard with a native `change` listener.
test('Swatch commits on a native change listener, bound and unbound', () => {
  const body = fnBody('Swatch');
  assert.match(body, /addEventListener\("change",/,
    'Swatch must listen for the native change event (the picker closing) — blur never fires on the laptop');
  assert.match(body, /removeEventListener\("change",/,
    'the native change listener must be removed on unmount');
  // The listener is bound once, so it must read the props through a ref.
  assert.match(body, /latest\.current=\{color,onChange\}/,
    'the once-bound listener must read color/onChange through a ref, never a stale closure');
  assert.match(body, /v!==latest\.current\.color\)latest\.current\.onChange\(v\)/,
    'commit must write only a colour that differs from the stored one');
  // React's onChange only previews; it must never write per drag step.
  const onChangeAttr = body.slice(body.indexOf('type="color"'));
  assert.doesNotMatch(onChangeAttr.slice(0, onChangeAttr.indexOf('onBlur')), /onChange\(/,
    'the per-step React onChange must only preview, never call the parent onChange');
});
