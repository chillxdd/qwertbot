const path = require('path');
const {
  MAX_COMMAND_NAME_LENGTH,
  MAX_TRIGGER_LENGTH,
  MAX_TRIGGERS,
  MAX_RESPONSES,
  MAX_RESPONSE_LENGTH,
  MAX_COOLDOWN_SECONDS,
  DEFAULT_COMMAND_COOLDOWN_SECONDS,
  DEFAULT_GLOBAL_COOLDOWN_SECONDS
} = require('../services/customCommands');
const { MAX_STREAM_LORE_LENGTH } = require('../services/streamLore');
const {
  MAX_TIMER_NAME_LENGTH, MIN_TIMER_INTERVAL_SECONDS, MAX_TIMER_INTERVAL_SECONDS, MAX_TIMER_RESPONSES, MAX_TIMER_RESPONSE_LENGTH,
  MAX_START_DELAY_SECONDS, MAX_JITTER_SECONDS, MAX_MINIMUM_CHAT_MESSAGES, MAX_MINIMUM_VIEWERS
} = require('../services/chatTimers');
const { MAX_BOT_PERSONALITY_NAME_LENGTH, MAX_BOT_PERSONALITY_LENGTH, MAX_BOT_PERSONALITY_COOLDOWN_SECONDS } = require('../services/botPersonality');
const { getRecentRenderLogs, getRenderLogsConfigStatus } = require('../services/renderLogs');
const { getRuntimeDiagnostics } = require('../services/runtimeDiagnostics');
const { getGeminiClientStatus } = require('../services/geminiClient');
const { getAuthStatus } = require('../services/twitchAuth');
const { getBroadcasterAuthStatus } = require('../services/twitchBroadcasterAuth');
const { getChatApiReadiness } = require('../services/twitchChat');
const { REQUIRED_EVENTSUB_SCOPES, getEventSubStatus } = require('../services/twitchEventSub');

