const { getStoredAuth, getValidAccessToken } = require('./twitchAuth');
const { getStoredBroadcasterAuth } = require('./twitchBroadcasterAuth');

const TWITCH_ANNOUNCEMENTS_URL = 'https://api.twitch.tv/helix/chat/announcements';
const REQUIRED_ANNOUNCEMENT_SCOPE = 'moderator:manage:announcements';
const ANNOUNCEMENT_COLORS = new Set(['primary', 'blue', 'green', 'orange', 'purple']);

function getClientId() {
  const value = String(process.env.TWITCH_CLIENT_ID || '').trim();
  if (!value) throw new Error('TWITCH_CLIENT_ID environment variable is not set.');
  return value;
}

function normalizeAnnouncementColor(value) {
  const color = String(value || '').trim().toLowerCase();
  return ANNOUNCEMENT_COLORS.has(color) ? color : 'primary';
}

async function sendChatAnnouncement(message, { color = 'primary' } = {}) {
  const text = String(message || '').trim();
  if (!text) throw new Error('Cannot send an empty Twitch announcement.');
  if (text.length > 500) throw new Error(`Twitch announcement is ${text.length} characters; maximum is 500.`);

  const [botAuth, broadcasterAuth, token] = await Promise.all([
    getStoredAuth(),
    getStoredBroadcasterAuth(),
    getValidAccessToken({ allowRefresh: true })
  ]);

  const moderatorId = String(botAuth?.twitchUserId || '').trim();
  const broadcasterId = String(broadcasterAuth?.twitchUserId || '').trim();
  if (!moderatorId || !broadcasterId || !token) {
    throw new Error('Bot/broadcaster OAuth is not ready for Twitch announcements.');
  }
  if (!Array.isArray(botAuth?.scopes) || !botAuth.scopes.includes(REQUIRED_ANNOUNCEMENT_SCOPE)) {
    const error = new Error(`Twitch announcements require bot OAuth scope ${REQUIRED_ANNOUNCEMENT_SCOPE}.`);
    error.reauthorizationRequired = true;
    throw error;
  }

  const url = new URL(TWITCH_ANNOUNCEMENTS_URL);
  url.searchParams.set('broadcaster_id', broadcasterId);
  url.searchParams.set('moderator_id', moderatorId);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': getClientId(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: text,
      color: normalizeAnnouncementColor(color)
    })
  });

  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.message || ''; } catch (_) {}
    throw new Error(`Twitch announcement failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }

  return { method: 'announcement_api', color: normalizeAnnouncementColor(color) };
}

module.exports = {
  REQUIRED_ANNOUNCEMENT_SCOPE,
  normalizeAnnouncementColor,
  sendChatAnnouncement
};
