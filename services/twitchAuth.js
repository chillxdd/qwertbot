const TwitchAuth = require('../models/TwitchAuth');

const TWITCH_VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

function getClientId() {
  const value = (process.env.TWITCH_CLIENT_ID || '').trim();
  if (!value) throw new Error('TWITCH_CLIENT_ID environment variable is not set.');
  return value;
}

function getClientSecret() {
  const value = (process.env.TWITCH_CLIENT_SECRET || '').trim();
  if (!value) throw new Error('TWITCH_CLIENT_SECRET environment variable is not set.');
  return value;
}

async function getStoredAuth() {
  return TwitchAuth.findOne({ provider: 'twitch' }).lean();
}

async function saveAuth({
  accessToken,
  refreshToken,
  expiresIn = null,
  scopes = [],
  twitchUserId = '',
  username = ''
}) {
  if (!accessToken || !refreshToken) {
    throw new Error('Both accessToken and refreshToken are required.');
  }

  const expiresAt = Number.isFinite(Number(expiresIn))
    ? new Date(Date.now() + Number(expiresIn) * 1000)
    : null;

  const doc = await TwitchAuth.findOneAndUpdate(
    { provider: 'twitch' },
    {
      $set: {
        twitchUserId: twitchUserId || '',
        username: (username || '').toLowerCase(),
        accessToken,
        refreshToken,
        scopes: Array.isArray(scopes) ? scopes : [],
        expiresAt
      },
      $setOnInsert: {
        provider: 'twitch'
      }
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true
    }
  );

  return doc.toObject();
}

async function validateAccessToken(accessToken) {
  if (!accessToken) {
    const error = new Error('No Twitch access token was provided.');
    error.status = 401;
    throw error;
  }

  const response = await fetch(TWITCH_VALIDATE_URL, {
    headers: {
      Authorization: `OAuth ${accessToken}`
    }
  });

  let data = {};

  try {
    data = await response.json();
  } catch (err) {
    // Leave data empty and use the HTTP status below.
  }

  if (!response.ok) {
    const error = new Error(data?.message || `Twitch token validation failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  return data;
}

async function refreshStoredToken() {
  const auth = await getStoredAuth();

  if (!auth?.refreshToken) {
    const error = new Error('No Twitch refresh token is stored in MongoDB. Re-authorize the bot from the WebUI.');
    error.reauthorizationRequired = true;
    throw error;
  }

  const body = new URLSearchParams({
    client_id: getClientId(),
    client_secret: getClientSecret(),
    grant_type: 'refresh_token',
    refresh_token: auth.refreshToken
  });

  const response = await fetch(TWITCH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  let data = {};

  try {
    data = await response.json();
  } catch (err) {
    // Leave data empty and use the HTTP status below.
  }

  if (!response.ok || !data.access_token) {
    const error = new Error(data?.message || `Twitch token refresh failed with HTTP ${response.status}.`);
    error.status = response.status;
    if (response.status === 400 || response.status === 401) {
      error.reauthorizationRequired = true;
    }
    throw error;
  }

  const newRefreshToken = data.refresh_token || auth.refreshToken;

  const validation = await validateAccessToken(data.access_token);

  const saved = await saveAuth({
    accessToken: data.access_token,
    refreshToken: newRefreshToken,
    expiresIn: data.expires_in,
    scopes: validation.scopes || data.scope || auth.scopes || [],
    twitchUserId: validation.user_id || auth.twitchUserId || '',
    username: validation.login || auth.username || ''
  });

  console.log('[OAuth] Twitch access token refreshed and saved to MongoDB.');
  return saved;
}

async function getAccessToken() {
  const auth = await getStoredAuth();
  return auth?.accessToken || null;
}

async function getValidAccessToken({ allowRefresh = true } = {}) {
  const auth = await getStoredAuth();

  if (!auth?.accessToken) {
    return null;
  }

  try {
    await validateAccessToken(auth.accessToken);
    return auth.accessToken;
  } catch (err) {
    if (allowRefresh && err.status === 401 && auth.refreshToken) {
      const refreshed = await refreshStoredToken();
      return refreshed.accessToken;
    }
    throw err;
  }
}

async function exchangeAuthorizationCode({ code, redirectUri }) {
  const body = new URLSearchParams({
    client_id: getClientId(),
    client_secret: getClientSecret(),
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  });

  const response = await fetch(TWITCH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  let data = {};

  try {
    data = await response.json();
  } catch (err) {
    // Leave data empty and use the HTTP status below.
  }

  if (!response.ok || !data.access_token || !data.refresh_token) {
    const error = new Error(data?.message || `Twitch authorization-code exchange failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  return data;
}

async function storeAuthorizationCodeResult(tokenData) {
  const validation = await validateAccessToken(tokenData.access_token);

  return saveAuth({
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresIn: tokenData.expires_in,
    scopes: validation.scopes || tokenData.scope || [],
    twitchUserId: validation.user_id || '',
    username: validation.login || ''
  });
}

async function getAuthStatus() {
  const auth = await getStoredAuth();

  if (!auth) {
    return {
      stored: false,
      username: null,
      twitchUserId: null,
      scopes: [],
      updatedAt: null
    };
  }

  return {
    stored: Boolean(auth.accessToken && auth.refreshToken),
    username: auth.username || null,
    twitchUserId: auth.twitchUserId || null,
    scopes: auth.scopes || [],
    updatedAt: auth.updatedAt || null
  };
}

module.exports = {
  exchangeAuthorizationCode,
  getAccessToken,
  getAuthStatus,
  getStoredAuth,
  getValidAccessToken,
  refreshStoredToken,
  saveAuth,
  storeAuthorizationCodeResult,
  validateAccessToken
};
