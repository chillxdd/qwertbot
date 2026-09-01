const PersistentPinConfig = require('../models/PersistentPinConfig');

const MAX_PERSISTENT_PIN_MESSAGE_LENGTH = 500;
const DEFAULT_PERSISTENT_PIN_HOLD_SECONDS = 10;
const MAX_PERSISTENT_PIN_HOLD_SECONDS = 3600;
const PERSISTENT_PIN_MONITOR_INTERVAL_MS = 15000;
const OWN_RESPONSE_TTL_MS = 15000;
const MONITOR_ERROR_LOG_INTERVAL_MS = 2 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeMessage(value) {
  return Array.from(String(value || '').trim()).slice(0, MAX_PERSISTENT_PIN_MESSAGE_LENGTH).join('');
}

function normalizeHoldSeconds(value, fallback = DEFAULT_PERSISTENT_PIN_HOLD_SECONDS) {
  const raw = value === undefined || value === null || value === '' ? fallback : Number(value);
  const seconds = Math.round(raw);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_PERSISTENT_PIN_HOLD_SECONDS) {
    throw new Error(`Persistent Stream Pin hold must be between 0 and ${MAX_PERSISTENT_PIN_HOLD_SECONDS} seconds.`);
  }
  return seconds;
}

function normalizeConfig(input = {}) {
  return {
    enabled: input.enabled === true,
    message: normalizeMessage(input.message),
    startupHoldSeconds: normalizeHoldSeconds(input.startupHoldSeconds)
  };
}

