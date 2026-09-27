'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { collection, WRITE_OPTIONS, isDuplicate } = require('./store');
const context = require('./context');
const { staleDeliveryReason } = require('./recoveryScope');
const idFor = (key) => `delivery:${createHash('sha256').update(String(key)).digest('hex')}`;
function unknownError(key, cause) {
  const err = new Error(`Delivery needs review; it may already have reached Twitch. No automatic resend. (${key})`, { cause });
  err.deliveryState = 'UNKNOWN';
  err.deliveryKey = key;
  err.reviewRequired = true;
  err.retryable = false;
  return err;
}
function createDeliveryService({ getCollection = collection, guard = context.assertOperation } = {}) {
  const inFlight = new Map();
  async function get(key) { return getCollection().findOne({ _id: idFor(key) }, { maxTimeMS: 5000 }); }
  async function performDelivery({ key, kind = 'message', payload = {}, send }) {
    await guard();
    const db = getCollection();
    const id = idFor(key);
    let row;
    try {
      row = await db.findOneAndUpdate({ _id: id }, { $setOnInsert: {
        kind: 'delivery', deliveryKind: kind,
        ...(context.current().recoveryScope || {}), namespace: String(process.env.TWITCH_CHANNEL || payload.channelName || payload.channel || '').replace(/^#/, '').toLowerCase(), key, payload, state: 'prepared', attempts: 0, createdAt: new Date()
      } }, { ...WRITE_OPTIONS, upsert: true, returnDocument: 'after', includeResultMetadata: false });
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      row = await get(key);
    }
    if (row?.recoveryClosed) throw context.cancelledError('This delivery was dismissed or expired; it will not be resent.');
    if (row?.state === 'sent') return { result: row.result, payload: row.payload, replayed: true, key };
    if (!row || !['prepared', 'not_sent'].includes(row.state)) throw unknownError(key);
    const attemptId = randomUUID();
    let claimed;
    try { claimed = await db.findOneAndUpdate({ _id: id, recoveryClosed: { $ne: true }, state: { $in: ['prepared', 'not_sent'] } }, {
      $set: { state: 'sending', attemptId, updatedAt: new Date(), fence: context.fence() }, $inc: { attempts: 1 },
      $unset: { purgeAt: '' }
    }, { ...WRITE_OPTIONS, returnDocument: 'after', includeResultMetadata: false });
    } catch (err) {
      // No wire request has started. An acknowledgement of the claim itself can
      // be lost, but it is safe to release only THIS attempt's claim.
      try { await db.updateOne({ _id: id, attemptId, state: 'sending' }, {
        $set: { state: 'not_sent', updatedAt: new Date() }
      }, WRITE_OPTIONS); } catch (_) { /* Remaining 'sending' needs review. */ }
      err.persistenceFailure = true; err.deliveryState = 'NOT_SENT'; throw err;
    }
    if (!claimed) throw unknownError(key);
    let dispatched = false;
    let result;
    try {
      await guard();
      dispatched = true;
      result = await context.withoutDeliveryScope(() => send(claimed.payload));
    } catch (err) {
      const definitelyNotSent = !dispatched || err?.deliveryState === 'NOT_SENT';
      try {
        await db.updateOne({ _id: id, attemptId, state: 'sending' }, { $set: {
          state: definitelyNotSent ? 'not_sent' : 'unknown', updatedAt: new Date(),
          lastError: String(err?.message || err).slice(0, 600)
        } }, WRITE_OPTIONS);
      } catch (_) { /* A surviving 'sending' record is deliberately quarantined. */ }
      if (!definitelyNotSent) throw unknownError(key, err);
      throw err;
    }
    try {
      const saved = await db.updateOne({ _id: id, attemptId, state: 'sending' }, { $set: {
        state: 'sent', result: result == null ? null : JSON.parse(JSON.stringify(result)),
        updatedAt: new Date(), sentAt: new Date(), purgeAt: new Date(Date.now() + 90 * 86400000)
      } }, WRITE_OPTIONS);
      if (saved.matchedCount !== 1) throw new Error('Delivery receipt was not committed.');
    } catch (err) {
      const ambiguous = unknownError(key, err);
      ambiguous.sentInThisProcess = true;
      ambiguous.receipt = result;
      throw ambiguous;
    }
    return { result, payload: claimed.payload, replayed: false, key };
  }
  function deliver(options) {
    if (!options?.key || typeof options.send !== 'function') throw new Error('A delivery key and send function are required.');
    if (inFlight.has(options.key)) return inFlight.get(options.key);
    const promise = performDelivery(options).finally(() => { inFlight.delete(options.key); });
    inFlight.set(options.key, promise);
    return promise;
  }
  async function resolve(key, outcome) {
    if (!['sent', 'not_sent'].includes(outcome)) throw new Error('Invalid delivery resolution.');
    await guard();
    if (inFlight.has(key)) throw new Error('This delivery is still in flight. Wait until the operation has stopped before reviewing it.');
    const existing = await get(key);
    if (inFlight.has(key)) throw new Error('This delivery is still in flight.');
    // Retrying a review whose acknowledgement was lost is safe and idempotent.
    if (existing?.recoveryClosed) return null;
    if (existing?.state === outcome) return existing;
    return getCollection().findOneAndUpdate({ _id: idFor(key), recoveryClosed: { $ne: true }, state: { $in: ['sending', 'unknown'] } }, {
      $set: { state: outcome, reviewedAt: new Date(), updatedAt: new Date() }
    }, { ...WRITE_OPTIONS, returnDocument: 'after', includeResultMetadata: false });
  }
  function closurePatch(reason, resolution = 'dismissed') {
    return { recoveryClosed: true, recoveryResolution: resolution,
      recoveryClosedAt: new Date(), recoveryReason: String(reason || '').slice(0, 600),
      // Keep the actual sent/unknown/not_sent receipt state; closing recovery
      // is NOT evidence that the remote service received (or missed) the send.
      purgeAt: new Date(Date.now() + 90 * 86400000), updatedAt: new Date() };
  }
  async function dismiss(key, { reason = 'Dismissed by a moderator; do not resend.', resolution = 'dismissed' } = {}) {
    await guard();
    if (inFlight.has(key)) throw new Error('This delivery is still in flight. Wait for it to stop before dismissing it.');
    const existing = await get(key);
    if (!existing) throw new Error('Delivery record not found. Refresh the recovery queue.');
    if (existing.recoveryClosed) return existing;
    if (inFlight.has(key)) throw new Error('This delivery is still in flight.');
    return getCollection().findOneAndUpdate({ _id: idFor(key), state: existing.state, recoveryClosed: { $ne: true } },
      { $set: closurePatch(reason, resolution) },
      { ...WRITE_OPTIONS, returnDocument: 'after', includeResultMetadata: false });
  }
  async function closeEventReceipts(namespace, job, reason, resolution = 'expired') {
    await guard();
    const prefix = `event:${namespace}:${job.messageId}:`;
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return getCollection().updateMany({ namespace, kind: 'delivery', recoveryClosed: { $ne: true },
      $or: [{ parentEventId: job._id }, { key: { $regex: `^${escaped}` } }]
    }, { $set: closurePatch(reason, resolution) }, WRITE_OPTIONS);
  }
  async function expireStale(namespace, status) {
    await guard();
    const rows = await getCollection().find({ namespace, kind: 'delivery', recoveryClosed: { $ne: true },
      state: { $in: ['prepared', 'not_sent', 'unknown', 'sending'] }
    }, { maxTimeMS: 5000 }).sort({ createdAt: 1 }).limit(1000).toArray();
    let count = 0;
    for (const row of rows) {
      // Event receipts are closed with their parent so offline/follow events
      // retain their own policy. Legacy orphans remain manually dismissible.
      if (row.parentEventId || String(row.key || '').startsWith('event:')) continue;
      const reason = staleDeliveryReason(row, typeof status === 'function' ? status() : status);
      if (!reason) continue;
      const result = await getCollection().updateOne({ _id: row._id, recoveryClosed: { $ne: true } },
        { $set: closurePatch(reason, 'expired') }, WRITE_OPTIONS);
      count += result.modifiedCount || 0;
    }
    return count;
  }
  return { get, deliver, resolve, dismiss, closeEventReceipts, expireStale, isInFlight: (key) => inFlight.has(key) };
}
const service = createDeliveryService();
module.exports = { ...service, createDeliveryService, idFor, unknownError };
