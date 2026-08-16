const express = require('express');
const tmi = require('tmi.js');
const crypto = require('crypto');

const {
  createRecapManager,
  generateRecap,
  parsePastedChat,
  SUMMARY_PREFIX,
  TWITCH_MESSAGE_LIMIT,
  MAX_PASTED_MESSAGES
} = require('./commands/recap');

const { connectDatabase } = require('./services/database');
const {
  exchangeAuthorizationCode,
  getAccessToken,
  getAuthStatus,
  getValidAccessToken,
  refreshStoredToken,
  storeAuthorizationCodeResult,
  validateAccessToken
} = require('./services/twitchAuth');

const {
  exchangeBroadcasterAuthorizationCode,
  getBroadcasterAuthStatus,
  storeBroadcasterAuthorizationCodeResult,
  validateBroadcasterAccessToken
} = require('./services/twitchBroadcasterAuth');
const {
  getChatApiReadiness,
  sendChatMessageViaApi
} = require('./services/twitchChat');

const app = express();
const PORT = process.env.PORT || 3000;

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const QWERT_OAUTH_LINK_SECRET = (process.env.QWERT_OAUTH_LINK_SECRET || '').trim();
const TWITCH_CLIENT_ID = (process.env.TWITCH_CLIENT_ID || '').trim();
const TWITCH_CLIENT_SECRET = (process.env.TWITCH_CLIENT_SECRET || '').trim();
const TWITCH_REDIRECT_URI = 'https://sqwertarmybot.onrender.com/auth/twitch/callback';
const TWITCH_OAUTH_SCOPES = ['chat:read', 'chat:edit', 'user:read:chat', 'user:write:chat', 'user:bot'];
const TWITCH_BROADCASTER_SCOPES = ['channel:bot'];
const OAUTH_STATE_LIFETIME = 10 * 60 * 1000;
const FALLBACK_ACCESS_TOKEN = (process.env.TWITCH_BOT_ACCESS_TOKEN || '').replace(/^oauth:/i, '').trim();
const channelName = (process.env.TWITCH_CHANNEL || '').toLowerCase().trim();
const botUsername = (process.env.TWITCH_BOT_USERNAME || '').toLowerCase().trim();

