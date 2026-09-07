const { randomUUID } = require('node:crypto');
const operationContext = require('./reliability/context');
const delivery = require('./reliability/delivery');
const { createSerialWriter, createSerialExecutor } = require('./reliability/serialWriter');
const { fetchWithTimeout: fetch } = require('./httpClient');
const {
  getRecentStreamRecaps,
  saveStreamRecap,
  getSessionMemoryBlocks,
  saveSessionMemoryBlock,
  clearSessionMemory,
  getActiveRecapState,
  saveActiveRecapState,
  clearStreamRecapsForStream
} = require('./streamRecapHistory');
const { getStreamLore, applyStreamLoreObservations, buildEffectiveLore } = require('./streamLore');
const { generateRecap, SUMMARY_PREFIX, sanitizeChatForGemini } = require('./recapGenerator');
const { generateSessionMemoryBlock, generateViewerLearningUpdates, generateStreamLoreObservations, buildSessionMemoryContext, normalizeSessionMemoryConfig } = require('./sessionMemory');
const { getViewerProfileSettings, getViewerLearningContext, applyViewerProfileUpdates } = require('./viewerProfiles');
const { cancelGeminiRequestsByLabelPrefix } = require('./geminiClient');
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
const POST_RECAP_LEARNING_DELAY_MS = 75 * 1000;
const RECAP_COMMAND_COOLDOWN = 5 * 60 * 1000;
const STREAM_STATUS_POLL_INTERVAL = 30 * 1000;
const TOKEN_VALIDATION_INTERVAL = 60 * 60 * 1000;
const ACTIVE_STATE_CHECKPOINT_INTERVAL = 30 * 1000;
const STARTUP_GRACE_MS = 60000;
const MAX_WINDOW_MESSAGES = 12000;
const MAX_WINDOW_EVENTS = 2000;
const MAX_WINDOW_BYTES = 4 * 1024 * 1024;
const MAX_WINDOW_AGE_MS = 6 * 60 * 60 * 1000;

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
  let managerStopping = false;
  let startPromise = null;
  let started = false;
  let pollInFlight = null;
  let lifecycleRevision = 0;
  let offlineChecks = 0;
  let lastEndedStreamId = '';
  let lastKnownPersistedStreamId = '';
  let pendingEnd = null;
  let windowId = randomUUID();
  let windowCreatedAt = Date.now();
  let windowBytes = 0;
  let capacityReached = false;
  let recoveryReason = '';
  let recoveryDeliveryKey = '';
  let lastPersistenceError = '';
  let startupGraceUntil = 0;
  const chatIds = new Set();
  const eventIds = new Set();
  const tasks = new Set();
  const serializeControl = createSerialExecutor();
  const serializeLifecycle = createSerialExecutor();
  const serializeLearning = createSerialExecutor();
  const stateWriter = createSerialWriter(async (snapshot) => {
    await saveActiveRecapState(snapshot);
  });
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
  let recapGenerationEpoch = 0;
  let streamSessionStartedAt = 0;
  let twitchStreamStartedAt = 0;
  let nextRecapAt = 0;
  let recapPaused = false;
  let collectionPaused = false;
  let pausedRemainingMs = 0;
  let pendingLearning = null;
  let recapTimer = null;
  let learningTimer = null;
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
      lastKnownPersistedStreamId = String(saved.lastKnownStreamId || '');
      lastStreamLifecycleEventType = String(saved.lastLifecycleEventType || '');
      if (lastStreamLifecycleEventType === 'offline') lastEndedStreamId = lastKnownPersistedStreamId;
      lastStreamLifecycleEventAt = saved.lastLifecycleEventAt ? new Date(saved.lastLifecycleEventAt).getTime() : 0;
      if (lastStreamEndedAt) {
        console.log(`[Stream Lifecycle] Restored last stream end: ${new Date(lastStreamEndedAt).toISOString()}.`);
      }
    } catch (err) {
      console.error('[Stream Lifecycle] Could not restore persisted stream lifecycle state:', err?.message || err);
      throw err;
    }
  }

  async function persistStreamLifecycle(patch = {}) {
    try {
      await saveStreamLifecycleState(channelName, patch);
    } catch (err) {
      console.error('[Stream Lifecycle] Could not persist stream lifecycle state:', err?.message || err);
      throw err;
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
    } catch (err) {
      console.warn('[Recap] Could not reserve an automation slot:', err.message);
      return { allowed: false, status: { active: true, availableAt: Date.now() + 10000 } };
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
    if (streamContexts.length > 500) streamContexts.shift();
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

    if (changed && streamLive && !collectionPaused) {
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
    if (!Array.isArray(data?.data)) throw new Error('Twitch returned malformed stream-status data; not treating it as offline.');
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


  function normalizePendingLearning(value) {
    if (!value || typeof value !== 'object') return null;
    const streamId = String(value.streamId || '').trim();
    const learningWindowId = String(value.windowId || '').trim();
    if (!streamId || !learningWindowId) return null;
    return {
      streamId,
      windowId: learningWindowId,
      dueAt: Math.max(0, Number(value.dueAt || 0)),
      generationStartedAt: Math.max(0, Number(value.generationStartedAt || 0)),
      windowThroughAt: Math.max(0, Number(value.windowThroughAt || 0)),
      recapSummaryBody: String(value.recapSummaryBody || ''),
      streamLore: String(value.streamLore || ''),
      messageSnapshot: normalizeChatRecords(value.messageSnapshot || []).map((item) => toStoredChatRecord(item)),
      contextSnapshot: Array.isArray(value.contextSnapshot) ? value.contextSnapshot : [],
      eventSnapshot: normalizeEventRecords(value.eventSnapshot || []).map((item) => toStoredEventRecord(item)),
      sessionMemoryDone: value.sessionMemoryDone === true,
      viewerLearningDone: value.viewerLearningDone === true,
      streamLoreDone: value.streamLoreDone === true,
      createdAt: Math.max(0, Number(value.createdAt || 0)) || Date.now()
    };
  }

  function createPendingLearningSnapshot({ streamId, learningWindowId, generationStartedAt,
    windowThroughAt, recapSummaryBody, streamLore, messageSnapshot, contextSnapshot, eventSnapshot }) {
    return normalizePendingLearning({
      streamId,
      windowId: learningWindowId,
      dueAt: 0,
      generationStartedAt,
      windowThroughAt,
      recapSummaryBody,
      streamLore,
      messageSnapshot,
      contextSnapshot,
      eventSnapshot,
      sessionMemoryDone: false,
      viewerLearningDone: false,
      streamLoreDone: false,
      createdAt: Date.now()
    });
  }


  function buildActiveState() {
    return {
      windowId, windowCreatedAt, capacityReached, recoveryReason, recoveryDeliveryKey,
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
      collectionPaused,
      pausedRemainingMs,
      pendingLearning
    };
  }

  async function persistActiveState({ force = false } = {}) {
    if (!currentStreamId || !streamLive) return;
    if (!force && !activeStateDirty) return;
    if (!force && stateWriter.pending) return;
    const snapshot = { streamId: currentStreamId, channelName,
      startedAt: twitchStreamStartedAt || streamSessionStartedAt || null,
      writerFence: operationContext.fence(), state: buildActiveState() };
    activeStateDirty = false;
    const saving = stateWriter.save(snapshot);
    activeStateSavePromise = saving;
    activeStateSaveInProgress = true;
    try {
      await saving;
      lastPersistenceError = '';
    } catch (err) {
      activeStateDirty = true;
      lastPersistenceError = String(err?.message || err);
      console.error('[Recap Persistence] State was NOT saved:', lastPersistenceError);
      err.persistenceFailure = true;
      throw err;
    } finally {
      if (activeStateSavePromise === saving) {
        activeStateSavePromise = null;
        activeStateSaveInProgress = false;
      }
    }
  }

  function rebuildWindowIndex() {
    chatIds.clear(); eventIds.clear();
    for (const item of recapMessages) {
      const id = String(item.sourceMessageId || item.twitchMessageId || '');
      if (id) chatIds.add(id);
    }
    for (const item of twitchEvents) if (item.sourceEventId) eventIds.add(String(item.sourceEventId));
    windowBytes = Buffer.byteLength(JSON.stringify({ recapMessages, twitchEvents, streamContexts }));
  }

  function cancelTasks({ publicOnly = false, includePreview = false } = {}) {
    for (const task of tasks) {
      if (!publicOnly || task.phase === 'public' || (includePreview && task.phase === 'preview')) task.controller.abort();
    }
  }

  function enterRecovery(message, key = '') {
    recoveryReason = String(message || 'Recap requires operator review.');
    recoveryDeliveryKey = key;
    recapPaused = true;
    recapInProgress = false;
    clearRecapTimer();
    nextRecapAt = 0;
    markActiveStateDirty();
  }

  function admitWindowEntry(value, kind = 'chat') {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const countFull = kind === 'event' ? twitchEvents.length >= MAX_WINDOW_EVENTS : recapMessages.length >= MAX_WINDOW_MESSAGES;
    if (capacityReached || countFull || windowBytes + bytes > MAX_WINDOW_BYTES ||
        ((recapMessages.length || twitchEvents.length) && Date.now() - windowCreatedAt > MAX_WINDOW_AGE_MS)) {
      if (!capacityReached) {
        capacityReached = true;
        collectionPaused = true;
        cancelTasks();
        enterRecovery('Recap window reached its retention limit. Collection is frozen; test or clear this window before resuming.');
        console.warn('[Recap] ' + recoveryReason);
        void persistActiveState({ force: true }).catch(() => {});
      }
      return false;
    }
    windowBytes += bytes;
    return true;
  }

  async function commitSentWindow(payload) {
    if (payload.streamId !== currentStreamId) return;
    // Save the immutable, already-delivered recap before advancing its window.
    // A crash here leaves the old identity recoverable through the send receipt.
    await saveStreamRecap({ streamId: payload.streamId, channelName,
      startedAt: payload.startedAt, text: payload.summary, windowId: payload.windowId });
    if (payload.streamId !== currentStreamId) return;
    if (pendingLearning?.streamId === payload.streamId && pendingLearning?.windowId === payload.windowId) {
      if (collectionPaused) {
        // Stop Recap System intentionally cancels post-recap learning even if a
        // Twitch send was accepted while the stop transition was in flight.
        pendingLearning = null;
      } else if (!pendingLearning.dueAt) {
        pendingLearning.dueAt = Date.now() + POST_RECAP_LEARNING_DELAY_MS;
        console.log(`[Recap] Post-recap learning queued for ${Math.round(POST_RECAP_LEARNING_DELAY_MS / 1000)}s after delivery.`);
      }
    }
    discardMessageSnapshot(payload.snapshotMaxId);
    discardContextSnapshot(payload.snapshotMaxContextId);
    discardEventSnapshot(payload.snapshotMaxEventId);
    if (windowId === payload.windowId) { windowId = randomUUID(); windowCreatedAt = Number(payload.windowThroughAt || Date.now()); }
    if (recoveryDeliveryKey === `recap:${channelName}:${payload.streamId}:${payload.windowId}`) {
      recoveryDeliveryKey = ''; recoveryReason = '';
    }
    firstRecapSent = true;
    recapInProgress = false;
    rebuildWindowIndex();
    if (!recapPaused) nextRecapAt = nextAnchoredRecapAt(streamSessionStartedAt, Date.now());
    markActiveStateDirty();
    await persistActiveState({ force: true });
    if (!recapPaused) scheduleRecapAt(nextRecapAt);
    schedulePendingLearning();
  }

  async function recoverWindowDelivery() {
    const key = `recap:${channelName}:${currentStreamId}:${windowId}`;
    const row = await delivery.get(key);
    if (row?.state === 'sent') {
      console.warn('[Recap] Recovered a committed Twitch receipt; consuming its snapshot without resending.');
      await commitSentWindow(row.payload);
    } else if (row && ['sending', 'unknown'].includes(row.state)) {
      enterRecovery('The previous recap may already have reached Twitch. Review chat and resolve its delivery before resuming, or clear the window.', key);
      await persistActiveState({ force: true });
    }
  }

  async function resolveDeliveryReview(outcome, expectedDeliveryKey = recoveryDeliveryKey) {
    if (expectedDeliveryKey !== recoveryDeliveryKey) return { success: false, message: 'This recap changed since you opened the review. Refresh before resolving it.' };
    if (!recoveryDeliveryKey) return { success: false, message: 'There is no ambiguous recap delivery to resolve.' };
    const key = recoveryDeliveryKey;
    const reviewedStreamId = currentStreamId;
    const row = await delivery.resolve(key, outcome);
    if (!row) return { success: false, message: 'The delivery record changed; refresh before reviewing it.' };
    // An offline/new-stream transition can race an operator's database request.
    // Resolve only that old receipt, never mutate the replacement live window.
    if (currentStreamId !== reviewedStreamId || recoveryDeliveryKey !== key) return { success: false, message: 'The old receipt was reviewed, but the active stream changed. Refresh its status.' };
    recoveryDeliveryKey = ''; recoveryReason = '';
    if (outcome === 'sent') await commitSentWindow(row.payload);
    pausedRemainingMs = outcome === 'sent' ? RECURRING_RECAP_DELAY : STARTUP_GRACE_MS;
    markActiveStateDirty();
    await persistActiveState({ force: true });
    return { success: true, message: outcome === 'sent'
      ? 'Marked delivered and removed the completed snapshot. Recaps remain paused until Resume.'
      : 'Marked definitely not delivered. The window is preserved; press Resume to retry. Only use this after checking Twitch chat.' };
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

      windowId = String(saved.windowId || randomUUID());
      windowCreatedAt = Number(saved.windowCreatedAt || Date.now());
      capacityReached = saved.capacityReached === true;
      recoveryReason = String(saved.recoveryReason || '');
      recoveryDeliveryKey = String(saved.recoveryDeliveryKey || '');
      recapMessages = normalizeChatRecords(saved.recapMessages || []).map((item) => toStoredChatRecord(item));
      messageSequence = Math.max(Number(saved.messageSequence || 0), recapMessages.at(-1)?.id || 0);
      streamContexts = Array.isArray(saved.streamContexts) ? saved.streamContexts : [];
      contextSequence = Math.max(Number(saved.contextSequence || 0), streamContexts.at(-1)?.id || 0);
      twitchEvents = normalizeEventRecords(saved.twitchEvents || []).map((item) => toStoredEventRecord(item));
      eventSequence = Math.max(Number(saved.eventSequence || 0), twitchEvents.at(-1)?.id || 0);
      firstRecapSent = Boolean(saved.firstRecapSent);
      recapInProgress = false;
      recapPaused = Boolean(saved.recapPaused);
      // Backward compatibility: older persisted states used recapPaused for both
      // generation and collection. Preserve that behavior on the first restore
      // after upgrade; all new saves persist collectionPaused independently.
      collectionPaused = saved.collectionPaused == null
        ? Boolean(saved.recapPaused)
        : Boolean(saved.collectionPaused);
      pausedRemainingMs = Math.max(0, Number(saved.pausedRemainingMs || 0));
      pendingLearning = normalizePendingLearning(saved.pendingLearning);
      streamSessionStartedAt = Number(saved.streamSessionStartedAt || 0) || Date.now();
      twitchStreamStartedAt = Number(saved.twitchStreamStartedAt || 0) || twitchStreamStartedAt || Date.now();
      nextRecapAt = Number(saved.nextRecapAt || 0);

      activeStateDirty = false;
      rebuildWindowIndex();
      await recoverWindowDelivery();
      schedulePendingLearning();
      if (!streamContexts.length) {
        addStreamContext({ title: currentStreamTitle, category: currentStreamCategory, gameId: currentStreamGameId });
      }

      if (!recapPaused) {
        if (!nextRecapAt) nextRecapAt = Date.now() + (firstRecapSent ? RECURRING_RECAP_DELAY : FIRST_RECAP_DELAY);
        startupGraceUntil = Date.now() + STARTUP_GRACE_MS;
        scheduleRecapAt(Math.max(startupGraceUntil, nextRecapAt));
      }

      console.log(`[Recap Persistence] Restored active recap window for stream ${streamId}: ${recapMessages.length} message(s), ${twitchEvents.length} event(s), next recap ${recapPaused ? 'paused' : new Date(nextRecapAt).toISOString()}.`);
      return true;
    } catch (err) {
      console.error('[Recap Persistence] Restore failed; refusing to overwrite saved state:', err.message || err);
      throw err;
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
    if (recapPaused || managerStopping || !operationContext.isActive()) return;

    nextRecapAt = timestamp;
    const delay = Math.max(0, timestamp - Date.now());

    recapTimer = operationContext.detached(() => setTimeout(() => {
      sendAutomaticRecap(firstRecapSent ? '60-minute timer' : 'first 60-minute timer')
        .catch((err) => console.error('[Recap] Scheduled recap error:', err));
    }, delay));
  }

  async function startStreamSession(status, alreadyLiveAtStartup = false) {
    cancelTasks();
    clearRecapTimer();
    clearLearningTimer();
    pendingLearning = null;
    windowId = randomUUID(); windowCreatedAt = Date.now(); windowBytes = 0;
    capacityReached = false; recoveryReason = ''; recoveryDeliveryKey = '';
    chatIds.clear(); eventIds.clear();
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
    collectionPaused = false;
    pausedRemainingMs = 0;

    currentStreamId = String(status?.streamId || '').trim();
    lastKnownPersistedStreamId = currentStreamId;
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

    const restored = await restoreActiveStateIfAvailable(status);
    if (!restored) {
      addStreamContext({
        title: currentStreamTitle,
        category: currentStreamCategory,
        gameId: currentStreamGameId
      });

      nextRecapAt = streamSessionStartedAt + FIRST_RECAP_DELAY;
      markActiveStateDirty();
      await persistActiveState({ force: true });
      scheduleRecapAt(nextRecapAt);
    }

    console.log(`[Recap] Qwert is LIVE. Automatic recap session ${restored ? 'restored from MongoDB' : 'started'}.`);
    console.log('[Recap] Current stream title:', currentStreamTitle || 'Unknown');
    console.log('[Recap] Current category:', currentStreamCategory || 'Unknown');
    console.log(restored ? '[Recap Persistence] Existing recap cadence preserved across restart.' : '[Recap] First recap will send after 60 minutes.');
  }

  async function finishPendingEnd() {
    if (!pendingEnd) return;
    const ending = pendingEnd;
    try { await stateWriter.flush(); } catch (err) { console.warn('[Recap] Prior checkpoint failed; applying the stream-end tombstone instead:', err.message); }
    await persistStreamLifecycle({ lastStreamEndedAt: ending.endedAt,
      lastKnownStreamId: ending.streamId, lastLifecycleEventType: 'offline',
      lastLifecycleEventAt: ending.endedAt });
    if (ending.streamId) await clearStreamRecapsForStream({
      streamId: ending.streamId, channelName, writerFence: operationContext.fence()
    });
    if (pendingEnd !== ending) return;
    currentStreamId = ''; currentStreamTitle = ''; currentStreamCategory = ''; currentStreamGameId = '';
    currentViewerCount = 0; recapMessages = []; streamContexts = []; twitchEvents = [];
    messageSequence = 0; contextSequence = 0; eventSequence = 0;
    pendingLearning = null; clearLearningTimer();
    firstRecapSent = false; recapInProgress = false; recapPaused = false; collectionPaused = false;
    pausedRemainingMs = 0; streamSessionStartedAt = 0; twitchStreamStartedAt = 0; nextRecapAt = 0;
    activeStateDirty = false; chatIds.clear(); eventIds.clear(); windowBytes = 0;
    capacityReached = false; recoveryReason = ''; recoveryDeliveryKey = ''; pendingEnd = null;
    console.log('[Recap] Qwert is OFFLINE. Ended stream state was durably cleared without touching another stream.');
  }

  async function endStreamSession(endedAtMs = 0) {
    const resolvedEndedAt = Number(endedAtMs) || recentOfflineLifecycleTimestamp() || Date.now();
    const endedStreamId = currentStreamId || lastKnownPersistedStreamId;
    lastStreamEndedAt = resolvedEndedAt; lastStreamLifecycleEventType = 'offline';
    lastStreamLifecycleEventAt = resolvedEndedAt; lastEndedStreamId = endedStreamId;
    cancelTasks(); recapGenerationEpoch += 1; clearRecapTimer(); clearLearningTimer(); pendingLearning = null;
    streamLive = false; recapInProgress = false; nextRecapAt = 0;
    pendingEnd ||= { streamId: endedStreamId, endedAt: resolvedEndedAt };
    try { await finishPendingEnd(); }
    catch (err) {
      recoveryReason = 'Stream ended, but MongoDB cleanup is pending. The saved stream will be retried safely.';
      throw err;
    }
  }

  async function noteStreamLifecycleEvent({ type, event = {}, timestamp = Date.now() } = {}) {
    const receivedAt = Number(timestamp) || Date.now();
    if (managerStopping || !operationContext.isActive()) return;
    if (receivedAt < lastStreamLifecycleEventAt || (streamLive && receivedAt < twitchStreamStartedAt)) {
      console.log('[Stream Lifecycle] Ignored an out-of-order lifecycle notification.');
      return;
    }
    lifecycleRevision += 1;
    await serializeLifecycle(async () => {
      if (managerStopping) return;
      if (pendingEnd) await finishPendingEnd();
      if (receivedAt < lastStreamLifecycleEventAt) return;
      if (type === 'stream.offline') {
        lastStreamEndedAt = receivedAt;
        lastStreamLifecycleEventType = 'offline'; lastStreamLifecycleEventAt = receivedAt;
        offlineChecks = 0;
        if (streamLive) await endStreamSession(receivedAt);
        else await persistStreamLifecycle({ lastStreamEndedAt, lastLifecycleEventType: 'offline', lastLifecycleEventAt: receivedAt });
      } else if (type === 'stream.online') {
        const parsed = Date.parse(event.started_at || '');
        lastStreamStartedAt = Number.isNaN(parsed) ? receivedAt : parsed;
        lastStreamLifecycleEventType = 'online'; lastStreamLifecycleEventAt = receivedAt;
        await persistStreamLifecycle({ lastStreamStartedAt, lastKnownStreamId: String(event.id || ''),
          lastLifecycleEventType: 'online', lastLifecycleEventAt: receivedAt });
      }
    });
    if (type === 'stream.online') await checkStreamStatus();
  }

  async function checkStreamStatus() {
    if (managerStopping || !operationContext.isActive()) return;
    if (pollInFlight) return pollInFlight;
    const revision = lifecycleRevision;
    pollInFlight = (async () => {
      try {
        if (pendingEnd) await serializeLifecycle(finishPendingEnd);
        const status = await fetchStreamStatus();
        if (managerStopping || revision !== lifecycleRevision || !operationContext.isActive()) return;
        await serializeLifecycle(async () => {
          if (managerStopping || revision !== lifecycleRevision) return;
          if (status.live) {
            offlineChecks = 0;
            if (status.streamId === lastEndedStreamId && lastStreamLifecycleEventType === 'offline' &&
                Date.now() - lastStreamLifecycleEventAt < 60000) return;
            if (!streamLive || status.streamId !== currentStreamId) {
              if (streamLive) await endStreamSession();
              try {
                await startStreamSession(status, !streamStateInitialized);
                streamStateInitialized = true;
              } catch (err) {
                clearRecapTimer(); streamLive = false; currentStreamId = ''; streamStateInitialized = false;
                throw err;
              }
            } else updateCurrentStreamContext(status);
          } else {
            if (streamLive || (!streamStateInitialized && lastKnownPersistedStreamId && lastStreamLifecycleEventType === 'online')) {
              offlineChecks += 1;
              if (offlineChecks < 3) {
                console.warn(`[Recap] Twitch returned offline (${offlineChecks}/3); preserving the live session pending confirmation.`);
                return;
              }
              await endStreamSession();
              offlineChecks = 0;
            }
            streamStateInitialized = true;
          }
        });
      } catch (err) {
        // Network/auth errors are unknown, never evidence of an ended stream.
        offlineChecks = 0;
        console.error('[Recap] Stream status check failed:', err.message || err);
      } finally { pollInFlight = null; }
    })();
    return pollInFlight;
  }

  function cancelRecapGeminiWork({ includeLearning = false } = {}) {
    const prefixes = ['hourly-recap'];
    if (includeLearning) prefixes.push('session-memory', 'viewer-learning', 'stream-lore');

    return prefixes.reduce((totals, prefix) => {
      const result = cancelGeminiRequestsByLabelPrefix(prefix);
      return {
        activeCancelled: totals.activeCancelled || Boolean(result.activeCancelled),
        queuedCancelled: totals.queuedCancelled + Number(result.queuedCancelled || 0)
      };
    }, { activeCancelled: false, queuedCancelled: 0 });
  }

  async function waitForActiveStateSave() {
    if (activeStateSaveInProgress && activeStateSavePromise) {
      try { await activeStateSavePromise; } catch (_) {}
    }
  }

  async function pauseGeneration({ channel, displayName = 'MOD', announce = true }) {
    if (!streamLive) {
      if (announce) await client.say(channel, await nativeResponse('stoprecap', 'offline', { user: displayName }, `@${displayName}, Qwert is offline, so the recap system is already inactive.`));
      return { success: false, message: 'Qwert is offline.' };
    }

    if (recapPaused && !collectionPaused && !recapInProgress && !lastPersistenceError) {
      if (announce) await client.say(channel, await nativeResponse('stoprecap', 'alreadyPaused', { user: displayName }, `@${displayName}, automatic hourly recap generation is already paused while collection remains active.`));
      return { success: false, message: 'Recap generation is already paused; collection is still active.' };
    }

    pausedRemainingMs = nextRecapAt ? Math.max(0, nextRecapAt - Date.now()) : pausedRemainingMs;

    // Pause Generation must guarantee that no in-flight automatic recap can
    // later reach Twitch. Collection stays active so the window keeps growing.
    const wasGenerating = recapInProgress;
    if (wasGenerating) {
      recapGenerationEpoch += 1;
      cancelTasks({ publicOnly: true });
      cancelRecapGeminiWork({ includeLearning: false });
    }

    recapPaused = true;
    collectionPaused = false;
    recapInProgress = false;
    clearRecapTimer();
    nextRecapAt = 0;

    await waitForActiveStateSave();
    markActiveStateDirty();
    await persistActiveState({ force: true });

    console.log(`[Recap] Generation paused by ${displayName}; collection remains ACTIVE.${wasGenerating ? ' Active recap generation was cancelled.' : ''}`);
    if (announce) {
      await client.say(channel, await nativeResponse('stoprecap', 'success', { user: displayName, messages: recapMessages.length, remaining: formatCountdown(pausedRemainingMs) }, `@${displayName}, automatic hourly recap generation is paused. Chat/event collection remains active with ${recapMessages.length} messages currently in the window.`));
    }

    return {
      success: true,
      message: `Recap generation paused. Collection remains ACTIVE; ${recapMessages.length} message(s) are currently in the window.`,
      paused: true,
      collectionPaused: false,
      abortedGeneration: wasGenerating
    };
  }

  // Backward-compatible name used by the Twitch !stoprecap command and older
  // route code. Its semantics are now generation-only pause.
  async function stopRecap(options) {
    return pauseGeneration(options);
  }


  async function stopRecapSystem({ displayName = 'MOD' } = {}) {
    if (!streamLive) {
      return { success: false, message: 'Qwert is offline. The recap system is already inactive.' };
    }

    const wasGenerating = recapInProgress;
    pausedRemainingMs = nextRecapAt ? Math.max(0, nextRecapAt - Date.now()) : pausedRemainingMs;

    // Invalidate every phase owned by an automatic recap and cancel both the
    // public recap request and post-recap memory/profile/lore Gemini work.
    recapGenerationEpoch += 1;
    cancelTasks();
    const cancelResult = cancelRecapGeminiWork({ includeLearning: true });

    clearRecapTimer();
    clearLearningTimer();
    pendingLearning = null;
    recapInProgress = false;
    recapPaused = true;
    collectionPaused = true;
    nextRecapAt = 0;

    await waitForActiveStateSave();
    markActiveStateDirty();
    await persistActiveState({ force: true });

    console.warn(`[Recap] Recap system STOPPED by ${displayName}. Window preserved at ${recapMessages.length} message(s) / ${twitchEvents.length} event(s).${wasGenerating ? ' Active generation was cancelled.' : ''}`);
    if (cancelResult.activeCancelled || cancelResult.queuedCancelled) {
      console.warn(`[Recap] Cancelled recap-system Gemini work: active=${cancelResult.activeCancelled ? 1 : 0}, queued=${cancelResult.queuedCancelled}.`);
    }

    return {
      success: true,
      message: `Recap system stopped. Generation and collection are PAUSED. Current window preserved (${recapMessages.length} message(s), ${twitchEvents.length} event(s)).`,
      paused: true,
      collectionPaused: true,
      abortedGeneration: wasGenerating || cancelResult.activeCancelled
    };
  }

  async function clearCurrentWindow({ displayName = 'MOD' } = {}) {
    if (!streamLive) {
      return { success: false, message: 'Qwert is offline. There is no active recap window to clear.' };
    }

    const clearedMessages = recapMessages.length;
    const clearedEvents = twitchEvents.length;
    const wasGenerating = recapInProgress;
    const clearedWindowId = windowId;

    // A pending snapshot with no dueAt belongs to a recap that has not been
    // confirmed delivered yet. Clearing that source window must clear its
    // learning handoff too; already-delivered delayed learning has a dueAt and
    // is intentionally independent of the new current window.
    if (pendingLearning?.windowId === clearedWindowId && !pendingLearning.dueAt) {
      pendingLearning = null;
      clearLearningTimer();
    }

    // A cleared window must never still be sent by an older generation.
    // Cancelling only hourly-recap work leaves already-sent post-processing
    // alone; those jobs use an immutable snapshot from the completed window.
    cancelTasks({ publicOnly: true, includePreview: true });
    if (wasGenerating) {
      recapGenerationEpoch += 1;
      cancelRecapGeminiWork({ includeLearning: false });
      recapInProgress = false;
    }

    windowId = randomUUID(); windowCreatedAt = Date.now(); capacityReached = false;
    recoveryReason = ''; recoveryDeliveryKey = ''; windowBytes = 0; chatIds.clear(); eventIds.clear();
    recapMessages = [];
    // Keep messageSequence monotonic across Clear.
    twitchEvents = [];
    // Keep eventSequence monotonic across Clear.
    streamContexts = [];
    // Keep contextSequence monotonic across Clear.
    addStreamContext({
      title: currentStreamTitle,
      category: currentStreamCategory,
      gameId: currentStreamGameId
    });

    // Clearing data does not otherwise change the operator-selected mode.
    // If automatic generation was active and we had to cancel an in-flight
    // recap, continue on the next anchored hourly boundary with a fresh window.
    if (!recapPaused && wasGenerating) {
      nextRecapAt = nextAnchoredRecapAt(streamSessionStartedAt, Date.now());
      scheduleRecapAt(nextRecapAt);
    }

    await waitForActiveStateSave();
    markActiveStateDirty();
    await persistActiveState({ force: true });

    console.warn(`[Recap] Current window cleared by ${displayName}: ${clearedMessages} message(s), ${clearedEvents} event(s). Generation=${recapPaused ? 'PAUSED' : 'RUNNING'}, collection=${collectionPaused ? 'PAUSED' : 'ACTIVE'}.`);
    return {
      success: true,
      message: `Current recap window cleared (${clearedMessages} message(s), ${clearedEvents} event(s)). Generation and collection modes were otherwise preserved.${wasGenerating ? ' The in-flight recap was cancelled to prevent sending cleared content.' : ''}`,
      clearedMessages,
      clearedEvents,
      abortedGeneration: wasGenerating,
      paused: recapPaused,
      collectionPaused
    };
  }

  // Legacy WebUI action kept so an older cached admin page cannot call a
  // destructive endpoint with obsolete semantics. It now performs the safe
  // composition explicitly: stop/freeze first, then clear the current window.
  async function abortAndClearRecap({ displayName = 'MOD' } = {}) {
    const stopped = await stopRecapSystem({ displayName });
    if (!stopped.success) return stopped;
    const cleared = await clearCurrentWindow({ displayName });
    return {
      ...cleared,
      message: `${cleared.message} Recap system remains STOPPED.`,
      paused: true,
      collectionPaused: true
    };
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

    await recoverWindowDelivery();
    if (recoveryDeliveryKey || capacityReached) return { success: false, message: recoveryReason };
    recapPaused = false;
    collectionPaused = false;
    recoveryReason = '';
    const resumeDelay = Math.max(STARTUP_GRACE_MS, pausedRemainingMs);
    nextRecapAt = Date.now() + resumeDelay;
    pausedRemainingMs = 0;

    addStreamContext({
      title: currentStreamTitle,
      category: currentStreamCategory,
      gameId: currentStreamGameId
    });

    await waitForActiveStateSave();
    markActiveStateDirty();
    try { await persistActiveState({ force: true }); }
    catch (err) { recapPaused = true; nextRecapAt = 0; clearRecapTimer(); throw err; }
    scheduleRecapAt(nextRecapAt);
    console.log(`[Recap] Resumed by ${displayName}. Generation RUNNING, collection ACTIVE. Next recap in ${formatCountdown(resumeDelay)}.`);

    if (announce) {
      await client.say(channel, await nativeResponse('startrecap', 'success', { user: displayName, remaining: formatCountdown(resumeDelay) }, `@${displayName}, automatic hourly recaps resumed where they left off. Next recap in ${formatCountdown(resumeDelay)}.`));
    }

    return { success: true, message: `Recap generation resumed and collection is ACTIVE. Next recap in ${formatCountdown(resumeDelay)}.` };
  }

  function recordTwitchEvent(event) {
    if (!streamLive || collectionPaused || managerStopping || !operationContext.isActive()) return false;
    const normalized = normalizeEventRecord(event);
    if (!normalized.text || sourceTimestamp(normalized.timestamp) < windowCreatedAt) return false;

    if (normalized.sourceEventId && eventIds.has(normalized.sourceEventId)) {
      return false;
    }

    eventSequence++;
    const storedEvent = toStoredEventRecord({
      ...normalized,
      id: eventSequence,
      timestamp: sourceTimestamp(normalized.timestamp)
    });
    if (!admitWindowEntry(storedEvent, 'event')) return false;
    twitchEvents.push(storedEvent);
    if (storedEvent.sourceEventId) eventIds.add(storedEvent.sourceEventId);

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
    if (!streamLive || collectionPaused || managerStopping || !operationContext.isActive()) return false;
    const body = String(rawMessage || '').trim();
    if (!body) return false;
    const messageId = String(twitchMessageId || tags?.id || tags?.['message-id'] || '').trim();
    const origin = normalizeSharedChatOrigin(
      sharedChat || metadata?.sharedChat || sharedChatOriginFromTwitchTags(tags)
    );
    const canonicalSourceId = String(sourceMessageId || origin.sourceMessageId || '').trim();
    if (timestamp || tags?.['tmi-sent-ts']) {
      if (sourceTimestamp(timestamp || tags['tmi-sent-ts']) < windowCreatedAt) return false;
    }
    const dedupeId = canonicalSourceId || messageId;
    if (dedupeId && chatIds.has(dedupeId)) return false;

    messageSequence++;
    const identity = normalizeIdentity(author || identityFromTwitchTags(tags, displayName), {
      displayName,
      login: tags?.username || '',
      userId: tags?.['user-id'] || '',
      role: 'viewer'
    });
    const storedMessage = toStoredChatRecord({
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
    });
    if (!admitWindowEntry(storedMessage)) return false;
    recapMessages.push(storedMessage);
    const storedId = String(storedMessage.sourceMessageId || storedMessage.twitchMessageId || '');
    if (storedId) chatIds.add(storedId);
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
    if (!streamLive || collectionPaused || managerStopping || !operationContext.isActive()) return false;
    const body = String(rawMessage || '').trim();
    if (!body) return false;
    if (timestamp && sourceTimestamp(timestamp) < windowCreatedAt) return false;
    const messageId = String(twitchMessageId || '').trim();
    if (messageId && chatIds.has(messageId)) return false;

    const botName = String(displayName || botUsername || 'SqwertArmyBot').trim() || 'SqwertArmyBot';
    messageSequence++;
    const storedMessage = toStoredChatRecord({
      id: messageSequence,
      twitchMessageId: messageId,
      timestamp: sourceTimestamp(timestamp),
      kind: 'bot_context',
      author: normalizeIdentity(author || { login: botUsername, displayName: botName, role: 'bot' }),
      body,
      replyTo,
      metadata
    });
    if (!admitWindowEntry(storedMessage)) return false;
    recapMessages.push(storedMessage);
    const storedId = String(storedMessage.sourceMessageId || storedMessage.twitchMessageId || '');
    if (storedId) chatIds.add(storedId);
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
    if (!streamLive || collectionPaused || managerStopping || !operationContext.isActive()) return false;
    const body = String(rawMessage || '').trim();
    if (!body) return false;
    const messageId = String(twitchMessageId || tags?.id || tags?.['message-id'] || '').trim();
    const origin = normalizeSharedChatOrigin(
      sharedChat || metadata?.sharedChat || sharedChatOriginFromTwitchTags(tags)
    );
    const canonicalSourceId = String(sourceMessageId || origin.sourceMessageId || '').trim();
    if (timestamp || tags?.['tmi-sent-ts']) {
      if (sourceTimestamp(timestamp || tags['tmi-sent-ts']) < windowCreatedAt) return false;
    }
    const dedupeId = canonicalSourceId || messageId;
    if (dedupeId && chatIds.has(dedupeId)) return false;

    const moderator = String(displayName || 'moderator').trim() || 'moderator';
    messageSequence++;
    const storedMessage = toStoredChatRecord({
      id: messageSequence,
      twitchMessageId: messageId,
      sourceMessageId: canonicalSourceId,
      timestamp: sourceTimestamp(timestamp || tags?.['tmi-sent-ts']),
      kind: 'moderator_announcement',
      author: normalizeIdentity(author || identityFromTwitchTags(tags, moderator), { displayName: moderator, role: 'moderator' }),
      body,
      sharedChat: origin,
      metadata: { ...metadata, color: String(color || '').trim() }
    });
    if (!admitWindowEntry(storedMessage)) return false;
    recapMessages.push(storedMessage);
    const storedId = String(storedMessage.sourceMessageId || storedMessage.twitchMessageId || '');
    if (storedId) chatIds.add(storedId);

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

  function createTask(phase) {
    const task = { phase, streamId: currentStreamId, controller: new AbortController(), promise: null };
    tasks.add(task);
    return task;
  }
  function taskCurrent(task) { return !managerStopping && streamLive && currentStreamId === task.streamId && !task.controller.signal.aborted; }

  function clearLearningTimer() {
    if (learningTimer) {
      clearTimeout(learningTimer);
      learningTimer = null;
    }
  }

  function schedulePendingLearning() {
    clearLearningTimer();
    const job = pendingLearning;
    if (!job || !job.dueAt || managerStopping || !streamLive || collectionPaused || currentStreamId !== job.streamId) return;
    const expectedWindowId = job.windowId;
    const delay = Math.max(0, Number(job.dueAt) - Date.now());
    learningTimer = operationContext.detached(() => setTimeout(() => {
      learningTimer = null;
      if (!pendingLearning || pendingLearning.windowId !== expectedWindowId) return;
      launchPendingLearning().catch((err) => console.error('[Recap] Delayed post-recap learning scheduler failed:', err?.message || err));
    }, delay));
  }

  async function checkpointLearningStage(job, field) {
    if (!pendingLearning || pendingLearning.windowId !== job.windowId || pendingLearning.streamId !== job.streamId) return false;
    pendingLearning[field] = true;
    markActiveStateDirty();
    await persistActiveState({ force: true });
    return true;
  }

  async function performPendingLearning(job, task) {
    operationContext.throwIfCancelled();
    if (!taskCurrent(task) || collectionPaused || pendingLearning?.windowId !== job.windowId) return;

    await serializeLearning(async () => {
      operationContext.throwIfCancelled();
      if (!taskCurrent(task) || collectionPaused || pendingLearning?.windowId !== job.windowId) return;

      const chatRecords = normalizeChatRecords(job.messageSnapshot || []);
      const sessionMemoryChatRecords = chatRecords.filter((item) => item.kind !== 'bot_context');
      const permanentLearningChatRecords = sessionMemoryChatRecords.filter((item) => !isSharedChatGuest(item));
      const sharedChatGuestCount = sessionMemoryChatRecords.length - permanentLearningChatRecords.length;
      const memoryChatRecords = sanitizeChatForGemini(sessionMemoryChatRecords).records;
      const permanentLearningRecords = sanitizeChatForGemini(permanentLearningChatRecords).records;
      const contextSnapshot = Array.isArray(job.contextSnapshot) ? job.contextSnapshot : [];
      const eventSnapshot = normalizeEventRecords(job.eventSnapshot || []);
      const generatedAtMs = Number(job.windowThroughAt || job.createdAt || Date.now());
      const sourceTimes = [
        ...(job.messageSnapshot || []).map((item) => Number(item?.timestamp || 0)),
        ...contextSnapshot.map((item) => Number(item?.timestamp || 0)),
        ...eventSnapshot.map((item) => Number(item?.timestamp || 0))
      ].filter((value) => value > 0);
      const windowStartedAtMs = sourceTimes.length
        ? Math.min(...sourceTimes)
        : Math.max(Number(job.generationStartedAt || 0), generatedAtMs - RECURRING_RECAP_DELAY);

      if (sharedChatGuestCount > 0) {
        console.log(`[Shared Chat] Kept ${sharedChatGuestCount} guest-origin message(s) in delayed session context and excluded them from permanent Viewer Profile and Stream Lore learning.`);
      }

      if (!job.sessionMemoryDone) {
        const sessionMemoryConfig = readSessionMemoryConfig();
        if (sessionMemoryConfig.enabled) {
          try {
            const memoryBlock = await generateSessionMemoryBlock({
              chatLogs: memoryChatRecords,
              streamContexts: contextSnapshot,
              twitchEvents: eventSnapshot,
              streamLore: String(job.streamLore || ''),
              publicRecap: String(job.recapSummaryBody || ''),
              streamTiming: { windowStartedAtMs, generatedAtMs },
              config: sessionMemoryConfig,
              channelName
            });
            if (!taskCurrent(task) || collectionPaused || pendingLearning?.windowId !== job.windowId) return;
            if (memoryBlock) {
              await saveSessionMemoryBlock({
                streamId: job.streamId,
                channelName,
                startedAt: job.generationStartedAt || null,
                block: memoryBlock,
                windowId: job.windowId
              });
              console.log(`[Session Memory] Stored delayed hourly memory block (${memoryBlock.detailedSummary.length} detailed chars, ${memoryBlock.compactSummary.length} compact chars).`);
            }
          } catch (memoryErr) {
            if (memoryErr?.cancelled || !taskCurrent(task)) throw memoryErr;
            console.error('[Session Memory] Delayed hourly memory generation/storage failed. Public recap remains successful:', memoryErr?.message || memoryErr);
          }
        }
        if (!taskCurrent(task) || collectionPaused || pendingLearning?.windowId !== job.windowId) return;
        await checkpointLearningStage(job, 'sessionMemoryDone');
      }

      if (!job.viewerLearningDone) {
        let viewerProfileSettings = { automaticLearningEnabled: false };
        try {
          viewerProfileSettings = await getViewerProfileSettings(channelName);
        } catch (settingsErr) {
          console.error('[Viewer Profiles] Could not load viewer-profile settings for delayed hourly learning:', settingsErr?.message || settingsErr);
        }
        if (viewerProfileSettings.automaticLearningEnabled) {
          try {
            const existingProfiles = await getViewerLearningContext(channelName, permanentLearningRecords);
            const viewerUpdates = await generateViewerLearningUpdates({ chatLogs: permanentLearningRecords, existingProfiles });
            if (!taskCurrent(task) || collectionPaused || pendingLearning?.windowId !== job.windowId) return;
            if (viewerUpdates.length) {
              const profileResult = await applyViewerProfileUpdates({
                channelName,
                chatLogs: permanentLearningRecords,
                updates: viewerUpdates
              });
              console.log(`[Viewer Profiles] Delayed hourly learning processed ${viewerUpdates.length} viewer update(s): ${profileResult.created} new pending, ${profileResult.reinforced} reinforced, ${profileResult.refined} pending auto-refined, ${profileResult.revisionsProposed} approved revision proposal(s), ${profileResult.contradictions} contradiction update(s), ${profileResult.skipped} skipped.`);
            } else {
              console.log('[Viewer Profiles] Delayed hourly learning found no durable viewer observations or updates.');
            }
          } catch (viewerErr) {
            if (viewerErr?.cancelled || !taskCurrent(task)) throw viewerErr;
            console.error('[Viewer Profiles] Delayed hourly learning failed. Session memory and public recap remain successful:', viewerErr?.message || viewerErr);
          }
        }
        if (!taskCurrent(task) || collectionPaused || pendingLearning?.windowId !== job.windowId) return;
        await checkpointLearningStage(job, 'viewerLearningDone');
      }

      if (!job.streamLoreDone) {
        let currentLoreRecord = null;
        try {
          currentLoreRecord = await getStreamLore(channelName);
        } catch (loreLoadErr) {
          console.error('[Stream Lore] Could not reload lore before delayed hourly learning; continuing with no existing observation context:', loreLoadErr?.message || loreLoadErr);
        }
        try {
          const loreObservations = await generateStreamLoreObservations({
            chatLogs: permanentLearningRecords,
            existingObservations: currentLoreRecord?.learnedObservations || []
          });
          if (!taskCurrent(task) || collectionPaused || pendingLearning?.windowId !== job.windowId) return;
          if (loreObservations.length) {
            const loreResult = await applyStreamLoreObservations(channelName, loreObservations);
            console.log(`[Stream Lore] Delayed hourly learning processed ${loreObservations.length} candidate(s): ${loreResult.created} new pending, ${loreResult.reinforced} reinforced, ${loreResult.refined} pending auto-refined, ${loreResult.revisionsProposed} approved revision proposal(s), ${loreResult.contradictions} contradiction update(s), ${loreResult.skipped} skipped.`);
          } else {
            console.log('[Stream Lore] Delayed hourly learning found no durable channel-lore candidates or updates.');
          }
        } catch (loreErr) {
          if (loreErr?.cancelled || !taskCurrent(task)) throw loreErr;
          console.error('[Stream Lore] Delayed hourly learning failed. Session memory and public recap remain successful:', loreErr?.message || loreErr);
        }
        if (!taskCurrent(task) || collectionPaused || pendingLearning?.windowId !== job.windowId) return;
        await checkpointLearningStage(job, 'streamLoreDone');
      }
    });
  }

  async function launchPendingLearning() {
    const job = pendingLearning;
    if (!job || !job.dueAt || managerStopping || !streamLive || collectionPaused || currentStreamId !== job.streamId) return;
    if (Number(job.dueAt) > Date.now()) { schedulePendingLearning(); return; }
    if ([...tasks].some((task) => task.phase === 'learning' && task.learningWindowId === job.windowId)) return;

    const task = createTask('learning');
    task.learningWindowId = job.windowId;
    console.log(`[Recap] Starting delayed post-recap learning for window ${job.windowId} after ${Math.round(POST_RECAP_LEARNING_DELAY_MS / 1000)}s quiet period.`);
    task.promise = operationContext.runOperation(() => performPendingLearning(job, task), {
      signal: task.controller.signal,
      isCurrent: () => taskCurrent(task) && !collectionPaused && pendingLearning?.windowId === job.windowId
    });

    try {
      await task.promise;
      if (!taskCurrent(task) || collectionPaused || pendingLearning?.windowId !== job.windowId) return;
      if (job.sessionMemoryDone && job.viewerLearningDone && job.streamLoreDone) {
        pendingLearning = null;
        markActiveStateDirty();
        await persistActiveState({ force: true });
        console.log('[Recap] Delayed post-recap memory/profile/lore processing complete.');
      }
    } catch (err) {
      if (err?.cancelled || managerStopping || !streamLive || collectionPaused || pendingLearning?.windowId !== job.windowId) {
        console.log('[Recap] Delayed post-recap learning paused/cancelled; durable checkpoint preserved.');
        return;
      }
      console.error('[Recap] Delayed post-recap learning encountered an unexpected failure; retrying in 60 seconds:', err?.message || err);
      pendingLearning.dueAt = Date.now() + 60000;
      markActiveStateDirty();
      try { await persistActiveState({ force: true }); } catch (_) {}
    } finally {
      tasks.delete(task);
      if (!managerStopping && streamLive && !collectionPaused && pendingLearning?.windowId === job.windowId) schedulePendingLearning();
    }
  }
  async function runPreview(fn) {
    if (managerStopping || (recapPaused && collectionPaused)) throw new Error('Recap system is stopped. Select Pause Generation to enable preview testing without automatic sends.');
    if ([...tasks].some((task) => task.phase === 'preview')) throw new Error('A recap preview is already running.');
    const task = createTask('preview');
    const previewWindowId = windowId;
    task.promise = operationContext.runOperation(async () => {
      const result = await fn();
      operationContext.throwIfCancelled();
      return result;
    }, { signal: task.controller.signal, isCurrent: () => taskCurrent(task) && windowId === previewWindowId });
    try { return await task.promise; } finally { tasks.delete(task); }
  }
  async function sendAutomaticRecap(reason) {
    if (managerStopping || !operationContext.isActive() || !streamLive || recapPaused || recapInProgress) return;
    const task = createTask('public');
    task.promise = operationContext.runOperation(() => performAutomaticRecap(reason, task), {
      signal: task.controller.signal, isCurrent: () => taskCurrent(task)
    });
    try { return await task.promise; } finally { tasks.delete(task); }
  }
  async function performAutomaticRecap(reason, task) {
    if (!streamLive || recapPaused || recapInProgress) return;
    if (deferForEventReaction()) return;
    if (deferForTaggedQuestionBuffer()) return;
    if (deferForAutomationSpacing()) return;

    recapInProgress = true;
    const generationStreamId = currentStreamId;
    const generationWindowId = windowId;
    const generationStartedAt = streamSessionStartedAt;
    const windowThroughAt = Date.now();
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

    let recapSent = false;

    try {
      let twitchMessage;
      let recapSummaryBody;
      let previousRecaps = [];
      let streamLore = '';
      let streamLoreRecord = null;

      if (currentStreamId) {
        try {
          previousRecaps = await getRecentStreamRecaps({ streamId: generationStreamId, limit: 5 });
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

      if (!taskCurrent(task)) {
        console.log('[Recap] Automatic recap was aborted by moderator before send. Discarding generated output.');
        return;
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

      if (!taskCurrent(task) || recapPaused) {
        console.log('[Recap] Automatic recap was aborted/paused before Twitch send. Generated output discarded.');
        return;
      }

      // Persist an immutable learning snapshot BEFORE the external send. If
      // Twitch accepts the recap and Render dies before commitSentWindow(), the
      // sent-receipt recovery path can still delay/resume the matching learning
      // work without retaining the already-completed recap window forever.
      if (!pendingLearning || pendingLearning.windowId === generationWindowId) {
        pendingLearning = createPendingLearningSnapshot({
          streamId: generationStreamId,
          learningWindowId: generationWindowId,
          generationStartedAt,
          windowThroughAt,
          recapSummaryBody,
          streamLore,
          messageSnapshot,
          contextSnapshot,
          eventSnapshot
        });
      } else {
        console.warn(`[Recap] A prior delayed-learning checkpoint (${pendingLearning.windowId}) is still pending; this recap will send normally but will not overwrite that durable learning snapshot.`);
      }

      // Persist the window identity and learning handoff before attempting any external delivery.
      await persistActiveState({ force: true });
      const delivered = await delivery.deliver({
        key: `recap:${channelName}:${generationStreamId}:${generationWindowId}`, kind: 'recap',
        payload: { streamId: generationStreamId, windowId: generationWindowId,
          startedAt: generationStartedAt, windowThroughAt, snapshotMaxId, snapshotMaxContextId, snapshotMaxEventId,
          message: twitchMessage, summary: recapSummaryBody },
        send: (payload) => client.say(channelName, payload.message, { temporaryPin: true })
      });
      recapSent = true;
      console.log(`[Recap] ${delivered.replayed ? 'Recovered already-sent recap' : 'Sent recap'} (${twitchMessage.length}/500).`);
      await commitSentWindow(delivered.payload);
      // Public recap delivery is now complete. The persisted learning snapshot
      // is scheduled separately so low-priority session/profile/lore work begins
      // only after the rolling-RPM quiet period and survives a restart.
      return;
    } catch (err) {
      if (err?.reviewRequired && currentStreamId === generationStreamId && windowId === generationWindowId) {
        enterRecovery(err.message, err.deliveryKey);
        try { await persistActiveState({ force: true }); } catch (_) {}
        return;
      }
      if (!taskCurrent(task) || err?.cancelled === true) {
        // An operator-owned pause/stop/clear transition owns the state now.
        // Do not schedule a five-minute retry or resurrect an older window.
        console.log('[Recap] Automatic recap operation cancelled by moderator; no retry scheduled.');
        return;
      }

      if (recapSent || err?.persistenceFailure) {
        enterRecovery(recapSent ? 'Recap was sent, but saving its completed state failed. Automatic recaps paused; check MongoDB and restart after recovery.' : 'MongoDB did not save the recap state. Automatic recaps paused to avoid unsafe delivery.');
        try { await persistActiveState({ force: true }); } catch (_) {}
        console.error('[Recap] Safe recovery pause:', err?.message || err);
        return;
      }

      console.error('[Recap] Automatic recap failed:', err);

      if (err.inputBlocked) {
        recapInProgress = false;
        discardMessageSnapshot(snapshotMaxId);
        discardContextSnapshot(snapshotMaxContextId);
        discardEventSnapshot(snapshotMaxEventId);
        firstRecapSent = true;
        windowId = randomUUID(); windowCreatedAt = Date.now(); rebuildWindowIndex();

        if (streamLive) {
          try {
            await delivery.deliver({ key: `recap-blocked:${generationStreamId}:${generationWindowId}`, kind: 'recap_notice',
              payload: { message: "The hourly recap was blocked due to sensitive terms found in chat. I'll try again in 60 minutes. Y'all may have gone a little too hard for the robot. LUL" },
              send: (payload) => client.say(channelName, payload.message) });
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
      recoveryReason, recoveryDeliveryKey, lastPersistenceError, capacityReached,
      recoveryRequired: Boolean(recoveryReason || recoveryDeliveryKey || pendingEnd),
      windowBytes, windowId, windowCreatedAt, startupGraceUntil: !recapPaused && startupGraceUntil > Date.now() ? startupGraceUntil : null,
      learningInProgress: [...tasks].some((task) => task.phase === 'learning'),
      learningPending: Boolean(pendingLearning),
      learningDueAt: Number(pendingLearning?.dueAt || 0) || null,
      learningWindowId: pendingLearning?.windowId || null,
      previewInProgress: [...tasks].some((task) => task.phase === 'preview'),
      streamLive,
      currentStreamId: currentStreamId || null,
      currentStreamTitle: currentStreamTitle || null,
      currentStreamCategory: currentStreamCategory || null,
      currentStreamGameId: currentStreamGameId || null,
      currentViewerCount,
      recapPaused,
      collectionPaused,
      recapSystemStopped: Boolean(recapPaused && collectionPaused),
      loggingMessages: streamStateInitialized && streamLive && !collectionPaused,
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
    if (started) return startPromise;
    if (!channelName) throw new Error('TWITCH_CHANNEL is missing.');
    managerStopping = false;
    started = true;
    startPromise = (async () => {
      await loadStreamLifecycleMemory();
      try { await validateStoredToken(); }
      catch (err) { console.warn('[Recap] Initial token check failed; polling will retry after authorization:', err.message || err); }
      if (managerStopping) return;
      streamPollTimer = operationContext.detached(() => setInterval(() => { void checkStreamStatus(); }, STREAM_STATUS_POLL_INTERVAL));
      activeStateCheckpointTimer = operationContext.detached(() => setInterval(() => {
        if (!managerStopping && operationContext.isActive()) void persistActiveState().catch(() => {});
      }, ACTIVE_STATE_CHECKPOINT_INTERVAL));
      tokenValidationTimer = operationContext.detached(() => setInterval(() => {
        if (!managerStopping) void validateStoredToken().catch((err) => console.warn('[Recap] Token validation:', err.message));
      }, TOKEN_VALIDATION_INTERVAL));
      await checkStreamStatus();
      console.log('[Recap] Detection enabled; three offline polls required. Restored recaps have a 60-second startup grace period.');
    })();
    try { await startPromise; } catch (err) { started = false; throw err; }
  }

  function quiesce() {
    managerStopping = true; lifecycleRevision += 1;
    clearRecapTimer();
    clearLearningTimer();
    clearInterval(streamPollTimer); clearInterval(tokenValidationTimer); clearInterval(activeStateCheckpointTimer);
    streamPollTimer = null; tokenValidationTimer = null; activeStateCheckpointTimer = null;
    cancelTasks();
    recapInProgress = false;
    started = false;
  }
  async function shutdown({ persist = true } = {}) {
    quiesce();
    if (persist && currentStreamId && streamLive) {
      markActiveStateDirty();
      await persistActiveState({ force: true });
      await stateWriter.flush();
    }
  }
  async function durableControl(fn) {
    return serializeControl(async () => {
      await operationContext.assertOperation();
      return fn();
    });
  }

  return {
    start, shutdown, quiesce, checkStreamStatus, runPreview,
    flush: () => persistActiveState({ force: true }),
    resolveDeliveryReview: (...args) => durableControl(() => resolveDeliveryReview(...args)),
    recordChatMessage,
    recordBotContextMessage,
    recordModeratorAnnouncement,
    recordTwitchEvent,
    handleRecapCommand,
    stopRecap: (options) => durableControl(() => pauseGeneration(options)),
    pauseGeneration: (options) => durableControl(() => pauseGeneration(options)),
    startRecap: (options) => durableControl(() => startRecap(options)),
    stopRecapSystem: (options) => durableControl(() => stopRecapSystem(options)),
    clearCurrentWindow: (options) => durableControl(() => clearCurrentWindow(options)),
    abortAndClearRecap: (options) => durableControl(() => abortAndClearRecap(options)),
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
