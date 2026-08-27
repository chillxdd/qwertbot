const { setViewerProfileOptOut, syncViewerIdentity, recordViewerCommandUsage } = require('./viewerProfiles');

const KNOWN_BOT_COMMANDS = new Set(['!recap', '!stoprecap', '!startrecap', '!optout', '!optin']);
const POKEMON_COMMUNITY_GAME_USERNAMES = new Set(['pokemoncommunitygame']);
const NIGHTBOT_RESPONSE_WINDOW = 5000;
const PROFILE_COMMAND_EXCLUSIONS = new Set(['!commands', '!optout', '!optin', '!startrecap', '!stoprecap']);

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

function extractReplyContext(tags = {}) {
  const parentMessageId = String(tags['reply-parent-msg-id'] || '').trim();
  const parentBody = String(tags['reply-parent-msg-body'] || '').trim();
  const parentDisplayName = String(
    tags['reply-parent-display-name'] || tags['reply-parent-user-login'] || ''
  ).trim();
  const parentUserLogin = String(tags['reply-parent-user-login'] || '').trim();
  const parentUserId = String(tags['reply-parent-user-id'] || '').trim();

  if (!parentMessageId && !parentBody && !parentDisplayName && !parentUserLogin) return null;

  return {
    parentMessageId,
    parentBody,
    parentDisplayName,
    parentUserLogin,
    parentUserId
  };
}

function createTwitchMessageHandler({ getRecapManager, getCustomCommandManager, getChatTimerManager, getBotPersonalityManager, getNativeCommandResponse = null, sendMessage, botUsername, summaryPrefix }) {
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


  function recordCommandBehavior({ channel, username, displayName, tags = {}, rawMessage, streamLive = false, recognized = true }) {
    const command = getCommandName(rawMessage);
    if (!command.startsWith('!') || PROFILE_COMMAND_EXCLUSIONS.has(command) || command.startsWith('!poke')) return;
    void recordViewerCommandUsage(channel, {
      username,
      displayName,
      twitchUserId: tags['user-id'] || '',
      command,
      streamLive,
      recognized
    }).catch((err) => {
      console.error(`[Viewer Profiles] Could not record command usage ${command} for ${displayName}:`, err?.message || err);
    });
  }

  function queuePotentialFakeCommand({ channel, username, displayName, tags, rawMessage, streamLive }) {
    pendingBangMessageId++;
    const pending = {
      id: pendingBangMessageId,
      username: String(username || '').toLowerCase().trim(),
      displayName,
      rawMessage,
      channel,
      tags,
      streamLive,
      createdAt: Date.now(),
      timer: null
    };

    pending.timer = setTimeout(() => {
      removePendingBangMessage(pending.id);
      // Nobody handled this bang command inside the response window, so count
      // it as an unrecognized/fake command behavior before preserving it as chat.
      recordCommandBehavior({ ...pending, recognized: false });
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
        recordCommandBehavior({ ...candidate, recognized: false });
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
    recordCommandBehavior(candidate);
    console.log(`[Recap] Nightbot responded to ${candidate.rawMessage}; command excluded from recap logs.`);
  }

  async function handleMessage(channel, tags = {}, message) {
    const recapManager = getRecapManager();
    if (!recapManager) return;

    const streamLive = Boolean(recapManager.getStatus?.().streamLive);
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

    // Twitch user ID is the stable viewer identity. Keep an existing Viewer Profile
    // synchronized with the mutable login/display name before any Tagged Question or
    // learning path can use it. The service caches stable identities, so this does not
    // become a Mongo query on every message once a viewer is synchronized.
    try {
      await syncViewerIdentity(channel, {
        username,
        displayName,
        twitchUserId: tags['user-id'] || ''
      });
    } catch (err) {
      console.error(`[Viewer Profiles] Could not synchronize Twitch identity for ${displayName}:`, err?.message || err);
    }

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
        const personalityResult = await botPersonalityManager.handleTaggedQuestion({
          rawMessage,
          displayName,
          tags,
          // Reply to the viewer's current message, while separately passing the
          // Twitch reply-parent metadata as conversational context for AskAI.
          replyParentMessageId: tags.id || tags['message-id'] || '',
          replyContext: extractReplyContext(tags)
        });
        if (personalityResult?.matched) {
          // Tagged questions are normally organic viewer chat and remain part of
          // recap/session-memory source. Explicit prompt-injection attempts are
          // intentionally excluded so malicious instruction text cannot poison
          // later AI context after the direct attack has already been blocked.
          if (personalityResult?.reason !== 'prompt_injection_blocked') {
            recapManager.recordChatMessage({ displayName, rawMessage });
          }
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
          const result = await setViewerProfileOptOut(channel, {
            username,
            displayName,
            twitchUserId: tags['user-id'] || '',
            optedOut: optingOut
          });
          if (typeof sendMessage === 'function') {
            const command = optingOut ? 'optout' : 'optin';
            const variant = optingOut ? 'success' : (result?.reactivated ? 'reactivated' : 'fresh');
            const text = typeof getNativeCommandResponse === 'function'
              ? await getNativeCommandResponse(command, variant, { user: displayName, retentionDays: 30 })
              : (optingOut
                ? `@${displayName}, you've opted out of Viewer Profiles. Learning and profile use stop immediately. Your existing profile will be deleted after 30 days unless you opt back in.`
                : result?.reactivated
                  ? `@${displayName}, you've opted back into Viewer Profiles. Your existing profile has been reactivated.`
                  : `@${displayName}, you've opted back into Viewer Profiles. A new profile can now be learned over time.`);
            await sendMessage(channel, text);
          }
        } catch (err) {
          console.error(`[Viewer Profiles] Failed to process ${lowerMsg} for ${displayName}:`, err?.message || err);
          if (typeof sendMessage === 'function') {
            const command = optingOut ? 'optout' : 'optin';
            const text = typeof getNativeCommandResponse === 'function'
              ? await getNativeCommandResponse(command, 'error', { user: displayName, retentionDays: 30 })
              : `@${displayName}, I couldn't update your Viewer Profile preference right now. Please try again later.`;
            await sendMessage(channel, text);
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
        recordCommandBehavior({ channel, username, displayName, tags, rawMessage, streamLive });
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
          } else if (customResult.triggerType === 'command') {
            recordCommandBehavior({ channel, username, displayName, tags, rawMessage, streamLive });
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
      queuePotentialFakeCommand({ channel, username, displayName, tags, rawMessage, streamLive });
      return;
    }

    recapManager.recordChatMessage({ displayName, rawMessage });
  }

  return { handleMessage };
}

module.exports = {
  createTwitchMessageHandler,
  isPokemonCommunityGameCommand,
  extractReplyContext
};
