'use strict';

// Both platforms use the same scheduler, rotation, validation, receipts and
// CRUD behavior. Only provider-specific state and delivery live in this adapter.
const YouTubeChatTimer = require('../models/YouTubeChatTimer');
const { reviewTimerDestinations } = require('./youtubeTimerDelivery');
const { createChatTimerManager } = require('./chatTimers');

function createYouTubeTimerManager({ channelKey, sendToAllChats, isEnabled = () => true,
  getGlobalStartDelaySeconds = () => 0, saveGlobalStartDelaySeconds = async () => {},
  getSessionStartedAtMs = () => 0, getStreamStatus = () => ({}),
  getAdvancedFilterById, evaluateAdvancedFilter, getViewerCount = async () => ({ count: 0, available: false }),
  canCountMessages = () => true, getDeliveryMetadata = () => ({}) }) {
  let active = false;
  let initialization = null;
  let viewer = { count: 0, available: false };
  let viewerRetryAt = 0;
  const core = createChatTimerManager({
    channelName: channelKey, platform: 'youtube', TimerModel: YouTubeChatTimer, channelField: 'channelKey', maxResponseLength: 200,
    isEnabled: () => active && isEnabled(), canCountMessages,
    getSettingsOverrides: () => ({ globalStartDelaySeconds: getGlobalStartDelaySeconds() }),
    persistSettingsOverrides: (s) => saveGlobalStartDelaySeconds(s.globalStartDelaySeconds),
    getStreamStatus: () => {
      const s = getStreamStatus() || {};
      return { ...s, streamLive: active && isEnabled(),
        currentStreamId: String(s.currentStreamId || s.streamId || (getSessionStartedAtMs() ? `session-${getSessionStartedAtMs()}` : '')),
        twitchStreamStartedAt: Number(getSessionStartedAtMs() || s.twitchStreamStartedAt || s.startedAt || 0),
        currentViewerCount: viewer.count, viewerCountAvailable: viewer.available };
    },
    getAdvancedFilterById, evaluateAdvancedFilter,
    beforeTick: async () => {
      if (Date.now() < viewerRetryAt) return;
      try { viewer = await getViewerCount(); viewerRetryAt = 0; }
      catch (err) {
        viewer = { count: 0, available: false }; viewerRetryAt = Date.now() + 60000;
        console.warn(`[YouTube Timers] Viewer count unavailable; waiting 60s before another lookup: ${err.message}`);
      }
    },
    getDeliveryMetadata, reviewDeliveryChildren: reviewTimerDestinations,
    sendMessage: (channel, text, options) => sendToAllChats(text, {
      kind: 'timer', strictConfirmed: true, ...options
    })
  });
  async function initialize() {
    if (!initialization) initialization = core.initialize().catch((err) => { initialization = null; throw err; });
    return initialization;
  }
  return {
    ...core,
    initialize,
    reload: async () => { await initialize(); return core.refreshCache(); },
    startSession: async () => { active = true; await initialize(); await core.refreshCache(); },
    stopSession: () => { active = false; viewer = { count: 0, available: false }; viewerRetryAt = 0; },
    noteChatMessage: (count = 1) => { if (active && canCountMessages()) for (let i = 0; i < Math.max(0, Math.floor(count)); i++) core.recordViewerActivity(); },
    applyGlobalStartDelay: () => core.reloadSettings(),
    shutdown: async () => { active = false; await core.shutdown(); initialization = null; }
  };
}
module.exports = { createYouTubeTimerManager };
