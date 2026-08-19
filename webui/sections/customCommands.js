export function initCustomCommandsSection({ $, esc, postJson, config = {} }) {
  const maxResponses = Number(config.maxResponses || 25);
  const maxResponseLength = Number(config.maxResponseLength || 500);
  const maxTriggerLength = Number(config.maxTriggerLength || 120);
  const maxCooldownSeconds = Number(config.maxCooldownSeconds || 86400);

  let commands = [];
  let editingId = null;
  let loaded = false;

  const listEl = $('customCommandList');
  const editorEl = $('customCommandEditor');
  const responsesEl = $('customCommandResponses');
  const msgEl = $('customCommandsMsg');
  const editorMsgEl = $('customCommandEditorMsg');

  function setMessage(text, isError = false) {
    msgEl.textContent = text || '';
    msgEl.classList.toggle('bad', Boolean(isError));
  }

  function setEditorMessage(text, isError = false) {
    editorMsgEl.textContent = text || '';
    editorMsgEl.classList.toggle('bad', Boolean(isError));
  }

  function responseRow(value = '') {
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-response-row';
    wrapper.innerHTML = `
      <textarea class="custom-response-input" maxlength="${maxResponseLength}" placeholder="Response text..."></textarea>
      <div class="custom-response-footer">
        <span class="detail custom-response-count">0/${maxResponseLength}</span>
        <button class="secondary custom-response-remove" type="button">Remove</button>
      </div>`;

    const textarea = wrapper.querySelector('.custom-response-input');
    const count = wrapper.querySelector('.custom-response-count');
    const remove = wrapper.querySelector('.custom-response-remove');
    textarea.value = value;

    const updateCount = () => { count.textContent = `${textarea.value.length}/${maxResponseLength}`; };
    textarea.addEventListener('input', updateCount);
    remove.onclick = () => {
      if (responsesEl.children.length <= 1) {
        setEditorMessage('A command needs at least one response.', true);
        return;
      }
      wrapper.remove();
      updateAddResponseState();
    };
    updateCount();
    return wrapper;
  }

  function updateAddResponseState() {
    $('addCustomResponseBtn').disabled = responsesEl.children.length >= maxResponses;
    $('customResponseHelp').textContent = `${responsesEl.children.length}/${maxResponses} response slots. One response is selected at random each time the command actually fires.`;
  }

  function addResponse(value = '') {
    if (responsesEl.children.length >= maxResponses) return;
    responsesEl.appendChild(responseRow(value));
    updateAddResponseState();
  }

  function closeEditor() {
    editingId = null;
    editorEl.classList.remove('open');
    setEditorMessage('');
  }

  function openEditor(command = null) {
    editingId = command?.id || null;
    $('customCommandEditorTitle').textContent = command ? 'Edit Custom Command' : 'Add Custom Command';
    $('customTriggerType').value = command?.triggerType || 'command';
    $('customTrigger').value = command?.trigger || '';
    $('customProbability').value = command?.probability ?? 100;
    $('customCooldown').value = command?.cooldownSeconds ?? 0;
    $('customEnabled').checked = command?.enabled !== false;
    responsesEl.replaceChildren();
    const values = command?.responses?.length ? command.responses : [''];
    values.forEach(addResponse);
    updateTriggerHelp();
    updateAddResponseState();
    setEditorMessage('');
    editorEl.classList.add('open');
    $('customTrigger').focus();
  }

  function updateTriggerHelp() {
    const type = $('customTriggerType').value;
    const trigger = $('customTrigger');
    if (type === 'inline') {
      trigger.placeholder = 'Example: hog reveal';
      $('customTriggerHelp').textContent = 'Inline Phrase: case-insensitive text that can appear anywhere in a normal viewer message. The viewer message remains eligible for the AI recap.';
    } else {
      trigger.placeholder = 'Example: !hog';
      $('customTriggerHelp').textContent = 'Command: matches the first chat token exactly, such as !hog or !quote. Arguments after it are available through $(query) and $(touser).';
    }
  }

  function statusBadge(command) {
    return command.enabled
      ? '<span class="custom-command-state enabled">Enabled</span>'
      : '<span class="custom-command-state disabled">Disabled</span>';
  }

  function renderList() {
    if (!commands.length) {
      listEl.innerHTML = '<div class="coming-soon custom-empty-state">No custom commands yet. Add one to get started.</div>';
      return;
    }

    listEl.innerHTML = commands.map((command) => {
      const type = command.triggerType === 'inline' ? 'Inline Phrase' : '!Command';
      const responseWord = command.responses.length === 1 ? 'response' : 'responses';
      return `
        <div class="custom-command-card" data-id="${esc(command.id)}">
          <div class="custom-command-card-main">
            <div class="custom-command-title-row">
              <strong>${esc(command.trigger)}</strong>
              ${statusBadge(command)}
            </div>
            <div class="detail">${esc(type)} · ${esc(command.probability)}% chance · ${esc(command.cooldownSeconds)}s cooldown · ${command.responses.length} ${responseWord} · Counter: ${esc(command.counter)}</div>
          </div>
          <div class="custom-command-actions">
            <button class="secondary custom-edit-btn" type="button">Edit</button>
            <button class="secondary custom-toggle-btn" type="button">${command.enabled ? 'Disable' : 'Enable'}</button>
            <button class="secondary custom-reset-btn" type="button">Reset Counter</button>
            <button class="danger custom-delete-btn" type="button">Delete</button>
          </div>
        </div>`;
    }).join('');

    listEl.querySelectorAll('.custom-command-card').forEach((card) => {
      const command = commands.find((item) => item.id === card.dataset.id);
      card.querySelector('.custom-edit-btn').onclick = () => openEditor(command);
      card.querySelector('.custom-toggle-btn').onclick = () => toggleCommand(command);
      card.querySelector('.custom-reset-btn').onclick = () => resetCounter(command);
      card.querySelector('.custom-delete-btn').onclick = () => deleteCommand(command);
    });
  }

  async function loadCommands({ quiet = false } = {}) {
    if (!quiet) setMessage('Loading custom commands...');
    const d = await postJson('/custom-commands/list');
    if (!d.success) {
      setMessage(d.error || 'Could not load custom commands.', true);
      return false;
    }
    commands = Array.isArray(d.commands) ? d.commands : [];
    loaded = true;
    renderList();
    setMessage(`${commands.length} custom command${commands.length === 1 ? '' : 's'} loaded.`);
    return true;
  }

  async function saveCommand() {
    const responses = [...responsesEl.querySelectorAll('.custom-response-input')].map((el) => el.value.trim()).filter(Boolean);
    const payload = {
      id: editingId || undefined,
      triggerType: $('customTriggerType').value,
      trigger: $('customTrigger').value.trim(),
      probability: Number($('customProbability').value),
      cooldownSeconds: Number($('customCooldown').value),
      enabled: $('customEnabled').checked,
      responses
    };

    $('saveCustomCommandBtn').disabled = true;
    setEditorMessage('Saving...');
    const d = await postJson('/custom-commands/save', payload);
    $('saveCustomCommandBtn').disabled = false;
    if (!d.success) {
      setEditorMessage(d.error || 'Could not save custom command.', true);
      return;
    }

    closeEditor();
    await loadCommands({ quiet: true });
    setMessage('Custom command saved to MongoDB. Changes are live immediately.');
  }

  async function toggleCommand(command) {
    const d = await postJson('/custom-commands/toggle', { id: command.id, enabled: !command.enabled });
    if (!d.success) return setMessage(d.error || 'Could not update custom command.', true);
    await loadCommands({ quiet: true });
    setMessage(`${command.trigger} ${command.enabled ? 'disabled' : 'enabled'}.`);
  }

  async function resetCounter(command) {
    if (!confirm(`Reset the counter for ${command.trigger} to 0?`)) return;
    const d = await postJson('/custom-commands/reset-counter', { id: command.id });
    if (!d.success) return setMessage(d.error || 'Could not reset counter.', true);
    await loadCommands({ quiet: true });
    setMessage(`${command.trigger} counter reset to 0.`);
  }

  async function deleteCommand(command) {
    if (!confirm(`Delete ${command.trigger}? This cannot be undone.`)) return;
    const d = await postJson('/custom-commands/delete', { id: command.id });
    if (!d.success) return setMessage(d.error || 'Could not delete custom command.', true);
    if (editingId === command.id) closeEditor();
    await loadCommands({ quiet: true });
    setMessage(`${command.trigger} deleted.`);
  }

  $('addCustomCommandBtn').onclick = () => openEditor();
  $('refreshCustomCommandsBtn').onclick = () => loadCommands();
  $('customTriggerType').onchange = updateTriggerHelp;
  $('addCustomResponseBtn').onclick = () => addResponse('');
  $('saveCustomCommandBtn').onclick = saveCommand;
  $('cancelCustomCommandBtn').onclick = closeEditor;
  $('customTrigger').maxLength = maxTriggerLength;
  $('customCooldown').max = String(maxCooldownSeconds);

  return {
    async onVisibilityChange(visible) {
      if (visible && !loaded) await loadCommands();
    },
    loadCommands
  };
}
