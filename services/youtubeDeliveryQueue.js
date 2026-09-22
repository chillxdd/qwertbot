'use strict';

const COMMAND_TTL_MS = 90 * 1000;
const TIMER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_CHAT = 100;
const RETRY_BACKOFF_MS = [30000, 60000, 120000, 300000, 600000, 900000];
const MAX_COMMAND_SEND_ATTEMPTS = 3;
const MAX_TIMER_SEND_ATTEMPTS = 6;
const QUEUEABLE_STATES = new Set(['connecting', 'priming', 'reconnecting']);

function isTransientSendError(err) {
  const message = String(err?.message || '').toLowerCase();
  if (message.includes('safety budget') || message.includes('commands are disabled') || message.includes('timers are disabled') || message.includes('bot is not active')) return false;
  const status = Number(err?.status || 0);
  if (!status) return true;
  return status === 401 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function createYouTubeDeliveryQueue({ getWorkerState, sendNow, now = () => Date.now(), warn = (message) => console.warn(message) } = {}) {
  if (typeof getWorkerState !== 'function') throw new Error('getWorkerState is required.');
  if (typeof sendNow !== 'function') throw new Error('sendNow is required.');

  const pendingByChat = new Map();
  const flushing = new Set();
  const retryTimers = new Map();
  let sequence = 0;

  function ttlFor(kind) {
    return kind === 'timer' ? TIMER_TTL_MS : COMMAND_TTL_MS;
  }

  function maxAttemptsFor(kind) {
    return kind === 'timer' ? MAX_TIMER_SEND_ATTEMPTS : MAX_COMMAND_SEND_ATTEMPTS;
  }

  function retryDelayFor(attempts) {
    const index = Math.max(0, Math.min(RETRY_BACKOFF_MS.length - 1, Number(attempts || 1) - 1));
    return RETRY_BACKOFF_MS[index];
  }

  function chatQueue(liveChatId, create = false) {
    const id = String(liveChatId || '');
    if (!id) return null;
    let queue = pendingByChat.get(id);
    if (!queue && create) {
      queue = new Map();
      pendingByChat.set(id, queue);
    }
    return queue || null;
  }

  function pruneChat(liveChatId) {
    const id = String(liveChatId || '');
    const queue = chatQueue(id, false);
    if (!queue) return;
    const current = now();
    for (const [key, item] of queue.entries()) {
      if (Number(item.expiresAt || 0) <= current) queue.delete(key);
    }
    if (!queue.size) pendingByChat.delete(id);
  }

  function pruneAll() {
    for (const id of [...pendingByChat.keys()]) pruneChat(id);
  }


  function scheduleFlush(liveChatId, delayMs = 10000) {
    const id = String(liveChatId || '');
    if (!id) return;
    const delay = Math.max(1000, Number(delayMs || 10000));
    const dueAt = now() + delay;
    const existing = retryTimers.get(id);
    // Keep the earliest pending retry. A new command should not wait behind an
    // older timer's much later retry window.
    if (existing && Number(existing.dueAt || 0) <= dueAt) return;
    if (existing?.handle) clearTimeout(existing.handle);
    const handle = setTimeout(() => {
      retryTimers.delete(id);
      void flush(id).catch((err) => warn(`[YouTube Delivery] Retry flush failed for ${id}: ${err?.message || err}`));
    }, delay);
    retryTimers.set(id, { handle, dueAt });
  }

  function buildKey(kind, options = {}) {
    const explicit = String(options.retryKey || '').trim();
    if (explicit) return explicit;
    sequence += 1;
    return `${kind || 'command'}:${now()}:${sequence}`;
  }

  function enqueue(liveChatId, text, options = {}, reason = 'worker-unavailable', attempts = 0) {
    const id = String(liveChatId || '');
    const kind = options.kind === 'timer' ? 'timer' : 'command';
    const queue = chatQueue(id, true);
    pruneChat(id);
    const actualQueue = chatQueue(id, true);
    const key = buildKey(kind, options);
    const existing = actualQueue.get(key);
    if (existing) {
      return { sent: false, queued: true, deduped: true, liveChatId: id, reason };
    }

    // Keep timer retry keys stable (one pending delivery per timer/chat) and
    // bound command bursts so a very long outage cannot create an unbounded
    // in-memory backlog.
    while (actualQueue.size >= MAX_PENDING_PER_CHAT) {
      const oldestKey = actualQueue.keys().next().value;
      if (oldestKey === undefined) break;
      actualQueue.delete(oldestKey);
    }

    actualQueue.set(key, {
      key,
      liveChatId: id,
      text: String(text || ''),
      options: { ...options, kind },
      kind,
      queuedAt: now(),
      expiresAt: now() + ttlFor(kind),
      attempts: Math.max(0, Math.floor(Number(attempts || 0))),
      nextAttemptAt: attempts > 0 ? now() + retryDelayFor(attempts) : now(),
      reason
    });
    return { sent: false, queued: true, deduped: false, liveChatId: id, reason };
  }

  async function deliver(liveChatId, text, options = {}) {
    const id = String(liveChatId || '');
    const state = String(getWorkerState(id) || '');
    if (QUEUEABLE_STATES.has(state)) return enqueue(id, text, options, state);
    if (state !== 'connected') {
      const err = new Error('YouTube live chat worker is not available.');
      err.code = 'CHAT_WORKER_UNAVAILABLE';
      throw err;
    }

    try {
      const data = await sendNow(id, text, options);
      return { sent: true, queued: false, liveChatId: id, data };
    } catch (err) {
      const latestState = String(getWorkerState(id) || '');
      if (isTransientSendError(err) && (latestState === 'connected' || QUEUEABLE_STATES.has(latestState))) {
        const queued = enqueue(id, text, options, err?.message || 'transient-send-failure', 1);
        if (latestState === 'connected') scheduleFlush(id, retryDelayFor(1));
        return queued;
      }
      throw err;
    }
  }

  async function flush(liveChatId) {
    const id = String(liveChatId || '');
    if (!id || flushing.has(id)) return { sentCount: 0, remaining: chatQueue(id, false)?.size || 0 };
    if (String(getWorkerState(id) || '') !== 'connected') return { sentCount: 0, remaining: chatQueue(id, false)?.size || 0 };
    pruneChat(id);
    const queue = chatQueue(id, false);
    if (!queue?.size) return { sentCount: 0, remaining: 0 };

    flushing.add(id);
    let sentCount = 0;
    try {
      let soonestRetryAt = 0;
      for (const [key, item] of [...queue.entries()]) {
        if (String(getWorkerState(id) || '') !== 'connected') break;
        const current = now();
        if (Number(item.expiresAt || 0) <= current) {
          queue.delete(key);
          continue;
        }
        if (Number(item.nextAttemptAt || 0) > current) {
          soonestRetryAt = !soonestRetryAt ? Number(item.nextAttemptAt) : Math.min(soonestRetryAt, Number(item.nextAttemptAt));
          continue;
        }
        try {
          await sendNow(id, item.text, item.options || {});
          queue.delete(key);
          sentCount += 1;
        } catch (err) {
          if (isTransientSendError(err)) {
            item.attempts = Math.max(0, Number(item.attempts || 0)) + 1;
            if (item.attempts >= maxAttemptsFor(item.kind)) {
              queue.delete(key);
              warn(`[YouTube Delivery] Dropped pending ${item.kind} for ${id} after ${item.attempts} transient send attempts: ${err?.message || err}`);
            } else {
              item.nextAttemptAt = current + retryDelayFor(item.attempts);
              soonestRetryAt = !soonestRetryAt ? item.nextAttemptAt : Math.min(soonestRetryAt, item.nextAttemptAt);
            }
            // One transient transport/API failure is enough signal to stop this
            // flush. Do not burst through the rest of the queue during an outage.
            break;
          }
          queue.delete(key);
          warn(`[YouTube Delivery] Dropped pending ${item.kind} for ${id}: ${err?.message || err}`);
        }
      }
      if (soonestRetryAt && String(getWorkerState(id) || '') === 'connected') {
        scheduleFlush(id, Math.max(1000, soonestRetryAt - now()));
      }
    } finally {
      flushing.delete(id);
      if (!queue.size) pendingByChat.delete(id);
    }
    return { sentCount, remaining: queue.size };
  }

  function clearChat(liveChatId) {
    const id = String(liveChatId || '');
    pendingByChat.delete(id);
    const retry = retryTimers.get(id);
    if (retry?.handle) clearTimeout(retry.handle);
    retryTimers.delete(id);
  }

  function clearAll() {
    pendingByChat.clear();
    flushing.clear();
    for (const retry of retryTimers.values()) if (retry?.handle) clearTimeout(retry.handle);
    retryTimers.clear();
  }

  function dropKind(kind) {
    const normalized = kind === 'timer' ? 'timer' : 'command';
    for (const [id, queue] of pendingByChat.entries()) {
      for (const [key, item] of queue.entries()) if (item.kind === normalized) queue.delete(key);
      if (!queue.size) pendingByChat.delete(id);
    }
  }

  function getStatus() {
    pruneAll();
    let commands = 0;
    let timers = 0;
    const chats = [];
    for (const [liveChatId, queue] of pendingByChat.entries()) {
      let chatCommands = 0;
      let chatTimers = 0;
      for (const item of queue.values()) {
        if (item.kind === 'timer') { timers += 1; chatTimers += 1; }
        else { commands += 1; chatCommands += 1; }
      }
      chats.push({ liveChatId, total: queue.size, commands: chatCommands, timers: chatTimers });
    }
    return { total: commands + timers, commands, timers, chats };
  }

  return { deliver, flush, clearChat, clearAll, dropKind, getStatus };
}

module.exports = {
  createYouTubeDeliveryQueue,
  isTransientSendError,
  COMMAND_TTL_MS,
  TIMER_TTL_MS,
  RETRY_BACKOFF_MS,
  MAX_COMMAND_SEND_ATTEMPTS,
  MAX_TIMER_SEND_ATTEMPTS
};
