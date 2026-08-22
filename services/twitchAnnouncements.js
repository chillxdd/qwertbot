const { getStoredAuth } = require('./twitchAuth');
const { getStoredBroadcasterAuth } = require('./twitchBroadcasterAuth');
const { getAppAccessToken } = require('./twitchChat');

const TWITCH_ANNOUNCEMENTS_URL = 'https://api.twitch.tv/helix/chat/announcements';
const REQUIRED_ANNOUNCEMENT_SCOPE = 'moderator:manage:announcements';
const REQUIRED_BOT_ANNOUNCEMENT_SCOPES = [REQUIRED_ANNOUNCEMENT_SCOPE, 'user:bot'];
const REQUIRED_BROADCASTER_ANNOUNCEMENT_SCOPES = ['channel:bot'];
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

  const [botAuth, broadcasterAuth] = await Promise.all([
    getStoredAuth(),
    getStoredBroadcasterAuth()
  ]);

  const moderatorId = String(botAuth?.twitchUserId || '').trim();
  const broadcasterId = String(broadcasterAuth?.twitchUserId || '').trim();
  if (!moderatorId || !broadcasterId) {
    throw new Error('Bot/broadcaster OAuth is not ready for Twitch announcements.');
  }

  const botScopes = Array.isArray(botAuth?.scopes) ? botAuth.scopes : [];
  const broadcasterScopes = Array.isArray(broadcasterAuth?.scopes) ? broadcasterAuth.scopes : [];
  const botMissingScopes = REQUIRED_BOT_ANNOUNCEMENT_SCOPES.filter((scope) => !botScopes.includes(scope));
  const broadcasterMissingScopes = REQUIRED_BROADCASTER_ANNOUNCEMENT_SCOPES.filter((scope) => !broadcasterScopes.includes(scope));

  if (botMissingScopes.length || broadcasterMissingScopes.length) {
    const parts = [];
    if (botMissingScopes.length) parts.push(`bot missing ${botMissingScopes.join(', ')}`);
    if (broadcasterMissingScopes.length) parts.push(`broadcaster missing ${broadcasterMissingScopes.join(', ')}`);
    const error = new Error(`Twitch announcement App Access Token mode is not ready: ${parts.join('; ')}.`);
    error.reauthorizationRequired = true;
    throw error;
  }

  const token = await getAppAccessToken();

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
      color: normalizeAnnouncementColor(color),
      for_source_only: true
    })
  });

  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.message || ''; } catch (_) {}
    throw new Error(`Twitch announcement failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }

  return { method: 'announcement_app_api', color: normalizeAnnouncementColor(color) };
}

module.exports = {
  REQUIRED_ANNOUNCEMENT_SCOPE,
  REQUIRED_BOT_ANNOUNCEMENT_SCOPES,
  REQUIRED_BROADCASTER_ANNOUNCEMENT_SCOPES,
  normalizeAnnouncementColor,
  sendChatAnnouncement
};
