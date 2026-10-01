'use strict';

const DiscordPresenceConfig = require('../models/DiscordPresenceConfig');

const VALID_STATUSES = new Set(['online', 'idle', 'dnd', 'invisible']);
const VALID_ACTIVITY_TYPES = new Set(['playing', 'watching', 'listening', 'competing', 'custom', 'none']);
const DEFAULT_DISCORD_PRESENCE = Object.freeze({
  status: 'online',
  liveActivityType: 'watching',
  liveActivityText: '{category}',
  offlineActivityType: 'custom',
  offlineActivityText: 'GeneralQwert is offline'
});
const MAX_ACTIVITY_TEXT_LENGTH = 128;
const TEMPLATE_VARIABLES = Object.freeze(['category', 'title', 'streamer']);

function cleanText(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}
function clampText(value, max = MAX_ACTIVITY_TEXT_LENGTH) {
  return Array.from(cleanText(value)).slice(0, max).join('');
}
function normalizeProfile(typeValue, textValue, fallbackType, fallbackText, label) {
  const activityType = cleanText(typeValue ?? fallbackType).toLowerCase();
  let activityText = cleanText(textValue ?? fallbackText);
  if (!VALID_ACTIVITY_TYPES.has(activityType)) {
    throw new Error(`Discord ${label} activity must be Playing, Watching, Listening, Competing, Custom Status, or None.`);
  }
  if (activityType === 'none') activityText = '';
  if (activityType !== 'none' && !activityText) throw new Error(`Discord ${label} Activity Text is required unless Activity is None.`);
  if (Array.from(activityText).length > MAX_ACTIVITY_TEXT_LENGTH) {
    throw new Error(`Discord ${label} Activity Text can contain at most ${MAX_ACTIVITY_TEXT_LENGTH} characters.`);
  }
  return { activityType, activityText };
}
function legacyPresenceDefaults(input = {}) {
  const legacyType = cleanText(input.activityType).toLowerCase();
  const legacyText = cleanText(input.activityText);
  if (!legacyType || !VALID_ACTIVITY_TYPES.has(legacyType)) return null;
  // If the V34 defaults were never customized, upgrade them to the more useful
  // live/offline defaults requested in V35. Customized V34 values are preserved
  // for both profiles until the user edits them.
  if (legacyType === 'watching' && legacyText === 'GeneralQwert') return { ...DEFAULT_DISCORD_PRESENCE };
  return {
    status: cleanText(input.status || DEFAULT_DISCORD_PRESENCE.status).toLowerCase(),
    liveActivityType: legacyType,
    liveActivityText: legacyType === 'none' ? '' : legacyText,
    offlineActivityType: legacyType,
    offlineActivityText: legacyType === 'none' ? '' : legacyText
  };
}
function normalizeDiscordPresenceSettings(input = {}) {
  const legacy = (!Object.prototype.hasOwnProperty.call(input, 'liveActivityType') && Object.prototype.hasOwnProperty.call(input, 'activityType'))
    ? legacyPresenceDefaults(input)
    : null;
  const source = legacy || input;
  const status = cleanText(source.status ?? DEFAULT_DISCORD_PRESENCE.status).toLowerCase();
  if (!VALID_STATUSES.has(status)) throw new Error('Discord status must be Online, Idle, Do Not Disturb, or Invisible.');
  const live = normalizeProfile(
    source.liveActivityType, source.liveActivityText,
    DEFAULT_DISCORD_PRESENCE.liveActivityType, DEFAULT_DISCORD_PRESENCE.liveActivityText, 'Twitch-live'
  );
  const offline = normalizeProfile(
    source.offlineActivityType, source.offlineActivityText,
    DEFAULT_DISCORD_PRESENCE.offlineActivityType, DEFAULT_DISCORD_PRESENCE.offlineActivityText, 'Twitch-offline'
  );
  return {
    status,
    liveActivityType: live.activityType,
    liveActivityText: live.activityText,
    offlineActivityType: offline.activityType,
    offlineActivityText: offline.activityText
  };
}
function normalizeStreamStatus(raw = {}) {
  return {
    known: Boolean(raw.streamStateInitialized ?? raw.known),
    live: Boolean(raw.streamLive ?? raw.live),
    title: cleanText(raw.currentStreamTitle ?? raw.title),
    category: cleanText(raw.currentStreamCategory ?? raw.category ?? raw.gameName),
    streamer: cleanText(raw.streamer || raw.channelDisplayName || 'GeneralQwert') || 'GeneralQwert'
  };
}
function renderTemplate(template, stream = {}) {
  const vars = {
    category: stream.category || stream.streamer || 'GeneralQwert',
    title: stream.title || stream.streamer || 'GeneralQwert',
    streamer: stream.streamer || 'GeneralQwert'
  };
  const rendered = cleanText(template).replace(/\{(category|title|streamer)\}/gi, (_, key) => String(vars[key.toLowerCase()] || ''));
  return clampText(rendered || vars.streamer);
}
function resolveDiscordPresence(settingsInput = {}, streamInput = {}) {
  const settings = normalizeDiscordPresenceSettings(settingsInput);
  const stream = normalizeStreamStatus(streamInput);
  const useLive = stream.known && stream.live;
  const activityType = useLive ? settings.liveActivityType : settings.offlineActivityType;
  const sourceText = useLive ? settings.liveActivityText : settings.offlineActivityText;
  const activityText = activityType === 'none' ? '' : renderTemplate(sourceText, stream);
  return {
    status: settings.status,
    activityType,
    activityText,
    twitchState: stream.known ? (stream.live ? 'live' : 'offline') : 'unknown',
    stream
  };
}

