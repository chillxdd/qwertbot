export function initCustomCommandsSection({ $, esc, postJson, config = {} }) {
  const maxCommandNameLength = Number(config.maxCommandNameLength || 80);
  const maxTriggers = Number(config.maxTriggers || 25);
  const maxResponses = Number(config.maxResponses || 25);
  const maxResponseLength = Number(config.maxResponseLength || 500);
  const maxTriggerLength = Number(config.maxTriggerLength || 120);
  const maxCooldownSeconds = Number(config.maxCooldownSeconds || 86400);

  let commands = [];
  let editingId = null;
  let loaded = false;

  const listEl = $('customCommandList');
  const editorEl = $('customCommandEditor');
  const triggersEl = $('customCommandTriggers');
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

  function triggerRow(value = { triggerType: 'command', trigger: '' }) {
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-trigger-row';
    wrapper.innerHTML = `
      <select class="custom-trigger-type" aria-label="Trigger type">
        <option value="command">!Command</option>
        <option value="inline">Inline Phrase</option>
      </select>
      <input class="custom-trigger-input" maxlength="${maxTriggerLength}" placeholder="Example: !hydrate">
      <button class="secondary custom-trigger-remove" type="button">Remove</button>`;

    const type = wrapper.querySelector('.custom-trigger-type');
    const input = wrapper.querySelector('.custom-trigger-input');
    const remove = wrapper.querySelector('.custom-trigger-remove');
    type.value = value?.triggerType === 'inline' ? 'inline' : 'command';
    input.value = value?.trigger || '';

    const updatePlaceholder = () => {
      input.placeholder = type.value === 'inline' ? 'Example: drink water' : 'Example: !hydrate';
    };
    type.addEventListener('change', updatePlaceholder);
    remove.onclick = () => {
      if (triggersEl.children.length <= 1) {
        setEditorMessage('A custom command needs at least one trigger.', true);
        return;
      }
      wrapper.remove();
      updateAddTriggerState();
    };
    updatePlaceholder();
    return wrapper;
  }

  function updateAddTriggerState() {
    $('addCustomTriggerBtn').disabled = triggersEl.children.length >= maxTriggers;
    $('customTriggerHelp').textContent = `${triggersEl.children.length}/${maxTriggers} trigger slots. Mix !Command and Inline Phrase triggers freely; every trigger runs the same command settings and response pool.`;
  }

  function addTrigger(value = { triggerType: 'command', trigger: '' }) {
    if (triggersEl.children.length >= maxTriggers) return;
    triggersEl.appendChild(triggerRow(value));
    updateAddTriggerState();
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

  function commandLabel(command) {
    if (command?.name) return command.name;
    const triggers = command?.triggers?.length ? command.triggers : [{ triggerType: command?.triggerType, trigger: command?.trigger }];
    return triggers[0]?.trigger || 'custom command';
  }

  function closeEditor() {
    editingId = null;
    editorEl.classList.remove('open');
    setEditorMessage('');
  }

  function openEditor(command = null) {
    editingId = command?.id || null;
    $('customCommandEditorTitle').textContent = command ? 'Edit Custom Command' : 'Add Custom Command';
    $('customCommandName').value = command?.name || commandLabel(command || {});
    if (!command) $('customCommandName').value = '';
    $('customUserLevel').value = command?.userLevel || 'everyone';
    $('customProbability').value = command?.probability ?? 100;
    $('customCooldown').value = command?.cooldownSeconds ?? 0;
    $('customEnabled').checked = command?.enabled !== false;

    triggersEl.replaceChildren();
    const triggerValues = command?.triggers?.length
      ? command.triggers
      : command
        ? [{ triggerType: command.triggerType || 'command', trigger: command.trigger || '' }]
        : [{ triggerType: 'command', trigger: '' }];
    triggerValues.forEach(addTrigger);

    responsesEl.replaceChildren();
    const responseValues = command?.responses?.length ? command.responses : [''];
    responseValues.forEach(addResponse);

    updateAddTriggerState();
    updateAddResponseState();
    setEditorMessage('');
    editorEl.classList.add('open');
    $('customCommandName').focus();
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
      const triggers = command?.triggers?.length ? command.triggers : [{ triggerType: command.triggerType, trigger: command.trigger }];
      const responseWord = command.responses.length === 1 ? 'response' : 'responses';
      const triggerWord = triggers.length === 1 ? 'trigger' : 'triggers';
      const userLevelLabels = { everyone: 'Everyone', subscriber: 'Subscriber', twitch_vip: 'Twitch VIP', moderator: 'Moderator', owner: 'Broadcaster / Owner' };
      const userLevel = userLevelLabels[command.userLevel] || 'Everyone';
      const triggerChips = triggers.map((trigger) => {
        const type = trigger.triggerType === 'inline' ? 'Inline' : '!Command';
        return `<span class="custom-trigger-chip"><strong>${esc(trigger.trigger)}</strong><small>${esc(type)}</small></span>`;
      }).join('');
      return `
        <div class="custom-command-card" data-id="${esc(command.id)}">
          <div class="custom-command-card-main">
            <div class="custom-command-title-row">
              <strong class="custom-command-name">${esc(commandLabel(command))}</strong>
              ${statusBadge(command)}
            </div>
            <div class="custom-trigger-chip-list">${triggerChips}</div>
            <div class="detail">${triggers.length} ${triggerWord} · UL: ${esc(userLevel)} · ${esc(command.probability)}% chance · ${esc(command.cooldownSeconds)}s cooldown · ${command.responses.length} ${responseWord} · Counter: ${esc(command.counter)}</div>
          </div>
          <div class="custom-command-actions">
            <button class="secondary custom-edit-btn" type="button">Edit</button>
            <button class="secondary custom-toggle-btn" type="button">${command.enabled ? 'Disable' : 'Enable'}</button>
            <button class="secondary custom-set-counter-btn" type="button">Set Counter</button>
            <button class="danger custom-delete-btn" type="button">Delete</button>
          </div>
        </div>`;
    }).join('');

    listEl.querySelectorAll('.custom-command-card').forEach((card) => {
      const command = commands.find((item) => item.id === card.dataset.id);
      card.querySelector('.custom-edit-btn').onclick = () => openEditor(command);
      card.querySelector('.custom-toggle-btn').onclick = () => toggleCommand(command);
      card.querySelector('.custom-set-counter-btn').onclick = () => setCounter(command);
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
    const name = $('customCommandName').value.trim();
    if (!name) {
      setEditorMessage('Give this custom command a name.', true);
      $('customCommandName').focus();
      return;
    }
    if (name.length > maxCommandNameLength) {
      setEditorMessage(`Command name cannot exceed ${maxCommandNameLength} characters.`, true);
      return;
    }

    const triggers = [...triggersEl.querySelectorAll('.custom-trigger-row')].map((row) => ({
      triggerType: row.querySelector('.custom-trigger-type').value,
      trigger: row.querySelector('.custom-trigger-input').value.trim()
    })).filter((item) => item.trigger);
    const responses = [...responsesEl.querySelectorAll('.custom-response-input')].map((el) => el.value.trim()).filter(Boolean);

    if (!triggers.length) {
      setEditorMessage('Add at least one trigger.', true);
      return;
    }

    const payload = {
      id: editingId || undefined,
      name,
      triggers,
      userLevel: $('customUserLevel').value,
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
    setMessage(`${commandLabel(command)} ${command.enabled ? 'disabled' : 'enabled'}.`);
  }

  async function setCounter(command) {
    const label = commandLabel(command);
    const raw = prompt(`Set the counter for ${label} to any whole integer >= 0:`, String(command.counter ?? 0));
    if (raw === null) return;

    const value = Number(raw.trim());
    if (!Number.isInteger(value) || value < 0) {
      return setMessage('Counter must be a whole integer greater than or equal to 0.', true);
    }

    const d = await postJson('/custom-commands/set-counter', { id: command.id, counter: value });
    if (!d.success) return setMessage(d.error || 'Could not set counter.', true);
    await loadCommands({ quiet: true });
    setMessage(`${label} counter set to ${value}.`);
  }

  async function deleteCommand(command) {
    const label = commandLabel(command);
    if (!confirm(`Delete ${label} and all of its triggers? This cannot be undone.`)) return;
    const d = await postJson('/custom-commands/delete', { id: command.id });
    if (!d.success) return setMessage(d.error || 'Could not delete custom command.', true);
    if (editingId === command.id) closeEditor();
    await loadCommands({ quiet: true });
    setMessage(`${label} deleted.`);
  }

  const variableHelpButton = $('toggleCustomVariableHelpBtn');
  const variableHelpBody = $('customVariableHelpBody');
  variableHelpButton.onclick = () => {
    const willShow = variableHelpBody.hidden;
    variableHelpBody.hidden = !willShow;
    variableHelpButton.textContent = willShow ? 'Hide Variables' : 'Show Variables';
    variableHelpButton.setAttribute('aria-expanded', String(willShow));
  };

  $('addCustomCommandBtn').onclick = () => openEditor();
  $('refreshCustomCommandsBtn').onclick = () => loadCommands();
  $('addCustomTriggerBtn').onclick = () => addTrigger();
  $('addCustomResponseBtn').onclick = () => addResponse('');
  $('saveCustomCommandBtn').onclick = saveCommand;
  $('cancelCustomCommandBtn').onclick = closeEditor;
  $('customCooldown').max = String(maxCooldownSeconds);
  $('customCommandName').maxLength = maxCommandNameLength;

  return {
    async onVisibilityChange(visible) {
      if (visible && !loaded) await loadCommands();
    },
    loadCommands
  };
}
