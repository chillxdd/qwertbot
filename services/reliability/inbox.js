'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { collection, WRITE_OPTIONS, isDuplicate } = require('./store');
const context = require('./context');
const delivery = require('./delivery');
const idFor = (namespace, id) => `event:${createHash('sha256').update(`${namespace}:${id}`).digest('hex')}`;
function createInbox({ namespace, processJob, getCollection = collection, concurrency = 4,
  isReady = () => context.isActive(), maxAgeMs = 15 * 60000 } = {}) {
  let timer = null;
  let acceptingWork = false;
  let polling = false;
  const running = new Map();
  async function accept(messageId, payload) {
    if (!messageId || String(messageId).length > 256) throw new Error('Missing or invalid EventSub message ID.');
    const db = getCollection();
    const id = idFor(namespace, messageId);
    if (await db.findOne({ _id: id }, { projection: { _id: 1 }, maxTimeMS: 3000 })) return { duplicate: true };
    const size = Buffer.byteLength(JSON.stringify(payload));
    if (size > 1024 * 1024) throw new Error('EventSub payload is too large.');
    const backlog = await db.countDocuments({ kind: 'event', namespace, state: { $in: ['pending', 'processing'] } }, { limit: 10000, maxTimeMS: 3000 });
    if (backlog >= 10000) throw new Error('Durable EventSub inbox is full; delivery was not acknowledged.');
    try {
      await db.insertOne({ _id: id, kind: 'event', namespace, messageId, payload, state: 'pending',
        createdAt: new Date(), availableAt: new Date(), attempts: 0, steps: {} },
      { ...WRITE_OPTIONS, maxTimeMS: 3000, writeConcern: { w: 'majority', wtimeoutMS: 3000 } });
    } catch (err) { if (isDuplicate(err)) return { duplicate: true }; throw err; }
    return { duplicate: false };
  }
  async function step(job, name, fn) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid durable job step name.');
    if (job.steps?.[name]?.done) return job.steps[name].value;
    context.throwIfCancelled();
    const value = await fn();
    const saved = { done: true, value: value === undefined ? null : value };
    if (Buffer.byteLength(JSON.stringify(saved)) > 512 * 1024) throw new Error('EventSub step result is too large.');
    const result = await getCollection().updateOne({ _id: job._id, claimId: job.claimId, state: 'processing' },
      { $set: { [`steps.${name}`]: saved } }, WRITE_OPTIONS);
    if (result.matchedCount !== 1) throw context.cancelledError('EventSub job was transferred to another worker.');
    job.steps ||= {}; job.steps[name] = saved;
    return saved.value;
  }
  async function execute(job, controller) {
    const heartbeat = setInterval(() => {
      getCollection().updateOne({ _id: job._id, claimId: job.claimId, state: 'processing' },
        [{ $set: { claimUntil: { $add: ['$$NOW', 90000] } } }], WRITE_OPTIONS)
        .then((r) => { if (r.matchedCount !== 1) controller.abort(); }).catch(() => controller.abort());
    }, 20000);
    // Configured action delays can total an hour. They still have a finite
    // watchdog, and shutdown interrupts them immediately through the signal.
    let watchdogExpired = false;
    const watchdog = setTimeout(() => { watchdogExpired = true; controller.abort(); }, 2 * 60 * 60000);
    let state = 'done';
    let patch = {};
    try {
      if (new Date(job.startedAt || Date.now()).getTime() - new Date(job.createdAt).getTime() > maxAgeMs && !Object.keys(job.steps || {}).length) {
        state = 'expired'; patch.lastError = 'Event waited over 15 minutes; stale reactions were not sent.';
      } else {
        await processJob(job, (name, fn) => step(job, name, fn));
      }
    } catch (err) {
      if (err?.reviewRequired || err?.deliveryState === 'UNKNOWN') {
        state = 'review'; patch.deliveryKey = err.deliveryKey || ''; patch.lastError = String(err.message).slice(0, 600);
      } else {
        const cancelled = !watchdogExpired && (err?.cancelled || controller.signal.aborted || !context.isActive());
        patch.failureCount = Number(job.failureCount || 0) + (cancelled ? 0 : 1);
        state = cancelled || patch.failureCount < 8 ? 'pending' : 'failed';
        patch.lastError = watchdogExpired ? 'Event action exceeded its two-hour watchdog.' : String(err?.message || err).slice(0, 600);
        patch.availableAt = new Date(Date.now() + (cancelled ? 1000 : Math.min(60000, 1000 * 2 ** patch.failureCount)));
      }
      if (state !== 'pending') console.error(`[EventSub Inbox] ${job.messageId}: ${state}: ${patch.lastError}`);
    } finally { clearInterval(heartbeat); clearTimeout(watchdog); }
    if (['done', 'expired'].includes(state)) patch.purgeAt = new Date(Date.now() + 7 * 86400000);
    await getCollection().updateOne({ _id: job._id, claimId: job.claimId, state: 'processing' }, {
      $set: { ...patch, state, completedAt: state === 'done' ? new Date() : null, updatedAt: new Date() },
      $unset: { claimId: '', claimUntil: '' }
    }, WRITE_OPTIONS);
  }
  async function poll() {
    if (polling || !acceptingWork || !isReady()) return;
    polling = true;
    try {
      while (acceptingWork && isReady() && running.size < concurrency) {
        await context.assertOperation();
        const claimId = randomUUID();
        const row = await getCollection().findOneAndUpdate({ kind: 'event', namespace,
          $or: [
            { state: 'pending', $expr: { $lte: ['$availableAt', '$$NOW'] } },
            { state: 'processing', fence: { $lt: context.fence() } },
            { state: 'processing', $expr: { $lte: ['$claimUntil', '$$NOW'] } }
          ]
        }, [{ $set: { state: 'processing', claimId, fence: context.fence(),
          startedAt: { $ifNull: ['$startedAt', '$$NOW'] },
          claimUntil: { $add: ['$$NOW', 90000] }, attempts: { $add: [{ $ifNull: ['$attempts', 0] }, 1] }
        } }], { ...WRITE_OPTIONS, sort: { createdAt: 1 }, returnDocument: 'after', includeResultMetadata: false });
        if (!row) break;
        // A restarted job retains its accepted age and completed steps; it does
        // not masquerade as a new Twitch event.
        const controller = new AbortController();
        const promise = context.runOperation(() => execute(row, controller), { signal: controller.signal });
        running.set(row._id, { controller, promise });
        promise.catch((err) => console.error('[EventSub Inbox] Job checkpoint failed:', err.message))
          .finally(() => { running.delete(row._id); });
      }
    } finally { polling = false; }
  }
  function start() {
    acceptingWork = true;
    if (!timer) timer = context.detached(() => setInterval(() => { poll().catch((err) => console.error('[EventSub Inbox] Poll failed:', err.message)); }, 500));
  }
  function quiesce() {
    acceptingWork = false;
    if (timer) clearInterval(timer); timer = null;
    for (const { controller } of running.values()) controller.abort();
  }
  async function stop() { quiesce(); await Promise.allSettled([...running.values()].map((job) => job.promise)); }
  async function resolveReview(messageId, outcome, expectedDeliveryKey) {
    await context.assertOperation();
    const id = idFor(namespace, messageId);
    const job = await getCollection().findOne({ _id: id, state: 'review' });
    if (!job?.deliveryKey) throw new Error('This event has no resolvable delivery receipt.');
    if (expectedDeliveryKey !== undefined && job.deliveryKey !== expectedDeliveryKey) throw new Error('The event action changed. Refresh before reviewing it.');
    const resolved = await delivery.resolve(job.deliveryKey, outcome);
    if (!resolved) throw new Error('This delivery changed or was resolved differently. Refresh before reviewing it.');
    const updated = await getCollection().updateOne({ _id: id, state: 'review', deliveryKey: job.deliveryKey }, {
      $set: { state: 'pending', availableAt: new Date(Date.now() + 1000), lastError: '' }
    }, WRITE_OPTIONS);
    if (updated.matchedCount !== 1) throw new Error('The old receipt was reviewed, but the event changed. Refresh its status.');
  }
  async function retryFailed(messageId) {
    await context.assertOperation();
    const result = await getCollection().updateOne({ _id: idFor(namespace, messageId), state: 'failed' }, {
      $set: { state: 'pending', failureCount: 0, availableAt: new Date(), lastError: '' }
    }, WRITE_OPTIONS);
    if (result.matchedCount !== 1) throw new Error('This event is not in the failed state. Refresh its status.');
  }
  return { accept, start, stop, quiesce, poll, resolveReview, retryFailed, get pendingInProcess() { return running.size; } };
}
module.exports = { createInbox, idFor };
