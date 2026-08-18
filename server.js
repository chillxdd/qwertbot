const express = require('express');
const tmi = require('tmi.js');
const crypto = require('crypto');

const {
  createRecapManager,
  generateRecap,
  SUMMARY_PREFIX,
  TWITCH_MESSAGE_LIMIT
} = require('./commands/recap');

const { connectDatabase } = require('./services/database');
const { MAX_STREAM_LORE_LENGTH, getStreamLore, saveStreamLore } = require('./services/streamLore');
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
const FALLBACK_ACCESS_TOKEN = (process.env.TWITCH_BOT_ACCESS_TOKEN || '').replace(/^oauth:/i, '').trim();
const channelName = (process.env.TWITCH_CHANNEL || '').toLowerCase().trim();
const botUsername = (process.env.TWITCH_BOT_USERNAME || '').toLowerCase().trim();

app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); }
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

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

const KNOWN_BOT_COMMANDS = new Set([
  '!recap',
  '!stoprecap',
  '!startrecap'
]);

const NIGHTBOT_RESPONSE_WINDOW = 5000;
let pendingBangMessageId = 0;
const pendingBangMessages = [];

function getCommandName(message) {
  return (message || '').trim().split(/\s+/)[0].toLowerCase();
}

function isKnownBotCommand(message) {
  return KNOWN_BOT_COMMANDS.has(getCommandName(message));
}

function isIgnoredUsername(username) {
  return ['nightbot', 'streamelements']
    .filter(Boolean)
    .includes((username || '').toLowerCase().trim());
}

function isBotHourlyRecap(username, message) {
  const normalizedUsername = (username || '').toLowerCase().trim();
  const normalizedMessage = (message || '').trim().toLowerCase();
  return Boolean(
    botUsername &&
    normalizedUsername === botUsername &&
    normalizedMessage.startsWith(SUMMARY_PREFIX.toLowerCase())
  );
}

function isModOrBroadcaster(tags) {
  const badges = tags.badges || {};
  return badges.broadcaster === '1' || tags.mod === true || badges.moderator === '1';
}

function isValidDashboardPassword(password) {
  return Boolean(DASHBOARD_PASSWORD && password === DASHBOARD_PASSWORD);
}

