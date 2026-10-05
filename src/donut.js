// The Home donut's geometry, pure + zero imports. Dashboard's <Donut> only
// renders what this returns, so the arc maths is testable without a DOM.
//
// THE FULL-RING CASE: a lone slice sweeps 0→360°, and an SVG arc from a point
// back to the SAME point is dropped by the renderer (the spec treats coincident
// endpoints as "omit the arc"). The old single-path drawing therefore left an
// empty ring beside a populated legend whenever only one category had spending
// — day one (all Uncategorized), or early in any month. A sweep that is a whole
// turn is returned as a 'ring' (drawn as a stroked <circle>) instead.

const FULL_TURN = 359.999;

export function donutGeometry(size) {
  return { cx: size / 2, cy: size / 2, r: size * 0.38, ir: size * 0.24 };
}

// data: [{ value, color, ... }] (positive values; the caller filters).
// → [] when there is nothing to draw, else one descriptor per slice:
//   { kind:'arc', d, color, start, end }   start/end in degrees, 0 = 12 o'clock
//   { kind:'ring', cx, cy, r, width, color }
export function donutSlices(data, size) {
  const rows = data || [];
  const total = rows.reduce((s, x) => s + x.value, 0);
  if (!total) return [];
  const { cx, cy, r, ir } = donutGeometry(size);
  function arc(s, e, or, ir) {
    const sa = (s - 90) * Math.PI / 180, ea = (e - 90) * Math.PI / 180, lg = e - s > 180 ? 1 : 0;
    const x1 = cx + or * Math.cos(sa), y1 = cy + or * Math.sin(sa), x2 = cx + or * Math.cos(ea), y2 = cy + or * Math.sin(ea);
    const x3 = cx + ir * Math.cos(ea), y3 = cy + ir * Math.sin(ea), x4 = cx + ir * Math.cos(sa), y4 = cy + ir * Math.sin(sa);
    return `M${x1},${y1} A${or},${or} 0 ${lg},1 ${x2},${y2} L${x3},${y3} A${ir},${ir} 0 ${lg},0 ${x4},${y4} Z`;
  }
  let off = 0;
  return rows.map(x => {
    const s = off;
    off += (x.value / total) * 360;
    const e = off;
    if (e - s >= FULL_TURN) return { kind: 'ring', cx, cy, r: (r + ir) / 2, width: r - ir, color: x.color };
    return { kind: 'arc', d: arc(s, e, r, ir), color: x.color, start: s, end: e };
  });
}
