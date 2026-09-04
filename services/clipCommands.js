const ClipCommandConfig = require('../models/ClipCommandConfig');
const {
  createClip,
  getLiveStreamInfo,
  validateClipForChannel
} = require('./twitchClips');

const MIN_CLIP_DURATION = 5;
const MAX_CLIP_DURATION = 60;
const LAST_COMMAND_COOLDOWN_MS = 30 * 1000;
const CLIP_COMMAND_COOLDOWN_MS = 60 * 1000;
const LAST_UPDATE_COOLDOWN_MS = 60 * 1000;
const DEFAULT_CLIP_SETTINGS = Object.freeze({
  clip: { defaultTitle: 'Qwert Clip', defaultDuration: 45 },
  cliplast: { defaultTitle: 'Last Notable Run End', defaultDuration: 45 }
});

// Exact normalized Twitch categories. This intentionally excludes fan games and
// derivative categories such as PokéRogue and Pokémon Infinite Fusion.
const OFFICIAL_POKEMON_CATEGORY_NAMES = Object.freeze([
  'Pokémon Red/Blue',
  'Pokémon Red and Blue',
  'Pokémon Yellow: Special Pikachu Edition',
  'Pokémon Gold/Silver',
  'Pokémon Gold and Silver',
  'Pokémon Crystal',
  'Pokémon Ruby/Sapphire',
  'Pokémon Ruby and Sapphire',
  'Pokémon FireRed/LeafGreen',
  'Pokémon Emerald',
  'Pokémon Diamond/Pearl',
  'Pokémon Diamond and Pearl',
  'Pokémon Platinum',
  'Pokémon HeartGold/SoulSilver',
  'Pokémon Black/White',
  'Pokémon Black and White',
  'Pokémon Black 2/White 2',
  'Pokémon Black 2 and White 2',
  'Pokémon X/Y',
  'Pokémon X and Y',
  'Pokémon Omega Ruby/Alpha Sapphire',
  'Pokémon Omega Ruby and Alpha Sapphire',
  'Pokémon Sun/Moon',
  'Pokémon Sun and Moon',
  'Pokémon Ultra Sun/Ultra Moon',
  'Pokémon Ultra Sun and Ultra Moon',
  "Pokémon: Let's Go, Pikachu!/Eevee!",
  "Pokémon: Let's Go, Pikachu! and Let's Go, Eevee!",
  'Pokémon Sword/Shield',
  'Pokémon Sword and Shield',
  'Pokémon Brilliant Diamond/Shining Pearl',
  'Pokémon Brilliant Diamond and Shining Pearl',
  'Pokémon Legends: Arceus',
  'Pokémon Scarlet/Violet',
  'Pokémon Scarlet and Violet',
  'Pokémon Legends: Z-A'
]);

