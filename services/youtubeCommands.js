'use strict';

const YouTubeCustomCommand = require('../models/YouTubeCustomCommand');
const YouTubeCustomCommandSettings = require('../models/YouTubeCustomCommandSettings');
const YouTubeNativeCommandConfig = require('../models/YouTubeNativeCommandConfig');
const { YOUTUBE_COMMANDS_URL } = require('../config/app');
const {
  normalizeCommandTrigger,
  parseCommandMessage,
  classifyYouTubeUser,
  userMeetsLevel,
  selectResponseIndex,
  renderUniversalResponse
} = require('../features/youtube/pure');

const DEFAULT_NATIVE_RESPONSE = `YouTube commands: ${YOUTUBE_COMMANDS_URL}`;
const MAX_CHAT_MESSAGE_LENGTH = 200;
const RECENT_CHATTERS_MAX = 250;

function createYouTubeCommandManager({ channelKey, sendMessage }) {
  let commandMap = new Map();
  let settings = { globalCooldownSeconds: 5 };
  let nativeConfig = { commandsEnabled: true, commandsResponse: '' };
  let loaded = false;
  const commandCooldowns = new Map();
  const globalCooldowns = new Map();
  const recentChatters = new Map();
  const nativeCooldowns = new Map();

  async function reload() {
    const [commands, savedSettings, savedNative] = await Promise.all([
      YouTubeCustomCommand.find({ channelKey, enabled: true }).lean(),
      YouTubeCustomCommandSettings.findOne({ channelKey }).lean(),
      YouTubeNativeCommandConfig.findOne({ channelKey }).lean()
    ]);
    commandMap = new Map();
    for (const command of commands) {
      const triggers = Array.isArray(command.triggers) && command.triggers.length
        ? command.triggers
        : [command.normalizedTrigger || command.trigger];
      for (const value of triggers) {
        const trigger = normalizeCommandTrigger(value);
        if (trigger) commandMap.set(trigger, command);
      }
    }
    settings = { globalCooldownSeconds: Number(savedSettings?.globalCooldownSeconds ?? 5) };
    nativeConfig = {
      commandsEnabled: savedNative?.commandsEnabled !== false,
      commandsResponse: String(savedNative?.commandsResponse || '')
    };
    loaded = true;
  }

  async function ensureLoaded() {
    if (!loaded) await reload();
  }

  function noteChatter(liveChatId, displayName) {
    const chatId = String(liveChatId || '');
    const name = String(displayName || '').trim();
    if (!chatId || !name) return;
    let list = recentChatters.get(chatId);
    if (!list) { list = []; recentChatters.set(chatId, list); }
    const existing = list.findIndex((value) => value.toLowerCase() === name.toLowerCase());
    if (existing >= 0) list.splice(existing, 1);
    list.push(name);
    if (list.length > RECENT_CHATTERS_MAX) list.splice(0, list.length - RECENT_CHATTERS_MAX);
  }

  function randomChatter(liveChatId, fallback) {
    const list = recentChatters.get(String(liveChatId || '')) || [];
    if (!list.length) return fallback;
    return list[Math.floor(Math.random() * list.length)] || fallback;
  }

  function cooldownKey(liveChatId, commandId) { return `${liveChatId}:${commandId}`; }
  function isCooling(map, key, seconds) {
    const until = Number(map.get(key) || 0);
    if (until > Date.now()) return true;
    if (seconds > 0) map.set(key, Date.now() + seconds * 1000);
    return false;
  }

  async function handleTextMessage({ liveChatId, message, author }) {
    noteChatter(liveChatId, author?.displayName);
    const parsed = parseCommandMessage(message);
    if (!parsed) return { handled: false };
    await ensureLoaded();

    if (parsed.trigger === '!commands') {
      if (!nativeConfig.commandsEnabled) return { handled: false, reason: 'native-disabled' };
      if (!userMeetsLevel(classifyYouTubeUser(author), 'everyone')) return { handled: false };
      if (isCooling(nativeCooldowns, String(liveChatId), 5)) return { handled: true, sent: false, reason: 'cooldown' };
      const response = (nativeConfig.commandsResponse || DEFAULT_NATIVE_RESPONSE).slice(0, MAX_CHAT_MESSAGE_LENGTH);
      const delivery = await sendMessage(liveChatId, response, { kind: 'command' });
      return { handled: true, sent: Boolean(delivery?.sent), queued: Boolean(delivery?.queued), native: true };
    }

    const command = commandMap.get(parsed.trigger);
    if (!command || command.enabled === false) return { handled: false };
    const level = classifyYouTubeUser(author);
    if (!userMeetsLevel(level, command.userLevel || 'everyone')) return { handled: true, sent: false, reason: 'permission' };

    const globalSeconds = Math.max(0, Number(settings.globalCooldownSeconds || 0));
    if (isCooling(globalCooldowns, String(liveChatId), globalSeconds)) return { handled: true, sent: false, reason: 'global-cooldown' };
    const key = cooldownKey(liveChatId, String(command._id));
    if (isCooling(commandCooldowns, key, Math.max(0, Number(command.cooldownSeconds || 0)))) {
      const cooldownResponse = String(command.cooldownResponse || '').slice(0, MAX_CHAT_MESSAGE_LENGTH);
      if (cooldownResponse) {
        const delivery = await sendMessage(liveChatId, cooldownResponse, { kind: 'command' });
        return { handled: true, sent: Boolean(delivery?.sent), queued: Boolean(delivery?.queued), reason: 'command-cooldown' };
      }
      return { handled: true, sent: false, reason: 'command-cooldown' };
    }

    if (Math.random() * 100 >= Math.max(0, Math.min(100, Number(command.probability ?? 100)))) {
      return { handled: true, sent: false, reason: 'probability' };
    }

    const responseIndex = selectResponseIndex({
      responses: command.responses,
      mode: command.responseMode,
      weights: command.responseWeights,
      lastIndex: Number(command.lastResponseIndex ?? -1),
      avoidImmediateRepeat: Boolean(command.avoidImmediateRepeat)
    });
    if (responseIndex < 0) return { handled: true, sent: false, reason: 'no-response' };

    const counterDoc = await YouTubeCustomCommand.findOneAndUpdate(
      { _id: command._id, channelKey, enabled: true },
      { $inc: { counter: 1 }, $set: { lastResponseIndex: responseIndex } },
      { new: true }
    ).lean();
    if (!counterDoc) {
      for (const [trigger, mapped] of commandMap.entries()) {
        if (String(mapped?._id) === String(command._id)) commandMap.delete(trigger);
      }
      return { handled: false };
    }
    command.counter = counterDoc.counter;
    command.lastResponseIndex = responseIndex;

    const rendered = renderUniversalResponse(command.responses[responseIndex], {
      displayName: author?.displayName,
      query: parsed.query,
      counter: counterDoc.counter,
      randomUser: randomChatter(liveChatId, author?.displayName)
    }).replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_CHAT_MESSAGE_LENGTH);
    if (!rendered) return { handled: true, sent: false, reason: 'empty-response' };

    const delayMs = Math.max(0, Math.min(30, Number(command.responseDelaySeconds || 0))) * 1000;
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const delivery = await sendMessage(liveChatId, rendered, { kind: 'command' });
    return { handled: true, sent: Boolean(delivery?.sent), queued: Boolean(delivery?.queued), commandId: String(command._id), trigger: parsed.trigger };
  }

  function clearChat(liveChatId) {
    const id = String(liveChatId || '');
    recentChatters.delete(id);
    globalCooldowns.delete(id);
    nativeCooldowns.delete(id);
    for (const key of [...commandCooldowns.keys()]) if (key.startsWith(`${id}:`)) commandCooldowns.delete(key);
  }

  function invalidate() { loaded = false; }

  return { handleTextMessage, noteChatter, clearChat, reload, invalidate, normalizeCommandTrigger, DEFAULT_NATIVE_RESPONSE };
}

module.exports = { createYouTubeCommandManager, DEFAULT_NATIVE_RESPONSE, MAX_CHAT_MESSAGE_LENGTH };
