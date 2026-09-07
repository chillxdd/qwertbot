// Database options must be configured before any module imports a model.
const { connectDatabase, disconnectDatabase, isDatabaseConnected, initializeDatabaseModels } = require('./services/database');

const express = require('express');
const tmi = require('tmi.js');
const path = require('path');

const { createRecapManager, SUMMARY_PREFIX, TWITCH_MESSAGE_LIMIT } = require('./commands/recap');

const context = require('./services/reliability/context');
const delivery = require('./services/reliability/delivery');
const { initializeStore, collection } = require('./services/reliability/store');
const { createRuntime } = require('./services/reliability/runtime');
const { createRateGate } = require('./services/reliability/rateGate');
const { canFallbackToIrc, deliveryError } = require('./services/reliability/twitchDelivery');
const { configureSharedRateGate, cancelAllGeminiRequests } = require('./services/geminiClient');
const { stopTemporaryPinTimer } = require('./services/twitchChat');
const { getGeminiClientStatus } = require('./services/geminiClient');
const { createModSessionManager } = require('./middleware/modSession');
const { createTwitchMessageHandler } = require('./services/twitchMessageHandler');
const { createCustomCommandManager } = require('./services/customCommands');
const { createChatTimerManager } = require('./services/chatTimers');
const { createEventSubReactionManager } = require('./services/eventSubReactions');
const { createAutomationSpacingManager } = require('./services/automationSpacing');
const { createPersistentPinManager } = require('./services/persistentStreamPin');
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
  getAccessToken,
  getStoredAuth,
  getValidAccessToken,
  refreshStoredToken,
  validateAccessToken
} = require('./services/twitchAuth');

const { getValidBroadcasterAccessToken } = require('./services/twitchBroadcasterAuth');
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
const { registerMemoryRoutes } = require('./routes/memory');
const { registerRecapRoutes } = require('./routes/recap');
const { registerNativeCommandRoutes } = require('./routes/nativeCommands');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PATH = '/hailfatcloud';

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const QWERT_OAUTH_LINK_SECRET = (process.env.QWERT_OAUTH_LINK_SECRET || '').trim();
const TWITCH_CLIENT_ID = (process.env.TWITCH_CLIENT_ID || '').trim();
const TWITCH_CLIENT_SECRET = (process.env.TWITCH_CLIENT_SECRET || '').trim();
const TWITCH_REDIRECT_URI = 'https://sqwertarmybot.onrender.com/auth/twitch/callback';
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
const MOD_SESSION_COOKIE = 'sqwert_mod_session';
const MOD_SESSION_LIFETIME = 12 * 60 * 60 * 1000;
const MOD_SESSION_COOKIE_SECURE = Boolean(process.env.RENDER_SERVICE_ID || process.env.RENDER || process.env.NODE_ENV === 'production');
const FALLBACK_ACCESS_TOKEN = (process.env.TWITCH_BOT_ACCESS_TOKEN || '').replace(/^oauth:/i, '').trim();
const channelName = (process.env.TWITCH_CHANNEL || '').toLowerCase().trim();
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

let botConnected = false;
let runtime = null;
let eventSubInbox = null;
let server = null;
let shutdownPromise = null;
let retentionTimer = null;
let usingMongoOAuth = false;
let twitchClient = null;
let recapManager = null;
let customCommandManager = null;
let chatTimerManager = null;
let eventSubReactionManager = null;
let automationSpacingManager = null;
let persistentPinManager = null;
let clipCommandManager = null;
let botPersonalityManager = null;
let twitchReconnectInProgress = false;
let twitchAuthRecoveryInProgress = false;
let twitchAuthRecoveryTimer = null;
let oauthValidationTimer = null;
let twitchConnectionGeneration = 0;

const shouldFallbackToIrc = canFallbackToIrc;

