import { test } from "node:test";
import assert from "node:assert/strict";
import { createSheetHistory } from "../src/sheetHistory.js";

// Small harness: records push/back calls and lets tests deliver the
// asynchronous popstate for each back() whenever they choose — the whole
// point of the machine is that back()'s popstate does NOT arrive in the same
// task as the call.
function harness() {
  const calls = [];
  const sh = createSheetHistory({
    push: () => calls.push("push"),
    back: () => calls.push("back"),
  });
  return { sh, calls };
}

test("opening the first sheet pushes exactly one entry; stacked sheets share it", () => {
  const { sh, calls } = harness();
  sh.onSheetsChange(true);
  sh.onSheetsChange(true); // tx sheet stacked over a drill-in: still one entry
  assert.deepEqual(calls, ["push"]);
});

test("organic back gesture with a sheet open closes all; entry is consumed", () => {
  const { sh, calls } = harness();
  sh.onSheetsChange(true);
  assert.equal(sh.onPop(true), true); // browser already popped our entry
  assert.deepEqual(calls, ["push"]);
  // Next pop is not ours — no close request.
  assert.equal(sh.onPop(false), false);
});

test("tap/Escape close consumes the entry with back(); its popstate is a no-op", () => {
  const { sh, calls } = harness();
  sh.onSheetsChange(true);
  sh.onSheetsChange(false); // closed by tap → back()
  assert.deepEqual(calls, ["push", "back"]);
  // The programmatic back()'s own popstate lands: must NOT request a close.
  assert.equal(sh.onPop(false), false);
  // And after it, an organic pop is still not ours.
  assert.equal(sh.onPop(false), false);
  assert.deepEqual(calls, ["push", "back"]);
});

// The CONFIRMED race: close a sheet (back() issued), open another sheet
// BEFORE the popstate lands. The old code pushed immediately (racing the
// in-flight traversal) and then the landing popstate flash-closed the
// just-opened sheet. The machine defers the push to the popstate and never
// closes the new sheet.
test("REGRESSION: sheet opened while back() is in flight — push deferred, no flash-close", () => {
  const { sh, calls } = harness();
  sh.onSheetsChange(true);   // push
  sh.onSheetsChange(false);  // back (pending)
  sh.onSheetsChange(true);   // second sheet opened fast — must NOT push yet
  assert.deepEqual(calls, ["push", "back"]);
  // The pending popstate lands with the second sheet open: no close, and the
  // deferred push happens now, restoring the one-entry invariant.
  assert.equal(sh.onPop(true), false);
  assert.deepEqual(calls, ["push", "back", "push"]);
  // From here the normal contract holds: organic pop closes the sheet.
  assert.equal(sh.onPop(true), true);
});

test("pending-back popstate with no sheet open pushes nothing", () => {
  const { sh, calls } = harness();
  sh.onSheetsChange(true);
  sh.onSheetsChange(false);
  assert.equal(sh.onPop(false), false);
  assert.deepEqual(calls, ["push", "back"]);
});

// The CONFIRMED stranded-entry finding: reload with a sheet open leaves the
// {mmSheet:true} entry on top while all flags reset — the first back gesture
// was a dead press. onMount consumes it.
test("REGRESSION: onMount consumes a stranded mmSheet entry from a reload", () => {
  const { sh, calls } = harness();
  sh.onMount({ mmSheet: true });
  assert.deepEqual(calls, ["back"]);
  // Its popstate lands quietly.
  assert.equal(sh.onPop(false), false);
  // Ordinary lifecycle still works afterwards.
  sh.onSheetsChange(true);
  assert.deepEqual(calls, ["back", "push"]);
  assert.equal(sh.onPop(true), true);
});

test("onMount without a stranded entry does nothing", () => {
  const { sh, calls } = harness();
  sh.onMount(null);
  sh.onMount({});
  assert.deepEqual(calls, []);
});

test("sheet opened during the onMount cleanup back() defers its push too", () => {
  const { sh, calls } = harness();
  sh.onMount({ mmSheet: true }); // back pending
  sh.onSheetsChange(true);       // sheet opens before the pop lands
  assert.deepEqual(calls, ["back"]);
  assert.equal(sh.onPop(true), false); // consumed pop → deferred push
  assert.deepEqual(calls, ["back", "push"]);
});

test("push throwing leaves no entry flag; a later pop is not ours", () => {
  const sh = createSheetHistory({
    push: () => { throw new Error("history unavailable"); },
    back: () => { throw new Error("history unavailable"); },
  });
  sh.onSheetsChange(true);      // push throws — swallowed
  assert.equal(sh.onPop(true), false); // no entry recorded, pop not ours
  sh.onSheetsChange(false);     // no entry → no back
});

test("back throwing clears pendingBack so the next open can push", () => {
  let allowPush = true;
  const calls = [];
  const sh = createSheetHistory({
    push: () => { if (!allowPush) throw new Error("no"); calls.push("push"); },
    back: () => { throw new Error("history unavailable"); },
  });
  sh.onSheetsChange(true);
  sh.onSheetsChange(false); // back throws; pendingBack must not stay set
  sh.onSheetsChange(true);  // must push immediately, not wait for a pop that never comes
  assert.deepEqual(calls, ["push", "push"]);
});
