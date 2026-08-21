const CustomCommand = require('../models/CustomCommand');
const CustomCommandSettings = require('../models/CustomCommandSettings');
const { getFollowInfo: getTwitchFollowInfo, formatFollowAge, formatFollowDate } = require('./twitchFollowers');

const MAX_COMMAND_NAME_LENGTH = 80;
const MAX_TRIGGER_LENGTH = 120;
const MAX_TRIGGERS = 25;
const MAX_RESPONSES = 25;
const MAX_RESPONSE_LENGTH = 500;
const MAX_COOLDOWN_SECONDS = 86400;
const MAX_RESPONSE_DELAY_SECONDS = 30;
const DEFAULT_COMMAND_COOLDOWN_SECONDS = 5;
const DEFAULT_GLOBAL_COOLDOWN_SECONDS = 5;
const RESERVED_COMMANDS = new Set(['!recap', '!startrecap', '!stoprecap']);
const OWN_RESPONSE_TTL_MS = 15000;
const USER_LEVELS = ['everyone', 'subscriber', 'twitch_vip', 'moderator', 'owner'];
const RESPONSE_MODES = ['equal', 'weighted', 'ifelse'];

function normalizeTrigger(triggerType, value) {
  let trigger = String(value || '').trim().replace(/\s+/g, ' ');
  if (triggerType === 'command') {
    trigger = trigger.split(/\s+/)[0] || '';
    if (trigger && !trigger.startsWith('!')) trigger = `!${trigger}`;
  }
  return trigger.toLowerCase();
}

function normalizeResponseCondition(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const first = raw.split(/\s+/)[0] || '';
  return first.replace(/^[^a-z0-9_@-]+|[^a-z0-9_@-]+$/gi, '');
}

function normalizeTriggerEntry(input = {}) {
  const triggerType = input.triggerType === 'inline' ? 'inline' : 'command';
  const rawTrigger = String(input.trigger || '').trim().replace(/\s+/g, ' ');
  const normalizedTrigger = normalizeTrigger(triggerType, rawTrigger);

  if (!normalizedTrigger) throw new Error('Trigger cannot be empty.');
  if (normalizedTrigger.length > MAX_TRIGGER_LENGTH) throw new Error(`Trigger cannot exceed ${MAX_TRIGGER_LENGTH} characters.`);

  if (triggerType === 'command') {
    if (!/^![a-z0-9_][a-z0-9_-]*$/i.test(normalizedTrigger)) {
      throw new Error('Command triggers must look like !command and may use letters, numbers, underscores, or hyphens.');
    }
    if (RESERVED_COMMANDS.has(normalizedTrigger)) {
      throw new Error(`${normalizedTrigger} is reserved by SqwertArmyBot.`);
    }
    if (normalizedTrigger.startsWith('!poke')) {
      throw new Error('Commands beginning with !poke are reserved for the Pokemon Community Game filter.');
    }
  }

  return {
    triggerType,
    trigger: triggerType === 'command' ? normalizedTrigger : rawTrigger,
    normalizedTrigger
  };
}

function getTriggers(command = {}) {
  if (Array.isArray(command.triggers) && command.triggers.length) {
    return command.triggers.map((entry) => ({
      triggerType: entry.triggerType === 'inline' ? 'inline' : 'command',
      trigger: String(entry.trigger || ''),
      normalizedTrigger: String(entry.normalizedTrigger || normalizeTrigger(entry.triggerType, entry.trigger))
    })).filter((entry) => entry.normalizedTrigger);
  }

  if (command.trigger || command.normalizedTrigger) {
    const triggerType = command.triggerType === 'inline' ? 'inline' : 'command';
    const trigger = String(command.trigger || command.normalizedTrigger || '');
    const normalizedTrigger = String(command.normalizedTrigger || normalizeTrigger(triggerType, trigger));
    if (normalizedTrigger) return [{ triggerType, trigger, normalizedTrigger }];
  }

  return [];
}