async function sendViaIrcFallback(channel, message, apiError, options = {}) {
  if (!twitchClient || !botConnected) {
    throw apiError;
  }

  const normalizedChannel = String(channel || '').replace(/^#/, '').toLowerCase();
  const targetChannel = normalizedChannel || channelName;

  console.warn(
    `[Chat] Chat API unavailable (${apiError?.message || apiError}). Falling back to IRC for this message.`
  );

  let fallbackMessage = String(message || '').trim();
  const fallbackLogin = String(options?.fallbackMentionLogin || '').replace(/^@+/, '').toLowerCase().trim();
  const fallbackDisplayName = String(options?.fallbackMentionDisplayName || '').replace(/^@+/, '').trim();
  const fallbackTarget = fallbackLogin || fallbackDisplayName;
  if (options?.replyParentMessageId && fallbackTarget) {
    const mentionPattern = new RegExp(`^@${String(fallbackTarget).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|\\s|[,:-])`, 'i');
    if (!mentionPattern.test(fallbackMessage)) fallbackMessage = `@${fallbackTarget} ${fallbackMessage}`.trim();
  }
  fallbackMessage = Array.from(fallbackMessage).slice(0, TWITCH_MESSAGE_LIMIT).join('').trim();

  await context.assertOperation();
  try { await twitchClient.say(targetChannel, fallbackMessage); }
  catch (cause) { throw deliveryError('IRC send outcome is unknown; it will not be retried automatically.', { state: 'UNKNOWN', cause }); }

  console.log('[Chat] Message sent through IRC fallback. Bot badge will not apply to this message.');

  return {
    method: 'irc_fallback',
    fallback: true,
    apiError: apiError?.message || String(apiError || '')
  };
}

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

      return sendViaIrcFallback(channel, message, err, options);
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

automationSpacingManager = createAutomationSpacingManager({ channelName });

persistentPinManager = createPersistentPinManager({
  channelName,
  sendMessageViaApi: (message) => sendChatMessageViaApi(message),
  getPinnedChatMessage,
  pinChatMessage,
  unpinChatMessage,
  beginPriorityAutomationHold: (engine) => automationSpacingManager?.beginPriorityHold?.(engine),
  endPriorityAutomationHold: (engine) => automationSpacingManager?.endPriorityHold?.(engine),
  getStreamStatus: () => recapManager?.getStatus?.() || {}
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
  tryReserveAutomationSlot: (engine) => automationSpacingManager?.tryReserve?.(engine) || Promise.resolve({ allowed: true })
});

eventSubReactionManager = createEventSubReactionManager({
  channelName,
  sendMessage: (channel, message, options = {}) => chatClientProxy.say(channel, message, options),
  sendAnnouncement: (message, options) => sendChatAnnouncement(message, options),
  getBotAccessToken,
  getCustomCommandManager: () => customCommandManager,
  noteAutomationSend: (engine) => automationSpacingManager?.noteAutomation?.(engine) || Promise.resolve(),
  getAutomationSpacingSeconds: () => automationSpacingManager?.getSettings?.().minimumSpacingSeconds || 0,
  getAutomationSpacingStatus: (engine) => automationSpacingManager?.getStatus?.(engine) || { active: false }
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
      streamTimezone: status.streamTimezone || 'America/Los_Angeles'
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

const twitchMessageHandler = createTwitchMessageHandler({
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

async function getBotAccessToken() {
  try {
    const stored = await getAccessToken();
    if (stored) {
      usingMongoOAuth = true;
      return stored;
    }
  } catch (err) {
    console.error('[OAuth Bot] Failed to read stored Twitch token:', err.message || err);
  }

  usingMongoOAuth = false;
  return FALLBACK_ACCESS_TOKEN || null;
}

async function refreshBotAccessToken() {
  const refreshed = await refreshStoredToken();
  usingMongoOAuth = true;
  return refreshed;
}

async function validateAnyBotToken(token) {
  return validateAccessToken(token);
}

function isIrcAuthenticationFailure(reason) {
  const text = String(reason || '').toLowerCase();
  return text.includes('login authentication failed') || text.includes('improperly formatted auth');
}

function clearTwitchAuthRecoveryTimer() {
  if (twitchAuthRecoveryTimer) {
    clearTimeout(twitchAuthRecoveryTimer);
    twitchAuthRecoveryTimer = null;
  }
}

async function recoverTwitchIrcAuthentication(reason = 'IRC authentication failure') {
  if (!runtime?.isActive() || !usingMongoOAuth || twitchAuthRecoveryInProgress) return;

  twitchAuthRecoveryInProgress = true;
  clearTwitchAuthRecoveryTimer();

  try {
    console.warn(`[OAuth Bot] ${reason}. Validating the stored bot token and refreshing it if needed.`);

    // If MongoDB already contains a newer valid token, use it. Otherwise a 401
    // from /validate automatically refreshes the token and saves the rotated
    // access + refresh token pair before we reconnect tmi.js.
    const accessToken = await getValidAccessToken({ allowRefresh: true });
    if (!accessToken) throw new Error('No MongoDB Twitch bot authorization is available.');

    usingMongoOAuth = true;
    await reconnectTwitchClient(reason, { accessToken });
    console.log('[OAuth Bot] IRC authentication recovery completed successfully.');
  } catch (err) {
    console.error('[OAuth Bot] IRC authentication recovery failed:', err.message || err);

    // A revoked/invalid refresh token genuinely requires consent again. Do not
    // hammer Twitch in that case. Transient network/5xx failures get one delayed
    // retry path so the bot can heal without manual intervention.
    if (!err?.reauthorizationRequired) {
      twitchAuthRecoveryTimer = setTimeout(() => {
        twitchAuthRecoveryTimer = null;
        recoverTwitchIrcAuthentication('retry after IRC authentication failure').catch((retryErr) => {
          console.error('[OAuth Bot] Delayed IRC authentication recovery failed:', retryErr.message || retryErr);
        });
      }, 15000);
      console.warn('[OAuth Bot] IRC authentication recovery will retry in 15 seconds.');
    } else {
      console.error('[OAuth Bot] Twitch reports that the bot authorization itself is no longer refreshable. Manual bot reauthorization is required.');
    }
  } finally {
    twitchAuthRecoveryInProgress = false;
  }
}

async function validateStoredOAuthSessions() {
  if (!isDatabaseConnected() || !runtime?.isActive()) return;

  try {
    const before = await getStoredAuth();
    const validBotToken = await getValidAccessToken({ allowRefresh: true });
    const after = await getStoredAuth();

    if (validBotToken) {
      usingMongoOAuth = true;
      console.log('[OAuth Bot] Hourly token validation succeeded.');

      // If validation had to refresh the token, rebuild the IRC client with the
      // newly stored token now instead of waiting for Twitch to force a RECONNECT.
      if (before?.accessToken && after?.accessToken && before.accessToken !== after.accessToken) {
        await reconnectTwitchClient('hourly OAuth refresh', { accessToken: after.accessToken });
      }
    }
  } catch (err) {
    if (err?.reauthorizationRequired) {
      console.error('[OAuth Bot] Authorization can no longer be refreshed. Manual bot reauthorization is required.');
    } else {
      console.warn('[OAuth Bot] Hourly token validation failed:', err.message || err);
    }
  }

  try {
    const broadcasterToken = await getValidBroadcasterAccessToken({ allowRefresh: true });
    if (broadcasterToken) {
      console.log('[OAuth Broadcaster] Hourly token validation succeeded.');
    }
  } catch (err) {
    if (err?.reauthorizationRequired) {
      console.error('[OAuth Broadcaster] Authorization can no longer be refreshed. Qwert must authorize again.');
    } else {
      console.warn('[OAuth Broadcaster] Hourly token validation failed:', err.message || err);
    }
  }
}

function startOAuthValidationLoop() {
  if (oauthValidationTimer) clearInterval(oauthValidationTimer);
  oauthValidationTimer = setInterval(() => {
    validateStoredOAuthSessions().catch((err) => {
      console.warn('[OAuth] Scheduled OAuth validation error:', err.message || err);
    });
  }, OAUTH_VALIDATION_INTERVAL);
}

async function resolveStartupToken() {
  try {
    const stored = await getValidAccessToken({ allowRefresh: true });
    if (stored) {
      usingMongoOAuth = true;
      console.log('[OAuth Bot] Using Twitch token stored in MongoDB.');
      return stored;
    }
  } catch (err) {
    console.error('[OAuth Bot] Stored Twitch token could not be used:', err.message || err);
  }

  if (FALLBACK_ACCESS_TOKEN) {
    usingMongoOAuth = false;
    console.warn('[OAuth Bot] Using legacy TWITCH_BOT_ACCESS_TOKEN fallback. Authorize the bot in the WebUI to move fully to MongoDB OAuth.');
    return FALLBACK_ACCESS_TOKEN;
  }

  return null;
}

function attachTwitchHandlers(client, generation) {
  client.on('connected', () => {
    if (generation !== twitchConnectionGeneration || !runtime?.isActive()) return;
    botConnected = true;
    console.log('[Bot] Twitch chat connection is online.');
  });

  client.on('disconnected', (reason) => {
    if (generation !== twitchConnectionGeneration || !runtime?.isActive()) return;
    botConnected = false;
    console.log('[Bot] Twitch chat disconnected:', reason);

    // tmi.js does not always surface Twitch's login failure through the notice
    // handler before the socket closes. The disconnect reason does contain it,
    // so recover here as well. This is the path that handles a Twitch RECONNECT
    // arriving after the IRC access token has expired.
    if (usingMongoOAuth && isIrcAuthenticationFailure(reason)) {
      recoverTwitchIrcAuthentication('IRC disconnect reported an authentication failure').catch((err) => {
        console.error('[OAuth Bot] IRC disconnect recovery error:', err.message || err);
      });
    }
  });

  client.on('notice', (channel, msgid, message) => {
    if (generation !== twitchConnectionGeneration || !runtime?.isActive()) return;

    if (usingMongoOAuth && isIrcAuthenticationFailure(message)) {
      recoverTwitchIrcAuthentication('IRC NOTICE reported an authentication failure').catch((err) => {
        console.error('[OAuth Bot] IRC notice recovery error:', err.message || err);
      });
    }
  });

  client.on('announcement', (channel, tags, message, self, color) => {
    if (generation !== twitchConnectionGeneration || !recapManager || !runtime?.canServeControls()) return;

    const rawMessage = String(message || '').trim();
    if (!rawMessage) return;

    const displayName = tags?.['display-name'] || tags?.login || tags?.username || 'moderator';
    recapManager.recordModeratorAnnouncement({
      displayName,
      rawMessage,
      color: String(color || tags?.['msg-param-color'] || '').trim(),
      tags,
      twitchMessageId: tags?.id || tags?.['message-id'] || '',
      timestamp: tags?.['tmi-sent-ts'] || Date.now()
    });
  });

  client.on('message', async (channel, tags, message) => {
    if (generation !== twitchConnectionGeneration || !recapManager || !runtime?.canServeControls()) return;
    await context.runOperation(() => twitchMessageHandler.handleMessage(channel, tags, message))
      .catch((err) => { if (!err.cancelled) console.error('[Chat Handler] Message processing failed:', err.message); });
  });
}


async function createAndConnectTwitchClient(accessToken) {
  await context.assertOperation();
  if (!accessToken) throw new Error('No Twitch access token is available.');
  if (!botUsername || !channelName) {
    throw new Error('TWITCH_BOT_USERNAME or TWITCH_CHANNEL is missing.');
  }

  twitchConnectionGeneration++;
  const generation = twitchConnectionGeneration;

  const client = new tmi.Client({
    options: { debug: true },
    identity: {
      username: botUsername,
      password: `oauth:${accessToken.replace(/^oauth:/i, '')}`
    },
    channels: [channelName]
  });

  attachTwitchHandlers(client, generation);
  twitchClient = client;
  let connectTimer;
  try {
    await Promise.race([client.connect(), new Promise((_, reject) => {
      connectTimer = setTimeout(() => reject(new Error('Twitch IRC connection timed out after 20 seconds.')), 20000);
    })]);
    await context.assertOperation();
  } catch (err) { void client.disconnect().catch(() => {}); throw err; }
  finally { clearTimeout(connectTimer); }
  botConnected = true;
  console.log(`[Bot] Connected to Twitch channel: #${channelName}`);
  return client;
}

async function reconnectTwitchClient(reason = 'manual reconnect', { accessToken = null } = {}) {
  if (twitchReconnectInProgress || !runtime?.isActive()) return;
  twitchReconnectInProgress = true;

  try {
    console.log(`[Bot] Reconnecting Twitch client: ${reason}`);
    const oldClient = twitchClient;
    botConnected = false;

    if (oldClient) {
      try {
        await oldClient.disconnect();
      } catch (err) {
        console.warn('[Bot] Old Twitch client disconnect warning:', err.message || err);
      }
    }

    const tokenToUse = accessToken || await getBotAccessToken();
    await createAndConnectTwitchClient(tokenToUse);
    await recapManager?.start();
    await recapManager?.checkStreamStatus();
    console.log('[Bot] Twitch client reconnected successfully.');
  } finally {
    twitchReconnectInProgress = false;
  }
}



// Express 4 does not catch rejected async route handlers automatically.
for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const register = app[method].bind(app);
  app[method] = (path, ...handlers) => register(path, ...handlers.map((handler) => typeof handler !== 'function' ? handler :
    function safeRoute(req, res, next) {
      try { Promise.resolve(handler(req, res, next)).catch(next); } catch (err) { next(err); }
    }));
}
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
  getBotConnected: () => botConnected,
  getUsingMongoOAuth: () => usingMongoOAuth,
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
  setUsingMongoOAuth: (value) => { usingMongoOAuth = Boolean(value); },
  reconnectTwitchClient,
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

registerChatRoutes(app, {
  requireModSession,
  channelName,
  chatClientProxy
});

async function activateBot() {
  await automationSpacingManager.initialize();
  await persistentPinManager.initialize();
  await customCommandManager.initialize();
  await eventSubReactionManager.initialize();
  await botPersonalityManager.initialize();
  recapManager = createRecapManager({
    client: chatClientProxy, channelName, getTwitchAccessToken: getBotAccessToken,
    refreshTwitchAccessToken: refreshBotAccessToken, validateTwitchAccessToken: validateAnyBotToken,
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
  const accessToken = await resolveStartupToken();
  if (accessToken) {
    try { await createAndConnectTwitchClient(accessToken); }
    catch (err) { console.warn('[Bot] Initial chat connection failed; automatic recovery will retry:', err.message); }
  }
  eventSubInbox.start();
  try { await persistentPinManager.syncLiveState(); }
  catch (err) { console.warn('[Persistent Pin] Startup sync pending:', err.message); }
  try { await ensureEventSubSubscriptions(); }
  catch (err) { console.warn('[EventSub] Subscription setup pending:', err.message); }
  startOAuthValidationLoop();
  retentionTimer = setInterval(() => {
    if (runtime.isActive()) void purgeExpiredOptedOutProfiles(channelName).catch((err) => console.warn('[Retention]', err.message));
  }, 6 * 60 * 60000);
}

async function maintainBot() {
  if (!runtime.isActive()) return;
  if (!botConnected && !twitchReconnectInProgress) {
    const token = await resolveStartupToken();
    if (token) {
      try { await reconnectTwitchClient('automatic connection recovery', { accessToken: token }); }
      catch (err) { console.warn('[Bot] Recovery pending:', err.message); }
    }
  }
  // Optional-scope/auth failures must not permanently disable EventSub setup.
  if (!maintainBot.lastEnsure || Date.now() - maintainBot.lastEnsure > 5 * 60000) {
    maintainBot.lastEnsure = Date.now();
    try { await ensureEventSubSubscriptions(); }
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
    botConnected = false; twitchConnectionGeneration++;
    clearTwitchAuthRecoveryTimer(); clearInterval(oauthValidationTimer); clearInterval(retentionTimer);
    recapManager?.quiesce(); chatTimerManager?.quiesce(); persistentPinManager?.quiesce();
    eventSubInbox?.quiesce(); stopTemporaryPinTimer(); cancelAllGeminiRequests();
  },
  flush: async ({ persist }) => {
    const work = [eventSubInbox?.stop()];
    if (persist) { work.push(recapManager?.shutdown({ persist: true }), chatTimerManager?.shutdown()); }
    const results = await Promise.allSettled(work);
    for (const result of results) if (result.status === 'rejected') console.error('[Shutdown] Durable flush failed:', result.reason?.message);
    if (twitchClient) {
      try { await twitchClient.disconnect(); } catch (err) { console.warn('[Shutdown] IRC disconnect:', err.message); }
    }
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, 'One or more shutdown checkpoints failed.');
  },
  disconnect: disconnectDatabase,
  fatal: (err) => { console.error('[Runtime] Stopping unsafe instance:', err.message); void requestShutdown('runtime ownership failure', 1, false); }
});
context.configureRuntime(runtime);
configureSharedRateGate(createRateGate({ key: process.env.GEMINI_API_KEY || 'unconfigured' }));

// Recovery actions require an authenticated operator and an explicit outcome.
app.get('/reliability/status', requireModSession, async (req, res) => {
  const state = runtime.status();
  if (!state.ready) return res.json({ success: true, runtime: state, review: [] });
  const timers = await chatTimerManager.listTimers();
  const recap = recapManager.getStatus();
  const pin = persistentPinManager.getConfig();
  const pendingKeys = [recap.recoveryDeliveryKey,
    ...timers.filter((item) => item.recoveryRequired).map((item) => item.deliveryKey),
    pin.recoveryRequired ? pin.deliveryKey : ''].filter(Boolean);
  // A Mongo acknowledgement can be lost AFTER a receipt was committed. Include
  // such confirmed receipts while the owning feature still awaits reconciliation.
  const rows = await collection().find({ namespace: channelName, $or: [
    { kind: 'event', state: { $in: ['review', 'failed'] } },
    { kind: 'delivery', state: { $in: ['unknown', 'sending'] } },
    { kind: 'delivery', key: { $in: pendingKeys } }
  ] }, { maxTimeMS: 5000 }).sort({ createdAt: -1 }).limit(100).toArray();
  const eventKeys = new Set(rows.filter((row) => row.kind === 'event' && row.deliveryKey).map((row) => row.deliveryKey));
  const review = [];
  for (const row of rows) {
    if (row.kind === 'event') {
      if (row.deliveryKey && delivery.isInFlight(row.deliveryKey)) continue;
      review.push({ target: 'event', id: row.messageId, deliveryKey: row.deliveryKey || '', state: row.state,
        title: `Twitch event: ${row.payload?.type || 'notification'}`, detail: row.lastError || '',
        createdAt: row.createdAt, retryOnly: row.state === 'failed' });
      continue;
    }
    if (delivery.isInFlight(row.key) || eventKeys.has(row.key)) continue;
    const timer = timers.find((item) => item.deliveryKey === row.key);
    const isRecap = recap.recoveryDeliveryKey === row.key;
    const isPin = pin.deliveryKey === row.key && pin.recoveryRequired;
    review.push({ target: isRecap ? 'recap' : timer ? 'timer' : isPin ? 'pin' : 'delivery',
      id: timer ? timer.id : row.key, deliveryKey: row.key, state: row.state,
      title: isRecap ? 'Hourly recap' : timer ? `Timer: ${timer.name}` : isPin ? 'Persistent stream pin' : row.deliveryKind,
      detail: row.lastError || 'Twitch may have received this action before its acknowledgement was saved.',
      preview: String(row.payload?.message || row.payload?.rendered || '').slice(0, 500), createdAt: row.createdAt });
  }
  res.json({ success: true, runtime: state, review });
});
app.post('/reliability/resolve', requireModSession, async (req, res) => {
  const { target, id, outcome, expectedDeliveryKey } = req.body;
  if (typeof expectedDeliveryKey !== 'string' || !expectedDeliveryKey ||
      (['recap', 'pin', 'delivery'].includes(target) && id !== expectedDeliveryKey)) {
    return res.status(409).json({ success: false, error: 'Refresh the recovery panel before reviewing this exact delivery.' });
  }
  if (!['sent', 'not_sent'].includes(outcome) || req.body.confirmed !== true) return res.status(400).json({ success: false, error: 'Confirm whether the message was sent or definitely not sent.' });
  let result;
  if (target === 'recap') result = await recapManager.resolveDeliveryReview(outcome, expectedDeliveryKey);
  else if (target === 'timer') result = await chatTimerManager.resolveReview(id, outcome, expectedDeliveryKey);
  else if (target === 'pin') result = await persistentPinManager.resolveReview(outcome, expectedDeliveryKey);
  else if (target === 'event') { await eventSubInbox.resolveReview(id, outcome, expectedDeliveryKey); result = { success: true, message: 'Event receipt resolved. Remaining unfinished actions will resume.' }; }
  else if (target === 'delivery') {
    const row = await delivery.get(id);
    if (!row || row.namespace !== channelName) return res.status(404).json({ success: false, error: 'Delivery record not found for this channel.' });
    const saved = await delivery.resolve(id, outcome);
    result = { success: Boolean(saved), message: 'Receipt reviewed. No standalone message was automatically restarted.' };
  } else return res.status(400).json({ success: false, error: 'Invalid recovery target.' });
  if (result?.success === false) return res.status(409).json({ success: false, error: result.message || 'The operation changed; refresh its status.' });
  res.json({ success: true, message: result?.message || 'Delivery reviewed. Refresh the affected control before continuing.', result });
});
app.post('/reliability/retry-event', requireModSession, async (req, res) => {
  if (req.body.confirmed !== true) return res.status(400).json({ success: false, error: 'Explicit confirmation is required.' });
  await eventSubInbox.retryFailed(req.body.id);
  res.json({ success: true, message: 'Failed event requeued. Completed action steps will not be repeated.' });
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
  console.log(`[Startup] Gemini model: ${getGeminiClientStatus().model}; global 15-RPM pacing enabled.`);
  console.log('[Startup] Reliability build: durable sends, inbox, graceful shutdown, recap-control split.');
});
runtime.start();
