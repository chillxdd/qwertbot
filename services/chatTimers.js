const { staleDeliveryReason } = require('./reliability/recoveryScope');
const { randomUUID } = require('node:crypto');
const context = require('./reliability/context');
const delivery = require('./reliability/delivery');
const { WRITE_OPTIONS } = require('./reliability/store');
const { createSerialExecutor } = require('./reliability/serialWriter');
const ChatTimer = require('../models/ChatTimer');
const rotation = require('../shared/timers/rotation');
const TimerConfig = require('../models/TimerConfig');

const { createOwnResponseTracker } = require('../shared/ownResponseTracker');
const MAX_TIMER_NAME_LENGTH = 80;
const MIN_TIMER_INTERVAL_SECONDS = 30;
const MAX_TIMER_INTERVAL_SECONDS = 86400;
const MAX_TIMER_RESPONSES = 25;
const MAX_TIMER_RESPONSE_LENGTH = 500;
const TIMER_RESPONSE_MODES = ['sequential'];
const TIMER_PRIORITIES = ['high', 'normal', 'low'];
const TIMER_ACTION_TYPES = ['chat_message', 'twitch_announcement'];
const TIMER_ANNOUNCEMENT_COLORS = ['primary', 'purple', 'blue', 'green', 'orange'];
const MAX_START_DELAY_SECONDS = 86400;
const MAX_JITTER_SECONDS = 86400;
const MAX_MINIMUM_CHAT_MESSAGES = 100000;
const MAX_MINIMUM_VIEWERS = 1000000;
const DEFAULT_GLOBAL_START_DELAY_SECONDS = 0;
const SCHEDULER_TICK_MS = 1000;
const ACTIVITY_CHECKPOINT_MS = 60 * 1000;
const RETRY_DELAYS_MS = [10000, 30000, 60000];
const HISTORY_LIMIT = 10;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function wholeNumber(value, fallback = 0) {
  return Math.round(finiteNumber(value, fallback));
}

function normalizeSettings(input = {}) {
  const globalStartDelaySeconds = wholeNumber(input.globalStartDelaySeconds, DEFAULT_GLOBAL_START_DELAY_SECONDS);
  if (globalStartDelaySeconds < 0 || globalStartDelaySeconds > MAX_START_DELAY_SECONDS) {
    throw new Error(`Global stream-start delay must be between 0 and ${MAX_START_DELAY_SECONDS} seconds.`);
  }

  const minimumSpacingSeconds = wholeNumber(input.minimumSpacingSeconds, 60);
  if (minimumSpacingSeconds < 0 || minimumSpacingSeconds > 3600) throw new Error('Timer spacing must be between 0 and 3600 seconds.');
  return { globalStartDelaySeconds, minimumSpacingSeconds };
}

function normalizeInput(input = {}, settings = {}, platformOptions = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Timer Name is required.');
  if (name.length > MAX_TIMER_NAME_LENGTH) throw new Error(`Timer Name can contain at most ${MAX_TIMER_NAME_LENGTH} characters.`);

  const intervalSeconds = finiteNumber(input.intervalSeconds, NaN);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < MIN_TIMER_INTERVAL_SECONDS || intervalSeconds > MAX_TIMER_INTERVAL_SECONDS) {
    throw new Error(`Interval must be between ${MIN_TIMER_INTERVAL_SECONDS} and ${MAX_TIMER_INTERVAL_SECONDS} seconds.`);
  }

  let startDelaySeconds = null;
  const rawStartDelay = input.startDelaySeconds;
  if (rawStartDelay !== null && rawStartDelay !== undefined && String(rawStartDelay).trim() !== '') {
    startDelaySeconds = wholeNumber(rawStartDelay, NaN);
    if (!Number.isFinite(startDelaySeconds) || startDelaySeconds < 0 || startDelaySeconds > MAX_START_DELAY_SECONDS) {
      throw new Error(`Per-timer stream-start delay must be between 0 and ${MAX_START_DELAY_SECONDS} seconds.`);
    }
    const globalDelay = wholeNumber(settings.globalStartDelaySeconds, DEFAULT_GLOBAL_START_DELAY_SECONDS);
    if (startDelaySeconds < globalDelay) {
      throw new Error(`Per-timer stream-start delay cannot be lower than the global delay (${globalDelay} seconds). Leave it blank to use the global delay.`);
    }
  }

  const minimumChatMessages = wholeNumber(input.minimumChatMessages, 0);
  if (minimumChatMessages < 0 || minimumChatMessages > MAX_MINIMUM_CHAT_MESSAGES) {
    throw new Error(`Minimum chat messages must be between 0 and ${MAX_MINIMUM_CHAT_MESSAGES}.`);
  }

  const minimumViewers = wholeNumber(input.minimumViewers, 0);
  if (minimumViewers < 0 || minimumViewers > MAX_MINIMUM_VIEWERS) {
    throw new Error(`Minimum viewers must be between 0 and ${MAX_MINIMUM_VIEWERS}.`);
  }

  const advancedFilterId = String(input.advancedFilterId || '').trim();

  const jitterSeconds = wholeNumber(input.jitterSeconds, 0);
  if (jitterSeconds < 0 || jitterSeconds > MAX_JITTER_SECONDS) {
    throw new Error(`Random timing variation must be between 0 and ${MAX_JITTER_SECONDS} seconds.`);
  }

  const priority = TIMER_PRIORITIES.includes(String(input.priority || '').toLowerCase())
    ? String(input.priority).toLowerCase()
    : 'normal';

  const responseSettings = rotation.normalizeResponses(input, platformOptions);
  return { name, intervalSeconds: Math.round(intervalSeconds * 1000) / 1000,
    startDelaySeconds, minimumChatMessages, minimumViewers, jitterSeconds, priority,
    ...responseSettings, enabled: input.enabled !== false };

}

function priorityRank(priority) {
  if (priority === 'high') return 0;
  if (priority === 'low') return 2;
  return 1;
}

