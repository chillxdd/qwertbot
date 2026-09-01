const express = require('express');
const tmi = require('tmi.js');
const path = require('path');

const { createRecapManager, SUMMARY_PREFIX, TWITCH_MESSAGE_LIMIT } = require('./commands/recap');

const { connectDatabase } = require('./services/database');
const { getGeminiClientStatus } = require('./services/geminiClient');
const { createModSessionManager } = require('./middleware/modSession');
const { createTwitchMessageHandler } = require('./services/twitchMessageHandler');
const { createCustomCommandManager } = require('./services/customCommands');
const { createChatTimerManager } = require('./services/chatTimers');
const { createEventSubReactionManager } = require('./services/eventSubReactions');
const { createAutomationSpacingManager } = require('./services/automationSpacing');
const { createPersistentPinManager } = require('./services/persistentStreamPin');
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

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const QWERT_OAUTH_LINK_SECRET = (process.env.QWERT_OAUTH_LINK_SECRET || '').trim();
const TWITCH_CLIENT_ID = (process.env.TWITCH_CLIENT_ID || '').trim();
const TWITCH_CLIENT_SECRET = (process.env.TWITCH_CLIENT_SECRET || '').trim();
const TWITCH_REDIRECT_URI = 'https://sqwertarmybot.onrender.com/auth/twitch/callback';
const TWITCH_OAUTH_SCOPES = ['chat:read', 'chat:edit', 'user:read:chat', 'user:write:chat', 'user:bot', 'moderator:manage:chat_messages', 'moderator:manage:shoutouts', REQUIRED_ANNOUNCEMENT_SCOPE, REQUIRED_CHATTERS_SCOPE];
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
let databaseConnected = false;
let usingMongoOAuth = false;
let twitchClient = null;
let recapManager = null;
let customCommandManager = null;
let chatTimerManager = null;
let eventSubReactionManager = null;
let automationSpacingManager = null;
let persistentPinManager = null;
let botPersonalityManager = null;
let twitchReconnectInProgress = false;
let twitchAuthRecoveryInProgress = false;
let twitchAuthRecoveryTimer = null;
let oauthValidationTimer = null;
let twitchConnectionGeneration = 0;

function shouldFallbackToIrc(err) {
  const message = String(err?.message || err || '');

  if (message.includes('MongoDB is not connected')) return true;
  if (message.includes('Twitch Chat API is not ready:')) return true;
  if (message.includes('Could not create Twitch App Access Token. HTTP 5')) return true;
  if (message.includes('Twitch Send Chat Message API failed with HTTP 401')) return true;
  if (/Twitch Send Chat Message API failed with HTTP 5\d\d/.test(message)) return true;

  // Node fetch/network failures are commonly surfaced as TypeError: fetch failed.
  if (err instanceof TypeError && /fetch/i.test(message)) return true;

  return false;
}

