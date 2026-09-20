'use strict';

const tmi = require('tmi.js');
const context = require('./reliability/context');
const { deliveryError } = require('./reliability/twitchDelivery');
const {
  getAccessToken,
  getStoredAuth,
  getValidAccessToken,
  refreshStoredToken,
  validateAccessToken
} = require('./twitchAuth');
const { getValidBroadcasterAccessToken } = require('./twitchBroadcasterAuth');

function createTwitchConnectionController({
  channelName,
  botUsername,
  fallbackAccessToken = '',
  twitchMessageLimit = 500,
  oauthValidationIntervalMs = 50 * 60 * 1000,
  isDatabaseConnected,
  getRuntime,
  getRecapManager,
  getMessageHandler
}) {
  let botConnected = false;
  let usingMongoOAuth = false;
  let twitchClient = null;
  let reconnectInProgress = false;
  let authRecoveryInProgress = false;
  let authRecoveryTimer = null;
  let oauthValidationTimer = null;
  let connectionGeneration = 0;

  function runtimeIsActive() {
    return Boolean(getRuntime?.()?.isActive?.());
  }

  function runtimeCanServeControls() {
    return Boolean(getRuntime?.()?.canServeControls?.());
  }

  async function getBotAccessToken() {
    try {
      const stored = await getAccessToken();
      if (stored) {
        usingMongoOAuth = true;
        return stored;
      }
    } catch (err) {
      console.error('[OAuth Bot] Failed to read stored Twitch token:', err.message || err);
    }

    usingMongoOAuth = false;
    return fallbackAccessToken || null;
  }

  async function refreshBotAccessToken() {
    const refreshed = await refreshStoredToken();
    usingMongoOAuth = true;
    return refreshed;
  }

  async function validateAnyBotToken(token) {
    return validateAccessToken(token);
  }

  function isIrcAuthenticationFailure(reason) {
    const text = String(reason || '').toLowerCase();
    return text.includes('login authentication failed') || text.includes('improperly formatted auth');
  }

  function clearAuthRecoveryTimer() {
    if (authRecoveryTimer) {
      clearTimeout(authRecoveryTimer);
      authRecoveryTimer = null;
    }
  }

  async function recoverIrcAuthentication(reason = 'IRC authentication failure') {
    if (!runtimeIsActive() || !usingMongoOAuth || authRecoveryInProgress) return;

    authRecoveryInProgress = true;
    clearAuthRecoveryTimer();

    try {
      console.warn(`[OAuth Bot] ${reason}. Validating the stored bot token and refreshing it if needed.`);
      const accessToken = await getValidAccessToken({ allowRefresh: true });
      if (!accessToken) throw new Error('No MongoDB Twitch bot authorization is available.');

      usingMongoOAuth = true;
      await reconnect(reason, { accessToken });
      console.log('[OAuth Bot] IRC authentication recovery completed successfully.');
    } catch (err) {
      console.error('[OAuth Bot] IRC authentication recovery failed:', err.message || err);
      if (!err?.reauthorizationRequired) {
        authRecoveryTimer = setTimeout(() => {
          authRecoveryTimer = null;
          recoverIrcAuthentication('retry after IRC authentication failure').catch((retryErr) => {
            console.error('[OAuth Bot] Delayed IRC authentication recovery failed:', retryErr.message || retryErr);
          });
        }, 15000);
        console.warn('[OAuth Bot] IRC authentication recovery will retry in 15 seconds.');
      } else {
        console.error('[OAuth Bot] Twitch reports that the bot authorization itself is no longer refreshable. Manual bot reauthorization is required.');
      }
    } finally {
      authRecoveryInProgress = false;
    }
  }

  async function validateStoredOAuthSessions() {
    if (!isDatabaseConnected?.() || !runtimeIsActive()) return;

    try {
      const before = await getStoredAuth();
      const validBotToken = await getValidAccessToken({ allowRefresh: true });
      const after = await getStoredAuth();

      if (validBotToken) {
        usingMongoOAuth = true;
        console.log('[OAuth Bot] Hourly token validation succeeded.');
        if (before?.accessToken && after?.accessToken && before.accessToken !== after.accessToken) {
          await reconnect('hourly OAuth refresh', { accessToken: after.accessToken });
        }
      }
    } catch (err) {
      if (err?.reauthorizationRequired) {
        console.error('[OAuth Bot] Authorization can no longer be refreshed. Manual bot reauthorization is required.');
      } else {
        console.warn('[OAuth Bot] Hourly token validation failed:', err.message || err);
      }
    }

    try {
      const broadcasterToken = await getValidBroadcasterAccessToken({ allowRefresh: true });
      if (broadcasterToken) console.log('[OAuth Broadcaster] Hourly token validation succeeded.');
    } catch (err) {
      if (err?.reauthorizationRequired) {
        console.error('[OAuth Broadcaster] Authorization can no longer be refreshed. Qwert must authorize again.');
      } else {
        console.warn('[OAuth Broadcaster] Hourly token validation failed:', err.message || err);
      }
    }
  }

  function startOAuthValidationLoop() {
    if (oauthValidationTimer) clearInterval(oauthValidationTimer);
    oauthValidationTimer = setInterval(() => {
      validateStoredOAuthSessions().catch((err) => {
        console.warn('[OAuth] Scheduled OAuth validation error:', err.message || err);
      });
    }, oauthValidationIntervalMs);
  }

  async function resolveStartupToken() {
    try {
      const stored = await getValidAccessToken({ allowRefresh: true });
      if (stored) {
        usingMongoOAuth = true;
        console.log('[OAuth Bot] Using Twitch token stored in MongoDB.');
        return stored;
      }
    } catch (err) {
      console.error('[OAuth Bot] Stored Twitch token could not be used:', err.message || err);
    }

    if (fallbackAccessToken) {
      usingMongoOAuth = false;
      console.warn('[OAuth Bot] Using legacy TWITCH_BOT_ACCESS_TOKEN fallback. Authorize the bot in the WebUI to move fully to MongoDB OAuth.');
      return fallbackAccessToken;
    }

    return null;
  }

  function attachHandlers(client, generation) {
    client.on('connected', () => {
      if (generation !== connectionGeneration || !runtimeIsActive()) return;
      botConnected = true;
      console.log('[Bot] Twitch chat connection is online.');
    });

    client.on('disconnected', (reason) => {
      if (generation !== connectionGeneration || !runtimeIsActive()) return;
      botConnected = false;
      console.log('[Bot] Twitch chat disconnected:', reason);
      if (usingMongoOAuth && isIrcAuthenticationFailure(reason)) {
        recoverIrcAuthentication('IRC disconnect reported an authentication failure').catch((err) => {
          console.error('[OAuth Bot] IRC disconnect recovery error:', err.message || err);
        });
      }
    });

    client.on('notice', (channel, msgid, message) => {
      if (generation !== connectionGeneration || !runtimeIsActive()) return;
      if (usingMongoOAuth && isIrcAuthenticationFailure(message)) {
        recoverIrcAuthentication('IRC NOTICE reported an authentication failure').catch((err) => {
          console.error('[OAuth Bot] IRC notice recovery error:', err.message || err);
        });
      }
    });

    client.on('announcement', (channel, tags, message, self, color) => {
      const recapManager = getRecapManager?.();
      if (generation !== connectionGeneration || !recapManager || !runtimeCanServeControls()) return;
      const rawMessage = String(message || '').trim();
      if (!rawMessage) return;
      const displayName = tags?.['display-name'] || tags?.login || tags?.username || 'moderator';
      recapManager.recordModeratorAnnouncement({
        displayName,
        rawMessage,
        color: String(color || tags?.['msg-param-color'] || '').trim(),
        tags,
        twitchMessageId: tags?.id || tags?.['message-id'] || '',
        timestamp: tags?.['tmi-sent-ts'] || Date.now()
      });
    });

    client.on('message', async (channel, tags, message) => {
      const recapManager = getRecapManager?.();
      const messageHandler = getMessageHandler?.();
      if (generation !== connectionGeneration || !recapManager || !messageHandler || !runtimeCanServeControls()) return;
      await context.runOperation(() => messageHandler.handleMessage(channel, tags, message))
        .catch((err) => { if (!err.cancelled) console.error('[Chat Handler] Message processing failed:', err.message); });
    });
  }

  async function createAndConnect(accessToken) {
    await context.assertOperation();
    if (!accessToken) throw new Error('No Twitch access token is available.');
    if (!botUsername || !channelName) throw new Error('TWITCH_BOT_USERNAME or TWITCH_CHANNEL is missing.');

    connectionGeneration++;
    const generation = connectionGeneration;
    const client = new tmi.Client({
      options: { debug: true },
      identity: {
        username: botUsername,
        password: `oauth:${accessToken.replace(/^oauth:/i, '')}`
      },
      channels: [channelName]
    });

    attachHandlers(client, generation);
    twitchClient = client;
    let connectTimer;
    try {
      await Promise.race([client.connect(), new Promise((_, reject) => {
        connectTimer = setTimeout(() => reject(new Error('Twitch IRC connection timed out after 20 seconds.')), 20000);
      })]);
      await context.assertOperation();
    } catch (err) {
      void client.disconnect().catch(() => {});
      throw err;
    } finally {
      clearTimeout(connectTimer);
    }
    botConnected = true;
    console.log(`[Bot] Connected to Twitch channel: #${channelName}`);
    return client;
  }

  async function reconnect(reason = 'manual reconnect', { accessToken = null } = {}) {
    if (reconnectInProgress || !runtimeIsActive()) return;
    reconnectInProgress = true;
    try {
      console.log(`[Bot] Reconnecting Twitch client: ${reason}`);
      const oldClient = twitchClient;
      botConnected = false;
      if (oldClient) {
        try { await oldClient.disconnect(); }
        catch (err) { console.warn('[Bot] Old Twitch client disconnect warning:', err.message || err); }
      }
      const tokenToUse = accessToken || await getBotAccessToken();
      await createAndConnect(tokenToUse);
      await getRecapManager?.()?.start?.();
      await getRecapManager?.()?.checkStreamStatus?.();
      console.log('[Bot] Twitch client reconnected successfully.');
    } finally {
      reconnectInProgress = false;
    }
  }

  async function maintainConnection() {
    if (!runtimeIsActive() || botConnected || reconnectInProgress) return;
    const token = await resolveStartupToken();
    if (!token) return;
    try { await reconnect('automatic connection recovery', { accessToken: token }); }
    catch (err) { console.warn('[Bot] Recovery pending:', err.message); }
  }

  async function sendViaIrcFallback(channel, message, apiError, options = {}) {
    if (!twitchClient || !botConnected) throw apiError;
    const normalizedChannel = String(channel || '').replace(/^#/, '').toLowerCase();
    const targetChannel = normalizedChannel || channelName;
    console.warn(`[Chat] Chat API unavailable (${apiError?.message || apiError}). Falling back to IRC for this message.`);

    let fallbackMessage = String(message || '').trim();
    const fallbackLogin = String(options?.fallbackMentionLogin || '').replace(/^@+/, '').toLowerCase().trim();
    const fallbackDisplayName = String(options?.fallbackMentionDisplayName || '').replace(/^@+/, '').trim();
    const fallbackTarget = fallbackLogin || fallbackDisplayName;
    if (options?.replyParentMessageId && fallbackTarget) {
      const mentionPattern = new RegExp(`^@${String(fallbackTarget).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|\\s|[,:-])`, 'i');
      if (!mentionPattern.test(fallbackMessage)) fallbackMessage = `@${fallbackTarget} ${fallbackMessage}`.trim();
    }
    fallbackMessage = Array.from(fallbackMessage).slice(0, twitchMessageLimit).join('').trim();

    await context.assertOperation();
    try { await twitchClient.say(targetChannel, fallbackMessage); }
    catch (cause) { throw deliveryError('IRC send outcome is unknown; it will not be retried automatically.', { state: 'UNKNOWN', cause }); }
    console.log('[Chat] Message sent through IRC fallback. Bot badge will not apply to this message.');
    return { method: 'irc_fallback', fallback: true, apiError: apiError?.message || String(apiError || '') };
  }

  function setUsingMongoOAuth(value) {
    usingMongoOAuth = Boolean(value);
  }

  function quiesce() {
    botConnected = false;
    connectionGeneration++;
    clearAuthRecoveryTimer();
    if (oauthValidationTimer) {
      clearInterval(oauthValidationTimer);
      oauthValidationTimer = null;
    }
  }

  async function disconnect() {
    if (!twitchClient) return;
    try { await twitchClient.disconnect(); }
    catch (err) { console.warn('[Shutdown] IRC disconnect:', err.message); }
  }

  return {
    getBotAccessToken,
    refreshBotAccessToken,
    validateAnyBotToken,
    resolveStartupToken,
    createAndConnect,
    reconnect,
    maintainConnection,
    sendViaIrcFallback,
    startOAuthValidationLoop,
    validateStoredOAuthSessions,
    setUsingMongoOAuth,
    isConnected: () => botConnected,
    isUsingMongoOAuth: () => usingMongoOAuth,
    isReconnectInProgress: () => reconnectInProgress,
    getClient: () => twitchClient,
    quiesce,
    disconnect
  };
}

module.exports = { createTwitchConnectionController };
