const { randomUUID } = require('node:crypto');
const context = require('./reliability/context');
const delivery = require('./reliability/delivery');
const { httpDeliveryError } = require('./reliability/twitchDelivery');
const { fetchWithTimeout: fetch } = require('./httpClient');
const { postDiscordWebhook: deliverDiscordWebhook } = require('./discordWebhook');
const EventSubReaction = require('../models/EventSubReaction');
const { MAX_AUTOMATION_SPACING_SECONDS } = require('./automationSpacing');
const { beginEventReaction, endEventReaction, getEventReactionHoldStatus } = require('./eventReactionHold');
const { getStoredAuth } = require('./twitchAuth');
const { getStoredBroadcasterAuth } = require('./twitchBroadcasterAuth');
const secretBox = require('./secretBox');

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
const ACTION_TYPES = new Set(['chat_message', 'custom_command', 'twitch_announcement', 'twitch_shoutout', 'discord_notification']);
const DISCORD_MENTION_MODES = new Set(['none', 'everyone', 'roles', 'all']);
const ANNOUNCEMENT_COLORS = new Set(['primary', 'blue', 'green', 'orange', 'purple']);
const MAX_ACTIONS = 12;
const MAX_HOLD_SECONDS = MAX_AUTOMATION_SPACING_SECONDS;
const MAX_ACTION_DELAY_SECONDS = 300;
const MAX_DISCORD_EMBED_FIELDS = 10;
const MAX_DISCORD_EMBED_BUTTONS = 5;
const DEFAULT_DISCORD_EMBED_COLOR = '#9146FF';
const STREAM_OFFLINE_TITLE = 'Stream is offline';
const STREAM_OFFLINE_CATEGORY = 'No active category';
const STREAM_LIVE_TITLE_FALLBACK = 'Untitled stream';
const STREAM_LIVE_CATEGORY_FALLBACK = 'No category set';

function sleep(ms) { return context.sleep(ms); }
function cleanText(value, max = 500) { return Array.from(String(value || '').trim()).slice(0, max).join(''); }

function normalizeDiscordWebhookUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch (_) { throw new Error('Discord Webhook URL is not a valid URL.'); }
  const host = String(url.hostname || '').toLowerCase();
  const allowedHosts = new Set(['discord.com', 'www.discord.com', 'discordapp.com', 'www.discordapp.com', 'canary.discord.com', 'ptb.discord.com']);
  if (url.protocol !== 'https:' || !allowedHosts.has(host) || url.username || url.password || url.port) {
    throw new Error('Discord Webhook URL must be an official https://discord.com/api/webhooks/... URL.');
  }
  const match = url.pathname.match(/^\/api\/webhooks\/(\d+)\/([A-Za-z0-9._-]+)\/?$/);
  if (!match) throw new Error('Discord Webhook URL must look like https://discord.com/api/webhooks/ID/TOKEN.');
  url.hash = '';
  return url.toString();
}

function discordAllowedMentions(mode) {
  const normalized = DISCORD_MENTION_MODES.has(String(mode || '')) ? String(mode) : 'none';
  const parse = [];
  if (normalized === 'everyone' || normalized === 'all') parse.push('everyone');
  if (normalized === 'roles' || normalized === 'all') parse.push('roles');
  return { parse };
}

function discordWebhookConfigured(action = {}) {
  return Boolean(String(action.discordWebhookId || '').trim() && action.discordWebhookSecret?.data);
}

function normalizeDiscordColor(value) {
  const raw = String(value || DEFAULT_DISCORD_EMBED_COLOR).trim();
  const normalized = raw.startsWith('#') ? raw : `#${raw}`;
  if (!/^#[0-9a-f]{6}$/i.test(normalized)) throw new Error('Discord embed color must be a 6-digit hex color such as #9146FF.');
  return normalized.toUpperCase();
}

function normalizeExternalUrl(value, label = 'Discord URL') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch (_) { throw new Error(`${label} must be a valid http(s) URL.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${label} must be a valid http(s) URL.`);
  return url.toString();
}

function normalizeDiscordUrlTemplate(value, label) {
  const raw = cleanText(value, 2048);
  if (!raw) return '';
  // EventSub variables are resolved at send time, so URL templates containing
  // variables cannot be fully validated until then.
  if (/\$\([^)]+\)/.test(raw)) return raw;
  return normalizeExternalUrl(raw, label);
}

