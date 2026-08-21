const ChatTimer = require('../models/ChatTimer');
const TimerConfig = require('../models/TimerConfig');

const MAX_TIMER_NAME_LENGTH = 80;
const MIN_TIMER_INTERVAL_SECONDS = 30;
const MAX_TIMER_INTERVAL_SECONDS = 86400;
const MAX_TIMER_RESPONSES = 25;
const MAX_TIMER_RESPONSE_LENGTH = 500;
const TIMER_RESPONSE_MODES = ['equal', 'weighted'];
const TIMER_PRIORITIES = ['high', 'normal', 'low'];
const MAX_START_DELAY_SECONDS = 86400;
const MAX_JITTER_SECONDS = 86400;
const MAX_MINIMUM_CHAT_MESSAGES = 100000;
const MAX_MINIMUM_VIEWERS = 1000000;
const DEFAULT_GLOBAL_START_DELAY_SECONDS = 0;
const SCHEDULER_TICK_MS = 1000;
const ACTIVITY_CHECKPOINT_MS = 60 * 1000;
const OWN_RESPONSE_TTL_MS = 15000;
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

  return { globalStartDelaySeconds };
}

function normalizeInput(input = {}, settings = {}) {
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

  const jitterSeconds = wholeNumber(input.jitterSeconds, 0);
  if (jitterSeconds < 0 || jitterSeconds > MAX_JITTER_SECONDS) {
    throw new Error(`Random timing variation must be between 0 and ${MAX_JITTER_SECONDS} seconds.`);
  }

  const priority = TIMER_PRIORITIES.includes(String(input.priority || '').toLowerCase())
    ? String(input.priority).toLowerCase()
    : 'normal';

  const responses = Array.isArray(input.responses)
    ? input.responses.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (responses.length < 1 || responses.length > MAX_TIMER_RESPONSES) {
    throw new Error(`Add between 1 and ${MAX_TIMER_RESPONSES} timer responses.`);
  }
  if (responses.some((value) => value.length > MAX_TIMER_RESPONSE_LENGTH)) {
    throw new Error(`Each timer response can contain at most ${MAX_TIMER_RESPONSE_LENGTH} characters.`);
  }

  const responseMode = TIMER_RESPONSE_MODES.includes(String(input.responseMode || '').toLowerCase())
    ? String(input.responseMode).toLowerCase()
    : 'equal';

  const responseWeights = responses.map((_, index) => {
    if (responseMode !== 'weighted') return 1;
    const value = Number(input.responseWeights?.[index] ?? 1);
    if (!Number.isFinite(value) || value <= 0) throw new Error('Specified Weight values must be greater than 0.');
    return value;
  });

  return {
    name,
    intervalSeconds: Math.round(intervalSeconds * 1000) / 1000,
    startDelaySeconds,
    minimumChatMessages,
    minimumViewers,
    jitterSeconds,
    priority,
    responses,
    responseMode,
    responseWeights,
    enabled: input.enabled !== false
  };
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

function calculateNextDueAt(timer, now = Date.now()) {
  const intervalMs = Math.max(MIN_TIMER_INTERVAL_SECONDS, finiteNumber(timer?.intervalSeconds, MIN_TIMER_INTERVAL_SECONDS)) * 1000;
  return now + Math.max(MIN_TIMER_INTERVAL_SECONDS * 1000, intervalMs + randomJitterMs(timer));
}

function chooseResponse(timer) {
  const responses = Array.isArray(timer.responses) ? timer.responses.filter(Boolean) : [];
  if (!responses.length) return { template: '', index: -1, mode: 'equal' };

  const mode = TIMER_RESPONSE_MODES.includes(timer.responseMode) ? timer.responseMode : 'equal';
  if (mode === 'weighted') {
    const weights = responses.map((_, index) => {
      const value = Number(timer.responseWeights?.[index] ?? 1);
      return Number.isFinite(value) && value > 0 ? value : 0;
    });
    const total = weights.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return { template: '', index: -1, mode };
    let roll = Math.random() * total;
    for (let index = 0; index < responses.length; index += 1) {
      roll -= weights[index];
      if (roll < 0) return { template: responses[index], index, mode };
    }
    return { template: responses[responses.length - 1], index: responses.length - 1, mode };
  }

  const index = Math.floor(Math.random() * responses.length);
  return { template: responses[index], index, mode };
}

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

async function renderTimerResponse(template, getRandomChatters) {
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

  return Array.from(output).slice(0, MAX_TIMER_RESPONSE_LENGTH).join('').trim();
}

function createChatTimerManager({ channelName, sendMessage, getStreamStatus = null, getRandomChatters = null, getEventReactionHoldStatus = null, getAutomationSpacingStatus = null, tryReserveAutomationSlot = null }) {
  const normalizedChannel = String(channelName || '').toLowerCase().trim();
  let cache = [];
  let settings = {
    globalStartDelaySeconds: DEFAULT_GLOBAL_START_DELAY_SECONDS
  };
  let scheduler = null;
  let checkpointTimer = null;
  let tickBusy = false;
  let lastSeenStreamId = '';
  let activityDirty = false;
  const ownResponses = [];


  function eventReactionHoldActive() {
    try {
      return Boolean(typeof getEventReactionHoldStatus === 'function' && getEventReactionHoldStatus()?.active);
    } catch (_) {
      return false;
    }
  }


  function automationSpacingStatus() {
    try {
      return typeof getAutomationSpacingStatus === 'function'
        ? (getAutomationSpacingStatus('timer') || { active: false })
        : { active: false };
    } catch (_) {
      return { active: false };
    }
  }

  async function reserveAutomationSlot() {
    try {
      return typeof tryReserveAutomationSlot === 'function'
        ? await tryReserveAutomationSlot('timer')
        : { allowed: true, status: { active: false } };
    } catch (_) {
      return { allowed: true, status: { active: false } };
    }
  }

  function streamStatus() {
    const status = typeof getStreamStatus === 'function' ? (getStreamStatus() || {}) : {};
    return {
      live: status.streamLive !== undefined ? Boolean(status.streamLive) : Boolean(status.live),
      streamId: String(status.currentStreamId || status.streamId || '').trim(),
      startedAt: Number(status.twitchStreamStartedAt || status.startedAt || 0) || 0,
      viewerCount: Math.max(0, wholeNumber(status.currentViewerCount ?? status.viewerCount, 0))
    };
  }

  function cleanupOwnResponses() {
    const cutoff = Date.now() - OWN_RESPONSE_TTL_MS;
    while (ownResponses.length && ownResponses[0].createdAt < cutoff) ownResponses.shift();
  }

  function noteOwnResponse(message) {
    cleanupOwnResponses();
    ownResponses.push({ message: String(message || '').trim(), createdAt: Date.now() });
  }

  function consumeOwnResponse(message) {
    cleanupOwnResponses();
    const normalized = String(message || '').trim();
    const index = ownResponses.findIndex((entry) => entry.message === normalized);
    if (index === -1) return false;
    ownResponses.splice(index, 1);
    return true;
  }

  async function loadSettings() {
    const stored = await TimerConfig.findOne({ channelName: normalizedChannel }).lean();
    if (!stored) {
      const created = await TimerConfig.findOneAndUpdate(
        { channelName: normalizedChannel },
        { $setOnInsert: { channelName: normalizedChannel, ...normalizeSettings({}) } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      ).lean();
      settings = { ...settings, ...created };
    } else {
      settings = { ...settings, ...stored };
    }
    return settings;
  }

  function scheduleForNewStream(timer, status, now = Date.now()) {
    const streamStartedAt = status.startedAt || now;
    const notBefore = streamStartedAt + effectiveStartDelay(timer, settings) * 1000;
    const normalFirstDue = streamStartedAt + Math.max(MIN_TIMER_INTERVAL_SECONDS, finiteNumber(timer.intervalSeconds, MIN_TIMER_INTERVAL_SECONDS)) * 1000 + randomJitterMs(timer);
    return Math.max(now, notBefore, normalFirstDue);
  }

  async function persistSchedulePatch(timerId, patch) {
    await ChatTimer.updateOne({ _id: timerId, channelName: normalizedChannel }, { $set: patch });
  }

  async function ensureScheduleForCurrentStream(timer, status, now = Date.now()) {
    if (!status.live || !status.streamId || timer.enabled === false) return timer;
    const sameStream = String(timer.scheduleStreamId || '') === status.streamId;
    const persistedDue = dateMs(timer.nextDueAt);
    if (sameStream && persistedDue > 0) return timer;

    const nextDueAt = new Date(scheduleForNewStream(timer, status, now));
    const patch = {
      scheduleStreamId: status.streamId,
      nextDueAt,
      messagesSinceLastFire: 0,
      retryCount: 0,
      nextRetryAt: null
    };
    Object.assign(timer, patch);
    await persistSchedulePatch(timer._id, patch);
    return timer;
  }

  async function refreshCache() {
    cache = await ChatTimer.find({ channelName: normalizedChannel }).sort({ createdAt: 1 }).lean();
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
    const automationStatus = automationSpacingStatus();
    const spacingRemainingMs = Math.max(0, Number(automationStatus.remainingMs || 0));
    const startNotBefore = status.startedAt ? status.startedAt + effectiveDelay * 1000 : 0;
    const startDelayRemainingMs = status.live && startNotBefore ? Math.max(0, startNotBefore - now) : 0;

    let waitingFor = '';
    if (!status.live) waitingFor = 'Stream offline';
    else if (startDelayRemainingMs > 0) waitingFor = 'Stream-start delay';
    else if (dueAt > now) waitingFor = timer.nextRetryAt ? 'Retry delay' : 'Interval';
    else if (missingMessages > 0) waitingFor = `${missingMessages} more chat message${missingMessages === 1 ? '' : 's'}`;
    else if (missingViewers > 0) waitingFor = `${missingViewers} more viewer${missingViewers === 1 ? '' : 's'}`;
    else if (automationStatus.active) waitingFor = 'Automation spacing';

    return {
      id: String(timer._id),
      name: String(timer.name || 'Timer'),
      intervalSeconds: Number(timer.intervalSeconds || MIN_TIMER_INTERVAL_SECONDS),
      startDelaySeconds: timer.startDelaySeconds === null || timer.startDelaySeconds === undefined ? null : Number(timer.startDelaySeconds),
      effectiveStartDelaySeconds: effectiveDelay,
      minimumChatMessages: wholeNumber(timer.minimumChatMessages, 0),
      minimumViewers: wholeNumber(timer.minimumViewers, 0),
      priority: TIMER_PRIORITIES.includes(timer.priority) ? timer.priority : 'normal',
      jitterSeconds: wholeNumber(timer.jitterSeconds, 0),
      responses: Array.isArray(timer.responses) ? timer.responses : [],
      responseMode: TIMER_RESPONSE_MODES.includes(timer.responseMode) ? timer.responseMode : 'equal',
      responseWeights: Array.isArray(timer.responseWeights) ? timer.responseWeights : [],
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
    const streamStartedAt = status.startedAt || now;
    const startNotBefore = streamStartedAt + effectiveStartDelay(timer, settings) * 1000;
    if (now < startNotBefore) return false;
    if (wholeNumber(timer.messagesSinceLastFire, 0) < wholeNumber(timer.minimumChatMessages, 0)) return false;
    if (status.viewerCount < wholeNumber(timer.minimumViewers, 0)) return false;
    if (automationSpacingStatus().active) return false;
    return true;
  }

  async function updateSuccessfulFire(timer, selection, rendered, reason = 'scheduled') {
    const now = new Date();
    const nextDueAt = new Date(calculateNextDueAt(timer, now.getTime()));
    const historyEntry = { firedAt: now, responseIndex: selection.index, response: rendered, reason };
    const currentHistory = Array.isArray(timer.history) ? timer.history : [];
    const nextHistory = [...currentHistory, historyEntry].slice(-HISTORY_LIMIT);
    const patch = {
      lastFiredAt: now,
      nextDueAt,
      nextRetryAt: null,
      retryCount: 0,
      timesFired: wholeNumber(timer.timesFired, 0) + 1,
      lastResponse: rendered,
      lastResponseIndex: selection.index,
      messagesSinceLastFire: 0,
      history: nextHistory
    };
    Object.assign(timer, patch);
    await persistSchedulePatch(timer._id, patch);
    activityDirty = false;
    console.log(`[Timers] Sent ${timer.name} -> response ${selection.index + 1}/${timer.responses.length} (${selection.mode}); next eligibility ${nextDueAt.toISOString()}.`);
  }

  async function scheduleFailure(timer, err) {
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
      console.warn(`[Timers] ${timer.name} send failed; retry ${currentRetryCount + 1}/${RETRY_DELAYS_MS.length} in ${Math.round(delayMs / 1000)}s: ${err?.message || err}`);
      return;
    }

    const nextDueAt = new Date(calculateNextDueAt(timer));
    const patch = {
      lastAttemptAt: attemptAt,
      retryCount: 0,
      nextRetryAt: null,
      nextDueAt
    };
    Object.assign(timer, patch);
    await persistSchedulePatch(timer._id, patch);
    console.error(`[Timers] ${timer.name} failed after ${RETRY_DELAYS_MS.length} retries; this occurrence was abandoned. Next regular occurrence is ${nextDueAt.toISOString()}:`, err?.message || err);
  }

  async function sendSelected(timer, { reason = 'scheduled', affectSchedule = true } = {}) {
    const selection = chooseResponse(timer);
    if (!selection.template) throw new Error(`${timer.name} has no selectable response.`);
    const rendered = await renderTimerResponse(selection.template, getRandomChatters);
    if (!rendered) throw new Error(`${timer.name} rendered an empty response.`);
    noteOwnResponse(rendered);
    await sendMessage(normalizedChannel, rendered);
    if (affectSchedule) await updateSuccessfulFire(timer, selection, rendered, reason);
    return { rendered, responseIndex: selection.index, responseMode: selection.mode };
  }

  async function runScheduledTimer(timer) {
    try {
      const reservation = await reserveAutomationSlot();
      if (!reservation?.allowed) return;
      if (eventReactionHoldActive()) return;
      await persistSchedulePatch(timer._id, { lastAttemptAt: new Date() });
      await sendSelected(timer, { reason: 'scheduled', affectSchedule: true });
    } catch (err) {
      await scheduleFailure(timer, err);
    }
  }

  async function tick() {
    if (tickBusy) return;
    tickBusy = true;
    try {
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

  async function checkpointActivity() {
    if (!activityDirty || !cache.length) return;
    activityDirty = false;
    try {
      const operations = cache
        .filter((timer) => timer.enabled !== false)
        .map((timer) => ({
          updateOne: {
            filter: { _id: timer._id, channelName: normalizedChannel },
            update: { $set: { messagesSinceLastFire: wholeNumber(timer.messagesSinceLastFire, 0) } }
          }
        }));
      if (operations.length) await ChatTimer.bulkWrite(operations, { ordered: false });
    } catch (err) {
      activityDirty = true;
      console.error('[Timers] Could not checkpoint chat-activity counters:', err?.message || err);
    }
  }

  function recordViewerActivity() {
    const status = streamStatus();
    if (!status.live || !status.streamId) return;
    for (const timer of cache) {
      if (timer.enabled === false || wholeNumber(timer.minimumChatMessages, 0) <= 0) continue;
      timer.messagesSinceLastFire = wholeNumber(timer.messagesSinceLastFire, 0) + 1;
    }
    activityDirty = true;
  }

  async function initialize() {
    await loadSettings();
    await refreshCache();
    if (!scheduler) scheduler = setInterval(() => { void tick(); }, SCHEDULER_TICK_MS);
    if (!checkpointTimer) checkpointTimer = setInterval(() => { void checkpointActivity(); }, ACTIVITY_CHECKPOINT_MS);
    console.log(`[Timers] Loaded ${cache.length} timer(s) from MongoDB. Global start delay ${settings.globalStartDelaySeconds}s.`);
  }

  async function listTimers() {
    await loadSettings();
    await refreshCache();
    return cache.map(toClient);
  }

  async function getSettings() {
    await loadSettings();
    return {
      globalStartDelaySeconds: wholeNumber(settings.globalStartDelaySeconds, DEFAULT_GLOBAL_START_DELAY_SECONDS)
    };
  }

  async function saveSettings(input = {}) {
    const normalized = normalizeSettings(input);
    const saved = await TimerConfig.findOneAndUpdate(
      { channelName: normalizedChannel },
      { $set: normalized, $setOnInsert: { channelName: normalizedChannel } },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();
    if (normalized.globalStartDelaySeconds > 0) {
      const adjusted = await ChatTimer.updateMany(
        {
          channelName: normalizedChannel,
          startDelaySeconds: { $ne: null, $lt: normalized.globalStartDelaySeconds }
        },
        { $set: { startDelaySeconds: normalized.globalStartDelaySeconds } }
      );
      if (adjusted?.modifiedCount) {
        console.log(`[Timers] Raised ${adjusted.modifiedCount} per-timer start-delay override(s) to match the new global minimum.`);
      }
    }
    settings = { ...settings, ...saved };
    await refreshCache();
    console.log(`[Timers] Updated settings: start delay ${normalized.globalStartDelaySeconds}s.`);
    return getSettings();
  }

  async function saveTimer(input = {}) {
    await loadSettings();
    const normalized = normalizeInput(input, settings);
    const id = String(input.id || '').trim();
    let saved;
    if (id) {
      saved = await ChatTimer.findOneAndUpdate(
        { _id: id, channelName: normalizedChannel },
        { $set: normalized },
        { new: true, runValidators: true }
      );
      if (!saved) throw new Error('Timer was not found.');
    } else {
      saved = await ChatTimer.create({ channelName: normalizedChannel, ...normalized });
    }

    await refreshCache();
    const cached = cache.find((item) => String(item._id) === String(saved._id));
    const status = streamStatus();
    if (cached && status.live && status.streamId) {
      const nextDueAt = new Date(scheduleForNewStream(cached, status));
      const patch = { scheduleStreamId: status.streamId, nextDueAt, retryCount: 0, nextRetryAt: null, messagesSinceLastFire: 0 };
      Object.assign(cached, patch);
      await persistSchedulePatch(cached._id, patch);
    }
    console.log(`[Timers] ${id ? 'Updated' : 'Created'} timer ${normalized.name}.`);
    return toClient(cached || saved.toObject());
  }

  async function deleteTimer(id) {
    const deleted = await ChatTimer.findOneAndDelete({ _id: id, channelName: normalizedChannel });
    if (!deleted) throw new Error('Timer was not found.');
    await refreshCache();
    console.log(`[Timers] Deleted timer ${deleted.name}.`);
  }

  async function setEnabled(id, enabled) {
    const saved = await ChatTimer.findOneAndUpdate(
      { _id: id, channelName: normalizedChannel },
      { $set: { enabled: Boolean(enabled), retryCount: 0, nextRetryAt: null } },
      { new: true, runValidators: true }
    );
    if (!saved) throw new Error('Timer was not found.');
    await refreshCache();
    const cached = cache.find((item) => String(item._id) === String(saved._id));
    const status = streamStatus();
    if (cached && cached.enabled !== false && status.live && status.streamId) {
      const nextDueAt = new Date(scheduleForNewStream(cached, status));
      const patch = { scheduleStreamId: status.streamId, nextDueAt, messagesSinceLastFire: 0 };
      Object.assign(cached, patch);
      await persistSchedulePatch(cached._id, patch);
    }
    console.log(`[Timers] ${saved.enabled ? 'Enabled' : 'Disabled'} timer ${saved.name}.`);
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
    const selection = chooseResponse(timer);
    if (!selection.template) throw new Error('Timer has no selectable response.');
    const rendered = await renderTimerResponse(selection.template, getRandomChatters);
    return { rendered, responseIndex: selection.index, responseMode: selection.mode };
  }

  async function testTimer(id) {
    const timer = await findTimerOrThrow(id);
    const result = await sendSelected(timer, { reason: 'scheduled', affectSchedule: false });
    console.log(`[Timers] Test sent for ${timer.name}; schedule and history were not changed.`);
    return result;
  }

  async function fireNow(id) {
    const timer = await findTimerOrThrow(id);
    const status = streamStatus();
    if (!status.live || !status.streamId) throw new Error('Fire Now is only available while Qwert is live. Use Test for an offline send check.');
    const result = await sendSelected(timer, { reason: 'manual', affectSchedule: true });
    console.log(`[Timers] Fire Now sent for ${timer.name} and reset its timer schedule.`);
    return result;
  }

  return {
    initialize,
    listTimers,
    getSettings,
    saveSettings,
    saveTimer,
    deleteTimer,
    setEnabled,
    previewTimer,
    testTimer,
    fireNow,
    recordViewerActivity,
    consumeOwnResponse,
    refreshCache
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
  createChatTimerManager
};
