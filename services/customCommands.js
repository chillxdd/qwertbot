const CustomCommand = require('../models/CustomCommand');

const MAX_TRIGGER_LENGTH = 120;
const MAX_RESPONSES = 25;
const MAX_RESPONSE_LENGTH = 500;
const MAX_COOLDOWN_SECONDS = 86400;
const RESERVED_COMMANDS = new Set(['!recap', '!startrecap', '!stoprecap']);
const OWN_RESPONSE_TTL_MS = 15000;

function normalizeTrigger(triggerType, value) {
  let trigger = String(value || '').trim().replace(/\s+/g, ' ');
  if (triggerType === 'command') {
    trigger = trigger.split(/\s+/)[0] || '';
    if (trigger && !trigger.startsWith('!')) trigger = `!${trigger}`;
  }
  return trigger.toLowerCase();
}

function validateAndNormalizeInput(input = {}) {
  const triggerType = input.triggerType === 'inline' ? 'inline' : 'command';
  const rawTrigger = String(input.trigger || '').trim().replace(/\s+/g, ' ');
  const normalizedTrigger = normalizeTrigger(triggerType, rawTrigger);

  if (!normalizedTrigger) throw new Error('Command / trigger cannot be empty.');
  if (normalizedTrigger.length > MAX_TRIGGER_LENGTH) throw new Error(`Command / trigger cannot exceed ${MAX_TRIGGER_LENGTH} characters.`);

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

  const probability = Number(input.probability);
  if (!Number.isFinite(probability) || probability < 0 || probability > 100) {
    throw new Error('Probability must be between 0 and 100. Decimals are allowed.');
  }

  const cooldownSeconds = Number(input.cooldownSeconds ?? 0);
  if (!Number.isFinite(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > MAX_COOLDOWN_SECONDS) {
    throw new Error(`Cooldown must be between 0 and ${MAX_COOLDOWN_SECONDS} seconds.`);
  }

  return {
    triggerType,
    trigger: triggerType === 'command' ? normalizedTrigger : rawTrigger,
    normalizedTrigger,
    responses,
    probability,
    cooldownSeconds: Math.round(cooldownSeconds * 1000) / 1000,
    enabled: input.enabled !== false
  };
}

function commandToClient(command) {
  return {
    id: String(command._id),
    triggerType: command.triggerType,
    trigger: command.trigger,
    responses: Array.isArray(command.responses) ? command.responses : [],
    probability: Number(command.probability ?? 100),
    cooldownSeconds: Number(command.cooldownSeconds ?? 0),
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

function renderResponse(template, context) {
  const user = String(context.user || 'viewer');
  const query = String(context.query || '');
  const toUser = firstTarget(query, user);
  const count = String(context.count ?? 0);

  let output = String(template || '');
  const pairs = [
    ['$(user)', user], ['$user', user],
    ['$(touser)', toUser], ['$touser', toUser],
    ['$(query)', query], ['$query', query],
    ['$(count)', count], ['$count', count]
  ];

  for (const [token, value] of pairs) output = replaceAllToken(output, token, value);

  // Twitch's chat message hard limit is 500 characters. Each stored response is
  // independently allowed up to 500; variable expansion can make it longer, so
  // clamp only the final rendered message rather than reducing response storage.
  return Array.from(output).slice(0, MAX_RESPONSE_LENGTH).join('').trim();
}

function createCustomCommandManager({ channelName, sendMessage }) {
  const normalizedChannel = String(channelName || '').toLowerCase().trim();
  let cache = [];
  const lastTriggeredAt = new Map();
  const ownResponses = [];

  async function refreshCache() {
    cache = await CustomCommand.find({ channelName: normalizedChannel }).sort({ createdAt: 1 }).lean();
    return cache;
  }

  async function initialize() {
    await refreshCache();
    console.log(`[Custom Commands] Loaded ${cache.length} command(s) from MongoDB.`);
  }

  async function listCommands() {
    await refreshCache();
    return cache.map(commandToClient);
  }

  async function saveCommand(input = {}) {
    const normalized = validateAndNormalizeInput(input);
    const id = String(input.id || '').trim();
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
      if (err?.code === 11000) throw new Error('A custom command with that trigger and type already exists.');
      throw err;
    }

    await refreshCache();
    console.log(`[Custom Commands] ${id ? 'Updated' : 'Created'} ${saved.triggerType} trigger ${saved.trigger}.`);
    return commandToClient(saved);
  }

  async function deleteCommand(id) {
    const deleted = await CustomCommand.findOneAndDelete({ _id: id, channelName: normalizedChannel });
    if (!deleted) throw new Error('Custom command was not found.');
    lastTriggeredAt.delete(String(id));
    await refreshCache();
    console.log(`[Custom Commands] Deleted ${deleted.triggerType} trigger ${deleted.trigger}.`);
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

  async function resetCounter(id) {
    const updated = await CustomCommand.findOneAndUpdate(
      { _id: id, channelName: normalizedChannel },
      { $set: { counter: 0 } },
      { new: true }
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

    const commandMatch = cache.find((command) => command.enabled !== false && command.triggerType === 'command' && command.normalizedTrigger === token);
    if (commandMatch) return { command: commandMatch, query };

    const inlineMatches = cache
      .filter((command) => command.enabled !== false && command.triggerType === 'inline' && lower.includes(command.normalizedTrigger))
      .sort((a, b) => b.normalizedTrigger.length - a.normalizedTrigger.length);

    if (!inlineMatches.length) return null;
    const command = inlineMatches[0];
    return { command, query: findInlineQuery(raw, command.normalizedTrigger) };
  }

  async function handleMessage({ rawMessage, displayName }) {
    const match = findMatch(rawMessage);
    if (!match) return { matched: false };

    const command = match.command;
    const commandId = String(command._id);
    const now = Date.now();
    const cooldownMs = Math.max(0, Number(command.cooldownSeconds || 0) * 1000);
    const previous = lastTriggeredAt.get(commandId) || 0;

    if (cooldownMs > 0 && now - previous < cooldownMs) {
      return { matched: true, triggerType: command.triggerType, responded: false, reason: 'cooldown' };
    }

    const probability = Math.max(0, Math.min(100, Number(command.probability ?? 100)));
    if (probability <= 0 || Math.random() * 100 >= probability) {
      return { matched: true, triggerType: command.triggerType, responded: false, reason: 'probability' };
    }

    const updated = await CustomCommand.findOneAndUpdate(
      { _id: command._id, channelName: normalizedChannel, enabled: true },
      { $inc: { counter: 1 } },
      { new: true }
    ).lean();

    if (!updated) {
      await refreshCache();
      return { matched: true, triggerType: command.triggerType, responded: false, reason: 'disabled' };
    }

    const responses = Array.isArray(updated.responses) ? updated.responses.filter(Boolean) : [];
    if (!responses.length) return { matched: true, triggerType: command.triggerType, responded: false, reason: 'no_response' };

    const template = responses[Math.floor(Math.random() * responses.length)];
    const rendered = renderResponse(template, {
      user: displayName,
      query: match.query,
      count: updated.counter
    });

    if (!rendered) return { matched: true, triggerType: command.triggerType, responded: false, reason: 'empty_response' };

    // Register the exact outgoing text before sending so the IRC echo cannot race
    // ahead of our recap-noise suppression. Stale entries self-expire quickly.
    noteOwnResponse(rendered);
    let result;
    try {
      result = await sendMessage(normalizedChannel, rendered);
    } catch (err) {
      // The counter represents successful command responses, so roll back the
      // atomic increment if Twitch rejected/failed the send.
      await CustomCommand.updateOne(
        { _id: command._id, channelName: normalizedChannel, counter: { $gt: 0 } },
        { $inc: { counter: -1 } }
      ).catch(() => {});
      throw err;
    }
    lastTriggeredAt.set(commandId, Date.now());

    const cached = cache.find((item) => String(item._id) === commandId);
    if (cached) cached.counter = updated.counter;

    console.log(`[Custom Commands] Triggered ${updated.trigger} -> response ${responses.indexOf(template) + 1}/${responses.length}.`);

    return {
      matched: true,
      triggerType: updated.triggerType,
      responded: true,
      counter: updated.counter,
      message: rendered,
      sendMethod: result?.method || 'unknown'
    };
  }

  return {
    initialize,
    listCommands,
    saveCommand,
    deleteCommand,
    setEnabled,
    resetCounter,
    handleMessage,
    consumeOwnResponse,
    refreshCache
  };
}

module.exports = {
  MAX_TRIGGER_LENGTH,
  MAX_RESPONSES,
  MAX_RESPONSE_LENGTH,
  MAX_COOLDOWN_SECONDS,
  RESERVED_COMMANDS,
  createCustomCommandManager,
  normalizeTrigger,
  renderResponse
};
