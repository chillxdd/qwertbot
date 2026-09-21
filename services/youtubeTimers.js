'use strict';

const YouTubeChatTimer = require('../models/YouTubeChatTimer');
const { selectResponseIndex } = require('../features/youtube/pure');

function createYouTubeTimerManager({ channelKey, sendToAllChats, isEnabled = () => true, getGlobalStartDelaySeconds = () => 0 }) {
  let timers = [];
  let active = false;
  let sessionStartedAt = 0;
  let timer = null;
  const nextDueById = new Map();

  function globalStartDelayMs() {
    return Math.max(0, Number(getGlobalStartDelaySeconds() || 0)) * 1000;
  }

  function sessionGlobalGateAt() {
    return active && sessionStartedAt ? sessionStartedAt + globalStartDelayMs() : 0;
  }

  async function reload() {
    timers = await YouTubeChatTimer.find({ channelKey, enabled: true }).lean();
    const now = Date.now();
    for (const item of timers) {
      const id = String(item._id);
      if (!nextDueById.has(id) || !active) {
        const startDelay = Math.max(0, Number(item.startDelaySeconds || 0)) * 1000;
        // startSession() deliberately anchors existing timers to the moment the
        // first YouTube live chat becomes ready. A timer created while already
        // live waits its own full start delay from creation/reload, while the
        // global start-delay gate can only push it later (never earlier).
        nextDueById.set(id, active ? Math.max(now + startDelay, sessionGlobalGateAt()) : 0);
      }
    }
    const valid = new Set(timers.map((item) => String(item._id)));
    for (const id of [...nextDueById.keys()]) if (!valid.has(id)) nextDueById.delete(id);
  }

  async function startSession() {
    if (active) return;
    active = true;
    sessionStartedAt = Date.now();
    await reload();
    const globalDelay = globalStartDelayMs();
    for (const item of timers) {
      const itemDelay = Math.max(0, Number(item.startDelaySeconds || 0)) * 1000;
      nextDueById.set(String(item._id), sessionStartedAt + Math.max(globalDelay, itemDelay));
    }
    if (!timer) timer = setInterval(() => { void tick(); }, 5000);
  }

  function stopSession() {
    active = false;
    sessionStartedAt = 0;
    nextDueById.clear();
  }

  function applyGlobalStartDelay() {
    if (!active || !sessionStartedAt) return;
    const gateAt = sessionGlobalGateAt();
    for (const [id, dueAt] of nextDueById.entries()) {
      if (dueAt && dueAt < gateAt) nextDueById.set(id, gateAt);
    }
  }

  async function fireTimer(item, { manual = false } = {}) {
    if (!item?.responses?.length) return { sent: false, reason: 'no-response' };
    const responseIndex = selectResponseIndex({
      responses: item.responses,
      mode: item.responseMode,
      weights: item.responseWeights,
      lastIndex: Number(item.lastResponseIndex ?? -1),
      avoidImmediateRepeat: Boolean(item.avoidImmediateRepeat)
    });
    if (responseIndex < 0) return { sent: false, reason: 'no-response' };
    const text = String(item.responses[responseIndex] || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    if (!text) return { sent: false, reason: 'empty-response' };
    const result = await sendToAllChats(text, { kind: 'timer', timerId: String(item._id), manual });
    if (result?.sentCount > 0) {
      item.lastResponseIndex = responseIndex;
      item.lastResponse = text;
      item.timesFired = Number(item.timesFired || 0) + 1;
      item.lastFiredAt = new Date();
      await YouTubeChatTimer.updateOne({ _id: item._id, channelKey }, {
        $set: { lastResponseIndex: responseIndex, lastResponse: text, lastFiredAt: item.lastFiredAt },
        $inc: { timesFired: 1 }
      });
    }
    return result;
  }

  async function tick() {
    if (!active || !isEnabled()) return;
    const now = Date.now();
    for (const item of timers) {
      const id = String(item._id);
      const due = Number(nextDueById.get(id) || 0);
      if (!due || due > now) continue;
      const intervalMs = Math.max(600, Number(item.intervalSeconds || 600)) * 1000;
      // Advance first so a slow API call cannot cause duplicate timer fires.
      nextDueById.set(id, now + intervalMs);
      try {
        const result = await fireTimer(item);
        if (!result?.sentCount) nextDueById.set(id, Math.min(now + 60000, now + intervalMs));
      } catch (err) {
        console.warn(`[YouTube Timers] ${item.name || id} could not send: ${err?.message || err}`);
        nextDueById.set(id, Math.min(now + 60000, now + intervalMs));
      }
    }
  }

  async function fireNow(timerId) {
    const item = await YouTubeChatTimer.findOne({ _id: timerId, channelKey, enabled: true }).lean();
    if (!item) throw new Error('YouTube timer not found or disabled.');
    return fireTimer(item, { manual: true });
  }

  function shutdown() {
    stopSession();
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { reload, startSession, stopSession, applyGlobalStartDelay, fireNow, shutdown };
}

module.exports = { createYouTubeTimerManager };
