export function initLoreSection({ $, postJson, maxLoreLength, maxBotPersonalityNameLength, maxBotPersonalityLength, maxBotPersonalityCooldownSeconds, botUsername }) {
  const maxLength = Number(maxLoreLength) || 12000;
  const personalityNameMaxLength = Number(maxBotPersonalityNameLength) || 80;
  const personalityMaxLength = Number(maxBotPersonalityLength) || 12000;
  $('streamLore').maxLength = maxLength;
  $('botPersonalityName').maxLength = personalityNameMaxLength;
  $('botPersonality').maxLength = personalityMaxLength;
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

  function syncCooldownResponseVisibility() {
    $('botPersonalityCooldownResponsePanel').hidden = !$('botPersonalityUseCooldownResponse').checked;
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
      syncCooldownResponseVisibility();
      updatePersonalityCount();
      $('botPersonalityMsg').textContent = d.updatedAt ? 'Saved personality settings loaded.' : 'No personality saved yet.';
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
        cooldownResponse: $('botPersonalityUseCooldownResponse').checked ? $('botPersonalityCooldownResponse').value.trim() : ''
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
      syncCooldownResponseVisibility();
      updatePersonalityCount();
      const audienceText = d.audience === 'everyone' ? 'Everyone can ask.' : 'Only Mods/Broadcaster can ask.';
      const cooldownText = ` Cooldown: ${d.cooldownSeconds}s${d.modsBypassCooldown ? ' (Mods/Broadcaster bypass).' : '.'}`;
      $('botPersonalityMsg').textContent = d.personality
        ? `Saved to MongoDB and live immediately. ${audienceText}${cooldownText}`
        : `Personality cleared; tagged AI answers are disabled. ${audienceText}${cooldownText}`;
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
  $('saveBotPersonalityBtn').onclick = saveBotPersonality;
  $('undoBotPersonalityBtn').onclick = loadBotPersonality;
  updateCount();
  updatePersonalityCount();
  syncCooldownResponseVisibility();
  selectMemoryView('lore');
  return {
    loadLore,
    loadBotPersonality,
    selectMemoryView,
    async loadMemory() {
      await Promise.all([loadLore(), loadBotPersonality()]);
    }
  };
}
