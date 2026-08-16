const crypto = require('crypto');
const { getAppAccessToken } = require('./twitchChat');
const { getStoredBroadcasterAuth } = require('./twitchBroadcasterAuth');

const EVENTSUB_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions';
const CALLBACK_URL = 'https://sqwertarmybot.onrender.com/eventsub/twitch';
const REQUIRED_EVENTSUB_SCOPES = [
  'channel:read:subscriptions',
  'bits:read',
  'moderator:read:followers',
  'channel:read:hype_train'
];

let lastEnsureAt = null;
let lastEnsureError = null;
let lastEnsureResults = [];
let lastEventAt = null;

function getClientId() {
  const value = (process.env.TWITCH_CLIENT_ID || '').trim();
  if (!value) throw new Error('TWITCH_CLIENT_ID environment variable is not set.');
  return value;
}

function getEventSubSecret() {
  const clientSecret = (process.env.TWITCH_CLIENT_SECRET || '').trim();
  if (!clientSecret) throw new Error('TWITCH_CLIENT_SECRET environment variable is not set.');
  // Twitch requires a 10-100 character secret. Derive a stable 64-char secret
  // without exposing or transmitting the Twitch Client Secret itself.
  return crypto
    .createHash('sha256')
    .update(`SqwertArmyBot:eventsub:${clientSecret}`)
    .digest('hex');
}

function getSubscriptionDefinitions(broadcasterUserId) {
  return [
    { type: 'channel.subscribe', version: '1', condition: { broadcaster_user_id: broadcasterUserId } },
    { type: 'channel.subscription.message', version: '1', condition: { broadcaster_user_id: broadcasterUserId } },
    { type: 'channel.subscription.gift', version: '1', condition: { broadcaster_user_id: broadcasterUserId } },
    { type: 'channel.cheer', version: '1', condition: { broadcaster_user_id: broadcasterUserId } },
    {
      type: 'channel.follow',
      version: '2',
      condition: { broadcaster_user_id: broadcasterUserId, moderator_user_id: broadcasterUserId }
    },
    { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: broadcasterUserId } },
    { type: 'channel.hype_train.begin', version: '2', condition: { broadcaster_user_id: broadcasterUserId } },
    { type: 'channel.hype_train.end', version: '2', condition: { broadcaster_user_id: broadcasterUserId } },
    { type: 'stream.online', version: '1', condition: { broadcaster_user_id: broadcasterUserId } },
    { type: 'stream.offline', version: '1', condition: { broadcaster_user_id: broadcasterUserId } }
  ];
}

function missingScopes(actualScopes, requiredScopes = REQUIRED_EVENTSUB_SCOPES) {
  const actual = Array.isArray(actualScopes) ? actualScopes : [];
  return requiredScopes.filter((scope) => !actual.includes(scope));
}

async function createSubscription(definition, appAccessToken) {
  const response = await fetch(EVENTSUB_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appAccessToken}`,
      'Client-Id': getClientId(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      type: definition.type,
      version: definition.version,
      condition: definition.condition,
      transport: {
        method: 'webhook',
        callback: CALLBACK_URL,
        secret: getEventSubSecret()
      }
    })
  });

  let data = {};
  try {
    data = await response.json();
  } catch (err) {
    // Use status text below.
  }

  if (response.status === 409) {
    return { type: definition.type, status: 'already_exists' };
  }

  if (!response.ok) {
    const detail = data?.message || JSON.stringify(data || {});
    throw new Error(`${definition.type}: HTTP ${response.status}: ${detail}`);
  }

  return {
    type: definition.type,
    status: Array.isArray(data.data) && data.data[0]?.status ? data.data[0].status : 'created'
  };
}

async function ensureEventSubSubscriptions() {
  const auth = await getStoredBroadcasterAuth();
  if (!auth?.twitchUserId) {
    throw new Error('Broadcaster OAuth is not stored yet.');
  }

  const missing = missingScopes(auth.scopes);
  if (missing.length) {
    throw new Error(`Broadcaster OAuth is missing EventSub scope(s): ${missing.join(', ')}`);
  }

  const appAccessToken = await getAppAccessToken();
  const definitions = getSubscriptionDefinitions(auth.twitchUserId);
  const results = await Promise.all(definitions.map(async (definition) => {
    try {
      return await createSubscription(definition, appAccessToken);
    } catch (err) {
      return { type: definition.type, status: 'error', error: err.message || String(err) };
    }
  }));

  lastEnsureAt = new Date();
  lastEnsureResults = results;
  const failures = results.filter((item) => item.status === 'error');
  lastEnsureError = failures.length ? failures.map((item) => item.error).join(' | ') : null;

  if (failures.length) {
    console.warn('[EventSub] Some subscriptions could not be created:', lastEnsureError);
  } else {
    console.log(`[EventSub] ${results.length} subscriptions are created or already present.`);
  }

  return results;
}

function timingSafeSignatureEqual(provided, expected) {
  try {
    const a = Buffer.from(String(provided || ''));
    const b = Buffer.from(String(expected || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (err) {
    return false;
  }
}

function verifyEventSubRequest(req) {
  const messageId = req.get('Twitch-Eventsub-Message-Id') || '';
  const timestamp = req.get('Twitch-Eventsub-Message-Timestamp') || '';
  const providedSignature = req.get('Twitch-Eventsub-Message-Signature') || '';
  const rawBody = req.rawBody;

  if (!messageId || !timestamp || !providedSignature || !rawBody) return false;

  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 10 * 60 * 1000) {
    return false;
  }

  const hmacMessage = messageId + timestamp + rawBody.toString('utf8');
  const expected = 'sha256=' + crypto
    .createHmac('sha256', getEventSubSecret())
    .update(hmacMessage)
    .digest('hex');

  return timingSafeSignatureEqual(providedSignature, expected);
}

function noteEventReceived() {
  lastEventAt = new Date();
}

function getEventSubStatus() {
  return {
    callbackUrl: CALLBACK_URL,
    requiredScopes: [...REQUIRED_EVENTSUB_SCOPES],
    lastEnsureAt,
    lastEnsureError,
    lastEnsureResults,
    lastEventAt
  };
}

module.exports = {
  CALLBACK_URL,
  REQUIRED_EVENTSUB_SCOPES,
  ensureEventSubSubscriptions,
  getEventSubStatus,
  noteEventReceived,
  verifyEventSubRequest
};
