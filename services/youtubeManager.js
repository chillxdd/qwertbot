'use strict';

const YouTubeConfig = require('../models/YouTubeConfig');
const { createYouTubeQuotaManager } = require('./youtubeQuota');
const { createYouTubeAuthManager } = require('./youtubeAuth');
const { createYouTubeDiscovery } = require('./youtubeDiscovery');
const { createYouTubeChatStreamFactory } = require('./youtubeChatStream');
const { createYouTubeCommandManager } = require('./youtubeCommands');
const { createYouTubeTimerManager } = require('./youtubeTimers');
const { createYouTubeDeliveryQueue } = require('./youtubeDeliveryQueue');
const {
  YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET,
  YOUTUBE_BROADCASTER_CHANNEL_ID,
  YOUTUBE_BROADCASTER_HANDLE,
  YOUTUBE_INSERT_COST,
  YOUTUBE_DISCOVERY_DELAYS_MS
} = require('../config/youtube');

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  commandsEnabled: true,
  timersEnabled: true,
  globalTimerStartDelaySeconds: 0,
  timerSafetyStopUnits: 7500,
  hardSafetyStopUnits: 9000,
  searchSafetyStopCalls: 90
});

function createYouTubeManager({ channelKey = 'generalqwert' } = {}) {
  const quotaManager = createYouTubeQuotaManager();
  const authManager = createYouTubeAuthManager({ quotaManager });
  const discovery = createYouTubeDiscovery({ authManager, quotaManager });
  let config = { ...DEFAULT_CONFIG };
  let twitchLive = false;
  let streamStateKnown = false;
  let botChannelId = '';
  let botDisplayName = '';
  let lastDiscoveryAt = null;
  let lastDiscoveryError = null;
  let discoveredBroadcasts = [];
  let discoveryPromise = null;
  let initialized = false;
  let quiesced = false;
  const discoveryTimers = new Set();
  const workers = new Map();
  const workerStates = new Map();

  const deliveryQueue = createYouTubeDeliveryQueue({
    getWorkerState: (liveChatId) => workerStates.get(String(liveChatId || ''))?.state || null,
    sendNow: (liveChatId, text, options) => attemptSendNow(liveChatId, text, options)
  });

  const commandManager = createYouTubeCommandManager({
    channelKey,
    sendMessage: (liveChatId, text, options) => sendMessage(liveChatId, text, options)
  });

  const timerManager = createYouTubeTimerManager({
    channelKey,
    sendToAllChats: (text, options) => sendToAllChats(text, options),
    isEnabled: () => Boolean(config.enabled && config.timersEnabled && twitchLive && !quiesced),
    getGlobalStartDelaySeconds: () => Number(config.globalTimerStartDelaySeconds || 0)
  });

  function hasConnectedChat() {
    return [...workerStates.values()].some((state) => state?.state === 'connected');
  }

  async function maybeStartTimerSession() {
    if (!config.enabled || !config.timersEnabled || !twitchLive || quiesced || !hasConnectedChat()) return;
    await timerManager.startSession();
  }

  const chatFactory = createYouTubeChatStreamFactory({
    authManager,
    quotaManager,
    onMessage: async (event) => {
      if (quiesced || !twitchLive || !config.enabled) return;
      if (botChannelId && String(event.author?.channelId || '') === botChannelId) return;
      if (!config.commandsEnabled) {
        commandManager.noteChatter(event.liveChatId, event.author?.displayName);
        return;
      }
      await commandManager.handleTextMessage(event);
    },
    onWorkerState: (state) => {
      workerStates.set(state.liveChatId, state);
      if (state.state === 'connected') {
        void maybeStartTimerSession().catch((err) => console.warn(`[YouTube Timers] Could not start timer session: ${err?.message || err}`));
        void deliveryQueue.flush(state.liveChatId).catch((err) => console.warn(`[YouTube Delivery] Could not flush ${state.liveChatId}: ${err?.message || err}`));
      }
      if (state.state === 'ended') {
        commandManager.clearChat(state.liveChatId);
        deliveryQueue.clearChat(state.liveChatId);
        if (!hasConnectedChat()) timerManager.stopSession();
      }
    }
  });

  async function loadConfig() {
    const doc = await YouTubeConfig.findOneAndUpdate(
      { channelKey },
      { $setOnInsert: { channelKey, ...DEFAULT_CONFIG } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    config = {
      enabled: doc?.enabled !== false,
      commandsEnabled: doc?.commandsEnabled !== false,
      timersEnabled: doc?.timersEnabled !== false,
      globalTimerStartDelaySeconds: Number(doc?.globalTimerStartDelaySeconds ?? DEFAULT_CONFIG.globalTimerStartDelaySeconds),
      timerSafetyStopUnits: Number(doc?.timerSafetyStopUnits ?? DEFAULT_CONFIG.timerSafetyStopUnits),
      hardSafetyStopUnits: Number(doc?.hardSafetyStopUnits ?? DEFAULT_CONFIG.hardSafetyStopUnits),
      searchSafetyStopCalls: Number(doc?.searchSafetyStopCalls ?? DEFAULT_CONFIG.searchSafetyStopCalls)
    };
    return { ...config };
  }

  async function refreshAuthIdentity() {
    const status = await authManager.getStatus();
    botChannelId = String(status.channelId || '');
    botDisplayName = String(status.displayName || '');
    return status;
  }

  async function initialize() {
    if (initialized) return;
    await loadConfig();
    await Promise.all([commandManager.reload(), timerManager.reload(), refreshAuthIdentity()]);
    initialized = true;
  }

  function clearDiscoveryTimers() {
    for (const timer of discoveryTimers) clearTimeout(timer);
    discoveryTimers.clear();
  }

  async function stopWorkers(reason = 'twitch-offline') {
    clearDiscoveryTimers();
    for (const [liveChatId, worker] of workers.entries()) {
      try { worker.stop(reason); } catch (_) {}
      commandManager.clearChat(liveChatId);
    }
    workers.clear();
    workerStates.clear();
    deliveryQueue.clearAll();
    discoveredBroadcasts = [];
    timerManager.stopSession();
  }

  async function reconcileChats(chats) {
    for (const chat of Array.isArray(chats) ? chats : []) {
      const liveChatId = String(chat.liveChatId || '');
      if (!liveChatId) continue;
      const existing = workers.get(liveChatId);
      if (existing) {
        existing.updateBroadcasts(chat.broadcasts || []);
        continue;
      }
      const worker = chatFactory.createWorker({ liveChatId, broadcasts: chat.broadcasts || [] });
      workers.set(liveChatId, worker);
      workerStates.set(liveChatId, worker.getStatus());
      try {
        await worker.start();
      } catch (err) {
        console.warn(`[YouTube] Could not start live chat ${liveChatId}: ${err?.message || err}`);
        workerStates.set(liveChatId, { ...worker.getStatus(), state: 'error', lastError: err?.message || String(err) });
        workers.delete(liveChatId);
      }
    }
  }

  async function discoverNow(reason = 'manual') {
    if (quiesced || !twitchLive || !config.enabled) return { broadcasts: [], chats: [] };
    // A slow Google request must not let two startup checkpoints spend quota
    // and reconcile the same chats concurrently. Manual rediscovery simply
    // joins the in-flight discovery rather than starting another request set.
    if (discoveryPromise) return discoveryPromise;
    discoveryPromise = (async () => {
      if (!authManager.configured()) throw new Error('YouTube OAuth environment settings are incomplete.');
      const authStatus = await refreshAuthIdentity();
      if (!authStatus.connected) throw new Error('SqwertArmyBot YouTube OAuth is not connected.');
      try {
        const result = await discovery.discoverActiveBroadcasts({ searchSafetyStopCalls: config.searchSafetyStopCalls });
        lastDiscoveryAt = new Date().toISOString();
        lastDiscoveryError = null;
        discoveredBroadcasts = result.broadcasts || [];
        await reconcileChats(result.chats || []);
        // Qwert normally has at most horizontal + vertical. Once both active
        // broadcasts are visible, later startup discovery checkpoints cannot
        // add a third expected feed, so cancel them and save search quota.
        if (discoveredBroadcasts.length >= 2) clearDiscoveryTimers();
        console.log(`[YouTube] Discovery (${reason}) found ${result.broadcasts?.length || 0} active broadcast(s), ${result.chats?.length || 0} distinct chat(s).`);
        return result;
      } catch (err) {
        lastDiscoveryAt = new Date().toISOString();
        lastDiscoveryError = err?.message || String(err);
        console.warn(`[YouTube] Discovery (${reason}) failed: ${lastDiscoveryError}`);
        throw err;
      }
    })().finally(() => { discoveryPromise = null; });
    return discoveryPromise;
  }

  function startDiscoveryWindow() {
    clearDiscoveryTimers();
    for (const delay of YOUTUBE_DISCOVERY_DELAYS_MS) {
      const timer = setTimeout(() => {
        discoveryTimers.delete(timer);
        if (!twitchLive || quiesced || !config.enabled) return;
        void discoverNow(`twitch-live+${Number((delay / 1000).toFixed(1))}s`).catch(() => {});
      }, delay);
      discoveryTimers.add(timer);
    }
  }

  async function syncTwitchLiveState({ live, known = true } = {}) {
    streamStateKnown = Boolean(known);
    const next = Boolean(live);
    // If a YouTube-only initialization attempt failed while Twitch was already
    // live, keep allowing later maintenance passes to retry initialization.
    // Once initialized, identical live-state updates remain a no-op.
    if (next === twitchLive && (initialized || !next)) return;
    twitchLive = next;
    if (!next) {
      await stopWorkers('twitch-offline');
      return;
    }
    if (!initialized) await initialize();
    if (quiesced || !config.enabled) return;
    startDiscoveryWindow();
  }

  async function sendRaw(liveChatId, text, token) {
    const response = await fetch('https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        snippet: {
          liveChatId,
          type: 'textMessageEvent',
          textMessageDetails: { messageText: String(text || '').slice(0, 200) }
        }
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data?.error?.message || `YouTube chat send failed (${response.status}).`);
      err.status = Number(response.status || 0);
      err.reason = data?.error?.errors?.[0]?.reason || null;
      throw err;
    }
    return data;
  }

  async function attemptSendNow(liveChatId, text, { kind = 'command' } = {}) {
    if (quiesced || !twitchLive || !config.enabled) throw new Error('YouTube bot is not active.');
    if (kind === 'command' && !config.commandsEnabled) throw new Error('YouTube commands are disabled.');
    if (kind === 'timer' && !config.timersEnabled) throw new Error('YouTube timers are disabled.');
    const content = String(text || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    if (!content) throw new Error('YouTube chat message is empty.');
    const limit = kind === 'timer' ? config.timerSafetyStopUnits : config.hardSafetyStopUnits;
    await quotaManager.reserveMainUnits(YOUTUBE_INSERT_COST, kind === 'timer' ? { timerMessages: 1 } : { commandMessages: 1 }, { limit });
    const token = await authManager.getValidAccessToken();
    return sendRaw(String(liveChatId), content, token);
  }

  async function sendMessage(liveChatId, text, options = {}) {
    return deliveryQueue.deliver(String(liveChatId), text, options);
  }

  async function sendToAllChats(text, { kind = 'timer', timerId = '', manual = false } = {}) {
    const active = [...workers.entries()].filter(([id]) => {
      const state = workerStates.get(id)?.state;
      return state && !['stopped', 'ended', 'error'].includes(state);
    });
    if (!active.length) return { sentCount: 0, queuedCount: 0, dedupedCount: 0, failedCount: 0, failures: [] };
    if (kind === 'timer' && !config.timersEnabled) return { sentCount: 0, queuedCount: 0, dedupedCount: 0, failedCount: 0, failures: [] };

    const failures = [];
    let sentCount = 0;
    let queuedCount = 0;
    let dedupedCount = 0;
    for (const [liveChatId] of active) {
      const retryKey = kind === 'timer' && timerId
        ? (manual ? `timer:${timerId}:manual:${Date.now()}:${liveChatId}` : `timer:${timerId}`)
        : '';
      try {
        const result = await sendMessage(liveChatId, text, { kind, timerId, manual, retryKey });
        if (result?.sent) sentCount += 1;
        else if (result?.queued && result?.deduped) dedupedCount += 1;
        else if (result?.queued) queuedCount += 1;
      } catch (err) {
        failures.push({ liveChatId, error: err?.message || String(err) });
      }
    }
    return { sentCount, queuedCount, dedupedCount, failedCount: failures.length, failures };
  }

  async function saveConfig(input = {}) {
    const timerSafetyStopUnits = Math.max(500, Math.min(9900, Math.floor(Number(input.timerSafetyStopUnits ?? config.timerSafetyStopUnits))));
    const hardSafetyStopUnits = Math.max(timerSafetyStopUnits + 50, Math.min(10000, Math.floor(Number(input.hardSafetyStopUnits ?? config.hardSafetyStopUnits))));
    const searchSafetyStopCalls = Math.max(1, Math.min(100, Math.floor(Number(input.searchSafetyStopCalls ?? config.searchSafetyStopCalls))));
    const globalTimerStartDelaySeconds = Math.max(0, Math.min(86400, Math.floor(Number(input.globalTimerStartDelaySeconds ?? config.globalTimerStartDelaySeconds))));
    const update = {
      enabled: input.enabled !== false,
      commandsEnabled: input.commandsEnabled !== false,
      timersEnabled: input.timersEnabled !== false,
      globalTimerStartDelaySeconds,
      timerSafetyStopUnits,
      hardSafetyStopUnits,
      searchSafetyStopCalls
    };
    await YouTubeConfig.findOneAndUpdate({ channelKey }, { $set: update, $setOnInsert: { channelKey } }, { upsert: true, setDefaultsOnInsert: true });
    const wasEnabled = config.enabled;
    const wereTimersEnabled = config.timersEnabled;
    const previousGlobalTimerStartDelaySeconds = Number(config.globalTimerStartDelaySeconds || 0);
    config = update;
    if (wasEnabled && !config.enabled) await stopWorkers('youtube-disabled');
    if (config.enabled && !config.commandsEnabled) deliveryQueue.dropKind('command');
    if (config.enabled && !config.timersEnabled) deliveryQueue.dropKind('timer');
    if (!wasEnabled && config.enabled && twitchLive) {
      startDiscoveryWindow();
    } else if (config.enabled && twitchLive) {
      if (wereTimersEnabled && !config.timersEnabled) timerManager.stopSession();
      if (!wereTimersEnabled && config.timersEnabled) await maybeStartTimerSession();
    }
    if (previousGlobalTimerStartDelaySeconds !== config.globalTimerStartDelaySeconds) timerManager.applyGlobalStartDelay();
    return { ...config };
  }

  async function onAuthChanged() {
    const authStatus = await refreshAuthIdentity();
    if (twitchLive && config.enabled && authStatus.connected) startDiscoveryWindow();
    else if (!authStatus.connected) await stopWorkers('youtube-auth-disconnected');
  }

  async function getAdminState() {
    const [auth, quota] = await Promise.all([authManager.getStatus(), quotaManager.getUsage()]);
    return { status: getStatus(), auth, quota, config: { ...config } };
  }

  async function runPreflight() {
    if (!initialized) await initialize();
    const checks = {};

    checks.environment = {
      ok: authManager.configured(),
      detail: authManager.configured()
        ? 'Google OAuth environment and encryption settings are present.'
        : 'Missing YouTube OAuth environment settings or CONFIG_ENCRYPTION_KEY.'
    };

    let authReady = false;
    try {
      const status = await refreshAuthIdentity();
      if (!status.connected) throw new Error('SqwertArmyBot YouTube OAuth is not connected.');
      await authManager.getValidAccessToken();
      authReady = true;
      checks.oauth = { ok: true, detail: `Authorized as ${status.displayName || status.channelId}.`, channelId: status.channelId || null };
    } catch (err) {
      checks.oauth = { ok: false, detail: err?.message || String(err) };
    }

    try {
      const result = chatFactory.preflight();
      checks.liveChatClient = { ok: true, detail: `StreamList client loaded for ${result.endpoint}.` };
    } catch (err) {
      checks.liveChatClient = { ok: false, detail: err?.message || String(err) };
    }

    if (authReady) {
      try {
        const broadcaster = await discovery.verifyBroadcaster();
        checks.broadcaster = { ok: true, detail: `Verified ${broadcaster.displayName || broadcaster.channelId}.`, ...broadcaster };
      } catch (err) {
        checks.broadcaster = { ok: false, detail: err?.message || String(err) };
      }
    } else {
      checks.broadcaster = { ok: false, skipped: true, detail: 'Skipped until SqwertArmyBot OAuth is connected.' };
    }

    const quota = await quotaManager.getUsage();
    const ok = Object.values(checks).every((check) => check.ok);
    return { ok, checkedAt: new Date().toISOString(), checks, quota };
  }

  function getStatus() {
    return {
      initialized,
      configured: Boolean(YOUTUBE_CLIENT_ID && YOUTUBE_CLIENT_SECRET),
      enabled: config.enabled,
      commandsEnabled: config.commandsEnabled,
      timersEnabled: config.timersEnabled,
      globalTimerStartDelaySeconds: config.globalTimerStartDelaySeconds,
      twitchLive,
      streamStateKnown,
      broadcaster: { channelId: YOUTUBE_BROADCASTER_CHANNEL_ID || null, handle: YOUTUBE_BROADCASTER_HANDLE || null },
      bot: { channelId: botChannelId || null, displayName: botDisplayName || null },
      activeBroadcasts: discoveredBroadcasts,
      distinctChats: [...workerStates.values()].filter((item) => !['stopped', 'ended'].includes(item.state)),
      pendingDeliveries: deliveryQueue.getStatus(),
      lastDiscoveryAt,
      lastDiscoveryError
    };
  }

  async function rediscoverNow() { return discoverNow('admin'); }
  async function fireTimerNow(timerId) { return timerManager.fireNow(timerId); }
  function invalidateCommands() { commandManager.invalidate(); }
  async function reloadCommands() { await commandManager.reload(); }
  async function reloadTimers() { await timerManager.reload(); }

  async function quiesce() {
    quiesced = true;
    await stopWorkers('runtime-quiesce');
  }

  async function resume() {
    if (!quiesced) return;
    quiesced = false;
    if (twitchLive && config.enabled) {
      await maybeStartTimerSession();
      startDiscoveryWindow();
    }
  }

  async function shutdown() {
    quiesced = true;
    await stopWorkers('shutdown');
    timerManager.shutdown();
    chatFactory.shutdown();
  }

  return {
    initialize,
    syncTwitchLiveState,
    rediscoverNow,
    getStatus,
    getAdminState,
    runPreflight,
    saveConfig,
    onAuthChanged,
    invalidateCommands,
    reloadCommands,
    reloadTimers,
    fireTimerNow,
    quiesce,
    resume,
    shutdown,
    authManager,
    quotaManager
  };
}

module.exports = { createYouTubeManager, DEFAULT_CONFIG };