function dateMs(value) {
  if (!value) return 0;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function effectiveStartDelay(timer, settings) {
  const globalDelay = Math.max(0, wholeNumber(settings?.globalStartDelaySeconds, DEFAULT_GLOBAL_START_DELAY_SECONDS));
  const timerDelay = timer?.startDelaySeconds === null || timer?.startDelaySeconds === undefined
    ? globalDelay
    : Math.max(0, wholeNumber(timer.startDelaySeconds, globalDelay));
  return Math.max(globalDelay, timerDelay);
}

function randomJitterMs(timer) {
  const jitterSeconds = Math.max(0, wholeNumber(timer?.jitterSeconds, 0));
  if (!jitterSeconds) return 0;
  const span = jitterSeconds * 2 + 1;
  return (Math.floor(Math.random() * span) - jitterSeconds) * 1000;
}

function calculateNextDueAt(timer, now = Date.now()) { return rotation.nextDueAt(timer, now); }
function chooseResponse(timer, evaluateFilter) { return rotation.chooseResponse(timer, evaluateFilter); }

const MAX_RANDOM_DECIMAL_PLACES = 5;

function randomIntegerInclusive(min, max) {
  const low = Math.ceil(Number(min));
  const high = Math.floor(Number(max));
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low > high) return null;
  const span = high - low + 1;
  if (!Number.isSafeInteger(span) || span <= 0) return null;
  return Math.floor(Math.random() * span) + low;
}

function randomNumberInclusive(min, max, decimalPlaces = 0) {
  const rawDecimals = Number(decimalPlaces);
  if (!Number.isInteger(rawDecimals) || rawDecimals < 0) return null;
  const decimals = Math.min(rawDecimals, MAX_RANDOM_DECIMAL_PLACES);
  const scale = 10 ** decimals;
  const low = Math.ceil(Number(min) * scale);
  const high = Math.floor(Number(max) * scale);
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low > high) return null;
  const scaled = randomIntegerInclusive(low, high);
  if (scaled === null) return null;
  return (scaled / scale).toFixed(decimals);
}

async function renderTimerResponse(template, getRandomChatters, maxLength = MAX_TIMER_RESPONSE_LENGTH) {
  let output = String(template || '');
  output = output.replace(/\$\(random\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+(\d+))?\)/gi, (match, min, max, decimals) => {
    if (decimals === undefined) {
      const value = randomIntegerInclusive(min, max);
      return value === null ? match : String(value);
    }
    const value = randomNumberInclusive(min, max, decimals);
    return value === null ? match : value;
  });

  const randomUserCount = (output.match(/\$\(randomuser\)/gi) || []).length;
  if (randomUserCount > 0) {
    if (typeof getRandomChatters !== 'function') throw new Error('$(randomuser) is unavailable because the chatter provider is not configured.');
    const randomUsers = await getRandomChatters(randomUserCount);
    if (!Array.isArray(randomUsers) || randomUsers.length < randomUserCount) throw new Error('$(randomuser) could not find enough eligible current chatters.');
    const queue = [...randomUsers];
    output = output.replace(/\$\(randomuser\)/gi, () => {
      const chatter = queue.shift();
      return String(chatter?.displayName || chatter?.login || 'viewer');
    });
  }

  return Array.from(output).slice(0, maxLength).join('').trim();
}

