// Database options must be configured before any module imports a model.
const { connectDatabase, disconnectDatabase, isDatabaseConnected, initializeDatabaseModels } = require('./services/database');

const express = require('express');
const path = require('path');
const { ADMIN_PATH, STREAM_TIME_ZONE, TWITCH_REDIRECT_URI, normalizeChannelName } = require('./config/app');

const { createRecapManager, SUMMARY_PREFIX } = require('./commands/recap');

const context = require('./services/reliability/context');
const delivery = require('./services/reliability/delivery');
const { initializeStore } = require('./services/reliability/store');
const { createRuntime } = require('./services/reliability/runtime');
const { createRateGate } = require('./services/reliability/rateGate');
const { canFallbackToIrc, deliveryError } = require('./services/reliability/twitchDelivery');
const { createTwitchConnectionController } = require('./services/twitchConnectionController');
const { createYouTubeManager } = require('./services/youtubeManager');
const { configureSharedRateGate, cancelAllGeminiRequests, getGeminiClientStatus, HARD_MAX_REQUESTS_PER_MINUTE } = require('./services/geminiClient');
const { stopTemporaryPinTimer } = require('./services/twitchChat');
const { createModSessionManager } = require('./middleware/modSession');
const { createTwitchMessageHandler } = require('./services/twitchMessageHandler');
const { createCustomCommandManager } = require('./services/customCommands');
const { createChatTimerManager } = require('./services/chatTimers');
const { createEventSubReactionManager } = require('./services/eventSubReactions');
const { createAutomationSpacingManager } = require('./services/automationSpacing');
const { createPersistentPinManager } = require('./services/persistentStreamPin');
const { createAdvancedFilterManager } = require('./services/advancedFilters');
const { createClipCommandManager } = require('./services/clipCommands');
const { REQUIRED_CLIPS_SCOPE } = require('./services/twitchClips');
const { getEventReactionHoldStatus } = require('./services/eventReactionHold');
const { getStreamLore } = require('./services/streamLore');
const { createBotPersonalityManager } = require('./services/botPersonality');
const { getRenderedNativeResponse } = require('./services/nativeCommandResponses');
const { ensureViewerProfileIndexes, purgeExpiredOptedOutProfiles } = require('./services/viewerProfiles');
const { REQUIRED_CHATTERS_SCOPE, getRandomChatters } = require('./services/twitchChatters');
const { REQUIRED_ANNOUNCEMENT_SCOPE, sendChatAnnouncement } = require('./services/twitchAnnouncements');
const {
  getPinnedChatMessage,
  pinChatMessage,
  sendChatMessageViaApi,
  startTemporaryChatPin,
  unpinChatMessage
} = require('./services/twitchChat');
const { ensureEventSubSubscriptions } = require('./services/twitchEventSub');

const { registerAuthRoutes } = require('./routes/auth');
const { registerChatRoutes } = require('./routes/chat');
const { registerCustomCommandRoutes } = require('./routes/customCommands');
const { registerTimerRoutes } = require('./routes/timers');
const { registerDashboardRoutes } = require('./routes/dashboard');
const { registerEventSubRoutes } = require('./routes/eventSub');
const { registerEventSubReactionRoutes } = require('./routes/eventSubReactions');
const { registerAutomationRoutes } = require('./routes/automation');
const { registerAdvancedFilterRoutes } = require('./routes/advancedFilters');
const { registerMemoryRoutes } = require('./routes/memory');
const { registerRecapRoutes } = require('./routes/recap');
const { registerNativeCommandRoutes } = require('./routes/nativeCommands');
const { registerReliabilityRoutes } = require('./routes/reliability');
const { registerYouTubeAuthRoutes } = require('./routes/youtubeAuth');
const { registerYouTubeRoutes } = require('./routes/youtube');

