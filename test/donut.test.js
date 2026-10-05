// The Home donut's geometry (src/donut.js). The bug this exists for: a month
// with ONE category drew nothing, because a single 0→360° slice is an SVG arc
// whose endpoints coincide, and the renderer drops such an arc. A whole turn
// must come back as a ring the component draws as a stroked circle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { donutSlices, donutGeometry } from '../src/donut.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 130;

// The outer arc's start and end points out of a path's `d`.
function outerEnds(d) {
  const m = d.match(/^M([^,]+),(\S+) A\S+ 0 [01],1 ([^,]+),(\S+) L/);
  assert.ok(m, `unparsed path: ${d}`);
  return m.slice(1, 5).map(Number);
}
const f32 = Math.fround;

test('why: a whole-turn arc has endpoints that coincide once the renderer parses them', () => {
  // Same maths the old <Donut> used for a lone slice (0→360°).
  const { cx, cy, r } = donutGeometry(SIZE);
  const at = deg => [cx + r * Math.cos((deg - 90) * Math.PI / 180), cy + r * Math.sin((deg - 90) * Math.PI / 180)];
  const [x1, y1] = at(0), [x2, y2] = at(360);
  assert.ok(f32(x1) === f32(x2) && f32(y1) === f32(y2), 'start and end are the same float32 point → arc dropped');
});

test('REGRESSION: a single category is a full RING, not an arc the renderer drops', () => {
  const out = donutSlices([{ value: 100, color: '#123456' }], SIZE);
  const { r, ir, cx, cy } = donutGeometry(SIZE);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'ring');
  assert.equal(out[0].color, '#123456');
  assert.equal(out[0].cx, cx);
  assert.equal(out[0].cy, cy);
  assert.ok(out[0].r > ir && out[0].r < r, 'centred in the band');
  assert.ok(Math.abs(out[0].r - out[0].width / 2 - ir) < 1e-9, 'inner edge at ir');
  assert.ok(Math.abs(out[0].r + out[0].width / 2 - r) < 1e-9, 'outer edge at r');
});

test('two halves are two arcs that cover the circle with distinct endpoints', () => {
  const out = donutSlices([{ value: 50, color: 'a' }, { value: 50, color: 'b' }], SIZE);
  assert.deepEqual(out.map(s => s.kind), ['arc', 'arc']);
  const sweep = out.reduce((s, x) => s + (x.end - x.start), 0);
  assert.ok(Math.abs(sweep - 360) < 1e-9, 'sweeps add up to a whole turn');
  for (const s of out) {
    const [x1, y1, x2, y2] = outerEnds(s.d);
    assert.ok(Math.hypot(f32(x1) - f32(x2), f32(y1) - f32(y2)) > 1e-3, 'endpoints are distinct after float32');
  }
  assert.equal(out[0].color, 'a');
  assert.equal(out[1].color, 'b');
});

test('a lopsided 99.9 / 0.1 split still draws two arcs (the ring threshold is not loose)', () => {
  const out = donutSlices([{ value: 999, color: 'a' }, { value: 1, color: 'b' }], SIZE);
  assert.deepEqual(out.map(s => s.kind), ['arc', 'arc']);
  assert.ok(out[0].d.includes(' 0 1,1 '), 'the big slice takes the large-arc flag');
});

test('nothing to draw → [] (the component shows its placeholder)', () => {
  assert.deepEqual(donutSlices([], SIZE), []);
  assert.deepEqual(donutSlices(null, SIZE), []);
  assert.deepEqual(donutSlices([{ value: 0, color: 'a' }], SIZE), []);
});

test('Dashboard\'s Donut renders the ring kind as a stroked circle', () => {
  const dash = readFileSync(join(root, 'src/components/Dashboard.jsx'), 'utf8');
  const start = dash.indexOf('function Donut(');
  const body = dash.slice(start, dash.indexOf('\n}\n', start));
  assert.ok(start > 0, 'Donut exists');
  assert.match(body, /donutSlices\(data,size\)/, 'geometry comes from src/donut.js');
  assert.match(body, /kind==="ring"[\s\S]*<circle[^>]*fill="none"[^>]*stroke=\{s\.color\}[^>]*strokeWidth=\{s\.width\}/);
  assert.doesNotMatch(body, /function arc\(/, 'no second copy of the arc maths');
});
