const crypto = require('crypto');
const { timingSafeStringEqual } = require('../middleware/modSession');
const {
  exchangeAuthorizationCode,
  getStoredAuth,
  storeAuthorizationCodeResult,
  validateAccessToken
} = require('../services/twitchAuth');
const {
  exchangeBroadcasterAuthorizationCode,
  getBroadcasterAuthStatus,
  storeBroadcasterAuthorizationCodeResult,
  validateBroadcasterAccessToken
} = require('../services/twitchBroadcasterAuth');
const { ensureEventSubSubscriptions } = require('../services/twitchEventSub');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function createOAuthStateStore(lifetimeMs) {
  const states = new Map();

  function cleanup() {
    const now = Date.now();
    for (const [state, createdAt] of states.entries()) {
      if (now - createdAt > lifetimeMs) states.delete(state);
    }
  }

  return {
    has(state) {
      cleanup();
      return Boolean(state && states.has(state));
    },
    create() {
      cleanup();
      const state = crypto.randomBytes(32).toString('hex');
      states.set(state, Date.now());
      return state;
    },
    consume(state) {
      cleanup();
      if (!state || !states.has(state)) return false;
      states.delete(state);
      return true;
    },
    cleanup
  };
}

function registerAuthRoutes(app, options) {
  const {
    requireModSession,
    getDatabaseConnected,
    setUsingMongoOAuth,
    reconnectTwitchClient,
    channelName,
    botUsername,
    clientId,
    clientSecret,
    redirectUri,
    botScopes,
    broadcasterScopes,
    qwertOAuthLinkSecret,
    oauthStateLifetimeMs
  } = options;

  const botStates = createOAuthStateStore(oauthStateLifetimeMs);
  const broadcasterStates = createOAuthStateStore(oauthStateLifetimeMs);

  const validQwertSecret = (value) => timingSafeStringEqual(value, qwertOAuthLinkSecret);

  app.post('/auth/twitch/start', requireModSession, (req, res) => {
    if (!clientId || !clientSecret) {
      return res.status(500).json({ success: false, error: 'TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET is not configured.' });
    }

    if (!getDatabaseConnected()) {
      return res.status(500).json({ success: false, error: 'MongoDB is not connected.' });
    }

    const state = botStates.create();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: botScopes.join(' '),
      state,
      force_verify: 'true'
    });

    res.json({
      success: true,
      authorizationUrl: `https://id.twitch.tv/oauth2/authorize?${params.toString()}`
    });
  });

  app.get('/auth/twitch/callback', async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query;

    botStates.cleanup();
    broadcasterStates.cleanup();

    const isBotAuthorization = botStates.has(state);
    const isBroadcasterAuthorization = broadcasterStates.has(state);

    if (!isBotAuthorization && !isBroadcasterAuthorization) {
      return res.status(400).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>OAuth request expired</h2><p>Return to the dashboard and start authorization again.</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></body></html>`);
    }

    if (isBotAuthorization) botStates.consume(state);
    if (isBroadcasterAuthorization) broadcasterStates.consume(state);

    if (error) {
      const who = isBroadcasterAuthorization ? 'Broadcaster' : 'Bot';
      return res.status(400).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>${who} Twitch authorization failed</h2><p>${escapeHtml(errorDescription || error)}</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></body></html>`);
    }

    if (!code) return res.status(400).send('Missing Twitch authorization code.');

    try {
      if (isBroadcasterAuthorization) {
        const tokenData = await exchangeBroadcasterAuthorizationCode({
          code,
          redirectUri
        });

        const validation = await validateBroadcasterAccessToken(tokenData.access_token);
        const authorizedLogin = (validation.login || '').toLowerCase().trim();

        if (channelName && authorizedLogin !== channelName) {
          return res.status(400).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>Wrong broadcaster account</h2><p>You authorized <strong>${escapeHtml(authorizedLogin || 'unknown')}</strong>, but TWITCH_CHANNEL is <strong>${escapeHtml(channelName)}</strong>.</p><p>Log into Twitch as the broadcaster/channel owner and try again.</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></body></html>`);
        }

        const scopes = Array.isArray(validation.scopes) ? validation.scopes : [];
        const missingScopes = broadcasterScopes.filter((scope) => !scopes.includes(scope));

        if (missingScopes.length > 0) {
          return res.status(400).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>Missing broadcaster permission</h2><p>Missing: ${escapeHtml(missingScopes.join(', '))}</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></body></html>`);
        }

        await storeBroadcasterAuthorizationCodeResult(tokenData);
        console.log(`[OAuth Broadcaster] Authorization saved to MongoDB for ${authorizedLogin}.`);

        let eventSubNote = 'EventSub setup will be retried automatically if needed.';
        try {
          const eventSubResults = await ensureEventSubSubscriptions();
          const failures = eventSubResults.filter((item) => item.status === 'error');
          const skipped = eventSubResults.filter((item) => item.status === 'skipped_missing_scope');
          const active = eventSubResults.length - failures.length - skipped.length;
          eventSubNote = failures.length
            ? `Broadcaster OAuth succeeded. ${active} EventSub subscription(s) are active; ${failures.length} need a retry. Check Render logs.`
            : skipped.length
              ? `Broadcaster OAuth succeeded. ${active} EventSub subscription(s) are active and ${skipped.length} optional subscription(s) are still waiting on permission.`
              : `Broadcaster OAuth succeeded and ${active} Twitch EventSub subscriptions were created or already existed.`;
        } catch (eventSubErr) {
          console.error('[EventSub] Setup after broadcaster OAuth failed:', eventSubErr.message || eventSubErr);
        }

        return res.send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><div style="max-width:700px;margin:auto;background:#18181b;padding:24px;border-radius:8px"><h2 style="color:#00f59b">Broadcaster authorization successful</h2><p>Authorized broadcaster: <strong>${escapeHtml(authorizedLogin)}</strong></p><p>The bot-badge and EventSub permissions were stored securely in MongoDB.</p><p>${escapeHtml(eventSubNote)}</p><p>Return to the dashboard. When the bot authorization is also updated, the dashboard will show <strong>BOT BADGE READY</strong>.</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></div></body></html>`);
      }

      const tokenData = await exchangeAuthorizationCode({
        code,
        redirectUri
      });

      const validation = await validateAccessToken(tokenData.access_token);
      const authorizedLogin = (validation.login || '').toLowerCase().trim();

      const existingBotAuth = getDatabaseConnected() ? await getStoredAuth() : null;
      const authorizedUserId = String(validation.user_id || '');
      const storedBotUserId = String(existingBotAuth?.twitchUserId || '');

      if (storedBotUserId) {
        if (!authorizedUserId || authorizedUserId !== storedBotUserId) {
          return res.status(400).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>Wrong Twitch account</h2><p>The Twitch account you authorized does not match the bot account already stored for this application.</p><p>Log into Twitch as <strong>${escapeHtml(botUsername || 'the configured bot account')}</strong> and try again.</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></body></html>`);
        }
      } else if (botUsername && authorizedLogin !== botUsername) {
        return res.status(400).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>Wrong Twitch account</h2><p>You authorized <strong>${escapeHtml(authorizedLogin || 'unknown')}</strong>, but TWITCH_BOT_USERNAME is <strong>${escapeHtml(botUsername)}</strong>.</p><p>Log into Twitch as the bot account and try again.</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></body></html>`);
      }

      const scopes = Array.isArray(validation.scopes) ? validation.scopes : [];
      const missingScopes = botScopes.filter((scope) => !scopes.includes(scope));

      if (missingScopes.length > 0) {
        return res.status(400).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>Missing Twitch permissions</h2><p>Missing: ${escapeHtml(missingScopes.join(', '))}</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></body></html>`);
      }

      await storeAuthorizationCodeResult(tokenData);
      setUsingMongoOAuth(true);
      console.log(`[OAuth Bot] Authorization saved to MongoDB for ${authorizedLogin}.`);

      setTimeout(() => {
        reconnectTwitchClient('updated MongoDB OAuth authorization').catch((err) => {
          console.error('[OAuth Bot] Twitch reconnect after authorization failed:', err.message || err);
        });
      }, 500);

      return res.send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><div style="max-width:700px;margin:auto;background:#18181b;padding:24px;border-radius:8px"><h2 style="color:#00f59b">Bot authorization successful</h2><p>Authorized account: <strong>${escapeHtml(authorizedLogin)}</strong></p><p>The bot grant now includes the scopes used for Twitch's modern Chat API, the legacy IRC connection used to receive chat, temporary hourly-recap pinning, and random current-chatter selection for custom commands.</p><p>Return to the dashboard and complete broadcaster authorization if it is still pending.</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></div></body></html>`);
    } catch (err) {
      console.error('[OAuth] Twitch callback failed:', err.message || err);
      return res.status(500).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>Twitch OAuth error</h2><p>${escapeHtml(err.message)}</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></body></html>`);
    }
  });

  app.get('/authorize-qwert', async (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    if (!qwertOAuthLinkSecret) {
      return res.status(503).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>Broadcaster authorization is not configured</h2><p>QWERT_OAUTH_LINK_SECRET is missing on the server.</p></body></html>`);
    }

    if (!validQwertSecret(String(req.query.key || ''))) {
      return res.status(403).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><h2>Invalid authorization link</h2><p>This private Qwert authorization link is invalid.</p></body></html>`);
    }

    if (!clientId || !clientSecret) {
      return res.status(500).send('TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET is not configured.');
    }

    if (!getDatabaseConnected()) {
      return res.status(500).send('MongoDB is not connected.');
    }

    try {
      const existing = await getBroadcasterAuthStatus();
      const scopes = Array.isArray(existing.scopes) ? existing.scopes : [];
      const alreadyAuthorized = existing.stored && broadcasterScopes.every((scope) => scopes.includes(scope));

      if (alreadyAuthorized) {
        return res.status(410).send(`<!doctype html><html><body style="font-family:Arial;background:#0f0f12;color:white;padding:40px"><div style="max-width:700px;margin:auto;background:#18181b;padding:24px;border-radius:8px"><h2 style="color:#00f59b">Authorization link already used</h2><p><strong>${escapeHtml(existing.username || channelName || 'Qwert')}</strong> has already granted all currently required broadcaster permissions.</p><p>This private authorization link is no longer needed.</p><p><a style="color:#bf94ff" href="/">Return to dashboard</a></p></div></body></html>`);
      }
    } catch (err) {
      console.error('[OAuth Broadcaster] Could not check existing authorization:', err.message || err);
      return res.status(500).send('Could not verify broadcaster authorization status.');
    }

    const state = broadcasterStates.create();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: broadcasterScopes.join(' '),
      state,
      force_verify: 'true'
    });

    res.redirect(`https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
  });

  app.get('/auth/broadcaster/start', (req, res) => {
    return res.status(404).send('Broadcaster OAuth is available only through the private Qwert authorization link.');
  });
}

module.exports = { registerAuthRoutes };