const app = express();
const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const QWERT_OAUTH_LINK_SECRET = (process.env.QWERT_OAUTH_LINK_SECRET || '').trim();
const TWITCH_CLIENT_ID = (process.env.TWITCH_CLIENT_ID || '').trim();
const TWITCH_CLIENT_SECRET = (process.env.TWITCH_CLIENT_SECRET || '').trim();
const TWITCH_OAUTH_SCOPES = ['chat:read', 'chat:edit', 'user:read:chat', 'user:write:chat', 'user:bot', 'moderator:manage:chat_messages', 'moderator:manage:shoutouts', REQUIRED_ANNOUNCEMENT_SCOPE, REQUIRED_CHATTERS_SCOPE, REQUIRED_CLIPS_SCOPE];
const TWITCH_BROADCASTER_SCOPES = [
  'channel:bot',
  'channel:read:subscriptions',
  'bits:read',
  'moderator:read:followers',
  'channel:read:hype_train',
  'channel:read:polls',
  'channel:read:predictions',
  'channel:read:redemptions',
  'channel:read:goals',
  'channel:read:ads',
  'moderator:read:shoutouts',
  'channel:read:vips',
  'channel:read:charity'
];
const OAUTH_STATE_LIFETIME = 10 * 60 * 1000;
const OAUTH_VALIDATION_INTERVAL = 50 * 60 * 1000;
const EVENTSUB_HEALTHY_ENSURE_INTERVAL = 60 * 60 * 1000;
const EVENTSUB_RETRY_ENSURE_INTERVAL = 5 * 60 * 1000;
const MOD_SESSION_COOKIE = 'sqwert_mod_session';
const MOD_SESSION_LIFETIME = 12 * 60 * 60 * 1000;
const MOD_SESSION_COOKIE_SECURE = Boolean(process.env.RENDER_SERVICE_ID || process.env.RENDER || process.env.NODE_ENV === 'production');
const FALLBACK_ACCESS_TOKEN = (process.env.TWITCH_BOT_ACCESS_TOKEN || '').replace(/^oauth:/i, '').trim();
const channelName = normalizeChannelName(process.env.TWITCH_CHANNEL);
const botUsername = (process.env.TWITCH_BOT_USERNAME || '').toLowerCase().trim();

app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); }
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/webui', express.static(path.join(__dirname, 'webui')));

if (!QWERT_OAUTH_LINK_SECRET) {
  console.warn('[Startup] QWERT_OAUTH_LINK_SECRET is not set. Private Qwert broadcaster authorization will be unavailable.');
}

let runtime = null;
let eventSubInbox = null;
let server = null;
let shutdownPromise = null;
let retentionTimer = null;
let recapManager = null;
let customCommandManager = null;
let chatTimerManager = null;
let eventSubReactionManager = null;
let automationSpacingManager = null;
let advancedFilterManager = null;
let persistentPinManager = null;
let clipCommandManager = null;
let botPersonalityManager = null;
let twitchMessageHandler = null;
let youtubeManager = null;

const twitchConnection = createTwitchConnectionController({
  channelName,
  botUsername,
  fallbackAccessToken: FALLBACK_ACCESS_TOKEN,
  oauthValidationIntervalMs: OAUTH_VALIDATION_INTERVAL,
  isDatabaseConnected,
  getRuntime: () => runtime,
  getRecapManager: () => recapManager,
  getMessageHandler: () => twitchMessageHandler
});

const shouldFallbackToIrc = canFallbackToIrc;

