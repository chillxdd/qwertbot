const NativeCommandConfig = require('../models/NativeCommandConfig');
const { COMMANDS_URL } = require('../config/app');

const MAX_RESPONSE_LENGTH = 450;
const OPTIONAL_BLANK_RESPONSES = new Set(['setlast.success', 'cliplast.success', 'clip.success']);
const DEFAULT_NATIVE_RESPONSES = Object.freeze({
  commands: {
    response: `All SqwertArmyBot commands: ${COMMANDS_URL}`
  },
  last: {
    response: 'Last Notable Run End: $(clipurl)',
    cooldown: '@$(user), !last is on cooldown. Try again in $(remaining).',
    empty: 'No notable run clip is saved yet.',
    error: 'I couldn\'t load the last notable run clip right now.'
  },
  setlast: {
    success: '',
    fail: 'Couldn\'t set !last. Make sure the URL is a valid Qwert Twitch clip from an approved Pokémon category.',
    cooldown: '@$(user), !setlast is on cooldown. Try again in $(remaining).'
  },
  textlast: {
    success: 'Last Good Run: $(date) at stream timestamp $(timestamp). No twitch clip due to copyrighted music.',
    cooldown: '@$(user), !textlast is on cooldown. Try again in $(remaining).',
    busy: 'Couldn\'t set text !last: another !setlast, !cliplast, or !textlast request is already in progress.',
    offline: 'Couldn\'t set text !last: Qwert is not live.',
    wrongCategory: 'Couldn\'t set text !last: $(category) is not an approved official Pokémon category.',
    timingError: 'Couldn\'t set text !last: Twitch did not return a usable stream start time.',
    apiError: 'Couldn\'t set text !last: Twitch stream timing could not be loaded.'
  },
  cliplast: {
    success: 'Last notable run saved: $(clipurl)',
    cooldown: '@$(user), !cliplast is on cooldown. Try again in $(remaining).',
    busy: 'Clip failed: another !setlast, !cliplast, or !textlast request is already in progress.',
    offline: 'Clip failed: Qwert is not live.',
    wrongCategory: 'Clip failed: $(category) is not an approved official Pokémon category.',
    invalidArguments: 'Clip failed: $(error)',
    clipsDisabled: 'Clip failed: clipping is disabled on the Twitch channel.',
    clipsRestricted: 'Clip failed: Twitch is restricting clip creation for this account or channel.',
    twitchCategoryNotClippable: 'Clip failed: Twitch does not allow clips in the current category.',
    titleRejected: 'Clip failed: Twitch rejected the clip title.',
    authError: 'Clip failed: Twitch authorization is invalid or missing the clips:edit permission.',
    rateLimited: 'Clip failed: Twitch is rate-limiting clip creation. Try again shortly.',
    apiError: 'Clip failed: Twitch API error. Try again shortly.',
    unpublished: 'Twitch accepted the clip but never published it. Likely due to copyrighted music playing on stream.',
    saveError: 'Clip was created, but QwertBot could not save it as !last: $(clipurl)',
    fail: 'Clip failed for an unknown reason.'
  },
  clip: {
    success: 'Clip created: $(clipurl)',
    fail: 'Couldn\'t create that clip.',
    cooldown: '@$(user), !clip is on cooldown. Try again in $(remaining).'
  },
  optout: {
    success: '@$(user), you\'ve opted out of Viewer Profiles. Learning and profile use stop immediately. Your existing profile will be deleted after 30 days unless you opt back in.',
    error: '@$(user), I couldn\'t update your Viewer Profile preference right now. Please try again later.'
  },
  optin: {
    reactivated: '@$(user), you\'ve opted back into Viewer Profiles. Your existing profile has been reactivated.',
    fresh: '@$(user), you\'ve opted back into Viewer Profiles. A new profile can now be learned over time.',
    error: '@$(user), I couldn\'t update your Viewer Profile preference right now. Please try again later.'
  },
  recap: {
    cooldown: '@$(user), !recap is on cooldown! Try again in $(remaining).',
    offline: '@$(user), hourly recaps will start when Qwert goes live.',
    paused: '@$(user), automatic hourly recaps are currently paused by a moderator.',
    generating: '@$(user), the next hourly recap is being generated now.',
    eta: '@$(user), the next hourly recap will be sent in $(remaining).'
  },
  startrecap: {
    offline: '@$(user), Qwert is offline. Hourly recaps will start fresh when the next stream begins.',
    alreadyRunning: '@$(user), automatic hourly recaps are already running.',
    success: '@$(user), automatic hourly recaps resumed where they left off. Next recap in $(remaining).'
  },
  stoprecap: {
    offline: '@$(user), Qwert is offline, so the recap system is already inactive.',
    alreadyPaused: '@$(user), automatic hourly recaps are already paused.',
    generating: '@$(user), an hourly recap is already being generated, so it can\'t be paused right now.',
    success: '@$(user), automatic hourly recaps are paused. $(messages) messages are preserved and the timer is frozen with $(remaining) remaining.'
  }
});

function normalizeChannelName(value) {
  return String(value || '').replace(/^#/, '').toLowerCase().trim();
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_NATIVE_RESPONSES));
}

function normalizeResponse(value, fallback) {
  const text = String(value ?? '').trim();
  // An explicitly blank default means the response is optional/silent.
  if (!text) return fallback === '' ? '' : fallback;
  return text.slice(0, MAX_RESPONSE_LENGTH);
}

function normalizeResponses(input = {}) {
  const out = cloneDefaults();
  for (const [command, variants] of Object.entries(out)) {
    for (const [variant, fallback] of Object.entries(variants)) {
      const supplied = input?.[command]?.[variant];
      if (OPTIONAL_BLANK_RESPONSES.has(`${command}.${variant}`) && supplied != null && String(supplied).trim() === '') {
        out[command][variant] = '';
      } else {
        out[command][variant] = normalizeResponse(supplied, fallback);
      }
    }
  }
  return out;
}

async function getNativeCommandResponses(channelName) {
  const channel = normalizeChannelName(channelName);
  const doc = await NativeCommandConfig.findOne({ channelName: channel }).lean();
  return normalizeResponses(doc?.responses || {});
}

async function saveNativeCommandResponses(channelName, responses = {}) {
  const channel = normalizeChannelName(channelName);
  const normalized = normalizeResponses(responses);
  await NativeCommandConfig.findOneAndUpdate(
    { channelName: channel },
    { $set: { responses: normalized } },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  );
  return normalized;
}

function renderNativeResponse(template, variables = {}) {
  return String(template || '').replace(/\$\(([a-zA-Z0-9_]+)\)/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) return match;
    return String(variables[key] ?? '');
  }).trim();
}

async function getRenderedNativeResponse(channelName, command, variant, variables = {}) {
  let responses = null;
  try {
    responses = await getNativeCommandResponses(channelName);
  } catch (err) {
    console.warn(`[Native Commands] Falling back to the default ${command}.${variant} response:`, err?.message || err);
  }
  const template = responses?.[command]?.[variant] || DEFAULT_NATIVE_RESPONSES?.[command]?.[variant] || '';
  return renderNativeResponse(template, variables);
}

module.exports = {
  MAX_RESPONSE_LENGTH,
  DEFAULT_NATIVE_RESPONSES,
  getNativeCommandResponses,
  saveNativeCommandResponses,
  renderNativeResponse,
  getRenderedNativeResponse
};
