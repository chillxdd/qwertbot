'use strict';
// Each caller waits for ITS snapshot, not merely for an older in-flight write.
// Rejection is returned to the caller, while the internal tail remains usable.
function createSerialWriter(write) {
  let tail = Promise.resolve();
  let latest = tail;
  let pending = 0;
  function save(snapshot) {
    const immutable = structuredClone(snapshot);
    pending += 1;
    const result = tail.then(() => write(immutable));
    latest = result;
    tail = result.catch(() => {}).finally(() => { pending -= 1; });
    return result;
  }
  return { save, flush: () => latest, get pending() { return pending; } };
}
function createSerialExecutor() {
  let tail = Promise.resolve();
  return (fn) => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
}
module.exports = { createSerialWriter, createSerialExecutor };