const chatClientProxy = {
  async say(channel, message, options = {}) {
    await context.assertOperation();
    const scopedKey = context.nextDeliveryKey('chat');
    if (scopedKey) return (await delivery.deliver({ key: scopedKey, kind: 'event-chat',
      payload: { channel, message, options }, send: (saved) => chatClientProxy.say(saved.channel, saved.message, saved.options) })).result;
    const normalizedChannel = String(channel || '').replace(/^#/, '').toLowerCase();
    if (normalizedChannel && normalizedChannel !== channelName) {
      throw new Error(`${botUsername || 'The bot'} is configured to send only to #${channelName}.`);
    }

    const wantsTemporaryPin = options?.temporaryPin === true;
    let previousPin = null;
    let pinSnapshotReady = false;

    if (wantsTemporaryPin && isDatabaseConnected()) {
      try {
        previousPin = await getPinnedChatMessage();
        pinSnapshotReady = true;
      } catch (pinErr) {
        console.warn(`[Recap Pins] Could not read the current pinned message before the recap. The recap will still send, but it will not be temporarily pinned: ${pinErr?.message || pinErr}`);
      }
    }

    try {
      if (!isDatabaseConnected()) {
        throw deliveryError('MongoDB is unavailable; chat sending has been paused to prevent untracked sends.');
      }

      const result = await sendChatMessageViaApi(message, { replyParentMessageId: options?.replyParentMessageId || null });

      console.log('[Chat] Message sent through Twitch Chat API.');

      if (wantsTemporaryPin && pinSnapshotReady && result?.message_id) {
        // Receipt first. Ancillary pinning must not delay the durable recap
        // commit or make a successful chat send appear to have failed.
        void startTemporaryChatPin({
          messageId: result.message_id,
          previousPin,
          displaySeconds: 60,
          onRestoreComplete: () => persistentPinManager?.reconcileNow?.('recap_end')
        }).catch((err) => console.warn('[Recap Pins] Chat was sent; temporary pinning failed:', err.message));
      }

      return {
        method: 'chat_api',
        fallback: false,
        result
      };
    } catch (err) {
      if (!shouldFallbackToIrc(err)) {
        throw err;
      }

      return twitchConnection.sendViaIrcFallback(channel, message, err, options);
    }
  }
};

const modSessionManager = createModSessionManager({
  password: DASHBOARD_PASSWORD,
  cookieName: MOD_SESSION_COOKIE,
  lifetimeMs: MOD_SESSION_LIFETIME,
  secureCookie: MOD_SESSION_COOKIE_SECURE
});

const requireModSession = modSessionManager.requireSession;

youtubeManager = createYouTubeManager({ channelKey: channelName || 'generalqwert' });

automationSpacingManager = createAutomationSpacingManager({ channelName });

advancedFilterManager = createAdvancedFilterManager({
  channelName,
  getStreamStatus: () => recapManager?.getStatus?.() || {}
});

persistentPinManager = createPersistentPinManager({
  channelName,
  sendMessageViaApi: (message) => sendChatMessageViaApi(message),
  getPinnedChatMessage,
  pinChatMessage,
  unpinChatMessage,
  beginPriorityAutomationHold: (engine) => automationSpacingManager?.beginPriorityHold?.(engine),
  endPriorityAutomationHold: (engine) => automationSpacingManager?.endPriorityHold?.(engine),
  getStreamStatus: () => recapManager?.getStatus?.() || {},
  getAdvancedFilterById: (id) => advancedFilterManager?.getFilterById?.(id) || null,
  evaluateAdvancedFilter: (id, status) => advancedFilterManager?.evaluateById?.(id, status) || { exists: false, matched: false, filterId: String(id || '') }
});

customCommandManager = createCustomCommandManager({
  channelName,
  sendMessage: (channel, message, options = {}) => chatClientProxy.say(channel, message, options),
  sendAnnouncement: (message, options) => sendChatAnnouncement(message, options),
  getRandomChatters: (count) => getRandomChatters({ count, excludeLogins: [botUsername] })
});

chatTimerManager = createChatTimerManager({
  channelName,
  sendMessage: (channel, message, options = {}) => chatClientProxy.say(channel, message, options),
  sendAnnouncement: (message, options) => sendChatAnnouncement(message, options),
  getStreamStatus: () => recapManager?.getStatus?.() || {},
  getRandomChatters: (count) => getRandomChatters({ count, excludeLogins: [botUsername] }),
  getEventReactionHoldStatus,
  getAutomationSpacingStatus: (engine) => automationSpacingManager?.getStatus?.(engine) || { active: false },
  tryReserveAutomationSlot: (engine) => automationSpacingManager?.tryReserve?.(engine) || Promise.resolve({ allowed: true }),
  getAdvancedFilterById: (id) => advancedFilterManager?.getFilterById?.(id) || null,
  evaluateAdvancedFilter: (id, status) => advancedFilterManager?.evaluateById?.(id, status) || { exists: false, matched: false, filterId: String(id || '') }
});

eventSubReactionManager = createEventSubReactionManager({
  channelName,
  sendMessage: (channel, message, options = {}) => chatClientProxy.say(channel, message, options),
  sendAnnouncement: (message, options) => sendChatAnnouncement(message, options),
  getBotAccessToken: twitchConnection.getBotAccessToken,
  getCustomCommandManager: () => customCommandManager,
  noteAutomationSend: (engine) => automationSpacingManager?.noteAutomation?.(engine) || Promise.resolve(),
  getAutomationSpacingSeconds: () => automationSpacingManager?.getSettings?.().minimumSpacingSeconds || 0,
  getAutomationSpacingStatus: (engine) => automationSpacingManager?.getStatus?.(engine) || { active: false },
  getStreamStatus: () => recapManager?.getStatus?.() || {}
});

botPersonalityManager = createBotPersonalityManager({
  channelName,
  botUsername,
  sendMessage: (channel, message, options) => chatClientProxy.say(channel, message, options),
  getStreamLore,
  getStreamContext: () => {
    const status = recapManager?.getStatus?.() || {};
    return {
      statusKnown: Boolean(status.streamStateInitialized),
      streamLive: Boolean(status.streamLive),
      title: status.currentStreamTitle || '',
      category: status.currentStreamCategory || '',
      currentStreamStartedAt: status.twitchStreamStartedAt || null,
      lastStreamEndedAt: status.lastStreamEndedAt || null,
      lastStreamEndedAgoMs: status.lastStreamEndedAgoMs ?? null,
      streamTimezone: status.streamTimezone || STREAM_TIME_ZONE
    };
  },
  getSessionMemoryContext: (request) => recapManager?.getSessionMemoryContext?.(request) || { text: '' },
  getCurrentChatRecords: () => recapManager?.getCurrentWindowLogs?.({ structured: true, includeBotContext: true }) || [],
  getCurrentEventRecords: () => recapManager?.getCurrentWindowEvents?.({ structured: true }) || []
});

clipCommandManager = createClipCommandManager({
  channelName,
  sendMessage: (channel, message, options = {}) => chatClientProxy.say(channel, message, options),
  getNativeCommandResponse: (command, variant, variables) => getRenderedNativeResponse(channelName, command, variant, variables)
});

twitchMessageHandler = createTwitchMessageHandler({
  getRecapManager: () => recapManager,
  getCustomCommandManager: () => customCommandManager,
  getChatTimerManager: () => chatTimerManager,
  getBotPersonalityManager: () => botPersonalityManager,
  getPersistentPinManager: () => persistentPinManager,
  getClipCommandManager: () => clipCommandManager,
  getNativeCommandResponse: (command, variant, variables) => getRenderedNativeResponse(channelName, command, variant, variables),
  sendMessage: (channel, message, options = {}) => chatClientProxy.say(channel, message, options),
  botUsername,
  summaryPrefix: SUMMARY_PREFIX
});

app.use((req, res, next) => {
  const exempt = req.path.startsWith('/auth/') || req.path === '/eventsub/twitch' || req.path === '/mod-login' || req.path === '/mod-logout';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !exempt && !runtime?.canServeControls()) {
    return res.status(503).json({ success: false, error: 'Bot is starting, stopping, or waiting for the active deployment to hand over. No control change was applied.', runtime: runtime?.status() });
  }
  return context.runOperation(next);
});

