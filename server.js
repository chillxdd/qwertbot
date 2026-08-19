const express = require('express');
const tmi = require('tmi.js');
const crypto = require('crypto');
const path = require('path');

const {
  createRecapManager,
  generateRecap,
  SUMMARY_PREFIX,
  TWITCH_MESSAGE_LIMIT
} = require('./commands/recap');

const { connectDatabase } = require('./services/database');
const { createModSessionManager, timingSafeStringEqual } = require('./middleware/modSession');
const { createTwitchMessageHandler } = require('./services/twitchMessageHandler');
const {
  MAX_COMMAND_NAME_LENGTH,
  MAX_TRIGGER_LENGTH,
  MAX_TRIGGERS,
  MAX_RESPONSES,
  MAX_RESPONSE_LENGTH,
  MAX_COOLDOWN_SECONDS,
  createCustomCommandManager
} = require('./services/customCommands');
const { MAX_STREAM_LORE_LENGTH, getStreamLore, saveStreamLore } = require('./services/streamLore');
const {
  MAX_PRIMARY_INSTRUCTIONS_LENGTH,
  MAX_EXPANSION_INSTRUCTIONS_LENGTH,
  getRecapPromptConfig,
  saveRecapPromptConfig
} = require('./services/recapPromptConfig');
const { getRecentRenderLogs, getRenderLogsConfigStatus } = require('./services/renderLogs');
const {
  exchangeAuthorizationCode,
  getAccessToken,
  getAuthStatus,
  getStoredAuth,
  getValidAccessToken,
  refreshStoredToken,
  storeAuthorizationCodeResult,
  validateAccessToken
} = require('./services/twitchAuth');

const {
  exchangeBroadcasterAuthorizationCode,
  getBroadcasterAuthStatus,
  getValidBroadcasterAccessToken,
  storeBroadcasterAuthorizationCodeResult,
  validateBroadcasterAccessToken
} = require('./services/twitchBroadcasterAuth');
const {
  getChatApiReadiness,
  getPinnedChatMessage,
  sendChatMessageViaApi,
  startTemporaryChatPin
} = require('./services/twitchChat');
const {
  REQUIRED_EVENTSUB_SCOPES,
  ensureEventSubSubscriptions,
  getEventSubStatus,
  noteEventReceived,
  verifyEventSubRequest
} = require('./services/twitchEventSub');

const app = express();
const PORT = process.env.PORT || 3000;

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const QWERT_OAUTH_LINK_SECRET = (process.env.QWERT_OAUTH_LINK_SECRET || '').trim();
const TWITCH_CLIENT_ID = (process.env.TWITCH_CLIENT_ID || '').trim();
const TWITCH_CLIENT_SECRET = (process.env.TWITCH_CLIENT_SECRET || '').trim();
const TWITCH_REDIRECT_URI = 'https://sqwertarmybot.onrender.com/auth/twitch/callback';
const TWITCH_OAUTH_SCOPES = ['chat:read', 'chat:edit', 'user:read:chat', 'user:write:chat', 'user:bot', 'moderator:manage:chat_messages'];
const TWITCH_BROADCASTER_SCOPES = ['channel:bot', 'channel:read:subscriptions', 'bits:read', 'moderator:read:followers', 'channel:read:hype_train'];
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
  console.warn('WARNING: QWERT_OAUTH_LINK_SECRET is not set. Private Qwert broadcaster authorization will be unavailable.');
}