function normalizeDiscordEmbed(raw = {}) {
  const enabled = raw?.enabled === true;
  const title = cleanText(raw.title, 256);
  const description = cleanText(raw.description, 4096);
  const url = enabled ? normalizeDiscordUrlTemplate(raw.url, 'Discord embed title URL') : cleanText(raw.url, 2048);
  const color = normalizeDiscordColor(raw.color);
  const thumbnailUrl = enabled ? normalizeDiscordUrlTemplate(raw.thumbnailUrl, 'Discord embed thumbnail URL') : cleanText(raw.thumbnailUrl, 2048);
  const imageUrl = enabled ? normalizeDiscordUrlTemplate(raw.imageUrl, 'Discord embed image URL') : cleanText(raw.imageUrl, 2048);
  const footer = cleanText(raw.footer, 2048);
  const timestamp = raw.timestamp === true;
  const rawFields = Array.isArray(raw.fields) ? raw.fields : [];
  if (rawFields.length > MAX_DISCORD_EMBED_FIELDS) throw new Error(`Discord embeds can have at most ${MAX_DISCORD_EMBED_FIELDS} custom fields in QwertBot.`);
  const fields = rawFields.map((field, index) => {
    const name = cleanText(field?.name, 256);
    const value = cleanText(field?.value, 1024);
    if (!name && !value) return null;
    if (enabled && (!name || !value)) throw new Error(`Discord embed field ${index + 1} needs both a name and value.`);
    return { name, value, inline: field?.inline === true };
  }).filter(Boolean);
  // New format is a repeatable buttons array (up to Discord's 5 buttons in
  // one action row). Fall back to the old single-button pair so reactions
  // saved by the previous build continue to work without a migration.
  let rawButtons = Array.isArray(raw.buttons) ? raw.buttons : [];
  if (!rawButtons.length && (raw.buttonLabel || raw.buttonUrl)) {
    rawButtons = [{ label: raw.buttonLabel, url: raw.buttonUrl }];
  }
  if (rawButtons.length > MAX_DISCORD_EMBED_BUTTONS) {
    throw new Error(`Discord embeds can have at most ${MAX_DISCORD_EMBED_BUTTONS} link buttons in QwertBot.`);
  }
  const buttons = rawButtons.map((button, index) => {
    const label = cleanText(button?.label, 80);
    const buttonUrl = enabled
      ? normalizeDiscordUrlTemplate(button?.url, `Discord button ${index + 1} URL`)
      : cleanText(button?.url, 2048);
    if (!label && !buttonUrl) return null;
    if (enabled && (!label || !buttonUrl)) throw new Error(`Discord link button ${index + 1} needs both a label and URL.`);
    return { label, url: buttonUrl };
  }).filter(Boolean);
  if (enabled && !title && !description && !thumbnailUrl && !imageUrl && !footer && !fields.some((field) => field.name && field.value)) {
    throw new Error('Include Embed is enabled, but the embed is empty. Add a title, description, image, footer, or custom field.');
  }
  const totalChars = Array.from(title + description + footer + fields.map((field) => field.name + field.value).join('')).length;
  if (totalChars > 6000) throw new Error("Discord embed text exceeds Discord's 6000-character total embed limit.");
  return { enabled, title, description, url, color, thumbnailUrl, imageUrl, footer, timestamp, fields, buttons };
}

