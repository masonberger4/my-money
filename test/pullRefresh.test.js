import { test } from "node:test";
import assert from "node:assert/strict";
import { createPullRefresh, PULL_DEFAULTS } from "../src/pullRefresh.js";

// Manual clock: every test advances time explicitly so gap/idle math (the
// whole point of the wheel burst logic) is never left to wall-clock luck.
function clock(start = 0) {
  let t = start;
  return { now: () => t, tick: (ms) => (t += ms) };
}

test("touch: pull past threshold and release triggers, clamped at 1", () => {
  const pr = createPullRefresh();
  const c = clock();
  assert.deepEqual(pr.touchStart({ y: 100, scrollY: 0, now: c.now(), blocked: false }), {
    progress: 0,
    shouldTrigger: false,
  });
  assert.deepEqual(pr.touchMove({ y: 135, scrollY: 0, now: c.tick(16), blocked: false }), {
    progress: 0.5,
    shouldTrigger: false,
  });
  assert.deepEqual(pr.touchMove({ y: 180, scrollY: 0, now: c.tick(16), blocked: false }), {
    progress: 1, // clamped — (180-100)/70 > 1
    shouldTrigger: false,
  });
  assert.deepEqual(pr.touchEnd({ now: c.tick(16) }), { progress: 0, shouldTrigger: true });
});

test("touch: released under threshold does not trigger", () => {
  const pr = createPullRefresh();
  const c = clock();
  pr.touchStart({ y: 100, scrollY: 0, now: c.now(), blocked: false });
  const move = pr.touchMove({ y: 140, scrollY: 0, now: c.tick(16), blocked: false });
  assert.ok(move.progress < 1 && move.progress > 0);
  // Progress returns to 0, not to where the finger stopped: touchend is the
  // last event of the gesture, so a partial value would strand the indicator
  // on screen with nothing left to arrive and clear it.
  assert.deepEqual(pr.touchEnd({ now: c.tick(16) }), { progress: 0, shouldTrigger: false });
});

test("touchStart off the top never arms — moves and end stay inert", () => {
  const pr = createPullRefresh();
  const c = clock();
  pr.touchStart({ y: 100, scrollY: 120, now: c.now(), blocked: false });
  assert.deepEqual(pr.touchMove({ y: 200, scrollY: 120, now: c.tick(16), blocked: false }), {
    progress: 0,
    shouldTrigger: false,
  });
  assert.deepEqual(pr.touchEnd({ now: c.tick(16) }), { progress: 0, shouldTrigger: false });
});

test("touch disarms mid-gesture once the page scrolls away from the top", () => {
  const pr = createPullRefresh();
  const c = clock();
  pr.touchStart({ y: 100, scrollY: 0, now: c.now(), blocked: false });
  pr.touchMove({ y: 130, scrollY: 0, now: c.tick(16), blocked: false }); // armed, mid-pull
  assert.deepEqual(pr.touchMove({ y: 140, scrollY: 30, now: c.tick(16), blocked: false }), {
    progress: 0,
    shouldTrigger: false,
  });
  // Still disarmed even if a later move reports back at the top.
  assert.deepEqual(pr.touchMove({ y: 200, scrollY: 0, now: c.tick(16), blocked: false }), {
    progress: 0,
    shouldTrigger: false,
  });
  assert.deepEqual(pr.touchEnd({ now: c.tick(16) }), { progress: 0, shouldTrigger: false });
});

test("blocked suppresses both touch arming and wheel accumulation", () => {
  const pr = createPullRefresh();
  const c = clock();
  pr.touchStart({ y: 100, scrollY: 0, now: c.now(), blocked: true });
  assert.deepEqual(pr.touchMove({ y: 200, scrollY: 0, now: c.tick(16), blocked: true }), {
    progress: 0,
    shouldTrigger: false,
  });
  assert.deepEqual(pr.touchEnd({ now: c.tick(16) }), { progress: 0, shouldTrigger: false });

  assert.deepEqual(pr.wheel({ deltaY: -80, scrollY: 0, now: c.tick(16), blocked: true }), {
    progress: 0,
    shouldTrigger: false,
  });
  assert.deepEqual(pr.wheel({ deltaY: -80, scrollY: 0, now: c.tick(16), blocked: true }), {
    progress: 0,
    shouldTrigger: false,
  });
});

