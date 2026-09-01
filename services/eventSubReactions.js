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
  { type: 'stream.offline', label: 'Stream Offline', threshold: null },
  { type: 'channel.poll.begin', label: 'Poll Start', threshold: null },
  { type: 'channel.poll.progress', label: 'Poll Progress', threshold: 'Total Votes' },
  { type: 'channel.poll.end', label: 'Poll End', threshold: 'Total Votes' },
  { type: 'channel.prediction.begin', label: 'Prediction Start', threshold: null },
  { type: 'channel.prediction.progress', label: 'Prediction Progress', threshold: 'Total Channel Points' },
  { type: 'channel.prediction.lock', label: 'Prediction Locked', threshold: 'Total Channel Points' },
  { type: 'channel.prediction.end', label: 'Prediction End', threshold: 'Total Channel Points' },
  { type: 'channel.channel_points_custom_reward_redemption.add', label: 'Channel Point Redemption', threshold: 'Reward Cost' },
  { type: 'channel.channel_points_automatic_reward_redemption.add', label: 'Automatic Point Redemption', threshold: 'Reward Cost' },
  { type: 'channel.goal.begin', label: 'Goal Start', threshold: 'Current Amount' },
  { type: 'channel.goal.progress', label: 'Goal Progress', threshold: 'Current Amount' },
  { type: 'channel.goal.end', label: 'Goal End', threshold: 'Current Amount' },
  { type: 'channel.ad_break.begin', label: 'Ad Break Start', threshold: 'Duration Seconds' }
];
const EVENT_TYPE_SET = new Set(EVENT_TYPES.map((item) => item.type));
const ACTION_TYPES = new Set(['chat_message', 'custom_command', 'twitch_announcement', 'twitch_shoutout']);
const ANNOUNCEMENT_COLORS = new Set(['primary', 'blue', 'green', 'orange', 'purple']);
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
    login: String(event.user_login || event.broadcaster_user_login || '').trim(),
    name: String(event.user_name || event.user_login || event.broadcaster_user_name || event.broadcaster_user_login || (event.is_anonymous ? 'Anonymous' : 'Qwert')).trim(),
    userId: String(event.user_id || event.broadcaster_user_id || '').trim()
  };
}

function sumNumeric(items, field) {
  return (Array.isArray(items) ? items : []).reduce((sum, item) => sum + Math.max(0, Number(item?.[field] || 0)), 0);
}

function predictionWinner(event = {}) {
  const winningId = String(event.winning_outcome_id || '');
  const outcome = (Array.isArray(event.outcomes) ? event.outcomes : []).find((item) => String(item?.id || '') === winningId);
  return String(outcome?.title || '').trim();
}

function eventTitle(type, event = {}) {
  if (type === 'channel.channel_points_custom_reward_redemption.add') return String(event.reward?.title || '').trim();
  if (type === 'channel.channel_points_automatic_reward_redemption.add') return String(event.reward?.type || '').replace(/_/g, ' ').trim();
  if (type.startsWith('channel.goal.')) return String(event.description || '').trim();
  return String(event.title || '').trim();
}

function numericEventValue(type, event = {}) {
  switch (type) {
    case 'channel.subscription.message': return Number(event.cumulative_months || 0);
    case 'channel.subscription.gift': return Number(event.total || 0);
    case 'channel.cheer': return Number(event.bits || 0);
    case 'channel.raid': return Number(event.viewers || 0);
    case 'channel.hype_train.begin':
    case 'channel.hype_train.end': return Number(event.level || 0);
    case 'channel.poll.progress':
    case 'channel.poll.end': return sumNumeric(event.choices, 'votes');
    case 'channel.prediction.progress':
    case 'channel.prediction.lock':
    case 'channel.prediction.end': return sumNumeric(event.outcomes, 'channel_points');
    case 'channel.channel_points_custom_reward_redemption.add': return Number(event.reward?.cost || 0);
    case 'channel.channel_points_automatic_reward_redemption.add': return Number(event.reward?.channel_points || event.reward?.cost || 0);
    case 'channel.goal.begin':
    case 'channel.goal.progress':
    case 'channel.goal.end': return Number(event.current_amount || 0);
    case 'channel.ad_break.begin': return Number(event.duration_seconds || 0);
    default: return 0;
  }
}

