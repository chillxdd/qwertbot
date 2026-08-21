const EventSubReaction = require('../models/EventSubReaction');
const { MAX_AUTOMATION_SPACING_SECONDS } = require('./automationSpacing');
const { beginEventReaction, endEventReaction, getEventReactionHoldStatus } = require('./eventReactionHold');
const { getStoredAuth } = require('./twitchAuth');
const { getStoredBroadcasterAuth } = require('./twitchBroadcasterAuth');

const EVENT_TYPES = [
  { type: 'channel.subscribe', label: 'Subscription', threshold: null },
  { type: 'channel.subscription.message', label: 'Resub Message', threshold: 'Cumulative Months' },
  { type: 'channel.subscription.gift', label: 'Gift Subs', threshold: 'Gift Count' },
  { type: 'channel.cheer', label: 'Bits / Cheer', threshold: 'Bits' },
  { type: 'channel.follow', label: 'Follow', threshold: null },
  { type: 'channel.raid', label: 'Raid', threshold: 'Raid Viewers' },
  { type: 'channel.hype_train.begin', label: 'Hype Train Start', threshold: 'Level' },
  { type: 'channel.hype_train.end', label: 'Hype Train End', threshold: 'Level' },
  { type: 'stream.online', label: 'Stream Online', threshold: null },
  { type: 'stream.offline', label: 'Stream Offline', threshold: null }
];
const EVENT_TYPE_SET = new Set(EVENT_TYPES.map((item) => item.type));
const ACTION_TYPES = new Set(['chat_message', 'custom_command', 'twitch_shoutout']);
const MAX_ACTIONS = 12;
const MAX_HOLD_SECONDS = MAX_AUTOMATION_SPACING_SECONDS;
const MAX_ACTION_DELAY_SECONDS = 300;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function cleanText(value, max = 500) { return Array.from(String(value || '').trim()).slice(0, max).join(''); }

function eventActor(event = {}, type = '') {
  if (type === 'channel.raid') {
    return {
      login: String(event.from_broadcaster_user_login || '').trim(),
      name: String(event.from_broadcaster_user_name || event.from_broadcaster_user_login || 'raider').trim(),
      userId: String(event.from_broadcaster_user_id || '').trim()
    };
  }
  return {
    login: String(event.user_login || '').trim(),
    name: String(event.user_name || event.user_login || (event.is_anonymous ? 'Anonymous' : 'viewer')).trim(),
    userId: String(event.user_id || '').trim()
  };
}

function numericEventValue(type, event = {}) {
  switch (type) {
    case 'channel.subscription.message': return Number(event.cumulative_months || 0);
    case 'channel.subscription.gift': return Number(event.total || 0);
    case 'channel.cheer': return Number(event.bits || 0);
    case 'channel.raid': return Number(event.viewers || 0);
    case 'channel.hype_train.begin':
    case 'channel.hype_train.end': return Number(event.level || 0);
    default: return 0;
  }
}

function reactionToClient(item) {
  return {
    id: String(item._id),
    name: item.name,
    eventType: item.eventType,
    enabled: item.enabled !== false,
    minimumValue: Number(item.minimumValue || 0),
    holdSeconds: Number(item.holdSeconds || 0),
    actions: Array.isArray(item.actions) ? item.actions.map((action) => ({
      type: action.type,
      value: String(action.value || ''),
      delaySeconds: Number(action.delaySeconds || 0),
      enabled: action.enabled !== false
    })) : [],
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null
  };
}

