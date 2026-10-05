// F49 — iOS Safari zooms the page when a form control under 16px takes focus
// and never zooms back out. The app's controls are sized inline (11–14px in
// the dense rows), so ONE coarse-pointer rule in src/ui.css lifts them all to
// 16px on a phone; `!important` is what lets a stylesheet rule beat an inline
// declaration. These pins keep that rule, keep its escape hatch honest (no
// control is sized ABOVE 16px inline, which the rule would shrink), and keep
// the rejected alternative out: `maximum-scale=1`/`user-scalable=no` would
// stop the zoom by disabling pinch-zoom, an accessibility regression.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

// The body of the first `@media <query> { … }` block, brace-matched.
function mediaBlock(css, query) {
  const start = css.indexOf(`@media ${query}`);
  if (start < 0) return null;
  let i = css.indexOf('{', start);
  const open = i;
  let depth = 0;
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) break;
  }
  return css.slice(open + 1, i);
}

test('ui.css lifts text-entry controls to 16px !important on a coarse pointer', () => {
  const css = read('src/ui.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = mediaBlock(css, '(pointer: coarse)');
  assert.ok(block, 'missing the @media (pointer: coarse) block');
  const rule = block.match(/([^{}]+)\{([^}]*)\}/);
  assert.ok(rule, 'the coarse-pointer block must hold a rule');
  const selectors = rule[1].split(',').map(s => s.trim());
  assert.match(rule[2], /font-size:\s*16px\s*!important/, 'must be 16px AND !important — inline styles beat a normal rule');
  assert.ok(selectors.some(s => /^input\b/.test(s)), 'inputs are covered');
  assert.ok(selectors.includes('select'), 'selects are covered (iOS zooms on them too)');
  assert.ok(selectors.includes('textarea'), 'textareas are covered');
  const input = selectors.find(s => /^input\b/.test(s));
  for (const t of ['checkbox', 'radio']) {
    assert.ok(input.includes(`:not([type=${t}])`), `non-text input type ${t} is excluded`);
  }
});

test('index.html keeps pinch-zoom: no maximum-scale, no user-scalable=no', () => {
  const html = read('index.html');
  const meta = html.match(/<meta name="viewport" content="([^"]+)"/);
  assert.ok(meta, 'viewport meta must exist');
  assert.doesNotMatch(meta[1], /maximum-scale/);
  assert.doesNotMatch(meta[1], /user-scalable\s*=\s*(no|0)/);
});

// The rule sets EXACTLY 16px, so a control sized above that inline would be
// shrunk on a phone. None is today; one that should be needs its own rule.
test('no form control is sized above 16px inline (the coarse rule would shrink it)', () => {
  const dir = join(root, 'src/components');
  const files = readdirSync(dir).filter(f => f.endsWith('.jsx')).map(f => join('src/components', f));
  const offenders = [];
  let seen = 0;
  for (const f of files) {
    const s = read(f);
    for (const m of s.matchAll(/<(input|select|textarea)\b/g)) {
      // The opening tag, up to its closing `>` outside any {…} expression.
      let i = m.index + m[0].length;
      let depth = 0;
      for (; i < s.length; i++) {
        const c = s[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0 && s[i - 1] !== '=') break;
      }
      seen++;
      for (const fs of s.slice(m.index, i).matchAll(/fontSize:\s*(\d+)/g)) {
        if (Number(fs[1]) > 16) offenders.push(`${f}:${s.slice(0, m.index).split('\n').length} fontSize ${fs[1]}`);
      }
    }
  }
  assert.ok(seen >= 40, `expected the app's form controls to be scanned (found ${seen})`);
  assert.deepEqual(offenders, []);
});
