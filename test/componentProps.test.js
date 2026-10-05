// Every prop a Dashboard.jsx call site passes to one of the file's own
// components must be one that component declares. A prop the signature never
// destructures is dead — it reads as available (`accounts` on QuickAddSheet,
// `surf` on TargetSheet both did) and is undefined inside. Zero deps: a
// brace/quote-aware scan of the JSX opening tags, in the test/headerMenu.test.js
// source-pin mold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dash = readFileSync(new URL('../src/components/Dashboard.jsx', import.meta.url), 'utf8');

// Top-level `function Name({a,b=1,c})` signatures. A rest prop (`...rest`)
// accepts anything, so such a component is skipped.
function signatures(src) {
  const sigs = new Map();
  for (const m of src.matchAll(/^(?:export default )?function ([A-Z]\w*)\(\{([^}]*)\}\)/gm)) {
    if (m[2].includes('...')) continue;
    sigs.set(m[1], new Set(m[2].split(',').map(p => p.trim().split('=')[0].trim()).filter(Boolean)));
  }
  return sigs;
}

// Attribute names of the opening tag starting at `at` (just past `<Name`):
// names at brace depth 0, skipping {expressions} and "string" values.
function attrNames(src, at) {
  const names = [];
  let depth = 0, tok = '';
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (depth === 0 && c === '"') { i = src.indexOf('"', i + 1); tok = ''; continue; }
    if (c === '{') { depth++; tok = ''; continue; }
    if (c === '}') { depth--; continue; }
    if (depth > 0) continue;
    if (c === '>') break;
    if (/[\w$-]/.test(c)) { tok += c; continue; }
    if (tok && (c === '=' || /[\s/]/.test(c))) names.push(tok);
    tok = '';
  }
  return names;
}

function undeclaredProps(src) {
  const out = [];
  for (const [name, declared] of signatures(src)) {
    for (const m of src.matchAll(new RegExp(`<${name}(?=[\\s/>])`, 'g'))) {
      for (const a of attrNames(src, m.index + name.length + 1)) {
        if (a !== 'key' && !declared.has(a)) out.push(`<${name} ${a}=…> (line ${src.slice(0, m.index).split('\n').length})`);
      }
    }
  }
  return out;
}

test('the scan sees props (sanity: it finds a planted dead prop)', () => {
  const planted = 'function Foo({a,b=2,label}) { return null; }\nconst x=<Foo a={1} label="two words" b={{c:1}} ghost={3}/>;\n';
  assert.deepEqual(undeclaredProps(planted), ['<Foo ghost=…> (line 2)']);
  assert.ok(signatures(dash).size > 10, 'the signature scan found too few components — has the declaration style changed?');
});

test('no Dashboard.jsx call site passes a prop its component does not declare', () => {
  assert.deepEqual(undeclaredProps(dash), [],
    'a prop the component never destructures is dead: delete it at the call site, or declare it if it is meant to be used');
});
