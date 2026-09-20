const { fetchWithTimeout: fetch } = require('./httpClient');
const crypto = require('crypto');
const { getAppAccessToken } = require('./twitchChat');
const { getStoredBroadcasterAuth } = require('./twitchBroadcasterAuth');
const { TWITCH_EVENTSUB_CALLBACK_URL } = require('../config/app');

const EVENTSUB_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions';
const CALLBACK_URL = TWITCH_EVENTSUB_CALLBACK_URL;

// Legacy/current EventSub permissions. Missing one no longer blocks unrelated
// subscriptions; each subscription definition checks only the scope it needs.
const REQUIRED_EVENTSUB_SCOPES = [
  'channel:read:subscriptions',
  'bits:read',
  'moderator:read:followers',
  'channel:read:hype_train'
];

// Optional awareness features. These are requested during broadcaster OAuth,
// but existing broadcaster grants can keep running without them until Qwert
// conveniently reauthorizes.
const OPTIONAL_EVENTSUB_SCOPES = [
  'channel:read:polls',
  'channel:read:predictions',
  'channel:read:redemptions',
  'channel:read:goals',
  'channel:read:ads',
  'moderator:read:shoutouts',
  'channel:read:vips',
  'channel:read:charity'
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
    .update(`twitchbot:eventsub:${clientSecret}`)
    .digest('hex');
}

function getSubscriptionDefinitions(broadcasterUserId) {
  const broadcaster = { broadcaster_user_id: broadcasterUserId };
  return [
    { type: 'channel.subscribe', version: '1', condition: broadcaster, anyScopes: ['channel:read:subscriptions'] },
    { type: 'channel.subscription.message', version: '1', condition: broadcaster, anyScopes: ['channel:read:subscriptions'] },
    { type: 'channel.subscription.gift', version: '1', condition: broadcaster, anyScopes: ['channel:read:subscriptions'] },
    { type: 'channel.cheer', version: '1', condition: broadcaster, anyScopes: ['bits:read'] },
    {
      type: 'channel.follow',
      version: '2',
      condition: { broadcaster_user_id: broadcasterUserId, moderator_user_id: broadcasterUserId },
      anyScopes: ['moderator:read:followers']
    },
    { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: broadcasterUserId } },
    { type: 'channel.hype_train.begin', version: '2', condition: broadcaster, anyScopes: ['channel:read:hype_train'] },
    { type: 'channel.hype_train.end', version: '2', condition: broadcaster, anyScopes: ['channel:read:hype_train'] },
    { type: 'stream.online', version: '1', condition: broadcaster },
    { type: 'stream.offline', version: '1', condition: broadcaster },

    // Optional read-only broadcaster awareness.
    { type: 'channel.poll.begin', version: '1', condition: broadcaster, anyScopes: ['channel:read:polls', 'channel:manage:polls'], optional: true },
    { type: 'channel.poll.progress', version: '1', condition: broadcaster, anyScopes: ['channel:read:polls', 'channel:manage:polls'], optional: true },
    { type: 'channel.poll.end', version: '1', condition: broadcaster, anyScopes: ['channel:read:polls', 'channel:manage:polls'], optional: true },
    { type: 'channel.prediction.begin', version: '1', condition: broadcaster, anyScopes: ['channel:read:predictions', 'channel:manage:predictions'], optional: true },
    { type: 'channel.prediction.progress', version: '1', condition: broadcaster, anyScopes: ['channel:read:predictions', 'channel:manage:predictions'], optional: true },
    { type: 'channel.prediction.lock', version: '1', condition: broadcaster, anyScopes: ['channel:read:predictions', 'channel:manage:predictions'], optional: true },
    { type: 'channel.prediction.end', version: '1', condition: broadcaster, anyScopes: ['channel:read:predictions', 'channel:manage:predictions'], optional: true },
    { type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: broadcaster, anyScopes: ['channel:read:redemptions', 'channel:manage:redemptions'], optional: true },
    { type: 'channel.channel_points_automatic_reward_redemption.add', version: '2', condition: broadcaster, anyScopes: ['channel:read:redemptions', 'channel:manage:redemptions'], optional: true },
    { type: 'channel.goal.begin', version: '1', condition: broadcaster, anyScopes: ['channel:read:goals'], optional: true },
    { type: 'channel.goal.progress', version: '1', condition: broadcaster, anyScopes: ['channel:read:goals'], optional: true },
    { type: 'channel.goal.end', version: '1', condition: broadcaster, anyScopes: ['channel:read:goals'], optional: true },
    { type: 'channel.ad_break.begin', version: '1', condition: broadcaster, anyScopes: ['channel:read:ads'], optional: true }
  ];
}

