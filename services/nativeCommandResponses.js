const NativeCommandConfig = require('../models/NativeCommandConfig');

const MAX_RESPONSE_LENGTH = 450;
const OPTIONAL_BLANK_RESPONSES = new Set(['setlast.success', 'cliplast.success', 'clip.success']);
const DEFAULT_NATIVE_RESPONSES = Object.freeze({
  commands: {
    response: 'All SqwertArmyBot commands: https://sqwertarmybot.onrender.com/commands'
  },
  last: {
    response: 'Last Notable Run End: $(clipurl)',
    cooldown: '@$(user), !last is on cooldown. Try again in $(remaining).',
    empty: 'No notable run clip is saved yet.',
    error: 'I couldn\'t load the last notable run clip right now.'
  },
  setlast: {
    success: '',
    fail: 'Couldn\'t set !last. Make sure Qwert is live in an approved Pokémon category and the URL is a valid Qwert Twitch clip.',
    cooldown: '@$(user), !setlast is on cooldown. Try again in $(remaining).'
  },
  cliplast: {
    success: 'Last notable run saved: $(clipurl)',
    fail: 'Couldn\'t create or save the notable run clip. Make sure Qwert is live in an approved Pokémon category and clipping is available.',
    cooldown: '@$(user), !cliplast is on cooldown. Try again in $(remaining).'
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
