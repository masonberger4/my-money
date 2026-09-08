// Pure state machine for pull-to-refresh (touch drag + trackpad/mouse wheel).
// Dashboard.jsx (or whatever owns the scroll container) wires this to real
// touch/wheel listeners and a spinner; this module owns the gesture math and
// the double-fire guards so they can be tested in Node without a DOM. No
// imports on purpose — this is a pure model file (see pure-models.md): plain
// data in, `{ progress, shouldTrigger }` out, nothing else touches the world.
//
// Two independent input families feed the SAME trigger/cooldown state:
//   - touch: fires on RELEASE (touchEnd) — the native mobile idiom, you see
//     the indicator fill and let go.
//   - wheel: fires the INSTANT the accumulated pull crosses threshold — there
//     is no "release" event for a wheel/trackpad gesture to hang a trigger on.
// Because a wheel burst can keep sending events long after a fast refresh has
// already resolved (trackpad inertia), triggering is followed by a `quiet`
// window that only wheel input respects; touch is re-armed by the next
// deliberate finger-down instead (see the `quiet` block below).

export const PULL_DEFAULTS = { touchThreshold: 70, wheelThreshold: 120, wheelIdleMs: 250 };
// touchThreshold: ~70px matches the iOS/Android pull-to-refresh convention —
//   roughly half a thumb's travel, far enough that a scroll flick doesn't
//   read as a pull.
// wheelThreshold: ~120px models "two mouse notches inside one idle window."
//   Chrome/Safari report ~100px of deltaY per physical notch, so a single
//   accidental notch shows the indicator at 83% but does not fire; a
//   deliberate two-notch scroll (or ~120px of continuous trackpad travel)
//   does. Tuned to the low end of "clearly on purpose."
// wheelIdleMs: 250ms is about how long it takes trackpad inertia to visibly
//   stop. It does double duty: it's both the "has this gesture stopped"
//   check AND the burst-boundary check used to decide burst-start arming
//   (below) — one clock, two related jobs, so they can't drift apart.

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