function isValidQwertOAuthSecret(value) {
  if (!QWERT_OAUTH_LINK_SECRET || typeof value !== 'string') return false;

  const provided = Buffer.from(value);
  const expected = Buffer.from(QWERT_OAUTH_LINK_SECRET);

  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
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

function removePendingBangMessage(id) {
  const index = pendingBangMessages.findIndex((item) => item.id === id);
  if (index !== -1) pendingBangMessages.splice(index, 1);
}

function queuePotentialFakeCommand({ username, displayName, rawMessage }) {
  pendingBangMessageId++;

  const pending = {
    id: pendingBangMessageId,
    username: (username || '').toLowerCase().trim(),
    displayName,
    rawMessage,
    createdAt: Date.now(),
    timer: null
  };

  pending.timer = setTimeout(() => {
    removePendingBangMessage(pending.id);
    if (recapManager) {
      recapManager.recordChatMessage({ displayName, rawMessage });
    }
  }, NIGHTBOT_RESPONSE_WINDOW);

  pendingBangMessages.push(pending);
}

function handleNightbotResponse(nightbotMessage) {
  const now = Date.now();

  for (let i = pendingBangMessages.length - 1; i >= 0; i--) {
    const candidate = pendingBangMessages[i];
    if (now - candidate.createdAt > NIGHTBOT_RESPONSE_WINDOW) {
      clearTimeout(candidate.timer);
      pendingBangMessages.splice(i, 1);
      if (recapManager) {
        recapManager.recordChatMessage({
          displayName: candidate.displayName,
          rawMessage: candidate.rawMessage
        });
      }
    }
  }

  if (pendingBangMessages.length === 0) return;

  const lowerNightbotMessage = (nightbotMessage || '').toLowerCase();
  let candidateIndex = -1;

  for (let i = pendingBangMessages.length - 1; i >= 0; i--) {
    const candidate = pendingBangMessages[i];
    if (candidate.username && lowerNightbotMessage.includes(`@${candidate.username}`)) {
      candidateIndex = i;
      break;
    }
  }

  if (candidateIndex === -1) candidateIndex = pendingBangMessages.length - 1;

  const candidate = pendingBangMessages[candidateIndex];
  clearTimeout(candidate.timer);
  pendingBangMessages.splice(candidateIndex, 1);
  console.log(`[Recap] Nightbot responded to ${candidate.rawMessage}; command excluded from recap logs.`);
}

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

  client.on('message', async (channel, tags, message, self) => {
    if (generation !== twitchConnectionGeneration || !recapManager) return;

    const rawMessage = (message || '').trim();
    const lowerMsg = rawMessage.toLowerCase();
    const username = (tags.username || '').toLowerCase().trim();
    const displayName = tags['display-name'] || tags.username || 'viewer';

    if (username === 'nightbot') {
      handleNightbotResponse(rawMessage);
      return;
    }

    if (username === 'streamelements') return;

    // The bot account may also be used manually in Twitch chat. Keep those messages
    // as normal recap context, but never feed a previously-sent hourly recap back
    // into the next recap window. This works whether tmi.js marks the message as
    // self=true or it arrived from another Twitch session using the same account.
    if (isBotHourlyRecap(username, rawMessage)) return;

    if (username === botUsername) {
      recapManager.recordChatMessage({ displayName, rawMessage });
      return;
    }

    if (isKnownBotCommand(rawMessage)) {
      if (lowerMsg === '!stoprecap') {
        if (!isModOrBroadcaster(tags)) return;
        await recapManager.stopRecap({ channel, displayName });
        return;
      }

      if (lowerMsg === '!startrecap') {
        if (!isModOrBroadcaster(tags)) return;
        await recapManager.startRecap({ channel, displayName });
        return;
      }

      if (lowerMsg === '!recap' || lowerMsg.startsWith('!recap ')) {
        await recapManager.handleRecapCommand({ channel, displayName });
        return;
      }

      return;
    }

    if (rawMessage.startsWith('!')) {
      queuePotentialFakeCommand({ username, displayName, rawMessage });
      return;
    }

    recapManager.recordChatMessage({ displayName, rawMessage });
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

  if (!isValidDashboardPassword(req.body.password)) {
    return res.status(401).json({ success: false, error: 'Incorrect password!' });
  }

  res.json({ success: true });
});

app.post('/stream-lore/get', async (req, res) => {
  if (!isValidDashboardPassword(req.body.password)) {
    return res.status(401).json({ success: false, error: 'Incorrect password!' });
  }

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

app.post('/stream-lore/save', async (req, res) => {
  if (!isValidDashboardPassword(req.body.password)) {
    return res.status(401).json({ success: false, error: 'Incorrect password!' });
  }

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

app.post('/auth/twitch/start', (req, res) => {
  if (!isValidDashboardPassword(req.body.password)) {
    return res.status(401).json({ success: false, error: 'Incorrect password!' });
  }

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


app.post('/recap-control', async (req, res) => {
  if (!isValidDashboardPassword(req.body.password)) {
    return res.status(401).json({ success: false, error: 'Incorrect password!' });
  }

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

app.post('/send-chat', async (req, res) => {
  const { password, message } = req.body;

  if (!isValidDashboardPassword(password)) {
    return res.status(401).json({ success: false, error: 'Incorrect password!' });
  }

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

app.post('/test-summary', async (req, res) => {
  const { password } = req.body;

  if (!isValidDashboardPassword(password)) {
    return res.status(401).json({ success: false, error: 'Incorrect password!' });
  }

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
    const result = await generateRecap(logs, streamContexts, twitchEvents, previousRecaps, streamLore, streamTiming);
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
  res.send(`<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>GeneralQwert's Twitch Bot</title>
  <style>
    body{font-family:Arial,sans-serif;background:#0f0f12;color:#fff;margin:0;padding:20px;transition:padding-right .2s ease}.mod-login{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:250px;background:#18181b;border:1px solid #33333d;border-radius:8px;padding:12px;z-index:40;box-shadow:0 8px 30px rgba(0,0,0,.55)}.mod-login h3{margin:0 0 6px}.mod-login input{margin:4px 0 6px;padding:9px}.mod-login button{padding:9px 12px}.recap-controls{display:none;margin-top:10px;padding-top:9px;border-top:1px solid #26262c}body.chat-open{padding-right:390px}.card{max-width:760px;margin:30px auto;background:#18181b;border:1px solid #26262c;border-radius:8px;padding:24px}h2{color:#9146ff;margin-top:0}h3{font-size:13px;color:#adadb8;text-transform:uppercase;margin-top:24px}input,textarea{width:100%;box-sizing:border-box;background:#0e0e10;color:#fff;border:1px solid #3a3a44;border-radius:4px;padding:11px;margin:6px 0 10px}textarea{min-height:220px}button{background:#9146ff;color:#fff;border:0;border-radius:4px;padding:11px 14px;font-weight:bold;cursor:pointer;margin:4px 4px 4px 0}button.secondary{background:#33333d}button.danger{background:#a52f36}button:disabled{opacity:.5}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.box{background:#0e0e10;border:1px solid #26262c;border-radius:6px;padding:14px}.label{font-size:11px;color:#777783;text-transform:uppercase}.value{font-size:16px;font-weight:bold;margin:5px 0}.detail{font-size:12px;color:#adadb8;line-height:1.5}.good{color:#00f59b}.bad{color:#ff4f4f}.warn{color:#f5c542}.section-nav{display:flex;flex-wrap:wrap;gap:8px;border-top:1px solid #2a2a30;margin-top:22px;padding-top:18px}.section-nav button{flex:1 1 190px;margin:0}.section-nav button.active{outline:2px solid #bf94ff;background:#772ce8}.section-panel{display:none;border-top:1px solid #2a2a30;margin-top:18px;padding-top:2px}.section-panel.open{display:block}.oauth-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}.oauth-grid .wide{grid-column:1/-1}.oauth-action{margin-top:10px}.modal-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:100;align-items:center;justify-content:center;padding:20px}.modal-backdrop.open{display:flex}.modal-card{width:min(420px,100%);background:#18181b;border:1px solid #3a3a44;border-radius:8px;padding:18px;box-shadow:0 10px 40px rgba(0,0,0,.5)}.modal-card h3{margin-top:0}.modal-actions{display:flex;justify-content:flex-end;gap:8px}.modal-actions button{margin:0}#protected{display:none}#testResult{white-space:pre-wrap;background:#0e0e10;padding:12px;border-radius:4px;margin-top:10px}a{color:#bf94ff}.chat-sidebar{position:fixed;top:0;right:0;width:360px;height:100vh;background:#0e0e10;border-left:1px solid #2a2a30;z-index:20;transform:translateX(100%);transition:transform .2s ease;display:flex;flex-direction:column}.chat-sidebar.open{transform:translateX(0)}.chat-sidebar iframe{display:block;border:0;width:360px;min-width:360px;height:100vh;background:#0e0e10}.chat-toggle{position:fixed;right:12px;top:14px;z-index:10;box-shadow:0 2px 12px rgba(0,0,0,.35)}body.chat-open .chat-toggle{right:380px}@media(max-width:1100px){body.chat-open{padding-right:20px}.chat-sidebar{width:min(360px,calc(100vw - 54px))}.chat-sidebar iframe{width:100%;min-width:0}body.chat-open .chat-toggle{right:calc(min(360px,calc(100vw - 54px)) + 20px)}}@media(max-width:600px){.grid,.oauth-grid{grid-template-columns:1fr}.oauth-grid .wide{grid-column:auto}.card{padding:18px}.mod-login{width:min(250px,calc(100vw - 110px))}}
  </style>
</head>
<body class="login-active">
<div id="login" class="mod-login">
  <h3>MOD Login</h3>
  <input id="password" type="password" placeholder="MOD password" autocomplete="current-password">
  <button id="loginBtn" type="button">Login</button>
  <div id="loginMsg" class="detail"></div>
</div>
<div class="card">
  <h2>GeneralQwert's Twitch Bot</h2>
  <div class="grid">
    <div class="box"><div class="label">Qwert Status</div><div id="qStatus" class="value warn">Checking...</div><div id="qDetail" class="detail"></div><div id="streamMeta" class="detail"></div></div>
    <div class="box"><div class="label">Bot Status</div><div id="bStatus" class="value warn">Checking...</div><div id="bDetail" class="detail"></div><div id="recapControls" class="recap-controls"><button id="pauseBtn" class="danger">Pause Recaps</button><button id="resumeBtn">Resume Recaps</button><div id="recapMsg" class="detail"></div></div></div>
    <div class="box"><div class="label">MongoDB Status</div><div id="dbStatus" class="value warn">Checking...</div><div id="dbDetail" class="detail"></div></div>
    <div class="box"><div class="label">Twitch Chat API Status</div><div id="chatApiStatusBox" class="value warn">Checking...</div><div id="chatApiDetail" class="detail"></div></div>
  </div>

  <div id="protected">
    <div class="section-nav" role="tablist" aria-label="Bot dashboard sections">
      <button id="messagingTab" class="secondary" type="button">Messaging + AI Recap</button>
      <button id="loreTab" class="secondary" type="button">Lore Management</button>
      <button id="oauthTab" class="secondary" type="button">OAuth Management</button>
    </div>

    <div id="messagingPanel" class="section-panel">
      <h3>Send Message to Twitch</h3>
      <input id="chatMessage" placeholder="Message">
      <button id="sendBtn">Send to Chat</button>
      <div id="chatMsg" class="detail"></div>

      <h3>AI Recap Testing</h3>
      <button id="storedBtn" class="secondary">Test Current Recap Window</button>
      <div id="testResult"></div>
    </div>

    <div id="lorePanel" class="section-panel">
      <h3>Stream Specific Lore</h3>
      <div class="detail">Persistent context for recurring channel lore, callbacks, nicknames, running jokes, or other background that can help the AI interpret current chat. Saved lore stays in MongoDB until you edit it.</div>
      <textarea id="streamLore" maxlength="${MAX_STREAM_LORE_LENGTH}" placeholder="Example: Chat calls the shiny Graveler 'Greg'. The left/middle/right joke refers to an old starter-choice argument..."></textarea>
      <button id="saveLoreBtn">Save Lore</button>
      <div id="loreCount" class="detail">0/${MAX_STREAM_LORE_LENGTH} characters</div>
      <div id="loreMsg" class="detail"></div>
    </div>

    <div id="oauthPanel" class="section-panel">
      <h3>OAuth Management</h3>
      <div class="oauth-grid">
        <div class="box"><div class="label">Bot OAuth</div><div id="oauthStatusBox" class="value warn">Checking...</div><div id="oauthDetail" class="detail"></div><div class="oauth-action"><button id="oauthBtn">Authorize / Reauthorize Twitch Bot</button><div id="oauthMsg" class="detail"></div></div></div>
        <div class="box"><div class="label">Broadcaster OAuth</div><div id="broadcasterStatusBox" class="value warn">Checking...</div><div id="broadcasterDetail" class="detail"></div><div class="oauth-action"><button id="broadcasterOauthBtn">Authorize / Reauthorize Broadcaster</button><div id="broadcasterOauthMsg" class="detail"></div></div></div>
        <div class="box wide"><div class="label">Twitch Chat API</div><div id="oauthChatApiStatusBox" class="value warn">Checking...</div><div id="oauthChatApiDetail" class="detail"></div></div>
      </div>
    </div>
  </div>
</div>
<div id="qwertSecretModal" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="qwertSecretTitle">
  <div class="modal-card">
    <h3 id="qwertSecretTitle">Broadcaster OAuth</h3>
    <label for="qwertSecretInput" class="detail">Enter Secret Key for Qwert:</label>
    <input id="qwertSecretInput" type="password" autocomplete="off" placeholder="Secret key">
    <div class="modal-actions"><button id="qwertSecretCancel" class="secondary" type="button">Cancel</button><button id="qwertSecretOk" type="button">OK</button></div>
  </div>
</div>
<button id="chatToggle" class="chat-toggle secondary" type="button">Hide Chat</button>
<aside id="chatSidebar" class="chat-sidebar open" aria-label="Twitch chat sidebar">
  <iframe id="twitchChatFrame" title="${escapeHtmlServer(channelName || 'Qwert')} Twitch chat" allowfullscreen></iframe>
</aside>
<script>
let password='';let loggedIn=false;
const $=id=>document.getElementById(id);
function esc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;')}
function countdown(ms){const s=Math.max(0,Math.ceil(ms/1000));return Math.floor(s/60)+'min '+(s%60)+'s'}
function uptime(ms){const s=Math.max(0,Math.floor((Number(ms)||0)/1000));const h=Math.floor(s/3600);const m=Math.floor((s%3600)/60);const sec=s%60;return h+'h '+m+'m '+sec+'s'}
function setChatOpen(open){$('chatSidebar').classList.toggle('open',open);document.body.classList.toggle('chat-open',open);$('chatToggle').textContent=open?'Hide Chat':'Show Chat';$('chatToggle').setAttribute('aria-expanded',open?'true':'false')}
const chatParent=location.hostname;
$('twitchChatFrame').src='https://www.twitch.tv/embed/${escapeHtmlServer(channelName || 'generalqwert')}/chat?darkpopout=1&parent='+encodeURIComponent(chatParent);
$('chatToggle').onclick=()=>setChatOpen(!$('chatSidebar').classList.contains('open'));
setChatOpen(true);
async function status(){
  try{
    const d=await (await fetch('/status',{cache:'no-store'})).json();
    $('qStatus').textContent=d.qwert.statusKnown?(d.qwert.live?'LIVE':'OFFLINE'):'CHECKING';
    $('qStatus').className='value '+(d.qwert.live?'good':d.qwert.statusKnown?'bad':'warn');
    $('qDetail').innerHTML='<a target="_blank" rel="noopener noreferrer" href="'+esc(d.qwert.twitchUrl)+'">Watch on Twitch</a><br><a target="_blank" rel="noopener noreferrer" href="https://www.youtube.com/@generalqwert/streams">Watch on YouTube</a>';
    $('streamMeta').innerHTML=d.qwert.live?'<br><b>Title:</b> '+esc(d.qwert.title||'Unknown')+'<br><b>Category:</b> '+esc(d.qwert.category||'Unknown')+'<br><b>Uptime:</b> '+esc(uptime(d.qwert.uptimeMs)):'';

    $('bStatus').textContent=d.bot.online?'ONLINE':'OFFLINE';
    $('bStatus').className='value '+(d.bot.online?'good':'bad');
    let bd=d.bot.loggingMessages?'Logging '+d.bot.messagesInWindow+' message(s) + '+(d.bot.twitchEventsInWindow||0)+' Twitch event(s) for hourly recap':'Not logging recap messages';
    if(d.bot.recapPaused)bd='Recaps PAUSED - '+d.bot.messagesInWindow+' message(s) preserved';
    if(d.bot.recapInProgress)bd+='<br>Recap generation in progress';
    else if(d.bot.nextRecapAt)bd+='<br>Next recap in '+countdown(d.bot.nextRecapAt-Date.now());
    $('bDetail').innerHTML=bd;

    $('dbStatus').textContent=d.database.connected?'CONNECTED':'OFFLINE';
    $('dbStatus').className='value '+(d.database.connected?'good':'bad');
    $('dbDetail').textContent=d.database.connected?'Persistent storage ready':'Check MONGODB_URI / Atlas network access';

    const bm=d.oauth.botMissingScopes||[];
    const bo=d.oauth.broadcaster||{};
    const bmiss=bo.missingScopes||[];
    const botGrantReady=!!(d.oauth.stored&&bm.length===0);
    const broadcasterGrantReady=!!(bo.stored&&bmiss.length===0);

    $('oauthStatusBox').textContent=botGrantReady?'READY':d.oauth.stored?'REAUTHORIZE':'NOT AUTHORIZED';
    $('oauthStatusBox').className='value '+(botGrantReady?'good':'warn');
    $('oauthDetail').innerHTML=d.oauth.stored?'Account: '+esc(d.oauth.username||'unknown')+(bm.length?'<br>Missing: '+esc(bm.join(', ')):'<br>Modern bot grant ready'):'Authorize the bot below.';

    $('broadcasterStatusBox').textContent=broadcasterGrantReady?'READY':bo.stored?'REAUTHORIZE':'NOT AUTHORIZED';
    $('broadcasterStatusBox').className='value '+(broadcasterGrantReady?'good':'warn');
    $('broadcasterDetail').innerHTML=bo.stored?'Account: '+esc(bo.username||'unknown')+(bmiss.length?'<br>Missing: '+esc(bmiss.join(', ')):'<br>Bot badge + EventSub scopes granted'):'Private Qwert authorization link required';

    const chatReady=!!d.oauth.chatApiReady;
    const chatStatus=chatReady?'BOT BADGE READY':'NOT READY';
    const mainChatDetail=chatReady?'Outgoing bot messages use Twitch Send Chat Message API + App Access Token.':(!botGrantReady||!broadcasterGrantReady?'Complete both OAuth grants in OAuth Management':'OAuth grants are present, but Twitch Chat API is not ready. Check Render logs.');
    const oauthChatDetail=chatReady?'Outgoing bot messages use Twitch Send Chat Message API + App Access Token.':(!botGrantReady||!broadcasterGrantReady?'Complete both OAuth grants above.':'OAuth grants are present, but Twitch Chat API is not ready. Check Render logs.');
    $('chatApiStatusBox').textContent=chatStatus;
    $('chatApiStatusBox').className='value '+(chatReady?'good':'warn');
    $('chatApiDetail').textContent=mainChatDetail;
    $('oauthChatApiStatusBox').textContent=chatStatus;
    $('oauthChatApiStatusBox').className='value '+(chatReady?'good':'warn');
    $('oauthChatApiDetail').textContent=oauthChatDetail;

    if(loggedIn){
      $('pauseBtn').disabled=!d.qwert.live||d.bot.recapPaused||d.bot.recapInProgress;
      $('resumeBtn').disabled=!d.qwert.live||!d.bot.recapPaused;
      $('oauthBtn').disabled=!d.oauth.configured||!d.database.connected;
    }
  }catch(e){
    $('bDetail').textContent='Status request failed';
  }
}
async function doLogin(){const p=$('password').value;if(!p)return;const d=await (await fetch('/mod-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})})).json();if(!d.success){$('loginMsg').textContent=d.error;return}password=p;loggedIn=true;$('login').style.display='none';document.body.classList.remove('login-active');$('protected').style.display='block';$('recapControls').style.display='block';await loadLore();status()}
$('loginBtn').onclick=doLogin;
$('password').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();doLogin()}});

const sectionMap={messagingTab:'messagingPanel',loreTab:'lorePanel',oauthTab:'oauthPanel'};
function toggleSection(tabId){
  const targetId=sectionMap[tabId];
  const target=$(targetId);
  const shouldOpen=!target.classList.contains('open');
  Object.entries(sectionMap).forEach(([buttonId,panelId])=>{
    $(panelId).classList.remove('open');
    $(buttonId).classList.remove('active');
    $(buttonId).setAttribute('aria-expanded','false');
  });
  if(shouldOpen){
    target.classList.add('open');
    $(tabId).classList.add('active');
    $(tabId).setAttribute('aria-expanded','true');
  }
}
Object.keys(sectionMap).forEach(tabId=>{
  $(tabId).setAttribute('aria-expanded','false');
  $(tabId).onclick=()=>toggleSection(tabId);
});
$('oauthBtn').onclick=async()=>{const d=await (await fetch('/auth/twitch/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})})).json();if(!d.success){$('oauthMsg').textContent=d.error;return}location.href=d.authorizationUrl};
function openQwertSecretModal(){$('qwertSecretInput').value='';$('qwertSecretModal').classList.add('open');setTimeout(()=>$('qwertSecretInput').focus(),0)}
function closeQwertSecretModal(){$('qwertSecretModal').classList.remove('open');$('qwertSecretInput').value=''}
async function copyQwertOauthUrl(){const secret=$('qwertSecretInput').value.trim();if(!secret)return;const url=location.origin+'/authorize-qwert?key='+encodeURIComponent(secret);try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(url)}else{const ta=document.createElement('textarea');ta.value=url;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.focus();ta.select();document.execCommand('copy');ta.remove()}closeQwertSecretModal();$('broadcasterOauthMsg').textContent='Broadcaster OAuth URL copied to clipboard.'}catch(e){$('broadcasterOauthMsg').textContent='Could not copy the OAuth URL. Check browser clipboard permissions.'}}
$('broadcasterOauthBtn').onclick=openQwertSecretModal;
$('qwertSecretCancel').onclick=closeQwertSecretModal;
$('qwertSecretOk').onclick=copyQwertOauthUrl;
$('qwertSecretInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();copyQwertOauthUrl()}else if(e.key==='Escape'){closeQwertSecretModal()}});
$('qwertSecretModal').addEventListener('click',e=>{if(e.target===$('qwertSecretModal'))closeQwertSecretModal()});

function updateLoreCount(){const text=$('streamLore').value;$('loreCount').textContent=text.length+'/${MAX_STREAM_LORE_LENGTH} characters'}
async function loadLore(){try{$('loreMsg').textContent='Loading...';const d=await (await fetch('/stream-lore/get',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})})).json();if(!d.success){$('loreMsg').textContent=d.error||'Could not load lore.';return}$('streamLore').value=d.text||'';updateLoreCount();$('loreMsg').textContent=d.updatedAt?'Saved lore loaded.':'No lore saved yet.'}catch(e){$('loreMsg').textContent='Could not load lore.'}}
async function saveLore(){try{$('saveLoreBtn').disabled=true;$('loreMsg').textContent='Saving...';const d=await (await fetch('/stream-lore/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password,text:$('streamLore').value})})).json();if(!d.success){$('loreMsg').textContent=d.error||'Could not save lore.';return}$('streamLore').value=d.text||'';updateLoreCount();$('loreMsg').textContent=d.text?'Saved to MongoDB.':'Lore cleared from MongoDB.'}catch(e){$('loreMsg').textContent='Could not save lore.'}finally{$('saveLoreBtn').disabled=false}}
$('streamLore').oninput=updateLoreCount;
$('saveLoreBtn').onclick=saveLore;
async function recapAction(action){const d=await (await fetch('/recap-control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password,action})})).json();$('recapMsg').textContent=d.message||d.error;status()}
$('pauseBtn').onclick=()=>recapAction('stop');$('resumeBtn').onclick=()=>recapAction('start');
$('sendBtn').onclick=async()=>{const message=$('chatMessage').value.trim();if(!message)return;const d=await (await fetch('/send-chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password,message})})).json();if(d.success){$('chatMsg').textContent=d.fallback?'Sent via IRC fallback (no bot badge for this message).':'Sent via Twitch Chat API.';$('chatMessage').value=''}else{$('chatMsg').textContent=d.error||'Failed to send.'}};
async function test(type){const body={password,type};$('testResult').textContent='Generating...';const d=await (await fetch('/test-summary',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();$('testResult').textContent=d.success?d.output+'\\n\\n'+d.characterCount+'/500 characters':(d.error?.message||d.error||'Error')}
$('storedBtn').onclick=()=>test('stored');
status();setInterval(status,15000);
</script>
</body>
</html>`);
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
