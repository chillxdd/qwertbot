const ClipCommandConfig = require('../models/ClipCommandConfig');
const {
  createClip,
  getLiveStreamInfo,
  validateClipForChannel
} = require('./twitchClips');
const { requestGeminiText } = require('./geminiClient');

const MIN_CLIP_DURATION = 5;
const MAX_CLIP_DURATION = 60;
const LAST_COMMAND_COOLDOWN_MS = 30 * 1000;
const CLIP_COMMAND_COOLDOWN_MS = 60 * 1000;
const LAST_UPDATE_COOLDOWN_MS = 60 * 1000;
const AUTO_TITLE_TIMEOUT_MS = 3000;
const DEFAULT_CLIP_SETTINGS = Object.freeze({
  clip: { defaultDuration: 45 },
  cliplast: { defaultDuration: 45 }
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

function normalizeTitle(value) {
  return String(value ?? '').trim().slice(0, 250);
}

function normalizeClipSettings(input = {}) {
  return {
    clip: {
      defaultDuration: clampDuration(input?.clip?.defaultDuration, DEFAULT_CLIP_SETTINGS.clip.defaultDuration)
    },
    cliplast: {
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

  if (!args) {
    return { title: '', duration: defaultDuration, autoTitle: true, usedDefaults: true };
  }

  // A leading number is a duration ONLY when followed by a pipe delimiter.
  // This keeps "!clip 30 seconds to mars" as a title. Both "60 | title"
  // and "60s | title" override duration. A blank right side intentionally
  // means "use this duration and generate an automatic title".
  const explicit = args.match(/^([0-9]+(?:\.[0-9]+)?)\s*s?\s*\|\s*(.*)$/i);
  if (explicit) {
    const duration = Number(explicit[1]);
    const title = normalizeTitle(explicit[2]);
    if (!Number.isFinite(duration) || duration < MIN_CLIP_DURATION || duration > MAX_CLIP_DURATION) {
      return { error: `Duration must be between ${MIN_CLIP_DURATION} and ${MAX_CLIP_DURATION} seconds.` };
    }
    return {
      title,
      duration,
      autoTitle: !title,
      usedDefaults: false
    };
  }

  return {
    title: normalizeTitle(args),
    duration: defaultDuration,
    autoTitle: false,
    usedDefaults: false
  };
}

const NEUTRAL_CLIP_TITLE_PROMPT = `Generate one short, playful Twitch clip title for a general gaming moment.
Rules:
- 2 to 6 words.
- Neutral tone only. Do not imply a win, loss, death, failure, success, clutch, throw, survival, or any specific outcome.
- Keep it broadly gaming-related and random/varied.
- Do not mention specific games, characters, players, streamers, usernames, moves, locations, or events.
- Return only the title. No quotes, label, punctuation explanation, or extra text.`;

const RUN_LOSS_CLIP_TITLE_PROMPT = `Generate one short, playful Twitch clip title for the end of a gaming challenge run that was lost.
Rules:
- 2 to 6 words.
- Negative/loss tone is appropriate because the run is confirmed over.
- Keep it generic and random/varied.
- Do not invent or mention specific games, characters, moves, opponents, locations, players, streamers, usernames, or circumstances.
- Return only the title. No quotes, label, punctuation explanation, or extra text.`;

const NON_NEUTRAL_GENERAL_TITLE_RE = /\b(win|wins|won|winner|victory|victorious|clutch|clutched|fail|fails|failed|failure|loss|lost|lose|loses|death|dead|died|dies|kill|killed|kills|throw|threw|thrown|choke|choked|survive|survived|survival|miracle|saved|save|defeat|defeated)\b/i;

function sanitizeGeneratedClipTitle(value, kind = 'clip') {
  let text = String(value || '').trim();
  if (!text) return '';
  text = text.replace(/^```[^\n]*\n?/i, '').replace(/```$/i, '').trim();
  text = text.split(/\r?\n/)[0].trim();
  text = text.replace(/^\s*(?:title|clip title)\s*:\s*/i, '').trim();
  text = text.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
  text = text.replace(/\s+/g, ' ').slice(0, 100).trim();
  if (!text) return '';
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 8) return '';
  if (/https?:\/\//i.test(text)) return '';
  if (kind === 'clip' && NON_NEUTRAL_GENERAL_TITLE_RE.test(text)) return '';
  return text;
}

function formatPacificDate(ms = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      month: '2-digit',
      day: '2-digit',
      year: '2-digit'
    }).formatToParts(new Date(ms));
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (byType.month && byType.day && byType.year) return `${byType.month}/${byType.day}/${byType.year}`;
  } catch (_) {}
  return '';
}

function formatElapsedStreamTime(startedAt, nowMs = Date.now()) {
  const startMs = Date.parse(String(startedAt || ''));
  if (!Number.isFinite(startMs) || startMs <= 0 || !Number.isFinite(Number(nowMs)) || Number(nowMs) < startMs) return '';
  const totalSeconds = Math.max(0, Math.floor((Number(nowMs) - startMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function buildFallbackClipTitle(kind, liveInfo, nowMs = Date.now()) {
  const date = formatPacificDate(nowMs);
  const elapsed = formatElapsedStreamTime(liveInfo?.startedAt, nowMs);
  if (!date || !elapsed) return '';
  const prefix = kind === 'cliplast' ? 'Qwert Run Loss' : 'Qwert Clip';
  return `${prefix} ${date} ${elapsed}`;
}

async function generateAutomaticClipTitle(kind, liveInfo, nowMs = Date.now()) {
  const prompt = kind === 'cliplast' ? RUN_LOSS_CLIP_TITLE_PROMPT : NEUTRAL_CLIP_TITLE_PROMPT;
  const started = Date.now();
  try {
    const request = requestGeminiText(prompt, {
      priority: 'high',
      timeoutMs: Math.max(1000, AUTO_TITLE_TIMEOUT_MS - 500),
      deadlineAt: started + AUTO_TITLE_TIMEOUT_MS
    });
    let timeoutId = null;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const err = new Error('Gemini clip-title request timed out.');
        err.clipTitleTimeout = true;
        reject(err);
      }, AUTO_TITLE_TIMEOUT_MS);
    });
    let generated;
    try {
      generated = await Promise.race([request, timeout]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    const clean = sanitizeGeneratedClipTitle(generated, kind);
    if (clean) return { title: clean, source: 'gemini' };
    console.warn(`[Clips] Gemini returned an unusable automatic ${kind} title; using deterministic fallback.`);
  } catch (err) {
    console.warn(`[Clips] Automatic ${kind} title unavailable after ${Date.now() - started}ms: ${err?.message || err}`);
  }

  const fallback = buildFallbackClipTitle(kind, liveInfo, nowMs);
  if (fallback) return { title: fallback, source: 'fallback' };
  return { title: '', source: 'twitch' };
}

async function resolveClipTitle(kind, parsed, liveInfo) {
  const supplied = normalizeTitle(parsed?.title);
  if (supplied) return { title: supplied, source: 'moderator' };
  return generateAutomaticClipTitle(kind, liveInfo);
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
      const clip = await validateClipForChannel(channel, arg);
      if (!isOfficialPokemonCategory(clip.gameName)) {
        throw new Error(`Clip category "${clip.gameName || 'Unknown'}" is not an approved official Pokémon title.`);
      }
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
      const liveInfo = await requireOfficialPokemonLive();
      const { settings } = await readConfig();
      const parsed = parseClipArguments(rawMessage, '!cliplast', settings.cliplast);
      if (parsed?.error) throw new Error(parsed.error);
      const resolvedTitle = await resolveClipTitle('cliplast', parsed, liveInfo);
      const clip = await createClip(channel, { ...parsed, title: resolvedTitle.title });
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
      const liveInfo = await getLiveStreamInfo(channel);
      if (!liveInfo.live) throw new Error('The channel is not live.');
      const { settings } = await readConfig();
      const parsed = parseClipArguments(rawMessage, '!clip', settings.clip);
      if (parsed?.error) throw new Error(parsed.error);
      const resolvedTitle = await resolveClipTitle('clip', parsed, liveInfo);
      const clip = await createClip(channel, { ...parsed, title: resolvedTitle.title });
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
  AUTO_TITLE_TIMEOUT_MS,
  DEFAULT_CLIP_SETTINGS,
  OFFICIAL_POKEMON_CATEGORY_NAMES,
  normalizeCategory,
  isOfficialPokemonCategory,
  normalizeClipSettings,
  parseClipArguments,
  sanitizeGeneratedClipTitle,
  formatElapsedStreamTime,
  buildFallbackClipTitle,
  generateAutomaticClipTitle,
  createClipCommandManager
};
