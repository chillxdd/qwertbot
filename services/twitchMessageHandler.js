const { setViewerProfileOptOut } = require('./viewerProfiles');

const KNOWN_BOT_COMMANDS = new Set(['!recap', '!stoprecap', '!startrecap', '!optout', '!optin']);
const POKEMON_COMMUNITY_GAME_USERNAMES = new Set(['pokemoncommunitygame']);
const NIGHTBOT_RESPONSE_WINDOW = 5000;

function getCommandName(message) {
  return String(message || '').trim().split(/\s+/)[0].toLowerCase();
}

function isKnownBotCommand(message) {
  return KNOWN_BOT_COMMANDS.has(getCommandName(message));
}

function isPokemonCommunityGameCommand(message) {
  return getCommandName(message).startsWith('!poke');
}

function isModOrBroadcaster(tags = {}) {
  const badges = tags.badges || {};
  return badges.broadcaster === '1' || tags.mod === true || badges.moderator === '1';
}

function createTwitchMessageHandler({ getRecapManager, getCustomCommandManager, getChatTimerManager, getBotPersonalityManager, sendMessage, botUsername, summaryPrefix }) {
  let pendingBangMessageId = 0;
  const pendingBangMessages = [];

  function isBotHourlyRecap(username, message) {
    const normalizedUsername = String(username || '').toLowerCase().trim();
    const normalizedMessage = String(message || '').trim().toLowerCase();
    return Boolean(
      botUsername &&
      normalizedUsername === botUsername &&
      normalizedMessage.startsWith(String(summaryPrefix || '').toLowerCase())
    );
  }

  function removePendingBangMessage(id) {
    const index = pendingBangMessages.findIndex((item) => item.id === id);
    if (index !== -1) pendingBangMessages.splice(index, 1);
  }

  function recordPending(candidate) {
    const recapManager = getRecapManager();
    if (!recapManager) return;
    recapManager.recordChatMessage({
      displayName: candidate.displayName,
      rawMessage: candidate.rawMessage
    });
  }

  function queuePotentialFakeCommand({ username, displayName, rawMessage }) {
    pendingBangMessageId++;
    const pending = {
      id: pendingBangMessageId,
      username: String(username || '').toLowerCase().trim(),
      displayName,
      rawMessage,
      createdAt: Date.now(),
      timer: null
    };

    pending.timer = setTimeout(() => {
      removePendingBangMessage(pending.id);
      recordPending(pending);
    }, NIGHTBOT_RESPONSE_WINDOW);

    pendingBangMessages.push(pending);
  }

  function handleNightbotResponse(nightbotMessage) {
    const now = Date.now();

    for (let i = pendingBangMessages.length - 1; i >= 0; i--) {
      const candidate = pendingBangMessages[i];
      if (now - candidate.createdAt > NIGHTBOT_RESPONSE_WINDOW) {
        clearTimeout(candidate.timer);
        pendingBangMessages.splice(i, 1);
        recordPending(candidate);
      }
    }

    if (pendingBangMessages.length === 0) return;

    const lowerNightbotMessage = String(nightbotMessage || '').toLowerCase();
    let candidateIndex = -1;

    for (let i = pendingBangMessages.length - 1; i >= 0; i--) {
      const candidate = pendingBangMessages[i];
      if (candidate.username && lowerNightbotMessage.includes(`@${candidate.username}`)) {
        candidateIndex = i;
        break;
      }
    }

    if (candidateIndex === -1) candidateIndex = pendingBangMessages.length - 1;
    const candidate = pendingBangMessages[candidateIndex];
    clearTimeout(candidate.timer);
    pendingBangMessages.splice(candidateIndex, 1);
    console.log(`[Recap] Nightbot responded to ${candidate.rawMessage}; command excluded from recap logs.`);
  }

  async function handleMessage(channel, tags = {}, message) {
    const recapManager = getRecapManager();
    if (!recapManager) return;

    const rawMessage = String(message || '').trim();
    const lowerMsg = rawMessage.toLowerCase();
    const username = String(tags.username || '').toLowerCase().trim();
    const displayName = tags['display-name'] || tags.username || 'viewer';

    if (username === 'nightbot') {
      handleNightbotResponse(rawMessage);
      return;
    }

    if (username === 'streamelements') return;
    if (POKEMON_COMMUNITY_GAME_USERNAMES.has(username)) return;
    if (isPokemonCommunityGameCommand(rawMessage)) return;
    if (isBotHourlyRecap(username, rawMessage)) return;

    const customCommandManager = typeof getCustomCommandManager === 'function' ? getCustomCommandManager() : null;
    const chatTimerManager = typeof getChatTimerManager === 'function' ? getChatTimerManager() : null;
    const botPersonalityManager = typeof getBotPersonalityManager === 'function' ? getBotPersonalityManager() : null;

    if (username === botUsername) {
      if (customCommandManager?.consumeOwnResponse(rawMessage)) return;
      if (chatTimerManager?.consumeOwnResponse(rawMessage)) return;
      if (botPersonalityManager?.consumeOwnResponse(rawMessage)) return;
      recapManager.recordChatMessage({ displayName, rawMessage });
      return;
    }

    // Count real viewer chat once for timer activity gates. Bot/system messages were filtered above.
    chatTimerManager?.recordViewerActivity?.();

    if (botPersonalityManager) {
      try {
        const personalityResult = await botPersonalityManager.handleTaggedQuestion({ rawMessage, displayName, tags });
        if (personalityResult?.matched) {
          // A tagged AI question is still organic viewer chat, even when the
          // current audience setting prevents the bot from answering it.
          recapManager.recordChatMessage({ displayName, rawMessage });
          return;
        }
      } catch (err) {
        console.error(`[Tagged Questions] Failed while answering tagged question from ${displayName}:`, err?.message || err);
        recapManager.recordChatMessage({ displayName, rawMessage });
        return;
      }
    }

    if (isKnownBotCommand(rawMessage)) {
      if (lowerMsg === '!optout' || lowerMsg === '!optin') {
        const optingOut = lowerMsg === '!optout';
        try {
          await setViewerProfileOptOut(channel, {
            username,
            displayName,
            twitchUserId: tags['user-id'] || '',
            optedOut: optingOut
          });
          if (typeof sendMessage === 'function') {
            const text = optingOut
              ? `@${displayName}, you've opted out of Viewer Profiles. I won't learn from or use your profile in AI responses.`
              : `@${displayName}, you've opted back into Viewer Profiles. Automatic learning and profile use are available again.`;
            await sendMessage(channel, text);
          }
        } catch (err) {
          console.error(`[Viewer Profiles] Failed to process ${lowerMsg} for ${displayName}:`, err?.message || err);
          if (typeof sendMessage === 'function') {
            await sendMessage(channel, `@${displayName}, I couldn't update your Viewer Profile preference right now. Please try again later.`);
          }
        }
        return;
      }

      if (lowerMsg === '!stoprecap') {
        if (!isModOrBroadcaster(tags)) return;
        await recapManager.stopRecap({ channel, displayName });
        return;
      }

      if (lowerMsg === '!startrecap') {
        if (!isModOrBroadcaster(tags)) return;
        await recapManager.startRecap({ channel, displayName });
        return;
      }

      if (lowerMsg === '!recap' || lowerMsg.startsWith('!recap ')) {
        await recapManager.handleRecapCommand({ channel, displayName });
      }
      return;
    }

    if (customCommandManager) {
      try {
        const customResult = await customCommandManager.handleMessage({ rawMessage, displayName, tags });
        if (customResult?.matched) {
          // Explicit !commands are operational noise and stay out of recap logs.
          // Inline triggers are still normal viewer chat, so preserve the source message.
          if (customResult.triggerType === 'inline') {
            recapManager.recordChatMessage({ displayName, rawMessage });
          }
          return;
        }
      } catch (err) {
        console.error(`[Custom Commands] Failed while handling ${rawMessage}:`, err?.message || err);
        // If a known custom command failed to send, avoid feeding the command text to Gemini.
        if (rawMessage.startsWith('!')) return;
      }
    }

    if (rawMessage.startsWith('!')) {
      queuePotentialFakeCommand({ username, displayName, rawMessage });
      return;
    }

    recapManager.recordChatMessage({ displayName, rawMessage });
  }

  return { handleMessage };
}

module.exports = {
  createTwitchMessageHandler,
  isPokemonCommunityGameCommand
};
