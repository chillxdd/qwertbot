const { getStoredAuth, getValidAccessToken, refreshStoredToken } = require('./twitchAuth');
const { getStoredBroadcasterAuth } = require('./twitchBroadcasterAuth');

const REQUIRED_CHATTERS_SCOPE = 'moderator:read:chatters';
const TWITCH_CHATTERS_URL = 'https://api.twitch.tv/helix/chat/chatters';
const MAX_CHATTER_PAGES = 100;
const DEFAULT_EXCLUDED_LOGINS = new Set([
  'nightbot',
  'streamelements',
  'pokemoncommunitygame'
]);

function getClientId() {
  const value = (process.env.TWITCH_CLIENT_ID || '').trim();
  if (!value) throw new Error('TWITCH_CLIENT_ID environment variable is not set.');
  return value;
}

function hasScope(scopes, required) {
  return Array.isArray(scopes) && scopes.includes(required);
}

async function fetchChattersPage({ accessToken, broadcasterUserId, moderatorUserId, after = '' }) {
  const params = new URLSearchParams({
    broadcaster_id: broadcasterUserId,
    moderator_id: moderatorUserId,
    first: '1000'
  });
  if (after) params.set('after', after);

  const response = await fetch(`${TWITCH_CHATTERS_URL}?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': getClientId()
    }
  });

  let data = {};
  try {
    data = await response.json();
  } catch (_) {
    // Keep the parsed body empty and report the HTTP status below.
  }

  if (!response.ok) {
    const error = new Error(data?.message || `Twitch Get Chatters failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  return data;
}

function sampleUnique(items, count) {
  const pool = [...items];
  const wanted = Math.max(0, Math.min(pool.length, Number(count) || 0));
  const selected = [];
  for (let i = 0; i < wanted; i += 1) {
    const index = Math.floor(Math.random() * pool.length);
    selected.push(pool[index]);
    pool.splice(index, 1);
  }
  return selected;
}

async function getRandomChatters({ count = 1, excludeLogins = [] } = {}) {
  const [botAuth, broadcasterAuth] = await Promise.all([
    getStoredAuth(),
    getStoredBroadcasterAuth()
  ]);

  if (!botAuth?.twitchUserId || !broadcasterAuth?.twitchUserId) {
    throw new Error('Random chatter requires both bot and broadcaster Twitch authorization.');
  }

  if (!hasScope(botAuth.scopes, REQUIRED_CHATTERS_SCOPE)) {
    const error = new Error(`Random chatter requires bot OAuth scope ${REQUIRED_CHATTERS_SCOPE}. Re-authorize the bot from OAuth Management.`);
    error.reauthorizationRequired = true;
    throw error;
  }

  let accessToken = await getValidAccessToken({ allowRefresh: true });
  if (!accessToken) throw new Error('Random chatter requires a valid bot Twitch access token.');

  const excluded = new Set(DEFAULT_EXCLUDED_LOGINS);
  for (const value of excludeLogins) {
    const normalized = String(value || '').toLowerCase().trim();
    if (normalized) excluded.add(normalized);
  }
  if (botAuth.username) excluded.add(String(botAuth.username).toLowerCase());

  async function loadAllChatters({ retry401 = true } = {}) {
    const chatters = [];
    const seenIds = new Set();
    let after = '';

    for (let page = 0; page < MAX_CHATTER_PAGES; page += 1) {
      let data;
      try {
        data = await fetchChattersPage({
          accessToken,
          broadcasterUserId: String(broadcasterAuth.twitchUserId),
          moderatorUserId: String(botAuth.twitchUserId),
          after
        });
      } catch (err) {
        if (err.status === 401 && retry401) {
          const refreshed = await refreshStoredToken();
          accessToken = refreshed.accessToken;
          return loadAllChatters({ retry401: false });
        }
        throw err;
      }

      for (const chatter of Array.isArray(data?.data) ? data.data : []) {
        const id = String(chatter?.user_id || '');
        const login = String(chatter?.user_login || '').toLowerCase();
        if (!id || !login || seenIds.has(id) || excluded.has(login)) continue;
        seenIds.add(id);
        chatters.push({
          userId: id,
          login,
          displayName: String(chatter?.user_name || chatter?.user_login || login)
        });
      }

      after = String(data?.pagination?.cursor || '');
      if (!after) break;
    }

    return chatters;
  }

  const chatters = await loadAllChatters();
  if (!chatters.length) return [];
  return sampleUnique(chatters, count);
}

module.exports = {
  REQUIRED_CHATTERS_SCOPE,
  getRandomChatters,
  sampleUnique
};
