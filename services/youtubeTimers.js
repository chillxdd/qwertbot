'use strict';

const YouTubeChatTimer = require('../models/YouTubeChatTimer');
const { selectResponseIndex } = require('../features/youtube/pure');

const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 86400;
const TICK_MS = 1000;
const RETRY_MS = 60000;

function priorityRank(priority) {
  if (priority === 'high') return 0;
  if (priority === 'low') return 2;
  return 1;
}

function randomJitterMs(item, random = Math.random) {
  const jitterSeconds = Math.max(0, Math.min(86400, Math.floor(Number(item?.jitterSeconds || 0))));
  if (!jitterSeconds) return 0;
  // Match Twitch timer semantics exactly: choose an integer-second offset
  // uniformly from -jitter through +jitter on every occurrence.
  const span = jitterSeconds * 2 + 1;
  return (Math.floor(random() * span) - jitterSeconds) * 1000;
}

function calculateNextDueAt(item, now = Date.now(), random = Math.random) {
  const intervalSeconds = Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, Number(item?.intervalSeconds || MIN_INTERVAL_SECONDS)));
  const intervalMs = intervalSeconds * 1000;
  return now + Math.max(MIN_INTERVAL_SECONDS * 1000, intervalMs + randomJitterMs(item, random));
}

function createYouTubeTimerManager({
  channelKey,
  sendToAllChats,
  isEnabled = () => true,
  getGlobalStartDelaySeconds = () => 0,
  getViewerCount = async () => ({ count: 0, available: false }),
  random = Math.random
}) {
  let timers = [];
  let active = false;
  let sessionStartedAt = 0;
  let timer = null;
  let tickBusy = false;
  let sessionMessageCount = 0;
  let lastViewerCount = null;
  let lastViewerCountAt = null;
  let lastViewerCountAvailable = false;
  const nextDueById = new Map();
  const activityBaselineById = new Map();

  function globalStartDelayMs() {
    return Math.max(0, Number(getGlobalStartDelaySeconds() || 0)) * 1000;
  }

  function sessionGlobalGateAt() {
    return active && sessionStartedAt ? sessionStartedAt + globalStartDelayMs() : 0;
  }

  function timerStartDelayMs(item) {
    if (item?.startDelaySeconds === null || item?.startDelaySeconds === undefined) return null;
    return Math.max(0, Number(item.startDelaySeconds || 0)) * 1000;
  }

  function firstDueAt(item, now = Date.now()) {
    const streamStart = sessionStartedAt || now;
    const globalDelay = globalStartDelayMs();
    const itemDelay = timerStartDelayMs(item);
    const effectiveDelay = itemDelay === null ? globalDelay : Math.max(globalDelay, itemDelay);
    const notBefore = streamStart + effectiveDelay;
    const normalFirstDue = calculateNextDueAt(item, streamStart, random);
    return Math.max(now, notBefore, normalFirstDue);
  }

  function activityProgress(item) {
    const id = String(item?._id || '');
    const baseline = Number(activityBaselineById.get(id) ?? sessionMessageCount);
    return Math.max(0, sessionMessageCount - baseline);
  }

  function waitingFor(item) {
    const parts = [];
    const minMessages = Math.max(0, Number(item?.minimumChatMessages || 0));
    const progress = activityProgress(item);
    if (minMessages > progress) parts.push(`${Math.ceil(minMessages - progress)} more chat message${Math.ceil(minMessages - progress) === 1 ? '' : 's'}`);
    const minViewers = Math.max(0, Number(item?.minimumViewers || 0));
    if (minViewers > 0) {
      if (!lastViewerCountAvailable) parts.push('viewer count');
      else if (Number(lastViewerCount || 0) < minViewers) parts.push(`${Math.ceil(minViewers - Number(lastViewerCount || 0))} more viewer${Math.ceil(minViewers - Number(lastViewerCount || 0)) === 1 ? '' : 's'}`);
    }
    return parts.join(' · ');
  }

  async function reload() {
    timers = await YouTubeChatTimer.find({ channelKey, enabled: true }).lean();
    const now = Date.now();
    for (const item of timers) {
      const id = String(item._id);
      if (!activityBaselineById.has(id)) activityBaselineById.set(id, sessionMessageCount);
      if (!nextDueById.has(id) || !active) {
        nextDueById.set(id, active ? firstDueAt(item, now) : 0);
      }
    }
    const valid = new Set(timers.map((item) => String(item._id)));
    for (const id of [...nextDueById.keys()]) if (!valid.has(id)) nextDueById.delete(id);
    for (const id of [...activityBaselineById.keys()]) if (!valid.has(id)) activityBaselineById.delete(id);
  }

  async function startSession() {
    if (active) return;
    active = true;
    sessionStartedAt = Date.now();
    sessionMessageCount = 0;
    lastViewerCount = null;
    lastViewerCountAt = null;
    lastViewerCountAvailable = false;
    nextDueById.clear();
    activityBaselineById.clear();
    await reload();
    for (const item of timers) activityBaselineById.set(String(item._id), 0);
    if (!timer) timer = setInterval(() => { void tick(); }, TICK_MS);
  }

  function stopSession() {
    active = false;
    sessionStartedAt = 0;
    sessionMessageCount = 0;
    lastViewerCount = null;
    lastViewerCountAt = null;
    lastViewerCountAvailable = false;
    nextDueById.clear();
    activityBaselineById.clear();
  }

  function noteChatMessage(count = 1) {
    if (!active) return;
    sessionMessageCount += Math.max(0, Math.floor(Number(count || 0)));
  }

  function applyGlobalStartDelay() {
    if (!active || !sessionStartedAt) return;
    const gateAt = sessionGlobalGateAt();
    for (const [id, dueAt] of nextDueById.entries()) {
      if (dueAt && dueAt < gateAt) nextDueById.set(id, gateAt);
    }
  }

  async function refreshViewerCount() {
    const result = await getViewerCount();
    if (result && typeof result === 'object') {
      lastViewerCount = Math.max(0, Number(result.count || 0));
      lastViewerCountAvailable = result.available !== false;
      lastViewerCountAt = result.fetchedAt || new Date().toISOString();
    } else {
      lastViewerCount = Math.max(0, Number(result || 0));
      lastViewerCountAvailable = Number.isFinite(Number(result));
      lastViewerCountAt = new Date().toISOString();
    }
    return { count: lastViewerCount, available: lastViewerCountAvailable };
  }

  async function activityReady(item) {
    const minMessages = Math.max(0, Number(item?.minimumChatMessages || 0));
    if (activityProgress(item) < minMessages) return false;
    const minViewers = Math.max(0, Number(item?.minimumViewers || 0));
    if (!minViewers) return true;
    const viewer = await refreshViewerCount();
    if (!viewer.available) return false;
    return viewer.count >= minViewers;
  }

  async function fireTimer(item, { manual = false } = {}) {
    if (!item?.responses?.length) return { sent: false, reason: 'no-response' };
    const responseIndex = selectResponseIndex({
      responses: item.responses,
      mode: item.responseMode,
      weights: item.responseWeights,
      lastIndex: Number(item.lastResponseIndex ?? -1),
      avoidImmediateRepeat: Boolean(item.avoidImmediateRepeat),
      random
    });
    if (responseIndex < 0) return { sent: false, reason: 'no-response' };
    const text = String(item.responses[responseIndex] || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    if (!text) return { sent: false, reason: 'empty-response' };
    const result = await sendToAllChats(text, { kind: 'timer', timerId: String(item._id), manual });
    const acceptedCount = Number(result?.sentCount || 0) + Number(result?.queuedCount || 0);
    if (acceptedCount > 0) {
      item.lastResponseIndex = responseIndex;
      item.lastResponse = text;
      item.timesFired = Number(item.timesFired || 0) + 1;
      item.lastFiredAt = new Date();
      activityBaselineById.set(String(item._id), sessionMessageCount);
      await YouTubeChatTimer.updateOne({ _id: item._id, channelKey }, {
        $set: { lastResponseIndex: responseIndex, lastResponse: text, lastFiredAt: item.lastFiredAt },
        $inc: { timesFired: 1 }
      });
    }
    return result;
  }

  async function tick() {
    if (tickBusy || !active || !isEnabled()) return;
    tickBusy = true;
    try {
      const now = Date.now();
      const dueItems = timers
        .filter((item) => {
          const due = Number(nextDueById.get(String(item._id)) || 0);
          return due > 0 && due <= now;
        })
        .sort((a, b) => {
          const priority = priorityRank(a.priority) - priorityRank(b.priority);
          if (priority) return priority;
          return Number(nextDueById.get(String(a._id)) || 0) - Number(nextDueById.get(String(b._id)) || 0);
        });

      // Match Twitch's scheduler pacing: at most one eligible scheduled timer
      // is attempted per one-second tick. This honors priority without dumping
      // a burst of several timer messages (and quota-heavy inserts) at once.
      for (const item of dueItems) {
        const id = String(item._id);
        try {
          if (!(await activityReady(item))) continue;
          // Advance before I/O so a slow API call cannot duplicate the occurrence.
          const regularNext = calculateNextDueAt(item, now, random);
          nextDueById.set(id, regularNext);
          const result = await fireTimer(item);
          const coveredCount = Number(result?.sentCount || 0) + Number(result?.queuedCount || 0) + Number(result?.dedupedCount || 0);
          if (!coveredCount) nextDueById.set(id, Math.min(now + RETRY_MS, regularNext));
          break;
        } catch (err) {
          console.warn(`[YouTube Timers] ${item.name || id} could not send: ${err?.message || err}`);
          const regularNext = calculateNextDueAt(item, now, random);
          nextDueById.set(id, Math.min(now + RETRY_MS, regularNext));
          break;
        }
      }
    } finally {
      tickBusy = false;
    }
  }

  async function fireNow(timerId) {
    const item = await YouTubeChatTimer.findOne({ _id: timerId, channelKey, enabled: true }).lean();
    if (!item) throw new Error('YouTube timer not found or disabled.');
    return fireTimer(item, { manual: true });
  }

  async function listTimers() {
    const all = await YouTubeChatTimer.find({ channelKey }).sort({ name: 1 }).lean();
    return all.map((item) => {
      const id = String(item._id);
      const dueAt = Number(nextDueById.get(id) || 0);
      const globalDelay = Math.max(0, Number(getGlobalStartDelaySeconds() || 0));
      const itemDelay = item.startDelaySeconds === null || item.startDelaySeconds === undefined ? globalDelay : Math.max(globalDelay, Number(item.startDelaySeconds || 0));
      return {
        ...item,
        messagesSinceLastFire: activityProgress(item),
        currentViewerCount: lastViewerCountAvailable ? Number(lastViewerCount || 0) : null,
        viewerCountCheckedAt: lastViewerCountAt,
        effectiveStartDelaySeconds: itemDelay,
        nextDueAt: active && dueAt ? new Date(dueAt).toISOString() : null,
        waitingFor: active ? waitingFor(item) : ''
      };
    });
  }

  function shutdown() {
    stopSession();
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { reload, startSession, stopSession, noteChatMessage, applyGlobalStartDelay, fireNow, listTimers, shutdown };
}

module.exports = {
  createYouTubeTimerManager,
  priorityRank,
  randomJitterMs,
  calculateNextDueAt,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS
};
