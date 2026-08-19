export function initLoreSection({ $, postJson, maxLoreLength, maxBotPersonalityLength }) {
  const maxLength = Number(maxLoreLength) || 12000;
  const personalityMaxLength = Number(maxBotPersonalityLength) || 12000;
  $('streamLore').maxLength = maxLength;
  $('botPersonality').maxLength = personalityMaxLength;

  function updateCount() {
    $('loreCount').textContent = `${$('streamLore').value.length}/${maxLength} characters`;
  }

  function updatePersonalityCount() {
    $('botPersonalityCount').textContent = `${$('botPersonality').value.length}/${personalityMaxLength} characters`;
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
      $('botPersonality').value = d.personality || '';
      $('botPersonalityEveryone').checked = d.audience === 'everyone';
      updatePersonalityCount();
      $('botPersonalityMsg').textContent = d.updatedAt ? 'Saved personality settings loaded.' : 'No personality saved yet.';
    } catch (_) {
      $('botPersonalityMsg').textContent = 'Could not load personality settings.';
    }
  }

  async function saveBotPersonality() {
    try {
      $('saveBotPersonalityBtn').disabled = true;
      $('botPersonalityMsg').textContent = 'Saving...';
      const d = await postJson('/bot-personality/save', {
        personality: $('botPersonality').value,
        audience: $('botPersonalityEveryone').checked ? 'everyone' : 'mods'
      });
      if (!d.success) {
        $('botPersonalityMsg').textContent = d.error || 'Could not save personality settings.';
        return;
      }
      $('botPersonality').value = d.personality || '';
      $('botPersonalityEveryone').checked = d.audience === 'everyone';
      updatePersonalityCount();
      const audienceText = d.audience === 'everyone' ? 'Everyone can ask.' : 'Only Mods/Broadcaster can ask.';
      $('botPersonalityMsg').textContent = d.personality
        ? `Saved to MongoDB and live immediately. ${audienceText}`
        : `Personality cleared; tagged AI answers are disabled. ${audienceText}`;
    } catch (_) {
      $('botPersonalityMsg').textContent = 'Could not save personality settings.';
    } finally {
      $('saveBotPersonalityBtn').disabled = false;
    }
  }

  $('streamLore').oninput = updateCount;
  $('saveLoreBtn').onclick = saveLore;
  $('undoLoreBtn').onclick = loadLore;
  $('botPersonality').oninput = updatePersonalityCount;
  $('saveBotPersonalityBtn').onclick = saveBotPersonality;
  $('undoBotPersonalityBtn').onclick = loadBotPersonality;
  updateCount();
  updatePersonalityCount();
  return {
    loadLore,
    loadBotPersonality,
    async loadMemory() {
      await Promise.all([loadLore(), loadBotPersonality()]);
    }
  };
}
