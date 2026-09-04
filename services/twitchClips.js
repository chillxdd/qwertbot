const { getValidAccessToken, refreshStoredToken } = require('./twitchAuth');

const REQUIRED_CLIPS_SCOPE = 'clips:edit';
const TWITCH_API_BASE = 'https://api.twitch.tv/helix';
const REQUEST_TIMEOUT_MS = 8000;
const CLIP_POLL_TIMEOUT_MS = 60000;
const CLIP_POLL_INTERVAL_MS = 2000;
const BROADCASTER_CACHE_TTL_MS = 60 * 60 * 1000;
const broadcasterCache = new Map();

function getClientId() {
  const value = String(process.env.TWITCH_CLIENT_ID || '').trim();
  if (!value) throw new Error('TWITCH_CLIENT_ID environment variable is not set.');
  return value;
}

function normalizeChannelName(value) {
  return String(value || '').replace(/^#/, '').trim().toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTwitchJson(url, accessToken, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': getClientId(),
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    let body = {};
    try { body = await response.json(); } catch (_) {}
    if (!response.ok) {
      const error = new Error(body?.message || `Twitch API request failed with HTTP ${response.status}.`);
      error.status = response.status;
      error.twitchBody = body;
      throw error;
    }
    return body;
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeoutError = new Error('Twitch API request timed out.');
      timeoutError.code = 'TWITCH_REQUEST_TIMEOUT';
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function withBotAccessToken(requestFn) {
  let token = await getValidAccessToken({ allowRefresh: true });
  if (!token) throw new Error('A valid bot Twitch OAuth token is required.');
  try {
    return await requestFn(token);
  } catch (err) {
    if (err?.status !== 401) throw err;
    const refreshed = await refreshStoredToken();
    token = refreshed?.accessToken || '';
    if (!token) throw err;
    return requestFn(token);
  }
}

async function getBroadcasterIdentity(channelName, { force = false } = {}) {
  const login = normalizeChannelName(channelName);
  if (!login) throw new Error('Twitch channel name is not configured.');
  const cached = broadcasterCache.get(login);
  if (!force && cached && Date.now() - cached.at < BROADCASTER_CACHE_TTL_MS) return cached.value;

  const value = await withBotAccessToken(async (token) => {
    const params = new URLSearchParams({ login });
    const body = await fetchTwitchJson(`${TWITCH_API_BASE}/users?${params.toString()}`, token);
    const user = Array.isArray(body?.data) ? body.data[0] || null : null;
    if (!user?.id) throw new Error(`Twitch channel @${login} was not found.`);
    return {
      id: String(user.id),
      login: String(user.login || login),
      displayName: String(user.display_name || user.login || login)
    };
  });
  broadcasterCache.set(login, { at: Date.now(), value });
  return value;
}

async function getLiveStreamInfo(channelName) {
  const broadcaster = await getBroadcasterIdentity(channelName);
  return withBotAccessToken(async (token) => {
    const params = new URLSearchParams({ user_id: broadcaster.id });
    const body = await fetchTwitchJson(`${TWITCH_API_BASE}/streams?${params.toString()}`, token);
    const stream = Array.isArray(body?.data) ? body.data[0] || null : null;
    return {
      broadcaster,
      live: Boolean(stream),
      streamId: String(stream?.id || ''),
      gameId: String(stream?.game_id || ''),
      gameName: String(stream?.game_name || '').trim(),
      title: String(stream?.title || '').trim(),
      startedAt: stream?.started_at || null
    };
  });
}

function parseTwitchClipUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || /\s/.test(raw)) return null;
  let url;
  try { url = new URL(raw); } catch (_) { return null; }
  if (url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();
  let clipId = '';
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'clips.twitch.tv') {
    if (parts.length === 1 && parts[0].toLowerCase() !== 'embed') clipId = parts[0];
  } else if (host === 'twitch.tv' || host === 'www.twitch.tv' || host === 'm.twitch.tv') {
    const clipIndex = parts.findIndex((part) => part.toLowerCase() === 'clip');
    if (clipIndex >= 0 && parts[clipIndex + 1]) clipId = parts[clipIndex + 1];
  }

  if (!clipId || !/^[A-Za-z0-9_-]+$/.test(clipId)) return null;
  return { clipId, url: `https://clips.twitch.tv/${clipId}` };
}

