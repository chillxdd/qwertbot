export function initLoreSection({ $, postJson, getPassword, maxLoreLength }) {
  const maxLength = Number(maxLoreLength) || 12000;
  $('streamLore').maxLength = maxLength;

  function updateCount() {
    $('loreCount').textContent = `${$('streamLore').value.length}/${maxLength} characters`;
  }

  async function loadLore() {
    try {
      $('loreMsg').textContent = 'Loading...';
      const d = await postJson('/stream-lore/get', { password: getPassword() });
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
      const d = await postJson('/stream-lore/save', { password: getPassword(), text: $('streamLore').value });
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

  $('streamLore').oninput = updateCount;
  $('saveLoreBtn').onclick = saveLore;
  $('undoLoreBtn').onclick = loadLore;
  updateCount();
  return { loadLore };
}