export function createPullRefresh(opts = {}) {
  const touchThreshold = opts.touchThreshold ?? PULL_DEFAULTS.touchThreshold;
  const wheelThreshold = opts.wheelThreshold ?? PULL_DEFAULTS.wheelThreshold;
  const wheelIdleMs = opts.wheelIdleMs ?? PULL_DEFAULTS.wheelIdleMs;

  // --- touch state ---
  let armed = false;     // finger went down at the top and hasn't disarmed
  let startY = 0;        // y at touchStart, for delta math
  let touchProgress = 0; // last progress computed by touchMove (touchEnd has no y of its own)

  // --- wheel state ---
  let lastWheelAt = null; // timestamp of the previous wheel event (null = no burst yet)
  let burstArmed = false; // whether the CURRENT burst was armed at ITS start
  let acc = 0;             // accumulated -deltaY within the current armed burst

  // --- shared double-fire guard ---
  let cooldown = false; // a trigger has fired and settle() hasn't cleared it yet
  let quiet = false;    // wheel-only: absorbs inertia tail after a trigger (see below)

  // A trigger is the one moment both input paths converge on. It resets
  // every per-gesture accumulator so the next gesture starts clean, and it
  // sets BOTH guards: cooldown (cleared explicitly by settle(), once the
  // caller's refresh actually finishes loading) and quiet (cleared only by a
  // fresh wheel burst that starts after cooldown is already off — see wheel()).
  function trigger() {
    cooldown = true;
    quiet = true;
    armed = false;
    touchProgress = 0;
    burstArmed = false;
    acc = 0;
    return { progress: 0, shouldTrigger: true };
  }

  // "At top" is scrollY <= 0, deliberately not === 0: iOS reports a NEGATIVE
  // scrollY while the page is rubber-banding above its own top, and a strict
  // === 0 check makes the gesture go dead exactly where it feels most natural
  // to pull (mid rubber-band), which is the one place users actually try it.
  const atTop = (scrollY) => scrollY <= 0;

  return {
    touchStart({ y, scrollY, blocked }) {
      // Arm only on a clean start: not mid some other blocking interaction,
      // not still cooling down from the last trigger, and at the top.
      // Cooldown DOES gate touch here (unlike quiet, which never does) —
      // that's the whole point of cooldown: no second trigger before the
      // in-flight refresh has settled, regardless of input method.
      if (!blocked && !cooldown && atTop(scrollY)) {
        armed = true;
        startY = y;
        touchProgress = 0;
      } else {
        armed = false;
      }
      return { progress: 0, shouldTrigger: false };
    },

    touchMove({ y, scrollY, blocked }) {
      if (!armed) return { progress: 0, shouldTrigger: false };
      // Any of these mid-gesture means "this isn't a pull anymore": the
      // page scrolled away from the top, something else is blocking, or a
      // trigger elsewhere set cooldown. Disarm rather than clamp to 0-and-
      // stay-armed, so a subsequent move at the top doesn't silently resume
      // a gesture the user's scroll already cancelled.
      if (blocked || cooldown || scrollY > 0) {
        armed = false;
        touchProgress = 0;
        return { progress: 0, shouldTrigger: false };
      }
      touchProgress = clamp01((y - startY) / touchThreshold);
      // touchMove never triggers — only release does (see module comment).
      return { progress: touchProgress, shouldTrigger: false };
    },

    touchEnd() {
      // No-op with nothing armed: e.g. a touchend with no matching start
      // (browser quirk / synthetic event), or a gesture already disarmed by
      // touchMove. Must not throw — callers fire this unconditionally.
      if (!armed) return { progress: 0, shouldTrigger: false };
      const finalProgress = touchProgress;
      armed = false;
      touchProgress = 0;
      if (finalProgress >= 1) return trigger();
      // A release BELOW threshold ends the gesture, so progress goes to 0 and
      // not to wherever the finger stopped. touchend is the LAST event of the
      // gesture — returning the partial value would leave the caller's
      // indicator frozen mid-screen with nothing left to arrive and clear it.
      return { progress: 0, shouldTrigger: false };
    },

    wheel({ deltaY, scrollY, now, blocked }) {
      // A "burst" is a run of wheel events with no gap over wheelIdleMs. We
      // decide burstArmed ONLY at the instant a burst starts, from the
      // blocked/scrollY reading at THAT instant — never re-armed mid-burst.
      // This is what stops a trackpad fling-to-top: one continuous burst
      // that begins deep in the page and only reaches scrollY<=0 partway
      // through must not suddenly start counting once it arrives — the user
      // was scrolling, not pulling, and the burst already answered that
      // question at its first event.
      const isNewBurst = lastWheelAt === null || now - lastWheelAt > wheelIdleMs;
      if (isNewBurst) {
        burstArmed = !blocked && atTop(scrollY);
        acc = 0;
        // quiet only lifts on a fresh burst that starts once cooldown is
        // ALREADY off. If cooldown is still on when a new burst starts, the
        // burst is real but the refresh hasn't settled yet — leave quiet set
        // so nothing here can race settle(); the very next burst after
        // settle() (or this one, if it started after settle()) clears it.
        if (!cooldown) quiet = false;
      }
      lastWheelAt = now;

      // quiet absorbs a trackpad's momentum tail after a trigger: inertia
      // frequently outlives a fast cached refresh, so without this guard the
      // dying tail of the SAME gesture would cross threshold a second time
      // and fire again. It only lifts per the rule above — the user has to
      // let the stream fully stop (a real idle gap) and pull again.
      if (quiet) return { progress: 0, shouldTrigger: false };

      // Burst wasn't armed at its start — every event in it is inert, no
      // matter what scrollY/blocked do later in the same burst.
      if (!burstArmed) return { progress: 0, shouldTrigger: false };

      // Mid-burst cancellation: blocked, still cooling down, scrolled off
      // the top, or scrolling the WRONG way (deltaY >= 0 is a scroll DOWN /
      // away from the pull gesture in wheel terms). Reset the accumulator
      // so resuming the pull afterward starts from zero, not a stale carry.
      if (blocked || cooldown || scrollY > 0 || deltaY >= 0) {
        acc = 0;
        return { progress: 0, shouldTrigger: false };
      }

      acc += -deltaY;
      const progress = Math.min(1, acc / wheelThreshold);
      if (progress >= 1) return trigger();
      return { progress, shouldTrigger: false };
    },

    // The refresh that a trigger started has finished loading. Clears ONLY
    // cooldown — quiet is a separate clock with its own clearing rule (a
    // fresh wheel burst), because inertia can still be arriving after the
    // network call that caused it has long since resolved.
    settle() {
      cooldown = false;
    },

    // Full reset: unmount, or a test wants a clean slate mid-file.
    reset() {
      armed = false;
      startY = 0;
      touchProgress = 0;
      lastWheelAt = null;
      burstArmed = false;
      acc = 0;
      cooldown = false;
      quiet = false;
    },
  };
}
