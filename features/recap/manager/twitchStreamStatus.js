'use strict';

const { fetchWithTimeout: fetch } = require('../../../services/httpClient');

function createTwitchStreamStatusClient({
  channelName,
  getTwitchAccessToken,
  refreshTwitchAccessToken,
  validateTwitchAccessToken,
  clientId = process.env.TWITCH_CLIENT_ID || ''
}) {
  let twitchClientId = String(clientId || '').trim();
  const gameArtCache = new Map();
  const GAME_ART_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

  function resolveBoxArtUrl(template, width = 285, height = 380) {
    return String(template || '').replace('{width}', String(width)).replace('{height}', String(height)).trim();
  }


  async function getAccessTokenOrThrow() {
    const token = await getTwitchAccessToken();
    if (!token) {
      const error = new Error('No Twitch OAuth token is stored in MongoDB. Authorize the bot from the WebUI.');
      error.reauthorizationRequired = true;
      throw error;
    }
    return token;
  }

  async function fetchGameImageUrl(gameId, accessToken, allowRefresh = true) {
    const normalizedGameId = String(gameId || '').trim();
    if (!normalizedGameId) return '';

    const cached = gameArtCache.get(normalizedGameId);
    if (cached && cached.expiresAt > Date.now()) return cached.url;

    const url = 'https://api.twitch.tv/helix/games?' + new URLSearchParams({ id: normalizedGameId }).toString();
    let response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': twitchClientId }
    });

    if (response.status === 401 && allowRefresh) {
      console.warn('[OAuth Bot] Recap game-art request returned 401. Refreshing bot OAuth token.');
      const refreshed = await refreshTwitchAccessToken();
      accessToken = refreshed?.accessToken || await getAccessTokenOrThrow();
      twitchClientId = (process.env.TWITCH_CLIENT_ID || twitchClientId).trim();
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': twitchClientId }
      });
    }

    if (!response.ok) throw new Error(`Twitch game-art request failed with HTTP ${response.status}.`);
    const data = await response.json();
    const game = Array.isArray(data?.data) ? data.data[0] : null;
    const resolved = resolveBoxArtUrl(game?.box_art_url || '');
    gameArtCache.set(normalizedGameId, { url: resolved, expiresAt: Date.now() + GAME_ART_CACHE_TTL_MS });
    return resolved;
  }

  async function fetchStreamStatus(allowRefresh = true) {
    if (!twitchClientId) throw new Error('TWITCH_CLIENT_ID environment variable is not set.');

    let accessToken = await getAccessTokenOrThrow();
    const url = 'https://api.twitch.tv/helix/streams?' + new URLSearchParams({ user_login: channelName }).toString();
    let response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': twitchClientId }
    });

    if (response.status === 401 && allowRefresh) {
      console.warn('[OAuth Bot] Recap stream-status request returned 401. Refreshing bot OAuth token.');
      const refreshed = await refreshTwitchAccessToken();
      accessToken = refreshed?.accessToken || await getAccessTokenOrThrow();
      twitchClientId = (process.env.TWITCH_CLIENT_ID || twitchClientId).trim();
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': twitchClientId }
      });
    }

    if (!response.ok) throw new Error(`Twitch stream-status request failed with HTTP ${response.status}.`);
    const data = await response.json();
    if (!Array.isArray(data?.data)) throw new Error('Twitch returned malformed stream-status data; not treating it as offline.');
    const stream = data.data.length > 0 ? data.data[0] : null;
    let gameImageUrl = '';
    if (stream?.game_id) {
      try {
        gameImageUrl = await fetchGameImageUrl(stream.game_id, accessToken);
      } catch (err) {
        console.warn('[Recap] Twitch game-art lookup failed:', err?.message || err);
      }
    }
    return {
      live: Boolean(stream),
      streamId: stream?.id || '',
      startedAt: stream?.started_at || null,
      title: stream?.title || '',
      category: stream?.game_name || '',
      gameId: stream?.game_id || '',
      gameImageUrl,
      viewerCount: Number(stream?.viewer_count || 0) || 0,
      thumbnailUrl: String(stream?.thumbnail_url || '').replace('{width}', '1280').replace('{height}', '720').trim()
    };
  }

  async function validateStoredToken() {
    if (typeof validateTwitchAccessToken !== 'function') return;
    const token = await getAccessTokenOrThrow();
    try {
      const validation = await validateTwitchAccessToken(token);
      if (validation?.client_id) twitchClientId = validation.client_id;
      console.log('[OAuth Bot] Recap stream-status bot token validated.');
    } catch (err) {
      if (err.status === 401 && typeof refreshTwitchAccessToken === 'function') {
        await refreshTwitchAccessToken();
        console.log('[OAuth Bot] Recap stream-status bot token refreshed after validation failure.');
        return;
      }
      throw err;
    }
  }

  return { getAccessTokenOrThrow, fetchStreamStatus, validateStoredToken };
}

module.exports = { createTwitchStreamStatusClient };
