export function initLoreSection({ $, postJson, maxLoreLength, maxBotPersonalityNameLength, maxBotPersonalityLength, maxBotPersonalityCooldownSeconds, botUsername, viewerProfiles }) {
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
  $('botPersonalityRetryCount').max = 2;
  $('botPersonalityFailureResponse').maxLength = 500;
  $('botPersonalitySecurityRefusalResponse').maxLength = 500;

  function selectMemoryView(view) {
    const selected = ['lore', 'personality', 'profiles'].includes(view) ? view : 'lore';
    const loreSelected = selected === 'lore';
    const personalitySelected = selected === 'personality';
    const profilesSelected = selected === 'profiles';
    $('streamLoreView').classList.toggle('open', loreSelected);
    $('botPersonalityView').classList.toggle('open', personalitySelected);
    $('viewerProfilesView').classList.toggle('open', profilesSelected);
    $('streamLoreViewTab').classList.toggle('active', loreSelected);
    $('botPersonalityViewTab').classList.toggle('active', personalitySelected);
    $('viewerProfilesViewTab').classList.toggle('active', profilesSelected);
    $('streamLoreViewTab').setAttribute('aria-selected', loreSelected ? 'true' : 'false');
    $('botPersonalityViewTab').setAttribute('aria-selected', personalitySelected ? 'true' : 'false');
    $('viewerProfilesViewTab').setAttribute('aria-selected', profilesSelected ? 'true' : 'false');
    if (viewerProfiles?.onVisibilityChange) viewerProfiles.onVisibilityChange(profilesSelected);
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

  function syncAiRetryControls() {
    $('botPersonalityRetryCount').disabled = !$('botPersonalityRetryEnabled').checked;
  }

  function setAiRetrySettings(aiRetry = {}) {
    $('botPersonalityRetryEnabled').checked = aiRetry.enabled !== false;
    $('botPersonalityRetryCount').value = aiRetry.maxRetries ?? 2;
    $('botPersonalityFailureResponse').value = aiRetry.failureResponse ?? 'Sorry $user, my AI brain is overloaded right now. Try asking me again in a moment.';
    syncAiRetryControls();
  }

  function getAiRetrySettings() {
    return {
      enabled: $('botPersonalityRetryEnabled').checked,
      maxRetries: Number($('botPersonalityRetryCount').value),
      failureResponse: $('botPersonalityFailureResponse').value.trim()
    };
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


  function renderLearnedLore(observations = []) {
    const list = Array.isArray(observations) ? observations : [];
    $('streamLoreObservationCount').textContent = `${list.length} observation${list.length === 1 ? '' : 's'}`;
    $('streamLoreObservations').innerHTML = list.length ? list.map((observation) => `
      <div class="viewer-profile-fact ${observation.enabled === true ? '' : 'disabled'}" data-observation-id="${String(observation.id || '').replace(/[&<>"']/g, '')}">
        <label class="inline-check"><input class="stream-lore-observation-toggle" type="checkbox" ${observation.enabled === true ? 'checked' : ''}> Use</label>
        <div class="viewer-profile-fact-copy">
          <div>${String(observation.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')}</div>
          <div class="detail">${String(observation.confidence || 'medium')} confidence · evidence ${Math.max(1, Number(observation.evidenceCount || 1))}x${observation.lastObservedAt ? ` · last ${new Date(observation.lastObservedAt).toLocaleDateString()}` : ''}</div>
        </div>
        <button class="danger stream-lore-observation-unlearn" type="button">Unlearn</button>
      </div>`).join('') : '<div class="detail custom-empty-state">No AI-learned stream lore observations yet.</div>';

    $('streamLoreObservations').querySelectorAll('.stream-lore-observation-toggle').forEach((toggle) => {
      toggle.onchange = async () => {
        const row = toggle.closest('.viewer-profile-fact');
        toggle.disabled = true;
        const d = await postJson('/stream-lore/observation-toggle', { observationId: row.dataset.observationId, enabled: toggle.checked });
        toggle.disabled = false;
        if (!d.success) {
          toggle.checked = !toggle.checked;
          $('streamLoreObservationsMsg').textContent = d.error || 'Could not update learned lore.';
          return;
        }
        $('streamLoreObservationsMsg').textContent = toggle.checked ? 'Observation approved.' : 'Observation kept but not used.';
        renderLearnedLore(d.learnedObservations || []);
      };
    });

    $('streamLoreObservations').querySelectorAll('.stream-lore-observation-unlearn').forEach((button) => {
      button.onclick = async () => {
        const row = button.closest('.viewer-profile-fact');
        if (!window.confirm('Unlearn this stream lore observation? This permanently deletes it.')) return;
        button.disabled = true;
        const d = await postJson('/stream-lore/observation-unlearn', { observationId: row.dataset.observationId });
        if (!d.success) {
          button.disabled = false;
          $('streamLoreObservationsMsg').textContent = d.error || 'Could not unlearn stream lore.';
          return;
        }
        $('streamLoreObservationsMsg').textContent = 'Observation unlearned.';
        renderLearnedLore(d.learnedObservations || []);
      };
    });
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
      renderLearnedLore(d.learnedObservations || []);
      $('streamLoreObservationsMsg').textContent = '';
      updateCount();
      $('loreMsg').textContent = d.updatedAt ? '' : 'No lore saved yet.';
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
      renderLearnedLore(d.learnedObservations || []);
      updateCount();
      $('loreMsg').textContent = d.text ? 'Saved.' : 'Lore cleared.';
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
      setAiRetrySettings(d.aiRetry || {});
      $('botPersonalitySecurityRefusalResponse').value = d.securityRefusalResponse || 'Cute. Chat does not get to rewrite my instructions or make me reveal them. Ask me an actual question.';
      setSessionMemorySettings(d.sessionMemory || {});
      syncCooldownResponseVisibility();
      updatePersonalityCount();
      $('botPersonalityMsg').textContent = d.updatedAt ? '' : 'No personality saved yet.';
      await loadSessionMemoryStatus();
    } catch (_) {
      $('botPersonalityMsg').textContent = 'Could not load personality settings.';
    }
  }

  async function saveBotPersonality() {
    const cooldownSeconds = Number($('botPersonalityCooldown').value);
    if (!Number.isFinite(cooldownSeconds) || cooldownSeconds < 5) {
      $('botPersonalityMsg').textContent = 'Cooldown must be at least 5 seconds.';
      $('botPersonalityCooldown').focus();
      return;
    }
    const retryCount = Number($('botPersonalityRetryCount').value);
    if (!Number.isFinite(retryCount) || retryCount < 0 || retryCount > 2 || !Number.isInteger(retryCount)) {
      $('botPersonalityMsg').textContent = 'AI retry count must be a whole number from 0 to 2.';
      $('botPersonalityRetryCount').focus();
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
        aiRetry: getAiRetrySettings(),
        securityRefusalResponse: $('botPersonalitySecurityRefusalResponse').value.trim(),
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
      setAiRetrySettings(d.aiRetry || {});
      $('botPersonalitySecurityRefusalResponse').value = d.securityRefusalResponse || 'Cute. Chat does not get to rewrite my instructions or make me reveal them. Ask me an actual question.';
      setSessionMemorySettings(d.sessionMemory || {});
      syncCooldownResponseVisibility();
      updatePersonalityCount();
      const audienceText = d.audience === 'everyone' ? 'Everyone can ask.' : 'Only Mods/Broadcaster can ask.';
      const cooldownText = ` Cooldown: ${d.cooldownSeconds}s${d.modsBypassCooldown ? ' (Mods/Broadcaster bypass).' : '.'}`;
      const retryText = d.aiRetry?.enabled === false ? ' AI retries: disabled.' : ` AI retries: ${d.aiRetry?.maxRetries ?? 2}.`;
      const memoryText = d.sessionMemory?.enabled === false ? ' Session Memory: disabled.' : ' Session Memory: enabled.';
      $('botPersonalityMsg').textContent = d.personality
        ? `Saved. ${audienceText}${cooldownText}${retryText}${memoryText}`
        : `Personality cleared; tagged AI answers are disabled. ${audienceText}${cooldownText}${retryText}${memoryText}`;
      await loadSessionMemoryStatus();
    } catch (_) {
      $('botPersonalityMsg').textContent = 'Could not save personality settings.';
    } finally {
      $('saveBotPersonalityBtn').disabled = false;
    }
  }

  $('streamLoreViewTab').onclick = () => selectMemoryView('lore');
  $('botPersonalityViewTab').onclick = () => selectMemoryView('personality');
  $('viewerProfilesViewTab').onclick = () => selectMemoryView('profiles');
  $('streamLore').oninput = updateCount;
  $('saveLoreBtn').onclick = saveLore;
  $('undoLoreBtn').onclick = loadLore;
  $('botPersonality').oninput = updatePersonalityCount;
  $('botPersonalityUseCooldownResponse').onchange = syncCooldownResponseVisibility;
  $('botPersonalityRetryEnabled').onchange = syncAiRetryControls;
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
  syncAiRetryControls();
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