const oauthStates = new Map();
const broadcasterOauthStates = new Map();
let botConnected = false;
let databaseConnected = false;
let usingMongoOAuth = false;
let twitchClient = null;
let recapManager = null;
let customCommandManager = null;
let twitchReconnectInProgress = false;
let twitchAuthRecoveryInProgress = false;
let twitchAuthRecoveryTimer = null;
let oauthValidationTimer = null;
let twitchConnectionGeneration = 0;
const recentEventSubMessageIds = new Map();

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
        console.warn(`[Pins] Could not read the current pinned message before the recap. The recap will still send, but it will not be temporarily pinned: ${pinErr?.message || pinErr}`);
      }
    }

    try {
      if (!databaseConnected) {
        throw new Error('MongoDB is not connected, so Twitch Chat API authorization cannot be verified.');
      }

      const result = await sendChatMessageViaApi(message);

      console.log('[Chat] Message sent through Twitch Chat API.');

      if (wantsTemporaryPin && pinSnapshotReady && result?.message_id) {
        try {
          await startTemporaryChatPin({
            messageId: result.message_id,
            previousPin,
            displaySeconds: 60
          });
        } catch (pinErr) {
          console.warn(`[Pins] Hourly recap was sent, but temporary pinning could not start: ${pinErr?.message || pinErr}`);
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

function isValidQwertOAuthSecret(value) {
  return timingSafeStringEqual(value, QWERT_OAUTH_LINK_SECRET);
}

function escapeHtmlServer(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function cleanupOAuthStates() {
  const now = Date.now();
  for (const [state, createdAt] of oauthStates.entries()) {
    if (now - createdAt > OAUTH_STATE_LIFETIME) oauthStates.delete(state);
  }
}

function createOAuthState() {
  cleanupOAuthStates();
  const state = crypto.randomBytes(32).toString('hex');
  oauthStates.set(state, Date.now());
  return state;
}

function consumeOAuthState(state) {
  cleanupOAuthStates();
  if (!state || !oauthStates.has(state)) return false;
  oauthStates.delete(state);
  return true;
}

function cleanupBroadcasterOAuthStates() {
  const now = Date.now();
  for (const [state, createdAt] of broadcasterOauthStates.entries()) {
    if (now - createdAt > OAUTH_STATE_LIFETIME) broadcasterOauthStates.delete(state);
  }
}

function createBroadcasterOAuthState() {
  cleanupBroadcasterOAuthStates();
  const state = crypto.randomBytes(32).toString('hex');
  broadcasterOauthStates.set(state, Date.now());
  return state;
}

function consumeBroadcasterOAuthState(state) {
  cleanupBroadcasterOAuthStates();
  if (!state || !broadcasterOauthStates.has(state)) return false;
  broadcasterOauthStates.delete(state);
  return true;
}

customCommandManager = createCustomCommandManager({
  channelName,
  sendMessage: (channel, message) => chatClientProxy.say(channel, message)
});

const twitchMessageHandler = createTwitchMessageHandler({
  getRecapManager: () => recapManager,
  getCustomCommandManager: () => customCommandManager,
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
    console.error('[OAuth] Failed to read stored Twitch token:', err.message || err);
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
    console.warn(`[OAuth] ${reason}. Validating the stored bot token and refreshing it if needed.`);

    // If MongoDB already contains a newer valid token, use it. Otherwise a 401
    // from /validate automatically refreshes the token and saves the rotated
    // access + refresh token pair before we reconnect tmi.js.
    const accessToken = await getValidAccessToken({ allowRefresh: true });
    if (!accessToken) throw new Error('No MongoDB Twitch bot authorization is available.');

    usingMongoOAuth = true;
    await reconnectTwitchClient(reason, { accessToken });
    console.log('[OAuth] IRC authentication recovery completed successfully.');
  } catch (err) {
    console.error('[OAuth] IRC authentication recovery failed:', err.message || err);

    // A revoked/invalid refresh token genuinely requires consent again. Do not
    // hammer Twitch in that case. Transient network/5xx failures get one delayed
    // retry path so the bot can heal without manual intervention.
    if (!err?.reauthorizationRequired) {
      twitchAuthRecoveryTimer = setTimeout(() => {
        twitchAuthRecoveryTimer = null;
        recoverTwitchIrcAuthentication('retry after IRC authentication failure').catch((retryErr) => {
          console.error('[OAuth] Delayed IRC authentication recovery failed:', retryErr.message || retryErr);
        });
      }, 15000);
      console.warn('[OAuth] IRC authentication recovery will retry in 15 seconds.');
    } else {
      console.error('[OAuth] Twitch reports that the bot authorization itself is no longer refreshable. Manual bot reauthorization is required.');
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
      console.log('[OAuth] Hourly bot token validation succeeded.');

      // If validation had to refresh the token, rebuild the IRC client with the
      // newly stored token now instead of waiting for Twitch to force a RECONNECT.
      if (before?.accessToken && after?.accessToken && before.accessToken !== after.accessToken) {
        await reconnectTwitchClient('hourly OAuth refresh', { accessToken: after.accessToken });
      }
    }
  } catch (err) {
    if (err?.reauthorizationRequired) {
      console.error('[OAuth] Bot authorization can no longer be refreshed. Manual bot reauthorization is required.');
    } else {
      console.warn('[OAuth] Hourly bot token validation failed:', err.message || err);
    }
  }

  try {
    const broadcasterToken = await getValidBroadcasterAccessToken({ allowRefresh: true });
    if (broadcasterToken) {
      console.log('[OAuth] Hourly broadcaster token validation succeeded.');
    }
  } catch (err) {
    if (err?.reauthorizationRequired) {
      console.error('[OAuth] Broadcaster authorization can no longer be refreshed. Qwert must authorize again.');
    } else {
      console.warn('[OAuth] Hourly broadcaster token validation failed:', err.message || err);
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
      console.log('[OAuth] Using Twitch token stored in MongoDB.');
      return stored;
    }
  } catch (err) {
    console.error('[OAuth] Stored Twitch token could not be used:', err.message || err);
  }

  if (FALLBACK_ACCESS_TOKEN) {
    usingMongoOAuth = false;
    console.warn('[OAuth] Using legacy TWITCH_BOT_ACCESS_TOKEN fallback. Authorize the bot in the WebUI to move fully to MongoDB OAuth.');
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
        console.error('[OAuth] IRC disconnect recovery error:', err.message || err);
      });
    }
  });

  client.on('notice', (channel, msgid, message) => {
    if (generation !== twitchConnectionGeneration) return;

    if (usingMongoOAuth && isIrcAuthenticationFailure(message)) {
      recoverTwitchIrcAuthentication('IRC NOTICE reported an authentication failure').catch((err) => {
        console.error('[OAuth] IRC notice recovery error:', err.message || err);
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
  console.log(`Connected to Twitch channel: #${channelName}`);
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


function cleanupRecentEventSubIds() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, seenAt] of recentEventSubMessageIds.entries()) {
    if (seenAt < cutoff) recentEventSubMessageIds.delete(id);
  }
}

function formatEventSubForRecap(type, event) {
  const name = event?.user_name || event?.user_login || 'A viewer';

  switch (type) {
    case 'channel.subscribe':
      if (event?.is_gift) return null; // gift details arrive through channel.subscription.gift
      return `${name} subscribed to Qwert at Tier ${String(event?.tier || '1000').replace('1000', '1').replace('2000', '2').replace('3000', '3')}.`;
    case 'channel.subscription.message': {
      const months = Number(event?.cumulative_months || 0);
      const message = String(event?.message?.text || '').trim();
      return `${name} resubscribed${months ? ` for ${months} cumulative month(s)` : ''}${message ? ` and wrote: ${message}` : ''}.`;
    }
    case 'channel.subscription.gift': {
      const total = Number(event?.total || 0);
      if (event?.is_anonymous) return `An anonymous viewer gifted ${total || 'multiple'} subscription(s) to Qwert's channel.`;
      return `${name} gifted ${total || 'multiple'} subscription(s) to Qwert's channel.`;
    }
    case 'channel.cheer': {
      const bits = Number(event?.bits || 0);
      if (event?.is_anonymous) return `An anonymous viewer cheered ${bits} Bits.`;
      return `${name} cheered ${bits} Bits.`;
    }
    case 'channel.follow':
      return `${name} followed Qwert.`;
    case 'channel.raid':
      return `${event?.from_broadcaster_user_name || event?.from_broadcaster_user_login || 'A streamer'} raided Qwert with ${Number(event?.viewers || 0)} viewer(s).`;
    case 'channel.hype_train.begin':
      return `A Hype Train began at level ${event?.level ?? 1}.`;
    case 'channel.hype_train.end':
      return `The Hype Train ended at level ${event?.level ?? 'unknown'}.`;
    case 'stream.online':
      return 'Qwert went live.';
    case 'stream.offline':
      return 'Qwert went offline.';
    default:
      return null;
  }
}

app.post('/eventsub/twitch', (req, res) => {
  try {
    if (!verifyEventSubRequest(req)) {
      return res.status(403).send('Invalid EventSub signature.');
    }

    const messageType = req.get('Twitch-Eventsub-Message-Type') || '';
    const messageId = req.get('Twitch-Eventsub-Message-Id') || '';

    if (messageType === 'webhook_callback_verification') {
      return res.status(200).type('text/plain').send(String(req.body?.challenge || ''));
    }

    if (messageType === 'revocation') {
      console.warn('[EventSub] Subscription revoked:', req.body?.subscription?.type, req.body?.subscription?.status);
      return res.sendStatus(204);
    }

    if (messageType !== 'notification') return res.sendStatus(204);

    cleanupRecentEventSubIds();
    if (messageId && recentEventSubMessageIds.has(messageId)) return res.sendStatus(204);
    if (messageId) recentEventSubMessageIds.set(messageId, Date.now());

    noteEventReceived();
    const type = req.body?.subscription?.type || '';
    const event = req.body?.event || {};
    const text = formatEventSubForRecap(type, event);

    if (text && recapManager) {
      recapManager.recordTwitchEvent({
        type,
        text,
        timestamp: Date.now()
      });
    }

    console.log(`[EventSub] ${type}: ${text || 'event received'}`);
    return res.sendStatus(204);
  } catch (err) {
    console.error('[EventSub] Webhook processing failed:', err.message || err);
    return res.sendStatus(500);
  }
});

app.get('/webui-config', (req, res) => {
  res.json({
    success: true,
    channelName: channelName || 'generalqwert',
    maxStreamLoreLength: MAX_STREAM_LORE_LENGTH,
    customCommands: {
      maxCommandNameLength: MAX_COMMAND_NAME_LENGTH,
      maxTriggerLength: MAX_TRIGGER_LENGTH,
      maxTriggers: MAX_TRIGGERS,
      maxResponses: MAX_RESPONSES,
      maxResponseLength: MAX_RESPONSE_LENGTH,
      maxCooldownSeconds: MAX_COOLDOWN_SECONDS
    }
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/status', async (req, res) => {
  const recapStatus = recapManager
    ? recapManager.getStatus()
    : {
        streamLive: false,
        streamStateInitialized: false,
        currentStreamTitle: null,
        currentStreamCategory: null,
        currentStreamGameId: null,
        loggingMessages: false,
        recapPaused: false,
        messagesInWindow: 0,
        twitchEventsInWindow: 0,
        contextChangesInWindow: 0,
        recapInProgress: false,
        nextRecapAt: null,
        pausedRemainingMs: null
      };

  let authStatus = {
    stored: false,
    username: null,
    twitchUserId: null,
    scopes: [],
    updatedAt: null
  };

  let broadcasterAuthStatus = {
    stored: false,
    username: null,
    twitchUserId: null,
    scopes: [],
    updatedAt: null
  };

  let chatApiStatus = {
    ready: false,
    botMissingScopes: ['user:write:chat', 'user:bot'],
    broadcasterMissingScopes: ['channel:bot']
  };

  const eventSubStatus = getEventSubStatus();
  let broadcasterMissingAllScopes = [...TWITCH_BROADCASTER_SCOPES];

  try {
    if (databaseConnected) {
      [authStatus, broadcasterAuthStatus, chatApiStatus] = await Promise.all([
        getAuthStatus(),
        getBroadcasterAuthStatus(),
        getChatApiReadiness()
      ]);
      broadcasterMissingAllScopes = TWITCH_BROADCASTER_SCOPES.filter((scope) => !(broadcasterAuthStatus.scopes || []).includes(scope));
    }
  } catch (err) {
    console.error('[OAuth] Could not load Twitch authorization status:', err.message || err);
  }

  res.json({
    success: true,
    qwert: {
      live: recapStatus.streamLive,
      statusKnown: recapStatus.streamStateInitialized,
      twitchUrl: `https://www.twitch.tv/${channelName}`,
      title: recapStatus.currentStreamTitle,
      category: recapStatus.currentStreamCategory,
      gameId: recapStatus.currentStreamGameId,
      startedAt: recapStatus.twitchStreamStartedAt,
      uptimeMs: recapStatus.streamUptimeMs
    },
    bot: {
      online: botConnected,
      loggingMessages: recapStatus.loggingMessages,
      recapPaused: recapStatus.recapPaused,
      messagesInWindow: recapStatus.messagesInWindow,
      twitchEventsInWindow: recapStatus.twitchEventsInWindow || 0,
      contextChangesInWindow: recapStatus.contextChangesInWindow,
      recapInProgress: recapStatus.recapInProgress,
      nextRecapAt: recapStatus.nextRecapAt,
      pausedRemainingMs: recapStatus.pausedRemainingMs
    },
    database: {
      connected: databaseConnected
    },
    oauth: {
      configured: Boolean(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET),
      stored: authStatus.stored,
      username: authStatus.username,
      scopes: authStatus.scopes,
      updatedAt: authStatus.updatedAt,
      usingMongoOAuth,
      botMissingScopes: chatApiStatus.botMissingScopes || [],
      broadcaster: {
        stored: broadcasterAuthStatus.stored,
        username: broadcasterAuthStatus.username,
        scopes: broadcasterAuthStatus.scopes,
        updatedAt: broadcasterAuthStatus.updatedAt,
        missingScopes: broadcasterMissingAllScopes
      },
      chatApiReady: Boolean(chatApiStatus.ready)
    },
    eventsub: {
      requiredScopes: REQUIRED_EVENTSUB_SCOPES,
      lastEnsureAt: eventSubStatus.lastEnsureAt,
      lastEnsureError: eventSubStatus.lastEnsureError,
      subscriptions: eventSubStatus.lastEnsureResults,
      lastEventAt: eventSubStatus.lastEventAt
    }
  });
});

app.post('/mod-login', (req, res) => {
  if (!DASHBOARD_PASSWORD) {
    return res.status(500).json({ success: false, error: 'DASHBOARD_PASSWORD is not configured on the server.' });
  }

  if (!modSessionManager.isValidPassword(req.body.password)) {
    return res.status(401).json({ success: false, error: 'Incorrect password!' });
  }

  modSessionManager.createSession(res);
  return res.json({ success: true, expiresInMs: MOD_SESSION_LIFETIME });
});

app.get('/mod-session', (req, res) => {
  return res.json({ success: true, authenticated: modSessionManager.hasValidSession(req) });
});

app.post('/stream-lore/get', requireModSession, async (req, res) => {

  if (!databaseConnected) {
    return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
  }

  try {
    const lore = await getStreamLore(channelName);
    return res.json({
      success: true,
      text: lore.text,
      updatedAt: lore.updatedAt,
      maxLength: MAX_STREAM_LORE_LENGTH
    });
  } catch (err) {
    console.error('[Lore] Could not load stream-specific lore:', err.message || err);
    return res.status(500).json({ success: false, error: 'Could not load stream-specific lore.' });
  }
});

app.post('/stream-lore/save', requireModSession, async (req, res) => {

  if (!databaseConnected) {
    return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
  }

  const text = typeof req.body.text === 'string' ? req.body.text : '';

  if (text.length > MAX_STREAM_LORE_LENGTH) {
    return res.status(400).json({ success: false, error: `Lore is too long. Maximum is ${MAX_STREAM_LORE_LENGTH} characters.` });
  }

  try {
    const lore = await saveStreamLore(channelName, text);
    console.log(`[Lore] Stream-specific lore saved to MongoDB (${lore.text.length} characters).`);
    return res.json({
      success: true,
      text: lore.text,
      updatedAt: lore.updatedAt,
      maxLength: MAX_STREAM_LORE_LENGTH
    });
  } catch (err) {
    console.error('[Lore] Could not save stream-specific lore:', err.message || err);
    return res.status(500).json({ success: false, error: err.message || 'Could not save stream-specific lore.' });
  }
});

app.post('/recap-prompt/get', requireModSession, async (req, res) => {
  if (!databaseConnected) {
    return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
  }

  try {
    const promptConfig = await getRecapPromptConfig(channelName);
    return res.json({
      success: true,
      primaryInstructions: promptConfig.primaryInstructions,
      expansionInstructions: promptConfig.expansionInstructions,
      source: promptConfig.source,
      updatedAt: promptConfig.updatedAt,
      maxPrimaryLength: MAX_PRIMARY_INSTRUCTIONS_LENGTH,
      maxExpansionLength: MAX_EXPANSION_INSTRUCTIONS_LENGTH
    });
  } catch (err) {
    console.error('[Recap Prompt] Could not load prompt settings:', err.message || err);
    return res.status(500).json({ success: false, error: 'Could not load recap prompt settings.' });
  }
});

app.post('/recap-prompt/save', requireModSession, async (req, res) => {
  if (!databaseConnected) {
    return res.status(503).json({ success: false, error: 'MongoDB is not connected.' });
  }

  const primaryInstructions = typeof req.body.primaryInstructions === 'string' ? req.body.primaryInstructions : '';
  const expansionInstructions = typeof req.body.expansionInstructions === 'string' ? req.body.expansionInstructions : '';

  try {
    const promptConfig = await saveRecapPromptConfig({
      channelName,
      primaryInstructions,
      expansionInstructions
    });
    console.log(`[Recap Prompt] Saved editable recap instructions to MongoDB (${promptConfig.primaryInstructions.length} primary chars, ${promptConfig.expansionInstructions.length} expansion chars).`);
    return res.json({
      success: true,
      primaryInstructions: promptConfig.primaryInstructions,
      expansionInstructions: promptConfig.expansionInstructions,
      source: promptConfig.source,
      updatedAt: promptConfig.updatedAt,
      maxPrimaryLength: MAX_PRIMARY_INSTRUCTIONS_LENGTH,
      maxExpansionLength: MAX_EXPANSION_INSTRUCTIONS_LENGTH
    });
  } catch (err) {
    console.error('[Recap Prompt] Could not save prompt settings:', err.message || err);
    return res.status(400).json({ success: false, error: err.message || 'Could not save recap prompt settings.' });
  }
});

app.post('/auth/twitch/start', requireModSession, (req, res) => {

  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    return res.status(500).json({ success: false, error: 'TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET is not configured.' });
  }

  if (!databaseConnected) {
    return res.status(500).json({ success: false, error: 'MongoDB is not connected.' });
  }

  const state = createOAuthState();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: TWITCH_CLIENT_ID,
    redirect_uri: TWITCH_REDIRECT_URI,
    scope: TWITCH_OAUTH_SCOPES.join(' '),
    state,
    force_verify: 'true'
  });

  res.json({
    success: true,
    authorizationUrl: `https://id.twitch.tv/oauth2/authorize?${params.toString()}`
  });
});

app.get('/auth/twitch/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  cleanupOAuthStates();
  cleanupBroadcasterOAuthStates();

  const isBotAuthorization = Boolean(state && oauthStates.has(state));
  const isBroadcasterAuthorization = Boolean(state && broadcasterOauthStates.has(state));

  if (!isBotAuthorization && !isBroadcasterAuthorization) {
    return res.status(400).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>OAuth request expired</h2><p>Return to the dashboard and start authorization again.</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></body></html>`);
  }

  if (isBotAuthorization) consumeOAuthState(state);
  if (isBroadcasterAuthorization) consumeBroadcasterOAuthState(state);

  if (error) {
    const who = isBroadcasterAuthorization ? 'Broadcaster' : 'Bot';
    return res.status(400).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>${who} Twitch authorization failed</h2><p>${escapeHtmlServer(errorDescription || error)}</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></body></html>`);
  }

  if (!code) return res.status(400).send('Missing Twitch authorization code.');

  try {
    if (isBroadcasterAuthorization) {
      const tokenData = await exchangeBroadcasterAuthorizationCode({
        code,
        redirectUri: TWITCH_REDIRECT_URI
      });

      const validation = await validateBroadcasterAccessToken(tokenData.access_token);
      const authorizedLogin = (validation.login || '').toLowerCase().trim();

      if (channelName && authorizedLogin !== channelName) {
        return res.status(400).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>Wrong broadcaster account</h2><p>You authorized <strong>${escapeHtmlServer(authorizedLogin || 'unknown')}</strong>, but TWITCH_CHANNEL is <strong>${escapeHtmlServer(channelName)}</strong>.</p><p>Log into Twitch as the broadcaster/channel owner and try again.</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></body></html>`);
      }

      const scopes = Array.isArray(validation.scopes) ? validation.scopes : [];
      const missingScopes = TWITCH_BROADCASTER_SCOPES.filter((scope) => !scopes.includes(scope));

      if (missingScopes.length > 0) {
        return res.status(400).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>Missing broadcaster permission</h2><p>Missing: ${escapeHtmlServer(missingScopes.join(', '))}</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></body></html>`);
      }

      await storeBroadcasterAuthorizationCodeResult(tokenData);
      console.log(`[OAuth] Broadcaster authorization saved to MongoDB for ${authorizedLogin}.`);

      let eventSubNote = 'EventSub setup will be retried automatically if needed.';
      try {
        const eventSubResults = await ensureEventSubSubscriptions();
        const failures = eventSubResults.filter((item) => item.status === 'error');
        eventSubNote = failures.length
          ? `Broadcaster OAuth succeeded. ${failures.length} EventSub subscription(s) need a retry; check Render logs.`
          : `Broadcaster OAuth succeeded and ${eventSubResults.length} Twitch EventSub subscriptions were created or already existed.`;
      } catch (eventSubErr) {
        console.error('[EventSub] Setup after broadcaster OAuth failed:', eventSubErr.message || eventSubErr);
      }

      return res.send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><div style="max-width:700px;margin:auto;background:#18181b;padding:24px;border-radius:8px"><h2 style="color:#00f59b">Broadcaster authorization successful</h2><p>Authorized broadcaster: <strong>${escapeHtmlServer(authorizedLogin)}</strong></p><p>The bot-badge and EventSub permissions were stored securely in MongoDB.</p><p>${escapeHtmlServer(eventSubNote)}</p><p>Return to the dashboard. When the bot authorization is also updated, the dashboard will show <strong>BOT BADGE READY</strong>.</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></div></body></html>`);
    }

    const tokenData = await exchangeAuthorizationCode({
      code,
      redirectUri: TWITCH_REDIRECT_URI
    });

    const validation = await validateAccessToken(tokenData.access_token);
    const authorizedLogin = (validation.login || '').toLowerCase().trim();

    const existingBotAuth = databaseConnected ? await getStoredAuth() : null;
    const authorizedUserId = String(validation.user_id || '');
    const storedBotUserId = String(existingBotAuth?.twitchUserId || '');

    // Rename-proof identity check: once we know the bot's stable Twitch user ID,
    // trust that ID instead of a changeable login name. On first authorization,
    // fall back to TWITCH_BOT_USERNAME so the wrong account still cannot be saved.
    if (storedBotUserId) {
      if (!authorizedUserId || authorizedUserId !== storedBotUserId) {
        return res.status(400).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>Wrong Twitch account</h2><p>The Twitch account you authorized does not match the bot account already stored for this application.</p><p>Log into Twitch as <strong>${escapeHtmlServer(botUsername || 'the configured bot account')}</strong> and try again.</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></body></html>`);
      }
    } else if (botUsername && authorizedLogin !== botUsername) {
      return res.status(400).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>Wrong Twitch account</h2><p>You authorized <strong>${escapeHtmlServer(authorizedLogin || 'unknown')}</strong>, but TWITCH_BOT_USERNAME is <strong>${escapeHtmlServer(botUsername)}</strong>.</p><p>Log into Twitch as the bot account and try again.</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></body></html>`);
    }

    const scopes = Array.isArray(validation.scopes) ? validation.scopes : [];
    const missingScopes = TWITCH_OAUTH_SCOPES.filter((scope) => !scopes.includes(scope));

    if (missingScopes.length > 0) {
      return res.status(400).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>Missing Twitch permissions</h2><p>Missing: ${escapeHtmlServer(missingScopes.join(', '))}</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></body></html>`);
    }

    await storeAuthorizationCodeResult(tokenData);
    usingMongoOAuth = true;
    console.log(`[OAuth] Bot authorization saved to MongoDB for ${authorizedLogin}.`);

    setTimeout(() => {
      reconnectTwitchClient('updated MongoDB OAuth authorization').catch((err) => {
        console.error('[OAuth] Twitch reconnect after authorization failed:', err.message || err);
      });
    }, 500);

    return res.send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><div style="max-width:700px;margin:auto;background:#18181b;padding:24px;border-radius:8px"><h2 style="color:#00f59b">Bot authorization successful</h2><p>Authorized account: <strong>${escapeHtmlServer(authorizedLogin)}</strong></p><p>The bot grant now includes the scopes used for Twitch's modern Chat API, the legacy IRC connection used to receive chat, and temporary hourly-recap pinning.</p><p>Return to the dashboard and complete broadcaster authorization if it is still pending.</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></div></body></html>`);
  } catch (err) {
    console.error('[OAuth] Twitch callback failed:', err.message || err);
    return res.status(500).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>Twitch OAuth error</h2><p>${escapeHtmlServer(err.message)}</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></body></html>`);
  }
});

app.get('/authorize-qwert', async (req, res) => {
  res.set('Referrer-Policy', 'no-referrer');
  if (!QWERT_OAUTH_LINK_SECRET) {
    return res.status(503).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>Broadcaster authorization is not configured</h2><p>QWERT_OAUTH_LINK_SECRET is missing on the server.</p></body></html>`);
  }

  if (!isValidQwertOAuthSecret(String(req.query.key || ''))) {
    return res.status(403).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>Invalid authorization link</h2><p>This private Qwert authorization link is invalid.</p></body></html>`);
  }

  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    return res.status(500).send('TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET is not configured.');
  }

  if (!databaseConnected) {
    return res.status(500).send('MongoDB is not connected.');
  }

  try {
    const existing = await getBroadcasterAuthStatus();
    const scopes = Array.isArray(existing.scopes) ? existing.scopes : [];
    const alreadyAuthorized = existing.stored && TWITCH_BROADCASTER_SCOPES.every((scope) => scopes.includes(scope));

    if (alreadyAuthorized) {
      return res.status(410).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><div style="max-width:700px;margin:auto;background:#18181b;padding:24px;border-radius:8px"><h2 style="color:#00f59b">Authorization link already used</h2><p><strong>${escapeHtmlServer(existing.username || channelName || 'Qwert')}</strong> has already granted all currently required broadcaster permissions.</p><p>This private authorization link is no longer needed.</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></div></body></html>`);
    }
  } catch (err) {
    console.error('[OAuth] Could not check existing broadcaster authorization:', err.message || err);
    return res.status(500).send('Could not verify broadcaster authorization status.');
  }

  const state = createBroadcasterOAuthState();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: TWITCH_CLIENT_ID,
    redirect_uri: TWITCH_REDIRECT_URI,
    scope: TWITCH_BROADCASTER_SCOPES.join(' '),
    state,
    force_verify: 'true'
  });

  res.redirect(`https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
});

app.get('/auth/broadcaster/start', (req, res) => {
  return res.status(404).send('Broadcaster OAuth is available only through the private Qwert authorization link.');
});


app.post('/render-logs', requireModSession, async (req, res) => {

  try {
    const config = getRenderLogsConfigStatus();
    if (!config.configured) {
      return res.status(503).json({
        success: false,
        configured: false,
        error: config.error
      });
    }

    const result = await getRecentRenderLogs({ limit: 100 });
    return res.json({
      success: true,
      configured: true,
      serviceName: result.serviceName,
      logs: result.logs,
      hasMore: result.hasMore
    });
  } catch (err) {
    console.error('[Render Logs] Could not load logs:', err.message || err);
    return res.status(err.status || 500).json({
      success: false,
      configured: true,
      error: err.message || 'Could not load Render logs.'
    });
  }
});

app.post('/recap-control', requireModSession, async (req, res) => {

  if (!recapManager) {
    return res.status(503).json({ success: false, error: 'Recap manager is not ready.' });
  }

  try {
    let result;
    if (req.body.action === 'stop') {
      result = await recapManager.stopRecap({ channel: channelName, displayName: 'WebUI MOD', announce: false });
    } else if (req.body.action === 'start') {
      result = await recapManager.startRecap({ channel: channelName, displayName: 'WebUI MOD', announce: false });
    } else {
      return res.status(400).json({ success: false, error: 'Invalid recap-control action.' });
    }

    res.json(result);
  } catch (err) {
    console.error('WebUI recap-control error:', err);
    res.status(500).json({ success: false, error: 'Failed to change recap state.' });
  }
});


app.post('/custom-commands/list', requireModSession, async (req, res) => {
  if (!databaseConnected || !customCommandManager) {
    return res.status(503).json({ success: false, error: 'Custom commands require MongoDB to be connected.' });
  }

  try {
    const commands = await customCommandManager.listCommands();
    return res.json({ success: true, commands });
  } catch (err) {
    console.error('[Custom Commands] Could not list commands:', err.message || err);
    return res.status(500).json({ success: false, error: err.message || 'Could not load custom commands.' });
  }
});

app.post('/custom-commands/save', requireModSession, async (req, res) => {
  if (!databaseConnected || !customCommandManager) {
    return res.status(503).json({ success: false, error: 'Custom commands require MongoDB to be connected.' });
  }

  try {
    const command = await customCommandManager.saveCommand(req.body || {});
    return res.json({ success: true, command });
  } catch (err) {
    console.error('[Custom Commands] Could not save command:', err.message || err);
    return res.status(400).json({ success: false, error: err.message || 'Could not save custom command.' });
  }
});

app.post('/custom-commands/delete', requireModSession, async (req, res) => {
  if (!databaseConnected || !customCommandManager) {
    return res.status(503).json({ success: false, error: 'Custom commands require MongoDB to be connected.' });
  }

  try {
    await customCommandManager.deleteCommand(String(req.body?.id || ''));
    return res.json({ success: true });
  } catch (err) {
    console.error('[Custom Commands] Could not delete command:', err.message || err);
    return res.status(400).json({ success: false, error: err.message || 'Could not delete custom command.' });
  }
});

app.post('/custom-commands/toggle', requireModSession, async (req, res) => {
  if (!databaseConnected || !customCommandManager) {
    return res.status(503).json({ success: false, error: 'Custom commands require MongoDB to be connected.' });
  }

  try {
    const command = await customCommandManager.setEnabled(String(req.body?.id || ''), Boolean(req.body?.enabled));
    return res.json({ success: true, command });
  } catch (err) {
    console.error('[Custom Commands] Could not toggle command:', err.message || err);
    return res.status(400).json({ success: false, error: err.message || 'Could not update custom command.' });
  }
});

app.post('/custom-commands/set-counter', requireModSession, async (req, res) => {
  if (!databaseConnected || !customCommandManager) {
    return res.status(503).json({ success: false, error: 'Custom commands require MongoDB to be connected.' });
  }

  try {
    const command = await customCommandManager.setCounter(String(req.body?.id || ''), req.body?.counter);
    return res.json({ success: true, command });
  } catch (err) {
    console.error('[Custom Commands] Could not set counter:', err.message || err);
    return res.status(400).json({ success: false, error: err.message || 'Could not set custom command counter.' });
  }
});

app.post('/send-chat', requireModSession, async (req, res) => {
  const { message } = req.body;

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ success: false, error: 'Message cannot be empty.' });
  }

  try {
    const sendResult = await chatClientProxy.say(channelName, message.trim());

    res.json({
      success: true,
      method: sendResult?.method || 'unknown',
      fallback: Boolean(sendResult?.fallback)
    });
  } catch (err) {
    console.error('Failed to send message:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to send to Twitch.' });
  }
});

app.post('/test-summary', requireModSession, async (req, res) => {

  if (!recapManager) {
    return res.status(503).json({ success: false, error: 'Recap manager is not ready.' });
  }

  const logs = recapManager.getCurrentWindowLogs();
  const streamContexts = recapManager.getCurrentWindowContexts();
  const twitchEvents = recapManager.getCurrentWindowEvents();
  let previousRecaps = [];
  let streamLore = '';

  try {
    previousRecaps = await recapManager.getCurrentStreamRecapHistory(5);
  } catch (historyErr) {
    console.error('Could not load previous recap history for WebUI current-window test:', historyErr.message || historyErr);
    previousRecaps = [];
  }

  try {
    if (databaseConnected) {
      const loreRecord = await getStreamLore(channelName);
      streamLore = String(loreRecord?.text || '');
    }
  } catch (loreErr) {
    console.error('Could not load stream-specific lore for WebUI current-window test:', loreErr.message || loreErr);
    streamLore = '';
  }

  if (logs.length === 0 && twitchEvents.length === 0) {
    return res.status(400).json({ success: false, error: 'There are currently no messages or Twitch events in the active automatic recap window.' });
  }

  try {
    const recapStatus = recapManager.getStatus();
    const generatedAtMs = Date.now();
    const streamTiming = {
      startedAtMs: recapStatus.twitchStreamStartedAt || 0,
      generatedAtMs,
      uptimeMs: recapStatus.twitchStreamStartedAt ? Math.max(0, generatedAtMs - recapStatus.twitchStreamStartedAt) : null
    };
    const result = await generateRecap(logs, streamContexts, twitchEvents, previousRecaps, streamLore, streamTiming, channelName);
    const fullOutput = SUMMARY_PREFIX + result.summary;

    res.json({
      success: true,
      source: 'stored',
      messageCount: logs.length,
      totalValidMessages: logs.length,
      streamContextCount: streamContexts.length,
      twitchEventCount: twitchEvents.length,
      previousRecapContextCount: previousRecaps.length,
      streamLoreCharacterCount: streamLore.length,
      output: fullOutput,
      characterCount: fullOutput.length,
      sanitized: result.sanitization.sanitized,
      censoredCount: result.sanitization.censoredCount,
      affectedMessages: result.sanitization.affectedMessages
    });
  } catch (err) {
    console.error('Summary test error:', err);
    res.status(500).json({
      success: false,
      error: {
        message: err.message,
        name: err.name,
        details: err.toString(),
        inputBlocked: err.inputBlocked || false
      }
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'webui', 'index.html'));
});

async function bootstrap() {
  try {
    await connectDatabase();
    databaseConnected = true;
  } catch (err) {
    databaseConnected = false;
    console.error('[Database] Startup failed:', err.message || err);
    console.error('[Database] The web dashboard will still start, but MongoDB OAuth cannot work until the connection is fixed.');
  }

  if (databaseConnected && customCommandManager) {
    try {
      await customCommandManager.initialize();
    } catch (err) {
      console.error('[Custom Commands] Startup load failed:', err.message || err);
    }
  }

  recapManager = createRecapManager({
    client: chatClientProxy,
    channelName,
    getTwitchAccessToken: getBotAccessToken,
    refreshTwitchAccessToken: refreshBotAccessToken,
    validateTwitchAccessToken: validateAnyBotToken
  });

  const accessToken = await resolveStartupToken();

  if (accessToken) {
    try {
      await createAndConnectTwitchClient(accessToken);
      await recapManager.start();
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
        console.log('[OAuth] Broadcaster token validated at startup.');
      }
    } catch (err) {
      if (err?.reauthorizationRequired) {
        console.error('[OAuth] Broadcaster authorization cannot be refreshed. Qwert must authorize again.');
      } else {
        console.log('[OAuth] Broadcaster startup validation pending:', err.message || err);
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
  console.error('Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
  console.log('Gemini model: gemini-3.5-flash-lite');
  console.log(`Twitch chat message limit: ${TWITCH_MESSAGE_LIMIT}`);
  console.log('Automatic hourly recap mode enabled.');
  console.log('First recap: 60 minutes.');
  console.log('Recurring recap: every 60 minutes.');
  console.log('Stream title/category check: every 30 seconds.');
  console.log(`Twitch OAuth callback: ${TWITCH_REDIRECT_URI}`);
  console.log('Twitch OAuth tokens are stored in MongoDB and are never logged.');
  console.log('OAuth health: bot and broadcaster sessions validate automatically every 50 minutes and refresh on 401.');
});

bootstrap().catch((err) => {
  console.error('[Startup] Fatal bootstrap error:', err);
});