app.use(express.json({ limit: '1mb' }));
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
  async say(channel, message) {
    const normalizedChannel = String(channel || '').replace(/^#/, '').toLowerCase();
    if (normalizedChannel && normalizedChannel !== channelName) {
      throw new Error(`SqwertArmyBot is configured to send only to #${channelName}.`);
    }

    try {
      if (!databaseConnected) {
        throw new Error('MongoDB is not connected, so Twitch Chat API authorization cannot be verified.');
      }

      const result = await sendChatMessageViaApi(message);

      console.log('[Chat] Message sent through Twitch Chat API.');

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
  return ['nightbot', 'streamelements', botUsername]
    .filter(Boolean)
    .includes((username || '').toLowerCase().trim());
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
  });

  client.on('notice', async (channel, msgid, message) => {
    if (generation !== twitchConnectionGeneration) return;

    const text = String(message || '').toLowerCase();
    if (
      usingMongoOAuth &&
      (text.includes('login authentication failed') || text.includes('improperly formatted auth'))
    ) {
      console.warn('[OAuth] IRC authentication failed. Trying a token refresh and reconnect.');
      try {
        await refreshBotAccessToken();
        await reconnectTwitchClient('IRC authentication failure');
      } catch (err) {
        console.error('[OAuth] IRC token refresh/reconnect failed:', err.message || err);
      }
    }
  });

  client.on('message', async (channel, tags, message, self) => {
    if (generation !== twitchConnectionGeneration || self || !recapManager) return;

    const rawMessage = (message || '').trim();
    const lowerMsg = rawMessage.toLowerCase();
    const username = (tags.username || '').toLowerCase().trim();
    const displayName = tags['display-name'] || tags.username || 'viewer';

    if (username === 'nightbot') {
      handleNightbotResponse(rawMessage);
      return;
    }

    if (username === 'streamelements' || username === botUsername) return;

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

async function reconnectTwitchClient(reason = 'manual reconnect') {
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

    const accessToken = await getBotAccessToken();
    await createAndConnectTwitchClient(accessToken);
    console.log('[Bot] Twitch client reconnected successfully.');
  } finally {
    twitchReconnectInProgress = false;
  }
}

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

  try {
    if (databaseConnected) {
      [authStatus, broadcasterAuthStatus, chatApiStatus] = await Promise.all([
        getAuthStatus(),
        getBroadcasterAuthStatus(),
        getChatApiReadiness()
      ]);
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
      gameId: recapStatus.currentStreamGameId
    },
    bot: {
      online: botConnected,
      loggingMessages: recapStatus.loggingMessages,
      recapPaused: recapStatus.recapPaused,
      messagesInWindow: recapStatus.messagesInWindow,
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
        missingScopes: chatApiStatus.broadcasterMissingScopes || []
      },
      chatApiReady: Boolean(chatApiStatus.ready)
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
      console.log(`[OAuth] Broadcaster channel:bot authorization saved to MongoDB for ${authorizedLogin}.`);

      return res.send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><div style="max-width:700px;margin:auto;background:#18181b;padding:24px;border-radius:8px"><h2 style="color:#00f59b">Broadcaster authorization successful</h2><p>Authorized broadcaster: <strong>${escapeHtmlServer(authorizedLogin)}</strong></p><p>The <strong>channel:bot</strong> permission was stored securely in MongoDB.</p><p>Return to the dashboard. When the bot authorization is also updated, the dashboard will show <strong>BOT BADGE READY</strong>.</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></div></body></html>`);
    }

    const tokenData = await exchangeAuthorizationCode({
      code,
      redirectUri: TWITCH_REDIRECT_URI
    });

    const validation = await validateAccessToken(tokenData.access_token);
    const authorizedLogin = (validation.login || '').toLowerCase().trim();

    if (botUsername && authorizedLogin !== botUsername) {
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

    return res.send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><div style="max-width:700px;margin:auto;background:#18181b;padding:24px;border-radius:8px"><h2 style="color:#00f59b">Bot authorization successful</h2><p>Authorized account: <strong>${escapeHtmlServer(authorizedLogin)}</strong></p><p>The bot grant now includes the scopes used for Twitch's modern Chat API as well as the legacy IRC connection used to receive chat.</p><p>Return to the dashboard and complete broadcaster authorization if it is still pending.</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></div></body></html>`);
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
      return res.status(410).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><div style="max-width:700px;margin:auto;background:#18181b;padding:24px;border-radius:8px"><h2 style="color:#00f59b">Authorization link already used</h2><p><strong>${escapeHtmlServer(existing.username || channelName || 'Qwert')}</strong> has already granted <strong>channel:bot</strong>.</p><p>This private authorization link is no longer needed.</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></div></body></html>`);
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
  const { password, type, pastedChat } = req.body;

  if (!isValidDashboardPassword(password)) {
    return res.status(401).json({ success: false, error: 'Incorrect password!' });
  }

  if (!recapManager) {
    return res.status(503).json({ success: false, error: 'Recap manager is not ready.' });
  }

  const sampleChatLogs = [
    'jebadiahchrist: when will you be continuing the Elden ring run?',
    'motmo_: W dalthecow',
    'dude_theguy: @Motmo_ LUL we have fun here',
    'dalthecow: for gl',
    'nightbot: W dalthecow',
    'coosgoose: W dal',
    'jebadiahchrist: holy shit you almost have 200 on twitch',
    'dude_theguy: W dalthecow',
    'perkinssx: W',
    'heifer54321: WW',
    'dumb_boyy: n opole?',
    'coosgoose: @Motmo_ Hahaha he was a formidable foe, he put in more work than I to be sure'
  ].filter((line) => !isIgnoredUsername(line.split(':')[0]));

  let logs;
  let source;
  let totalValidMessages;
  let streamContexts = [];

  if (type === 'stored') {
    logs = recapManager.getCurrentWindowLogs();
    streamContexts = recapManager.getCurrentWindowContexts();
    if (logs.length === 0) {
      return res.status(400).json({ success: false, error: 'There are currently no messages in the active automatic recap window.' });
    }
    source = 'stored';
    totalValidMessages = logs.length;
  } else if (type === 'pasted') {
    if (typeof pastedChat !== 'string' || !pastedChat.trim()) {
      return res.status(400).json({ success: false, error: 'No pasted chat logs were provided.' });
    }

    const parsed = parsePastedChat(pastedChat, ['nightbot', 'streamelements', botUsername]);
    if (parsed.logs.length === 0) {
      return res.status(400).json({ success: false, error: 'No recognizable Twitch chat messages were found.' });
    }

    logs = parsed.logs;
    source = 'pasted';
    totalValidMessages = parsed.totalValidMessages;
  } else {
    logs = sampleChatLogs;
    source = 'sample';
    totalValidMessages = logs.length;
  }

  try {
    const result = await generateRecap(logs, streamContexts);
    const fullOutput = SUMMARY_PREFIX + result.summary;

    res.json({
      success: true,
      source,
      messageCount: logs.length,
      totalValidMessages,
      streamContextCount: streamContexts.length,
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
  <title>SqwertArmyBot Dashboard</title>
  <style>
    body{font-family:Arial,sans-serif;background:#0f0f12;color:#fff;margin:0;padding:20px}.card{max-width:760px;margin:30px auto;background:#18181b;border:1px solid #26262c;border-radius:8px;padding:24px}h2{color:#9146ff;margin-top:0}h3{font-size:13px;color:#adadb8;text-transform:uppercase;margin-top:24px}input,textarea{width:100%;box-sizing:border-box;background:#0e0e10;color:#fff;border:1px solid #3a3a44;border-radius:4px;padding:11px;margin:6px 0 10px}textarea{min-height:220px}button{background:#9146ff;color:#fff;border:0;border-radius:4px;padding:11px 14px;font-weight:bold;cursor:pointer;margin:4px 4px 4px 0}button.secondary{background:#33333d}button.danger{background:#a52f36}button:disabled{opacity:.5}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.box{background:#0e0e10;border:1px solid #26262c;border-radius:6px;padding:14px}.label{font-size:11px;color:#777783;text-transform:uppercase}.value{font-size:16px;font-weight:bold;margin:5px 0}.detail{font-size:12px;color:#adadb8;line-height:1.5}.good{color:#00f59b}.bad{color:#ff4f4f}.warn{color:#f5c542}.section{border-top:1px solid #2a2a30;margin-top:20px;padding-top:18px}#protected{display:none}#testResult{white-space:pre-wrap;background:#0e0e10;padding:12px;border-radius:4px;margin-top:10px}a{color:#bf94ff}@media(max-width:600px){.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
<div class="card">
  <h2>SqwertArmyBot</h2>
  <div class="grid">
    <div class="box"><div class="label">Qwert</div><div id="qStatus" class="value warn">Checking...</div><div id="qDetail" class="detail"></div><div id="streamMeta" class="detail"></div></div>
    <div class="box"><div class="label">Bot</div><div id="bStatus" class="value warn">Checking...</div><div id="bDetail" class="detail"></div></div>
    <div class="box"><div class="label">MongoDB</div><div id="dbStatus" class="value warn">Checking...</div><div id="dbDetail" class="detail"></div></div>
    <div class="box"><div class="label">Bot OAuth</div><div id="oauthStatusBox" class="value warn">Checking...</div><div id="oauthDetail" class="detail"></div></div>
    <div class="box"><div class="label">Broadcaster OAuth</div><div id="broadcasterStatusBox" class="value warn">Checking...</div><div id="broadcasterDetail" class="detail"></div></div>
    <div class="box"><div class="label">Twitch Chat API</div><div id="chatApiStatusBox" class="value warn">Checking...</div><div id="chatApiDetail" class="detail"></div></div>
  </div>

  <div class="section">
    <h3>Qwert Broadcaster Authorization</h3>
    <div class="detail">Broadcaster authorization is protected by a private one-time link. The public dashboard cannot start Qwert's OAuth flow. Once <strong>${escapeHtmlServer(channelName || 'the broadcaster account')}</strong> successfully grants <strong>channel:bot</strong>, the private link stops working.</div>
  </div>

  <div id="login" class="section">
    <h3>MOD Login</h3>
    <input id="password" type="password" placeholder="MOD password">
    <button id="loginBtn">Login</button>
    <div id="loginMsg" class="detail"></div>
  </div>

  <div id="protected">
    <div class="section">
      <h3>Bot OAuth</h3>
      <div class="detail">Authorize the Twitch account named <strong>${escapeHtmlServer(botUsername || 'TWITCH_BOT_USERNAME')}</strong>. This update requests the modern bot scopes needed for the official Send Chat Message API while keeping the IRC scopes used to receive chat.</div>
      <button id="oauthBtn">Reauthorize Twitch Bot for Chat API</button>
      <div id="oauthMsg" class="detail"></div>
    </div>

    <div class="section">
      <h3>Automatic Recaps</h3>
      <button id="pauseBtn" class="danger">Pause Recaps</button>
      <button id="resumeBtn">Resume Recaps</button>
      <div id="recapMsg" class="detail"></div>
    </div>

    <div class="section">
      <h3>Send Message to Twitch</h3>
      <input id="chatMessage" placeholder="Message">
      <button id="sendBtn">Send to Chat</button>
      <div id="chatMsg" class="detail"></div>
    </div>

    <div class="section">
      <h3>AI Recap Testing</h3>
      <button id="sampleBtn" class="secondary">Test Sample Chat</button>
      <button id="storedBtn" class="secondary">Test Current Recap Window</button>
      <textarea id="pasted" placeholder="Paste Render/Twitch chat logs here..."></textarea>
      <button id="pastedBtn" class="secondary">Test Pasted Chat</button>
      <div id="testResult"></div>
    </div>
  </div>
</div>
<script>
let password='';let loggedIn=false;
const $=id=>document.getElementById(id);
function esc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;')}
function countdown(ms){const s=Math.max(0,Math.ceil(ms/1000));return Math.floor(s/60)+'min '+(s%60)+'s'}
async function status(){try{const d=await (await fetch('/status',{cache:'no-store'})).json();$('qStatus').textContent=d.qwert.statusKnown?(d.qwert.live?'LIVE':'OFFLINE'):'CHECKING';$('qStatus').className='value '+(d.qwert.live?'good':d.qwert.statusKnown?'bad':'warn');$('qDetail').innerHTML='<a target="_blank" href="'+esc(d.qwert.twitchUrl)+'">Open Twitch</a>';$('streamMeta').innerHTML=d.qwert.live?'<br><b>Title:</b> '+esc(d.qwert.title||'Unknown')+'<br><b>Category:</b> '+esc(d.qwert.category||'Unknown'):'';$('bStatus').textContent=d.bot.online?'ONLINE':'OFFLINE';$('bStatus').className='value '+(d.bot.online?'good':'bad');let bd=d.bot.loggingMessages?'Logging '+d.bot.messagesInWindow+' message(s) for hourly recap':'Not logging recap messages';if(d.bot.recapPaused)bd='Recaps PAUSED - '+d.bot.messagesInWindow+' message(s) preserved';if(d.bot.recapInProgress)bd+='<br>Recap generation in progress';else if(d.bot.nextRecapAt)bd+='<br>Next recap in '+countdown(d.bot.nextRecapAt-Date.now());$('bDetail').innerHTML=bd;$('dbStatus').textContent=d.database.connected?'CONNECTED':'OFFLINE';$('dbStatus').className='value '+(d.database.connected?'good':'bad');$('dbDetail').textContent=d.database.connected?'Persistent storage ready':'Check MONGODB_URI / Atlas network access';const bm=d.oauth.botMissingScopes||[];$('oauthStatusBox').textContent=d.oauth.stored&&bm.length===0?'READY':d.oauth.stored?'REAUTHORIZE':'NOT AUTHORIZED';$('oauthStatusBox').className='value '+(d.oauth.stored&&bm.length===0?'good':'warn');$('oauthDetail').innerHTML=d.oauth.stored?'Account: '+esc(d.oauth.username||'unknown')+(bm.length?'<br>Missing: '+esc(bm.join(', ')):'<br>Modern bot grant ready'):'MOD login required to authorize bot';const bo=d.oauth.broadcaster||{};const bmiss=bo.missingScopes||[];$('broadcasterStatusBox').textContent=bo.stored&&bmiss.length===0?'READY':bo.stored?'REAUTHORIZE':'NOT AUTHORIZED';$('broadcasterStatusBox').className='value '+(bo.stored&&bmiss.length===0?'good':'warn');$('broadcasterDetail').innerHTML=bo.stored?'Account: '+esc(bo.username||'unknown')+(bmiss.length?'<br>Missing: '+esc(bmiss.join(', ')):'<br>channel:bot granted'):'Private Qwert authorization link required';$('chatApiStatusBox').textContent=d.oauth.chatApiReady?'BOT BADGE READY':'NOT READY';$('chatApiStatusBox').className='value '+(d.oauth.chatApiReady?'good':'warn');$('chatApiDetail').textContent=d.oauth.chatApiReady?'Outgoing bot messages use Twitch Send Chat Message API + App Access Token.':'Complete both OAuth grants above.';if(loggedIn){$('pauseBtn').disabled=!d.qwert.live||d.bot.recapPaused||d.bot.recapInProgress;$('resumeBtn').disabled=!d.qwert.live||!d.bot.recapPaused;$('oauthBtn').disabled=!d.oauth.configured||!d.database.connected}}catch(e){$('bDetail').textContent='Status request failed'}}
$('loginBtn').onclick=async()=>{const p=$('password').value;if(!p)return;const d=await (await fetch('/mod-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})})).json();if(!d.success){$('loginMsg').textContent=d.error;return}password=p;loggedIn=true;$('login').style.display='none';$('protected').style.display='block';status()};
$('oauthBtn').onclick=async()=>{const d=await (await fetch('/auth/twitch/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})})).json();if(!d.success){$('oauthMsg').textContent=d.error;return}location.href=d.authorizationUrl};
async function recapAction(action){const d=await (await fetch('/recap-control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password,action})})).json();$('recapMsg').textContent=d.message||d.error;status()}
$('pauseBtn').onclick=()=>recapAction('stop');$('resumeBtn').onclick=()=>recapAction('start');
$('sendBtn').onclick=async()=>{const message=$('chatMessage').value.trim();if(!message)return;const d=await (await fetch('/send-chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password,message})})).json();if(d.success){$('chatMsg').textContent=d.fallback?'Sent via IRC fallback (no bot badge for this message).':'Sent via Twitch Chat API.';$('chatMessage').value=''}else{$('chatMsg').textContent=d.error||'Failed to send.'}};
async function test(type){const body={password,type};if(type==='pasted')body.pastedChat=$('pasted').value;$('testResult').textContent='Generating...';const d=await (await fetch('/test-summary',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();$('testResult').textContent=d.success?d.output+'\\n\\n'+d.characterCount+'/500 characters':(d.error?.message||d.error||'Error')}
$('sampleBtn').onclick=()=>test('sample');$('storedBtn').onclick=()=>test('stored');$('pastedBtn').onclick=()=>test('pasted');
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
});

bootstrap().catch((err) => {
  console.error('[Startup] Fatal bootstrap error:', err);
});