function createDiscordPresenceManager({ channelName, discordBot, getStreamStatus = null }) {
  const normalizedChannel = String(channelName || '').toLowerCase().trim();
  let settings = { ...DEFAULT_DISCORD_PRESENCE };
  let initialized = false;
  let lastAppliedKey = '';
  let lastResolved = resolveDiscordPresence(settings, {});

  function getSettings() { return { ...settings }; }
  function currentStreamStatus() {
    try { return typeof getStreamStatus === 'function' ? (getStreamStatus() || {}) : {}; }
    catch (_) { return {}; }
  }
  function applyResolved(streamStatus = currentStreamStatus()) {
    const resolved = resolveDiscordPresence(settings, streamStatus);
    lastResolved = resolved;
    const key = JSON.stringify([resolved.status, resolved.activityType, resolved.activityText]);
    if (key !== lastAppliedKey) {
      discordBot?.setPresenceConfig?.({
        status: resolved.status,
        activityType: resolved.activityType,
        activityText: resolved.activityText
      });
      lastAppliedKey = key;
      console.log(`[Discord Bot] Presence applied for Twitch ${resolved.twitchState}: ${resolved.status}; ${resolved.activityType}${resolved.activityText ? ` ${JSON.stringify(resolved.activityText)}` : ''}.`);
    }
    return { ...resolved, stream: { ...resolved.stream } };
  }

  async function initialize() {
    const stored = await DiscordPresenceConfig.findOne({ channelName: normalizedChannel }).lean();
    if (stored) {
      settings = normalizeDiscordPresenceSettings(stored);
    } else {
      const created = await DiscordPresenceConfig.findOneAndUpdate(
        { channelName: normalizedChannel },
        { $setOnInsert: { channelName: normalizedChannel, ...DEFAULT_DISCORD_PRESENCE } },
        { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
      ).lean();
      settings = normalizeDiscordPresenceSettings(created || DEFAULT_DISCORD_PRESENCE);
    }
    // Persist the normalized V35 shape so V34 legacy rows migrate automatically.
    await DiscordPresenceConfig.updateOne(
      { channelName: normalizedChannel },
      { $set: settings, $unset: { activityType: '', activityText: '' } },
      { runValidators: true }
    );
    initialized = true;
    applyResolved();
    return getSettings();
  }

  async function saveSettings(input = {}) {
    const normalized = normalizeDiscordPresenceSettings(input);
    const saved = await DiscordPresenceConfig.findOneAndUpdate(
      { channelName: normalizedChannel },
      { $set: normalized, $unset: { activityType: '', activityText: '' }, $setOnInsert: { channelName: normalizedChannel } },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();
    settings = normalizeDiscordPresenceSettings(saved || normalized);
    initialized = true;
    lastAppliedKey = '';
    applyResolved();
    return getSettings();
  }

  function syncStreamStatus(streamStatus = currentStreamStatus()) {
    if (!initialized) return null;
    return applyResolved(streamStatus);
  }
  function getResolvedPresence() {
    if (!initialized) return { ...lastResolved, stream: { ...lastResolved.stream } };
    return applyResolved();
  }

  return {
    initialize,
    getSettings,
    saveSettings,
    syncStreamStatus,
    getResolvedPresence,
    isInitialized: () => initialized
  };
}

module.exports = {
  createDiscordPresenceManager,
  normalizeDiscordPresenceSettings,
  normalizeStreamStatus,
  resolveDiscordPresence,
  renderTemplate,
  DEFAULT_DISCORD_PRESENCE,
  MAX_ACTIVITY_TEXT_LENGTH,
  TEMPLATE_VARIABLES
};
