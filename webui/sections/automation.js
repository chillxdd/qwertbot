export function initAutomationSection({ $, postJson }) {
  let loaded = false;
  let maxSpacingSeconds = 3600;

  function setMessage(message = '', isError = false) {
    const el = $('automationSpacingMsg');
    el.textContent = message;
    el.classList.toggle('bad-text', Boolean(isError));
  }

  async function loadSettings() {
    try {
      const d = await postJson('/automation/settings', {});
      if (!d.success) throw new Error(d.error || 'Could not load automation settings.');
      maxSpacingSeconds = Number(d.limits?.maxSpacingSeconds || 3600);
      $('automationSpacingSeconds').max = String(maxSpacingSeconds);
      $('automationSpacingSeconds').value = String(Number(d.settings?.minimumSpacingSeconds ?? 30));
      loaded = true;
      setMessage('');
    } catch (err) {
      setMessage(err.message || 'Could not load automation settings.', true);
    }
  }

  async function saveSettings() {
    const minimumSpacingSeconds = Number($('automationSpacingSeconds').value);
    if (!Number.isInteger(minimumSpacingSeconds) || minimumSpacingSeconds < 0 || minimumSpacingSeconds > maxSpacingSeconds) {
      return setMessage(`Spacing must be a whole number between 0 and ${maxSpacingSeconds} seconds.`, true);
    }
    $('saveAutomationSpacingBtn').disabled = true;
    try {
      const d = await postJson('/automation/settings/save', { minimumSpacingSeconds });
      if (!d.success) throw new Error(d.error || 'Could not save automation settings.');
      $('automationSpacingSeconds').value = String(Number(d.settings?.minimumSpacingSeconds ?? minimumSpacingSeconds));
      setMessage('Automation spacing saved.');
    } catch (err) {
      setMessage(err.message || 'Could not save automation settings.', true);
    } finally {
      $('saveAutomationSpacingBtn').disabled = false;
    }
  }

  $('saveAutomationSpacingBtn').onclick = saveSettings;
  return { loadSettings: () => loaded ? Promise.resolve() : loadSettings(), refresh: loadSettings };
}
