// makeSerializedUpdater — the ONE read-merge-write promise-chain discipline,
// extracted from the byte-for-byte twins updateRecIgnore / updateSavedChats in
// dataAdapter.js (a third hand copy that forgets the `.catch(() => {})` dams
// the queue after one network blip — this helper is why there is no third
// copy).
//
// Invariants every site relies on (see the updateRecIgnore comment block in
// dataAdapter.js for the full incident history):
//   - A failed READ aborts before any write: `read()` throwing means `write`
//     is never called, so a network blip can't let a rebuilt/empty value wipe
//     the other phone's data.
//   - SAME-DEVICE updates are SERIALIZED: two quick calls run strictly in
//     order, so the second's read sees the first's committed write instead of
//     interleaving (read A, read B, write A, write B) and dropping A's change.
//   - One failed update never dams the queue: the internal chain swallows
//     rejections (`.catch(() => {})`), while each CALLER still receives the
//     real rejection from its own returned promise.
//   - The returned promise resolves with the MERGED value that was written,
//     so callers can adopt entries the other phone added since their last
//     read. The cross-device race stays the accepted last-write-wins.
//
// Pure module, zero imports — dataAdapter binds the real read/write.

/**
 * @param {() => Promise<any>} read   fetch the current stored value
 * @param {(next: any) => Promise<void>} write  persist the merged value
 * @returns {(merge: (current: any) => any) => Promise<any>}
 *   update(merge): queue one read-merge-write; resolves with the value written.
 */
export function makeSerializedUpdater(read, write) {
  let chain = Promise.resolve();
  return function update(merge) {
    const run = chain.then(async () => {
      const current = await read();
      const next = await merge(current);
      await write(next);
      return next;
    });
    chain = run.catch(() => {});
    return run;
  };
}