function discordEmbedToClient(raw = {}) {
  return {
    enabled: raw?.enabled === true,
    title: String(raw?.title || ''),
    description: String(raw?.description || ''),
    url: String(raw?.url || ''),
    color: /^#[0-9a-f]{6}$/i.test(String(raw?.color || '')) ? String(raw.color).toUpperCase() : DEFAULT_DISCORD_EMBED_COLOR,
    thumbnailUrl: String(raw?.thumbnailUrl || ''),
    imageUrl: String(raw?.imageUrl || ''),
    footer: String(raw?.footer || ''),
    timestamp: raw?.timestamp === true,
    fields: (Array.isArray(raw?.fields) ? raw.fields : []).slice(0, MAX_DISCORD_EMBED_FIELDS).map((field) => ({
      name: String(field?.name || ''), value: String(field?.value || ''), inline: field?.inline === true
    })),
    buttons: (() => {
      const current = Array.isArray(raw?.buttons) ? raw.buttons : [];
      const source = current.length ? current : ((raw?.buttonLabel || raw?.buttonUrl) ? [{ label: raw.buttonLabel, url: raw.buttonUrl }] : []);
      return source.slice(0, MAX_DISCORD_EMBED_BUTTONS).map((button) => ({
        label: String(button?.label || ''), url: String(button?.url || '')
      }));
    })()
  };
}

function decryptDiscordWebhook(action = {}) {
  if (!discordWebhookConfigured(action)) throw new Error('Discord Notification does not have a saved webhook URL.');
  return normalizeDiscordWebhookUrl(secretBox.decrypt(action.discordWebhookSecret, action.discordWebhookId));
}

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

function pollWinner(event = {}) {
  const choices = (Array.isArray(event.choices) ? event.choices : [])
    .map((choice) => ({
      title: String(choice?.title || '').trim(),
      votes: Math.max(0, Number(choice?.votes || 0))
    }))
    .filter((choice) => choice.title);
  if (!choices.length) return '';
  const maxVotes = Math.max(...choices.map((choice) => choice.votes));
  if (maxVotes <= 0) return '';
  return choices.filter((choice) => choice.votes === maxVotes).map((choice) => choice.title).join(' / ');
}

function eventWinner(type, event = {}) {
  if (type === 'channel.poll.end') return pollWinner(event);
  if (type === 'channel.prediction.end') return predictionWinner(event);
  return '';
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
      enabled: action.enabled !== false,
      ...(action.type === 'discord_notification' ? {
        discordWebhookId: String(action.discordWebhookId || ''),
        discordWebhookConfigured: discordWebhookConfigured(action),
        discordMentionMode: DISCORD_MENTION_MODES.has(String(action.discordMentionMode || '')) ? String(action.discordMentionMode) : 'none',
        discordEmbed: discordEmbedToClient(action.discordEmbed)
      } : {})
    })) : [],
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null
  };
}