function createPersistentPinManager({
  channelName,
  sendMessageViaApi,
  getPinnedChatMessage,
  pinChatMessage,
  unpinChatMessage,
  beginPriorityAutomationHold = null,
  endPriorityAutomationHold = null,
  getStreamStatus = null
}) {
  const normalizedChannel = String(channelName || '').toLowerCase().trim();
  let config = {
    channelName: normalizedChannel,
    enabled: false,
    message: '',
    startupHoldSeconds: DEFAULT_PERSISTENT_PIN_HOLD_SECONDS,
    activeStreamId: '',
    activeMessageId: '',
    lastPinnedAt: null
  };
  let operationBusy = false;
  let monitorTimer = null;
  let monitorBusy = false;
  let monitorStreamId = '';
  let displacedByMessageId = '';
  let lastMonitorErrorLogAt = 0;
  const ownResponses = [];

  function cleanupOwnResponses() {
    const cutoff = Date.now() - OWN_RESPONSE_TTL_MS;
    while (ownResponses.length && ownResponses[0].createdAt < cutoff) ownResponses.shift();
  }

  function noteOwnResponse(message) {
    cleanupOwnResponses();
    ownResponses.push({ message: String(message || '').trim(), createdAt: Date.now() });
  }

  function consumeOwnResponse(message) {
    cleanupOwnResponses();
    const normalized = String(message || '').trim();
    const index = ownResponses.findIndex((entry) => entry.message === normalized);
    if (index === -1) return false;
    ownResponses.splice(index, 1);
    return true;
  }

  function toClient() {
    return {
      enabled: config.enabled === true,
      message: String(config.message || ''),
      startupHoldSeconds: normalizeHoldSeconds(config.startupHoldSeconds),
      activeStreamId: String(config.activeStreamId || ''),
      activeMessageId: String(config.activeMessageId || ''),
      lastPinnedAt: config.lastPinnedAt || null,
      monitorActive: Boolean(monitorTimer)
    };
  }

  function streamStatus() {
    try {
      const status = typeof getStreamStatus === 'function' ? (getStreamStatus() || {}) : {};
      return {
        live: status.streamLive !== undefined ? Boolean(status.streamLive) : Boolean(status.live),
        streamId: String(status.currentStreamId || status.streamId || '').trim()
      };
    } catch (_) {
      return { live: false, streamId: '' };
    }
  }

  async function initialize() {
    const stored = await PersistentPinConfig.findOne({ channelName: normalizedChannel }).lean();
    if (stored) {
      config = {
        ...config,
        ...stored,
        startupHoldSeconds: normalizeHoldSeconds(stored.startupHoldSeconds)
      };
    } else {
      const created = await PersistentPinConfig.findOneAndUpdate(
        { channelName: normalizedChannel },
        {
          $setOnInsert: {
            channelName: normalizedChannel,
            enabled: false,
            message: '',
            startupHoldSeconds: DEFAULT_PERSISTENT_PIN_HOLD_SECONDS
          }
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      ).lean();
      config = {
        ...config,
        ...created,
        startupHoldSeconds: normalizeHoldSeconds(created?.startupHoldSeconds)
      };
    }
    console.log(`[Persistent Pin] ${config.enabled ? 'Enabled' : 'Disabled'}; post-pin automation hold ${config.startupHoldSeconds}s.`);
    return toClient();
  }

  async function persistRuntime(patch = {}) {
    config = { ...config, ...patch };
    await PersistentPinConfig.updateOne(
      { channelName: normalizedChannel },
      { $set: patch, $setOnInsert: { channelName: normalizedChannel } },
      { upsert: true }
    );
  }

  async function persistEnabled(enabled) {
    await persistRuntime({ enabled: enabled === true });
    if (!enabled) stopMonitor();
  }

  async function saveConfig(input = {}) {
    const rawMessage = String(input.message || '').trim();
    if (Array.from(rawMessage).length > MAX_PERSISTENT_PIN_MESSAGE_LENGTH) {
      throw new Error(`Persistent Stream Pin message can contain at most ${MAX_PERSISTENT_PIN_MESSAGE_LENGTH} characters.`);
    }
    const next = normalizeConfig({ ...input, message: rawMessage });
    if (next.enabled && !next.message) {
      throw new Error('Persistent Stream Pin message is required when the feature is enabled.');
    }

    const previousEnabled = config.enabled === true;
    const previousMessageId = String(config.activeMessageId || '').trim();
    const messageChanged = next.message !== String(config.message || '');
    const update = { ...next };
    if (messageChanged) update.activeMessageId = '';

    const saved = await PersistentPinConfig.findOneAndUpdate(
      { channelName: normalizedChannel },
      {
        $set: update,
        $setOnInsert: { channelName: normalizedChannel }
      },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();
    config = {
      ...config,
      ...saved,
      startupHoldSeconds: normalizeHoldSeconds(saved?.startupHoldSeconds)
    };

    if (!config.enabled) {
      stopMonitor();
      // Disabling from the UI stops persistence. If our own persistent message is
      // the active pin, remove it; never tear down a moderator's replacement pin.
      if (previousEnabled && previousMessageId && typeof getPinnedChatMessage === 'function' && typeof unpinChatMessage === 'function') {
        try {
          const current = await getPinnedChatMessage();
          if (String(current?.message_id || '').trim() === previousMessageId) {
            await unpinChatMessage(previousMessageId);
          }
        } catch (err) {
          console.warn('[Persistent Pin] Settings disabled, but the current pin could not be checked/removed:', err?.message || err);
        }
      }
    } else {
      const status = streamStatus();
      if (status.live) {
        if (status.streamId && status.streamId !== String(config.activeStreamId || '')) {
          await persistRuntime({ activeStreamId: status.streamId, activeMessageId: '' });
        }
        startMonitor(status.streamId || config.activeStreamId || '');
        // If the configured text changed while our old message was pinned, replace
        // it now. If a moderator has another message pinned, leave that override alone.
        if (messageChanged && previousMessageId && typeof getPinnedChatMessage === 'function') {
          try {
            const current = await getPinnedChatMessage();
            const currentId = String(current?.message_id || '').trim();
            if (currentId === previousMessageId && typeof unpinChatMessage === 'function') {
              await unpinChatMessage(previousMessageId);
              await restoreIfUnpinned({ source: 'settings_update', streamId: status.streamId });
            } else if (!currentId) {
              await restoreIfUnpinned({ source: 'settings_update', streamId: status.streamId });
            }
          } catch (err) {
            console.warn('[Persistent Pin] Saved settings, but the live pin could not be refreshed:', err?.message || err);
          }
        } else if (!previousEnabled) {
          // Enabling from the UI while live should take effect immediately only if
          // there is no active moderator pin. A replacement pin always wins until removed.
          await restoreIfUnpinned({ source: 'settings_enable', streamId: status.streamId }).catch((err) => {
            console.warn('[Persistent Pin] Enabled while live, but automatic restore is pending:', err?.message || err);
          });
        }
      }
    }

    console.log(`[Persistent Pin] Settings saved (${config.enabled ? 'enabled' : 'disabled'}; hold ${config.startupHoldSeconds}s).`);
    return toClient();
  }

  async function postFreshConfiguredMessage(streamId = '') {
    if (typeof sendMessageViaApi !== 'function') throw new Error('Twitch Chat API sender is unavailable.');
    if (!String(config.message || '').trim()) throw new Error('Persistent Stream Pin message is not configured.');
    noteOwnResponse(config.message);
    let result;
    try {
      result = await sendMessageViaApi(config.message);
    } catch (err) {
      consumeOwnResponse(config.message);
      throw err;
    }
    const messageId = String(result?.message_id || '').trim();
    if (!messageId) throw new Error('Twitch sent the persistent-pin message without returning a message ID.');

    await persistRuntime({
      activeStreamId: String(streamId || config.activeStreamId || ''),
      activeMessageId: messageId
    });
    return messageId;
  }

  async function removeCurrentPinIfDifferent(targetMessageId = '') {
    if (typeof getPinnedChatMessage !== 'function' || typeof unpinChatMessage !== 'function') return;
    const current = await getPinnedChatMessage();
    const currentId = String(current?.message_id || '').trim();
    if (currentId && currentId !== String(targetMessageId || '').trim()) {
      await unpinChatMessage(currentId);
    }
  }

  async function pinMessage(messageId) {
    if (typeof pinChatMessage !== 'function') throw new Error('Twitch pinned-chat API is unavailable.');
    await pinChatMessage(messageId, { durationSeconds: null });
    displacedByMessageId = '';
    await persistRuntime({ activeMessageId: String(messageId || ''), lastPinnedAt: new Date() });
  }

  async function runExclusive(task) {
    while (operationBusy) await sleep(100);
    operationBusy = true;
    try {
      return await task();
    } finally {
      operationBusy = false;
    }
  }

  async function holdOtherAutomations() {
    const seconds = normalizeHoldSeconds(config.startupHoldSeconds);
    if (seconds > 0) await sleep(seconds * 1000);
  }

  function beginPinPriorityHold() {
    if (typeof beginPriorityAutomationHold !== 'function') return false;
    return beginPriorityAutomationHold('stream_pin') !== false;
  }

  function endPinPriorityHold() {
    if (typeof endPriorityAutomationHold === 'function') endPriorityAutomationHold('stream_pin');
  }

  function stopMonitor() {
    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = null;
    monitorStreamId = '';
    displacedByMessageId = '';
  }

  function startMonitor(streamId = '') {
    monitorStreamId = String(streamId || monitorStreamId || config.activeStreamId || '').trim();
    if (monitorTimer || !config.enabled || !String(config.message || '').trim()) return;
    monitorTimer = setInterval(() => {
      void monitorTick();
    }, PERSISTENT_PIN_MONITOR_INTERVAL_MS);
    console.log(`[Persistent Pin] Persistence monitor active (checks every ${Math.round(PERSISTENT_PIN_MONITOR_INTERVAL_MS / 1000)}s).`);
  }

  async function restoreIfUnpinned({ source = 'monitor', streamId = '' } = {}) {
    if (!config.enabled || !String(config.message || '').trim()) return { handled: false, reason: 'disabled' };
    if (typeof getPinnedChatMessage !== 'function') return { handled: false, reason: 'pin_api_unavailable' };

    return runExclusive(async () => {
      const current = await getPinnedChatMessage();
      const currentId = String(current?.message_id || '').trim();
      const targetMessageId = String(config.activeMessageId || '').trim();

      if (currentId) {
        if (currentId === targetMessageId) {
          displacedByMessageId = '';
          return { handled: false, reason: 'already_pinned', messageId: currentId };
        }
        if (displacedByMessageId !== currentId) {
          displacedByMessageId = currentId;
          console.log('[Persistent Pin] Another message is pinned; leaving it in place until it is removed or !repin is used.');
        }
        return { handled: false, reason: 'displaced', messageId: currentId };
      }

      displacedByMessageId = '';
      let messageId = targetMessageId;
      if (messageId) {
        try {
          await pinMessage(messageId);
          console.log(`[Persistent Pin] Restored persistent pin automatically (${source}).`);
          return { handled: true, messageId, reposted: false };
        } catch (err) {
          console.log(`[Persistent Pin] Saved message ID could not be restored; posting a fresh copy: ${err?.message || err}`);
        }
      }

      messageId = await postFreshConfiguredMessage(streamId || monitorStreamId || config.activeStreamId || '');
      await pinMessage(messageId);
      console.log(`[Persistent Pin] Posted a fresh copy and restored the persistent pin automatically (${source}).`);
      return { handled: true, messageId, reposted: true };
    });
  }

  async function monitorTick() {
    if (monitorBusy || operationBusy || !monitorTimer || !config.enabled) return;
    monitorBusy = true;
    try {
      const status = streamStatus();
      if (typeof getStreamStatus === 'function' && !status.live) {
        stopMonitor();
        return;
      }
      if (status.streamId) monitorStreamId = status.streamId;
      await restoreIfUnpinned({ source: 'monitor', streamId: monitorStreamId });
    } catch (err) {
      const now = Date.now();
      if (now - lastMonitorErrorLogAt >= MONITOR_ERROR_LOG_INTERVAL_MS) {
        lastMonitorErrorLogAt = now;
        console.warn('[Persistent Pin] Persistence monitor check failed; will retry:', err?.message || err);
      }
    } finally {
      monitorBusy = false;
    }
  }

  async function handleStreamOnline({ event = {} } = {}) {
    if (!config.enabled || !String(config.message || '').trim()) {
      return { handled: false, reason: 'not_configured' };
    }

    const streamId = String(event?.id || event?.stream_id || '').trim();
    if (streamId && streamId === String(config.activeStreamId || '') && config.activeMessageId) {
      startMonitor(streamId);
      return { handled: false, reason: 'already_handled' };
    }

    beginPinPriorityHold();
    let posted = false;
    try {
      const result = await runExclusive(async () => {
        try {
          // Persistent Stream Pin intentionally ignores global Automation Spacing.
          // It is the first stream-start automation and owns the priority gate until
          // its own post-pin hold expires.
          await persistRuntime({ activeStreamId: streamId, activeMessageId: '' });
          const messageId = await postFreshConfiguredMessage(streamId);
          posted = true;
          await removeCurrentPinIfDifferent(messageId);
          await pinMessage(messageId);
          startMonitor(streamId);
          console.log('[Persistent Pin] Stream-start message posted and pinned for the full stream.');
          return { handled: true, messageId, streamId };
        } catch (err) {
          console.error('[Persistent Pin] Stream-start pin failed:', err?.message || err);
          return { handled: false, reason: 'error', error: err?.message || String(err || '') };
        }
      });

      if (result?.handled) {
        await holdOtherAutomations();
      }
      return result;
    } finally {
      endPinPriorityHold();
      if (!posted && streamId && streamId !== String(config.activeStreamId || '')) {
        await persistRuntime({ activeStreamId: streamId, activeMessageId: '' }).catch(() => {});
      }
    }
  }

  async function handleStreamOffline() {
    stopMonitor();
    if (!config.activeStreamId && !config.activeMessageId) return { handled: false };
    try {
      await persistRuntime({ activeStreamId: '', activeMessageId: '' });
      return { handled: true };
    } catch (err) {
      console.warn('[Persistent Pin] Could not clear per-stream runtime state:', err?.message || err);
      return { handled: false, reason: 'error' };
    }
  }

  async function syncLiveState() {
    const status = streamStatus();
    if (!status.live) {
      stopMonitor();
      return { live: false };
    }
    if (!config.enabled || !String(config.message || '').trim()) {
      stopMonitor();
      return { live: true, enabled: false };
    }

    if (status.streamId && status.streamId !== String(config.activeStreamId || '')) {
      await persistRuntime({ activeStreamId: status.streamId, activeMessageId: '' });
    }
    startMonitor(status.streamId || config.activeStreamId || '');
    try {
      await restoreIfUnpinned({ source: 'startup_sync', streamId: status.streamId });
    } catch (err) {
      console.warn('[Persistent Pin] Startup live-state sync could not restore the pin yet:', err?.message || err);
    }
    return { live: true, enabled: true, streamId: status.streamId || config.activeStreamId || '' };
  }

  async function repin() {
    if (!String(config.message || '').trim()) {
      return { handled: false, reason: 'not_configured' };
    }

    // !repin is a built-in broadcaster/mod QoL command and is always available.
    // It is also a remote control for the UI Enabled checkbox.
    if (!config.enabled) await persistEnabled(true);

    const status = streamStatus();
    if (status.live && status.streamId && status.streamId !== String(config.activeStreamId || '')) {
      await persistRuntime({ activeStreamId: status.streamId, activeMessageId: '' });
    }
    if (status.live) startMonitor(status.streamId || config.activeStreamId || '');

    beginPinPriorityHold();
    try {
      const result = await runExclusive(async () => {
        try {
          let targetMessageId = String(config.activeMessageId || '').trim();
          await removeCurrentPinIfDifferent(targetMessageId);

          if (targetMessageId) {
            try {
              await pinMessage(targetMessageId);
              console.log('[Persistent Pin] !repin restored the configured stream message and enabled persistence.');
              return { handled: true, messageId: targetMessageId, reposted: false };
            } catch (err) {
              console.log(`[Persistent Pin] Saved message ID could not be re-pinned; posting a fresh copy: ${err?.message || err}`);
            }
          }

          targetMessageId = await postFreshConfiguredMessage(status.streamId || config.activeStreamId || '');
          await removeCurrentPinIfDifferent(targetMessageId);
          await pinMessage(targetMessageId);
          console.log('[Persistent Pin] !repin posted a fresh configured message, pinned it, and enabled persistence.');
          return { handled: true, messageId: targetMessageId, reposted: true };
        } catch (err) {
          console.error('[Persistent Pin] !repin failed:', err?.message || err);
          return { handled: false, reason: 'error' };
        }
      });
      if (result?.handled) await holdOtherAutomations();
      return result;
    } finally {
      endPinPriorityHold();
    }
  }

  async function unpin() {
    // !unpin is always available to broadcaster/mods. Disable persistence first so
    // the monitor cannot race the command and immediately put the pin back.
    if (config.enabled) await persistEnabled(false);
    else stopMonitor();

    return runExclusive(async () => {
      try {
        const current = typeof getPinnedChatMessage === 'function' ? await getPinnedChatMessage() : null;
        const currentId = String(current?.message_id || '').trim();
        if (!currentId) {
          console.log('[Persistent Pin] !unpin disabled persistence; nothing was currently pinned.');
          return { handled: true, reason: 'nothing_pinned' };
        }
        if (typeof unpinChatMessage !== 'function') throw new Error('Twitch pinned-chat API is unavailable.');
        await unpinChatMessage(currentId);
        console.log('[Persistent Pin] !unpin removed the current pin and disabled persistence.');
        return { handled: true, messageId: currentId };
      } catch (err) {
        console.error('[Persistent Pin] !unpin disabled persistence, but removing the current pin failed:', err?.message || err);
        return { handled: false, reason: 'error' };
      }
    });
  }

  return {
    initialize,
    getConfig: toClient,
    saveConfig,
    handleStreamOnline,
    handleStreamOffline,
    syncLiveState,
    repin,
    unpin,
    consumeOwnResponse,
    _monitorTick: monitorTick
  };
}

module.exports = {
  MAX_PERSISTENT_PIN_MESSAGE_LENGTH,
  DEFAULT_PERSISTENT_PIN_HOLD_SECONDS,
  MAX_PERSISTENT_PIN_HOLD_SECONDS,
  PERSISTENT_PIN_MONITOR_INTERVAL_MS,
  createPersistentPinManager,
  normalizeConfig
};
