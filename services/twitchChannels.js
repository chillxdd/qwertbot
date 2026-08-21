const { getValidAccessToken, refreshStoredToken } = require('./twitchAuth');

const TWITCH_USERS_URL = 'https://api.twitch.tv/helix/users';
const TWITCH_CHANNELS_URL = 'https://api.twitch.tv/helix/channels';
const REQUEST_TIMEOUT_MS = 6000;
const GAME_CACHE_TTL_MS = 60 * 1000;
const gameCache = new Map();

function getClientId() {
  const value = String(process.env.TWITCH_CLIENT_ID || '').trim();
  if (!value) throw new Error('TWITCH_CLIENT_ID environment variable is not set.');
  return value;
}

function cleanLogin(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

async function fetchJson(url, accessToken) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': getClientId()
      },
      signal: controller.signal
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) {
      const error = new Error(data?.message || `Twitch channel lookup failed with HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeoutError = new Error('Twitch channel lookup timed out.');
      timeoutError.code = 'TWITCH_CHANNEL_LOOKUP_TIMEOUT';
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function lookupGame(login, accessToken) {
  const userParams = new URLSearchParams({ login });
  const userData = await fetchJson(`${TWITCH_USERS_URL}?${userParams.toString()}`, accessToken);
  const user = Array.isArray(userData?.data) ? userData.data[0] || null : null;
  if (!user?.id) return { foundUser: false, login, displayName: login, gameName: '' };

  const channelParams = new URLSearchParams({ broadcaster_id: String(user.id) });
  const channelData = await fetchJson(`${TWITCH_CHANNELS_URL}?${channelParams.toString()}`, accessToken);
  const channel = Array.isArray(channelData?.data) ? channelData.data[0] || null : null;
  return {
    foundUser: true,
    login: String(user.login || login),
    displayName: String(user.display_name || user.login || login),
    gameName: String(channel?.game_name || '').trim()
  };
}

async function getGameInfo({ viewerLogin }) {
  const login = cleanLogin(viewerLogin);
  if (!login) throw new Error('Game lookup requires a Twitch username.');

  const cached = gameCache.get(login);
  if (cached && Date.now() - cached.at < GAME_CACHE_TTL_MS) return cached.value;

  let accessToken = await getValidAccessToken({ allowRefresh: true });
  if (!accessToken) throw new Error('Game lookup requires a valid bot Twitch access token.');

  async function run({ retry401 = true } = {}) {
    try {
      const value = await lookupGame(login, accessToken);
      gameCache.set(login, { at: Date.now(), value });
      return value;
    } catch (err) {
      if (err?.status === 401 && retry401) {
        const refreshed = await refreshStoredToken();
        accessToken = refreshed.accessToken;
        return run({ retry401: false });
      }
      throw err;
    }
  }

  return run();
}

module.exports = { getGameInfo };
