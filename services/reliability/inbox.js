'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { collection, WRITE_OPTIONS, isDuplicate } = require('./store');
const context = require('./context');
const delivery = require('./delivery');
const { eventTime, sessionBinding, staleEventReason } = require('./recoveryScope');
const idFor = (namespace, id) => `event:${createHash('sha256').update(`${namespace}:${id}`).digest('hex')}`;
function createInbox({ namespace, processJob, getCollection = collection, concurrency = 4,
  isReady = () => context.isActive(), maxAgeMs = 15 * 60000, safetyPollMs = 30000,
  getStreamState = () => ({}), deliveryService = delivery } = {}) {
  let safetyTimer = null;
  let wakeHandle = null;
  let retryWakeTimer = null;
  let retryWakeAt = 0;
  let acceptingWork = false;
  let polling = false;
  let wakeRequested = false;
  const running = new Map();
  let reconciling = null;
  let lastReconciledAt = 0;
  let lastReconciledState = '';
  function status() { return getStreamState() || {}; }
  function staleReason(job, checkAge = true) { return staleEventReason(job, status(), { maxAgeMs, checkAge }); }
  function retiredError(reason) { return Object.assign(context.cancelledError(reason), { expired: true }); }

  async function closeReceipts(job, reason, resolution) {
    await deliveryService.closeEventReceipts(namespace, job, reason, resolution);
    await getCollection().updateOne({ _id: job._id, state: resolution },
      { $set: { recoveryReceiptsClosed: true } }, WRITE_OPTIONS);
  }
  async function retire(job, reason, resolution = 'expired') {
    await context.assertOperation();
    const filter = { _id: job._id, namespace, state: job.state };
    if (job.claimId) filter.claimId = job.claimId;
    const result = await getCollection().updateOne(filter, {
      $set: { state: resolution, lastError: String(reason).slice(0, 600),
        recoveryResolution: resolution, recoveryClosedAt: new Date(), updatedAt: new Date(),
        recoveryReceiptsClosed: false, purgeAt: new Date(Date.now() + 7 * 86400000) },
      $unset: { claimId: '', claimUntil: '' }
    }, WRITE_OPTIONS);
    if (result.matchedCount !== 1) return false;
    // A cancelled wait must not requeue itself. Its final checkpoint requires
    // state=processing and therefore cannot overwrite this durable tombstone.
    running.get(job._id)?.controller.abort();
    await closeReceipts(job, reason, resolution);
    return true;
  }
  async function reconcileExpired({ force = false } = {}) {
    if (reconciling) return reconciling;
    const live = status();
    const signature = JSON.stringify([live.streamStateInitialized, live.streamLive,
      live.currentStreamId, live.twitchStreamStartedAt, live.lastStreamEndedAt]);
    if (!force && signature === lastReconciledState && Date.now() - lastReconciledAt < 30000) return 0;
    reconciling = (async () => {
      await context.assertOperation();
      const rows = await getCollection().find({ kind: 'event', namespace, $or: [
        { state: { $in: ['pending', 'processing', 'review', 'failed'] } },
        { state: { $in: ['dismissed', 'expired'] }, recoveryReceiptsClosed: { $ne: true } }
      ] }, { maxTimeMS: 5000, projection: { _id: 1, namespace: 1, messageId: 1, state: 1,
        createdAt: 1, claimId: 1, deliveryKey: 1, lastError: 1, sessionStreamId: 1, sessionStartedAt: 1,
        'payload.timestamp': 1, 'payload.type': 1, 'payload.event.id': 1, 'payload.event.started_at': 1,
        'steps.lifecycle': 1, recoveryReceiptsClosed: 1 } }).sort({ createdAt: 1 }).limit(1000).toArray();
      let expired = 0;
      for (const job of rows) {
        if (['dismissed', 'expired'].includes(job.state)) {
          await closeReceipts(job, job.lastError || 'Recovery closed.', job.state);
          continue;
        }
        const reason = staleReason(job, !running.has(job._id));
        if (reason && await retire(job, reason)) expired += 1;
      }
      if (expired) console.log(`[Recovery] Expired ${expired} stale EventSub job(s); no remaining actions will be sent.`);
      lastReconciledAt = Date.now(); lastReconciledState = signature;
      return expired;
    })().finally(() => { reconciling = null; });
    return reconciling;
  }
  async function assertJobCurrent(job) {
    context.throwIfCancelled();
    const reason = staleReason(job, false);
    if (reason) throw retiredError(reason);
    const binding = sessionBinding(job, status());
    if (binding.sessionStreamId) {
      const result = await getCollection().updateOne({ _id: job._id, claimId: job.claimId, state: 'processing' },
        { $set: binding }, WRITE_OPTIONS);
      if (result.matchedCount !== 1) throw context.cancelledError('Event was dismissed, expired or transferred.');
      Object.assign(job, binding);
      Object.assign(context.current().recoveryScope || {}, binding);
    }
  }
  async function dismiss(messageId, expectedDeliveryKey = '') {
    await context.assertOperation();
    const job = await getCollection().findOne({ _id: idFor(namespace, messageId), namespace });
    if (!job) throw new Error('Event not found. Refresh the recovery queue.');
    if (['dismissed', 'expired'].includes(job.state)) {
      await closeReceipts(job, job.lastError, job.state);
      return { success: true, message: 'This event is already closed; no actions will be retried.' };
    }
    if (!['review', 'failed'].includes(job.state) || running.has(job._id)) throw new Error('This event changed or is still running. Refresh before dismissing it.');
    if ((job.deliveryKey || '') !== expectedDeliveryKey) throw new Error('The pending action changed. Refresh before dismissing it.');
    if (job.deliveryKey && deliveryService.isInFlight(job.deliveryKey)) throw new Error('The action is still in flight. Wait before dismissing it.');
    const reason = 'Dismissed by a moderator; remaining actions will not be sent.';
    if (!await retire(job, reason, 'dismissed')) throw new Error('This event changed. Refresh the recovery queue.');
    return { success: true, message: reason };
  }

  function logPollError(err) { console.error('[EventSub Inbox] Poll failed:', err.message); }
  function scheduleWake() {
    if (!acceptingWork || wakeHandle) return;
    wakeHandle = context.detached(() => setImmediate(async () => {
      wakeHandle = null;
      if (!acceptingWork) return;
      if (polling) return; // poll() will reschedule because wakeRequested stays true.
      wakeRequested = false;
      try { await poll(); } catch (err) { logPollError(err); }
      if (wakeRequested) scheduleWake();
    }));
  }
  function requestPoll() {
    if (!acceptingWork) return;
    wakeRequested = true;
    scheduleWake();
  }
  function scheduleRetryWake(when) {
    if (!acceptingWork) return;
    const at = new Date(when || 0).getTime();
    if (!Number.isFinite(at) || at <= Date.now()) { requestPoll(); return; }
    if (retryWakeTimer && retryWakeAt <= at) return;
    if (retryWakeTimer) clearTimeout(retryWakeTimer);
    retryWakeAt = at;
    retryWakeTimer = context.detached(() => setTimeout(() => {
      retryWakeTimer = null; retryWakeAt = 0; requestPoll();
    }, Math.max(0, at - Date.now())));
  }
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
        createdAt: new Date(), availableAt: new Date(), attempts: 0, steps: {},
        ...sessionBinding({ payload, createdAt: new Date() }, status()) },
      { ...WRITE_OPTIONS, maxTimeMS: 3000, writeConcern: { w: 'majority', wtimeoutMS: 3000 } });
    } catch (err) { if (isDuplicate(err)) return { duplicate: true }; throw err; }
    // Normal path: once the webhook is durably stored, wake the worker immediately.
    // This is intentionally not awaited so Twitch acknowledgement is not delayed by
    // reaction execution. The periodic poll below is only a recovery safety net.
    requestPoll();
    return { duplicate: false };
  }
  async function step(job, name, fn) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid durable job step name.');
    await assertJobCurrent(job);
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
      const expiredReason = staleReason(job);
      if (expiredReason) {
        state = 'expired'; patch.lastError = expiredReason;
      } else {
        await processJob(job, (name, fn) => step(job, name, fn));
      }
    } catch (err) {
      const expiredReason = staleReason(job, false);
      if (err?.expired || expiredReason) {
        state = 'expired'; patch.lastError = expiredReason || err.message;
      } else if (err?.reviewRequired || err?.deliveryState === 'UNKNOWN') {
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
    if (state === 'expired') {
      // Run retirement outside the cancelled job context, but keep the runtime
      // ownership check. The send's AbortSignal must stay cancelled.
      await context.detached(() => retire(job, patch.lastError));
      return;
    }
    if (['done', 'expired'].includes(state)) patch.purgeAt = new Date(Date.now() + 7 * 86400000);
    await getCollection().updateOne({ _id: job._id, claimId: job.claimId, state: 'processing' }, {
      $set: { ...patch, state, completedAt: state === 'done' ? new Date() : null, updatedAt: new Date() },
      $unset: { claimId: '', claimUntil: '' }
    }, WRITE_OPTIONS);
    if (state === 'pending' && patch.availableAt) scheduleRetryWake(patch.availableAt);
  }
  async function poll() {
    if (polling || !acceptingWork || !isReady()) return;
    polling = true;
    try {
      await reconcileExpired();
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
        const promise = context.runOperation(() => execute(row, controller), {
          signal: controller.signal,
          // Checked by context.sleep and all guarded transports, including
          // Discord's Retry-After wait. A new/end session invalidates the send.
          isCurrent: () => !staleReason(row, false),
          recoveryScope: { parentEventId: row._id, occurredAt: new Date(eventTime(row)),
            sessionStreamId: row.sessionStreamId || '', sessionStartedAt: row.sessionStartedAt || 0 }
        });
        running.set(row._id, { controller, promise, job: row });
        promise.catch((err) => console.error('[EventSub Inbox] Job checkpoint failed:', err.message))
          .finally(() => {
            running.delete(row._id);
            // Refill a freed concurrency slot immediately if more work is queued.
            requestPoll();
          });
      }
    } finally {
      polling = false;
      if (wakeRequested) scheduleWake();
    }
  }
  function start() {
    acceptingWork = true;
    if (!safetyTimer) {
      const interval = Math.max(1000, Number(safetyPollMs) || 30000);
      safetyTimer = context.detached(() => setInterval(requestPoll, interval));
      console.log(`[EventSub Inbox] Immediate wake enabled; ${Math.round(interval / 1000)}s safety reconciliation poll.`);
    }
    // Startup reconciliation catches work left pending by a crash or deploy.
    requestPoll();
  }
  function quiesce() {
    acceptingWork = false;
    wakeRequested = false;
    if (safetyTimer) clearInterval(safetyTimer); safetyTimer = null;
    if (wakeHandle) clearImmediate(wakeHandle); wakeHandle = null;
    if (retryWakeTimer) clearTimeout(retryWakeTimer); retryWakeTimer = null; retryWakeAt = 0;
    for (const { controller } of running.values()) controller.abort();
  }
  async function stop() { quiesce(); await Promise.allSettled([...running.values()].map((job) => job.promise)); }
  async function resolveReview(messageId, outcome, expectedDeliveryKey) {
    await context.assertOperation();
    const id = idFor(namespace, messageId);
    const job = await getCollection().findOne({ _id: id, state: 'review' });
    if (job && staleReason(job)) { await retire(job, staleReason(job)); throw new Error('This event expired and cannot be retried.'); }
    if (!job?.deliveryKey) throw new Error('This event has no resolvable delivery receipt.');
    if (expectedDeliveryKey !== undefined && job.deliveryKey !== expectedDeliveryKey) throw new Error('The event action changed. Refresh before reviewing it.');
    const resolved = await deliveryService.resolve(job.deliveryKey, outcome);
    if (!resolved) throw new Error('This delivery changed or was resolved differently. Refresh before reviewing it.');
    if (staleReason(job)) { await retire(job, staleReason(job)); throw new Error('This event expired while being reviewed. It will not be retried.'); }
    const updated = await getCollection().updateOne({ _id: id, state: 'review', deliveryKey: job.deliveryKey }, {
      $set: { state: 'pending', availableAt: new Date(Date.now() + 1000), lastError: '' }
    }, WRITE_OPTIONS);
    if (updated.matchedCount !== 1) throw new Error('The old receipt was reviewed, but the event changed. Refresh its status.');
    scheduleRetryWake(Date.now() + 1000);
  }
  async function retryFailed(messageId) {
    await context.assertOperation();
    const job = await getCollection().findOne({ _id: idFor(namespace, messageId), state: 'failed' });
    if (!job) throw new Error('This event is no longer failed. Refresh its status.');
    const reason = staleReason(job);
    if (reason) { await retire(job, reason); throw new Error('This event expired and cannot be retried.'); }
    const result = await getCollection().updateOne({ _id: job._id, state: 'failed' }, {
      $set: { state: 'pending', failureCount: 0, availableAt: new Date(), lastError: '' }
    }, WRITE_OPTIONS);
    if (result.matchedCount !== 1) throw new Error('This event is not in the failed state. Refresh its status.');
    requestPoll();
  }
  return { accept, start, stop, quiesce, poll, resolveReview, retryFailed, dismiss, reconcileExpired, get pendingInProcess() { return running.size; } };
}
module.exports = { createInbox, idFor };
