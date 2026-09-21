'use strict';

const COMMAND_TTL_MS = 90 * 1000;
const TIMER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_CHAT = 100;
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
    if (!id || retryTimers.has(id)) return;
    const handle = setTimeout(() => {
      retryTimers.delete(id);
      void flush(id).catch((err) => warn(`[YouTube Delivery] Retry flush failed for ${id}: ${err?.message || err}`));
    }, Math.max(1000, Number(delayMs || 10000)));
    retryTimers.set(id, handle);
  }

  function buildKey(kind, options = {}) {
    const explicit = String(options.retryKey || '').trim();
    if (explicit) return explicit;
    sequence += 1;
    return `${kind || 'command'}:${now()}:${sequence}`;
  }

  function enqueue(liveChatId, text, options = {}, reason = 'worker-unavailable') {
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
        const queued = enqueue(id, text, options, err?.message || 'transient-send-failure');
        if (latestState === 'connected') scheduleFlush(id, 10000);
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
      for (const [key, item] of [...queue.entries()]) {
        if (String(getWorkerState(id) || '') !== 'connected') break;
        if (Number(item.expiresAt || 0) <= now()) {
          queue.delete(key);
          continue;
        }
        try {
          await sendNow(id, item.text, item.options || {});
          queue.delete(key);
          sentCount += 1;
        } catch (err) {
          if (isTransientSendError(err)) {
            if (String(getWorkerState(id) || '') === 'connected') scheduleFlush(id, 30000);
            break;
          }
          queue.delete(key);
          warn(`[YouTube Delivery] Dropped pending ${item.kind} for ${id}: ${err?.message || err}`);
        }
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
    if (retry) clearTimeout(retry);
    retryTimers.delete(id);
  }

  function clearAll() {
    pendingByChat.clear();
    flushing.clear();
    for (const retry of retryTimers.values()) clearTimeout(retry);
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
  TIMER_TTL_MS
};
