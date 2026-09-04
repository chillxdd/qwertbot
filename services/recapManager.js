const {
  getRecentStreamRecaps,
  saveStreamRecap,
  getSessionMemoryBlocks,
  saveSessionMemoryBlock,
  clearSessionMemory,
  getActiveRecapState,
  saveActiveRecapState,
  clearStreamRecapsByChannel
} = require('./streamRecapHistory');
const { getStreamLore, applyStreamLoreObservations, buildEffectiveLore } = require('./streamLore');
const { generateRecap, SUMMARY_PREFIX, sanitizeChatForGemini } = require('./recapGenerator');
const { generateSessionMemoryBlock, generateViewerLearningUpdates, generateStreamLoreObservations, buildSessionMemoryContext, normalizeSessionMemoryConfig } = require('./sessionMemory');
const { getViewerProfileSettings, getViewerLearningContext, applyViewerProfileUpdates } = require('./viewerProfiles');
const { getStreamLifecycleState, saveStreamLifecycleState } = require('./streamLifecycle');
const {
  identityFromTwitchTags,
  normalizeIdentity,
  normalizeSharedChatOrigin,
  sharedChatOriginFromTwitchTags,
  sharedChatOriginFromRecord,
  isSharedChatGuest,
  canonicalChatMessageId,
  normalizeChatRecord,
  normalizeChatRecords,
  renderChatRecord,
  normalizeEventRecord,
  normalizeEventRecords,
  renderEventRecord
} = require('./sourceRecords');

const FIRST_RECAP_DELAY = 60 * 60 * 1000;
const RECURRING_RECAP_DELAY = 60 * 60 * 1000;
const RECAP_FAILURE_RETRY_DELAY = 5 * 60 * 1000;
const RECAP_COMMAND_COOLDOWN = 5 * 60 * 1000;
const STREAM_STATUS_POLL_INTERVAL = 30 * 1000;
const TOKEN_VALIDATION_INTERVAL = 60 * 60 * 1000;
const ACTIVE_STATE_CHECKPOINT_INTERVAL = 30 * 1000;

function sourceTimestamp(value, fallback = Date.now()) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isNaN(parsed) ? fallback : parsed;
}

function toStoredChatRecord(value, defaults = {}) {
  const record = normalizeChatRecord(value, defaults);
  return {
    ...record,
    body: record.text,
    // Preserve the legacy rendered field for existing Mongo documents/UI code.
    text: renderChatRecord(record, { includeBotMarker: false })
  };
}

function toStoredEventRecord(value, defaults = {}) {
  return normalizeEventRecord(value, defaults);
}

function replyReferenceFromInput(replyTo = null, tags = {}) {
  if (replyTo && typeof replyTo === 'object') return replyTo;
  const messageId = String(tags?.['reply-parent-msg-id'] || '').trim();
  const text = String(tags?.['reply-parent-msg-body'] || '').trim();
  const author = normalizeIdentity({
    userId: tags?.['reply-parent-user-id'] || '',
    login: tags?.['reply-parent-user-login'] || '',
    displayName: tags?.['reply-parent-display-name'] || tags?.['reply-parent-user-login'] || '',
    role: 'viewer'
  });
  if (!messageId && !text && !author.login && !author.displayName) return null;
  return { messageId, text, author };
}

function formatCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}min ${seconds}s` : `${seconds}s`;
}

function nextAnchoredRecapAt(streamSessionStartedAt, afterMs = Date.now()) {
  const anchor = Number(streamSessionStartedAt || 0);
  if (!anchor) return Number(afterMs || Date.now()) + RECURRING_RECAP_DELAY;

  const after = Number(afterMs || Date.now());
  const firstDue = anchor + FIRST_RECAP_DELAY;
  if (after < firstDue) return firstDue;

  const completedIntervals = Math.floor((after - anchor) / RECURRING_RECAP_DELAY);
  return anchor + ((completedIntervals + 1) * RECURRING_RECAP_DELAY);
}

function createRecapManager({
  client,
  channelName,
  getTwitchAccessToken,
  refreshTwitchAccessToken,
  validateTwitchAccessToken,
  getSessionMemoryConfig,
  getEventReactionHoldStatus = null,
  getTaggedQuestionRecapBufferStatus = null,
  getAutomationSpacingStatus = null,
  tryReserveAutomationSlot = null,
  getNativeCommandResponse = null,
  botUsername = ''
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
  let lastStreamStartedAt = 0;
  let lastStreamEndedAt = 0;
  let lastStreamLifecycleEventType = '';
  let lastStreamLifecycleEventAt = 0;

  async function nativeResponse(command, variant, variables, fallback) {
    if (typeof getNativeCommandResponse === 'function') {
      try {
        const rendered = await getNativeCommandResponse(command, variant, variables || {});
        if (rendered) return rendered;
      } catch (err) {
        console.error(`[Native Commands] Could not render ${command}.${variant}:`, err?.message || err);
      }
    }
    return fallback;
  }
  async function loadStreamLifecycleMemory() {
    try {
      const saved = await getStreamLifecycleState(channelName);
      if (!saved) return;
      lastStreamStartedAt = saved.lastStreamStartedAt ? new Date(saved.lastStreamStartedAt).getTime() : 0;
      lastStreamEndedAt = saved.lastStreamEndedAt ? new Date(saved.lastStreamEndedAt).getTime() : 0;
      lastStreamLifecycleEventType = String(saved.lastLifecycleEventType || '');
      lastStreamLifecycleEventAt = saved.lastLifecycleEventAt ? new Date(saved.lastLifecycleEventAt).getTime() : 0;
      if (lastStreamEndedAt) {
        console.log(`[Stream Lifecycle] Restored last stream end: ${new Date(lastStreamEndedAt).toISOString()}.`);
      }
    } catch (err) {
      console.error('[Stream Lifecycle] Could not restore persisted stream lifecycle state:', err?.message || err);
    }
  }

  async function persistStreamLifecycle(patch = {}) {
    try {
      await saveStreamLifecycleState(channelName, patch);
    } catch (err) {
      console.error('[Stream Lifecycle] Could not persist stream lifecycle state:', err?.message || err);
    }
  }

  function recentOfflineLifecycleTimestamp(now = Date.now()) {
    if (lastStreamLifecycleEventType !== 'offline' || !lastStreamLifecycleEventAt) return 0;
    return now - lastStreamLifecycleEventAt <= 5 * 60 * 1000 ? lastStreamLifecycleEventAt : 0;
  }

  let activeStateSavePromise = null;
  let lastRecapCommandUse = 0;


  function eventReactionHold() {
    try {
      return typeof getEventReactionHoldStatus === 'function'
        ? (getEventReactionHoldStatus() || { active: false })
        : { active: false };
    } catch (_) {
      return { active: false };
    }
  }

  function deferForEventReaction(reason = 'EventSub reaction hold') {
    const hold = eventReactionHold();
    if (!hold.active) return false;
    const resumeAt = hold.holdUntil && hold.holdUntil > Date.now()
      ? hold.holdUntil + 1000
      : Date.now() + 1000;
    recapInProgress = false;
    scheduleRecapAt(resumeAt);
    console.log(`[Recap] Deferred by ${reason}; retrying after EventSub activity settles.`);
    return true;
  }



  function taggedQuestionRecapBuffer() {
    try {
      return typeof getTaggedQuestionRecapBufferStatus === 'function'
        ? (getTaggedQuestionRecapBufferStatus() || { active: false })
        : { active: false };
    } catch (_) {
      return { active: false };
    }
  }

  function deferForTaggedQuestionBuffer(reason = 'Tagged Question collision buffer') {
    const status = taggedQuestionRecapBuffer();
    if (!status.active) return false;
    const resumeAt = status.availableAt && status.availableAt > Date.now()
      ? status.availableAt + 250
      : Date.now() + Math.max(1000, Number(status.remainingMs || 0));
    recapInProgress = false;
    scheduleRecapAt(resumeAt);
    const suffix = status.inFlight ? 'while a Tagged Question is still being answered' : `for ${status.bufferSeconds || 0}s after the Tagged Question reply`;
    console.log(`[Recap] Deferred by ${reason} ${suffix}. Tagged Questions remain immediate.`);
    return true;
  }


  function automationSpacing() {
    try {
      return typeof getAutomationSpacingStatus === 'function'
        ? (getAutomationSpacingStatus('recap') || { active: false })
        : { active: false };
    } catch (_) {
      return { active: false };
    }
  }

  function deferForAutomationSpacing(reason = 'automation spacing') {
    const spacing = automationSpacing();
    if (!spacing.active) return false;
    const resumeAt = spacing.availableAt && spacing.availableAt > Date.now()
      ? spacing.availableAt + 1000
      : Date.now() + Math.max(1000, Number(spacing.remainingMs || 0));
    recapInProgress = false;
    scheduleRecapAt(resumeAt);
    console.log(`[Recap] Deferred by ${reason}; retrying after automated-message spacing clears.`);
    return true;
  }

  async function reserveAutomationSlot() {
    try {
      return typeof tryReserveAutomationSlot === 'function'
        ? await tryReserveAutomationSlot('recap')
        : { allowed: true, status: { active: false } };
    } catch (_) {
      return { allowed: true, status: { active: false } };
    }
  }

  function readSessionMemoryConfig() {
    try {
      return normalizeSessionMemoryConfig(typeof getSessionMemoryConfig === 'function' ? getSessionMemoryConfig() : {});
    } catch (err) {
      console.error('[Session Memory] Could not read settings; using defaults:', err?.message || err);
      return normalizeSessionMemoryConfig();
    }
  }

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
      recapMessages: recapMessages.map((item) => toStoredChatRecord(item)),
      messageSequence,
      streamContexts,
      contextSequence,
      twitchEvents: twitchEvents.map((item) => toStoredEventRecord(item)),
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

      recapMessages = normalizeChatRecords(saved.recapMessages || []).map((item) => toStoredChatRecord(item));
      messageSequence = Math.max(Number(saved.messageSequence || 0), recapMessages.at(-1)?.id || 0);
      streamContexts = Array.isArray(saved.streamContexts) ? saved.streamContexts : [];
      contextSequence = Math.max(Number(saved.contextSequence || 0), streamContexts.at(-1)?.id || 0);
      twitchEvents = normalizeEventRecords(saved.twitchEvents || []).map((item) => toStoredEventRecord(item));
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

    lastStreamStartedAt = twitchStreamStartedAt;
    lastStreamLifecycleEventType = 'online';
    lastStreamLifecycleEventAt = Date.now();
    await persistStreamLifecycle({
      lastStreamStartedAt,
      lastKnownStreamId: currentStreamId,
      lastLifecycleEventType: 'online',
      lastLifecycleEventAt: lastStreamLifecycleEventAt
    });

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

  async function endStreamSession(endedAtMs = 0) {
    const now = Date.now();
    const resolvedEndedAt = Number(endedAtMs) || recentOfflineLifecycleTimestamp(now) || now;
    lastStreamEndedAt = resolvedEndedAt;
    lastStreamLifecycleEventType = 'offline';
    lastStreamLifecycleEventAt = resolvedEndedAt;
    clearRecapTimer();
    streamLive = false;
    const lifecycleSavePromise = persistStreamLifecycle({
      lastStreamEndedAt,
      lastLifecycleEventType: 'offline',
      lastLifecycleEventAt: resolvedEndedAt
    });
    if (activeStateSavePromise) {
      try { await activeStateSavePromise; } catch {}
    }
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
    await lifecycleSavePromise;
    console.log('[Recap] Qwert is OFFLINE. Automatic recap session stopped and recap history cleared.');
  }

  async function noteStreamLifecycleEvent({ type, event = {}, timestamp = Date.now() } = {}) {
    const normalizedType = String(type || '').trim();
    const receivedAt = Number(timestamp) || Date.now();

    if (normalizedType === 'stream.offline') {
      lastStreamEndedAt = receivedAt;
      lastStreamLifecycleEventType = 'offline';
      lastStreamLifecycleEventAt = receivedAt;
      console.log(`[Stream Lifecycle] EventSub recorded stream end at ${new Date(receivedAt).toISOString()}.`);
      if (streamStateInitialized && streamLive) {
        await endStreamSession(receivedAt);
      } else {
        await persistStreamLifecycle({
          lastStreamEndedAt,
          lastLifecycleEventType: 'offline',
          lastLifecycleEventAt: receivedAt
        });
      }
      return;
    }

    if (normalizedType === 'stream.online') {
      const parsedStartedAt = Date.parse(event?.started_at || '');
      const startedAt = Number.isNaN(parsedStartedAt) ? receivedAt : parsedStartedAt;
      lastStreamStartedAt = startedAt;
      lastStreamLifecycleEventType = 'online';
      lastStreamLifecycleEventAt = receivedAt;
      await persistStreamLifecycle({
        lastStreamStartedAt,
        lastKnownStreamId: String(event?.id || '').trim(),
        lastLifecycleEventType: 'online',
        lastLifecycleEventAt: receivedAt
      });
      console.log(`[Stream Lifecycle] EventSub recorded stream start at ${new Date(startedAt).toISOString()}.`);
      if (streamStateInitialized && !streamLive) await checkStreamStatus();
    }
  }

  async function checkStreamStatus() {
    try {
      const status = await fetchStreamStatus();

      if (!streamStateInitialized) {
        streamStateInitialized = true;
        if (status.live) await startStreamSession(status, true);
        else {
          streamLive = false;
          if (lastStreamStartedAt && (!lastStreamEndedAt || lastStreamStartedAt > lastStreamEndedAt)) {
            // The bot restarted after a stream that began while we were online, but
            // no trustworthy offline timestamp survived. Do not present an older
            // stream's end time as though it were the most recent one.
            lastStreamEndedAt = 0;
            void persistStreamLifecycle({ lastStreamEndedAt: null });
            console.warn('[Stream Lifecycle] Current status is offline, but the most recent stream start is newer than the stored end time. Exact last-stream end is unknown (likely missed during downtime).');
          }
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
      if (announce) await client.say(channel, await nativeResponse('stoprecap', 'offline', { user: displayName }, `@${displayName}, Qwert is offline, so the recap system is already inactive.`));
      return { success: false, message: 'Qwert is offline.' };
    }

    if (recapPaused) {
      if (announce) await client.say(channel, await nativeResponse('stoprecap', 'alreadyPaused', { user: displayName }, `@${displayName}, automatic hourly recaps are already paused.`));
      return { success: false, message: 'Automatic hourly recaps are already paused.' };
    }

    if (recapInProgress) {
      if (announce) await client.say(channel, await nativeResponse('stoprecap', 'generating', { user: displayName }, `@${displayName}, an hourly recap is already being generated, so it can't be paused right now.`));
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
      await client.say(channel, await nativeResponse('stoprecap', 'success', { user: displayName, messages: recapMessages.length, remaining: formatCountdown(pausedRemainingMs) }, `@${displayName}, automatic hourly recaps are paused. ${recapMessages.length} messages are preserved and the timer is frozen with ${formatCountdown(pausedRemainingMs)} remaining.`));
    }

    return { success: true, message: `Automatic hourly recaps paused with ${formatCountdown(pausedRemainingMs)} remaining.` };
  }

  async function startRecap({ channel, displayName = 'MOD', announce = true }) {
    if (!streamLive) {
      if (announce) await client.say(channel, await nativeResponse('startrecap', 'offline', { user: displayName }, `@${displayName}, Qwert is offline. Hourly recaps will start fresh when the next stream begins.`));
      return { success: false, message: 'Qwert is offline.' };
    }

    if (!recapPaused) {
      if (announce) await client.say(channel, await nativeResponse('startrecap', 'alreadyRunning', { user: displayName }, `@${displayName}, automatic hourly recaps are already running.`));
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
      await client.say(channel, await nativeResponse('startrecap', 'success', { user: displayName, remaining: formatCountdown(resumeDelay) }, `@${displayName}, automatic hourly recaps resumed where they left off. Next recap in ${formatCountdown(resumeDelay)}.`));
    }

    return { success: true, message: `Automatic hourly recaps resumed. Next recap in ${formatCountdown(resumeDelay)}.` };
  }

  function recordTwitchEvent(event) {
    if (!streamLive || recapPaused) return false;
    const normalized = normalizeEventRecord(event);
    if (!normalized.text) return false;

    if (normalized.sourceEventId && twitchEvents.some((item) => String(item?.sourceEventId || '') === normalized.sourceEventId)) {
      return false;
    }

    eventSequence++;
    twitchEvents.push(toStoredEventRecord({
      ...normalized,
      id: eventSequence,
      timestamp: sourceTimestamp(normalized.timestamp)
    }));

    markActiveStateDirty();
    console.log(`[Recap] Verified Twitch event recorded: ${normalized.text}`);
    return true;
  }

  function recordChatMessage({
    displayName,
    rawMessage,
    tags = {},
    author = null,
    twitchMessageId = '',
    sourceMessageId = '',
    timestamp = 0,
    replyTo = null,
    sharedChat = null,
    metadata = {}
  } = {}) {
    if (!streamLive || recapPaused) return false;
    const body = String(rawMessage || '').trim();
    if (!body) return false;
    const messageId = String(twitchMessageId || tags?.id || tags?.['message-id'] || '').trim();
    const origin = normalizeSharedChatOrigin(
      sharedChat || metadata?.sharedChat || sharedChatOriginFromTwitchTags(tags)
    );
    const canonicalSourceId = String(sourceMessageId || origin.sourceMessageId || '').trim();
    const dedupeId = canonicalSourceId || messageId;
    if (dedupeId && recapMessages.some((item, index) => canonicalChatMessageId(item, index) === dedupeId)) return false;

    messageSequence++;
    const identity = normalizeIdentity(author || identityFromTwitchTags(tags, displayName), {
      displayName,
      login: tags?.username || '',
      userId: tags?.['user-id'] || '',
      role: 'viewer'
    });
    recapMessages.push(toStoredChatRecord({
      id: messageSequence,
      twitchMessageId: messageId,
      sourceMessageId: canonicalSourceId,
      timestamp: sourceTimestamp(timestamp || tags?.['tmi-sent-ts']),
      kind: 'viewer',
      author: identity,
      body,
      replyTo: replyReferenceFromInput(replyTo, tags),
      sharedChat: origin,
      metadata
    }));
    markActiveStateDirty();
    return true;
  }

  function recordBotContextMessage({
    displayName,
    rawMessage,
    author = null,
    twitchMessageId = '',
    timestamp = 0,
    replyTo = null,
    metadata = {}
  } = {}) {
    if (!streamLive || recapPaused) return false;
    const body = String(rawMessage || '').trim();
    if (!body) return false;
    const messageId = String(twitchMessageId || '').trim();
    if (messageId && recapMessages.some((item) => String(item?.twitchMessageId || '') === messageId)) return false;

    const botName = String(displayName || botUsername || 'SqwertArmyBot').trim() || 'SqwertArmyBot';
    messageSequence++;
    recapMessages.push(toStoredChatRecord({
      id: messageSequence,
      twitchMessageId: messageId,
      timestamp: sourceTimestamp(timestamp),
      kind: 'bot_context',
      author: normalizeIdentity(author || { login: botUsername, displayName: botName, role: 'bot' }),
      body,
      replyTo,
      metadata
    }));
    markActiveStateDirty();
    return true;
  }

  function recordModeratorAnnouncement({
    displayName,
    rawMessage,
    color = '',
    tags = {},
    author = null,
    twitchMessageId = '',
    sourceMessageId = '',
    timestamp = 0,
    sharedChat = null,
    metadata = {}
  } = {}) {
    if (!streamLive || recapPaused) return false;
    const body = String(rawMessage || '').trim();
    if (!body) return false;
    const messageId = String(twitchMessageId || tags?.id || tags?.['message-id'] || '').trim();
    const origin = normalizeSharedChatOrigin(
      sharedChat || metadata?.sharedChat || sharedChatOriginFromTwitchTags(tags)
    );
    const canonicalSourceId = String(sourceMessageId || origin.sourceMessageId || '').trim();
    const dedupeId = canonicalSourceId || messageId;
    if (dedupeId && recapMessages.some((item, index) => canonicalChatMessageId(item, index) === dedupeId)) return false;

    const moderator = String(displayName || 'moderator').trim() || 'moderator';
    messageSequence++;
    recapMessages.push(toStoredChatRecord({
      id: messageSequence,
      twitchMessageId: messageId,
      sourceMessageId: canonicalSourceId,
      timestamp: sourceTimestamp(timestamp || tags?.['tmi-sent-ts']),
      kind: 'moderator_announcement',
      author: normalizeIdentity(author || identityFromTwitchTags(tags, moderator), { displayName: moderator, role: 'moderator' }),
      body,
      sharedChat: origin,
      metadata: { ...metadata, color: String(color || '').trim() }
    }));

    markActiveStateDirty();
    console.log(`[Recap] ${origin.isGuest ? 'Shared Chat guest announcement' : 'Moderator announcement'} recorded from ${moderator}: ${body}`);
    return true;
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
    if (deferForEventReaction()) return;
    if (deferForTaggedQuestionBuffer()) return;
    if (deferForAutomationSpacing()) return;

    recapInProgress = true;
    clearRecapTimer();

    const messageSnapshot = [...recapMessages];
    const contextSnapshot = [...streamContexts];
    const eventSnapshot = [...twitchEvents];
    const snapshotMaxId = messageSnapshot.length ? messageSnapshot[messageSnapshot.length - 1].id : null;
    const snapshotMaxContextId = contextSnapshot.length ? contextSnapshot[contextSnapshot.length - 1].id : null;
    const snapshotMaxEventId = eventSnapshot.length ? eventSnapshot[eventSnapshot.length - 1].id : null;
    const chatRecords = normalizeChatRecords(messageSnapshot);
    const sessionMemoryChatRecords = chatRecords.filter((item) => item.kind !== 'bot_context');
    const permanentLearningChatRecords = sessionMemoryChatRecords.filter((item) => !isSharedChatGuest(item));
    const sharedChatGuestCount = sessionMemoryChatRecords.length - permanentLearningChatRecords.length;

    console.log(`[Recap] Automatic recap triggered by ${reason}.`);
    console.log(`[Recap] Window contains ${chatRecords.length} chat messages (${sharedChatGuestCount} Shared Chat guest-origin) and ${eventSnapshot.length} verified Twitch event(s).`);

    try {
      let twitchMessage;
      let recapSummaryBody;
      let previousRecaps = [];
      let streamLore = '';
      let streamLoreRecord = null;

      if (currentStreamId) {
        try {
          previousRecaps = await getRecentStreamRecaps({ streamId: currentStreamId, limit: 5 });
          console.log(`[Recap] Loaded ${previousRecaps.length} previous hourly recap(s) from this stream for continuity context.`);
        } catch (historyErr) {
          console.error('[Recap] Could not load previous stream recap context. Continuing without it:', historyErr.message || historyErr);
        }
      }

      try {
        streamLoreRecord = await getStreamLore(channelName);
        // Guest messages can mention legitimate GeneralQwert lore subjects, so
        // their message BODY remains useful for matching. Their guest display
        // name/source community must not auto-bind a same-named GeneralQwert
        // subject simply because Twitch copied that speaker into the room.
        const loreMatchSource = [
          ...chatRecords.map((item) => isSharedChatGuest(item) ? String(item.text || '') : renderChatRecord(item)),
          ...eventSnapshot.map((event) => renderEventRecord(event))
        ].join('\n');
        const sharedChatLoreExclusions = [...new Set(chatRecords
          .filter((item) => isSharedChatGuest(item))
          .flatMap((item) => {
            const origin = sharedChatOriginFromRecord(item);
            return [
              ...(Array.isArray(item?.author?.aliases) ? item.author.aliases : []),
              item?.author?.displayName,
              item?.author?.login,
              origin.sourceBroadcasterDisplayName,
              origin.sourceBroadcasterLogin
            ];
          })
          .map((value) => String(value || '').trim())
          .filter(Boolean))];
        streamLore = buildEffectiveLore(
          streamLoreRecord?.manualEntries || [],
          streamLoreRecord?.learnedObservations || [],
          loreMatchSource,
          { includeGlobal: true, excludeSubjectAliases: sharedChatLoreExclusions }
        );
        if (streamLore) console.log(`[Recap] Loaded ${streamLore.length} characters of stream-specific lore from MongoDB.`);
      } catch (loreErr) {
        console.error('[Recap] Could not load stream-specific lore. Continuing without it:', loreErr.message || loreErr);
      }

      if (chatRecords.length === 0 && eventSnapshot.length === 0) {
        recapSummaryBody = 'Chat was quiet this hour—nothing notable to recap.';
        twitchMessage = SUMMARY_PREFIX + recapSummaryBody;
      } else {
        const generatedAtMs = Date.now();
        const streamTiming = {
          startedAtMs: twitchStreamStartedAt || 0,
          generatedAtMs,
          uptimeMs: twitchStreamStartedAt ? Math.max(0, generatedAtMs - twitchStreamStartedAt) : null
        };
        const result = await generateRecap(chatRecords, contextSnapshot, eventSnapshot, previousRecaps, streamLore, streamTiming, channelName, botUsername);
        recapSummaryBody = result.summary;
        twitchMessage = SUMMARY_PREFIX + recapSummaryBody;
      }

      if (!streamLive) {
        console.log('[Recap] Stream ended during recap generation. Recap was not sent.');
        recapInProgress = false;
        return;
      }

      if (deferForEventReaction('EventSub reaction started during recap generation')) return;
      if (deferForTaggedQuestionBuffer('Tagged Question activity during recap generation')) return;
      if (deferForAutomationSpacing('automation activity during recap generation')) return;
      const automationReservation = await reserveAutomationSlot();
      if (!automationReservation?.allowed) {
        const spacing = automationReservation?.status || automationSpacing();
        const resumeAt = spacing.availableAt && spacing.availableAt > Date.now() ? spacing.availableAt + 1000 : Date.now() + 1000;
        recapInProgress = false;
        scheduleRecapAt(resumeAt);
        console.log('[Recap] Deferred because another automation engine won the send slot.');
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

      if (currentStreamId) {
        const sessionMemoryConfig = readSessionMemoryConfig();
        let viewerProfileSettings = { automaticLearningEnabled: false };
        try {
          viewerProfileSettings = await getViewerProfileSettings(channelName);
        } catch (settingsErr) {
          console.error('[Viewer Profiles] Could not load viewer-profile settings for hourly learning:', settingsErr?.message || settingsErr);
        }
        if (sessionMemoryConfig.enabled || viewerProfileSettings.automaticLearningEnabled || currentStreamId) {
          const generatedAtMs = Date.now();
          const sourceTimes = [
            ...messageSnapshot.map((item) => Number(item?.timestamp || 0)),
            ...contextSnapshot.map((item) => Number(item?.timestamp || 0)),
            ...eventSnapshot.map((item) => Number(item?.timestamp || 0))
          ].filter((value) => value > 0);
          const windowStartedAtMs = sourceTimes.length ? Math.min(...sourceTimes) : Math.max(streamSessionStartedAt || 0, generatedAtMs - RECURRING_RECAP_DELAY);
          // Bot answers can help the public recap understand surrounding viewer conversation,
          // but they must not become self-learning evidence. Shared Chat guest messages remain
          // useful TEMPORARY same-stream context, while permanent Qwert Viewer Profiles and
          // Stream Lore only learn from messages originating in Qwert's own room.
          const memoryChatRecords = sanitizeChatForGemini(sessionMemoryChatRecords).records;
          const permanentLearningRecords = sanitizeChatForGemini(permanentLearningChatRecords).records;
          if (sharedChatGuestCount > 0) {
            console.log(`[Shared Chat] Kept ${sharedChatGuestCount} guest-origin message(s) in recap/session context and excluded them from permanent Viewer Profile and Stream Lore learning.`);
          }

          if (sessionMemoryConfig.enabled) {
            try {
              const memoryBlock = await generateSessionMemoryBlock({
                chatLogs: memoryChatRecords,
                streamContexts: contextSnapshot,
                twitchEvents: eventSnapshot,
                streamLore,
                publicRecap: recapSummaryBody,
                streamTiming: { windowStartedAtMs, generatedAtMs },
                config: sessionMemoryConfig,
                channelName
              });
              if (memoryBlock) {
                await saveSessionMemoryBlock({
                  streamId: currentStreamId,
                  channelName,
                  startedAt: streamSessionStartedAt || null,
                  block: memoryBlock
                });
                console.log(`[Session Memory] Stored hourly memory block (${memoryBlock.detailedSummary.length} detailed chars, ${memoryBlock.compactSummary.length} compact chars).`);
              }
            } catch (memoryErr) {
              console.error('[Session Memory] Hourly memory generation/storage failed. Public recap remains successful:', memoryErr?.message || memoryErr);
            }
          }

          if (viewerProfileSettings.automaticLearningEnabled) {
            try {
              const existingProfiles = await getViewerLearningContext(channelName, permanentLearningRecords);
              const viewerUpdates = await generateViewerLearningUpdates({ chatLogs: permanentLearningRecords, existingProfiles });
              if (viewerUpdates.length) {
                const profileResult = await applyViewerProfileUpdates({
                  channelName,
                  chatLogs: permanentLearningRecords,
                  updates: viewerUpdates
                });
                console.log(`[Viewer Profiles] Dedicated hourly learning processed ${viewerUpdates.length} viewer update(s): ${profileResult.created} new pending, ${profileResult.reinforced} reinforced, ${profileResult.refined} pending auto-refined, ${profileResult.revisionsProposed} approved revision proposal(s), ${profileResult.contradictions} contradiction update(s), ${profileResult.skipped} skipped.`);
              } else {
                console.log('[Viewer Profiles] Dedicated hourly learning found no durable viewer observations or updates.');
              }
            } catch (viewerErr) {
              console.error('[Viewer Profiles] Dedicated hourly learning failed. Session memory and public recap remain successful:', viewerErr?.message || viewerErr);
            }
          }

          try {
            const loreObservations = await generateStreamLoreObservations({
              chatLogs: permanentLearningRecords,
              existingObservations: streamLoreRecord?.learnedObservations || []
            });
            if (loreObservations.length) {
              const loreResult = await applyStreamLoreObservations(channelName, loreObservations);
              console.log(`[Stream Lore] Dedicated hourly learning processed ${loreObservations.length} candidate(s): ${loreResult.created} new pending, ${loreResult.reinforced} reinforced, ${loreResult.refined} pending auto-refined, ${loreResult.revisionsProposed} approved revision proposal(s), ${loreResult.contradictions} contradiction update(s), ${loreResult.skipped} skipped.`);
            } else {
              console.log('[Stream Lore] Dedicated hourly learning found no durable channel-lore candidates or updates.');
            }
          } catch (loreErr) {
            console.error('[Stream Lore] Dedicated hourly learning failed. Session memory and public recap remain successful:', loreErr?.message || loreErr);
          }
        }
      }

      discardMessageSnapshot(snapshotMaxId);
      discardContextSnapshot(snapshotMaxContextId);
      discardEventSnapshot(snapshotMaxEventId);
      firstRecapSent = true;
      recapInProgress = false;
      nextRecapAt = nextAnchoredRecapAt(streamSessionStartedAt, Date.now());
      scheduleRecapAt(nextRecapAt);
      markActiveStateDirty();
      await persistActiveState({ force: true });
      console.log(`[Recap] Next automatic recap remains on the anchored hourly cadence at ${new Date(nextRecapAt).toISOString()}.`);
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

          nextRecapAt = nextAnchoredRecapAt(streamSessionStartedAt, Date.now());
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
      await client.say(channel, await nativeResponse('recap', 'cooldown', { user: displayName, remaining: formatCountdown(RECAP_COMMAND_COOLDOWN - elapsed) }, `@${displayName}, !recap is on cooldown! Try again in ${formatCountdown(RECAP_COMMAND_COOLDOWN - elapsed)}.`));
      return;
    }

    lastRecapCommandUse = now;

    try {
      if (!streamLive) {
        await client.say(channel, await nativeResponse('recap', 'offline', { user: displayName }, `@${displayName}, hourly recaps will start when Qwert goes live.`));
        return;
      }

      if (recapPaused) {
        await client.say(channel, await nativeResponse('recap', 'paused', { user: displayName }, `@${displayName}, automatic hourly recaps are currently paused by a moderator.`));
        return;
      }

      if (recapInProgress) {
        await client.say(channel, await nativeResponse('recap', 'generating', { user: displayName }, `@${displayName}, the next hourly recap is being generated now.`));
        return;
      }

      const remaining = nextRecapAt ? formatCountdown(nextRecapAt - Date.now()) : 'a moment';
      await client.say(channel, await nativeResponse('recap', 'eta', { user: displayName, remaining }, `@${displayName}, the next hourly recap will be sent in ${remaining}.`));
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
      streamUptimeMs: streamLive && twitchStreamStartedAt ? Math.max(0, Date.now() - twitchStreamStartedAt) : null,
      lastStreamStartedAt: lastStreamStartedAt || null,
      lastStreamEndedAt: lastStreamEndedAt || null,
      lastStreamEndedAgoMs: !streamLive && lastStreamEndedAt ? Math.max(0, Date.now() - lastStreamEndedAt) : null,
      streamTimezone: 'America/Los_Angeles',
      lastStreamLifecycleEventType: lastStreamLifecycleEventType || null,
      lastStreamLifecycleEventAt: lastStreamLifecycleEventAt || null
    };
  }

  function getCurrentWindowLogs({ structured = false, includeBotContext = false } = {}) {
    const records = normalizeChatRecords(recapMessages)
      .filter((item) => includeBotContext || item.kind !== 'bot_context');
    return structured ? records : records.map((item) => renderChatRecord(item));
  }

  function getCurrentWindowEvents({ structured = true } = {}) {
    const records = normalizeEventRecords(twitchEvents);
    return structured ? records : records.map((item) => ({ type: item.type, text: item.text, timestamp: item.timestamp }));
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

  async function getSessionMemoryStatus() {
    const config = readSessionMemoryConfig();
    if (!currentStreamId || !streamLive) {
      return { enabled: config.enabled, streamLive: false, blockCount: 0, detailedCharacters: 0, compactCharacters: 0, currentWindowMessages: recapMessages.length };
    }
    const blocks = await getSessionMemoryBlocks({ streamId: currentStreamId });
    return {
      enabled: config.enabled,
      streamLive: true,
      streamId: currentStreamId,
      blockCount: blocks.length,
      detailedCharacters: blocks.reduce((sum, block) => sum + String(block?.detailedSummary || '').length, 0),
      compactCharacters: blocks.reduce((sum, block) => sum + String(block?.compactSummary || '').length, 0),
      currentWindowMessages: recapMessages.length,
      latestBlockAt: blocks.at(-1)?.endedAtMs || null
    };
  }

  async function getSessionMemoryContext(request = '') {
    const config = readSessionMemoryConfig();
    if (!config.enabled || !currentStreamId || !streamLive) return { text: '', stats: { enabled: config.enabled, blockCount: 0, contextCharacters: 0 } };
    const options = request && typeof request === 'object'
      ? request
      : { question: String(request || '') };
    const blocks = await getSessionMemoryBlocks({ streamId: currentStreamId });
    return buildSessionMemoryContext({
      blocks,
      question: options.question || '',
      requesterIdentity: options.requesterIdentity || null,
      recipientIdentity: options.recipientIdentity || null,
      recentChatLogs: normalizeChatRecords(recapMessages),
      config,
      streamLive
    });
  }

  async function clearCurrentSessionMemory() {
    if (!currentStreamId || !streamLive) return { success: false, message: 'No active Twitch stream session.' };
    await clearSessionMemory({ streamId: currentStreamId });
    console.log('[Session Memory] Current stream memory blocks cleared by moderator.');
    return { success: true, message: 'Current stream session memory cleared.' };
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

    await loadStreamLifecycleMemory();
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
    recordBotContextMessage,
    recordModeratorAnnouncement,
    recordTwitchEvent,
    handleRecapCommand,
    stopRecap,
    startRecap,
    getCurrentWindowLogs,
    getCurrentWindowContexts,
    getCurrentWindowEvents,
    getCurrentStreamRecapHistory,
    getSessionMemoryStatus,
    getSessionMemoryContext,
    clearCurrentSessionMemory,
    noteStreamLifecycleEvent,
    getStatus
  };
}


module.exports = { createRecapManager };