test("wheel: three notches inside the idle window accumulate and trigger on the third", () => {
  const pr = createPullRefresh();
  const c = clock();
  const r1 = pr.wheel({ deltaY: -50, scrollY: 0, now: c.now(), blocked: false });
  assert.ok(Math.abs(r1.progress - 50 / 120) < 1e-9);
  assert.equal(r1.shouldTrigger, false);
  const r2 = pr.wheel({ deltaY: -50, scrollY: 0, now: c.tick(50), blocked: false });
  assert.ok(Math.abs(r2.progress - 100 / 120) < 1e-9);
  assert.equal(r2.shouldTrigger, false);
  const r3 = pr.wheel({ deltaY: -50, scrollY: 0, now: c.tick(50), blocked: false });
  assert.deepEqual(r3, { progress: 0, shouldTrigger: true }); // 150 > 120 → trigger, progress zeroed
});

test("wheel: an idle gap over wheelIdleMs starts a fresh burst and restarts the accumulator", () => {
  const pr = createPullRefresh();
  const c = clock();
  const r1 = pr.wheel({ deltaY: -100, scrollY: 0, now: c.now(), blocked: false });
  assert.equal(r1.shouldTrigger, false);
  // 300ms > wheelIdleMs (250ms): new burst, accumulator restarts at 50, not 150.
  const r2 = pr.wheel({ deltaY: -50, scrollY: 0, now: c.tick(300), blocked: false });
  assert.ok(Math.abs(r2.progress - 50 / 120) < 1e-9);
  assert.equal(r2.shouldTrigger, false);
});

test("wheel: a positive deltaY (scroll down) mid-burst resets the accumulator", () => {
  const pr = createPullRefresh();
  const c = clock();
  pr.wheel({ deltaY: -80, scrollY: 0, now: c.now(), blocked: false }); // acc=80
  const reset = pr.wheel({ deltaY: 20, scrollY: 0, now: c.tick(16), blocked: false });
  assert.deepEqual(reset, { progress: 0, shouldTrigger: false });
  // Same burst (no idle gap) continues from the reset accumulator, not 80+.
  const r = pr.wheel({ deltaY: -50, scrollY: 0, now: c.tick(16), blocked: false });
  assert.ok(Math.abs(r.progress - 50 / 120) < 1e-9);
});

// The CONFIRMED fling-to-top bug: a trackpad fling that starts mid-page and
// carries the page up to scrollY 0 is ONE continuous burst (gaps well under
// wheelIdleMs throughout). Arming is decided only at the burst's first
// event, at scrollY 400 — off the top — so it must stay unarmed for the rest
// of the burst even once scrollY reaches 0, or every fling-to-top would
// accidentally trigger a refresh nobody asked for.
test("REGRESSION: a burst that starts off the top never triggers, even after scrollY reaches 0", () => {
  const pr = createPullRefresh();
  const c = clock();
  let scrollY = 400;
  // Burst starts off the top.
  let last = pr.wheel({ deltaY: -40, scrollY, now: c.now(), blocked: false });
  assert.equal(last.shouldTrigger, false);
  // scrollY falls to 0 across the same burst (16ms cadence, well under 250ms).
  while (scrollY > 0) {
    scrollY = Math.max(0, scrollY - 40);
    last = pr.wheel({ deltaY: -40, scrollY, now: c.tick(16), blocked: false });
    assert.equal(last.shouldTrigger, false);
  }
  // Now at scrollY 0, still the SAME burst: ten more pulls, never triggers.
  for (let i = 0; i < 10; i++) {
    last = pr.wheel({ deltaY: -30, scrollY: 0, now: c.tick(16), blocked: false });
    assert.equal(last.shouldTrigger, false);
    assert.equal(last.progress, 0);
  }
});