function normalizeReaction(input = {}, automationSpacingSeconds = 0) {
  const name = cleanText(input.name, 80);
  if (!name) throw new Error('Name is required.');
  const eventType = String(input.eventType || '').trim();
  if (!EVENT_TYPE_SET.has(eventType)) throw new Error('Choose a supported EventSub event.');
  const minimumValue = Number(input.minimumValue || 0);
  if (!Number.isFinite(minimumValue) || minimumValue < 0) throw new Error('Minimum value must be 0 or greater.');
  const holdSeconds = Number(input.holdSeconds ?? 60);
  if (!Number.isFinite(holdSeconds) || holdSeconds < 0 || holdSeconds > MAX_HOLD_SECONDS) {
    throw new Error(`Post-reaction hold must be between 0 and ${MAX_HOLD_SECONDS} seconds.`);
  }
  const spacingSeconds = Math.max(0, Number(automationSpacingSeconds) || 0);
  if (holdSeconds > 0 && holdSeconds < spacingSeconds) {
    throw new Error(`Automation Spacing is currently ${spacingSeconds} seconds. Enter 0 to use global spacing only, or ${spacingSeconds} seconds or more for an additional post-reaction hold.`);
  }
  const rawActions = Array.isArray(input.actions) ? input.actions : [];
  if (!rawActions.length) throw new Error('Add at least one action.');
  if (rawActions.length > MAX_ACTIONS) throw new Error(`A reaction can have at most ${MAX_ACTIONS} actions.`);
  const actions = rawActions.map((raw) => {
    const type = String(raw.type || '').trim();
    if (!ACTION_TYPES.has(type)) throw new Error('Choose a supported reaction action.');
    const delaySeconds = Number(raw.delaySeconds || 0);
    if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_ACTION_DELAY_SECONDS) {
      throw new Error(`Action delay must be between 0 and ${MAX_ACTION_DELAY_SECONDS} seconds.`);
    }
    const value = cleanText(raw.value, 500);
    if ((type === 'chat_message' || type === 'custom_command') && !value) {
      throw new Error(type === 'chat_message' ? 'Chat Message needs text.' : 'Custom Command needs a command such as !so $(raider).');
    }
    return { type, value, delaySeconds, enabled: raw.enabled !== false };
  });
  return {
    name,
    eventType,
    enabled: input.enabled !== false,
    minimumValue: Math.round(minimumValue * 1000) / 1000,
    holdSeconds: Math.round(holdSeconds * 1000) / 1000,
    actions
  };
}

function renderEventTemplate(template, type, event = {}) {
  const actor = eventActor(event, type);
  const map = {
    user: actor.name,
    username: actor.login || actor.name,
    raider: type === 'channel.raid' ? actor.name : actor.name,
    viewers: Number(event.viewers || 0),
    bits: Number(event.bits || 0),
    gifts: Number(event.total || 0),
    level: Number(event.level || 0),
    months: Number(event.cumulative_months || 0),
    event: EVENT_TYPES.find((item) => item.type === type)?.label || type
  };
  return String(template || '').replace(/\$\((user|username|raider|viewers|bits|gifts|level|months|event)\)/gi, (_, key) => String(map[key.toLowerCase()] ?? ''));
}