function definitionScopeAvailable(definition, actualScopes) {
  const accepted = Array.isArray(definition?.anyScopes) ? definition.anyScopes.filter(Boolean) : [];
  if (!accepted.length) return true;
  const granted = new Set(Array.isArray(actualScopes) ? actualScopes : []);
  return accepted.some((scope) => granted.has(scope));
}

async function eventSubFetch(url, options, appAccessToken) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${appAccessToken}`,
      'Client-Id': getClientId(),
      ...(options?.headers || {})
    }
  });

  let data = {};
  if (response.status !== 204) {
    try { data = await response.json(); } catch (_) {}
  }
  return { response, data };
}

async function listSubscriptions(appAccessToken) {
  const subscriptions = [];
  let cursor = '';
  do {
    const params = new URLSearchParams({ first: '100' });
    if (cursor) params.set('after', cursor);
    const { response, data } = await eventSubFetch(`${EVENTSUB_URL}?${params.toString()}`, { method: 'GET' }, appAccessToken);
    if (!response.ok) {
      const detail = data?.message || JSON.stringify(data || {});
      throw new Error(`Could not list EventSub subscriptions: HTTP ${response.status}: ${detail}`);
    }
    if (Array.isArray(data?.data)) subscriptions.push(...data.data);
    cursor = String(data?.pagination?.cursor || '');
  } while (cursor);
  return subscriptions;
}

function normalizedCondition(value) {
  return Object.fromEntries(Object.entries(value || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, String(item ?? '')]));
}

function conditionsEqual(left, right) {
  return JSON.stringify(normalizedCondition(left)) === JSON.stringify(normalizedCondition(right));
}

function subscriptionUsesCallback(subscription) {
  return subscription?.transport?.method === 'webhook' && String(subscription?.transport?.callback || '') === CALLBACK_URL;
}

function subscriptionReferencesBroadcaster(subscription, broadcasterUserId) {
  const wanted = String(broadcasterUserId || '');
  return wanted && Object.values(subscription?.condition || {}).some((value) => String(value || '') === wanted);
}

function subscriptionMatchesDefinition(subscription, definition) {
  return subscriptionUsesCallback(subscription) &&
    String(subscription?.type || '') === definition.type &&
    String(subscription?.version || '') === definition.version &&
    conditionsEqual(subscription?.condition, definition.condition);
}

function subscriptionIsUsable(subscription) {
  return ['enabled', 'webhook_callback_verification_pending'].includes(String(subscription?.status || ''));
}

async function deleteSubscription(subscriptionId, appAccessToken) {
  const params = new URLSearchParams({ id: String(subscriptionId || '') });
  const { response, data } = await eventSubFetch(`${EVENTSUB_URL}?${params.toString()}`, { method: 'DELETE' }, appAccessToken);
  if (!response.ok) {
    const detail = data?.message || JSON.stringify(data || {});
    throw new Error(`delete ${subscriptionId}: HTTP ${response.status}: ${detail}`);
  }
}

async function createSubscription(definition, appAccessToken) {
  const { response, data } = await eventSubFetch(EVENTSUB_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  }, appAccessToken);

  if (response.status === 409) {
    return { type: definition.type, status: 'already_exists', optional: definition.optional === true };
  }

  if (!response.ok) {
    const detail = data?.message || JSON.stringify(data || {});
    throw new Error(`${definition.type}: HTTP ${response.status}: ${detail}`);
  }

  const created = Array.isArray(data.data) ? data.data[0] : null;
  return {
    type: definition.type,
    status: created?.status || 'created',
    subscriptionId: created?.id || null,
    optional: definition.optional === true
  };
}

async function reconcileDefinition(definition, broadcasterUserId, actualScopes, existingSubscriptions, appAccessToken) {
  if (!definitionScopeAvailable(definition, actualScopes)) {
    return {
      type: definition.type,
      status: 'skipped_missing_scope',
      optional: definition.optional === true,
      requiredAnyScope: [...(definition.anyScopes || [])]
    };
  }

  // Only touch subscriptions owned by this QwertBot callback, of this event
  // type, and targeting this broadcaster. Other apps/callbacks/broadcasters are
  // intentionally out of scope even though the app access token can list them.
  const managed = existingSubscriptions.filter((subscription) =>
    subscriptionUsesCallback(subscription) &&
    String(subscription?.type || '') === definition.type &&
    subscriptionReferencesBroadcaster(subscription, broadcasterUserId)
  );
  const exact = managed.filter((subscription) => subscriptionMatchesDefinition(subscription, definition));
  const usable = exact
    .filter(subscriptionIsUsable)
    .sort((a, b) => {
      const aRank = a.status === 'enabled' ? 0 : 1;
      const bRank = b.status === 'enabled' ? 0 : 1;
      if (aRank !== bRank) return aRank - bRank;
      return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
  const keep = usable[0] || null;
  const toDelete = managed.filter((subscription) => !keep || String(subscription.id) !== String(keep.id));

  let removed = 0;
  for (const subscription of toDelete) {
    try {
      await deleteSubscription(subscription.id, appAccessToken);
      removed += 1;
    } catch (err) {
      return {
        type: definition.type,
        status: 'error',
        optional: definition.optional === true,
        error: `${definition.type}: could not remove stale/duplicate subscription: ${err.message || err}`
      };
    }
  }

  if (keep) {
    return {
      type: definition.type,
      status: 'existing',
      twitchStatus: keep.status,
      subscriptionId: keep.id || null,
      removedDuplicates: removed,
      optional: definition.optional === true
    };
  }

  try {
    const created = await createSubscription(definition, appAccessToken);
    return { ...created, removedDuplicates: removed };
  } catch (err) {
    return { type: definition.type, status: 'error', optional: definition.optional === true, error: err.message || String(err) };
  }
}

async function ensureEventSubSubscriptions() {
  const auth = await getStoredBroadcasterAuth();
  if (!auth?.twitchUserId) {
    throw new Error('Broadcaster OAuth is not stored yet.');
  }

  const appAccessToken = await getAppAccessToken();
  const definitions = getSubscriptionDefinitions(auth.twitchUserId);
  const existingSubscriptions = await listSubscriptions(appAccessToken);
  const results = [];

  for (const definition of definitions) {
    results.push(await reconcileDefinition(
      definition,
      auth.twitchUserId,
      auth.scopes,
      existingSubscriptions,
      appAccessToken
    ));
  }

  lastEnsureAt = new Date();
  lastEnsureResults = results;
  const failures = results.filter((item) => item.status === 'error');
  const skipped = results.filter((item) => item.status === 'skipped_missing_scope');
  const requiredSkipped = skipped.filter((item) => item.optional !== true);
  const healthErrors = [
    ...failures.map((item) => item.error),
    ...requiredSkipped.map((item) => `${item.type}: missing required broadcaster scope (${(item.requiredAnyScope || []).join(' or ')})`)
  ].filter(Boolean);
  lastEnsureError = healthErrors.length ? healthErrors.join(' | ') : null;

  if (failures.length) {
    console.warn('[EventSub] Some subscriptions could not be reconciled:', failures.map((item) => item.error).join(' | '));
  }
  if (requiredSkipped.length) {
    console.warn(`[EventSub] ${requiredSkipped.length} required subscription(s) are waiting on broadcaster scope: ${requiredSkipped.map((item) => item.type).join(', ')}`);
  }
  const optionalSkipped = skipped.filter((item) => item.optional === true);
  if (optionalSkipped.length) {
    console.log(`[EventSub] ${optionalSkipped.length} optional subscription(s) skipped because their broadcaster scope is not granted; this does not make EventSub unhealthy: ${optionalSkipped.map((item) => item.type).join(', ')}`);
  }
  const removed = results.reduce((sum, item) => sum + Number(item.removedDuplicates || 0), 0);
  const active = results.filter((item) => !['error', 'skipped_missing_scope'].includes(item.status)).length;
  console.log(`[EventSub] Reconcile complete: ${active} active/present, ${optionalSkipped.length} optional scope skip(s), ${requiredSkipped.length} required scope skip(s), ${failures.length} error(s), ${removed} stale/duplicate removed.`);

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
    optionalScopes: [...OPTIONAL_EVENTSUB_SCOPES],
    lastEnsureAt,
    lastEnsureError,
    lastEnsureResults,
    lastEventAt
  };
}

module.exports = {
  CALLBACK_URL,
  REQUIRED_EVENTSUB_SCOPES,
  OPTIONAL_EVENTSUB_SCOPES,
  ensureEventSubSubscriptions,
  getEventSubStatus,
  noteEventReceived,
  verifyEventSubRequest
};
