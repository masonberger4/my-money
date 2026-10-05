// Keyboard and screen-reader hints on Dashboard.jsx inputs and steppers —
// attribute-level a11y that only a source scan can reach (no DOM harness).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dash = readFileSync(new URL('../src/components/Dashboard.jsx', import.meta.url), 'utf8');

// The opening tag of the first <input …/> whose text contains `marker`.
function inputTag(marker) {
  const at = dash.indexOf(marker);
  assert.ok(at > 0, `${marker} moved — update this test's anchor`);
  const start = dash.lastIndexOf('<input', at);
  return dash.slice(start, dash.indexOf('/>', at));
}

// Return on the iPhone keyboard did nothing in the Spending search (no form,
// no handler), so the keyboard sat over the results; autocorrect rewrote
// bank shorthand. Blur-on-Enter only dismisses the keyboard — it writes no
// search state — and the autoFocus gate (the Refine invariant) is untouched.
test('the Spending search input: search key, no autocorrect, Return dismisses', () => {
  const tag = inputTag('placeholder="Search all transactions…"');
  assert.match(tag, /enterKeyHint="search"/);
  assert.match(tag, /autoCorrect="off"/);
  assert.match(tag, /autoCapitalize="off"/);
  assert.match(tag, /spellCheck=\{false\}/);
  assert.match(tag, /onKeyDown=\{e=>\{if\(e\.key==="Enter"\)e\.currentTarget\.blur\(\);\}\}/);
  assert.match(tag, /autoFocus=\{!searchActive\}/, 'the autoFocus gate must stay exactly as it was');
});

test('the Ask chat input labels its Return key "send"', () => {
  const tag = inputTag('value={chatInput}');
  assert.match(tag, /enterKeyHint="send"/);
});

// VoiceOver reads a bare ‹/› as a glyph (a title doesn't name a button that
// has text content). Every button whose whole label is ‹ or › must carry an
// aria-label — the tax-year pair was the odd one out next to the month and
// year pickers, and the account page's back button had only a title.
test('every ‹ / › stepper button has an aria-label', () => {
  // Anchor on the glyph+close, then walk back to the tag's start (an
  // attribute-regex can't span `=>` inside onClick).
  const buttons = [...dash.matchAll(/>\s*[‹›]\s*<\/button>/g)]
    .map(m => dash.slice(dash.lastIndexOf('<button', m.index), m.index + 1));
  assert.ok(buttons.length >= 8, `expected the month, year and tax-year steppers and the back buttons, found ${buttons.length}`);
  for (const b of buttons) assert.match(b, /aria-label="[^"]+"/, `unlabelled stepper: ${b.slice(0, 120)}`);
});