function reactionToClient(item, automationSpacingSeconds = 0) {
  const spacingSeconds = Math.max(0, Number(automationSpacingSeconds) || 0);
  const storedHoldSeconds = Number(item.holdSeconds);
  const clientHoldSeconds = Number.isFinite(storedHoldSeconds) && storedHoldSeconds > 0 && storedHoldSeconds >= spacingSeconds
    ? storedHoldSeconds
    : null;
  return {
    id: String(item._id),
    name: item.name,
    eventType: item.eventType,
    enabled: item.enabled !== false,
    minimumValue: Number(item.minimumValue || 0),
    holdSeconds: clientHoldSeconds,
    actions: Array.isArray(item.actions) ? item.actions.map((action) => ({
      type: action.type,
      value: String(action.value || ''),
      color: ANNOUNCEMENT_COLORS.has(String(action.color || '').toLowerCase()) ? String(action.color).toLowerCase() : 'primary',
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
  const rawHoldSeconds = input.holdSeconds;
  const useGlobalHold = rawHoldSeconds === null || rawHoldSeconds === undefined || rawHoldSeconds === '' || Number(rawHoldSeconds) === 0;
  const holdSeconds = useGlobalHold ? null : Number(rawHoldSeconds);
  if (holdSeconds !== null && (!Number.isFinite(holdSeconds) || holdSeconds < 0 || holdSeconds > MAX_HOLD_SECONDS)) {
    throw new Error(`Post-reaction hold must be blank or between 0 and ${MAX_HOLD_SECONDS} seconds.`);
  }
  const spacingSeconds = Math.max(0, Number(automationSpacingSeconds) || 0);
  if (holdSeconds !== null && holdSeconds < spacingSeconds) {
    throw new Error(`Automation Spacing is currently ${spacingSeconds} seconds. Leave Post-Reaction Hold blank to use global spacing, or enter ${spacingSeconds} seconds or more.`);
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
    if ((type === 'chat_message' || type === 'custom_command' || type === 'twitch_announcement') && !value) {
      if (type === 'chat_message') throw new Error('Chat Message needs text.');
      if (type === 'twitch_announcement') throw new Error('Twitch Announcement needs text.');
      throw new Error('Custom Command needs a command such as !so $(raider).');
    }
    const color = ANNOUNCEMENT_COLORS.has(String(raw.color || '').toLowerCase()) ? String(raw.color).toLowerCase() : 'primary';
    return { type, value, color, delaySeconds, enabled: raw.enabled !== false };
  });
  return {
    name,
    eventType,
    enabled: input.enabled !== false,
    minimumValue: Math.round(minimumValue * 1000) / 1000,
    holdSeconds: holdSeconds === null ? null : Math.round(holdSeconds * 1000) / 1000,
    actions
  };
}

function renderEventTemplate(template, type, event = {}) {
  const actor = eventActor(event, type);
  const choices = (Array.isArray(event.choices) ? event.choices : []).map((item) => String(item?.title || '').trim()).filter(Boolean).join(' / ');
  const outcomes = (Array.isArray(event.outcomes) ? event.outcomes : []).map((item) => String(item?.title || '').trim()).filter(Boolean).join(' / ');
  const map = {
    user: actor.name,
    username: actor.login || actor.name,
    raider: actor.name,
    viewers: Number(event.viewers || 0),
    bits: Number(event.bits || 0),
    gifts: Number(event.total || 0),
    level: Number(event.level || 0),
    months: Number(event.cumulative_months || 0),
    event: EVENT_TYPES.find((item) => item.type === type)?.label || type,
    title: eventTitle(type, event),
    choices: choices || outcomes,
    votes: sumNumeric(event.choices, 'votes'),
    points: sumNumeric(event.outcomes, 'channel_points'),
    winner: predictionWinner(event),
    reward: String(event.reward?.title || event.reward?.type || '').replace(/_/g, ' ').trim(),
    input: String(event.user_input || event.message?.text || '').trim(),
    current: Number(event.current_amount || 0),
    target: Number(event.target_amount || 0),
    duration: Number(event.duration_seconds || 0),
    status: String(event.status || '').trim(),
    automatic: event.is_automatic ? 'yes' : 'no'
  };
  return String(template || '').replace(/\$\((user|username|raider|viewers|bits|gifts|level|months|event|title|choices|votes|points|winner|reward|input|current|target|duration|status|automatic)\)/gi, (_, key) => String(map[key.toLowerCase()] ?? ''));
}

function createEventSubReactionManager({ channelName, sendMessage, sendAnnouncement = null, getBotAccessToken, getCustomCommandManager, noteAutomationSend = null, getAutomationSpacingSeconds = null, getAutomationSpacingStatus = null }) {
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
    const spacingSeconds = currentAutomationSpacingSeconds();
    return cache.map((reaction) => reactionToClient(reaction, spacingSeconds));
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
    return reactionToClient(saved, currentAutomationSpacingSeconds());
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
    return reactionToClient(saved, currentAutomationSpacingSeconds());
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
    if (action.type === 'twitch_announcement') {
      const message = renderEventTemplate(action.value, type, event).trim();
      if (message) {
        if (typeof sendAnnouncement !== 'function') throw new Error('Twitch announcements are not available.');
        await sendAnnouncement(message, { color: action.color || 'primary' });
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
      const configuredHold = Number(reaction.holdSeconds);
      const spacingSeconds = currentAutomationSpacingSeconds();
      const effectiveHoldSeconds = Math.max(
        spacingSeconds,
        Number.isFinite(configuredHold) && configuredHold > 0 ? configuredHold : 0
      );
      endEventReaction(effectiveHoldSeconds);
      const holdSource = Number.isFinite(configuredHold) && configuredHold > 0 ? 'custom' : 'global Automation Spacing';
      console.log(`[EventSub Reactions] Finished ${reaction.name}; recaps/timers held for ${effectiveHoldSeconds}s (${holdSource}).`);
    }
  }

  async function waitForHigherPriorityAutomation() {
    if (typeof getAutomationSpacingStatus !== 'function') return;
    while (true) {
      let status = { blockedByPriority: false };
      try { status = getAutomationSpacingStatus('eventsub') || status; } catch (_) {}
      if (!status.blockedByPriority) return;
      await sleep(Math.max(250, Math.min(1000, Number(status.remainingMs || 250))));
    }
  }

  async function handleEvent(type, event = {}) {
    if (!EVENT_TYPE_SET.has(type)) return;
    await waitForHigherPriorityAutomation();
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
