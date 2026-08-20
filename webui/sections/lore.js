export function initLoreSection({ $, postJson, maxLoreLength, maxBotPersonalityNameLength, maxBotPersonalityLength, maxBotPersonalityCooldownSeconds, botUsername }) {
  const maxLength = Number(maxLoreLength) || 12000;
  const personalityNameMaxLength = Number(maxBotPersonalityNameLength) || 80;
  const personalityMaxLength = Number(maxBotPersonalityLength) || 12000;
  const sessionMemoryPromptMaxLength = 6000;
  $('streamLore').maxLength = maxLength;
  $('botPersonalityName').maxLength = personalityNameMaxLength;
  $('botPersonality').maxLength = personalityMaxLength;
  $('sessionMemoryPromptInstructions').maxLength = sessionMemoryPromptMaxLength;
  const taggedMention = String(botUsername || '').replace(/^@+/, '').trim();
  if ($('botTaggedQuestionMention')) $('botTaggedQuestionMention').textContent = taggedMention ? `@${taggedMention}` : '@<bot_username>';

  $('botPersonalityCooldown').min = 5;
  $('botPersonalityCooldown').max = Number(maxBotPersonalityCooldownSeconds) || 86400;
  $('botPersonalityCooldownResponse').maxLength = 500;

  function selectMemoryView(view) {
    const loreSelected = view !== 'personality';
    $('streamLoreView').classList.toggle('open', loreSelected);
    $('botPersonalityView').classList.toggle('open', !loreSelected);
    $('streamLoreViewTab').classList.toggle('active', loreSelected);
    $('botPersonalityViewTab').classList.toggle('active', !loreSelected);
    $('streamLoreViewTab').setAttribute('aria-selected', loreSelected ? 'true' : 'false');
    $('botPersonalityViewTab').setAttribute('aria-selected', loreSelected ? 'false' : 'true');
  }

  function updateCount() {
    $('loreCount').textContent = `${$('streamLore').value.length}/${maxLength} characters`;
  }

  function updatePersonalityCount() {
    $('botPersonalityCount').textContent = `${$('botPersonality').value.length}/${personalityMaxLength} characters`;
  }

  function updateSessionMemoryPromptCount() {
    $('sessionMemoryPromptCount').textContent = `${$('sessionMemoryPromptInstructions').value.length}/${sessionMemoryPromptMaxLength} characters`;
  }

  function syncCooldownResponseVisibility() {
    $('botPersonalityCooldownResponsePanel').hidden = !$('botPersonalityUseCooldownResponse').checked;
  }

  function setSessionMemorySettings(memory = {}) {
    $('sessionMemoryEnabled').checked = memory.enabled !== false;
    $('sessionMemoryRecentHours').value = memory.recentDetailedHours ?? 2;
    $('sessionMemoryMaxContext').value = memory.maxContextCharacters ?? 18000;
    $('sessionMemoryRecentChat').value = memory.recentChatMessages ?? 30;
    $('sessionMemoryRelevantOlder').value = memory.relevantOlderBlocks ?? 2;
    $('sessionMemoryPromptInstructions').value = memory.promptInstructions || '';
    updateSessionMemoryPromptCount();
  }

  function getSessionMemorySettings() {
    return {
      enabled: $('sessionMemoryEnabled').checked,
      recentDetailedHours: Number($('sessionMemoryRecentHours').value),
      maxContextCharacters: Number($('sessionMemoryMaxContext').value),
      recentChatMessages: Number($('sessionMemoryRecentChat').value),
      relevantOlderBlocks: Number($('sessionMemoryRelevantOlder').value),
      promptInstructions: $('sessionMemoryPromptInstructions').value
    };
  }

  function toggleSessionMemoryAdvanced(forceOpen = null) {
    const body = $('sessionMemorySettingsBody');
    const button = $('sessionMemorySettingsToggle');
    const open = forceOpen === null ? !body.classList.contains('open') : Boolean(forceOpen);
    body.classList.toggle('open', open);
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    button.textContent = open ? 'Hide Advanced Session Memory Settings' : 'Show Advanced Session Memory Settings';
  }

  async function loadLore() {
    try {
      $('loreMsg').textContent = 'Loading...';
      const d = await postJson('/stream-lore/get', {});
      if (!d.success) {
        $('loreMsg').textContent = d.error || 'Could not load lore.';
        return;
      }
      $('streamLore').value = d.text || '';
      updateCount();
      $('loreMsg').textContent = d.updatedAt ? 'Saved lore loaded.' : 'No lore saved yet.';
    } catch (_) {
      $('loreMsg').textContent = 'Could not load lore.';
    }
  }

  async function saveLore() {
    try {
      $('saveLoreBtn').disabled = true;
      $('loreMsg').textContent = 'Saving...';
      const d = await postJson('/stream-lore/save', { text: $('streamLore').value });
      if (!d.success) {
        $('loreMsg').textContent = d.error || 'Could not save lore.';
        return;
      }
      $('streamLore').value = d.text || '';
      updateCount();
      $('loreMsg').textContent = d.text ? 'Saved to MongoDB.' : 'Lore cleared from MongoDB.';
    } catch (_) {
      $('loreMsg').textContent = 'Could not save lore.';
    } finally {
      $('saveLoreBtn').disabled = false;
    }
  }

  async function loadSessionMemoryStatus() {
    try {
      $('sessionMemoryStatus').textContent = 'Loading session memory status...';
      const d = await postJson('/session-memory/status', {});
      if (!d.success) {
        $('sessionMemoryStatus').textContent = d.error || 'Could not load session memory status.';
        return;
      }
      if (!d.streamLive) {
        $('sessionMemoryStatus').textContent = d.enabled === false
          ? 'Session Memory is disabled. No active stream memory is in use.'
          : 'Qwert is offline. Session Memory will start fresh with the next stream.';
        return;
      }
      const latest = d.latestBlockAt ? new Date(d.latestBlockAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'none yet';
      $('sessionMemoryStatus').textContent = `Active: ${d.blockCount || 0} completed block(s), ${(d.detailedCharacters || 0).toLocaleString()} detailed chars, ${(d.compactCharacters || 0).toLocaleString()} compact chars, ${d.currentWindowMessages || 0} current-window messages. Latest block: ${latest}.`;
    } catch (_) {
      $('sessionMemoryStatus').textContent = 'Could not load session memory status.';
    }
  }

  async function clearSessionMemory() {
    const confirmed = window.confirm('Clear all temporary Session Memory for the current live stream? This does not change Stream Lore, public recap history, or OAuth settings.');
    if (!confirmed) return;
    try {
      $('clearSessionMemoryBtn').disabled = true;
      $('sessionMemoryActionMsg').textContent = 'Clearing current session memory...';
      const d = await postJson('/session-memory/clear', {});
      $('sessionMemoryActionMsg').textContent = d.success ? (d.message || 'Current session memory cleared.') : (d.error || d.message || 'Could not clear session memory.');
      await loadSessionMemoryStatus();
    } catch (_) {
      $('sessionMemoryActionMsg').textContent = 'Could not clear current session memory.';
    } finally {
      $('clearSessionMemoryBtn').disabled = false;
    }
  }

  async function loadBotPersonality() {
    try {
      $('botPersonalityMsg').textContent = 'Loading...';
      const d = await postJson('/bot-personality/get', {});
      if (!d.success) {
        $('botPersonalityMsg').textContent = d.error || 'Could not load personality settings.';
        return;
      }
      $('botPersonalityName').value = d.name || '';
      $('botPersonality').value = d.personality || '';
      $('botPersonalityModsOnly').checked = d.audience === 'mods';
      $('botPersonalityModsBypassCooldown').checked = d.modsBypassCooldown !== false;
      $('botPersonalityCooldown').value = d.cooldownSeconds ?? 5;
      $('botPersonalityCooldownResponse').value = d.cooldownResponse || '';
      $('botPersonalityUseCooldownResponse').checked = Boolean(d.cooldownResponse);
      setSessionMemorySettings(d.sessionMemory || {});
      syncCooldownResponseVisibility();
      updatePersonalityCount();
      $('botPersonalityMsg').textContent = d.updatedAt ? 'Saved personality settings loaded.' : 'No personality saved yet.';
      await loadSessionMemoryStatus();
    } catch (_) {
      $('botPersonalityMsg').textContent = 'Could not load personality settings.';
    }
  }

  async function saveBotPersonality() {
    const cooldownSeconds = Number($('botPersonalityCooldown').value);
    if (!Number.isFinite(cooldownSeconds) || cooldownSeconds < 5) {
      $('botPersonalityMsg').textContent = 'Tagged-question cooldown must be at least 5 seconds.';
      $('botPersonalityCooldown').focus();
      return;
    }
    try {
      $('saveBotPersonalityBtn').disabled = true;
      $('botPersonalityMsg').textContent = 'Saving...';
      const d = await postJson('/bot-personality/save', {
        name: $('botPersonalityName').value,
        personality: $('botPersonality').value,
        audience: $('botPersonalityModsOnly').checked ? 'mods' : 'everyone',
        cooldownSeconds,
        modsBypassCooldown: $('botPersonalityModsBypassCooldown').checked,
        cooldownResponse: $('botPersonalityUseCooldownResponse').checked ? $('botPersonalityCooldownResponse').value.trim() : '',
        sessionMemory: getSessionMemorySettings()
      });
      if (!d.success) {
        $('botPersonalityMsg').textContent = d.error || 'Could not save personality settings.';
        return;
      }
      $('botPersonalityName').value = d.name || '';
      $('botPersonality').value = d.personality || '';
      $('botPersonalityModsOnly').checked = d.audience === 'mods';
      $('botPersonalityModsBypassCooldown').checked = d.modsBypassCooldown !== false;
      $('botPersonalityCooldown').value = d.cooldownSeconds ?? 5;
      $('botPersonalityCooldownResponse').value = d.cooldownResponse || '';
      $('botPersonalityUseCooldownResponse').checked = Boolean(d.cooldownResponse);
      setSessionMemorySettings(d.sessionMemory || {});
      syncCooldownResponseVisibility();
      updatePersonalityCount();
      const audienceText = d.audience === 'everyone' ? 'Everyone can ask.' : 'Only Mods/Broadcaster can ask.';
      const cooldownText = ` Cooldown: ${d.cooldownSeconds}s${d.modsBypassCooldown ? ' (Mods/Broadcaster bypass).' : '.'}`;
      const memoryText = d.sessionMemory?.enabled === false ? ' Session Memory: disabled.' : ' Session Memory: enabled.';
      $('botPersonalityMsg').textContent = d.personality
        ? `Saved to MongoDB and live immediately. ${audienceText}${cooldownText}${memoryText}`
        : `Personality cleared; tagged AI answers are disabled. ${audienceText}${cooldownText}${memoryText}`;
      await loadSessionMemoryStatus();
    } catch (_) {
      $('botPersonalityMsg').textContent = 'Could not save personality settings.';
    } finally {
      $('saveBotPersonalityBtn').disabled = false;
    }
  }

  $('streamLoreViewTab').onclick = () => selectMemoryView('lore');
  $('botPersonalityViewTab').onclick = () => selectMemoryView('personality');
  $('streamLore').oninput = updateCount;
  $('saveLoreBtn').onclick = saveLore;
  $('undoLoreBtn').onclick = loadLore;
  $('botPersonality').oninput = updatePersonalityCount;
  $('botPersonalityUseCooldownResponse').onchange = syncCooldownResponseVisibility;
  $('sessionMemoryPromptInstructions').oninput = updateSessionMemoryPromptCount;
  $('sessionMemorySettingsToggle').onclick = () => toggleSessionMemoryAdvanced();
  $('refreshSessionMemoryBtn').onclick = loadSessionMemoryStatus;
  $('clearSessionMemoryBtn').onclick = clearSessionMemory;
  $('saveBotPersonalityBtn').onclick = saveBotPersonality;
  $('undoBotPersonalityBtn').onclick = loadBotPersonality;
  updateCount();
  updatePersonalityCount();
  updateSessionMemoryPromptCount();
  syncCooldownResponseVisibility();
  toggleSessionMemoryAdvanced(false);
  selectMemoryView('lore');
  return {
    loadLore,
    loadBotPersonality,
    loadSessionMemoryStatus,
    selectMemoryView,
    async loadMemory() {
      await Promise.all([loadLore(), loadBotPersonality()]);
    }
  };
}