eventSubInbox = registerEventSubRoutes(app, {
  channelName,
  getRecapManager: () => recapManager,
  getEventSubReactionManager: () => eventSubReactionManager,
  getPersistentPinManager: () => persistentPinManager
});

registerDashboardRoutes(app, {
  requireModSession,
  modSessionManager,
  dashboardPassword: DASHBOARD_PASSWORD,
  modSessionLifetimeMs: MOD_SESSION_LIFETIME,
  channelName,
  botUsername,
  twitchClientId: TWITCH_CLIENT_ID,
  twitchClientSecret: TWITCH_CLIENT_SECRET,
  botScopes: TWITCH_OAUTH_SCOPES,
  broadcasterScopes: TWITCH_BROADCASTER_SCOPES,
  getRecapManager: () => recapManager,
  getRuntimeStatus: () => runtime?.status() || {},
  getBotPersonalityManager: () => botPersonalityManager,
  getDatabaseConnected: () => isDatabaseConnected(),
  getBotConnected: () => twitchConnection.isConnected(),
  getUsingMongoOAuth: () => twitchConnection.isUsingMongoOAuth(),
  getYouTubeManager: () => youtubeManager,
  viewsDir: path.join(__dirname, 'views'),
  adminPath: ADMIN_PATH
});

registerMemoryRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => isDatabaseConnected(),
  getBotPersonalityManager: () => botPersonalityManager,
  getRecapManager: () => recapManager,
  channelName
});

registerRecapRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => isDatabaseConnected(),
  getRecapManager: () => recapManager,
  channelName
});

registerAuthRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => isDatabaseConnected(),
  setUsingMongoOAuth: (value) => twitchConnection.setUsingMongoOAuth(value),
  reconnectTwitchClient: twitchConnection.reconnect,
  channelName,
  botUsername,
  clientId: TWITCH_CLIENT_ID,
  clientSecret: TWITCH_CLIENT_SECRET,
  redirectUri: TWITCH_REDIRECT_URI,
  botScopes: TWITCH_OAUTH_SCOPES,
  broadcasterScopes: TWITCH_BROADCASTER_SCOPES,
  qwertOAuthLinkSecret: QWERT_OAUTH_LINK_SECRET,
  oauthStateLifetimeMs: OAUTH_STATE_LIFETIME,
  adminPath: ADMIN_PATH
});

registerCustomCommandRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => isDatabaseConnected(),
  getCustomCommandManager: () => customCommandManager
});

registerTimerRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => isDatabaseConnected(),
  getChatTimerManager: () => chatTimerManager,
  getPersistentPinManager: () => persistentPinManager
});

registerAutomationRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => isDatabaseConnected(),
  getAutomationSpacingManager: () => automationSpacingManager
});

registerAdvancedFilterRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => isDatabaseConnected(),
  getAdvancedFilterManager: () => advancedFilterManager
});

registerEventSubReactionRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => isDatabaseConnected(),
  getEventSubReactionManager: () => eventSubReactionManager,
  getPersistentPinManager: () => persistentPinManager
});


registerNativeCommandRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => isDatabaseConnected(),
  getClipCommandManager: () => clipCommandManager,
  channelName
});

registerYouTubeAuthRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => isDatabaseConnected(),
  youtubeManager,
  adminPath: ADMIN_PATH
});

registerYouTubeRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => isDatabaseConnected(),
  youtubeManager,
  channelKey: channelName || 'generalqwert',
  viewsDir: path.join(__dirname, 'views')
});

registerChatRoutes(app, {
  requireModSession,
  channelName,
  chatClientProxy
});

async function initializeYouTubeFailOpen(context = 'startup') {
  try {
    await youtubeManager?.initialize?.();
    return true;
  } catch (err) {
    console.warn(`[YouTube] ${context} failed; Twitch will continue normally:`, err?.message || err);
    return false;
  }
}

async function syncYouTubeFailOpen(streamStatus, context = 'live-state sync') {
  try {
    await youtubeManager?.syncTwitchLiveState?.({
      live: Boolean(streamStatus?.streamLive),
      known: Boolean(streamStatus?.streamStateInitialized)
    });
    return true;
  } catch (err) {
    console.warn(`[YouTube] ${context} failed; Twitch will continue normally:`, err?.message || err);
    return false;
  }
}