function validateAndNormalizeInput(input = {}) {
  const name = String(input.name || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Command name cannot be empty.');
  if (name.length > MAX_COMMAND_NAME_LENGTH) throw new Error(`Command name cannot exceed ${MAX_COMMAND_NAME_LENGTH} characters.`);

  const rawTriggers = Array.isArray(input.triggers) && input.triggers.length
    ? input.triggers
    : [{ triggerType: input.triggerType, trigger: input.trigger }];

  if (rawTriggers.length > MAX_TRIGGERS) throw new Error(`A custom command can have at most ${MAX_TRIGGERS} triggers.`);
  const triggers = rawTriggers.map(normalizeTriggerEntry);
  if (!triggers.length) throw new Error('Add at least one trigger.');

  const seen = new Set();
  for (const trigger of triggers) {
    const key = `${trigger.triggerType}:${trigger.normalizedTrigger}`;
    if (seen.has(key)) throw new Error(`Duplicate trigger: ${trigger.trigger}.`);
    seen.add(key);
  }

  const responses = (Array.isArray(input.responses) ? input.responses : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  if (responses.length < 1) throw new Error('Add at least one response.');
  if (responses.length > MAX_RESPONSES) throw new Error(`A command can have at most ${MAX_RESPONSES} responses.`);
  for (const response of responses) {
    if (response.length > MAX_RESPONSE_LENGTH) {
      throw new Error(`Each response can contain at most ${MAX_RESPONSE_LENGTH} characters.`);
    }
  }

  const responseMode = RESPONSE_MODES.includes(String(input.responseMode || '').toLowerCase())
    ? String(input.responseMode).toLowerCase()
    : 'equal';
  const rawWeights = Array.isArray(input.responseWeights) ? input.responseWeights : [];
  const responseWeights = responses.map((_, index) => {
    const value = Number(rawWeights[index] ?? 1);
    if (Number.isFinite(value) && value >= 0) return value;
    return responseMode === 'weighted' ? NaN : 1;
  });
  if (responseMode === 'weighted') {
    if (responseWeights.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new Error('Every response weight must be a number greater than or equal to 0.');
    }
    if (!responseWeights.some((value) => value > 0)) {
      throw new Error('Weighted responses need at least one response with a weight greater than 0.');
    }
  }

  const rawConditions = Array.isArray(input.responseConditions) ? input.responseConditions : [];
  const responseConditions = responses.map((_, index) => normalizeResponseCondition(rawConditions[index]));
  if (responseMode === 'ifelse') {
    const nonBlank = responseConditions.filter(Boolean);
    if (new Set(nonBlank).size !== nonBlank.length) throw new Error('If/Else response words must be unique.');
    if (responseConditions.filter((value) => !value).length > 1) throw new Error('If/Else mode can have only one blank Else response.');
    if (responseConditions.some((value) => value.length > 80)) throw new Error('If/Else match words cannot exceed 80 characters.');
  }

  const userLevel = USER_LEVELS.includes(String(input.userLevel || '').toLowerCase())
    ? String(input.userLevel).toLowerCase()
    : 'everyone';

  const probability = Number(input.probability);
  if (!Number.isFinite(probability) || probability < 0 || probability > 100) {
    throw new Error('Probability must be between 0 and 100. Decimals are allowed.');
  }

  const cooldownSeconds = Number(input.cooldownSeconds ?? DEFAULT_COMMAND_COOLDOWN_SECONDS);
  if (!Number.isFinite(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > MAX_COOLDOWN_SECONDS) {
    throw new Error(`Cooldown must be between 0 and ${MAX_COOLDOWN_SECONDS} seconds.`);
  }

  const cooldownResponse = String(input.cooldownResponse || '').trim();
  if (cooldownResponse.length > MAX_RESPONSE_LENGTH) {
    throw new Error(`Cooldown response can contain at most ${MAX_RESPONSE_LENGTH} characters.`);
  }

  const responseDelaySeconds = Number(input.responseDelaySeconds ?? 0);
  if (!Number.isFinite(responseDelaySeconds) || responseDelaySeconds < 0 || responseDelaySeconds > MAX_RESPONSE_DELAY_SECONDS) {
    throw new Error(`Response delay must be between 0 and ${MAX_RESPONSE_DELAY_SECONDS} seconds.`);
  }

  const primary = triggers[0];
  return {
    name,
    triggers,
    // Mirror the first trigger into the legacy fields for backwards compatibility.
    triggerType: primary.triggerType,
    trigger: primary.trigger,
    normalizedTrigger: primary.normalizedTrigger,
    responses,
    responseMode,
    responseWeights,
    responseConditions,
    userLevel,
    probability,
    cooldownSeconds: Math.round(cooldownSeconds * 1000) / 1000,
    cooldownResponse,
    responseDelaySeconds: Math.round(responseDelaySeconds * 1000) / 1000,
    enabled: input.enabled !== false
  };
}

function commandToClient(command) {
  const triggers = getTriggers(command);
  const primary = triggers[0] || { triggerType: 'command', trigger: '', normalizedTrigger: '' };
  const fallbackName = String(command.name || primary.trigger || 'Custom Command').trim();
  return {
    id: String(command._id),
    name: fallbackName,
    triggers: triggers.map(({ triggerType, trigger }) => ({ triggerType, trigger })),
    // Keep these fields in the response for older UI/client compatibility.
    triggerType: primary.triggerType,
    trigger: primary.trigger,
    responses: Array.isArray(command.responses) ? command.responses : [],
    responseMode: RESPONSE_MODES.includes(command.responseMode) ? command.responseMode : 'equal',
    responseWeights: Array.isArray(command.responseWeights) ? command.responseWeights : [],
    responseConditions: Array.isArray(command.responseConditions) ? command.responseConditions : [],
    userLevel: USER_LEVELS.includes(command.userLevel) ? command.userLevel : 'everyone',
    probability: Number(command.probability ?? 100),
    cooldownSeconds: Number(command.cooldownSeconds ?? 0),
    cooldownResponse: String(command.cooldownResponse || ''),
    responseDelaySeconds: Number(command.responseDelaySeconds ?? 0),
    enabled: command.enabled !== false,
    counter: Number(command.counter || 0),
    createdAt: command.createdAt || null,
    updatedAt: command.updatedAt || null
  };
}

function getCommandQuery(message) {
  const raw = String(message || '').trim();
  const parts = raw.split(/\s+/);
  return {
    token: String(parts[0] || '').toLowerCase(),
    query: parts.slice(1).join(' ').trim()
  };
}

function findInlineQuery(rawMessage, normalizedTrigger) {
  const raw = String(rawMessage || '');
  const lower = raw.toLowerCase();
  const index = lower.indexOf(normalizedTrigger);
  if (index === -1) return '';
  return raw.slice(index + normalizedTrigger.length).trim();
}

function firstTarget(query, fallback) {
  const first = String(query || '').trim().split(/\s+/)[0] || '';
  const target = first.replace(/^@+/, '').trim();
  return target || fallback;
}

function replaceAllToken(text, token, value) {
  return text.split(token).join(String(value ?? ''));
}

function randomIntegerInclusive(min, max) {
  const low = Math.ceil(Number(min));
  const high = Math.floor(Number(max));
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low > high) return null;
  const span = high - low + 1;
  if (!Number.isSafeInteger(span) || span <= 0) return null;
  return Math.floor(Math.random() * span) + low;
}

function renderResponse(template, context) {
  const user = String(context.user || 'viewer');
  const query = String(context.query || '');
  const toUser = firstTarget(query, user);
  const count = String(context.count ?? 0);
  const followAge = String(context.followAge || '');
  const followDate = String(context.followDate || '');

  let output = String(template || '');
  output = output.replace(/\$\(random\s+(-?\d+)\s+(-?\d+)\)/gi, (match, min, max) => {
    const value = randomIntegerInclusive(min, max);
    return value === null ? match : String(value);
  });

  const randomUsers = Array.isArray(context.randomUsers) ? [...context.randomUsers] : [];
  output = output.replace(/\$\(randomuser\)/gi, () => {
    const chatter = randomUsers.shift();
    return String(chatter?.displayName || chatter?.login || user);
  });

  const pairs = [
    ['$(user)', user], ['$user', user],
    ['$(touser)', toUser], ['$touser', toUser],
    ['$(query)', query], ['$query', query],
    ['$(count)', count], ['$count', count],
    ['$(followage)', followAge], ['$followage', followAge],
    ['$(followdate)', followDate], ['$followdate', followDate]
  ];

  for (const [token, value] of pairs) output = replaceAllToken(output, token, value);

  return Array.from(output).slice(0, MAX_RESPONSE_LENGTH).join('').trim();
}

function templateNeedsFollowInfo(template) {
  return /\$\(follow(?:age|date)\)|\$follow(?:age|date)\b/i.test(String(template || ''));
}

async function resolveFollowContext({ template, query, displayName, getFollowInfo = getTwitchFollowInfo }) {
  if (!templateNeedsFollowInfo(template)) return { followAge: '', followDate: '' };

  const target = firstTarget(query, displayName);
  const info = await getFollowInfo({ viewerLogin: target });
  if (!info?.foundUser) {
    throw new Error(`Twitch user ${target} was not found.`);
  }
  if (!info?.isFollowing || !info?.followedAt) {
    return { followAge: 'not following', followDate: 'not following' };
  }

  return {
    followAge: formatFollowAge(info.followedAt),
    followDate: formatFollowDate(info.followedAt)
  };
}

function normalizeIfElseWord(query) {
  return normalizeResponseCondition(String(query || '').trim().split(/\s+/)[0] || '');
}

function chooseResponseTemplate(command, responses, query) {
  const mode = RESPONSE_MODES.includes(command?.responseMode) ? command.responseMode : 'equal';
  if (!responses.length) return { template: '', index: -1, mode };

  if (mode === 'weighted') {
    const weights = responses.map((_, index) => {
      const value = Number(command?.responseWeights?.[index] ?? 1);
      return Number.isFinite(value) && value > 0 ? value : 0;
    });
    const total = weights.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return { template: '', index: -1, mode };
    let roll = Math.random() * total;
    for (let index = 0; index < responses.length; index += 1) {
      roll -= weights[index];
      if (roll < 0) return { template: responses[index], index, mode };
    }
    return { template: responses[responses.length - 1], index: responses.length - 1, mode };
  }

  if (mode === 'ifelse') {
    const conditions = responses.map((_, index) => String(command?.responseConditions?.[index] || '').trim().toLowerCase());
    const word = normalizeIfElseWord(query);
    let index = conditions.findIndex((condition) => condition && condition === word);
    if (index === -1) index = conditions.findIndex((condition) => !condition);
    return index === -1 ? { template: '', index: -1, mode } : { template: responses[index], index, mode };
  }

  const index = Math.floor(Math.random() * responses.length);
  return { template: responses[index], index, mode };
}

function getViewerUserLevel(tags = {}) {
  const badges = tags.badges || {};
  if (badges.broadcaster === '1') return 'owner';
  if (tags.mod === true || tags.mod === '1' || badges.moderator === '1') return 'moderator';
  if (badges.vip === '1') return 'twitch_vip';
  if (tags.subscriber === true || tags.subscriber === '1' || badges.subscriber || badges.founder) return 'subscriber';
  return 'everyone';
}

function meetsUserLevel(tags = {}, required = 'everyone') {
  const hierarchy = { everyone: 0, subscriber: 1, twitch_vip: 2, moderator: 3, owner: 4 };
  const actual = getViewerUserLevel(tags);
  const requiredLevel = USER_LEVELS.includes(required) ? required : 'everyone';
  return hierarchy[actual] >= hierarchy[requiredLevel];
}

function createCustomCommandManager({ channelName, sendMessage, getRandomChatters = null, getFollowInfo = getTwitchFollowInfo }) {
  const normalizedChannel = String(channelName || '').toLowerCase().trim();
  let cache = [];
  let globalCooldownSeconds = DEFAULT_GLOBAL_COOLDOWN_SECONDS;
  let lastGlobalResponseAt = 0;
  let globalResponseInFlight = false;
  const lastTriggeredAt = new Map();
  const ownResponses = [];

  async function refreshCache() {
    cache = await CustomCommand.find({ channelName: normalizedChannel }).sort({ createdAt: 1 }).lean();
    return cache;
  }

  async function refreshSettings() {
    const settings = await CustomCommandSettings.findOne({ channelName: normalizedChannel }).lean();
    const value = Number(settings?.globalCooldownSeconds ?? DEFAULT_GLOBAL_COOLDOWN_SECONDS);
    globalCooldownSeconds = Number.isFinite(value)
      ? Math.max(0, Math.min(MAX_COOLDOWN_SECONDS, value))
      : DEFAULT_GLOBAL_COOLDOWN_SECONDS;
    return { globalCooldownSeconds };
  }

  async function initialize() {
    await Promise.all([refreshCache(), refreshSettings()]);
    console.log(`[Custom Commands] Loaded ${cache.length} command(s) from MongoDB. Global cooldown: ${globalCooldownSeconds}s.`);
  }

  async function getSettings() {
    await refreshSettings();
    return { globalCooldownSeconds };
  }

  async function saveSettings(input = {}) {
    const value = Number(input.globalCooldownSeconds ?? DEFAULT_GLOBAL_COOLDOWN_SECONDS);
    if (!Number.isFinite(value) || value < 0 || value > MAX_COOLDOWN_SECONDS) {
      throw new Error(`Global cooldown must be between 0 and ${MAX_COOLDOWN_SECONDS} seconds.`);
    }
    const normalized = Math.round(value * 1000) / 1000;
    await CustomCommandSettings.findOneAndUpdate(
      { channelName: normalizedChannel },
      { $set: { globalCooldownSeconds: normalized } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    globalCooldownSeconds = normalized;
    return { globalCooldownSeconds };
  }

  function isGlobalCoolingDown(now = Date.now()) {
    const globalCooldownMs = Math.max(0, Number(globalCooldownSeconds || 0) * 1000);
    return globalResponseInFlight || (globalCooldownMs > 0 && now - lastGlobalResponseAt < globalCooldownMs);
  }

  function acquireGlobalResponseSlot() {
    if (isGlobalCoolingDown()) return false;
    globalResponseInFlight = true;
    return true;
  }

  function releaseGlobalResponseSlot({ sent = false } = {}) {
    if (sent) lastGlobalResponseAt = Date.now();
    globalResponseInFlight = false;
  }

  async function listCommands() {
    await refreshCache();
    return cache.map(commandToClient);
  }

  async function assertTriggersAvailable(triggers, excludingId = '') {
    const docs = await CustomCommand.find({ channelName: normalizedChannel }).lean();
    const wanted = new Set(triggers.map((trigger) => `${trigger.triggerType}:${trigger.normalizedTrigger}`));
    for (const doc of docs) {
      if (excludingId && String(doc._id) === excludingId) continue;
      for (const existing of getTriggers(doc)) {
        if (wanted.has(`${existing.triggerType}:${existing.normalizedTrigger}`)) {
          throw new Error(`Trigger ${existing.trigger} is already used by another custom command.`);
        }
      }
    }
  }

  async function saveCommand(input = {}) {
    const normalized = validateAndNormalizeInput(input);
    const id = String(input.id || '').trim();
    await assertTriggersAvailable(normalized.triggers, id);
    let saved;

    try {
      if (id) {
        saved = await CustomCommand.findOneAndUpdate(
          { _id: id, channelName: normalizedChannel },
          { $set: normalized },
          { new: true, runValidators: true }
        );
        if (!saved) throw new Error('Custom command was not found.');
      } else {
        saved = await CustomCommand.create({ channelName: normalizedChannel, ...normalized });
      }
    } catch (err) {
      if (err?.code === 11000) throw new Error('One of those custom-command triggers is already in use.');
      throw err;
    }

    await refreshCache();
    console.log(`[Custom Commands] ${id ? 'Updated' : 'Created'} command with ${normalized.triggers.length} trigger(s).`);
    return commandToClient(saved);
  }

  async function deleteCommand(id) {
    const deleted = await CustomCommand.findOneAndDelete({ _id: id, channelName: normalizedChannel });
    if (!deleted) throw new Error('Custom command was not found.');
    lastTriggeredAt.delete(String(id));
    await refreshCache();
    console.log(`[Custom Commands] Deleted command with ${getTriggers(deleted).length} trigger(s).`);
    return true;
  }

  async function setEnabled(id, enabled) {
    const updated = await CustomCommand.findOneAndUpdate(
      { _id: id, channelName: normalizedChannel },
      { $set: { enabled: Boolean(enabled) } },
      { new: true, runValidators: true }
    );
    if (!updated) throw new Error('Custom command was not found.');
    await refreshCache();
    return commandToClient(updated);
  }

  async function setCounter(id, value) {
    const numericValue = Number(value);
    if (!Number.isInteger(numericValue) || numericValue < 0) {
      throw new Error('Counter must be a whole integer greater than or equal to 0.');
    }

    const updated = await CustomCommand.findOneAndUpdate(
      { _id: id, channelName: normalizedChannel },
      { $set: { counter: numericValue } },
      { new: true, runValidators: true }
    );
    if (!updated) throw new Error('Custom command was not found.');
    await refreshCache();
    return commandToClient(updated);
  }

  function cleanupOwnResponses() {
    const cutoff = Date.now() - OWN_RESPONSE_TTL_MS;
    while (ownResponses.length && ownResponses[0].createdAt < cutoff) ownResponses.shift();
  }

  function noteOwnResponse(message) {
    cleanupOwnResponses();
    ownResponses.push({ message: String(message || '').trim(), createdAt: Date.now() });
  }

  function consumeOwnResponse(message) {
    cleanupOwnResponses();
    const normalized = String(message || '').trim();
    const index = ownResponses.findIndex((entry) => entry.message === normalized);
    if (index === -1) return false;
    ownResponses.splice(index, 1);
    return true;
  }

  function findMatch(rawMessage) {
    const raw = String(rawMessage || '').trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();
    const { token, query } = getCommandQuery(raw);

    // Exact !command triggers take priority across all custom commands.
    for (const command of cache) {
      if (command.enabled === false) continue;
      const trigger = getTriggers(command).find((entry) => entry.triggerType === 'command' && entry.normalizedTrigger === token);
      if (trigger) return { command, trigger, query };
    }

    // For inline phrases, prefer the longest matching phrase to avoid a short
    // trigger stealing a message from a more specific trigger.
    const inlineMatches = [];
    for (const command of cache) {
      if (command.enabled === false) continue;
      for (const trigger of getTriggers(command)) {
        if (trigger.triggerType === 'inline' && lower.includes(trigger.normalizedTrigger)) {
          inlineMatches.push({ command, trigger });
        }
      }
    }
    inlineMatches.sort((a, b) => b.trigger.normalizedTrigger.length - a.trigger.normalizedTrigger.length);
    if (!inlineMatches.length) return null;
    const match = inlineMatches[0];
    return {
      ...match,
      query: findInlineQuery(raw, match.trigger.normalizedTrigger)
    };
  }

  async function handleMessage({ rawMessage, displayName, tags = {} }) {
    const match = findMatch(rawMessage);
    if (!match) return { matched: false };

    const command = match.command;
    const matchedTrigger = match.trigger;
    const commandId = String(command._id);

    if (!meetsUserLevel(tags, command.userLevel || 'everyone')) {
      return {
        matched: true,
        triggerType: matchedTrigger.triggerType,
        trigger: matchedTrigger.trigger,
        responded: false,
        reason: 'userlevel',
        requiredUserLevel: command.userLevel || 'everyone'
      };
    }

    const now = Date.now();
    if (isGlobalCoolingDown(now)) {
      return {
        matched: true,
        triggerType: matchedTrigger.triggerType,
        trigger: matchedTrigger.trigger,
        responded: false,
        reason: 'global_cooldown'
      };
    }

    const cooldownMs = Math.max(0, Number(command.cooldownSeconds || 0) * 1000);
    const previous = lastTriggeredAt.get(commandId) || 0;

    if (cooldownMs > 0 && now - previous < cooldownMs) {
      const cooldownTemplate = String(command.cooldownResponse || '').trim();
      if (!cooldownTemplate) {
        return { matched: true, triggerType: matchedTrigger.triggerType, trigger: matchedTrigger.trigger, responded: false, reason: 'cooldown' };
      }

      const randomUserCount = (cooldownTemplate.match(/\$\(randomuser\)/gi) || []).length;
      let randomUsers = [];
      if (randomUserCount > 0) {
        if (typeof getRandomChatters !== 'function') {
          return { matched: true, triggerType: matchedTrigger.triggerType, trigger: matchedTrigger.trigger, responded: false, reason: 'randomuser_unavailable' };
        }
        try {
          randomUsers = await getRandomChatters(randomUserCount);
        } catch (err) {
          console.error('[Custom Commands] Could not resolve $(randomuser) for cooldown response:', err.message || err);
          return { matched: true, triggerType: matchedTrigger.triggerType, trigger: matchedTrigger.trigger, responded: false, reason: 'randomuser_error' };
        }
        if (randomUsers.length < randomUserCount) {
          return { matched: true, triggerType: matchedTrigger.triggerType, trigger: matchedTrigger.trigger, responded: false, reason: 'no_random_chatter' };
        }
      }

      let followContext = { followAge: '', followDate: '' };
      try {
        followContext = await resolveFollowContext({
          template: cooldownTemplate,
          query: match.query,
          displayName,
          getFollowInfo
        });
      } catch (err) {
        console.error('[Custom Commands] Could not resolve follow variable for cooldown response:', err.message || err);
        return { matched: true, triggerType: matchedTrigger.triggerType, trigger: matchedTrigger.trigger, responded: false, reason: 'follow_lookup_error' };
      }

      const renderedCooldown = renderResponse(cooldownTemplate, {
        user: displayName,
        query: match.query,
        count: Number(command.counter || 0),
        randomUsers,
        ...followContext
      });
      if (!renderedCooldown) {
        return { matched: true, triggerType: matchedTrigger.triggerType, trigger: matchedTrigger.trigger, responded: false, reason: 'cooldown' };
      }

      if (!acquireGlobalResponseSlot()) {
        return { matched: true, triggerType: matchedTrigger.triggerType, trigger: matchedTrigger.trigger, responded: false, reason: 'global_cooldown' };
      }

      noteOwnResponse(renderedCooldown);
      let result;
      let sent = false;
      try {
        result = await sendMessage(normalizedChannel, renderedCooldown);
        sent = true;
      } finally {
        releaseGlobalResponseSlot({ sent });
      }
      return {
        matched: true,
        triggerType: matchedTrigger.triggerType,
        trigger: matchedTrigger.trigger,
        responded: true,
        reason: 'cooldown',
        cooldownResponse: true,
        message: renderedCooldown,
        sendMethod: result?.method || 'unknown'
      };
    }

    const probability = Math.max(0, Math.min(100, Number(command.probability ?? 100)));
    if (probability <= 0 || Math.random() * 100 >= probability) {
      return { matched: true, triggerType: matchedTrigger.triggerType, trigger: matchedTrigger.trigger, responded: false, reason: 'probability' };
    }

    const currentResponses = Array.isArray(command.responses) ? command.responses.filter(Boolean) : [];
    if (!currentResponses.length) {
      return { matched: true, triggerType: matchedTrigger.triggerType, trigger: matchedTrigger.trigger, responded: false, reason: 'no_response' };
    }

    const selection = chooseResponseTemplate(command, currentResponses, match.query);
    const template = selection.template;
    if (!template) {
      return { matched: true, triggerType: matchedTrigger.triggerType, trigger: matchedTrigger.trigger, responded: false, reason: selection.mode === 'ifelse' ? 'ifelse_no_match' : 'no_response' };
    }
    const randomUserCount = (String(template).match(/\$\(randomuser\)/gi) || []).length;
    let randomUsers = [];

    if (randomUserCount > 0) {
      if (typeof getRandomChatters !== 'function') {
        return { matched: true, triggerType: matchedTrigger.triggerType, trigger: matchedTrigger.trigger, responded: false, reason: 'randomuser_unavailable' };
      }

      try {
        randomUsers = await getRandomChatters(randomUserCount);
      } catch (err) {
        console.error('[Custom Commands] Could not resolve $(randomuser):', err.message || err);
        return {
          matched: true,
          triggerType: matchedTrigger.triggerType,
          trigger: matchedTrigger.trigger,
          responded: false,
          reason: 'randomuser_error'
        };
      }

      if (randomUsers.length < randomUserCount) {
        console.warn('[Custom Commands] $(randomuser) could not find enough eligible current chatters.');
        return { matched: true, triggerType: matchedTrigger.triggerType, trigger: matchedTrigger.trigger, responded: false, reason: 'no_random_chatter' };
      }
    }

    let followContext = { followAge: '', followDate: '' };
    try {
      followContext = await resolveFollowContext({
        template,
        query: match.query,
        displayName,
        getFollowInfo
      });
    } catch (err) {
      console.error('[Custom Commands] Could not resolve follow variable:', err.message || err);
      return {
        matched: true,
        triggerType: matchedTrigger.triggerType,
        trigger: matchedTrigger.trigger,
        responded: false,
        reason: 'follow_lookup_error'
      };
    }

    const responseDelayMs = Math.max(0, Number(command.responseDelaySeconds || 0) * 1000);
    if (responseDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, responseDelayMs));

      // Another invocation of this command may have completed while this one was
      // waiting. Re-check the per-command cooldown so delayed responses cannot
      // slip through concurrently when the global cooldown is disabled.
      const delayedNow = Date.now();
      const delayedPrevious = lastTriggeredAt.get(commandId) || 0;
      if (cooldownMs > 0 && delayedNow - delayedPrevious < cooldownMs) {
        return { matched: true, triggerType: matchedTrigger.triggerType, trigger: matchedTrigger.trigger, responded: false, reason: 'cooldown' };
      }
    }

    if (!acquireGlobalResponseSlot()) {
      return { matched: true, triggerType: matchedTrigger.triggerType, trigger: matchedTrigger.trigger, responded: false, reason: 'global_cooldown' };
    }

    let updated;
    try {
      updated = await CustomCommand.findOneAndUpdate(
        { _id: command._id, channelName: normalizedChannel, enabled: true },
        { $inc: { counter: 1 } },
        { new: true }
      ).lean();
    } catch (err) {
      releaseGlobalResponseSlot();
      throw err;
    }

    if (!updated) {
      releaseGlobalResponseSlot();
      await refreshCache();
      return { matched: true, triggerType: matchedTrigger.triggerType, trigger: matchedTrigger.trigger, responded: false, reason: 'disabled' };
    }

    const responses = Array.isArray(updated.responses) ? updated.responses.filter(Boolean) : currentResponses;
    const rendered = renderResponse(template, {
      user: displayName,
      query: match.query,
      count: updated.counter,
      randomUsers,
      ...followContext
    });

    if (!rendered) {
      releaseGlobalResponseSlot();
      return { matched: true, triggerType: matchedTrigger.triggerType, trigger: matchedTrigger.trigger, responded: false, reason: 'empty_response' };
    }

    noteOwnResponse(rendered);
    let result;
    let sent = false;
    try {
      result = await sendMessage(normalizedChannel, rendered);
      sent = true;
    } catch (err) {
      await CustomCommand.updateOne(
        { _id: command._id, channelName: normalizedChannel, counter: { $gt: 0 } },
        { $inc: { counter: -1 } }
      ).catch(() => {});
      throw err;
    } finally {
      releaseGlobalResponseSlot({ sent });
    }
    lastTriggeredAt.set(commandId, Date.now());

    const cached = cache.find((item) => String(item._id) === commandId);
    if (cached) cached.counter = updated.counter;

    console.log(`[Custom Commands] Triggered ${matchedTrigger.triggerType} ${matchedTrigger.trigger} -> response ${selection.index + 1}/${responses.length} (${selection.mode}).`);

    return {
      matched: true,
      triggerType: matchedTrigger.triggerType,
      trigger: matchedTrigger.trigger,
      responded: true,
      counter: updated.counter,
      message: rendered,
      sendMethod: result?.method || 'unknown'
    };
  }

  return {
    initialize,
    listCommands,
    getSettings,
    saveSettings,
    saveCommand,
    deleteCommand,
    setEnabled,
    setCounter,
    handleMessage,
    consumeOwnResponse,
    refreshCache
  };
}

module.exports = {
  MAX_COMMAND_NAME_LENGTH,
  MAX_TRIGGER_LENGTH,
  MAX_TRIGGERS,
  MAX_RESPONSES,
  MAX_RESPONSE_LENGTH,
  MAX_COOLDOWN_SECONDS,
  MAX_RESPONSE_DELAY_SECONDS,
  DEFAULT_COMMAND_COOLDOWN_SECONDS,
  DEFAULT_GLOBAL_COOLDOWN_SECONDS,
  RESERVED_COMMANDS,
  USER_LEVELS,
  RESPONSE_MODES,
  createCustomCommandManager,
  normalizeTrigger,
  normalizeResponseCondition,
  renderResponse,
  randomIntegerInclusive,
  getViewerUserLevel,
  meetsUserLevel,
  chooseResponseTemplate,
  normalizeIfElseWord,
  templateNeedsFollowInfo,
  resolveFollowContext
};