async function sendViaIrcFallback(channel, message, apiError) {
  if (!twitchClient || !botConnected) {
    throw apiError;
  }

  const normalizedChannel = String(channel || '').replace(/^#/, '').toLowerCase();
  const targetChannel = normalizedChannel || channelName;

  console.warn(
    `[Chat] Chat API unavailable (${apiError?.message || apiError}). Falling back to IRC for this message.`
  );

  await twitchClient.say(targetChannel, message);

  console.log('[Chat] Message sent through IRC fallback. Bot badge will not apply to this message.');

  return {
    method: 'irc_fallback',
    fallback: true,
    apiError: apiError?.message || String(apiError || '')
  };
}

const chatClientProxy = {
  async say(channel, message, options = {}) {
    const normalizedChannel = String(channel || '').replace(/^#/, '').toLowerCase();
    if (normalizedChannel && normalizedChannel !== channelName) {
      throw new Error(`${botUsername || 'The bot'} is configured to send only to #${channelName}.`);
    }

    const wantsTemporaryPin = options?.temporaryPin === true;
    let previousPin = null;
    let pinSnapshotReady = false;

    if (wantsTemporaryPin && databaseConnected) {
      try {
        previousPin = await getPinnedChatMessage();
        pinSnapshotReady = true;
      } catch (pinErr) {
        console.warn(`[Recap Pins] Could not read the current pinned message before the recap. The recap will still send, but it will not be temporarily pinned: ${pinErr?.message || pinErr}`);
      }
    }

    try {
      if (!databaseConnected) {
        throw new Error('MongoDB is not connected, so Twitch Chat API authorization cannot be verified.');
      }

      const result = await sendChatMessageViaApi(message, { replyParentMessageId: options?.replyParentMessageId || null });

      console.log('[Chat] Message sent through Twitch Chat API.');

      if (wantsTemporaryPin && pinSnapshotReady && result?.message_id) {
        try {
          await startTemporaryChatPin({
            messageId: result.message_id,
            previousPin,
            displaySeconds: 60
          });
        } catch (pinErr) {
          console.warn(`[Recap Pins] Hourly recap was sent, but temporary pinning could not start: ${pinErr?.message || pinErr}`);
        }
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

      return sendViaIrcFallback(channel, message, err);
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
  sendMessage: (channel, message) => chatClientProxy.say(channel, message),
  sendAnnouncement: (message, options) => sendChatAnnouncement(message, options),
  getStreamStatus: () => recapManager?.getStatus?.() || {},
  getRandomChatters: (count) => getRandomChatters({ count, excludeLogins: [botUsername] }),
  getEventReactionHoldStatus,
  getAutomationSpacingStatus: (engine) => automationSpacingManager?.getStatus?.(engine) || { active: false },
  tryReserveAutomationSlot: (engine) => automationSpacingManager?.tryReserve?.(engine) || Promise.resolve({ allowed: true })
});

eventSubReactionManager = createEventSubReactionManager({
  channelName,
  sendMessage: (channel, message) => chatClientProxy.say(channel, message),
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
  getSessionMemoryContext: (question) => recapManager?.getSessionMemoryContext?.(question) || { text: '' }
});

const twitchMessageHandler = createTwitchMessageHandler({
  getRecapManager: () => recapManager,
  getCustomCommandManager: () => customCommandManager,
  getChatTimerManager: () => chatTimerManager,
  getBotPersonalityManager: () => botPersonalityManager,
  getPersistentPinManager: () => persistentPinManager,
  getNativeCommandResponse: (command, variant, variables) => getRenderedNativeResponse(channelName, command, variant, variables),
  sendMessage: (channel, message) => chatClientProxy.say(channel, message),
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
  if (!usingMongoOAuth || twitchAuthRecoveryInProgress) return;

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
  if (!databaseConnected) return;

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
    if (generation !== twitchConnectionGeneration) return;
    botConnected = true;
    console.log('[Bot] Twitch chat connection is online.');
  });

  client.on('disconnected', (reason) => {
    if (generation !== twitchConnectionGeneration) return;
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
    if (generation !== twitchConnectionGeneration) return;

    if (usingMongoOAuth && isIrcAuthenticationFailure(message)) {
      recoverTwitchIrcAuthentication('IRC NOTICE reported an authentication failure').catch((err) => {
        console.error('[OAuth Bot] IRC notice recovery error:', err.message || err);
      });
    }
  });

  client.on('announcement', (channel, tags, message, self, color) => {
    if (generation !== twitchConnectionGeneration || !recapManager) return;

    const rawMessage = String(message || '').trim();
    if (!rawMessage) return;

    const displayName = tags?.['display-name'] || tags?.login || tags?.username || 'moderator';
    recapManager.recordModeratorAnnouncement({
      displayName,
      rawMessage,
      color: String(color || tags?.['msg-param-color'] || '').trim()
    });
  });

  client.on('message', async (channel, tags, message) => {
    if (generation !== twitchConnectionGeneration || !recapManager) return;
    await twitchMessageHandler.handleMessage(channel, tags, message);
  });
}


async function createAndConnectTwitchClient(accessToken) {
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
  await client.connect();
  botConnected = true;
  console.log(`[Bot] Connected to Twitch channel: #${channelName}`);
  return client;
}

async function reconnectTwitchClient(reason = 'manual reconnect', { accessToken = null } = {}) {
  if (twitchReconnectInProgress) return;
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
    console.log('[Bot] Twitch client reconnected successfully.');
  } finally {
    twitchReconnectInProgress = false;
  }
}



registerEventSubRoutes(app, {
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
  getBotPersonalityManager: () => botPersonalityManager,
  getDatabaseConnected: () => databaseConnected,
  getBotConnected: () => botConnected,
  getUsingMongoOAuth: () => usingMongoOAuth,
  webuiDir: path.join(__dirname, 'webui')
});

registerMemoryRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => databaseConnected,
  getBotPersonalityManager: () => botPersonalityManager,
  getRecapManager: () => recapManager,
  channelName
});

registerRecapRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => databaseConnected,
  getRecapManager: () => recapManager,
  channelName
});

registerAuthRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => databaseConnected,
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
  oauthStateLifetimeMs: OAUTH_STATE_LIFETIME
});

registerCustomCommandRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => databaseConnected,
  getCustomCommandManager: () => customCommandManager
});

registerTimerRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => databaseConnected,
  getChatTimerManager: () => chatTimerManager,
  getPersistentPinManager: () => persistentPinManager
});

registerAutomationRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => databaseConnected,
  getAutomationSpacingManager: () => automationSpacingManager
});

registerEventSubReactionRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => databaseConnected,
  getEventSubReactionManager: () => eventSubReactionManager,
  getPersistentPinManager: () => persistentPinManager
});


registerNativeCommandRoutes(app, {
  requireModSession,
  getDatabaseConnected: () => databaseConnected,
  channelName
});

registerChatRoutes(app, {
  requireModSession,
  channelName,
  chatClientProxy
});

async function bootstrap() {
  try {
    await connectDatabase();
    await ensureViewerProfileIndexes();
    databaseConnected = true;
  } catch (err) {
    databaseConnected = false;
    console.error('[Database] Startup failed:', err.message || err);
    console.error('[Database] The web dashboard will still start, but MongoDB OAuth cannot work until the connection is fixed.');
  }

  if (databaseConnected) {
    try {
      const result = await purgeExpiredOptedOutProfiles(channelName);
      if (result.purged > 0) console.log(`[Viewer Profiles] Purged ${result.purged} expired opted-out profile(s).`);
    } catch (err) {
      console.error('[Viewer Profiles] Startup retention cleanup failed:', err.message || err);
    }
  }

  if (databaseConnected && automationSpacingManager) {
    try {
      await automationSpacingManager.initialize();
    } catch (err) {
      console.error('[Automation] Startup load failed:', err.message || err);
    }
  }

  if (databaseConnected && persistentPinManager) {
    try {
      await persistentPinManager.initialize();
    } catch (err) {
      console.error('[Persistent Pin] Startup load failed:', err.message || err);
    }
  }

  if (databaseConnected && customCommandManager) {
    try {
      await customCommandManager.initialize();
    } catch (err) {
      console.error('[Custom Commands] Startup load failed:', err.message || err);
    }
  }

  if (databaseConnected && chatTimerManager) {
    try {
      await chatTimerManager.initialize();
    } catch (err) {
      console.error('[Timers] Startup load failed:', err.message || err);
    }
  }

  if (databaseConnected && eventSubReactionManager) {
    try {
      await eventSubReactionManager.initialize();
    } catch (err) {
      console.error('[EventSub Reactions] Startup load failed:', err.message || err);
    }
  }

  if (databaseConnected && botPersonalityManager) {
    try {
      await botPersonalityManager.initialize();
    } catch (err) {
      console.error('[Tagged Questions] Startup load failed:', err.message || err);
    }
  }

  recapManager = createRecapManager({
    client: chatClientProxy,
    channelName,
    getTwitchAccessToken: getBotAccessToken,
    refreshTwitchAccessToken: refreshBotAccessToken,
    validateTwitchAccessToken: validateAnyBotToken,
    getSessionMemoryConfig: () => botPersonalityManager?.getConfig?.()?.sessionMemory || {},
    getEventReactionHoldStatus,
    getTaggedQuestionRecapBufferStatus: () => botPersonalityManager?.getRecapCollisionStatus?.() || { active: false },
    getAutomationSpacingStatus: (engine) => automationSpacingManager?.getStatus?.(engine) || { active: false },
    tryReserveAutomationSlot: (engine) => automationSpacingManager?.tryReserve?.(engine) || Promise.resolve({ allowed: true }),
    getNativeCommandResponse: (command, variant, variables) => getRenderedNativeResponse(channelName, command, variant, variables)
  });

  const accessToken = await resolveStartupToken();

  if (accessToken) {
    try {
      await createAndConnectTwitchClient(accessToken);
      await recapManager.start();
      if (persistentPinManager?.syncLiveState) {
        await persistentPinManager.syncLiveState();
      }
    } catch (err) {
      botConnected = false;
      console.error('[Bot] Twitch startup failed:', err.message || err);
      console.error('[Bot] If MongoDB OAuth is not yet authorized, use the WebUI Authorize Twitch Bot button.');
    }
  } else {
    console.warn('[Bot] No Twitch access token is available. Open the WebUI and authorize the bot.');
  }

  if (databaseConnected) {
    // Twitch requires third-party OAuth sessions to be validated at startup and
    // at least hourly. Bot startup validation happens in resolveStartupToken();
    // validate/refresh the broadcaster grant here too.
    try {
      const broadcasterToken = await getValidBroadcasterAccessToken({ allowRefresh: true });
      if (broadcasterToken) {
        console.log('[OAuth Broadcaster] Token validated at startup.');
      }
    } catch (err) {
      if (err?.reauthorizationRequired) {
        console.error('[OAuth Broadcaster] Authorization cannot be refreshed. Qwert must authorize again.');
      } else {
        console.log('[OAuth Broadcaster] Startup validation pending:', err.message || err);
      }
    }

    try {
      await ensureEventSubSubscriptions();
    } catch (err) {
      console.log('[EventSub] Startup setup pending:', err.message || err);
    }

    startOAuthValidationLoop();
    console.log('[OAuth] Automatic bot + broadcaster token validation scheduled every 50 minutes.');
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
});

