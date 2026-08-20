const ChatTimer = require('../models/ChatTimer');

const MAX_TIMER_NAME_LENGTH = 80;
const MIN_TIMER_INTERVAL_SECONDS = 30;
const MAX_TIMER_INTERVAL_SECONDS = 86400;
const MAX_TIMER_RESPONSES = 25;
const MAX_TIMER_RESPONSE_LENGTH = 500;
const TIMER_RESPONSE_MODES = ['equal', 'weighted'];
const SCHEDULER_TICK_MS = 1000;
const OWN_RESPONSE_TTL_MS = 15000;

function normalizeInput(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Timer Name is required.');
  if (name.length > MAX_TIMER_NAME_LENGTH) throw new Error(`Timer Name can contain at most ${MAX_TIMER_NAME_LENGTH} characters.`);

  const intervalSeconds = Number(input.intervalSeconds);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < MIN_TIMER_INTERVAL_SECONDS || intervalSeconds > MAX_TIMER_INTERVAL_SECONDS) {
    throw new Error(`Interval must be between ${MIN_TIMER_INTERVAL_SECONDS} and ${MAX_TIMER_INTERVAL_SECONDS} seconds.`);
  }

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
    responses,
    responseMode,
    responseWeights,
    enabled: input.enabled !== false
  };
}

function toClient(timer) {
  return {
    id: String(timer._id),
    name: String(timer.name || 'Timer'),
    intervalSeconds: Number(timer.intervalSeconds || MIN_TIMER_INTERVAL_SECONDS),
    responses: Array.isArray(timer.responses) ? timer.responses : [],
    responseMode: TIMER_RESPONSE_MODES.includes(timer.responseMode) ? timer.responseMode : 'equal',
    responseWeights: Array.isArray(timer.responseWeights) ? timer.responseWeights : [],
    enabled: timer.enabled !== false,
    createdAt: timer.createdAt || null,
    updatedAt: timer.updatedAt || null
  };
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

function randomIntegerInclusive(min, max) {
  const low = Math.ceil(Number(min));
  const high = Math.floor(Number(max));
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low > high) return null;
  const span = high - low + 1;
  if (!Number.isSafeInteger(span) || span <= 0) return null;
  return Math.floor(Math.random() * span) + low;
}