function normalizeReaction(input = {}, automationSpacingSeconds = 0, existingReaction = null) {
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

  const existingDiscordById = new Map(
    (Array.isArray(existingReaction?.actions) ? existingReaction.actions : [])
      .filter((action) => action?.type === 'discord_notification' && String(action.discordWebhookId || '').trim())
      .map((action) => [String(action.discordWebhookId).trim(), action])
  );

  const actions = rawActions.map((raw) => {
    const type = String(raw.type || '').trim();
    if (!ACTION_TYPES.has(type)) throw new Error('Choose a supported reaction action.');
    const delaySeconds = Number(raw.delaySeconds || 0);
    if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_ACTION_DELAY_SECONDS) {
      throw new Error(`Action delay must be between 0 and ${MAX_ACTION_DELAY_SECONDS} seconds.`);
    }
    const value = cleanText(raw.value, type === 'discord_notification' ? 2000 : 500);
    if ((type === 'chat_message' || type === 'custom_command' || type === 'twitch_announcement') && !value) {
      if (type === 'chat_message') throw new Error('Chat Message needs text.');
      if (type === 'twitch_announcement') throw new Error('Twitch Announcement needs text.');
      throw new Error('Custom Command needs a command such as !so $(raider).');
    }
    const color = ANNOUNCEMENT_COLORS.has(String(raw.color || '').toLowerCase()) ? String(raw.color).toLowerCase() : 'primary';
    const base = { type, value, color, delaySeconds, enabled: raw.enabled !== false };
    if (type !== 'discord_notification') return base;

    const requestedWebhookId = cleanText(raw.discordWebhookId, 80);
    const existingAction = requestedWebhookId ? existingDiscordById.get(requestedWebhookId) : null;
    const enteredWebhookUrl = String(raw.discordWebhookUrl || '').trim();
    const mentionMode = DISCORD_MENTION_MODES.has(String(raw.discordMentionMode || '')) ? String(raw.discordMentionMode) : 'none';
    const discordEmbed = normalizeDiscordEmbed(raw.discordEmbed || {});
    if (!value && !discordEmbed.enabled) throw new Error('Discord Notification needs message text, an embed, or both.');
    let discordWebhookId = existingAction ? requestedWebhookId : randomUUID();
    let discordWebhookSecret;
    if (enteredWebhookUrl) {
      const normalizedUrl = normalizeDiscordWebhookUrl(enteredWebhookUrl);
      discordWebhookSecret = secretBox.encrypt(normalizedUrl, discordWebhookId);
    } else if (existingAction && discordWebhookConfigured(existingAction)) {
      discordWebhookSecret = existingAction.discordWebhookSecret;
    } else {
      throw new Error('Discord Notification needs a Webhook URL. Paste it once; saved webhook URLs are hidden when you reopen the reaction.');
    }
    return { ...base, discordWebhookId, discordWebhookSecret, discordMentionMode: mentionMode, discordEmbed };
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

function renderEventTemplate(template, type, event = {}, extra = {}) {
  const actor = eventActor(event, type);
  const choices = (Array.isArray(event.choices) ? event.choices : []).map((item) => String(item?.title || '').trim()).filter(Boolean).join(' / ');
  const outcomes = (Array.isArray(event.outcomes) ? event.outcomes : []).map((item) => String(item?.title || '').trim()).filter(Boolean).join(' / ');
  const streamTitle = String(extra.streamTitle || '').trim();
  const streamCategory = String(extra.streamCategory || '').trim();
  const streamLive = extra.streamLive === true;
  const explicitStreamTitle = String(extra.streamTitleVariable || (streamLive ? (streamTitle || STREAM_LIVE_TITLE_FALLBACK) : STREAM_OFFLINE_TITLE)).trim();
  const explicitStreamCategory = String(extra.streamCategoryVariable || (streamLive ? (streamCategory || STREAM_LIVE_CATEGORY_FALLBACK) : STREAM_OFFLINE_CATEGORY)).trim();
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
    winner: eventWinner(type, event),
    reward: String(event.reward?.title || event.reward?.type || '').replace(/_/g, ' ').trim(),
    input: String(event.user_input || event.message?.text || '').trim(),
    current: Number(event.current_amount || 0),
    target: Number(event.target_amount || 0),
    duration: Number(event.duration_seconds || 0),
    status: String(event.status || '').trim(),
    automatic: event.is_automatic ? 'yes' : 'no',
    channel: String(extra.channelName || event.broadcaster_user_name || event.broadcaster_user_login || '').trim(),
    // $(game) is intentionally retired from EventSub templates. Keep it in the
    // matcher below only so old saved templates resolve it to blank instead of
    // leaking the literal token into chat/Discord. Use $(streamcategory) or
    // its alias $(streamgame) for the current broadcast category.
    game: '',
    streamtitle: explicitStreamTitle,
    streamcategory: explicitStreamCategory,
    streamgame: explicitStreamCategory,
    url: String(extra.streamUrl || '').trim(),
    thumbnail: String(extra.thumbnail || '').trim(),
    started: String(extra.startedAt || event.started_at || '').trim()
  };
  return String(template || '').replace(/\$\((user|username|raider|viewers|bits|gifts|level|months|event|title|choices|votes|points|winner|reward|input|current|target|duration|status|automatic|channel|game|streamtitle|streamcategory|streamgame|url|thumbnail|started)\)/gi, (_, key) => String(map[key.toLowerCase()] ?? ''));
}

function renderDiscordEmbed(raw = {}, type, event = {}, extra = {}) {
  if (!raw?.enabled) return { embed: null, components: [] };
  const text = (value, max) => cleanText(renderEventTemplate(value, type, event, extra), max);
  const url = (value, label) => {
    const rendered = text(value, 2048);
    return rendered ? normalizeExternalUrl(rendered, label) : '';
  };
  const embed = {};
  const title = text(raw.title, 256);
  const description = text(raw.description, 4096);
  const titleUrl = url(raw.url, 'Discord embed title URL');
  const thumbnailUrl = url(raw.thumbnailUrl, 'Discord embed thumbnail URL');
  const imageUrl = url(raw.imageUrl, 'Discord embed image URL');
  const footer = text(raw.footer, 2048);
  if (title) embed.title = title;
  if (description) embed.description = description;
  if (titleUrl && title) embed.url = titleUrl;
  embed.color = parseInt(normalizeDiscordColor(raw.color).slice(1), 16);
  if (thumbnailUrl) embed.thumbnail = { url: thumbnailUrl };
  if (imageUrl) embed.image = { url: imageUrl };
  if (footer) embed.footer = { text: footer };
  if (raw.timestamp === true) embed.timestamp = new Date().toISOString();
  const fields = (Array.isArray(raw.fields) ? raw.fields : []).slice(0, MAX_DISCORD_EMBED_FIELDS).map((field) => ({
    name: text(field?.name, 256), value: text(field?.value, 1024), inline: field?.inline === true
  })).filter((field) => field.name && field.value);
  if (fields.length) embed.fields = fields;
  const currentButtons = Array.isArray(raw.buttons) ? raw.buttons : [];
  const sourceButtons = currentButtons.length ? currentButtons : ((raw.buttonLabel || raw.buttonUrl) ? [{ label: raw.buttonLabel, url: raw.buttonUrl }] : []);
  const renderedButtons = sourceButtons.slice(0, MAX_DISCORD_EMBED_BUTTONS).map((button, index) => ({
    label: text(button?.label, 80),
    url: url(button?.url, `Discord button ${index + 1} URL`)
  })).filter((button) => button.label && button.url);
  const components = renderedButtons.length
    ? [{ type: 1, components: renderedButtons.map((button) => ({ type: 2, style: 5, label: button.label, url: button.url })) }]
    : [];
  return { embed, components };
}

function createEventSubReactionManager({ channelName, sendMessage, sendAnnouncement = null, getBotAccessToken, getCustomCommandManager, noteAutomationSend = null, getAutomationSpacingSeconds = null, getAutomationSpacingStatus = null, getStreamStatus = null }) {
  const normalizedChannel = String(channelName || '').toLowerCase().trim();
  let cache = [];

  function currentAutomationSpacingSeconds() {
    if (typeof getAutomationSpacingSeconds !== 'function') return 0;
    const value = Number(getAutomationSpacingSeconds());
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  function eventTemplateContext(event = {}) {
    let status = {};
    try { status = typeof getStreamStatus === 'function' ? (getStreamStatus() || {}) : {}; } catch (_) {}
    const startedMs = Number(status.twitchStreamStartedAt || status.streamSessionStartedAt || 0);
    const streamLive = status.streamLive !== undefined ? Boolean(status.streamLive) : Boolean(status.live);
    const currentStreamTitle = String(status.currentStreamTitle || status.title || '').trim();
    const currentStreamCategory = String(status.currentStreamCategory || status.category || '').trim();
    const twitchThumbnail = String(status.currentStreamThumbnailUrl || status.thumbnailUrl || '').trim();
    const thumbnailBase = twitchThumbnail || `https://static-cdn.jtvnw.net/previews-ttv/live_user_${encodeURIComponent(normalizedChannel)}-1280x720.jpg`;
    let thumbnailUrl = thumbnailBase;
    try {
      const parsed = new URL(thumbnailBase);
      // Discord proxies/cache images by URL. Give every rendered notification a
      // fresh URL so an offline/test placeholder cannot poison the next live card.
      parsed.searchParams.set('qwertbot', `${String(status.currentStreamId || status.streamId || event.id || 'stream').trim() || 'stream'}-${Date.now()}`);
      thumbnailUrl = parsed.toString();
    } catch (_) {}
    return {
      channelName: String(event.broadcaster_user_name || event.broadcaster_user_login || normalizedChannel).trim(),
      // Explicit current-broadcast source metadata. Event-specific $(title) no
      // longer falls back to this stream title, and EventSub $(game) is retired.
      streamTitle: currentStreamTitle,
      streamCategory: currentStreamCategory,
      // Explicit current-broadcast variables. These never go blank just because
      // the broadcast is offline or Twitch has not supplied metadata yet.
      streamLive,
      streamTitleVariable: streamLive ? (currentStreamTitle || STREAM_LIVE_TITLE_FALLBACK) : STREAM_OFFLINE_TITLE,
      streamCategoryVariable: streamLive ? (currentStreamCategory || STREAM_LIVE_CATEGORY_FALLBACK) : STREAM_OFFLINE_CATEGORY,
      streamUrl: `https://twitch.tv/${normalizedChannel}`,
      thumbnail: thumbnailUrl,
      startedAt: startedMs > 0 ? new Date(startedMs).toISOString() : String(event.started_at || '')
    };
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
    const id = String(input.id || '').trim();
    const existing = id ? await EventSubReaction.findOne({ _id: id, channelName: normalizedChannel }).lean() : null;
    if (id && !existing) throw new Error('Reaction was not found.');
    const normalized = normalizeReaction(input, currentAutomationSpacingSeconds(), existing);
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

  async function postDiscordWebhook(webhookUrl, content, mentionMode = 'none', { embed = null, components = [], testMode = false } = {}) {
    const url = normalizeDiscordWebhookUrl(webhookUrl);
    const message = cleanText(content, 2000);
    if (!message && !embed && !(Array.isArray(components) && components.length)) throw new Error('Discord Notification is empty.');
    const body = { allowed_mentions: discordAllowedMentions(mentionMode) };
    if (message) body.content = message;
    if (embed) body.embeds = [embed];
    if (Array.isArray(components) && components.length) body.components = components;
    const targetUrl = new URL(url);
    if (Array.isArray(components) && components.length) targetUrl.searchParams.set('with_components', 'true');
    return deliverDiscordWebhook({
      webhookUrl: targetUrl.toString(),
      body,
      purpose: testMode ? 'admin test' : 'EventSub notification',
      // Admin tests should stay interactive. They will transparently honor a
      // short Discord Retry-After, but a long/global limit is surfaced to the
      // dashboard immediately with the exact diagnostics instead of hanging
      // the browser request for minutes.
      max429Retries: testMode ? 2 : 6,
      maxTotalWaitMs: testMode ? 15000 : 20 * 60 * 1000
    });
  }

  function findDiscordActionByWebhookId(webhookId) {
    const id = String(webhookId || '').trim();
    if (!id) return null;
    for (const reaction of cache) {
      const action = (reaction.actions || []).find((item) => item?.type === 'discord_notification' && String(item.discordWebhookId || '') === id);
      if (action) return action;
    }
    return null;
  }

  async function testDiscordNotification({ webhookUrl = '', webhookId = '', content = '', discordEmbed = null, eventType = 'stream.online' } = {}) {
    let targetUrl = String(webhookUrl || '').trim();
    if (targetUrl) targetUrl = normalizeDiscordWebhookUrl(targetUrl);
    else {
      const action = findDiscordActionByWebhookId(webhookId);
      if (!action) throw new Error('Saved Discord webhook was not found. Save the reaction first or paste a webhook URL.');
      targetUrl = decryptDiscordWebhook(action);
    }
    const type = EVENT_TYPE_SET.has(String(eventType || '')) ? String(eventType) : 'stream.online';
    let previewEvent;
    if (type === 'channel.raid') {
      previewEvent = { from_broadcaster_user_name: 'ExampleRaider', from_broadcaster_user_login: 'exampleraider', viewers: 42 };
    } else {
      previewEvent = { user_name: 'ExampleUser', user_login: 'exampleuser', bits: 100, total: 5, cumulative_months: 12, started_at: new Date().toISOString() };
      if (type.startsWith('channel.poll.') || type.startsWith('channel.prediction.')) previewEvent.title = 'Example event title';
      if (type === 'channel.channel_points_custom_reward_redemption.add') previewEvent.reward = { title: 'Example reward' };
      if (type === 'channel.channel_points_automatic_reward_redemption.add') previewEvent.reward = { type: 'example_reward' };
      if (type.startsWith('channel.goal.')) previewEvent.description = 'Example goal';
    }
    const extra = eventTemplateContext(previewEvent);
    const normalizedEmbed = discordEmbed ? normalizeDiscordEmbed(discordEmbed) : { enabled: false };
    const rendered = renderDiscordEmbed(normalizedEmbed, type, previewEvent, extra);
    const renderedContent = renderEventTemplate(String(content || ''), type, previewEvent, extra).trim();
    const message = renderedContent || (rendered.embed || rendered.components.length ? '' : 'QwertBot Discord notification test ✅');
    // Test sends always suppress mentions, regardless of the saved action setting.
    const result = await postDiscordWebhook(targetUrl, message, 'none', { ...rendered, testMode: true });
    return { success: true, diagnostics: result?.diagnostics || null };
  }

  async function sendTwitchShoutout(type, event) {
    const key = context.nextDeliveryKey('shoutout');
    if (key) return (await delivery.deliver({ key, kind: 'event-shoutout', payload: { type, event },
      send: (saved) => sendTwitchShoutout(saved.type, saved.event) })).result;
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
      throw httpDeliveryError('Twitch shoutout', response, detail);
    }
  }

  async function runAction(action, type, event) {
    await context.assertOperation();
    if (action.delaySeconds > 0) await sleep(action.delaySeconds * 1000);
    const templateContext = eventTemplateContext(event);
    if (action.type === 'chat_message') {
      const message = renderEventTemplate(action.value, type, event, templateContext).trim();
      if (message) {
        await sendMessage(normalizedChannel, message);
        if (typeof noteAutomationSend === 'function') await noteAutomationSend('eventsub');
      }
      return;
    }
    if (action.type === 'twitch_announcement') {
      const message = renderEventTemplate(action.value, type, event, templateContext).trim();
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
      const rawMessage = renderEventTemplate(action.value, type, event, templateContext).trim();
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
    if (action.type === 'discord_notification') {
      const message = renderEventTemplate(action.value, type, event, templateContext).trim();
      const renderedEmbed = renderDiscordEmbed(action.discordEmbed || {}, type, event, templateContext);
      if (!message && !renderedEmbed.embed && !renderedEmbed.components.length) return;
      const mentionMode = DISCORD_MENTION_MODES.has(String(action.discordMentionMode || '')) ? String(action.discordMentionMode) : 'none';
      const key = context.nextDeliveryKey('discord-notification');
      if (key) {
        await delivery.deliver({
          key,
          kind: 'event-discord-notification',
          payload: { content: message, mentionMode, webhookId: String(action.discordWebhookId || ''), embed: renderedEmbed.embed, components: renderedEmbed.components },
          send: (saved) => postDiscordWebhook(decryptDiscordWebhook(action), saved.content, saved.mentionMode, { embed: saved.embed || null, components: saved.components || [] })
        });
      } else {
        await postDiscordWebhook(decryptDiscordWebhook(action), message, mentionMode, renderedEmbed);
      }
      return;
    }
    if (action.type === 'twitch_shoutout') {
      await sendTwitchShoutout(type, event);
      if (typeof noteAutomationSend === 'function') await noteAutomationSend('eventsub');
    }
  }

  async function runReaction(reaction, type, event, durableStep = null) {
    const holdRelevant = (reaction.actions || []).some((action) => action?.enabled !== false && action?.type !== 'discord_notification');
    if (holdRelevant) beginEventReaction();
    let completed = false;
    console.log(`[EventSub Reactions] Starting ${reaction.name} for ${type}.`);
    try {
      for (const [index, action] of (reaction.actions || []).entries()) {
        if (action.enabled === false) continue;
        try {
          const execute = () => {
            const parentKey = context.current().deliveryScope?.key;
            return parentKey ? context.withDeliveryScope(`${parentKey}:reaction:${reaction._id}:action:${index}`, () => runAction(action, type, event))
              : runAction(action, type, event);
          };
          if (durableStep) await durableStep(`reaction_${reaction._id}_action_${index}`, execute);
          else await execute();
        } catch (err) {
          console.error(`[EventSub Reactions] ${reaction.name} action ${action.type} failed:`, err?.message || err);
          throw err;
        }
      }
      completed = true;
    } finally {
      const configuredHold = Number(reaction.holdSeconds);
      const spacingSeconds = currentAutomationSpacingSeconds();
      const effectiveHoldSeconds = completed && holdRelevant ? Math.max(
        spacingSeconds,
        Number.isFinite(configuredHold) && configuredHold > 0 ? configuredHold : 0
      ) : 0;
      if (holdRelevant) endEventReaction(effectiveHoldSeconds);
      if (completed && holdRelevant) {
        const holdSource = Number.isFinite(configuredHold) && configuredHold > 0 ? 'custom' : 'global Automation Spacing';
        console.log(`[EventSub Reactions] Completed ${reaction.name}; recaps/timers held for ${effectiveHoldSeconds}s (${holdSource}).`);
      } else if (completed) {
        console.log(`[EventSub Reactions] Completed ${reaction.name}; Discord-only reaction did not hold recaps/timers.`);
      } else {
        console.warn(`[EventSub Reactions] Failed ${reaction.name}; no post-reaction recap/timer hold was added.`);
      }
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

  function planEvent(type, event = {}) {
    return JSON.parse(JSON.stringify(cache.filter((reaction) => reaction.enabled !== false && reaction.eventType === type &&
      (!(Number(reaction.minimumValue) > 0) || numericEventValue(type, event) >= Number(reaction.minimumValue)))));
  }
  async function handleEvent(type, event = {}, { plan = null, durableStep = null } = {}) {
    if (!EVENT_TYPE_SET.has(type)) return;
    await waitForHigherPriorityAutomation();
    const candidates = plan || planEvent(type, event);
    for (const reaction of candidates) {
      const minimum = Number(reaction.minimumValue || 0);
      if (minimum > 0 && numericEventValue(type, event) < minimum) continue;
      await runReaction(reaction, type, event, durableStep);
    }
  }

  return {
    initialize,
    listReactions,
    saveReaction,
    deleteReaction,
    setEnabled,
    testDiscordNotification,
    handleEvent, planEvent,
    refreshCache,
    getHoldStatus: getEventReactionHoldStatus,
    getAutomationSpacingSeconds: currentAutomationSpacingSeconds,
    getDiscordSecretStatus: secretBox.status,
    eventTypes: EVENT_TYPES
  };
}

module.exports = {
  EVENT_TYPES,
  MAX_ACTIONS,
  MAX_HOLD_SECONDS,
  MAX_ACTION_DELAY_SECONDS,
  MAX_DISCORD_EMBED_FIELDS,
  MAX_DISCORD_EMBED_BUTTONS,
  createEventSubReactionManager,
  renderEventTemplate,
  numericEventValue,
  normalizeDiscordWebhookUrl,
  discordAllowedMentions,
  normalizeDiscordEmbed,
  renderDiscordEmbed
};
