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
  const triggerMsgEl = $('customTriggerMsg');
  const responseMsgEl = $('customResponseMsg');

  function setMessage(text, isError = false) {
    msgEl.textContent = text || '';
    msgEl.classList.toggle('bad', Boolean(isError));
  }

  function setEditorMessage(text, isError = false) {
    editorMsgEl.textContent = text || '';
    editorMsgEl.classList.toggle('bad', Boolean(isError));
  }

  function setTriggerMessage(text, isError = false) {
    triggerMsgEl.textContent = text || '';
    triggerMsgEl.classList.toggle('bad', Boolean(isError));
  }

  function setResponseMessage(text, isError = false) {
    responseMsgEl.textContent = text || '';
    responseMsgEl.classList.toggle('bad', Boolean(isError));
  }

  function responseMode() {
    return $('customResponseMode').value || 'equal';
  }

  function updateResponseModeUi() {
    const mode = responseMode();
    const help = $('customResponseModeHelp');
    if (mode === 'weighted') {
      help.textContent = 'Specified Weight chooses proportionally by weight. Example: weights 1, 2, 7 are roughly 10%, 20%, 70%.';
    } else if (mode === 'ifelse') {
      help.textContent = 'If / Else checks the first word after the matched trigger, case-insensitively. Set a word such as genesect; leave one condition blank for Else.';
    } else {
      help.textContent = 'Equal Odds randomly chooses between all responses.';
    }
    responsesEl.querySelectorAll('.custom-response-row').forEach((row) => {
      row.querySelector('.custom-response-weight-wrap').hidden = mode !== 'weighted';
      row.querySelector('.custom-response-condition-wrap').hidden = mode !== 'ifelse';
    });
    updateAddResponseState();
  }

  function clearEditorMessages() {
    setEditorMessage('');
    setTriggerMessage('');
    setResponseMessage('');
  }

  function escAttr(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
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
        setTriggerMessage('A custom command needs at least one trigger.', true);
        return;
      }
      wrapper.remove();
      setTriggerMessage('');
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
    setTriggerMessage('');
    triggersEl.appendChild(triggerRow(value));
    updateAddTriggerState();
  }

  function responseRow(value = '', weight = 1, condition = '') {
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-response-row';
    wrapper.innerHTML = `
      <div class="custom-response-rule-row">
        <label class="custom-response-weight-wrap">Weight
          <input class="custom-response-weight" type="number" min="0" step="0.01" value="${escAttr(weight ?? 1)}">
        </label>
        <label class="custom-response-condition-wrap">If first word equals
          <input class="custom-response-condition" type="text" maxlength="80" placeholder="Example: genesect" value="${escAttr(condition || '')}">
          <span class="detail">Leave blank for Else.</span>
        </label>
      </div>
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
        setResponseMessage('A command needs at least one response.', true);
        return;
      }
      wrapper.remove();
      setResponseMessage('');
      updateAddResponseState();
    };
    updateCount();
    return wrapper;
  }

  function updateAddResponseState() {
    $('addCustomResponseBtn').disabled = responsesEl.children.length >= maxResponses;
    const mode = responseMode();
    const detail = mode === 'weighted'
      ? 'Responses are selected proportionally by their weights.'
      : mode === 'ifelse'
        ? 'The first word after the trigger selects a matching response; one blank condition can act as Else.'
        : 'One response is selected at equal random odds each time the command actually fires.';
    $('customResponseHelp').textContent = `${responsesEl.children.length}/${maxResponses} response slots. ${detail}`;
  }

  function addResponse(value = '', weight = 1, condition = '') {
    if (responsesEl.children.length >= maxResponses) return;
    setResponseMessage('');
    responsesEl.appendChild(responseRow(value, weight, condition));
    updateResponseModeUi();
  }


  function updateCooldownResponseCount() {
    $('customCooldownResponseCount').textContent = `${$('customCooldownResponse').value.length}/${maxResponseLength}`;
  }

  function commandLabel(command) {
    if (command?.name) return command.name;
    const triggers = command?.triggers?.length ? command.triggers : [{ triggerType: command?.triggerType, trigger: command?.trigger }];
    return triggers[0]?.trigger || 'custom command';
  }

  function responseModeLabel(mode) {
    if (mode === 'weighted') return 'Weighted';
    if (mode === 'ifelse') return 'If / Else';
    return 'Equal Odds';
  }

  function closeEditor() {
    editingId = null;
    editorEl.classList.remove('open');
    clearEditorMessages();
  }

  function openEditor(command = null) {
    editingId = command?.id || null;
    $('customCommandEditorTitle').textContent = command ? 'Edit Custom Command' : 'Add Custom Command';
    $('customCommandName').value = command?.name || commandLabel(command || {});
    if (!command) $('customCommandName').value = '';
    $('customUserLevel').value = command?.userLevel || 'everyone';
    $('customProbability').value = command?.probability ?? 100;
    $('customCooldown').value = command?.cooldownSeconds ?? 0;
    $('customCooldownResponse').value = command?.cooldownResponse || '';
    $('customUseCooldownResponse').checked = Boolean(command?.cooldownResponse);
    $('customCooldownResponseWrap').hidden = !$('customUseCooldownResponse').checked;
    $('customResponseMode').value = command?.responseMode || 'equal';
    updateCooldownResponseCount();
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
    const responseWeights = command?.responseWeights || [];
    const responseConditions = command?.responseConditions || [];
    responseValues.forEach((value, index) => addResponse(value, responseWeights[index] ?? 1, responseConditions[index] || ''));

    updateAddTriggerState();
    updateResponseModeUi();
    clearEditorMessages();
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
            <div class="detail">${triggers.length} ${triggerWord} · UL: ${esc(userLevel)} · ${esc(command.probability)}% chance · ${esc(command.cooldownSeconds)}s cooldown · ${command.responses.length} ${responseWord} · ${esc(responseModeLabel(command.responseMode))} · Counter: ${esc(command.counter)}</div>
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
    const responseEntries = [...responsesEl.querySelectorAll('.custom-response-row')].map((row) => ({
      response: row.querySelector('.custom-response-input').value.trim(),
      weight: Number(row.querySelector('.custom-response-weight').value),
      condition: row.querySelector('.custom-response-condition').value.trim()
    })).filter((entry) => entry.response);
    const responses = responseEntries.map((entry) => entry.response);
    const responseWeights = responseEntries.map((entry) => entry.weight);
    const responseConditions = responseEntries.map((entry) => entry.condition);

    if (!triggers.length) {
      setTriggerMessage('Add at least one trigger.', true);
      triggersEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setTriggerMessage('');

    if (!responses.length) {
      setResponseMessage('Add at least one response.', true);
      responsesEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setResponseMessage('');

    const payload = {
      id: editingId || undefined,
      name,
      triggers,
      userLevel: $('customUserLevel').value,
      probability: Number($('customProbability').value),
      cooldownSeconds: Number($('customCooldown').value),
      cooldownResponse: $('customUseCooldownResponse').checked ? $('customCooldownResponse').value.trim() : '',
      enabled: $('customEnabled').checked,
      responseMode: responseMode(),
      responseWeights,
      responseConditions,
      responses
    };

    $('saveCustomCommandBtn').disabled = true;
    setEditorMessage('Saving...');
    const d = await postJson('/custom-commands/save', payload);
    $('saveCustomCommandBtn').disabled = false;
    if (!d.success) {
      const errorText = d.error || 'Could not save custom command.';
      const lowerError = String(errorText).toLowerCase();
      if (lowerError.includes('trigger')) {
        setTriggerMessage(errorText, true);
        triggersEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (lowerError.includes('response')) {
        setResponseMessage(errorText, true);
        responsesEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        setEditorMessage(errorText, true);
      }
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

  const variablesDialog = $('customVariablesDialog');
  $('showCustomVariablesBtn').onclick = () => {
    if (typeof variablesDialog.showModal === 'function') variablesDialog.showModal();
    else variablesDialog.setAttribute('open', '');
  };
  $('closeCustomVariablesBtn').onclick = () => {
    if (typeof variablesDialog.close === 'function') variablesDialog.close();
    else variablesDialog.removeAttribute('open');
  };
  variablesDialog.addEventListener('click', (event) => {
    if (event.target === variablesDialog && typeof variablesDialog.close === 'function') variablesDialog.close();
  });

  $('customUseCooldownResponse').onchange = () => {
    const enabled = $('customUseCooldownResponse').checked;
    $('customCooldownResponseWrap').hidden = !enabled;
    if (enabled) $('customCooldownResponse').focus();
  };

  $('addCustomCommandBtn').onclick = () => openEditor();
  $('refreshCustomCommandsBtn').onclick = () => loadCommands();
  $('addCustomTriggerBtn').onclick = () => addTrigger();
  $('addCustomResponseBtn').onclick = () => addResponse('');
  $('customResponseMode').onchange = updateResponseModeUi;
  $('saveCustomCommandBtn').onclick = saveCommand;
  $('cancelCustomCommandBtn').onclick = closeEditor;
  $('customCooldown').max = String(maxCooldownSeconds);
  $('customCooldownResponse').maxLength = maxResponseLength;
  $('customCooldownResponse').addEventListener('input', updateCooldownResponseCount);
  updateCooldownResponseCount();
  $('customCommandName').maxLength = maxCommandNameLength;

  return {
    async onVisibilityChange(visible) {
      if (visible && !loaded) await loadCommands();
    },
    loadCommands
  };
}