async function activateBot() {
  await automationSpacingManager.initialize();
  await advancedFilterManager.initialize();
  await persistentPinManager.initialize();
  await customCommandManager.initialize();
  await eventSubReactionManager.initialize();
  await botPersonalityManager.initialize();
  await initializeYouTubeFailOpen('initialization');
  recapManager = createRecapManager({
    client: chatClientProxy, channelName, getTwitchAccessToken: twitchConnection.getBotAccessToken,
    refreshTwitchAccessToken: twitchConnection.refreshBotAccessToken, validateTwitchAccessToken: twitchConnection.validateAnyBotToken,
    getSessionMemoryConfig: () => botPersonalityManager?.getConfig?.()?.sessionMemory || {},
    getEventReactionHoldStatus,
    getTaggedQuestionRecapBufferStatus: () => botPersonalityManager?.getRecapCollisionStatus?.() || { active: false },
    getAutomationSpacingStatus: (engine) => automationSpacingManager?.getStatus?.(engine) || { active: false },
    tryReserveAutomationSlot: (engine) => automationSpacingManager?.tryReserve?.(engine) || Promise.resolve({ allowed: false }),
    getNativeCommandResponse: (command, variant, variables) => getRenderedNativeResponse(channelName, command, variant, variables),
    botUsername
  });
  await chatTimerManager.initialize();
  // Detection remains restartable even if initial OAuth/IRC is unavailable.
  await recapManager.start();
  {
    const streamStatus = recapManager.getStatus();
    await syncYouTubeFailOpen(streamStatus, 'startup live-state sync');
  }
  const accessToken = await twitchConnection.resolveStartupToken();
  if (accessToken) {
    try { await twitchConnection.createAndConnect(accessToken); }
    catch (err) { console.warn('[Bot] Initial chat connection failed; automatic recovery will retry:', err.message); }
  }
  eventSubInbox.start();
  try { await persistentPinManager.syncLiveState(); }
  catch (err) { console.warn('[Persistent Pin] Startup sync pending:', err.message); }
  try { await runEventSubEnsure(); }
  catch (err) { console.warn('[EventSub] Subscription setup pending:', err.message); }
  twitchConnection.startOAuthValidationLoop();
  try { await purgeExpiredOptedOutProfiles(channelName); }
  catch (err) { console.warn('[Retention] Startup purge pending:', err.message); }
  retentionTimer = setInterval(() => {
    if (runtime.isActive()) void purgeExpiredOptedOutProfiles(channelName).catch((err) => console.warn('[Retention]', err.message));
  }, 6 * 60 * 60000);
}

function eventSubEnsureHealthy(results) {
  return Array.isArray(results) && results.length > 0 && results.every((item) => {
    if (!item || item.status === 'error') return false;
    if (item.status === 'skipped_missing_scope') return item.optional === true;
    return true;
  });
}

async function runEventSubEnsure() {
  // Record every attempt, including startup failures. This prevents the 30-second
  // runtime maintenance loop from immediately repeating the same ensure call.
  maintainBot.lastEnsure = Date.now();
  try {
    const results = await ensureEventSubSubscriptions();
    maintainBot.lastEnsureHealthy = eventSubEnsureHealthy(results);
    return results;
  } catch (err) {
    maintainBot.lastEnsureHealthy = false;
    throw err;
  }
}

async function maintainBot() {
  if (!runtime.isActive()) return;
  await twitchConnection.maintainConnection();
  {
    const streamStatus = recapManager?.getStatus?.() || {};
    await syncYouTubeFailOpen(streamStatus, 'maintenance live-state sync');
  }

  // Healthy EventSub subscriptions only need a periodic reconciliation. Missing
  // optional scopes are expected and do not trigger the five-minute retry loop;
  // actual errors or missing required scopes do.
  const ensureInterval = maintainBot.lastEnsureHealthy
    ? EVENTSUB_HEALTHY_ENSURE_INTERVAL
    : EVENTSUB_RETRY_ENSURE_INTERVAL;
  if (!maintainBot.lastEnsure || Date.now() - maintainBot.lastEnsure >= ensureInterval) {
    try { await runEventSubEnsure(); }
    catch (err) { console.warn('[EventSub] Setup retry pending:', err.message); }
  }
}

