const {
  getRecentStreamRecaps,
  saveStreamRecap,
  getActiveRecapState,
  saveActiveRecapState,
  clearStreamRecapsByChannel
} = require('./streamRecapHistory');
const { getStreamLore } = require('./streamLore');
const { generateRecap, SUMMARY_PREFIX } = require('./recapGenerator');

const FIRST_RECAP_DELAY = 60 * 60 * 1000;
const RECURRING_RECAP_DELAY = 60 * 60 * 1000;
const RECAP_FAILURE_RETRY_DELAY = 5 * 60 * 1000;
const RECAP_COMMAND_COOLDOWN = 5 * 60 * 1000;
const STREAM_STATUS_POLL_INTERVAL = 30 * 1000;
const TOKEN_VALIDATION_INTERVAL = 60 * 60 * 1000;
const ACTIVE_STATE_CHECKPOINT_INTERVAL = 30 * 1000;

function formatCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}min ${seconds}s` : `${seconds}s`;
}

function createRecapManager({
  client,
  channelName,
  getTwitchAccessToken,
  refreshTwitchAccessToken,
  validateTwitchAccessToken
}) {
  let twitchClientId = (process.env.TWITCH_CLIENT_ID || '').trim();
  let streamStateInitialized = false;
  let streamLive = false;
  let currentStreamTitle = '';
  let currentStreamCategory = '';
  let currentStreamGameId = '';
  let currentViewerCount = 0;
  let currentStreamId = '';
  let recapMessages = [];
  let messageSequence = 0;
  let streamContexts = [];
  let contextSequence = 0;
  let twitchEvents = [];
  let eventSequence = 0;
  let firstRecapSent = false;
  let recapInProgress = false;
  let streamSessionStartedAt = 0;
  let twitchStreamStartedAt = 0;
  let nextRecapAt = 0;
  let recapPaused = false;
  let pausedRemainingMs = 0;
  let recapTimer = null;
  let streamPollTimer = null;
  let tokenValidationTimer = null;
  let activeStateCheckpointTimer = null;
  let activeStateDirty = false;
  let activeStateSaveInProgress = false;
  let activeStateSavePromise = null;
  let lastRecapCommandUse = 0;

  function addStreamContext({ title = '', category = '', gameId = '' }) {
    const item = {
      title: String(title || '').trim(),
      category: String(category || '').trim(),
      gameId: String(gameId || '').trim()
    };

    const previous = streamContexts[streamContexts.length - 1];
    if (
      previous &&
      previous.title === item.title &&
      previous.category === item.category &&
      previous.gameId === item.gameId
    ) {
      return;
    }

    contextSequence++;
    streamContexts.push({ id: contextSequence, timestamp: Date.now(), ...item });
    activeStateDirty = true;
    console.log('[Recap] Stream context recorded:', {
      title: item.title || 'Unknown',
      category: item.category || 'Unknown'
    });
  }

  function updateCurrentStreamContext(status) {
    if (status?.startedAt) {
      const parsedStart = Date.parse(status.startedAt);
      if (!Number.isNaN(parsedStart)) twitchStreamStartedAt = parsedStart;
    }

    const newTitle = String(status?.title || '').trim();
    const newCategory = String(status?.category || '').trim();
    const newGameId = String(status?.gameId || '').trim();
    currentViewerCount = Math.max(0, Number(status?.viewerCount || 0) || 0);

    const changed =
      newTitle !== currentStreamTitle ||
      newCategory !== currentStreamCategory ||
      newGameId !== currentStreamGameId;

    currentStreamTitle = newTitle;
    currentStreamCategory = newCategory;
    currentStreamGameId = newGameId;

    if (changed && streamLive && !recapPaused) {
      addStreamContext({ title: newTitle, category: newCategory, gameId: newGameId });
    }
  }

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
    if (!twitchClientId) {
      throw new Error('TWITCH_CLIENT_ID environment variable is not set.');
    }

    let accessToken = await getAccessTokenOrThrow();
    const url = 'https://api.twitch.tv/helix/streams?' + new URLSearchParams({
      user_login: channelName
    }).toString();

    let response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': twitchClientId
      }
    });

    if (response.status === 401 && allowRefresh) {
      console.warn('[OAuth Bot] Recap stream-status request returned 401. Refreshing bot OAuth token.');
      const refreshed = await refreshTwitchAccessToken();
      accessToken = refreshed?.accessToken || await getAccessTokenOrThrow();
      twitchClientId = (process.env.TWITCH_CLIENT_ID || twitchClientId).trim();

      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Client-Id': twitchClientId
        }
      });
    }

    if (!response.ok) {
      throw new Error(`Twitch stream-status request failed with HTTP ${response.status}.`);
    }

    const data = await response.json();
    const stream = Array.isArray(data.data) && data.data.length > 0 ? data.data[0] : null;

    return {
      live: Boolean(stream),
      streamId: stream?.id || '',
      startedAt: stream?.started_at || null,
      title: stream?.title || '',
      category: stream?.game_name || '',
      gameId: stream?.game_id || '',
      viewerCount: Number(stream?.viewer_count || 0) || 0
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


  function buildActiveState() {
    return {
      recapMessages,
      messageSequence,
      streamContexts,
      contextSequence,
      twitchEvents,
      eventSequence,
      firstRecapSent,
      streamSessionStartedAt,
      twitchStreamStartedAt,
      nextRecapAt,
      recapPaused,
      pausedRemainingMs
    };
  }

  async function persistActiveState({ force = false } = {}) {
    if (!currentStreamId || !streamLive) return;
    if (!force && !activeStateDirty) return;
    if (activeStateSaveInProgress) {
      activeStateDirty = true;
      return;
    }

    activeStateSaveInProgress = true;
    activeStateDirty = false;
    const streamIdAtSave = currentStreamId;
    const stateAtSave = buildActiveState();
    activeStateSavePromise = saveActiveRecapState({
      streamId: streamIdAtSave,
      channelName,
      startedAt: twitchStreamStartedAt || streamSessionStartedAt || null,
      state: stateAtSave
    });
    try {
      await activeStateSavePromise;
    } catch (err) {
      activeStateDirty = true;
      console.error('[Recap Persistence] Could not checkpoint active recap window:', err.message || err);
    } finally {
      activeStateSavePromise = null;
      activeStateSaveInProgress = false;
    }
  }

  function markActiveStateDirty() {
    if (streamLive && currentStreamId) activeStateDirty = true;
  }

  async function restoreActiveStateIfAvailable(status) {
    const streamId = String(status?.streamId || '').trim();
    if (!streamId) return false;
    try {
      const saved = await getActiveRecapState({ streamId });
      if (!saved) return false;

      recapMessages = Array.isArray(saved.recapMessages) ? saved.recapMessages : [];
      messageSequence = Math.max(Number(saved.messageSequence || 0), recapMessages.at(-1)?.id || 0);
      streamContexts = Array.isArray(saved.streamContexts) ? saved.streamContexts : [];
      contextSequence = Math.max(Number(saved.contextSequence || 0), streamContexts.at(-1)?.id || 0);
      twitchEvents = Array.isArray(saved.twitchEvents) ? saved.twitchEvents : [];
      eventSequence = Math.max(Number(saved.eventSequence || 0), twitchEvents.at(-1)?.id || 0);
      firstRecapSent = Boolean(saved.firstRecapSent);
      recapInProgress = false;
      recapPaused = Boolean(saved.recapPaused);
      pausedRemainingMs = Math.max(0, Number(saved.pausedRemainingMs || 0));
      streamSessionStartedAt = Number(saved.streamSessionStartedAt || 0) || Date.now();
      twitchStreamStartedAt = Number(saved.twitchStreamStartedAt || 0) || twitchStreamStartedAt || Date.now();
      nextRecapAt = Number(saved.nextRecapAt || 0);

      activeStateDirty = false;
      if (!streamContexts.length) {
        addStreamContext({ title: currentStreamTitle, category: currentStreamCategory, gameId: currentStreamGameId });
      }

      if (!recapPaused) {
        if (!nextRecapAt) nextRecapAt = Date.now() + (firstRecapSent ? RECURRING_RECAP_DELAY : FIRST_RECAP_DELAY);
        scheduleRecapAt(Math.max(Date.now() + 1000, nextRecapAt));
      }

      console.log(`[Recap Persistence] Restored active recap window for stream ${streamId}: ${recapMessages.length} message(s), ${twitchEvents.length} event(s), next recap ${recapPaused ? 'paused' : new Date(nextRecapAt).toISOString()}.`);
      return true;
    } catch (err) {
      console.error('[Recap Persistence] Could not restore active recap window; starting fresh:', err.message || err);
      return false;
    }
  }

  function clearRecapTimer() {
    if (recapTimer) {
      clearTimeout(recapTimer);
      recapTimer = null;
    }
  }

  function scheduleRecapAt(timestamp) {
    clearRecapTimer();
    if (recapPaused) return;

    nextRecapAt = timestamp;
    const delay = Math.max(0, timestamp - Date.now());

    recapTimer = setTimeout(() => {
      sendAutomaticRecap(firstRecapSent ? '60-minute timer' : 'first 60-minute timer')
        .catch((err) => console.error('[Recap] Scheduled recap error:', err));
    }, delay);
  }

  async function startStreamSession(status, alreadyLiveAtStartup = false) {
    clearRecapTimer();
    streamLive = true;
    recapMessages = [];
    messageSequence = 0;
    streamContexts = [];
    contextSequence = 0;
    twitchEvents = [];
    eventSequence = 0;
    firstRecapSent = false;
    recapInProgress = false;
    recapPaused = false;
    pausedRemainingMs = 0;

    currentStreamId = String(status?.streamId || '').trim();
    currentStreamTitle = String(status?.title || '').trim();
    currentStreamCategory = String(status?.category || '').trim();
    currentStreamGameId = String(status?.gameId || '').trim();
    currentViewerCount = Math.max(0, Number(status?.viewerCount || 0) || 0);

    if (status?.startedAt) {
      const parsed = Date.parse(status.startedAt);
      twitchStreamStartedAt = Number.isNaN(parsed) ? Date.now() : parsed;
    } else {
      twitchStreamStartedAt = Date.now();
    }

    // Preserve existing recap cadence behavior: if the bot starts/restarts while
    // Qwert is already live, begin a fresh 60-minute recap window from bot startup.
    // twitchStreamStartedAt above remains the authoritative Twitch uptime source.
    if (status?.startedAt && !alreadyLiveAtStartup) {
      const parsed = Date.parse(status.startedAt);
      streamSessionStartedAt = Number.isNaN(parsed) ? Date.now() : parsed;
    } else {
      streamSessionStartedAt = Date.now();
    }

    const restored = alreadyLiveAtStartup ? await restoreActiveStateIfAvailable(status) : false;
    if (!restored) {
      addStreamContext({
        title: currentStreamTitle,
        category: currentStreamCategory,
        gameId: currentStreamGameId
      });

      nextRecapAt = streamSessionStartedAt + FIRST_RECAP_DELAY;
      scheduleRecapAt(nextRecapAt);
      markActiveStateDirty();
      await persistActiveState({ force: true });
    }

    console.log(`[Recap] Qwert is LIVE. Automatic recap session ${restored ? 'restored from MongoDB' : 'started'}.`);
    console.log('[Recap] Current stream title:', currentStreamTitle || 'Unknown');
    console.log('[Recap] Current category:', currentStreamCategory || 'Unknown');
    console.log(restored ? '[Recap Persistence] Existing recap cadence preserved across restart.' : '[Recap] First recap will send after 60 minutes.');
  }

  async function endStreamSession() {
    clearRecapTimer();
    if (activeStateSavePromise) {
      try { await activeStateSavePromise; } catch {}
    }
    streamLive = false;
    currentStreamId = '';
    currentStreamTitle = '';
    currentStreamCategory = '';
    currentStreamGameId = '';
    currentViewerCount = 0;
    recapMessages = [];
    messageSequence = 0;
    streamContexts = [];
    contextSequence = 0;
    twitchEvents = [];
    eventSequence = 0;
    firstRecapSent = false;
    recapInProgress = false;
    recapPaused = false;
    pausedRemainingMs = 0;
    streamSessionStartedAt = 0;
    twitchStreamStartedAt = 0;
    nextRecapAt = 0;
    activeStateDirty = false;
    clearStreamRecapsByChannel(channelName)
      .then((result) => console.log(`[Recap] Cleared ${result?.deletedCount || 0} stored stream recap session(s) from MongoDB.`))
      .catch((err) => console.error('[Recap] Could not clear stored stream recap history after stream end:', err.message || err));
    console.log('[Recap] Qwert is OFFLINE. Automatic recap session stopped and recap history cleared.');
  }

  async function checkStreamStatus() {
    try {
      const status = await fetchStreamStatus();

      if (!streamStateInitialized) {
        streamStateInitialized = true;
        if (status.live) await startStreamSession(status, true);
        else {
          streamLive = false;
          clearStreamRecapsByChannel(channelName)
            .then((result) => {
              if (result?.deletedCount) console.log(`[Recap] Removed ${result.deletedCount} stale stored recap session(s) while Qwert is offline.`);
            })
            .catch((err) => console.error('[Recap] Could not clear stale stream recap history:', err.message || err));
          console.log('[Recap] Qwert is currently offline. Waiting for stream start.');
        }
        return;
      }

      if (status.live && !streamLive) {
        await startStreamSession(status, false);
        return;
      }

      if (!status.live && streamLive) {
        await endStreamSession();
        return;
      }

      if (status.live && streamLive) updateCurrentStreamContext(status);
    } catch (err) {
      console.error('[Recap] Stream status check failed:', err.message || err);
    }
  }

  async function stopRecap({ channel, displayName = 'MOD', announce = true }) {
    if (!streamLive) {
      if (announce) await client.say(channel, `@${displayName}, Qwert is offline, so the recap system is already inactive.`);
      return { success: false, message: 'Qwert is offline.' };
    }

    if (recapPaused) {
      if (announce) await client.say(channel, `@${displayName}, automatic hourly recaps are already paused.`);
      return { success: false, message: 'Automatic hourly recaps are already paused.' };
    }

    if (recapInProgress) {
      if (announce) await client.say(channel, `@${displayName}, an hourly recap is already being generated, so it can't be paused right now.`);
      return { success: false, message: 'An hourly recap is currently being generated.' };
    }

    pausedRemainingMs = nextRecapAt ? Math.max(0, nextRecapAt - Date.now()) : 0;
    recapPaused = true;
    clearRecapTimer();
    markActiveStateDirty();
    await persistActiveState({ force: true });

    console.log(`[Recap] Paused by ${displayName}.`);
    console.log(`[Recap] ${recapMessages.length} messages preserved.`);
    console.log(`[Recap] ${formatCountdown(pausedRemainingMs)} remaining on timer.`);

    if (announce) {
      await client.say(channel, `@${displayName}, automatic hourly recaps are paused. ${recapMessages.length} messages are preserved and the timer is frozen with ${formatCountdown(pausedRemainingMs)} remaining.`);
    }

    return { success: true, message: `Automatic hourly recaps paused with ${formatCountdown(pausedRemainingMs)} remaining.` };
  }

  async function startRecap({ channel, displayName = 'MOD', announce = true }) {
    if (!streamLive) {
      if (announce) await client.say(channel, `@${displayName}, Qwert is offline. Hourly recaps will start fresh when the next stream begins.`);
      return { success: false, message: 'Qwert is offline.' };
    }

    if (!recapPaused) {
      if (announce) await client.say(channel, `@${displayName}, automatic hourly recaps are already running.`);
      return { success: false, message: 'Automatic hourly recaps are already running.' };
    }

    recapPaused = false;
    const resumeDelay = Math.max(1000, pausedRemainingMs);
    nextRecapAt = Date.now() + resumeDelay;
    pausedRemainingMs = 0;

    addStreamContext({
      title: currentStreamTitle,
      category: currentStreamCategory,
      gameId: currentStreamGameId
    });

    scheduleRecapAt(nextRecapAt);
    markActiveStateDirty();
    await persistActiveState({ force: true });
    console.log(`[Recap] Resumed by ${displayName}. Next recap in ${formatCountdown(resumeDelay)}.`);

    if (announce) {
      await client.say(channel, `@${displayName}, automatic hourly recaps resumed where they left off. Next recap in ${formatCountdown(resumeDelay)}.`);
    }

    return { success: true, message: `Automatic hourly recaps resumed. Next recap in ${formatCountdown(resumeDelay)}.` };
  }

  function recordTwitchEvent(event) {
    if (!streamLive || recapPaused) return;
    const text = String(event?.text || '').trim();
    if (!text) return;

    eventSequence++;
    twitchEvents.push({
      id: eventSequence,
      timestamp: event?.timestamp || Date.now(),
      type: String(event?.type || 'twitch_event'),
      text
    });

    markActiveStateDirty();
    console.log(`[Recap] Verified Twitch event recorded: ${text}`);
  }

  function recordChatMessage({ displayName, rawMessage }) {
    if (!streamLive || recapPaused) return;
    const text = (rawMessage || '').trim();
    if (!text) return;

    messageSequence++;
    recapMessages.push({
      id: messageSequence,
      timestamp: Date.now(),
      text: `${displayName}: ${text}`
    });
    markActiveStateDirty();
  }

  function recordModeratorAnnouncement({ displayName, rawMessage, color = '' }) {
    if (!streamLive || recapPaused) return;
    const text = String(rawMessage || '').trim();
    if (!text) return;

    const moderator = String(displayName || 'moderator').trim() || 'moderator';
    const announcementColor = String(color || '').trim();
    const colorLabel = announcementColor ? ` (${announcementColor})` : '';

    messageSequence++;
    recapMessages.push({
      id: messageSequence,
      timestamp: Date.now(),
      text: `[MODERATOR ANNOUNCEMENT${colorLabel} by ${moderator}]: ${text}`
    });

    markActiveStateDirty();
    console.log(`[Recap] Moderator announcement recorded from ${moderator}: ${text}`);
  }

  function discardMessageSnapshot(snapshotMaxId) {
    if (snapshotMaxId === null) return;
    recapMessages = recapMessages.filter((item) => item.id > snapshotMaxId);
    markActiveStateDirty();
  }

  function discardEventSnapshot(snapshotMaxEventId) {
    if (snapshotMaxEventId === null) return;
    twitchEvents = twitchEvents.filter((item) => item.id > snapshotMaxEventId);
    markActiveStateDirty();
  }

  function discardContextSnapshot(snapshotMaxContextId) {
    if (snapshotMaxContextId === null) return;
    streamContexts = streamContexts.filter((item) => item.id > snapshotMaxContextId);
    markActiveStateDirty();

    if (streamContexts.length === 0 && streamLive) {
      addStreamContext({
        title: currentStreamTitle,
        category: currentStreamCategory,
        gameId: currentStreamGameId
      });
    }
  }

  async function sendAutomaticRecap(reason) {
    if (!streamLive || recapPaused || recapInProgress) return;

    recapInProgress = true;
    clearRecapTimer();

    const messageSnapshot = [...recapMessages];
    const contextSnapshot = [...streamContexts];
    const eventSnapshot = [...twitchEvents];
    const snapshotMaxId = messageSnapshot.length ? messageSnapshot[messageSnapshot.length - 1].id : null;
    const snapshotMaxContextId = contextSnapshot.length ? contextSnapshot[contextSnapshot.length - 1].id : null;
    const snapshotMaxEventId = eventSnapshot.length ? eventSnapshot[eventSnapshot.length - 1].id : null;
    const chatLogs = messageSnapshot.map((item) => item.text);

    console.log(`[Recap] Automatic recap triggered by ${reason}.`);
    console.log(`[Recap] Window contains ${chatLogs.length} chat messages and ${eventSnapshot.length} verified Twitch event(s).`);

    try {
      let twitchMessage;
      let recapSummaryBody;
      let previousRecaps = [];
      let streamLore = '';

      if (currentStreamId) {
        try {
          previousRecaps = await getRecentStreamRecaps({ streamId: currentStreamId, limit: 5 });
          console.log(`[Recap] Loaded ${previousRecaps.length} previous hourly recap(s) from this stream for continuity context.`);
        } catch (historyErr) {
          console.error('[Recap] Could not load previous stream recap context. Continuing without it:', historyErr.message || historyErr);
        }
      }

      try {
        const loreRecord = await getStreamLore(channelName);
        streamLore = String(loreRecord?.text || '');
        if (streamLore) console.log(`[Recap] Loaded ${streamLore.length} characters of stream-specific lore from MongoDB.`);
      } catch (loreErr) {
        console.error('[Recap] Could not load stream-specific lore. Continuing without it:', loreErr.message || loreErr);
      }

      if (chatLogs.length === 0 && eventSnapshot.length === 0) {
        recapSummaryBody = 'Chat was quiet this hour—nothing notable to recap.';
        twitchMessage = SUMMARY_PREFIX + recapSummaryBody;
      } else {
        const generatedAtMs = Date.now();
        const streamTiming = {
          startedAtMs: twitchStreamStartedAt || 0,
          generatedAtMs,
          uptimeMs: twitchStreamStartedAt ? Math.max(0, generatedAtMs - twitchStreamStartedAt) : null
        };
        const result = await generateRecap(chatLogs, contextSnapshot, eventSnapshot, previousRecaps, streamLore, streamTiming, channelName);
        recapSummaryBody = result.summary;
        twitchMessage = SUMMARY_PREFIX + recapSummaryBody;
      }

      if (!streamLive) {
        console.log('[Recap] Stream ended during recap generation. Recap was not sent.');
        recapInProgress = false;
        return;
      }

      await client.say(channelName, twitchMessage, { temporaryPin: true });
      console.log('[Recap] Sent:', twitchMessage);
      console.log(`[Recap] Length: ${twitchMessage.length}/500`);

      if (currentStreamId && recapSummaryBody) {
        try {
          await saveStreamRecap({
            streamId: currentStreamId,
            channelName,
            startedAt: streamSessionStartedAt || null,
            text: recapSummaryBody
          });
          console.log('[Recap] Stored this hourly recap in MongoDB for same-stream continuity context.');
        } catch (historyErr) {
          console.error('[Recap] Recap sent successfully, but MongoDB history storage failed:', historyErr.message || historyErr);
        }
      }

      discardMessageSnapshot(snapshotMaxId);
      discardContextSnapshot(snapshotMaxContextId);
      discardEventSnapshot(snapshotMaxEventId);
      firstRecapSent = true;
      recapInProgress = false;
      nextRecapAt = Date.now() + RECURRING_RECAP_DELAY;
      scheduleRecapAt(nextRecapAt);
      markActiveStateDirty();
      await persistActiveState({ force: true });
      console.log('[Recap] Next automatic recap scheduled in 60 minutes.');
    } catch (err) {
      console.error('[Recap] Automatic recap failed:', err);

      if (err.inputBlocked) {
        recapInProgress = false;
        discardMessageSnapshot(snapshotMaxId);
        discardContextSnapshot(snapshotMaxContextId);
        discardEventSnapshot(snapshotMaxEventId);
        firstRecapSent = true;

        if (streamLive) {
          try {
            await client.say(channelName, "The hourly recap was blocked due to sensitive terms found in chat. I'll try again in 60 minutes. Y'all may have gone a little too hard for the robot. LUL");
          } catch (sendErr) {
            console.error('[Recap] Failed to send blocked-recap notice:', sendErr);
          }

          nextRecapAt = Date.now() + RECURRING_RECAP_DELAY;
          scheduleRecapAt(nextRecapAt);
          markActiveStateDirty();
          await persistActiveState({ force: true });
        }
        return;
      }

      recapInProgress = false;
      nextRecapAt = Date.now() + RECAP_FAILURE_RETRY_DELAY;
      scheduleRecapAt(nextRecapAt);
      markActiveStateDirty();
      await persistActiveState({ force: true });
      console.log('[Recap] Retrying automatic recap in 5 minutes.');
    }
  }

  async function handleRecapCommand({ channel, displayName }) {
    const now = Date.now();
    const elapsed = now - lastRecapCommandUse;

    if (lastRecapCommandUse > 0 && elapsed < RECAP_COMMAND_COOLDOWN) {
      await client.say(channel, `@${displayName}, !recap is on cooldown! Try again in ${formatCountdown(RECAP_COMMAND_COOLDOWN - elapsed)}.`);
      return;
    }

    lastRecapCommandUse = now;

    try {
      if (!streamLive) {
        await client.say(channel, `@${displayName}, hourly recaps will start when Qwert goes live.`);
        return;
      }

      if (recapPaused) {
        await client.say(channel, `@${displayName}, automatic hourly recaps are currently paused by a moderator.`);
        return;
      }

      if (recapInProgress) {
        await client.say(channel, `@${displayName}, the next hourly recap is being generated now.`);
        return;
      }

      const remaining = nextRecapAt ? formatCountdown(nextRecapAt - Date.now()) : 'a moment';
      await client.say(channel, `@${displayName}, the next hourly recap will be sent in ${remaining}.`);
    } catch (err) {
      console.error('[Recap] Failed to answer !recap:', err);
    }
  }

  function getStatus() {
    return {
      streamStateInitialized,
      streamLive,
      currentStreamId: currentStreamId || null,
      currentStreamTitle: currentStreamTitle || null,
      currentStreamCategory: currentStreamCategory || null,
      currentStreamGameId: currentStreamGameId || null,
      currentViewerCount,
      recapPaused,
      loggingMessages: streamStateInitialized && streamLive && !recapPaused,
      recapInProgress,
      firstRecapSent,
      messagesInWindow: recapMessages.length,
      twitchEventsInWindow: twitchEvents.length,
      contextChangesInWindow: streamContexts.length,
      nextRecapAt: recapPaused ? null : nextRecapAt || null,
      pausedRemainingMs: recapPaused ? pausedRemainingMs : null,
      streamSessionStartedAt: streamSessionStartedAt || null,
      twitchStreamStartedAt: twitchStreamStartedAt || null,
      streamUptimeMs: streamLive && twitchStreamStartedAt ? Math.max(0, Date.now() - twitchStreamStartedAt) : null
    };
  }

  function getCurrentWindowLogs() {
    return recapMessages.map((item) => item.text);
  }

  function getCurrentWindowEvents() {
    return twitchEvents.map((item) => ({ type: item.type, text: item.text, timestamp: item.timestamp }));
  }

  function getCurrentWindowContexts() {
    return streamContexts.map((item) => ({
      title: item.title,
      category: item.category,
      gameId: item.gameId
    }));
  }

  async function getCurrentStreamRecapHistory(limit = 5) {
    if (!currentStreamId) return [];
    return getRecentStreamRecaps({ streamId: currentStreamId, limit });
  }

  async function start() {
    if (!channelName) {
      console.error('[Recap] Cannot start automatic recaps: TWITCH_CHANNEL is missing.');
      return;
    }

    try {
      await validateStoredToken();
    } catch (err) {
      console.error('[OAuth Bot] Initial recap stream-status bot token validation failed:', err.message || err);
      return;
    }

    await checkStreamStatus();

    streamPollTimer = setInterval(checkStreamStatus, STREAM_STATUS_POLL_INTERVAL);
    if (!activeStateCheckpointTimer) {
      activeStateCheckpointTimer = setInterval(() => { void persistActiveState(); }, ACTIVE_STATE_CHECKPOINT_INTERVAL);
    }

    tokenValidationTimer = setInterval(() => {
      validateStoredToken().catch((err) => {
        console.error('[OAuth Bot] Recap stream-status bot token validation failed:', err.message || err);
      });
    }, TOKEN_VALIDATION_INTERVAL);

    console.log('[Recap] Automatic stream detection enabled.');
    console.log('[Recap] Twitch stream status/title/category will be checked every 30 seconds.');
    console.log('[Recap] Automatic recap cadence: every 60 minutes.');
    console.log('[Recap Persistence] Active recap window checkpoints every 30 seconds while changed.');
  }

  return {
    start,
    recordChatMessage,
    recordModeratorAnnouncement,
    recordTwitchEvent,
    handleRecapCommand,
    stopRecap,
    startRecap,
    getCurrentWindowLogs,
    getCurrentWindowContexts,
    getCurrentWindowEvents,
    getCurrentStreamRecapHistory,
    getStatus
  };
}


module.exports = { createRecapManager };