function createChatTimerManager({ channelName, sendMessage, sendAnnouncement = null, getStreamStatus = null, getRandomChatters = null, getEventReactionHoldStatus = null, getAutomationSpacingStatus = null, tryReserveAutomationSlot = null, getAdvancedFilterById = null, evaluateAdvancedFilter = null,
  platform = 'twitch', TimerModel = ChatTimer, channelField = 'channelName', maxResponseLength = 500,
  getSettingsOverrides = null, persistSettingsOverrides = null, isEnabled = () => true,
  canCountMessages = () => true, beforeTick = null, getDeliveryMetadata = null, reviewDeliveryChildren = null
}) {
  const normalizedChannel = String(channelName || '').toLowerCase().trim();
  const settingsKey = platform === 'twitch' ? normalizedChannel : `${platform}:${normalizedChannel}`;
  const timerKeyPrefix = platform === 'twitch' ? 'timer' : `${platform}-timer`;
  const platformOptions = { maxLength: maxResponseLength, allowAnnouncements: platform === 'twitch' };
  let cache = [];
  let settings = {
    globalStartDelaySeconds: DEFAULT_GLOBAL_START_DELAY_SECONDS, minimumSpacingSeconds: 60, lastTimerMessageAt: null
  };
  let scheduler = null;
  let checkpointTimer = null;
  let tickBusy = false;
  let lastSeenStreamId = '';
  let activityDirty = false;
  const { note: noteOwnResponse, consume: consumeOwnResponse } = createOwnResponseTracker();
  const serialize = createSerialExecutor();
  let stopping = false;
  let queuedTick = false;
  const fenceFilter = () => ({ $or: [{ schedulerFence: { $exists: false } }, { schedulerFence: { $lte: context.fence() } }] });
  const occurrenceKey = (timer) => `${timerKeyPrefix}:${normalizedChannel}:${timer._id}:${timer.scheduleStreamId}:${dateMs(timer.nextDueAt)}${timer.configurationRevision ? ':' + timer.configurationRevision : ''}`;


  function eventReactionHoldActive() {
    try {
      return Boolean(typeof getEventReactionHoldStatus === 'function' && getEventReactionHoldStatus()?.active);
    } catch (_) {
      return false;
    }
  }


  function automationSpacingStatus(timer = null) {
    let external = { active: false, remainingMs: 0 };
    try { external = getAutomationSpacingStatus?.('timer') || external; } catch (_) {}
    const remainingMs = Math.max(0, dateMs(settings.lastTimerMessageAt) + Number(settings.minimumSpacingSeconds || 0) * 1000 - Date.now());
    return { ...external, active: Boolean(external.active || remainingMs > 0),
      remainingMs: Math.max(remainingMs, Number(external.remainingMs || 0)) };
  }

  async function reserveAutomationSlot(timer) {
    if (automationSpacingStatus(timer).active) return { allowed: false };
    try {
      return typeof tryReserveAutomationSlot === 'function'
        ? await tryReserveAutomationSlot('timer')
        : { allowed: true, status: { active: false } };
    } catch (_) {
      return { allowed: false, status: { active: false } };
    }
  }

  function streamStatus() {
    const status = typeof getStreamStatus === 'function' ? (getStreamStatus() || {}) : {};
    return {
      live: status.streamLive !== undefined ? Boolean(status.streamLive) : Boolean(status.live),
      streamId: String(status.currentStreamId || status.streamId || '').trim(),
      startedAt: Number(status.twitchStreamStartedAt || status.startedAt || 0) || 0,
      viewerCount: Math.max(0, wholeNumber(status.currentViewerCount ?? status.viewerCount, 0)),
      viewerCountAvailable: status.viewerCountAvailable !== false,
      title: String(status.currentStreamTitle || status.title || '').trim(),
      category: String(status.currentStreamCategory || status.category || status.gameName || '').trim()
    };
  }

  function filterEvaluation(filterId, status = streamStatus()) {
    if (!filterId) return { exists: true, matched: true, filterId: '', filterName: '' };
    if (typeof evaluateAdvancedFilter === 'function') {
      try { return evaluateAdvancedFilter(filterId, status) || { exists: false, matched: false }; }
      catch (_) { return { exists: false, matched: false }; }
    }
    return { exists: false, matched: false, filterId, filterName: '' };
  }
  const selectionFor = (item, status = streamStatus()) => chooseResponse(item, (id) => filterEvaluation(id, status));
  const responseStatesFor = (item, status = streamStatus()) => rotation.evaluateResponses(item, (id) => filterEvaluation(id, status));



  async function loadSettings() {
    const stored = await TimerConfig.findOne({ channelName: settingsKey }).lean();
    if (!stored) {
      const created = await TimerConfig.findOneAndUpdate(
        { channelName: settingsKey },
        { $setOnInsert: { channelName: settingsKey, ...normalizeSettings({}) } },
        { ...WRITE_OPTIONS, new: true, upsert: true, setDefaultsOnInsert: true }
      ).lean();
      settings = { ...settings, ...created };
    } else {
      settings = { ...settings, ...stored };
    }
    if (getSettingsOverrides) settings = { ...settings, ...getSettingsOverrides() };
    return settings;
  }

  function scheduleForNewStream(timer, status, now = Date.now()) {
    return rotation.firstDueAt(timer, { startedAt: status.startedAt, now, globalStartDelaySeconds: settings.globalStartDelaySeconds });
  }

  async function persistSchedulePatch(timerId, patch, extra = {}) {
    await context.assertOperation();
    const result = await TimerModel.updateOne({ _id: timerId, [channelField]: normalizedChannel, ...fenceFilter(), ...extra },
      { $set: { ...patch, schedulerFence: context.fence() } }, WRITE_OPTIONS);
    if (result.matchedCount !== 1) throw context.cancelledError('Timer changed or belongs to a newer deployment.');
  }

  async function ensureScheduleForCurrentStream(timer, status, now = Date.now()) {
    if (!status.live || !status.streamId || timer.enabled === false) return timer;
    const sameStream = String(timer.scheduleStreamId || '') === status.streamId;
    const persistedDue = dateMs(timer.nextDueAt);
    const streamStartedAt = Number(status.startedAt || 0);
    const lastFiredAt = dateMs(timer.lastFiredAt);
    const firedThisStream = Boolean(streamStartedAt && lastFiredAt >= streamStartedAt) ||
      String(timer.lastCompletedOccurrence || '').startsWith(`${timerKeyPrefix}:${normalizedChannel}:${timer._id}:${status.streamId}:`);
    const attemptedThisStream = Boolean(streamStartedAt && dateMs(timer.lastAttemptAt) >= streamStartedAt);
    // A first-send failure is still a real occurrence. Refreshing the UI must
    // not pull its retry/abandonment schedule back to the start cooldown.
    if (sameStream && persistedDue > 0 && (firedThisStream || attemptedThisStream || timer.deliveryKey || timer.recoveryRequired)) return timer;

    // Legacy YouTube timers had no durable due time. Resume from their last
    // successful send, rather than firing again immediately after a deployment.
    if (!persistedDue && firedThisStream) {
      const patch = { scheduleStreamId: status.streamId, nextDueAt: new Date(Math.max(now, lastFiredAt + Number(timer.intervalSeconds) * 1000)) };
      await persistSchedulePatch(timer._id, patch); Object.assign(timer, patch); return timer;
    }
    const firstDueMs = scheduleForNewStream(timer, status, now);
    if (sameStream && persistedDue > 0 && persistedDue <= firstDueMs) return timer;
    const nextDueAt = new Date(firstDueMs);
    const patch = {
      scheduleStreamId: status.streamId,
      nextDueAt,
      ...(!sameStream ? { messagesSinceLastFire: 0, lastAttemptAt: null, lastResponseId: '', lastResponseIndex: -1, deliveryKey: '', recoveryRequired: false, recoveryReason: '' } : {}),
      retryCount: 0,
      nextRetryAt: null
    };
    await persistSchedulePatch(timer._id, patch);
    Object.assign(timer, patch);
    return timer;
  }

  async function refreshCache() {
    const previous = new Map(cache.map((timer) => [String(timer._id), timer]));
    const fresh = await TimerModel.find({ [channelField]: normalizedChannel }).sort({ createdAt: 1 }).lean();
    for (const timer of fresh) {
      const migration = rotation.migrationPatch(timer, platformOptions);
      if (migration) { await persistSchedulePatch(timer._id, migration); Object.assign(timer, migration); }
      const old = previous.get(String(timer._id));
      if (old && old.scheduleStreamId === timer.scheduleStreamId && dateMs(old.nextDueAt) === dateMs(timer.nextDueAt)) {
        timer.messagesSinceLastFire = Math.max(wholeNumber(timer.messagesSinceLastFire), wholeNumber(old.messagesSinceLastFire));
      }
    }
    cache = fresh;
    // Recover spacing even if the secondary spacing checkpoint was interrupted.
    for (const item of cache) if (dateMs(item.lastFiredAt) > dateMs(settings.lastTimerMessageAt)) {
      settings.lastTimerMessageAt = item.lastFiredAt;
    }
    const status = streamStatus();
    if (status.live && status.streamId) {
      for (const timer of cache) await ensureScheduleForCurrentStream(timer, status);
    }
    return cache;
  }

  function toClient(timer) {
    const status = streamStatus();
    const now = Date.now();
    const dueAt = dateMs(timer.nextRetryAt) || dateMs(timer.nextDueAt);
    const effectiveDelay = effectiveStartDelay(timer, settings);
    const missingMessages = Math.max(0, wholeNumber(timer.minimumChatMessages, 0) - wholeNumber(timer.messagesSinceLastFire, 0));
    const missingViewers = Math.max(0, wholeNumber(timer.minimumViewers, 0) - status.viewerCount);
    const responseStates = responseStatesFor(timer, status);
    const selection = selectionFor(timer, status);
    const automationStatus = automationSpacingStatus(timer);
    const spacingRemainingMs = Math.max(0, Number(automationStatus.remainingMs || 0));
    const startNotBefore = status.startedAt ? status.startedAt + effectiveDelay * 1000 : 0;
    const startDelayRemainingMs = status.live && startNotBefore ? Math.max(0, startNotBefore - now) : 0;

    let waitingFor = '';
    if (timer.recoveryRequired) waitingFor = 'Delivery needs review - no automatic resend';
    else if (timer.enabled === false) waitingFor = 'Timer disabled';
    else if (!isEnabled()) waitingFor = 'Platform timers inactive';
    else if (!status.live) waitingFor = 'Stream offline';
    else if (startDelayRemainingMs > 0) waitingFor = 'Stream-start delay';
    else if (dueAt > now) waitingFor = timer.nextRetryAt ? 'Retry delay' : 'Interval';
    else if (Number(timer.minimumChatMessages) > 0 && !canCountMessages()) waitingFor = 'Chat listening disabled - Min Messages cannot be met';
    else if (missingMessages > 0) waitingFor = `${missingMessages} more chat message${missingMessages === 1 ? '' : 's'}`;
    else if (Number(timer.minimumViewers) > 0 && !status.viewerCountAvailable) waitingFor = 'Viewer count unavailable';
    else if (missingViewers > 0) waitingFor = `${missingViewers} more viewer${missingViewers === 1 ? '' : 's'}`;
    else if (selection.index < 0) waitingFor = 'No eligible responses (disabled or filtered)';
    else if (automationStatus.active) waitingFor = 'Automation spacing';

    return {
      id: String(timer._id),
      recoveryRequired: timer.recoveryRequired === true,
      recoveryReason: timer.recoveryReason || '',
      deliveryKey: timer.deliveryKey || '',
      name: String(timer.name || 'Timer'),
      intervalSeconds: Number(timer.intervalSeconds || MIN_TIMER_INTERVAL_SECONDS),
      startDelaySeconds: timer.startDelaySeconds === null || timer.startDelaySeconds === undefined ? null : Number(timer.startDelaySeconds),
      effectiveStartDelaySeconds: effectiveDelay,
      minimumChatMessages: wholeNumber(timer.minimumChatMessages, 0),
      minimumViewers: wholeNumber(timer.minimumViewers, 0),
      advancedFilterId: '', responseIds: timer.responseIds || [], responseFilterIds: timer.responseFilterIds || [],
      responseEnabled: timer.responseEnabled || [], responseStates,
      eligibleResponseCount: responseStates.filter((r) => r.eligible).length, nextResponseIndex: selection.index,
      lastResponseId: timer.lastResponseId || '', rotationVersion: 1,
      priority: TIMER_PRIORITIES.includes(timer.priority) ? timer.priority : 'normal',
      jitterSeconds: wholeNumber(timer.jitterSeconds, 0),
      responses: Array.isArray(timer.responses) ? timer.responses : [],
      responseMode: 'sequential',
      responseWeights: Array.isArray(timer.responseWeights) ? timer.responseWeights : [],
      avoidImmediateRepeat: timer.responseMode === 'equal' && Array.isArray(timer.responses) && timer.responses.length >= 2 && timer.avoidImmediateRepeat === true,
      actionTypes: Array.isArray(timer.actionTypes) ? timer.actionTypes : [],
      actionColors: Array.isArray(timer.actionColors) ? timer.actionColors : [],
      enabled: timer.enabled !== false,
      scheduleStreamId: String(timer.scheduleStreamId || ''),
      lastFiredAt: timer.lastFiredAt || null,
      nextDueAt: timer.nextDueAt || null,
      nextRetryAt: timer.nextRetryAt || null,
      timesFired: wholeNumber(timer.timesFired, 0),
      lastResponse: String(timer.lastResponse || ''),
      lastResponseIndex: wholeNumber(timer.lastResponseIndex, -1),
      messagesSinceLastFire: wholeNumber(timer.messagesSinceLastFire, 0),
      retryCount: wholeNumber(timer.retryCount, 0),
      history: Array.isArray(timer.history) ? timer.history.slice(-HISTORY_LIMIT) : [],
      waitingFor,
      spacingRemainingMs,
      startDelayRemainingMs,
      currentViewerCount: status.viewerCount,
      createdAt: timer.createdAt || null,
      updatedAt: timer.updatedAt || null
    };
  }

  function isDue(timer, now) {
    const retryAt = dateMs(timer.nextRetryAt);
    if (retryAt) return now >= retryAt;
    const dueAt = dateMs(timer.nextDueAt);
    return dueAt > 0 && now >= dueAt;
  }

  function meetsEligibility(timer, status, now) {
    if (timer.recoveryRequired) return false;
    const streamStartedAt = status.startedAt || now;
    const startNotBefore = streamStartedAt + effectiveStartDelay(timer, settings) * 1000;
    if (now < startNotBefore) return false;
    if (wholeNumber(timer.messagesSinceLastFire, 0) < wholeNumber(timer.minimumChatMessages, 0)) return false;
    if (status.viewerCount < wholeNumber(timer.minimumViewers, 0)) return false;
    if (Number(timer.minimumChatMessages) > 0 && !canCountMessages()) return false;
    if (Number(timer.minimumViewers) > 0 && !status.viewerCountAvailable) return false;
    if (selectionFor(timer, status).index < 0) return false;
    if (automationSpacingStatus(timer).active) return false;
    return true;
  }

  async function updateSuccessfulFire(timer, payload, key) {
    await context.assertOperation();
    const now = new Date();
    const nextDueAt = new Date(calculateNextDueAt(timer, now.getTime()));
    const remainingMessages = Math.max(0, wholeNumber(timer.messagesSinceLastFire) - wholeNumber(payload.activityAtStart));
    const historyEntry = { firedAt: now, responseIndex: payload.selection.index, response: payload.rendered,
      actionType: payload.actionType, actionColor: payload.actionColor, reason: payload.reason };
    const patch = { lastFiredAt: now, nextDueAt, nextRetryAt: null, retryCount: 0,
      lastResponse: payload.rendered, lastResponseIndex: payload.selection.responseId ? (timer.responseIds || []).indexOf(payload.selection.responseId) : payload.selection.index,
      lastResponseId: payload.selection.responseId || timer.responseIds?.[payload.selection.index] || '',
      messagesSinceLastFire: remainingMessages, lastCompletedOccurrence: key,
      deliveryKey: '', recoveryRequired: false, recoveryReason: '', schedulerFence: context.fence() };
    const result = await TimerModel.updateOne({ _id: timer._id, [channelField]: normalizedChannel,
      scheduleStreamId: payload.streamId, nextDueAt: new Date(payload.dueAt),
      lastCompletedOccurrence: { $ne: key }, ...fenceFilter() }, {
      $set: patch, $inc: { timesFired: 1 }, $push: { history: { $each: [historyEntry], $slice: -HISTORY_LIMIT } }
    }, WRITE_OPTIONS);
    if (result.matchedCount === 1) {
      Object.assign(timer, patch, { timesFired: wholeNumber(timer.timesFired) + 1,
        history: [...(timer.history || []), historyEntry].slice(-HISTORY_LIMIT) });
    } else {
      // A receipt already applied, a deleted timer, or an explicit edit must not
      // be overwritten by an old in-flight occurrence.
      await refreshCache();
    }
    settings.lastTimerMessageAt = now;
    await TimerConfig.updateOne({ channelName: settingsKey }, { $set: { lastTimerMessageAt: now } }, WRITE_OPTIONS).catch((err) => console.warn(`[${platform} Timers] Spacing checkpoint failed: ${err.message}`));
    console.log(`[${platform} Timers] Committed occurrence ${key}; no replay of its chat send.`);
  }

  async function scheduleFailure(timer, err) {
    if (err?.cancelled || stopping || !context.isActive()) return;
    if (err?.timerSelectionBlocked) {
      const key = timer.deliveryKey || occurrenceKey(timer);
      const row = await delivery.get(key);
      if (row && ['prepared', 'not_sent'].includes(row.state)) await delivery.dismiss(key, { reason: 'Response is no longer eligible; waiting for another eligible response.' });
      const patch = { nextDueAt: new Date(Date.now() + 1000), nextRetryAt: null, retryCount: 0, deliveryKey: '' };
      await persistSchedulePatch(timer._id, patch); Object.assign(timer, patch); return;
    }
    if (err?.reviewRequired || err?.deliveryState === 'UNKNOWN') {
      const patch = { recoveryRequired: true, recoveryReason: String(err.message).slice(0, 600),
        deliveryKey: err.deliveryKey || occurrenceKey(timer), nextRetryAt: null };
      Object.assign(timer, patch);
      await persistSchedulePatch(timer._id, patch);
      console.error(`[${platform} Timers] ${timer.name} paused for delivery review. No blind retry.`);
      return;
    }
    if (err?.commitOnly) {
      timer.nextRetryAt = new Date(Date.now() + 10000);
      console.error(`[${platform} Timers] ${timer.name} was sent, but its schedule save failed. Retrying the save, not the send.`);
      return;
    }
    const currentRetryCount = wholeNumber(timer.retryCount, 0);
    const attemptAt = new Date();
    if (currentRetryCount < RETRY_DELAYS_MS.length) {
      const delayMs = RETRY_DELAYS_MS[currentRetryCount];
      const patch = {
        lastAttemptAt: attemptAt,
        retryCount: currentRetryCount + 1,
        nextRetryAt: new Date(Date.now() + delayMs)
      };
      Object.assign(timer, patch);
      await persistSchedulePatch(timer._id, patch);
      console.warn(`[${platform} Timers] ${timer.name} send failed; retry ${currentRetryCount + 1}/${RETRY_DELAYS_MS.length} in ${Math.round(delayMs / 1000)}s: ${err?.message || err}`);
      return;
    }

    const oldKey = timer.deliveryKey;
    if (oldKey) { const row = await delivery.get(oldKey); if (row && ['prepared', 'not_sent'].includes(row.state)) await delivery.dismiss(oldKey, { reason: 'Send retries exhausted.' }); }
    const nextDueAt = new Date(calculateNextDueAt(timer));
    const patch = {
      deliveryKey: '',
      lastAttemptAt: attemptAt,
      retryCount: 0,
      nextRetryAt: null,
      nextDueAt
    };
    await persistSchedulePatch(timer._id, patch);
    Object.assign(timer, patch);
    console.error(`[${platform} Timers] ${timer.name} failed after ${RETRY_DELAYS_MS.length} retries; this occurrence was abandoned. Next regular occurrence is ${nextDueAt.toISOString()}:`, err?.message || err);
  }

  async function sendSelected(timer, { reason = 'scheduled', affectSchedule = true } = {}) {
    if (timer.recoveryRequired) throw new Error('This timer needs delivery review before another send.');
    await context.assertOperation();
    const key = affectSchedule ? (timer.deliveryKey || occurrenceKey(timer)) : `${timerKeyPrefix}-test:${normalizedChannel}:${timer._id}:${randomUUID()}`;
    if (affectSchedule && !timer.deliveryKey) { await persistSchedulePatch(timer._id, { deliveryKey: key }); timer.deliveryKey = key; }
    const existing = await delivery.get(key);
    let payload = existing?.payload;
    if (!existing) {
    const selection = selectionFor(timer);
    if (!selection.template) throw Object.assign(new Error(`${timer.name} has no eligible response.`), { timerSelectionBlocked: true, deliveryState: 'NOT_SENT' });
    const rendered = await renderTimerResponse(selection.template, getRandomChatters, maxResponseLength);
    if (!rendered) throw new Error(`${timer.name} rendered an empty action message.`);
    const actionType = TIMER_ACTION_TYPES.includes(timer.actionTypes?.[selection.index]) ? timer.actionTypes[selection.index] : 'chat_message';
    const actionColor = TIMER_ANNOUNCEMENT_COLORS.includes(timer.actionColors?.[selection.index]) ? timer.actionColors[selection.index] : 'primary';
    payload = { selection, rendered, actionType, actionColor, reason,
      ...(getDeliveryMetadata ? getDeliveryMetadata() : {}),
      channelName: normalizedChannel, platform, configurationRevision: timer.configurationRevision,
      streamId: timer.scheduleStreamId, dueAt: dateMs(timer.nextDueAt),
      activityAtStart: wholeNumber(timer.messagesSinceLastFire) };
    }
    const receipt = await delivery.deliver({ key, kind: timerKeyPrefix, payload, send: async (saved) => {
      const status = streamStatus();
      if (stopping || (affectSchedule && (!status.live || status.streamId !== saved.streamId))) {
        throw Object.assign(context.cancelledError('Timer stream changed before send.'), { deliveryState: 'NOT_SENT' });
      }
      const current = responseStatesFor(timer, status).find((r) => saved.selection.responseId ? r.id === saved.selection.responseId : r.index === saved.selection.index);
      if (!isEnabled() || timer.enabled === false || (saved.configurationRevision && timer.configurationRevision !== saved.configurationRevision) || !current?.eligible) {
        throw Object.assign(new Error('Timer response is no longer eligible.'), { deliveryState: 'NOT_SENT', timerSelectionBlocked: true });
      }
      if (saved.actionType === 'twitch_announcement') {
        if (typeof sendAnnouncement !== 'function') throw Object.assign(new Error('Announcements are unavailable.'), { deliveryState: 'NOT_SENT' });
        return sendAnnouncement(saved.rendered, { color: saved.actionColor });
      }
      noteOwnResponse(saved.rendered);
      return sendMessage(normalizedChannel, saved.rendered, { timerDelivery: saved, deliveryKey: key });
    } });
    if (affectSchedule) {
      try { await updateSuccessfulFire(timer, receipt.payload, key); }
      catch (err) { err.commitOnly = true; throw err; }
    }
    const sent = receipt.payload;
    return { rendered: sent.rendered, responseIndex: sent.selection.index, responseMode: sent.selection.mode,
      actionType: sent.actionType, actionColor: sent.actionColor, replayed: receipt.replayed };
  }

  async function runScheduledTimer(timer) {
    try {
      const reservation = await reserveAutomationSlot(timer);
      if (!reservation?.allowed) return;
      if (eventReactionHoldActive()) return;
      await persistSchedulePatch(timer._id, { lastAttemptAt: new Date() });
      await sendSelected(timer, { reason: 'scheduled', affectSchedule: true });
    } catch (err) {
      await scheduleFailure(timer, err);
    }
  }

  async function tick() {
    if (tickBusy || stopping || !context.isActive() || !isEnabled()) return;
    tickBusy = true;
    try {
      // The scheduler wakes once per second so due timers stay responsive, but
      // an idle/offline tick must remain network-silent. Ownership is asserted
      // immediately before any durable state change/send by the downstream
      // reservation/persistence/delivery paths.
      if (beforeTick && cache.some((item) => item.enabled !== false && Number(item.minimumViewers) > 0 && isDue(item, Date.now()))) await beforeTick();
      const status = streamStatus();
      if (!status.live || !status.streamId) {
        lastSeenStreamId = '';
        return;
      }

      if (status.streamId !== lastSeenStreamId) {
        lastSeenStreamId = status.streamId;
        await refreshCache();
      }

      if (eventReactionHoldActive()) return;

      const now = Date.now();
      const candidates = cache
        .filter((timer) => timer.enabled !== false && isDue(timer, now) && meetsEligibility(timer, status, now))
        .sort((a, b) => {
          const p = priorityRank(a.priority) - priorityRank(b.priority);
          if (p !== 0) return p;
          const aDue = dateMs(a.nextRetryAt) || dateMs(a.nextDueAt);
          const bDue = dateMs(b.nextRetryAt) || dateMs(b.nextDueAt);
          if (aDue !== bDue) return aDue - bDue;
          return dateMs(a.createdAt) - dateMs(b.createdAt);
        });

      if (candidates.length) await runScheduledTimer(candidates[0]);
    } finally {
      tickBusy = false;
    }
  }

  async function checkpointActivity({ force = false } = {}) {
    if (!force && !context.isActive()) return;
    if (!activityDirty || !cache.length) return;
    activityDirty = false;
    try {
      const operations = cache
        .filter((timer) => timer.enabled !== false)
        .map((timer) => ({
          updateOne: {
            filter: { _id: timer._id, [channelField]: normalizedChannel, scheduleStreamId: timer.scheduleStreamId, nextDueAt: timer.nextDueAt, ...fenceFilter() },
            update: { $set: { messagesSinceLastFire: wholeNumber(timer.messagesSinceLastFire, 0) } }
          }
        }));
      if (operations.length) await TimerModel.bulkWrite(operations, { ...WRITE_OPTIONS, ordered: false });
    } catch (err) {
      activityDirty = true;
      console.error('[Timers] Could not checkpoint chat-activity counters:', err?.message || err);
      if (force) throw err;
    }
  }

  function recordViewerActivity() {
    if (stopping || !context.isActive()) return;
    const status = streamStatus();
    if (!status.live || !status.streamId) return;
    for (const timer of cache) {
      if (timer.enabled === false || wholeNumber(timer.minimumChatMessages, 0) <= 0) continue;
      timer.messagesSinceLastFire = wholeNumber(timer.messagesSinceLastFire, 0) + 1;
    }
    activityDirty = true;
  }

  async function initialize() {
    stopping = false;
    await context.assertOperation();
    await TimerModel.updateMany({ [channelField]: normalizedChannel, ...fenceFilter() },
      { $set: { schedulerFence: context.fence() } }, WRITE_OPTIONS);
    await TimerConfig.updateOne({ channelName: settingsKey, ...fenceFilter() },
      { $set: { schedulerFence: context.fence() } }, WRITE_OPTIONS);
    await loadSettings();
    await refreshCache();
    if (!scheduler) scheduler = context.detached(() => setInterval(() => {
      if (queuedTick || stopping) return;
      queuedTick = true;
      serialize(tick).catch((err) => console.error('[Timers] Tick failed:', err.message)).finally(() => { queuedTick = false; });
    }, SCHEDULER_TICK_MS));
    if (!checkpointTimer) checkpointTimer = context.detached(() => setInterval(() => { serialize(checkpointActivity).catch((err) => console.error('[Timers] Checkpoint failed:', err.message)); }, ACTIVITY_CHECKPOINT_MS));
    console.log(`[${platform} Timers] Loaded ${cache.length} timer(s) from MongoDB. Global start delay ${settings.globalStartDelaySeconds}s.`);
  }

  async function listTimers() {
    await loadSettings();
    await refreshCache();
    return cache.map(toClient);
  }

  async function getSettings() {
    await loadSettings();
    return {
      globalStartDelaySeconds: wholeNumber(settings.globalStartDelaySeconds, DEFAULT_GLOBAL_START_DELAY_SECONDS),
      minimumSpacingSeconds: Number(settings.minimumSpacingSeconds ?? 60)
    };
  }

  async function saveSettings(input = {}) {
    await context.assertOperation();
    const normalized = normalizeSettings(input);
    const saved = await TimerConfig.findOneAndUpdate(
      { channelName: settingsKey, ...fenceFilter() },
      { $set: { ...normalized, schedulerFence: context.fence() }, $setOnInsert: { channelName: settingsKey } },
      { ...WRITE_OPTIONS, new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();
    if (normalized.globalStartDelaySeconds > 0) {
      const adjusted = await TimerModel.updateMany(
        {
          [channelField]: normalizedChannel,
          ...fenceFilter(), startDelaySeconds: { $ne: null, $lt: normalized.globalStartDelaySeconds }
        },
        { $set: { startDelaySeconds: normalized.globalStartDelaySeconds, schedulerFence: context.fence() } }, WRITE_OPTIONS
      );
      if (adjusted?.modifiedCount) {
        console.log(`[${platform} Timers] Raised ${adjusted.modifiedCount} per-timer start-delay override(s) to match the new global minimum.`);
      }
    }
    if (persistSettingsOverrides) await persistSettingsOverrides(normalized);
    settings = { ...settings, ...saved };
    await refreshCache();
    console.log(`[${platform} Timers] Updated settings: start delay ${normalized.globalStartDelaySeconds}s.`);
    return getSettings();
  }

  async function settleBeforeEdit(id) {
    const item = cache.find((r) => String(r._id) === String(id));
    if (!item?.deliveryKey) return;
    const record = await delivery.get(item.deliveryKey);
    if (record?.state === 'sent' && !record.recoveryClosed) await updateSuccessfulFire(item, record.payload, item.deliveryKey);
    else if (record && ['prepared', 'not_sent'].includes(record.state) && !record.recoveryClosed) {
      await delivery.dismiss(item.deliveryKey, { reason: 'Timer edited or toggled before delivery.' });
      await persistSchedulePatch(item._id, { deliveryKey: '' }); item.deliveryKey = '';
    } else if (record && !record.recoveryClosed) throw new Error('Resolve or dismiss this timer delivery in Recovery before editing it.');
  }

  async function saveTimer(input = {}) {
    await context.assertOperation();
    await loadSettings();
    const normalized = normalizeInput(input, settings, platformOptions);
    normalized.configurationRevision = randomUUID();
    for (const id of new Set(normalized.responseFilterIds.filter(Boolean))) {
      if (!getAdvancedFilterById?.(id)) throw new Error('Selected Advanced Filter was not found. Refresh and choose another filter.');
    }
    const id = String(input.id || '').trim();
    if (id) await settleBeforeEdit(id);
    let saved;
    if (id) {
      saved = await TimerModel.findOneAndUpdate(
        { _id: id, [channelField]: normalizedChannel, ...fenceFilter() },
        { $set: { ...normalized, schedulerFence: context.fence() } },
        { ...WRITE_OPTIONS, new: true, runValidators: true }
      );
      if (!saved) throw new Error('Timer was not found.');
    } else {
      [saved] = await TimerModel.create([{ [channelField]: normalizedChannel, schedulerFence: context.fence(), ...normalized }], WRITE_OPTIONS);
    }

    await refreshCache();
    const cached = cache.find((item) => String(item._id) === String(saved._id));
    const status = streamStatus();
    if (cached && status.live && status.streamId) {
      const fired = dateMs(cached.lastFiredAt) >= status.startedAt && status.startedAt > 0;
      const nextDueAt = new Date(fired ? Math.max(Date.now(), dateMs(cached.lastFiredAt) + cached.intervalSeconds * 1000) : scheduleForNewStream(cached, status));
      const patch = { scheduleStreamId: status.streamId, nextDueAt, retryCount: 0, nextRetryAt: null, messagesSinceLastFire: 0 };
      await persistSchedulePatch(cached._id, patch);
      Object.assign(cached, patch);
    }
    console.log(`[${platform} Timers] ${id ? 'Updated' : 'Created'} timer ${normalized.name}.`);
    return toClient(cached || saved.toObject());
  }

  async function deleteTimer(id) {
    await context.assertOperation();
    const deleted = await TimerModel.findOneAndDelete({ _id: id, [channelField]: normalizedChannel, ...fenceFilter() }, WRITE_OPTIONS);
    if (!deleted) throw new Error('Timer was not found.');
    await refreshCache();
    console.log(`[${platform} Timers] Deleted timer ${deleted.name}.`);
  }

  async function setEnabled(id, enabled) {
    await context.assertOperation();
    await settleBeforeEdit(id);
    const saved = await TimerModel.findOneAndUpdate(
      { _id: id, [channelField]: normalizedChannel, ...fenceFilter() },
      { $set: { enabled: Boolean(enabled), retryCount: 0, nextRetryAt: null, schedulerFence: context.fence() } },
      { ...WRITE_OPTIONS, new: true, runValidators: true }
    );
    if (!saved) throw new Error('Timer was not found.');
    await refreshCache();
    const cached = cache.find((item) => String(item._id) === String(saved._id));
    const status = streamStatus();
    if (cached && cached.enabled !== false && status.live && status.streamId) {
      const fired = dateMs(cached.lastFiredAt) >= status.startedAt && status.startedAt > 0;
      const nextDueAt = new Date(fired ? Math.max(Date.now(), dateMs(cached.lastFiredAt) + cached.intervalSeconds * 1000) : scheduleForNewStream(cached, status));
      const patch = { scheduleStreamId: status.streamId, nextDueAt, messagesSinceLastFire: 0 };
      await persistSchedulePatch(cached._id, patch);
      Object.assign(cached, patch);
    }
    console.log(`[${platform} Timers] ${saved.enabled ? 'Enabled' : 'Disabled'} timer ${saved.name}.`);
    return toClient(cached || saved.toObject());
  }

  async function findTimerOrThrow(id) {
    await refreshCache();
    const timer = cache.find((item) => String(item._id) === String(id));
    if (!timer) throw new Error('Timer was not found.');
    return timer;
  }

  async function previewTimer(id) {
    const timer = await findTimerOrThrow(id);
    const selection = selectionFor(timer);
    if (!selection.template) throw new Error('Timer has no selectable action.');
    const rendered = await renderTimerResponse(selection.template, getRandomChatters, maxResponseLength);
    return { rendered, responseIndex: selection.index, responseMode: selection.mode, actionType: TIMER_ACTION_TYPES.includes(timer.actionTypes?.[selection.index]) ? timer.actionTypes[selection.index] : 'chat_message', actionColor: TIMER_ANNOUNCEMENT_COLORS.includes(timer.actionColors?.[selection.index]) ? timer.actionColors[selection.index] : 'primary' };
  }

  async function testTimer(id) {
    await context.assertOperation();
    const timer = await findTimerOrThrow(id);
    const result = await sendSelected(timer, { reason: 'scheduled', affectSchedule: false });
    console.log(`[${platform} Timers] Test sent for ${timer.name}; schedule and history were not changed.`);
    return result;
  }

  async function fireNow(id) {
    await context.assertOperation();
    const timer = await findTimerOrThrow(id);
    const status = streamStatus();
    if (!isEnabled() || timer.enabled === false) throw new Error('Timer or platform is disabled.');
    if (!status.live || !status.streamId) throw new Error('Fire Now is only available while Qwert is live. Use Test for an offline send check.');
    const result = await sendSelected(timer, { reason: 'manual', affectSchedule: true });
    console.log(`[${platform} Timers] Fire Now sent for ${timer.name} and reset its timer schedule.`);
    return result;
  }

  function quiesce() {
    stopping = true;
    if (scheduler) clearInterval(scheduler);
    if (checkpointTimer) clearInterval(checkpointTimer);
    scheduler = null; checkpointTimer = null;
  }
  async function dismissReview(id, expectedDeliveryKey) {
    const timer = await findTimerOrThrow(id);
    if (!expectedDeliveryKey || timer.deliveryKey !== expectedDeliveryKey) throw new Error('This timer occurrence changed. Refresh before dismissing it.');
    const pending = await delivery.get(expectedDeliveryKey);
    if (reviewDeliveryChildren && pending) await reviewDeliveryChildren(expectedDeliveryKey, pending.payload, 'dismiss');
    const record = await delivery.dismiss(expectedDeliveryKey);
    if (!record) throw new Error('Delivery changed. Refresh the page.');
    // Skip one occurrence. Do not pretend it fired or increment sent counters.
    const oldSession = record.payload?.streamId && record.payload.streamId !== timer.scheduleStreamId;
    const patch = { recoveryRequired: false, recoveryReason: '', deliveryKey: '',
      nextRetryAt: null, retryCount: 0,
      ...(!oldSession ? { lastCompletedOccurrence: expectedDeliveryKey, nextDueAt: new Date(calculateNextDueAt(timer)) } : {}) };
    await persistSchedulePatch(timer._id, patch); Object.assign(timer, patch);
    return { success: true, message: 'Timer occurrence dismissed. Its next normal interval remains scheduled.' };
  }
  async function expireRecovery(status) {
    if (!cache.some((timer) => timer.recoveryRequired && timer.deliveryKey)) return;
    await refreshCache();
    for (const timer of cache) {
      if (!timer.recoveryRequired || !timer.deliveryKey) continue;
      const row = await delivery.get(timer.deliveryKey);
      const reason = row && staleDeliveryReason(row, typeof getStreamStatus === 'function' ? getStreamStatus() : status);
      if (delivery.isInFlight(timer.deliveryKey)) continue;
      if (!reason) {
        if (row?.recoveryClosed) await dismissReview(String(timer._id), timer.deliveryKey);
        continue;
      }
      await delivery.dismiss(timer.deliveryKey, { reason, resolution: 'expired' });
      const patch = { recoveryRequired: false, recoveryReason: '', deliveryKey: '', nextRetryAt: null, retryCount: 0 };
      await persistSchedulePatch(timer._id, patch); Object.assign(timer, patch);
    }
  }

  async function resolveReview(id, outcome, expectedDeliveryKey) {
    const timer = await findTimerOrThrow(id);
    if (expectedDeliveryKey !== undefined && timer.deliveryKey !== expectedDeliveryKey) throw new Error('This timer occurrence changed. Refresh before reviewing it.');
    if (!timer.deliveryKey) throw new Error('Timer has no pending delivery review.');
    const pending = await delivery.get(timer.deliveryKey);
    if (reviewDeliveryChildren && pending) await reviewDeliveryChildren(timer.deliveryKey, pending.payload, outcome);
    const record = await delivery.resolve(timer.deliveryKey, outcome);
    if (!record) throw new Error('Delivery was already resolved or changed. Refresh the page.');
    const key = timer.deliveryKey;
    const patch = { recoveryRequired: false, recoveryReason: '', deliveryKey: '' };
    await persistSchedulePatch(timer._id, patch); Object.assign(timer, patch);
    if (outcome === 'sent') await updateSuccessfulFire(timer, record.payload, key);
    else { timer.nextRetryAt = new Date(Date.now() + 60000); await persistSchedulePatch(timer._id, { nextRetryAt: timer.nextRetryAt }); }
    return toClient(timer);
  }

  return {
    quiesce,
    shutdown: () => { quiesce(); return serialize(() => checkpointActivity({ force: true })); },
    dismissReview: (...args) => serialize(() => dismissReview(...args)),
    expireRecovery: (...args) => serialize(() => expireRecovery(...args)),
    resolveReview: (...args) => serialize(() => resolveReview(...args)),
    initialize: () => serialize(initialize),
    tick: () => serialize(tick),
    reloadSettings: () => serialize(async () => { await loadSettings(); await refreshCache(); }),
    listTimers: (...args) => serialize(() => listTimers(...args)),
    getSettings: (...args) => serialize(() => getSettings(...args)),
    saveSettings: (...args) => serialize(() => saveSettings(...args)),
    saveTimer: (...args) => serialize(() => saveTimer(...args)),
    deleteTimer: (...args) => serialize(() => deleteTimer(...args)),
    setEnabled: (...args) => serialize(() => setEnabled(...args)),
    previewTimer: (...args) => serialize(() => previewTimer(...args)),
    testTimer: (...args) => serialize(() => testTimer(...args)),
    fireNow: (...args) => serialize(() => fireNow(...args)),
    recordViewerActivity,
    consumeOwnResponse,
    refreshCache: () => serialize(refreshCache)
  };
}

module.exports = {
  MAX_TIMER_NAME_LENGTH,
  MIN_TIMER_INTERVAL_SECONDS,
  MAX_TIMER_INTERVAL_SECONDS,
  MAX_TIMER_RESPONSES,
  MAX_TIMER_RESPONSE_LENGTH,
  MAX_START_DELAY_SECONDS,
  MAX_JITTER_SECONDS,
  MAX_MINIMUM_CHAT_MESSAGES,
  MAX_MINIMUM_VIEWERS,
  DEFAULT_GLOBAL_START_DELAY_SECONDS,
  TIMER_RESPONSE_MODES,
  TIMER_PRIORITIES,
  TIMER_ACTION_TYPES,
  TIMER_ANNOUNCEMENT_COLORS,
  createChatTimerManager, normalizeInput, chooseResponse, calculateNextDueAt
};
