const { getStoredAuth } = require('./twitchAuth');
const { getStoredBroadcasterAuth } = require('./twitchBroadcasterAuth');

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_SEND_CHAT_URL = 'https://api.twitch.tv/helix/chat/messages';
const REQUIRED_BOT_APP_SCOPES = ['user:write:chat', 'user:bot'];
const REQUIRED_BROADCASTER_APP_SCOPES = ['channel:bot'];

let cachedAppAccessToken = '';
let cachedAppAccessTokenExpiresAt = 0;

function getClientId() {
  const value = (process.env.TWITCH_CLIENT_ID || '').trim();
  if (!value) throw new Error('TWITCH_CLIENT_ID environment variable is not set.');
  return value;
}

function getClientSecret() {
  const value = (process.env.TWITCH_CLIENT_SECRET || '').trim();
  if (!value) throw new Error('TWITCH_CLIENT_SECRET environment variable is not set.');
  return value;
}

function missingScopes(actualScopes, requiredScopes) {
  const actual = Array.isArray(actualScopes) ? actualScopes : [];
  return requiredScopes.filter((scope) => !actual.includes(scope));
}

async function createAppAccessToken() {
  const body = new URLSearchParams({
    client_id: getClientId(),
    client_secret: getClientSecret(),
    grant_type: 'client_credentials'
  });

  const response = await fetch(TWITCH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  let data = {};
  try {
    data = await response.json();
  } catch (err) {
    // Use status below.
  }

  if (!response.ok || !data.access_token) {
    throw new Error(data?.message || `Could not create Twitch App Access Token. HTTP ${response.status}.`);
  }

  cachedAppAccessToken = data.access_token;
  cachedAppAccessTokenExpiresAt = Date.now() + Math.max(60, Number(data.expires_in || 0) - 120) * 1000;

  console.log('[Twitch Chat API] App Access Token created.');
  return cachedAppAccessToken;
}

async function getAppAccessToken({ forceRefresh = false } = {}) {
  if (
    !forceRefresh &&
    cachedAppAccessToken &&
    cachedAppAccessTokenExpiresAt > Date.now()
  ) {
    return cachedAppAccessToken;
  }

  return createAppAccessToken();
}

async function getChatApiReadiness() {
  const [botAuth, broadcasterAuth] = await Promise.all([
    getStoredAuth(),
    getStoredBroadcasterAuth()
  ]);

  const botMissingScopes = missingScopes(botAuth?.scopes, REQUIRED_BOT_APP_SCOPES);
  const broadcasterMissingScopes = missingScopes(
    broadcasterAuth?.scopes,
    REQUIRED_BROADCASTER_APP_SCOPES
  );

  return {
    ready: Boolean(
      botAuth?.twitchUserId &&
      broadcasterAuth?.twitchUserId &&
      botMissingScopes.length === 0 &&
      broadcasterMissingScopes.length === 0
    ),
    botAuthorized: Boolean(botAuth?.twitchUserId),
    broadcasterAuthorized: Boolean(broadcasterAuth?.twitchUserId),
    botUserId: botAuth?.twitchUserId || null,
    broadcasterUserId: broadcasterAuth?.twitchUserId || null,
    botUsername: botAuth?.username || null,
    broadcasterUsername: broadcasterAuth?.username || null,
    botMissingScopes,
    broadcasterMissingScopes
  };
}

async function sendChatMessageViaApi(message, { retry401 = true } = {}) {
  const text = String(message || '').trim();

  if (!text) {
    throw new Error('Cannot send an empty Twitch chat message.');
  }

  if (text.length > 500) {
    throw new Error(`Twitch chat message is ${text.length} characters; maximum is 500.`);
  }

  const readiness = await getChatApiReadiness();

  if (!readiness.ready) {
    const details = [];
    if (readiness.botMissingScopes.length) {
      details.push(`bot missing ${readiness.botMissingScopes.join(', ')}`);
    }
    if (readiness.broadcasterMissingScopes.length) {
      details.push(`broadcaster missing ${readiness.broadcasterMissingScopes.join(', ')}`);
    }
    if (!readiness.botUserId) details.push('bot authorization missing');
    if (!readiness.broadcasterUserId) details.push('broadcaster authorization missing');

    throw new Error(`Twitch Chat API is not ready: ${details.join('; ')}.`);
  }

  const appAccessToken = await getAppAccessToken();

  const response = await fetch(TWITCH_SEND_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appAccessToken}`,
      'Client-Id': getClientId(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      broadcaster_id: readiness.broadcasterUserId,
      sender_id: readiness.botUserId,
      message: text,
      for_source_only: true
    })
  });

  let data = {};
  try {
    data = await response.json();
  } catch (err) {
    // Use status below.
  }

  if (response.status === 401 && retry401) {
    cachedAppAccessToken = '';
    cachedAppAccessTokenExpiresAt = 0;
    await getAppAccessToken({ forceRefresh: true });
    return sendChatMessageViaApi(text, { retry401: false });
  }

  if (!response.ok) {
    const detail = data?.message || JSON.stringify(data || {});
    throw new Error(`Twitch Send Chat Message API failed with HTTP ${response.status}: ${detail}`);
  }

  const result = Array.isArray(data.data) ? data.data[0] : null;

  if (!result?.is_sent) {
    const dropReason = result?.drop_reason;
    const reason = dropReason?.message || dropReason?.code || 'Twitch did not send the message.';
    throw new Error(`Twitch dropped the chat message: ${reason}`);
  }

  return result;
}

module.exports = {
  REQUIRED_BOT_APP_SCOPES,
  REQUIRED_BROADCASTER_APP_SCOPES,
  getAppAccessToken,
  getChatApiReadiness,
  sendChatMessageViaApi
};
