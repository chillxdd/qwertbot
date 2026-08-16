const { getStoredAuth } = require('./twitchAuth');
const { getStoredBroadcasterAuth } = require('./twitchBroadcasterAuth');

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_SEND_CHAT_URL = 'https://api.twitch.tv/helix/chat/messages';
const TWITCH_CHAT_PINS_URL = 'https://api.twitch.tv/helix/chat/pins';

const REQUIRED_BOT_APP_SCOPES = ['user:write:chat', 'user:bot'];
const REQUIRED_BROADCASTER_APP_SCOPES = ['channel:bot'];
const REQUIRED_BOT_PIN_SCOPES = ['user:bot', 'moderator:manage:chat_messages'];
const REQUIRED_BROADCASTER_PIN_SCOPES = ['channel:bot'];

let cachedAppAccessToken = '';
let cachedAppAccessTokenExpiresAt = 0;
let activePinRestoreTimer = null;
let activeTemporaryPinMessageId = null;

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

async function getAuthorizationSnapshot() {
  const [botAuth, broadcasterAuth] = await Promise.all([
    getStoredAuth(),
    getStoredBroadcasterAuth()
  ]);

  return { botAuth, broadcasterAuth };
}

async function getChatApiReadiness() {
  const { botAuth, broadcasterAuth } = await getAuthorizationSnapshot();

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

async function getPinApiReadiness() {
  const { botAuth, broadcasterAuth } = await getAuthorizationSnapshot();

  const botMissingScopes = missingScopes(botAuth?.scopes, REQUIRED_BOT_PIN_SCOPES);
  const broadcasterMissingScopes = missingScopes(
    broadcasterAuth?.scopes,
    REQUIRED_BROADCASTER_PIN_SCOPES
  );

  return {
    ready: Boolean(
      botAuth?.twitchUserId &&
      broadcasterAuth?.twitchUserId &&
      botMissingScopes.length === 0 &&
      broadcasterMissingScopes.length === 0
    ),
    botUserId: botAuth?.twitchUserId || null,
    broadcasterUserId: broadcasterAuth?.twitchUserId || null,
    botMissingScopes,
    broadcasterMissingScopes
  };
}

function describeReadinessFailure(readiness, label) {
  const details = [];
  if (readiness.botMissingScopes?.length) {
    details.push(`bot missing ${readiness.botMissingScopes.join(', ')}`);
  }
  if (readiness.broadcasterMissingScopes?.length) {
    details.push(`broadcaster missing ${readiness.broadcasterMissingScopes.join(', ')}`);
  }
  if (!readiness.botUserId) details.push('bot authorization missing');
  if (!readiness.broadcasterUserId) details.push('broadcaster authorization missing');
  return `${label} is not ready: ${details.join('; ')}.`;
}

async function twitchApiFetch(url, options = {}, { retry401 = true } = {}) {
  const appAccessToken = await getAppAccessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${appAccessToken}`,
      'Client-Id': getClientId(),
      ...(options.headers || {})
    }
  });

  if (response.status === 401 && retry401) {
    cachedAppAccessToken = '';
    cachedAppAccessTokenExpiresAt = 0;
    await getAppAccessToken({ forceRefresh: true });
    return twitchApiFetch(url, options, { retry401: false });
  }

  return response;
}

async function sendChatMessageViaApi(message) {
  const text = String(message || '').trim();

  if (!text) {
    throw new Error('Cannot send an empty Twitch chat message.');
  }

  if (text.length > 500) {
    throw new Error(`Twitch chat message is ${text.length} characters; maximum is 500.`);
  }

  const readiness = await getChatApiReadiness();

  if (!readiness.ready) {
    throw new Error(describeReadinessFailure(readiness, 'Twitch Chat API'));
  }

  const response = await twitchApiFetch(TWITCH_SEND_CHAT_URL, {
    method: 'POST',
    headers: {
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

async function getPinnedChatMessage() {
  const readiness = await getPinApiReadiness();
  if (!readiness.ready) {
    throw new Error(describeReadinessFailure(readiness, 'Twitch pinned-chat API'));
  }

  const params = new URLSearchParams({
    broadcaster_id: readiness.broadcasterUserId,
    moderator_id: readiness.botUserId
  });

  const response = await twitchApiFetch(`${TWITCH_CHAT_PINS_URL}?${params.toString()}`, {
    method: 'GET'
  });

  let data = {};
  try {
    data = await response.json();
  } catch (err) {
    // Use status below.
  }

  if (!response.ok) {
    const detail = data?.message || JSON.stringify(data || {});
    throw new Error(`Get Pinned Chat Message failed with HTTP ${response.status}: ${detail}`);
  }

  return Array.isArray(data.data) && data.data.length ? data.data[0] : null;
}

async function pinChatMessage(messageId, { durationSeconds = null } = {}) {
  const readiness = await getPinApiReadiness();
  if (!readiness.ready) {
    throw new Error(describeReadinessFailure(readiness, 'Twitch pinned-chat API'));
  }

  const params = new URLSearchParams({
    broadcaster_id: readiness.broadcasterUserId,
    moderator_id: readiness.botUserId,
    message_id: String(messageId)
  });

  if (durationSeconds !== null && durationSeconds !== undefined) {
    const duration = Math.max(30, Math.min(1800, Math.round(Number(durationSeconds))));
    params.set('duration_seconds', String(duration));
  }

  const response = await twitchApiFetch(`${TWITCH_CHAT_PINS_URL}?${params.toString()}`, {
    method: 'PUT'
  });

  if (!response.ok) {
    let data = {};
    try {
      data = await response.json();
    } catch (err) {
      // Use status below.
    }
    const detail = data?.message || JSON.stringify(data || {});
    throw new Error(`Pin Chat Message failed with HTTP ${response.status}: ${detail}`);
  }
}

async function unpinChatMessage(messageId) {
  const readiness = await getPinApiReadiness();
  if (!readiness.ready) {
    throw new Error(describeReadinessFailure(readiness, 'Twitch pinned-chat API'));
  }

  const params = new URLSearchParams({
    broadcaster_id: readiness.broadcasterUserId,
    moderator_id: readiness.botUserId,
    message_id: String(messageId)
  });

  const response = await twitchApiFetch(`${TWITCH_CHAT_PINS_URL}?${params.toString()}`, {
    method: 'DELETE'
  });

  if (!response.ok && response.status !== 404) {
    let data = {};
    try {
      data = await response.json();
    } catch (err) {
      // Use status below.
    }
    const detail = data?.message || JSON.stringify(data || {});
    throw new Error(`Unpin Chat Message failed with HTTP ${response.status}: ${detail}`);
  }
}

function remainingDurationSeconds(previousPin) {
  if (!previousPin?.ends_at) return null;
  const endsAt = Date.parse(previousPin.ends_at);
  if (!Number.isFinite(endsAt)) return null;
  return Math.floor((endsAt - Date.now()) / 1000);
}

async function restorePreviousPin({ temporaryMessageId, previousPin }) {
  let currentPin;
  try {
    currentPin = await getPinnedChatMessage();
  } catch (err) {
    console.warn(`[Pins] Could not verify the current pin before restoration: ${err?.message || err}`);
    return;
  }

  // If a moderator or broadcaster changed the pin while the recap was displayed,
  // respect that manual action and do not overwrite it.
  if (!currentPin || currentPin.message_id !== temporaryMessageId) {
    console.log('[Pins] The temporary recap pin is no longer the active pin. Leaving the current pin state untouched.');
    return;
  }

  if (!previousPin?.message_id) {
    await unpinChatMessage(temporaryMessageId);
    console.log('[Pins] Temporary recap pin removed. There was no previous pin to restore.');
    return;
  }

  const remaining = remainingDurationSeconds(previousPin);

  // If the original pin would naturally have expired while the recap was pinned,
  // do not resurrect it after its original expiry time.
  if (remaining !== null && remaining < 30) {
    await unpinChatMessage(temporaryMessageId);
    console.log('[Pins] Previous pin would have expired during the recap pin window, so it was not restored.');
    return;
  }

  const restoreOptions = remaining === null
    ? { durationSeconds: null }
    : { durationSeconds: Math.min(1800, remaining) };

  await pinChatMessage(previousPin.message_id, restoreOptions);
  console.log('[Pins] Previous pinned message restored after the hourly recap.');
}

async function startTemporaryChatPin({ messageId, previousPin = null, displaySeconds = 60 }) {
  const seconds = Math.max(30, Math.min(1800, Math.round(Number(displaySeconds) || 60)));

  // Give the temporary pin a small buffer so that when the restoration timer runs,
  // Twitch should still report our recap as the active pin. This lets us distinguish
  // normal expiry from a moderator manually changing/unpinning it.
  const twitchPinDuration = Math.min(1800, seconds + 15);

  if (activePinRestoreTimer) {
    clearTimeout(activePinRestoreTimer);
    activePinRestoreTimer = null;
  }

  await pinChatMessage(messageId, { durationSeconds: twitchPinDuration });
  activeTemporaryPinMessageId = messageId;
  console.log(`[Pins] Hourly recap pinned for approximately ${seconds} seconds.`);

  activePinRestoreTimer = setTimeout(() => {
    const temporaryMessageId = messageId;
    activePinRestoreTimer = null;

    restorePreviousPin({ temporaryMessageId, previousPin })
      .catch((err) => {
        console.warn(`[Pins] Could not restore the previous pin: ${err?.message || err}`);
      })
      .finally(() => {
        if (activeTemporaryPinMessageId === temporaryMessageId) {
          activeTemporaryPinMessageId = null;
        }
      });
  }, seconds * 1000);

  return {
    temporaryMessageId: messageId,
    displaySeconds: seconds,
    previousMessageId: previousPin?.message_id || null
  };
}

module.exports = {
  REQUIRED_BOT_APP_SCOPES,
  REQUIRED_BROADCASTER_APP_SCOPES,
  REQUIRED_BOT_PIN_SCOPES,
  REQUIRED_BROADCASTER_PIN_SCOPES,
  getAppAccessToken,
  getChatApiReadiness,
  getPinApiReadiness,
  getPinnedChatMessage,
  pinChatMessage,
  sendChatMessageViaApi,
  startTemporaryChatPin,
  unpinChatMessage
};