async function renderTimerResponse(template, getRandomChatters) {
  let output = String(template || '');
  output = output.replace(/\$\(random\s+(-?\d+)\s+(-?\d+)\)/gi, (match, min, max) => {
    const value = randomIntegerInclusive(min, max);
    return value === null ? match : String(value);
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

function createChatTimerManager({ channelName, sendMessage, getStreamLive = null, getRandomChatters = null }) {
  const normalizedChannel = String(channelName || '').toLowerCase().trim();
  let cache = [];
  let scheduler = null;
  let wasLive = false;
  let tickBusy = false;
  const nextDueAt = new Map();
  const ownResponses = [];

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

  function resetScheduleFor(timer, now = Date.now()) {
    const id = String(timer._id);
    if (timer.enabled === false) {
      nextDueAt.delete(id);
      return;
    }
    nextDueAt.set(id, now + Math.max(MIN_TIMER_INTERVAL_SECONDS, Number(timer.intervalSeconds || MIN_TIMER_INTERVAL_SECONDS)) * 1000);
  }

  function resetAllSchedules(now = Date.now()) {
    nextDueAt.clear();
    for (const timer of cache) resetScheduleFor(timer, now);
  }

  async function refreshCache({ preserveSchedules = true } = {}) {
    const oldSchedule = new Map(nextDueAt);
    cache = await ChatTimer.find({ channelName: normalizedChannel }).sort({ createdAt: 1 }).lean();
    if (!preserveSchedules) {
      resetAllSchedules();
      return cache;
    }
    nextDueAt.clear();
    for (const timer of cache) {
      const id = String(timer._id);
      if (timer.enabled === false) continue;
      if (oldSchedule.has(id)) nextDueAt.set(id, oldSchedule.get(id));
      else resetScheduleFor(timer);
    }
    return cache;
  }

  async function runTimer(timer) {
    const id = String(timer._id);
    const selection = chooseResponse(timer);
    if (!selection.template) {
      console.warn(`[Timers] ${timer.name} has no selectable response; skipping this interval.`);
      resetScheduleFor(timer);
      return;
    }

    try {
      const rendered = await renderTimerResponse(selection.template, getRandomChatters);
      if (!rendered) {
        console.warn(`[Timers] ${timer.name} rendered an empty response; skipping this interval.`);
        resetScheduleFor(timer);
        return;
      }
      noteOwnResponse(rendered);
      await sendMessage(normalizedChannel, rendered);
      console.log(`[Timers] Sent ${timer.name} -> response ${selection.index + 1}/${timer.responses.length} (${selection.mode}).`);
    } catch (err) {
      console.error(`[Timers] Failed to send ${timer.name}:`, err?.message || err);
    } finally {
      const current = cache.find((item) => String(item._id) === id);
      if (current && current.enabled !== false) resetScheduleFor(current);
      else nextDueAt.delete(id);
    }
  }

  async function tick() {
    if (tickBusy) return;
    tickBusy = true;
    try {
      const live = typeof getStreamLive === 'function' ? Boolean(getStreamLive()) : true;
      if (!live) {
        if (wasLive) nextDueAt.clear();
        wasLive = false;
        return;
      }

      const now = Date.now();
      if (!wasLive) {
        wasLive = true;
        resetAllSchedules(now);
        return;
      }

      for (const timer of cache) {
        if (timer.enabled === false) continue;
        const id = String(timer._id);
        const due = nextDueAt.get(id);
        if (!due) {
          resetScheduleFor(timer, now);
          continue;
        }
        if (now >= due) {
          // Move the deadline forward immediately so overlapping scheduler ticks
          // can never send the same timer twice.
          nextDueAt.set(id, Number.POSITIVE_INFINITY);
          await runTimer(timer);
        }
      }
    } finally {
      tickBusy = false;
    }
  }

  async function initialize() {
    await refreshCache({ preserveSchedules: false });
    if (!scheduler) scheduler = setInterval(() => { void tick(); }, SCHEDULER_TICK_MS);
    console.log(`[Timers] Loaded ${cache.length} timer(s) from MongoDB.`);
  }

  async function listTimers() {
    await refreshCache();
    return cache.map(toClient);
  }

  async function saveTimer(input = {}) {
    const normalized = normalizeInput(input);
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
    if (cached) resetScheduleFor(cached);
    console.log(`[Timers] ${id ? 'Updated' : 'Created'} timer ${normalized.name}.`);
    return toClient(saved);
  }

  async function deleteTimer(id) {
    const deleted = await ChatTimer.findOneAndDelete({ _id: id, channelName: normalizedChannel });
    if (!deleted) throw new Error('Timer was not found.');
    nextDueAt.delete(String(id));
    await refreshCache();
    console.log(`[Timers] Deleted timer ${deleted.name}.`);
  }

  async function setEnabled(id, enabled) {
    const saved = await ChatTimer.findOneAndUpdate(
      { _id: id, channelName: normalizedChannel },
      { $set: { enabled: Boolean(enabled) } },
      { new: true, runValidators: true }
    );
    if (!saved) throw new Error('Timer was not found.');
    await refreshCache();
    const cached = cache.find((item) => String(item._id) === String(saved._id));
    if (cached) resetScheduleFor(cached);
    console.log(`[Timers] ${saved.enabled ? 'Enabled' : 'Disabled'} timer ${saved.name}.`);
    return toClient(saved);
  }

  return {
    initialize,
    listTimers,
    saveTimer,
    deleteTimer,
    setEnabled,
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
  TIMER_RESPONSE_MODES,
  createChatTimerManager
};
