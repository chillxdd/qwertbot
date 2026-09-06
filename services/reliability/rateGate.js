'use strict';
const { createHash } = require('node:crypto');
const { collection, WRITE_OPTIONS, isDuplicate } = require('./store');
const context = require('./context');
// A server-time rolling window survives a deployment and coordinates channels
// that share a Gemini key. No key/credential is stored in this collection.
function createRateGate({ key, getCollection = collection, limit = 15, windowMs = 60000 } = {}) {
  const id = `gemini-rate:${createHash('sha256').update(String(key)).digest('hex')}`;
  let initialized = false;
  async function ensure() {
    if (initialized) return;
    try {
      await getCollection().updateOne({ _id: id }, { $setOnInsert: {
        kind: 'rate', starts: [], nextAt: new Date(0), backoffUntil: new Date(0)
      } }, { ...WRITE_OPTIONS, upsert: true });
    } catch (err) { if (!isDuplicate(err)) throw err; }
    initialized = true;
  }
  const recent = { $filter: { input: { $ifNull: ['$starts', []] }, as: 't',
    cond: { $gt: ['$$t', { $subtract: ['$$NOW', windowMs] }] } } };
  async function tryReserve(spacingMs = 4000) {
    await ensure();
    const row = await getCollection().findOneAndUpdate({ _id: id, $expr: { $and: [
      { $lte: ['$nextAt', '$$NOW'] }, { $lte: ['$backoffUntil', '$$NOW'] },
      { $lt: [{ $size: recent }, limit] }
    ] } }, [{ $set: { starts: { $concatArrays: [recent, ['$$NOW']] },
      nextAt: { $add: ['$$NOW', Math.max(4000, spacingMs)] }, updatedAt: '$$NOW' } }],
    { ...WRITE_OPTIONS, returnDocument: 'after', includeResultMetadata: false });
    return Boolean(row);
  }
  async function reserve({ spacingMs = 4000, deadlineAt = 0, signal } = {}) {
    for (;;) {
      context.throwIfCancelled();
      if (signal?.aborted) throw context.cancelledError();
      if (deadlineAt && Date.now() >= deadlineAt) {
        const err = new Error('Gemini request could not start before its shared-rate deadline.');
        err.queueDeadline = true; err.retryable = false; throw err;
      }
      await context.assertOperation();
      if (await tryReserve(spacingMs)) return;
      await context.sleep(250, signal);
    }
  }
  async function backoff(delayMs) {
    if (!(delayMs > 0)) return;
    await ensure();
    await getCollection().updateOne({ _id: id }, [{ $set: {
      backoffUntil: { $max: ['$backoffUntil', { $add: ['$$NOW', delayMs] }] }
    } }], WRITE_OPTIONS);
  }
  return { reserve, backoff, tryReserve };
}
module.exports = { createRateGate };