async function getClipById(clipId) {
  const id = String(clipId || '').trim();
  if (!id) return null;
  return withBotAccessToken(async (token) => {
    const params = new URLSearchParams({ id });
    const body = await fetchTwitchJson(`${TWITCH_API_BASE}/clips?${params.toString()}`, token);
    return Array.isArray(body?.data) ? body.data[0] || null : null;
  });
}

async function getGameById(gameId) {
  const id = String(gameId || '').trim();
  if (!id) return null;
  return withBotAccessToken(async (token) => {
    const params = new URLSearchParams({ id });
    const body = await fetchTwitchJson(`${TWITCH_API_BASE}/games?${params.toString()}`, token);
    const game = Array.isArray(body?.data) ? body.data[0] || null : null;
    if (!game?.id) return null;
    return {
      id: String(game.id),
      name: String(game.name || '').trim()
    };
  });
}

async function validateClipForChannel(channelName, clipUrl) {
  const parsed = parseTwitchClipUrl(clipUrl);
  if (!parsed) throw new Error('Only Twitch clip URLs are accepted.');
  const broadcaster = await getBroadcasterIdentity(channelName);
  const clip = await getClipById(parsed.clipId);
  if (!clip?.id) throw new Error('Twitch could not find that clip.');
  if (String(clip.broadcaster_id || '') !== broadcaster.id) {
    throw new Error('That Twitch clip belongs to a different broadcaster.');
  }

  const gameId = String(clip.game_id || '').trim();
  let gameName = String(clip.game_name || '').trim();
  if (!gameName && gameId) {
    const game = await getGameById(gameId);
    gameName = String(game?.name || '').trim();
  }

  return {
    id: String(clip.id),
    url: String(clip.url || parsed.url),
    title: String(clip.title || ''),
    duration: Number.isFinite(Number(clip.duration)) ? Number(clip.duration) : null,
    creatorName: String(clip.creator_name || ''),
    gameId,
    gameName
  };
}

async function createClip(channelName, { title = '', duration = 30 } = {}) {
  const broadcaster = await getBroadcasterIdentity(channelName);
  const safeDuration = Number(duration);
  if (!Number.isFinite(safeDuration) || safeDuration < 5 || safeDuration > 60) {
    throw new Error('Clip duration must be between 5 and 60 seconds.');
  }
  const safeTitle = String(title || '').trim();

  const created = await withBotAccessToken(async (token) => {
    const params = new URLSearchParams({
      broadcaster_id: broadcaster.id,
      duration: String(safeDuration)
    });
    if (safeTitle) params.set('title', safeTitle);
    const body = await fetchTwitchJson(`${TWITCH_API_BASE}/clips?${params.toString()}`, token, { method: 'POST' });
    const item = Array.isArray(body?.data) ? body.data[0] || null : null;
    if (!item?.id) throw new Error('Twitch did not return a clip ID.');
    return { id: String(item.id), editUrl: String(item.edit_url || '') };
  });

  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < CLIP_POLL_TIMEOUT_MS) {
    await sleep(CLIP_POLL_INTERVAL_MS);
    try {
      const clip = await getClipById(created.id);
      if (clip?.id) {
        return {
          id: String(clip.id),
          url: String(clip.url || `https://clips.twitch.tv/${created.id}`),
          title: String(clip.title || safeTitle),
          duration: Number.isFinite(Number(clip.duration)) ? Number(clip.duration) : safeDuration,
          creatorName: String(clip.creator_name || ''),
          editUrl: created.editUrl
        };
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) console.warn('[Clips] Last Get Clips poll failed:', lastError?.message || lastError);
  throw new Error('Twitch did not finish creating the clip within 60 seconds.');
}

module.exports = {
  REQUIRED_CLIPS_SCOPE,
  parseTwitchClipUrl,
  getBroadcasterIdentity,
  getLiveStreamInfo,
  getClipById,
  getGameById,
  validateClipForChannel,
  createClip
};
