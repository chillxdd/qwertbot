const AutomationConfig = require('../models/AutomationConfig');

const DEFAULT_AUTOMATION_SPACING_SECONDS = 30;
const MAX_AUTOMATION_SPACING_SECONDS = 3600;
const VALID_ENGINES = new Set(['recap', 'timer', 'eventsub', 'stream_pin']);

function normalizeSeconds(value) {
  const seconds = Math.round(Number(value));
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_AUTOMATION_SPACING_SECONDS) {
    throw new Error(`Automation spacing must be between 0 and ${MAX_AUTOMATION_SPACING_SECONDS} seconds.`);
  }
  return seconds;
}

function createAutomationSpacingManager({ channelName }) {
  const normalizedChannel = String(channelName || '').toLowerCase().trim();
  let state = {
    minimumSpacingSeconds: DEFAULT_AUTOMATION_SPACING_SECONDS,
    lastAutomationAt: null,
    lastEngine: ''
  };
  let initialized = false;
  let reservationBusy = false;
  let priorityHoldEngine = '';


  function dateMs(value) {
    if (!value) return 0;
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }

  async function initialize() {
    const stored = await AutomationConfig.findOne({ channelName: normalizedChannel }).lean();
    if (stored) {
      state = { ...state, ...stored };
    } else {
      const created = await AutomationConfig.findOneAndUpdate(
        { channelName: normalizedChannel },
        { $setOnInsert: { channelName: normalizedChannel, minimumSpacingSeconds: DEFAULT_AUTOMATION_SPACING_SECONDS } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      ).lean();
      state = { ...state, ...created };
    }
    initialized = true;
    console.log(`[Automation] Minimum automation spacing: ${state.minimumSpacingSeconds}s.`);
    return getSettings();
  }

  function getSettings() {
    return {
      minimumSpacingSeconds: Number(state.minimumSpacingSeconds ?? DEFAULT_AUTOMATION_SPACING_SECONDS),
      lastAutomationAt: state.lastAutomationAt || null,
      lastEngine: String(state.lastEngine || '')
    };
  }

  async function saveSettings(input = {}) {
    const minimumSpacingSeconds = normalizeSeconds(input.minimumSpacingSeconds);
    const saved = await AutomationConfig.findOneAndUpdate(
      { channelName: normalizedChannel },
      { $set: { minimumSpacingSeconds }, $setOnInsert: { channelName: normalizedChannel } },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();
    state = { ...state, ...saved };
    initialized = true;
    console.log(`[Automation] Updated automation spacing to ${minimumSpacingSeconds}s.`);
    return getSettings();
  }

  function getStatus(engine = '') {
    const normalizedEngine = VALID_ENGINES.has(engine) ? engine : '';
    const spacingMs = Math.max(0, Number(state.minimumSpacingSeconds ?? DEFAULT_AUTOMATION_SPACING_SECONDS)) * 1000;
    const lastAtMs = dateMs(state.lastAutomationAt);
    const lastEngine = String(state.lastEngine || '');
    const applies = Boolean(normalizedEngine && lastEngine);
    const availableAt = applies && lastAtMs ? lastAtMs + spacingMs : 0;
    const spacingRemainingMs = availableAt ? Math.max(0, availableAt - Date.now()) : 0;
    const blockedByPriority = Boolean(priorityHoldEngine && normalizedEngine && normalizedEngine !== priorityHoldEngine);
    const remainingMs = blockedByPriority ? Math.max(250, spacingRemainingMs) : spacingRemainingMs;
    return {
      active: blockedByPriority || remainingMs > 0,
      remainingMs,
      availableAt: !blockedByPriority && spacingRemainingMs > 0 ? availableAt : 0,
      minimumSpacingSeconds: Number(state.minimumSpacingSeconds ?? DEFAULT_AUTOMATION_SPACING_SECONDS),
      lastAutomationAt: state.lastAutomationAt || null,
      lastEngine,
      blockedByPriority,
      priorityHoldEngine
    };
  }

  function beginPriorityHold(engine) {
    if (!VALID_ENGINES.has(engine)) return false;
    if (priorityHoldEngine && priorityHoldEngine !== engine) return false;
    priorityHoldEngine = engine;
    return true;
  }

  function endPriorityHold(engine) {
    if (!engine || priorityHoldEngine === engine) priorityHoldEngine = '';
    return getStatus(engine);
  }

  async function noteAutomation(engine) {
    if (!VALID_ENGINES.has(engine)) return getStatus(engine);
    const now = new Date();
    state.lastAutomationAt = now;
    state.lastEngine = engine;
    void AutomationConfig.updateOne(
      { channelName: normalizedChannel },
      { $set: { lastAutomationAt: now, lastEngine: engine }, $setOnInsert: { channelName: normalizedChannel, minimumSpacingSeconds: state.minimumSpacingSeconds } },
      { upsert: true }
    ).catch((err) => console.error('[Automation] Could not persist last automation send:', err?.message || err));
    return getStatus(engine);
  }

  async function tryReserve(engine) {
    if (!VALID_ENGINES.has(engine)) return { allowed: true, status: getStatus(engine) };
    const initialStatus = getStatus(engine);
    if (initialStatus.blockedByPriority) return { allowed: false, status: initialStatus };
    if (reservationBusy) return { allowed: false, status: { ...getStatus(engine), remainingMs: Math.max(250, getStatus(engine).remainingMs || 0) } };
    reservationBusy = true;
    try {
      const status = getStatus(engine);
      if (status.active) return { allowed: false, status };
      await noteAutomation(engine);
      return { allowed: true, status: getStatus(engine) };
    } finally {
      reservationBusy = false;
    }
  }

  return { initialize, getSettings, saveSettings, getStatus, noteAutomation, tryReserve, beginPriorityHold, endPriorityHold, isInitialized: () => initialized };
}

module.exports = {
  DEFAULT_AUTOMATION_SPACING_SECONDS,
  MAX_AUTOMATION_SPACING_SECONDS,
  createAutomationSpacingManager
};