runtime = createRuntime({ key: `bot:${channelName}:${botUsername}`, connect: connectDatabase,
  isConnected: isDatabaseConnected,
  initialize: async () => {
    await initializeStore();
    await initializeDatabaseModels();
    await ensureViewerProfileIndexes();
  },
  activate: activateBot,
  maintenance: maintainBot,
  quiesce: () => {
    twitchConnection.quiesce(); clearInterval(retentionTimer);
    recapManager?.quiesce(); chatTimerManager?.quiesce(); persistentPinManager?.quiesce();
    void youtubeManager?.quiesce?.();
    eventSubInbox?.quiesce(); stopTemporaryPinTimer(); cancelAllGeminiRequests();
  },
  flush: async ({ persist }) => {
    const work = [eventSubInbox?.stop(), youtubeManager?.shutdown?.()];
    if (persist) { work.push(recapManager?.shutdown({ persist: true }), chatTimerManager?.shutdown()); }
    const results = await Promise.allSettled(work);
    for (const result of results) if (result.status === 'rejected') console.error('[Shutdown] Durable flush failed:', result.reason?.message);
    await twitchConnection.disconnect();
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, 'One or more shutdown checkpoints failed.');
  },
  disconnect: disconnectDatabase,
  fatal: (err) => { console.error('[Runtime] Stopping unsafe instance:', err.message); void requestShutdown('runtime ownership failure', 1, false); }
});
context.configureRuntime(runtime);
configureSharedRateGate(createRateGate({ key: process.env.GEMINI_API_KEY || 'unconfigured', limit: HARD_MAX_REQUESTS_PER_MINUTE }));

registerReliabilityRoutes(app, {
  requireModSession,
  channelName,
  getRuntime: () => runtime,
  getChatTimerManager: () => chatTimerManager,
  getRecapManager: () => recapManager,
  getPersistentPinManager: () => persistentPinManager,
  getEventSubInbox: () => eventSubInbox
});

app.use((err, req, res, next) => {
  console.error('[WebUI] Request failed:', err.message);
  if (res.headersSent) return next(err);
  res.status(err.cancelled ? 409 : err.persistenceFailure ? 503 : 500).json({
    success: false, error: err.message || 'Request failed.', deliveryUnknown: err.deliveryState === 'UNKNOWN'
  });
});

function requestShutdown(reason, exitCode = 0, persist = true) {
  if (shutdownPromise) return shutdownPromise;
  console.log(`[Shutdown] ${reason}: stopping new work and flushing durable state.`);
  // Render normally allows 30 seconds. Exit before its hard kill; receipts for
  // interrupted sends remain quarantined rather than guessed on next startup.
  const deadline = setTimeout(() => { console.error('[Shutdown] 25-second drain deadline reached.'); process.exit(exitCode || 1); }, 25000);
  shutdownPromise = (async () => {
    try { await runtime.stop({ persist }); }
    catch (err) { console.error('[Shutdown] Cleanup failed:', err.message); exitCode = 1; }
    if (server) server.close();
    clearTimeout(deadline);
    process.exit(exitCode);
  })();
  return shutdownPromise;
}
process.once('SIGTERM', () => { void requestShutdown('SIGTERM'); });
process.once('SIGINT', () => { void requestShutdown('SIGINT'); });
process.on('unhandledRejection', (reason) => { console.error('[Process] Unhandled rejection:', reason); void requestShutdown('unhandled rejection', 1); });
process.on('uncaughtException', (err) => { console.error('[Process] Uncaught exception:', err); void requestShutdown('uncaught exception', 1); });

server = app.listen(PORT, () => {
  console.log(`[Startup] Web server on ${PORT}; waiting for the Mongo-backed bot lease.`);
  const geminiStatus = getGeminiClientStatus();
  console.log(`[Startup] Gemini default/recap writer: ${geminiStatus.model}; hourly recap premium editor: ${geminiStatus.recapEditorModel} (QwertBot cap ${geminiStatus.recapEditorDailyLimit}/day, one editor attempt per recap, no premium retry); global ${HARD_MAX_REQUESTS_PER_MINUTE}-RPM pacing enabled (${geminiStatus.requestSpacingMs}ms minimum request spacing).`);
  console.log('[Startup] Reliability build: durable sends, inbox, graceful shutdown, recap-control split.');
});
runtime.start();
