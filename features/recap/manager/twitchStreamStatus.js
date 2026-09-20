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

  async function getAccessTokenOrThrow() {
    const token = await getTwitchAccessToken();
    if (!token) {
      const error = new Error('No Twitch OAuth token is stored in MongoDB. Authorize the bot from the WebUI.');
      error.reauthorizationRequired = true;
      throw error;
    }
    return token;
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
    return {
      live: Boolean(stream),
      streamId: stream?.id || '',
      startedAt: stream?.started_at || null,
      title: stream?.title || '',
      category: stream?.game_name || '',
      gameId: stream?.game_id || '',
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
