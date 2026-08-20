const TwitchBroadcasterAuth = require('../models/TwitchBroadcasterAuth');

const TWITCH_VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

let broadcasterRefreshInFlight = null;

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

async function validateBroadcasterAccessToken(accessToken) {
  if (!accessToken) {
    const error = new Error('No broadcaster Twitch access token was provided.');
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
    // Use HTTP status below.
  }

  if (!response.ok) {
    const error = new Error(data?.message || `Twitch broadcaster token validation failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  return data;
}

async function getStoredBroadcasterAuth() {
  return TwitchBroadcasterAuth.findOne({ provider: 'twitch-broadcaster' }).lean();
}

async function saveBroadcasterAuth({
  accessToken,
  refreshToken,
  expiresIn = null,
  scopes = [],
  twitchUserId = '',
  username = ''
}) {
  if (!accessToken || !refreshToken) {
    throw new Error('Both broadcaster accessToken and refreshToken are required.');
  }

  const expiresAt = Number.isFinite(Number(expiresIn))
    ? new Date(Date.now() + Number(expiresIn) * 1000)
    : null;

  const doc = await TwitchBroadcasterAuth.findOneAndUpdate(
    { provider: 'twitch-broadcaster' },
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
        provider: 'twitch-broadcaster'
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

async function exchangeBroadcasterAuthorizationCode({ code, redirectUri }) {
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
    // Use HTTP status below.
  }

  if (!response.ok || !data.access_token || !data.refresh_token) {
    const error = new Error(data?.message || `Twitch broadcaster authorization-code exchange failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  return data;
}

async function storeBroadcasterAuthorizationCodeResult(tokenData) {
  const validation = await validateBroadcasterAccessToken(tokenData.access_token);

  return saveBroadcasterAuth({
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresIn: tokenData.expires_in,
    scopes: validation.scopes || tokenData.scope || [],
    twitchUserId: validation.user_id || '',
    username: validation.login || ''
  });
}

async function refreshBroadcasterToken() {
  // Broadcaster refresh tokens may rotate too. Serialize refresh attempts so the
  // newest token pair always wins in MongoDB.
  if (broadcasterRefreshInFlight) return broadcasterRefreshInFlight;

  broadcasterRefreshInFlight = (async () => {
    const auth = await getStoredBroadcasterAuth();

    if (!auth?.refreshToken) {
      const error = new Error('No broadcaster refresh token is stored in MongoDB. Qwert must authorize the app again.');
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
      // Use HTTP status below.
    }

    if (!response.ok || !data.access_token) {
      const error = new Error(data?.message || `Twitch broadcaster token refresh failed with HTTP ${response.status}.`);
      error.status = response.status;
      if (response.status === 400 || response.status === 401) {
        error.reauthorizationRequired = true;
      }
      throw error;
    }

    const newRefreshToken = data.refresh_token || auth.refreshToken;
    const validation = await validateBroadcasterAccessToken(data.access_token);

    const saved = await saveBroadcasterAuth({
      accessToken: data.access_token,
      refreshToken: newRefreshToken,
      expiresIn: data.expires_in,
      scopes: validation.scopes || data.scope || auth.scopes || [],
      twitchUserId: validation.user_id || auth.twitchUserId || '',
      username: validation.login || auth.username || ''
    });

    console.log('[OAuth Broadcaster] Twitch token refreshed and saved to MongoDB.');
    return saved;
  })();

  try {
    return await broadcasterRefreshInFlight;
  } finally {
    broadcasterRefreshInFlight = null;
  }
}

async function getValidBroadcasterAccessToken({ allowRefresh = true } = {}) {
  const auth = await getStoredBroadcasterAuth();

  if (!auth?.accessToken) return null;

  try {
    await validateBroadcasterAccessToken(auth.accessToken);
    return auth.accessToken;
  } catch (err) {
    if (allowRefresh && err.status === 401 && auth.refreshToken) {
      const refreshed = await refreshBroadcasterToken();
      return refreshed.accessToken;
    }
    throw err;
  }
}

async function getBroadcasterAuthStatus() {
  const auth = await getStoredBroadcasterAuth();

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
  exchangeBroadcasterAuthorizationCode,
  getBroadcasterAuthStatus,
  getValidBroadcasterAccessToken,
  getStoredBroadcasterAuth,
  refreshBroadcasterToken,
  saveBroadcasterAuth,
  storeBroadcasterAuthorizationCodeResult,
  validateBroadcasterAccessToken
};