// The CONFIRMED inertia double-fire bug: trackpad momentum keeps sending
// wheel events after the triggered refresh has already resolved and
// settle() has run. Those events are the tail of the SAME burst (gaps under
// wheelIdleMs), so `quiet` must hold through all of them; only a genuine
// idle gap (a new burst) after cooldown is off lifts it.
test("REGRESSION: inertia tail after a trigger does not double-fire", () => {
  const pr = createPullRefresh();
  const c = clock();
  pr.wheel({ deltaY: -60, scrollY: 0, now: c.now(), blocked: false });
  const t2 = pr.wheel({ deltaY: -70, scrollY: 0, now: c.tick(16), blocked: false });
  assert.deepEqual(t2, { progress: 0, shouldTrigger: true }); // 130 > 120

  c.tick(100);
  pr.settle(); // refresh resolved quickly; cooldown clears, quiet does not

  // 600ms of inertia tail at 16ms cadence — every gap is well under
  // wheelIdleMs, so this is all still the triggering burst.
  for (let elapsed = 0; elapsed < 600; elapsed += 16) {
    const r = pr.wheel({ deltaY: -40, scrollY: 0, now: c.tick(16), blocked: false });
    assert.equal(r.shouldTrigger, false);
  }

  // A real idle gap (>250ms) finally ends the burst. cooldown is already
  // off, so this fresh burst clears `quiet` and a full pull now fires.
  const after = pr.wheel({ deltaY: -130, scrollY: 0, now: c.tick(300), blocked: false });
  assert.deepEqual(after, { progress: 0, shouldTrigger: true });
});

test("cooldown blocks a fresh touch pull until settle() clears it", () => {
  const pr = createPullRefresh();
  const c = clock();
  pr.touchStart({ y: 0, scrollY: 0, now: c.now(), blocked: false });
  pr.touchMove({ y: 200, scrollY: 0, now: c.tick(16), blocked: false });
  const first = pr.touchEnd({ now: c.tick(16) });
  assert.equal(first.shouldTrigger, true);

  // Cooldown is on: touchStart itself refuses to arm, so the full pull below
  // is inert end to end.
  pr.touchStart({ y: 0, scrollY: 0, now: c.tick(16), blocked: false });
  pr.touchMove({ y: 200, scrollY: 0, now: c.tick(16), blocked: false });
  const duringCooldown = pr.touchEnd({ now: c.tick(16) });
  assert.equal(duringCooldown.shouldTrigger, false);

  pr.settle();

  // Same pull now goes through.
  pr.touchStart({ y: 0, scrollY: 0, now: c.tick(16), blocked: false });
  pr.touchMove({ y: 200, scrollY: 0, now: c.tick(16), blocked: false });
  const afterSettle = pr.touchEnd({ now: c.tick(16) });
  assert.equal(afterSettle.shouldTrigger, true);
});

test("negative scrollY (rubber-band) counts as at-top for touch start and wheel burst start", () => {
  const pr = createPullRefresh();
  const c = clock();
  pr.touchStart({ y: 100, scrollY: -12, now: c.now(), blocked: false });
  const move = pr.touchMove({ y: 150, scrollY: -12, now: c.tick(16), blocked: false });
  assert.ok(move.progress > 0); // armed, not dead

  const pr2 = createPullRefresh();
  const w = pr2.wheel({ deltaY: -130, scrollY: -12, now: c.now(), blocked: false });
  assert.deepEqual(w, { progress: 0, shouldTrigger: true }); // burst armed at a negative scrollY
});

test("touchEnd with nothing armed is a no-op and does not throw", () => {
  const pr = createPullRefresh();
  assert.doesNotThrow(() => {
    const r = pr.touchEnd({ now: 0 });
    assert.deepEqual(r, { progress: 0, shouldTrigger: false });
  });
});

test("custom thresholds from opts are honoured; PULL_DEFAULTS is unchanged by them", () => {
  const pr = createPullRefresh({ touchThreshold: 10, wheelThreshold: 20, wheelIdleMs: 1000 });
  const c = clock();
  pr.touchStart({ y: 0, scrollY: 0, now: c.now(), blocked: false });
  // With the default 70px threshold this would be far short of 1; with the
  // custom 10px threshold it's already clamped.
  assert.deepEqual(pr.touchMove({ y: 15, scrollY: 0, now: c.tick(16), blocked: false }), {
    progress: 1,
    shouldTrigger: false,
  });

  assert.deepEqual(PULL_DEFAULTS, { touchThreshold: 70, wheelThreshold: 120, wheelIdleMs: 250 });
});