app.listen(PORT, () => {
  console.log(`[Startup] Web server running on port ${PORT}`);
  const geminiStatus = getGeminiClientStatus();
  console.log(`[Startup] Gemini model: ${geminiStatus.model}`);
  console.log(`[Startup] Gemini global request spacing: ${geminiStatus.requestSpacingMs}ms (override with GEMINI_REQUEST_SPACING_MS).`);
  console.log(`[Startup] Twitch chat message limit: ${TWITCH_MESSAGE_LIMIT}`);
  console.log('[Recap] Automatic hourly recap mode enabled.');
  console.log('[Recap] First recap: 60 minutes.');
  console.log('[Recap] Recurring recap: every 60 minutes.');
  console.log('[Recap] Stream title/category check: every 30 seconds.');
  console.log(`[OAuth] Twitch OAuth callback: ${TWITCH_REDIRECT_URI}`);
  console.log('[OAuth] Twitch OAuth tokens are stored in MongoDB and are never logged.');
  console.log('[OAuth] Bot and broadcaster sessions validate automatically every 50 minutes and refresh on 401.');
});


setInterval(async () => {
  if (!databaseConnected) return;
  try {
    const result = await purgeExpiredOptedOutProfiles(channelName);
    if (result.purged > 0) console.log(`[Viewer Profiles] Purged ${result.purged} expired opted-out profile(s).`);
  } catch (err) {
    console.error('[Viewer Profiles] Retention cleanup failed:', err.message || err);
  }
}, 6 * 60 * 60 * 1000);

bootstrap().catch((err) => {
  console.error('[Startup] Fatal bootstrap error:', err);
});
