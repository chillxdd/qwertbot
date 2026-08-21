export function initMessagingSection({ $, postJson }) {
  let lastSavedPrimary = '';
  let lastSavedExpansion = '';
  let maxPrimaryLength = 20000;
  let maxExpansionLength = 12000;


  function setPromptSettingsOpen(open) {
    const body = $('promptSettingsBody');
    const toggle = $('promptSettingsToggle');
    body.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.textContent = open ? 'Hide Advanced Prompt Settings' : 'Show Advanced Prompt Settings';
  }

  function updatePromptCounts() {
    $('primaryPromptCount').textContent = `${$('primaryRecapInstructions').value.length}/${maxPrimaryLength} characters`;
    $('expansionPromptCount').textContent = `${$('expansionRecapInstructions').value.length}/${maxExpansionLength} characters`;
  }

  function applyPromptConfig(d) {
    maxPrimaryLength = Number(d.maxPrimaryLength) || 20000;
    maxExpansionLength = Number(d.maxExpansionLength) || 12000;
    $('primaryRecapInstructions').maxLength = maxPrimaryLength;
    $('expansionRecapInstructions').maxLength = maxExpansionLength;
    lastSavedPrimary = String(d.primaryInstructions || '');
    lastSavedExpansion = String(d.expansionInstructions || '');
    $('primaryRecapInstructions').value = lastSavedPrimary;
    $('expansionRecapInstructions').value = lastSavedExpansion;
    updatePromptCounts();
  }

  async function loadPrompt() {
    $('promptMsg').textContent = 'Loading saved prompt settings...';
    const d = await postJson('/recap-prompt/get');
    if (!d.success) {
      $('promptMsg').textContent = d.error || 'Could not load recap prompt settings.';
      return false;
    }
    applyPromptConfig(d);
    $('promptMsg').textContent = d.source === 'mongodb' ? '' : 'Using default instructions.';
    return true;
  }


  $('promptSettingsToggle').onclick = async () => {
    const opening = !$('promptSettingsBody').classList.contains('open');
    setPromptSettingsOpen(opening);
    if (opening && !lastSavedPrimary && !lastSavedExpansion) {
      await loadPrompt();
    }
  };

  $('sendBtn').onclick = async () => {
    const message = $('chatMessage').value.trim();
    if (!message) return;
    const d = await postJson('/send-chat', { message });
    if (d.success) {
      $('chatMsg').textContent = d.fallback ? 'Sent via IRC fallback (no bot badge for this message).' : 'Sent via Twitch Chat API.';
      $('chatMessage').value = '';
    } else {
      $('chatMsg').textContent = d.error || 'Failed to send.';
    }
  };

  $('storedBtn').onclick = async () => {
    $('testResult').textContent = 'Generating...';
    const d = await postJson('/test-summary', { type: 'stored' });
    $('testResult').textContent = d.success
      ? `${d.output}\n\n${d.characterCount}/500 characters`
      : (d.error?.message || d.error || 'Error');
  };

  $('primaryRecapInstructions').addEventListener('input', updatePromptCounts);
  $('expansionRecapInstructions').addEventListener('input', updatePromptCounts);

  $('savePromptBtn').onclick = async () => {
    const primaryInstructions = $('primaryRecapInstructions').value.trim();
    const expansionInstructions = $('expansionRecapInstructions').value.trim();
    if (!primaryInstructions || !expansionInstructions) {
      $('promptMsg').textContent = 'Both prompt instruction fields must contain text.';
      return;
    }

    $('savePromptBtn').disabled = true;
    $('promptMsg').textContent = 'Saving prompt settings...';
    const d = await postJson('/recap-prompt/save', { primaryInstructions, expansionInstructions });
    $('savePromptBtn').disabled = false;

    if (!d.success) {
      $('promptMsg').textContent = d.error || 'Could not save recap prompt settings.';
      return;
    }

    applyPromptConfig(d);
    $('promptMsg').textContent = 'Saved. The next recap will use these instructions.';
  };

  $('undoPromptBtn').onclick = async () => {
    const loaded = await loadPrompt();
    if (loaded) $('promptMsg').textContent = 'Unsaved changes discarded.';
  };

  setPromptSettingsOpen(false);
  updatePromptCounts();
  return { loadPrompt };
}
