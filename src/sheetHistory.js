// Pure state machine for the "back gesture closes the open sheet" history
// entry (backlog Session B item 4). Dashboard.jsx wires it to window.history;
// this module owns the invariants so they can be tested in Node:
//
// - ONE {mmSheet:true} entry exists while any overlay is open; stacked sheets
//   share it (one back-swipe dismisses the stack, matching the overlay
//   tap-out).
// - Closing by tap/Escape consumes the entry with back(). back()'s popstate is
//   ASYNCHRONOUS, so a `pendingBack` flag marks the in-flight traversal:
//   a sheet opened before it lands must NOT push (the push would race the
//   traversal and desync the stack), and the consumed entry's popstate must
//   NOT close the just-opened sheet. When that popstate arrives, the deferred
//   push happens then — history and flags stay in lockstep.
// - A page reload with a sheet open strands the pushed entry (refs reset,
//   the entry survives): onMount sees state.mmSheet and consumes it with one
//   back(), so the user's first back gesture isn't a dead press.
// - push/back are injected and every call is try/caught here (iOS standalone
//   PWAs have been quirky about history; a failure just means the old
//   do-nothing swipe, never a crash or a stuck flag).
export function createSheetHistory({ push, back }) {
  let entry = false;       // our {mmSheet:true} entry is on top of history
  let pendingBack = false; // we issued back() and its popstate hasn't landed

  const doPush = () => {
    try { push(); entry = true; } catch { /* history unavailable */ }
  };
  const doBack = () => {
    pendingBack = true;
    try { back(); } catch { pendingBack = false; }
  };

  return {
    // Call once with history.state at mount time.
    onMount(state) {
      if (state && state.mmSheet) doBack();
    },
    // Call whenever the any-sheet-open boolean changes (or re-renders — idempotent).
    onSheetsChange(open) {
      if (open && !entry && !pendingBack) doPush();
      else if (!open && entry) { entry = false; doBack(); }
    },
    // Call on every popstate with the CURRENT any-sheet-open boolean.
    // Returns true when the pop is an organic back gesture that should close
    // every overlay; false when it's our own consumed entry (or not ours).
    onPop(open) {
      if (pendingBack) {
        // The programmatic back() landed. If a sheet opened while it was in
        // flight, its push was deferred to here.
        pendingBack = false;
        if (open && !entry) doPush();
        return false;
      }
      if (!entry) return false; // organic pop, not our entry
      entry = false;
      return true;
    },
  };
}