function createEventSubReactionManager({ channelName, sendMessage, getBotAccessToken, getCustomCommandManager, noteAutomationSend = null, getAutomationSpacingSeconds = null }) {
  const normalizedChannel = String(channelName || '').toLowerCase().trim();
  let cache = [];

  function currentAutomationSpacingSeconds() {
    if (typeof getAutomationSpacingSeconds !== 'function') return 0;
    const value = Number(getAutomationSpacingSeconds());
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  async function refreshCache() {
    cache = await EventSubReaction.find({ channelName: normalizedChannel }).sort({ createdAt: 1 }).lean();
    return cache;
  }

  async function initialize() {
    await refreshCache();
    console.log(`[EventSub Reactions] Loaded ${cache.length} reaction(s).`);
  }

  async function listReactions() {
    await refreshCache();
    return cache.map(reactionToClient);
  }

  async function saveReaction(input = {}) {
    const normalized = normalizeReaction(input, currentAutomationSpacingSeconds());
    const id = String(input.id || '').trim();
    let saved;
    if (id) {
      saved = await EventSubReaction.findOneAndUpdate({ _id: id, channelName: normalizedChannel }, { $set: normalized }, { new: true, runValidators: true }).lean();
      if (!saved) throw new Error('Reaction was not found.');
    } else {
      saved = (await EventSubReaction.create({ channelName: normalizedChannel, ...normalized })).toObject();
    }
    await refreshCache();
    return reactionToClient(saved);
  }

  async function deleteReaction(id) {
    const deleted = await EventSubReaction.findOneAndDelete({ _id: id, channelName: normalizedChannel }).lean();
    if (!deleted) throw new Error('Reaction was not found.');
    await refreshCache();
  }

  async function setEnabled(id, enabled) {
    const saved = await EventSubReaction.findOneAndUpdate({ _id: id, channelName: normalizedChannel }, { $set: { enabled: Boolean(enabled) } }, { new: true }).lean();
    if (!saved) throw new Error('Reaction was not found.');
    await refreshCache();
    return reactionToClient(saved);
  }

  async function sendTwitchShoutout(type, event) {
    const actor = eventActor(event, type);
    if (!actor.userId) throw new Error('This EventSub payload does not include a target broadcaster ID for shoutout.');
    const [botAuth, broadcasterAuth, token] = await Promise.all([
      getStoredAuth(),
      getStoredBroadcasterAuth(),
      getBotAccessToken()
    ]);
    const moderatorId = String(botAuth?.twitchUserId || '').trim();
    const broadcasterId = String(broadcasterAuth?.twitchUserId || event?.broadcaster_user_id || event?.to_broadcaster_user_id || '').trim();
    if (!moderatorId || !broadcasterId || !token) throw new Error('Bot/broadcaster OAuth is not ready for Twitch shoutouts.');
    const url = new URL('https://api.twitch.tv/helix/chat/shoutouts');
    url.searchParams.set('from_broadcaster_id', broadcasterId);
    url.searchParams.set('to_broadcaster_id', actor.userId);
    url.searchParams.set('moderator_id', moderatorId);
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': String(process.env.TWITCH_CLIENT_ID || '').trim() }
    });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json())?.message || ''; } catch (_) {}
      throw new Error(`Twitch shoutout failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
  }

  async function runAction(action, type, event) {
    if (action.delaySeconds > 0) await sleep(action.delaySeconds * 1000);
    if (action.type === 'chat_message') {
      const message = renderEventTemplate(action.value, type, event).trim();
      if (message) {
        await sendMessage(normalizedChannel, message);
        if (typeof noteAutomationSend === 'function') await noteAutomationSend('eventsub');
      }
      return;
    }
    if (action.type === 'custom_command') {
      const manager = getCustomCommandManager?.();
      if (!manager) throw new Error('Custom Commands is not available.');
      const rawMessage = renderEventTemplate(action.value, type, event).trim();
      if (!rawMessage) return;
      const actor = eventActor(event, type);
      const result = await manager.handleMessage({
        rawMessage,
        displayName: actor.name || 'EventSub',
        tags: { badges: { broadcaster: '1' }, mod: true, subscriber: true },
        systemInvocation: true
      });
      if (!result?.matched) throw new Error(`Custom command did not match: ${rawMessage}`);
      if (!result?.responded) throw new Error(`Custom command matched but did not respond (${result?.reason || 'unknown reason'}).`);
      if (typeof noteAutomationSend === 'function') await noteAutomationSend('eventsub');
      return;
    }
    if (action.type === 'twitch_shoutout') {
      await sendTwitchShoutout(type, event);
      if (typeof noteAutomationSend === 'function') await noteAutomationSend('eventsub');
    }
  }

  async function runReaction(reaction, type, event) {
    beginEventReaction();
    console.log(`[EventSub Reactions] Starting ${reaction.name} for ${type}.`);
    try {
      for (const action of reaction.actions || []) {
        if (action.enabled === false) continue;
        try {
          await runAction(action, type, event);
        } catch (err) {
          console.error(`[EventSub Reactions] ${reaction.name} action ${action.type} failed:`, err?.message || err);
        }
      }
    } finally {
      endEventReaction(reaction.holdSeconds || 0);
      console.log(`[EventSub Reactions] Finished ${reaction.name}; recaps/timers held for ${Number(reaction.holdSeconds || 0)}s.`);
    }
  }

  async function handleEvent(type, event = {}) {
    if (!EVENT_TYPE_SET.has(type)) return;
    const candidates = cache.filter((reaction) => reaction.enabled !== false && reaction.eventType === type);
    for (const reaction of candidates) {
      const minimum = Number(reaction.minimumValue || 0);
      if (minimum > 0 && numericEventValue(type, event) < minimum) continue;
      void runReaction(reaction, type, event);
    }
  }

  return {
    initialize,
    listReactions,
    saveReaction,
    deleteReaction,
    setEnabled,
    handleEvent,
    refreshCache,
    getHoldStatus: getEventReactionHoldStatus,
    getAutomationSpacingSeconds: currentAutomationSpacingSeconds,
    eventTypes: EVENT_TYPES
  };
}

module.exports = {
  EVENT_TYPES,
  MAX_ACTIONS,
  MAX_HOLD_SECONDS,
  MAX_ACTION_DELAY_SECONDS,
  createEventSubReactionManager,
  renderEventTemplate,
  numericEventValue
};
