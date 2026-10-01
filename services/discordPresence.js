'use strict';

const DiscordPresenceConfig = require('../models/DiscordPresenceConfig');

const VALID_STATUSES = new Set(['online', 'idle', 'dnd', 'invisible']);
const VALID_ACTIVITY_TYPES = new Set(['playing', 'watching', 'listening', 'competing', 'none']);
const DEFAULT_DISCORD_PRESENCE = Object.freeze({
  status: 'online',
  activityType: 'watching',
  activityText: 'GeneralQwert'
});
const MAX_ACTIVITY_TEXT_LENGTH = 128;

function normalizeDiscordPresenceSettings(input = {}) {
  const status = String(input.status ?? DEFAULT_DISCORD_PRESENCE.status).trim().toLowerCase();
  const activityType = String(input.activityType ?? DEFAULT_DISCORD_PRESENCE.activityType).trim().toLowerCase();
  let activityText = String(input.activityText ?? DEFAULT_DISCORD_PRESENCE.activityText).trim();
  if (!VALID_STATUSES.has(status)) throw new Error('Discord status must be Online, Idle, Do Not Disturb, or Invisible.');
  if (!VALID_ACTIVITY_TYPES.has(activityType)) throw new Error('Discord activity must be Playing, Watching, Listening, Competing, or None.');
  if (activityType === 'none') activityText = '';
  if (activityType !== 'none' && !activityText) throw new Error('Discord Activity Text is required unless Activity is None.');
  if (Array.from(activityText).length > MAX_ACTIVITY_TEXT_LENGTH) throw new Error(`Discord Activity Text can contain at most ${MAX_ACTIVITY_TEXT_LENGTH} characters.`);
  return { status, activityType, activityText };
}

function createDiscordPresenceManager({ channelName, discordBot }) {
  const normalizedChannel = String(channelName || '').toLowerCase().trim();
  let settings = { ...DEFAULT_DISCORD_PRESENCE };
  let initialized = false;

  function getSettings() { return { ...settings }; }

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
    initialized = true;
    discordBot?.setPresenceConfig?.(settings);
    console.log(`[Discord Bot] Presence settings: ${settings.status}; ${settings.activityType}${settings.activityText ? ` ${JSON.stringify(settings.activityText)}` : ''}.`);
    return getSettings();
  }

  async function saveSettings(input = {}) {
    const normalized = normalizeDiscordPresenceSettings(input);
    const saved = await DiscordPresenceConfig.findOneAndUpdate(
      { channelName: normalizedChannel },
      { $set: normalized, $setOnInsert: { channelName: normalizedChannel } },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();
    settings = normalizeDiscordPresenceSettings(saved || normalized);
    initialized = true;
    discordBot?.setPresenceConfig?.(settings);
    console.log(`[Discord Bot] Presence updated: ${settings.status}; ${settings.activityType}${settings.activityText ? ` ${JSON.stringify(settings.activityText)}` : ''}.`);
    return getSettings();
  }

  return { initialize, getSettings, saveSettings, isInitialized: () => initialized };
}

module.exports = {
  createDiscordPresenceManager,
  normalizeDiscordPresenceSettings,
  DEFAULT_DISCORD_PRESENCE,
  MAX_ACTIVITY_TEXT_LENGTH
};
