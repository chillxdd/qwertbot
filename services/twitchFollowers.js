const {
  getStoredBroadcasterAuth,
  getValidBroadcasterAccessToken,
  refreshBroadcasterToken
} = require('./twitchBroadcasterAuth');

const REQUIRED_FOLLOWERS_SCOPE = 'moderator:read:followers';
const TWITCH_USERS_URL = 'https://api.twitch.tv/helix/users';
const TWITCH_FOLLOWERS_URL = 'https://api.twitch.tv/helix/channels/followers';
const REQUEST_TIMEOUT_MS = 6000;

function getClientId() {
  const value = (process.env.TWITCH_CLIENT_ID || '').trim();
  if (!value) throw new Error('TWITCH_CLIENT_ID environment variable is not set.');
  return value;
}

function hasScope(scopes, required) {
  return Array.isArray(scopes) && scopes.includes(required);
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
    try {
      data = await response.json();
    } catch (_) {
      // Use HTTP status below if Twitch did not return JSON.
    }

    if (!response.ok) {
      const error = new Error(data?.message || `Twitch follower lookup failed with HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }

    return data;
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeoutError = new Error('Twitch follower lookup timed out.');
      timeoutError.code = 'TWITCH_FOLLOW_LOOKUP_TIMEOUT';
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function getUserByLogin(login, accessToken) {
  const params = new URLSearchParams({ login });
  const data = await fetchJson(`${TWITCH_USERS_URL}?${params.toString()}`, accessToken);
  return Array.isArray(data?.data) ? data.data[0] || null : null;
}

async function getFollowerRelationship({ broadcasterUserId, viewerUserId, accessToken }) {
  const params = new URLSearchParams({
    broadcaster_id: String(broadcasterUserId),
    user_id: String(viewerUserId),
    first: '1'
  });
  const data = await fetchJson(`${TWITCH_FOLLOWERS_URL}?${params.toString()}`, accessToken);
  return Array.isArray(data?.data) ? data.data[0] || null : null;
}

async function getFollowInfo({ viewerLogin }) {
  const login = cleanLogin(viewerLogin);
  if (!login) throw new Error('Follower lookup requires a Twitch username.');

  const broadcasterAuth = await getStoredBroadcasterAuth();
  if (!broadcasterAuth?.twitchUserId) {
    throw new Error('Follower lookup requires stored broadcaster Twitch authorization.');
  }
  if (!hasScope(broadcasterAuth.scopes, REQUIRED_FOLLOWERS_SCOPE)) {
    const error = new Error(`Follower lookup requires broadcaster OAuth scope ${REQUIRED_FOLLOWERS_SCOPE}.`);
    error.reauthorizationRequired = true;
    throw error;
  }

  let accessToken = await getValidBroadcasterAccessToken({ allowRefresh: true });
  if (!accessToken) throw new Error('Follower lookup requires a valid broadcaster Twitch access token.');

  async function lookup({ retry401 = true } = {}) {
    try {
      const viewer = await getUserByLogin(login, accessToken);
      if (!viewer?.id) {
        return {
          foundUser: false,
          isFollowing: false,
          viewerLogin: login,
          viewerDisplayName: viewerLogin,
          followedAt: null
        };
      }

      const relationship = await getFollowerRelationship({
        broadcasterUserId: broadcasterAuth.twitchUserId,
        viewerUserId: viewer.id,
        accessToken
      });

      return {
        foundUser: true,
        isFollowing: Boolean(relationship?.followed_at),
        viewerLogin: String(viewer.login || login),
        viewerDisplayName: String(viewer.display_name || viewer.login || login),
        followedAt: relationship?.followed_at ? new Date(relationship.followed_at) : null
      };
    } catch (err) {
      if (err?.status === 401 && retry401) {
        const refreshed = await refreshBroadcasterToken();
        accessToken = refreshed.accessToken;
        return lookup({ retry401: false });
      }
      throw err;
    }
  }

  return lookup();
}

function plural(value, unit) {
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

function daysInUtcMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function addUtcYears(date, count) {
  const copy = new Date(date.getTime());
  const month = copy.getUTCMonth();
  const day = copy.getUTCDate();
  const targetYear = copy.getUTCFullYear() + count;
  copy.setUTCDate(1);
  copy.setUTCFullYear(targetYear);
  copy.setUTCMonth(month);
  copy.setUTCDate(Math.min(day, daysInUtcMonth(targetYear, month)));
  return copy;
}

function addUtcMonths(date, count) {
  const copy = new Date(date.getTime());
  const day = copy.getUTCDate();
  const absoluteMonth = copy.getUTCFullYear() * 12 + copy.getUTCMonth() + count;
  const targetYear = Math.floor(absoluteMonth / 12);
  const targetMonth = ((absoluteMonth % 12) + 12) % 12;
  copy.setUTCDate(1);
  copy.setUTCFullYear(targetYear);
  copy.setUTCMonth(targetMonth);
  copy.setUTCDate(Math.min(day, daysInUtcMonth(targetYear, targetMonth)));
  return copy;
}

function formatFollowAge(followedAt, now = new Date()) {
  const start = followedAt instanceof Date ? new Date(followedAt.getTime()) : new Date(followedAt);
  const end = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) return '';

  let cursor = new Date(start.getTime());
  let years = end.getUTCFullYear() - cursor.getUTCFullYear();
  if (years > 0 && addUtcYears(cursor, years) > end) years -= 1;
  if (years > 0) cursor = addUtcYears(cursor, years);

  let months = (end.getUTCFullYear() - cursor.getUTCFullYear()) * 12 + (end.getUTCMonth() - cursor.getUTCMonth());
  if (months > 0 && addUtcMonths(cursor, months) > end) months -= 1;
  if (months > 0) cursor = addUtcMonths(cursor, months);

  let remainingSeconds = Math.max(0, Math.floor((end.getTime() - cursor.getTime()) / 1000));
  const days = Math.floor(remainingSeconds / 86400);
  remainingSeconds -= days * 86400;
  const hours = Math.floor(remainingSeconds / 3600);
  remainingSeconds -= hours * 3600;
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds - minutes * 60;

  const parts = [];
  if (years) parts.push(plural(years, 'year'));
  if (months) parts.push(plural(months, 'month'));
  if (days) parts.push(plural(days, 'day'));
  if (hours) parts.push(plural(hours, 'hour'));
  if (minutes) parts.push(plural(minutes, 'minute'));
  if (seconds || !parts.length) parts.push(plural(seconds, 'second'));
  return parts.join(', ');
}

function formatFollowDate(followedAt) {
  const date = followedAt instanceof Date ? followedAt : new Date(followedAt);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(date);
}

module.exports = {
  REQUIRED_FOLLOWERS_SCOPE,
  REQUEST_TIMEOUT_MS,
  cleanLogin,
  formatFollowAge,
  formatFollowDate,
  getFollowInfo
};
