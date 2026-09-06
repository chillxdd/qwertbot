'use strict';
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { collection, WRITE_OPTIONS, isDuplicate } = require('./store');

// Server time determines ownership. A conservative monotonic local deadline
// prevents a stalled event loop or a slow renewal reply from extending a lease.
function createLease({ key, ttlMs = 30000, owner = randomUUID(), getCollection = collection,
  onLost = () => {}, clock = () => performance.now() } = {}) {
  let token = 0;
  let safeUntil = 0;
  let held = false;
  let renewal = null;
  let initialized = false;
  const id = `lease:${key}`;
  const validFilter = () => ({ _id: id, owner, fence: token, $expr: { $gt: ['$expiresAt', '$$NOW'] } });
  function lose() {
    if (!held) return;
    held = false;
    safeUntil = 0;
    onLost();
  }
  function isHeld() {
    if (held && clock() >= safeUntil) lose();
    return held;
  }
  async function acquire() {
    const began = clock();
    let result;
    if (!initialized) {
      try {
        await getCollection().updateOne({ _id: id }, { $setOnInsert: {
          kind: 'lease', owner: '', fence: 0, expiresAt: new Date(0)
        } }, { ...WRITE_OPTIONS, upsert: true });
      } catch (err) { if (!isDuplicate(err)) throw err; }
      initialized = true;
    }
    try {
      result = await getCollection().findOneAndUpdate({ _id: id, $or: [
        { owner }, { $expr: { $lte: [{ $ifNull: ['$expiresAt', new Date(0)] }, '$$NOW'] } }
      ] }, [{ $set: {
        kind: 'lease', owner,
        fence: { $cond: [{ $eq: ['$owner', owner] }, { $ifNull: ['$fence', 0] }, { $add: [{ $ifNull: ['$fence', 0] }, 1] }] },
        heartbeatAt: '$$NOW', expiresAt: { $add: ['$$NOW', ttlMs] }
      } }], { ...WRITE_OPTIONS, returnDocument: 'after', includeResultMetadata: false });
    } catch (err) { if (isDuplicate(err)) return false; throw err; }
    if (!result || clock() >= began + ttlMs - 2000) return false;
    token = result.fence;
    safeUntil = began + ttlMs - 2000;
    held = true;
    return true;
  }
  async function renew() {
    if (renewal) return renewal;
    if (!isHeld()) return false;
    renewal = (async () => {
      const began = clock();
      try {
        const result = await getCollection().findOneAndUpdate(validFilter(), [{ $set: {
          heartbeatAt: '$$NOW', expiresAt: { $add: ['$$NOW', ttlMs] }
        } }], { ...WRITE_OPTIONS, returnDocument: 'after', includeResultMetadata: false });
        if (!result || clock() >= began + ttlMs - 2000) { lose(); return false; }
        safeUntil = began + ttlMs - 2000;
        return true;
      } catch (err) { lose(); throw err; }
      finally { renewal = null; }
    })();
    return renewal;
  }
  async function assertOwned() {
    if (!isHeld()) throw leaseError();
    try {
      const record = await getCollection().findOne(validFilter(), { maxTimeMS: 5000, projection: { _id: 1 } });
      if (!record || !isHeld()) { lose(); throw leaseError(); }
    } catch (err) { lose(); throw err; }
  }
  async function release() {
    held = false;
    safeUntil = 0;
    if (renewal) { try { await renewal; } catch (_) {} }
    await getCollection().updateOne({ _id: id, owner, fence: token }, {
      $set: { owner: '', expiresAt: new Date(0) }
    }, WRITE_OPTIONS);
  }
  return { acquire, renew, release, assertOwned, isHeld, lose, get fence() { return token; }, owner, id };
}
function leaseError() {
  const err = new Error('This instance no longer owns the bot lease; work was stopped to prevent duplicates.');
  err.cancelled = true;
  err.retryable = false;
  err.deliveryState = 'NOT_SENT';
  return err;
}
module.exports = { createLease, leaseError };