function registerDashboardRoutes(app, options) {
  const {
    requireModSession,
    modSessionManager,
    dashboardPassword,
    modSessionLifetimeMs,
    channelName,
    botUsername,
    twitchClientId,
    twitchClientSecret,
    botScopes,
    broadcasterScopes,
    getRecapManager,
    getBotPersonalityManager,
    getDatabaseConnected,
    getBotConnected,
    getUsingMongoOAuth,
    webuiDir
  } = options;

  app.get('/webui-config', (req, res) => {
    res.json({
      success: true,
      channelName: channelName || 'generalqwert',
      botUsername: botUsername || '',
      maxStreamLoreLength: MAX_STREAM_LORE_LENGTH,
      maxBotPersonalityNameLength: MAX_BOT_PERSONALITY_NAME_LENGTH,
      maxBotPersonalityLength: MAX_BOT_PERSONALITY_LENGTH,
      maxBotPersonalityCooldownSeconds: MAX_BOT_PERSONALITY_COOLDOWN_SECONDS,
      timers: {
        maxTimerNameLength: MAX_TIMER_NAME_LENGTH,
        minIntervalSeconds: MIN_TIMER_INTERVAL_SECONDS,
        maxIntervalSeconds: MAX_TIMER_INTERVAL_SECONDS,
        maxResponses: MAX_TIMER_RESPONSES,
        maxResponseLength: MAX_TIMER_RESPONSE_LENGTH,
        maxStartDelaySeconds: MAX_START_DELAY_SECONDS,
        maxJitterSeconds: MAX_JITTER_SECONDS,
        maxMinimumChatMessages: MAX_MINIMUM_CHAT_MESSAGES,
        maxMinimumViewers: MAX_MINIMUM_VIEWERS
      },
      customCommands: {
        maxCommandNameLength: MAX_COMMAND_NAME_LENGTH,
        maxTriggerLength: MAX_TRIGGER_LENGTH,
        maxTriggers: MAX_TRIGGERS,
        maxResponses: MAX_RESPONSES,
        maxResponseLength: MAX_RESPONSE_LENGTH,
        maxCooldownSeconds: MAX_COOLDOWN_SECONDS,
        defaultCommandCooldownSeconds: DEFAULT_COMMAND_COOLDOWN_SECONDS,
        defaultGlobalCooldownSeconds: DEFAULT_GLOBAL_COOLDOWN_SECONDS
      }
    });
  });

  app.get('/health', (req, res) => res.status(200).send('OK'));

  app.get('/status', async (req, res) => {
    const recapManager = getRecapManager();
    const recapStatus = recapManager ? recapManager.getStatus() : {
      streamLive: false,
      streamStateInitialized: false,
      currentStreamTitle: null,
      currentStreamCategory: null,
      currentStreamGameId: null,
      loggingMessages: false,
      recapPaused: false,
      messagesInWindow: 0,
      twitchEventsInWindow: 0,
      contextChangesInWindow: 0,
      recapInProgress: false,
      nextRecapAt: null,
      pausedRemainingMs: null
    };

    let authStatus = { stored: false, username: null, twitchUserId: null, scopes: [], updatedAt: null };
    let broadcasterAuthStatus = { stored: false, username: null, twitchUserId: null, scopes: [], updatedAt: null };
    let chatApiStatus = { ready: false, botMissingScopes: ['user:write:chat', 'user:bot'], broadcasterMissingScopes: ['channel:bot'] };
    const eventSubStatus = getEventSubStatus();
    let botMissingAllScopes = [...botScopes];
    let broadcasterMissingAllScopes = [...broadcasterScopes];

    try {
      if (getDatabaseConnected()) {
        [authStatus, broadcasterAuthStatus, chatApiStatus] = await Promise.all([
          getAuthStatus(), getBroadcasterAuthStatus(), getChatApiReadiness()
        ]);
        botMissingAllScopes = botScopes.filter((scope) => !(authStatus.scopes || []).includes(scope));
        broadcasterMissingAllScopes = broadcasterScopes.filter((scope) => !(broadcasterAuthStatus.scopes || []).includes(scope));
      }
    } catch (err) {
      console.error('[OAuth] Could not load Twitch authorization status:', err.message || err);
    }


    res.json({
      success: true,
      qwert: {
        live: recapStatus.streamLive,
        statusKnown: recapStatus.streamStateInitialized,
        twitchUrl: `https://www.twitch.tv/${channelName}`,
        title: recapStatus.currentStreamTitle,
        category: recapStatus.currentStreamCategory,
        gameId: recapStatus.currentStreamGameId,
        startedAt: recapStatus.twitchStreamStartedAt,
        uptimeMs: recapStatus.streamUptimeMs
      },
      bot: {
        online: getBotConnected(),
        loggingMessages: recapStatus.loggingMessages,
        recapPaused: recapStatus.recapPaused,
        messagesInWindow: recapStatus.messagesInWindow,
        twitchEventsInWindow: recapStatus.twitchEventsInWindow || 0,
        contextChangesInWindow: recapStatus.contextChangesInWindow,
        recapInProgress: recapStatus.recapInProgress,
        nextRecapAt: recapStatus.nextRecapAt,
        pausedRemainingMs: recapStatus.pausedRemainingMs
      },
      database: { connected: getDatabaseConnected() },
      oauth: {
        configured: Boolean(twitchClientId && twitchClientSecret),
        stored: authStatus.stored,
        username: authStatus.username,
        scopes: authStatus.scopes,
        updatedAt: authStatus.updatedAt,
        usingMongoOAuth: getUsingMongoOAuth(),
        botMissingScopes: botMissingAllScopes,
        broadcaster: {
          stored: broadcasterAuthStatus.stored,
          username: broadcasterAuthStatus.username,
          scopes: broadcasterAuthStatus.scopes,
          updatedAt: broadcasterAuthStatus.updatedAt,
          missingScopes: broadcasterMissingAllScopes
        },
        chatApiReady: Boolean(chatApiStatus.ready)
      },
      eventsub: {
        requiredScopes: REQUIRED_EVENTSUB_SCOPES,
        optionalScopes: eventSubStatus.optionalScopes || [],
        lastEnsureAt: eventSubStatus.lastEnsureAt,
        lastEnsureError: eventSubStatus.lastEnsureError,
        subscriptions: eventSubStatus.lastEnsureResults,
        lastEventAt: eventSubStatus.lastEventAt
      }
    });
  });

  app.post('/mod-login', (req, res) => {
    if (!dashboardPassword) return res.status(500).json({ success: false, error: 'DASHBOARD_PASSWORD is not configured on the server.' });
    if (!modSessionManager.isValidPassword(req.body.password)) return res.status(401).json({ success: false, error: 'Incorrect password!' });
    modSessionManager.createSession(res);
    return res.json({ success: true, expiresInMs: modSessionLifetimeMs });
  });

  app.get('/mod-session', (req, res) => res.json({ success: true, authenticated: modSessionManager.hasValidSession(req) }));

  app.post('/mod-logout', (req, res) => {
    modSessionManager.clearSession(req, res);
    return res.json({ success: true });
  });

  app.post('/render-logs', requireModSession, async (req, res) => {
    const recapManager = getRecapManager();
    const recapStatus = recapManager?.getStatus?.() || {};
    const taggedStatus = getBotPersonalityManager?.()?.getRecapCollisionStatus?.() || {};
    const runtime = getRuntimeDiagnostics();
    const gemini = getGeminiClientStatus();
    const diagnostics = {
      runtime,
      gemini,
      taggedQuestions: {
        inFlight: Number(taggedStatus.taggedQuestionsInFlight || 0)
      },
      recap: {
        inProgress: Boolean(recapStatus.recapInProgress),
        paused: Boolean(recapStatus.recapPaused),
        messagesInWindow: Number(recapStatus.messagesInWindow || 0),
        twitchEventsInWindow: Number(recapStatus.twitchEventsInWindow || 0)
      },
      services: {
        databaseConnected: Boolean(getDatabaseConnected()),
        botConnected: Boolean(getBotConnected()),
        streamLive: Boolean(recapStatus.streamLive),
        streamStateKnown: Boolean(recapStatus.streamStateInitialized)
      }
    };

    const config = getRenderLogsConfigStatus();
    if (!config.configured) {
      return res.json({
        success: true,
        configured: false,
        serviceName: process.env.RENDER_SERVICE_NAME || 'Render service',
        logs: [],
        hasMore: false,
        logsError: config.error,
        diagnostics
      });
    }

    try {
      const result = await getRecentRenderLogs({ limit: 100 });
      return res.json({ success: true, configured: true, serviceName: result.serviceName, logs: result.logs, hasMore: result.hasMore, diagnostics });
    } catch (err) {
      console.error('[Render Diagnostics] Could not load Render logs:', err.message || err);
      return res.json({
        success: true,
        configured: true,
        serviceName: process.env.RENDER_SERVICE_NAME || 'Render service',
        logs: [],
        hasMore: false,
        logsError: err.message || 'Could not load Render logs.',
        diagnostics
      });
    }
  });

  app.get('/', (req, res) => res.sendFile(path.join(webuiDir, 'index.html')));
}

module.exports = { registerDashboardRoutes };
