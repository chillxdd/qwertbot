'use strict';

const { randomBytes, timingSafeEqual } = require('node:crypto');
const YouTubeAuth = require('../models/YouTubeAuth');
const secretBox = require('./secretBox');
const {
  YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET,
  YOUTUBE_REDIRECT_URI,
  YOUTUBE_SCOPE,
  YOUTUBE_LIST_COST
} = require('../config/youtube');

const PROVIDER = 'youtube-bot';
const ACCESS_CONTEXT = 'youtube:bot:access';
const REFRESH_CONTEXT = 'youtube:bot:refresh';
const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_MARGIN_MS = 90 * 1000;

function createYouTubeAuthManager({ quotaManager }) {
  const pendingStates = new Map();
  let refreshPromise = null;

  function configured() {
    return Boolean(YOUTUBE_CLIENT_ID && YOUTUBE_CLIENT_SECRET && YOUTUBE_REDIRECT_URI && secretBox.status().ready);
  }

  function pruneStates() {
    const now = Date.now();
    for (const [state, expiresAt] of pendingStates.entries()) if (expiresAt <= now) pendingStates.delete(state);
  }

  function createAuthorizationUrl() {
    if (!configured()) throw new Error('YouTube OAuth is not fully configured. Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and CONFIG_ENCRYPTION_KEY.');
    pruneStates();
    const state = randomBytes(32).toString('base64url');
    pendingStates.set(state, Date.now() + STATE_TTL_MS);
    const params = new URLSearchParams({
      client_id: YOUTUBE_CLIENT_ID,
      redirect_uri: YOUTUBE_REDIRECT_URI,
      response_type: 'code',
      scope: YOUTUBE_SCOPE,
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
      state
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  function consumeState(candidate) {
    pruneStates();
    const state = String(candidate || '');
    const expiresAt = pendingStates.get(state);
    if (!expiresAt || expiresAt <= Date.now()) return false;
    let matched = false;
    try {
      const expected = Buffer.from(state);
      const actual = Buffer.from(String(candidate || ''));
      matched = expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch (_) { matched = false; }
    if (matched) pendingStates.delete(state);
    return matched;
  }

  async function postToken(params) {
    await quotaManager?.noteAuthCall?.();
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      throw new Error(data.error_description || data.error || `Google OAuth token request failed (${response.status}).`);
    }
    return data;
  }

  async function identifyChannel(accessToken) {
    await quotaManager.reserveMainUnits(YOUTUBE_LIST_COST, { authCalls: 1 });
    const response = await fetch('https://www.googleapis.com/youtube/v3/channels?part=id%2Csnippet&mine=true&maxResults=5', {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `Could not identify the authorized YouTube channel (${response.status}).`);
    const channels = Array.isArray(data.items) ? data.items : [];
    if (!channels.length) throw new Error('The authorized Google account does not expose a YouTube channel. Create/select the SqwertArmyBot YouTube channel and try again.');
    if (channels.length > 1) {
      console.warn(`[YouTube OAuth] Google returned ${channels.length} owned channels; using the first channel returned (${channels[0]?.snippet?.title || channels[0]?.id}).`);
    }
    return {
      channelId: String(channels[0]?.id || ''),
      displayName: String(channels[0]?.snippet?.title || '')
    };
  }

  async function exchangeCode({ code, state }) {
    if (!consumeState(state)) throw new Error('YouTube OAuth state is invalid or expired. Start the connection again from the dashboard.');
    const token = await postToken({
      code: String(code || ''),
      client_id: YOUTUBE_CLIENT_ID,
      client_secret: YOUTUBE_CLIENT_SECRET,
      redirect_uri: YOUTUBE_REDIRECT_URI,
      grant_type: 'authorization_code'
    });
    const identity = await identifyChannel(token.access_token);
    if (!identity.channelId) throw new Error('YouTube did not return a valid bot channel identity.');

    const existing = await YouTubeAuth.findOne({ provider: PROVIDER });
    if (existing?.channelId && existing.channelId !== identity.channelId) {
      throw new Error(`This QwertBot installation is locked to YouTube channel ${existing.displayName || existing.channelId}. Disconnect it first if you intentionally want to replace the bot identity.`);
    }

    let refreshToken = String(token.refresh_token || '');
    if (!refreshToken && existing?.refreshTokenBox) refreshToken = secretBox.decrypt(existing.refreshTokenBox, REFRESH_CONTEXT);
    if (!refreshToken) throw new Error('Google did not issue a refresh token. Re-authorize with consent or move the OAuth app out of Testing before relying on this connection long-term.');

    const scopes = String(token.scope || YOUTUBE_SCOPE).split(/\s+/).filter(Boolean);
    const expiresAt = new Date(Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000);
    const saved = await YouTubeAuth.findOneAndUpdate(
      { provider: PROVIDER },
      {
        $set: {
          channelId: identity.channelId,
          displayName: identity.displayName,
          accessTokenBox: secretBox.encrypt(token.access_token, ACCESS_CONTEXT),
          refreshTokenBox: secretBox.encrypt(refreshToken, REFRESH_CONTEXT),
          scopes,
          expiresAt
        },
        $setOnInsert: { provider: PROVIDER }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return summarize(saved);
  }

  function summarize(doc) {
    return {
      configured: configured(),
      connected: Boolean(doc?.accessTokenBox && doc?.refreshTokenBox && doc?.channelId),
      channelId: doc?.channelId || null,
      displayName: doc?.displayName || null,
      scopes: Array.isArray(doc?.scopes) ? doc.scopes : [],
      expiresAt: doc?.expiresAt || null,
      updatedAt: doc?.updatedAt || null,
      encryption: secretBox.status()
    };
  }

  async function getStatus() {
    const doc = await YouTubeAuth.findOne({ provider: PROVIDER }).lean();
    return summarize(doc);
  }

  async function refreshAccessToken(doc) {
    const refreshToken = secretBox.decrypt(doc.refreshTokenBox, REFRESH_CONTEXT);
    const token = await postToken({
      client_id: YOUTUBE_CLIENT_ID,
      client_secret: YOUTUBE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });
    const expiresAt = new Date(Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000);
    const update = {
      accessTokenBox: secretBox.encrypt(token.access_token, ACCESS_CONTEXT),
      expiresAt
    };
    if (token.refresh_token) update.refreshTokenBox = secretBox.encrypt(token.refresh_token, REFRESH_CONTEXT);
    if (token.scope) update.scopes = String(token.scope).split(/\s+/).filter(Boolean);
    await YouTubeAuth.updateOne({ _id: doc._id }, { $set: update });
    return token.access_token;
  }

  async function getValidAccessToken() {
    const doc = await YouTubeAuth.findOne({ provider: PROVIDER });
    if (!doc?.accessTokenBox || !doc?.refreshTokenBox) throw new Error('SqwertArmyBot YouTube OAuth is not connected.');
    const expiresAtMs = doc.expiresAt ? new Date(doc.expiresAt).getTime() : 0;
    if (expiresAtMs > Date.now() + REFRESH_MARGIN_MS) return secretBox.decrypt(doc.accessTokenBox, ACCESS_CONTEXT);
    if (!refreshPromise) {
      refreshPromise = refreshAccessToken(doc).finally(() => { refreshPromise = null; });
    }
    return refreshPromise;
  }

  async function disconnect() {
    await YouTubeAuth.deleteOne({ provider: PROVIDER });
  }

  return {
    configured,
    createAuthorizationUrl,
    exchangeCode,
    getStatus,
    getValidAccessToken,
    disconnect
  };
}

module.exports = { createYouTubeAuthManager };