function normalizeChannelName(value) {
  return String(value || '').replace(/^#/, '').trim().toLowerCase();
}

function normalizeCategory(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const OFFICIAL_POKEMON_CATEGORY_KEYS = new Set(OFFICIAL_POKEMON_CATEGORY_NAMES.map(normalizeCategory));

function isOfficialPokemonCategory(gameName) {
  return OFFICIAL_POKEMON_CATEGORY_KEYS.has(normalizeCategory(gameName));
}

function clampDuration(value, fallback = 45) {
  const number = Number(value);
  if (!Number.isFinite(number)) return Number(fallback);
  return Math.min(MAX_CLIP_DURATION, Math.max(MIN_CLIP_DURATION, Math.round(number * 10) / 10));
}

function normalizeTitle(value, fallback) {
  const text = String(value ?? '').trim();
  return (text || String(fallback || '').trim()).slice(0, 250);
}

function normalizeClipSettings(input = {}) {
  return {
    clip: {
      defaultTitle: normalizeTitle(input?.clip?.defaultTitle, DEFAULT_CLIP_SETTINGS.clip.defaultTitle),
      defaultDuration: clampDuration(input?.clip?.defaultDuration, DEFAULT_CLIP_SETTINGS.clip.defaultDuration)
    },
    cliplast: {
      defaultTitle: normalizeTitle(input?.cliplast?.defaultTitle, DEFAULT_CLIP_SETTINGS.cliplast.defaultTitle),
      defaultDuration: clampDuration(input?.cliplast?.defaultDuration, DEFAULT_CLIP_SETTINGS.cliplast.defaultDuration)
    }
  };
}

function parseClipArguments(rawMessage, commandName, defaults = {}) {
  const raw = String(rawMessage || '').trim();
  const prefix = String(commandName || '').trim().toLowerCase();
  const firstSpace = raw.search(/\s/);
  const token = (firstSpace === -1 ? raw : raw.slice(0, firstSpace)).toLowerCase();
  if (token !== prefix) return null;
  const args = firstSpace === -1 ? '' : raw.slice(firstSpace).trim();
  const defaultDuration = clampDuration(defaults.defaultDuration, 45);
  const defaultTitle = normalizeTitle(defaults.defaultTitle, 'Qwert Clip');

  if (!args) return { title: defaultTitle, duration: defaultDuration, usedDefaults: true };

  // A leading number is a duration ONLY when followed by a pipe delimiter.
  // This keeps "!clip 30 seconds to mars" as a title, while both
  // "!clip 60 | title" and "!clip 60s | title" explicitly override duration.
  const explicit = args.match(/^([0-9]+(?:\.[0-9]+)?)\s*s?\s*\|\s*(.+)$/i);
  if (explicit) {
    const duration = Number(explicit[1]);
    const title = String(explicit[2] || '').trim();
    if (!Number.isFinite(duration) || duration < MIN_CLIP_DURATION || duration > MAX_CLIP_DURATION) {
      return { error: `Duration must be between ${MIN_CLIP_DURATION} and ${MAX_CLIP_DURATION} seconds.` };
    }
    if (!title) return { error: 'A clip title is required after the pipe.' };
    return { title: normalizeTitle(title, defaultTitle), duration, usedDefaults: false };
  }

  if (args.includes('|') && /^\s*[0-9]+(?:\.[0-9]+)?\s*s?\s*\|/i.test(args)) {
    return { error: 'A clip title is required after the pipe.' };
  }

  return { title: normalizeTitle(args, defaultTitle), duration: defaultDuration, usedDefaults: false };
}

function formatRemaining(ms) {
  const seconds = Math.max(1, Math.ceil(Number(ms || 0) / 1000));
  return `${seconds}s`;
}

function userIdentityFromTags(tags = {}, displayName = '') {
  return {
    userId: String(tags['user-id'] || '').trim(),
    login: String(tags.username || '').trim().toLowerCase(),
    displayName: String(displayName || tags['display-name'] || tags.username || '').trim()
  };
}

function createClipCommandManager({ channelName, sendMessage, getNativeCommandResponse }) {
  const channel = normalizeChannelName(channelName);
  let lastCommandUse = 0;
  let clipCommandUse = 0;
  let lastUpdateCommandUse = 0;
  let lastUpdateBusy = false;

  async function readConfig() {
    const doc = await ClipCommandConfig.findOne({ channelName: channel }).lean();
    const settings = normalizeClipSettings(doc || {});
    return { settings, lastClip: doc?.lastClip || null };
  }

  async function saveSettings(input = {}) {
    const settings = normalizeClipSettings(input);
    await ClipCommandConfig.findOneAndUpdate(
      { channelName: channel },
      { $set: { clip: settings.clip, cliplast: settings.cliplast } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    return settings;
  }

  async function saveLastClip(clip, source, identity) {
    const lastClip = {
      id: String(clip?.id || ''),
      url: String(clip?.url || ''),
      title: String(clip?.title || ''),
      duration: Number.isFinite(Number(clip?.duration)) ? Number(clip.duration) : null,
      creatorName: String(clip?.creatorName || ''),
      source,
      setByUserId: identity.userId,
      setByLogin: identity.login,
      setByDisplayName: identity.displayName,
      setAt: new Date()
    };
    await ClipCommandConfig.findOneAndUpdate(
      { channelName: channel },
      { $set: { lastClip } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    return lastClip;
  }

  async function clearLastClip() {
    await ClipCommandConfig.findOneAndUpdate(
      { channelName: channel },
      { $set: { lastClip: {} } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
  }

  async function response(command, variant, variables, fallback = '') {
    if (typeof getNativeCommandResponse === 'function') {
      return getNativeCommandResponse(command, variant, variables || {});
    }
    return fallback;
  }

  async function say(channelArg, text) {
    const message = String(text || '').trim();
    if (message && typeof sendMessage === 'function') await sendMessage(channelArg, message);
  }

  async function requireOfficialPokemonLive() {
    const info = await getLiveStreamInfo(channel);
    if (!info.live) throw new Error('The channel is not live.');
    if (!isOfficialPokemonCategory(info.gameName)) {
      throw new Error(`Current category "${info.gameName || 'Unknown'}" is not an approved official Pokémon title.`);
    }
    return info;
  }

  async function handleLast({ channel: channelArg, displayName }) {
    const now = Date.now();
    if (lastCommandUse && now - lastCommandUse < LAST_COMMAND_COOLDOWN_MS) {
      await say(channelArg, await response('last', 'cooldown', {
        user: displayName,
        remaining: formatRemaining(LAST_COMMAND_COOLDOWN_MS - (now - lastCommandUse))
      }));
      return { matched: true, responded: true, reason: 'cooldown' };
    }
    lastCommandUse = now;
    try {
      const { lastClip } = await readConfig();
      if (!lastClip?.url) {
        await say(channelArg, await response('last', 'empty', { user: displayName }));
        return { matched: true, responded: true, reason: 'empty' };
      }
      await say(channelArg, await response('last', 'response', {
        user: displayName,
        clipurl: lastClip.url,
        cliptitle: lastClip.title || ''
      }));
      return { matched: true, responded: true, reason: 'success', clip: lastClip };
    } catch (err) {
      console.error('[Clips] !last failed:', err?.message || err);
      await say(channelArg, await response('last', 'error', { user: displayName }));
      return { matched: true, responded: true, reason: 'error' };
    }
  }

  async function handleSetLast({ channel: channelArg, rawMessage, displayName, tags }) {
    const identity = userIdentityFromTags(tags, displayName);
    const arg = String(rawMessage || '').trim().replace(/^!setlast\b/i, '').trim();
    if (!arg) {
      await say(channelArg, await response('setlast', 'fail', { user: displayName }));
      return { matched: true, responded: true, reason: 'invalid_url' };
    }
    const now = Date.now();
    if (lastUpdateCommandUse && now - lastUpdateCommandUse < LAST_UPDATE_COOLDOWN_MS) {
      await say(channelArg, await response('setlast', 'cooldown', {
        user: displayName,
        remaining: formatRemaining(LAST_UPDATE_COOLDOWN_MS - (now - lastUpdateCommandUse))
      }));
      return { matched: true, responded: true, reason: 'cooldown' };
    }
    if (lastUpdateBusy) {
      await say(channelArg, await response('setlast', 'fail', { user: displayName }));
      return { matched: true, responded: true, reason: 'busy' };
    }
    lastUpdateBusy = true;
    try {
      await requireOfficialPokemonLive();
      const clip = await validateClipForChannel(channel, arg);
      const saved = await saveLastClip(clip, 'setlast', identity);
      lastUpdateCommandUse = Date.now();
      await say(channelArg, await response('setlast', 'success', { user: displayName, clipurl: saved.url, cliptitle: saved.title || '' }));
      console.log(`[Clips] !setlast updated !last to ${saved.url} by ${identity.displayName || identity.login || 'moderator'}.`);
      return { matched: true, responded: true, reason: 'success', clip: saved };
    } catch (err) {
      console.error('[Clips] !setlast failed:', err?.message || err);
      await say(channelArg, await response('setlast', 'fail', { user: displayName }));
      return { matched: true, responded: true, reason: 'error' };
    } finally {
      lastUpdateBusy = false;
    }
  }

  async function handleClipLast({ channel: channelArg, rawMessage, displayName, tags }) {
    const identity = userIdentityFromTags(tags, displayName);
    const now = Date.now();
    if (lastUpdateCommandUse && now - lastUpdateCommandUse < LAST_UPDATE_COOLDOWN_MS) {
      await say(channelArg, await response('cliplast', 'cooldown', {
        user: displayName,
        remaining: formatRemaining(LAST_UPDATE_COOLDOWN_MS - (now - lastUpdateCommandUse))
      }));
      return { matched: true, responded: true, reason: 'cooldown' };
    }
    if (lastUpdateBusy) {
      await say(channelArg, await response('cliplast', 'fail', { user: displayName }));
      return { matched: true, responded: true, reason: 'busy' };
    }
    lastUpdateBusy = true;
    try {
      await requireOfficialPokemonLive();
      const { settings } = await readConfig();
      const parsed = parseClipArguments(rawMessage, '!cliplast', settings.cliplast);
      if (parsed?.error) throw new Error(parsed.error);
      const clip = await createClip(channel, parsed);
      const saved = await saveLastClip(clip, 'cliplast', identity);
      lastUpdateCommandUse = Date.now();
      await say(channelArg, await response('cliplast', 'success', { user: displayName, clipurl: saved.url, cliptitle: saved.title || '' }));
      console.log(`[Clips] !cliplast created and saved ${saved.url} by ${identity.displayName || identity.login || 'moderator'}.`);
      return { matched: true, responded: true, reason: 'success', clip: saved };
    } catch (err) {
      console.error('[Clips] !cliplast failed:', err?.message || err);
      await say(channelArg, await response('cliplast', 'fail', { user: displayName }));
      return { matched: true, responded: true, reason: 'error' };
    } finally {
      lastUpdateBusy = false;
    }
  }

  async function handleClip({ channel: channelArg, rawMessage, displayName }) {
    const now = Date.now();
    if (clipCommandUse && now - clipCommandUse < CLIP_COMMAND_COOLDOWN_MS) {
      await say(channelArg, await response('clip', 'cooldown', {
        user: displayName,
        remaining: formatRemaining(CLIP_COMMAND_COOLDOWN_MS - (now - clipCommandUse))
      }));
      return { matched: true, responded: true, reason: 'cooldown' };
    }
    clipCommandUse = now;
    try {
      const { settings } = await readConfig();
      const parsed = parseClipArguments(rawMessage, '!clip', settings.clip);
      if (parsed?.error) throw new Error(parsed.error);
      const clip = await createClip(channel, parsed);
      await say(channelArg, await response('clip', 'success', { user: displayName, clipurl: clip.url, cliptitle: clip.title || '' }));
      console.log(`[Clips] !clip created ${clip.url} by ${displayName}.`);
      return { matched: true, responded: true, reason: 'success', clip };
    } catch (err) {
      console.error('[Clips] !clip failed:', err?.message || err);
      await say(channelArg, await response('clip', 'fail', { user: displayName }));
      return { matched: true, responded: true, reason: 'error' };
    }
  }

  async function handleMessage({ channel: channelArg, rawMessage, displayName, tags = {}, isModOrBroadcaster = false }) {
    const command = String(rawMessage || '').trim().split(/\s+/)[0].toLowerCase();
    if (!['!last', '!setlast', '!cliplast', '!clip'].includes(command)) return { matched: false };

    if (command === '!last') return handleLast({ channel: channelArg, displayName });
    if (!isModOrBroadcaster) return { matched: true, responded: false, reason: 'unauthorized' };
    if (command === '!setlast') return handleSetLast({ channel: channelArg, rawMessage, displayName, tags });
    if (command === '!cliplast') return handleClipLast({ channel: channelArg, rawMessage, displayName, tags });
    return handleClip({ channel: channelArg, rawMessage, displayName, tags });
  }

  async function getAdminState() {
    const { settings, lastClip } = await readConfig();
    return {
      settings,
      lastClip: lastClip?.url ? lastClip : null,
      cooldowns: {
        lastSeconds: LAST_COMMAND_COOLDOWN_MS / 1000,
        clipSeconds: CLIP_COMMAND_COOLDOWN_MS / 1000,
        setlastSeconds: LAST_UPDATE_COOLDOWN_MS / 1000,
        cliplastSeconds: LAST_UPDATE_COOLDOWN_MS / 1000,
        lastUpdateShared: true
      },
      approvedPokemonCategories: [...OFFICIAL_POKEMON_CATEGORY_NAMES]
    };
  }

  return {
    handleMessage,
    getAdminState,
    saveSettings,
    clearLastClip
  };
}

module.exports = {
  MIN_CLIP_DURATION,
  MAX_CLIP_DURATION,
  LAST_COMMAND_COOLDOWN_MS,
  CLIP_COMMAND_COOLDOWN_MS,
  LAST_UPDATE_COOLDOWN_MS,
  DEFAULT_CLIP_SETTINGS,
  OFFICIAL_POKEMON_CATEGORY_NAMES,
  normalizeCategory,
  isOfficialPokemonCategory,
  normalizeClipSettings,
  parseClipArguments,
  createClipCommandManager
};
