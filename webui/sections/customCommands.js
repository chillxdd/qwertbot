export function initCustomCommandsSection({ $, esc, postJson, config = {} }) {
  const maxCommandNameLength = Number(config.maxCommandNameLength || 80);
  const maxTriggers = Number(config.maxTriggers || 25);
  const maxResponses = Number(config.maxResponses || 25);
  const maxResponseLength = Number(config.maxResponseLength || 500);
  const maxTriggerLength = Number(config.maxTriggerLength || 120);
  const maxCooldownSeconds = Number(config.maxCooldownSeconds || 86400);
  const defaultCommandCooldownSeconds = Number(config.defaultCommandCooldownSeconds ?? 5);
  const defaultGlobalCooldownSeconds = Number(config.defaultGlobalCooldownSeconds ?? 5);

  let commands = [];
  let editingId = null;
  let loaded = false;
  let currentPage = 1;
  let counterCommand = null;

  const SORT_STORAGE_KEY = 'sqwert-custom-command-sort';
  const VALID_SORTS = new Set(['created_asc', 'created_desc', 'name_asc', 'name_desc', 'counter_desc', 'counter_asc']);
  const PAGE_SIZE_STORAGE_KEY = 'sqwert-custom-command-page-size';
  const VALID_PAGE_SIZES = new Set([10, 25, 50]);

  const listEl = $('customCommandList');
  const editorEl = $('customCommandEditor');
  const triggersEl = $('customCommandTriggers');
  const responsesEl = $('customCommandResponses');
  const msgEl = $('customCommandsMsg');
  const editorMsgEl = $('customCommandEditorMsg');
  const triggerMsgEl = $('customTriggerMsg');
  const responseMsgEl = $('customResponseMsg');
  const globalCooldownMsgEl = $('customGlobalCooldownMsg');

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

  function setGlobalCooldownMessage(text, isError = false) {
    globalCooldownMsgEl.textContent = text || '';
    globalCooldownMsgEl.classList.toggle('bad', Boolean(isError));
  }

  function responseMode() {
    return $('customResponseMode').value || 'equal';
  }

  function updateSendAsUi() {
    const sendAs = $('customSendAs').value || 'chat';
    $('customAnnouncementColorWrap').hidden = sendAs !== 'announcement';
    $('customSendAsHelp').textContent = sendAs === 'announcement'
      ? "Announcement sends the selected response using Twitch's highlighted announcement banner. The bot account must be a moderator and authorized for announcements."
      : sendAs === 'reply'
        ? 'Reply to Trigger sends the response as a Twitch reply to the viewer message that triggered the command. If no source message is available, it falls back to normal chat.'
        : 'Chat Message sends a normal bot message.';
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
    if (editorEl.open && typeof editorEl.close === 'function') editorEl.close();
    else editorEl.removeAttribute('open');
    clearEditorMessages();
  }

  function openEditor(command = null) {
    editingId = command?.id || null;
    $('customCommandEditorTitle').textContent = command ? 'Edit Custom Command' : 'Add Custom Command';
    $('customCommandName').value = command?.name || commandLabel(command || {});
    if (!command) $('customCommandName').value = '';
    $('customUserLevel').value = command?.userLevel || 'everyone';
    $('customProbability').value = command?.probability ?? 100;
    $('customCooldown').value = command?.cooldownSeconds ?? defaultCommandCooldownSeconds;
    $('customResponseDelay').value = command?.responseDelaySeconds ?? 0;
    $('customCooldownResponse').value = command?.cooldownResponse || '';
    $('customUseCooldownResponse').checked = Boolean(command?.cooldownResponse);
    $('customCooldownResponseWrap').hidden = !$('customUseCooldownResponse').checked;
    $('customResponseMode').value = command?.responseMode || 'equal';
    $('customSendAs').value = command?.sendAs || 'chat';
    $('customAnnouncementColor').value = command?.announcementColor || 'primary';
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
    updateSendAsUi();
    clearEditorMessages();
    editorEl.classList.add('open');
    if (typeof editorEl.showModal === 'function' && !editorEl.open) editorEl.showModal();
    else editorEl.setAttribute('open', '');
    $('customCommandName').focus();
  }

  function statusBadge(command) {
    return command.enabled
      ? '<span class="custom-command-state enabled">Enabled</span>'
      : '<span class="custom-command-state disabled">Disabled</span>';
  }

  function selectedSort() {
    const value = $('customCommandSort')?.value || 'created_asc';
    return VALID_SORTS.has(value) ? value : 'created_asc';
  }

  function commandCreatedMs(command) {
    const value = Date.parse(command?.createdAt || '');
    return Number.isFinite(value) ? value : 0;
  }

  function compareCommandNames(a, b) {
    return commandLabel(a).localeCompare(commandLabel(b), undefined, { sensitivity: 'base', numeric: true });
  }

  function sortedCommands() {
    const sort = selectedSort();
    return [...commands].sort((a, b) => {
      let result = 0;
      if (sort === 'name_asc') result = compareCommandNames(a, b);
      else if (sort === 'name_desc') result = compareCommandNames(b, a);
      else if (sort === 'counter_desc') result = Number(b?.counter || 0) - Number(a?.counter || 0);
      else if (sort === 'counter_asc') result = Number(a?.counter || 0) - Number(b?.counter || 0);
      else if (sort === 'created_desc') result = commandCreatedMs(b) - commandCreatedMs(a);
      else result = commandCreatedMs(a) - commandCreatedMs(b);

      // Keep ties deterministic so cards do not jump around between refreshes.
      if (result === 0) result = compareCommandNames(a, b);
      if (result === 0) result = String(a?.id || '').localeCompare(String(b?.id || ''));
      return result;
    });
  }


  function selectedPageSize() {
    const value = Number($('customCommandPageSize')?.value || 10);
    return VALID_PAGE_SIZES.has(value) ? value : 10;
  }

  function searchQuery() {
    return String($('customCommandSearch')?.value || '').trim().toLocaleLowerCase();
  }

  function matchesSearch(command, query) {
    if (!query) return true;
    const triggers = command?.triggers?.length
      ? command.triggers
      : [{ triggerType: command?.triggerType, trigger: command?.trigger }];
    const haystack = [
      commandLabel(command),
      command?.userLevel,
      ...(triggers || []).flatMap((item) => [item?.trigger, item?.triggerType]),
      ...(Array.isArray(command?.responses) ? command.responses : [])
    ].filter(Boolean).join(' ').toLocaleLowerCase();
    return haystack.includes(query);
  }

  function filteredCommands() {
    const query = searchQuery();
    return sortedCommands().filter((command) => matchesSearch(command, query));
  }

  function updatePagination(totalItems) {
    const pageSize = selectedPageSize();
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    currentPage = Math.min(Math.max(1, currentPage), totalPages);
    $('customCommandPageLabel').textContent = `Page ${currentPage} of ${totalPages}`;
    $('customCommandPrevPage').disabled = currentPage <= 1;
    $('customCommandNextPage').disabled = currentPage >= totalPages;
    $('customCommandPagination').hidden = commands.length === 0;
    return { pageSize, totalPages };
  }

  function renderList() {
    if (!commands.length) {
      listEl.innerHTML = '<div class="coming-soon custom-empty-state">No custom commands yet. Add one to get started.</div>';
      $('customCommandPagination').hidden = true;
      return;
    }

    const filtered = filteredCommands();
    const { pageSize } = updatePagination(filtered.length);
    const start = (currentPage - 1) * pageSize;
    const visibleCommands = filtered.slice(start, start + pageSize);

    if (!visibleCommands.length) {
      listEl.innerHTML = '<div class="coming-soon custom-empty-state">No custom commands match your search.</div>';
      return;
    }

    listEl.innerHTML = visibleCommands.map((command) => {
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
            <div class="detail">${triggers.length} ${triggerWord} · UL: ${esc(userLevel)} · ${esc(command.probability)}% chance · ${esc(command.cooldownSeconds)}s cooldown · ${esc(command.responseDelaySeconds || 0)}s delay · ${command.responses.length} ${responseWord} · ${esc(responseModeLabel(command.responseMode))} · ${command.sendAs === 'announcement' ? `Announcement (${esc(command.announcementColor || 'primary')})` : command.sendAs === 'reply' ? 'Reply to Trigger' : 'Chat Message'} · Counter: ${esc(command.counter)}</div>
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


  async function loadGlobalCooldown({ quiet = false } = {}) {
    if (!quiet) setGlobalCooldownMessage('Loading...');
    const d = await postJson('/custom-commands/settings');
    if (!d.success) {
      setGlobalCooldownMessage(d.error || 'Could not load global cooldown.', true);
      return false;
    }
    const value = Number(d.settings?.globalCooldownSeconds ?? defaultGlobalCooldownSeconds);
    $('customGlobalCooldown').value = Number.isFinite(value) ? value : defaultGlobalCooldownSeconds;
    setGlobalCooldownMessage(quiet ? '' : 'Loaded.');
    return true;
  }

  async function saveGlobalCooldown() {
    const value = Number($('customGlobalCooldown').value);
    if (!Number.isFinite(value) || value < 0 || value > maxCooldownSeconds) {
      setGlobalCooldownMessage(`Enter a value between 0 and ${maxCooldownSeconds} seconds.`, true);
      return;
    }

    $('saveCustomGlobalCooldownBtn').disabled = true;
    setGlobalCooldownMessage('Saving...');
    const d = await postJson('/custom-commands/settings/save', { globalCooldownSeconds: value });
    $('saveCustomGlobalCooldownBtn').disabled = false;
    if (!d.success) {
      setGlobalCooldownMessage(d.error || 'Could not save global cooldown.', true);
      return;
    }
    $('customGlobalCooldown').value = d.settings?.globalCooldownSeconds ?? value;
    setGlobalCooldownMessage('Saved. Changes are live immediately.');
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
      setEditorMessage(`Name cannot exceed ${maxCommandNameLength} characters.`, true);
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
      responseDelaySeconds: Number($('customResponseDelay').value),
      cooldownResponse: $('customUseCooldownResponse').checked ? $('customCooldownResponse').value.trim() : '',
      enabled: $('customEnabled').checked,
      responseMode: responseMode(),
      sendAs: $('customSendAs').value || 'chat',
      announcementColor: $('customAnnouncementColor').value || 'primary',
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

  function closeCounterDialog() {
    counterCommand = null;
    $('customCounterMsg').textContent = '';
    $('customCounterMsg').classList.remove('bad');
    const dialog = $('customCounterDialog');
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  }

  function setCounter(command) {
    counterCommand = command;
    $('customCounterCommandName').textContent = commandLabel(command);
    $('customCounterValue').value = String(command.counter ?? 0);
    $('customCounterMsg').textContent = '';
    $('customCounterMsg').classList.remove('bad');
    const dialog = $('customCounterDialog');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    requestAnimationFrame(() => {
      $('customCounterValue').focus();
      $('customCounterValue').select();
    });
  }

  async function saveCounter() {
    if (!counterCommand) return;
    const raw = String($('customCounterValue').value || '').trim();
    const value = Number(raw);
    const counterMsg = $('customCounterMsg');
    counterMsg.textContent = '';
    counterMsg.classList.remove('bad');
    if (raw === '' || !Number.isInteger(value) || value < 0) {
      counterMsg.textContent = 'Counter must be a whole integer greater than or equal to 0.';
      counterMsg.classList.add('bad');
      $('customCounterValue').focus();
      return;
    }

    const command = counterCommand;
    const label = commandLabel(command);
    $('saveCustomCounterBtn').disabled = true;
    try {
      const d = await postJson('/custom-commands/set-counter', { id: command.id, counter: value });
      if (!d.success) {
        counterMsg.textContent = d.error || 'Could not set counter.';
        counterMsg.classList.add('bad');
        return;
      }
      closeCounterDialog();
      await loadCommands({ quiet: true });
      setMessage(`${label} counter set to ${value}.`);
    } finally {
      $('saveCustomCounterBtn').disabled = false;
    }
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

  const counterDialog = $('customCounterDialog');
  $('saveCustomCounterBtn').onclick = saveCounter;
  $('cancelCustomCounterBtn').onclick = closeCounterDialog;
  $('closeCustomCounterBtn').onclick = closeCounterDialog;
  $('customCounterValue').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void saveCounter();
    }
  });
  counterDialog.addEventListener('click', (event) => {
    if (event.target === counterDialog) closeCounterDialog();
  });
  counterDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeCounterDialog();
  });

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

  const sortSelect = $('customCommandSort');
  if (sortSelect) {
    try {
      const savedSort = localStorage.getItem(SORT_STORAGE_KEY);
      if (VALID_SORTS.has(savedSort)) sortSelect.value = savedSort;
    } catch {}
    sortSelect.onchange = () => {
      try { localStorage.setItem(SORT_STORAGE_KEY, selectedSort()); } catch {}
      currentPage = 1;
      renderList();
    };
  }

  const searchInput = $('customCommandSearch');
  if (searchInput) searchInput.oninput = () => { currentPage = 1; renderList(); };

  const pageSizeSelect = $('customCommandPageSize');
  if (pageSizeSelect) {
    try {
      const savedPageSize = Number(localStorage.getItem(PAGE_SIZE_STORAGE_KEY));
      if (VALID_PAGE_SIZES.has(savedPageSize)) pageSizeSelect.value = String(savedPageSize);
    } catch {}
    pageSizeSelect.onchange = () => {
      currentPage = 1;
      try { localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(selectedPageSize())); } catch {}
      renderList();
    };
  }
  $('customCommandPrevPage').onclick = () => { if (currentPage > 1) { currentPage -= 1; renderList(); } };
  $('customCommandNextPage').onclick = () => { currentPage += 1; renderList(); };

  $('addCustomCommandBtn').onclick = () => openEditor();
  $('refreshCustomCommandsBtn').onclick = () => Promise.all([loadCommands(), loadGlobalCooldown()]);
  $('saveCustomGlobalCooldownBtn').onclick = saveGlobalCooldown;
  $('addCustomTriggerBtn').onclick = () => addTrigger();
  $('addCustomResponseBtn').onclick = () => addResponse('');
  $('customResponseMode').onchange = updateResponseModeUi;
  $('customSendAs').onchange = updateSendAsUi;
  $('saveCustomCommandBtn').onclick = saveCommand;
  $('cancelCustomCommandBtn').onclick = closeEditor;
  $('closeCustomCommandEditorBtn').onclick = closeEditor;
  editorEl.addEventListener('click', (event) => { if (event.target === editorEl && !variablesDialog.open) closeEditor(); });
  editorEl.addEventListener('cancel', (event) => { event.preventDefault(); if (!variablesDialog.open) closeEditor(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && editorEl.classList.contains('open') && !variablesDialog.open) closeEditor(); });
  $('customGlobalCooldown').max = String(maxCooldownSeconds);
  $('customGlobalCooldown').value = String(defaultGlobalCooldownSeconds);
  $('customCooldown').max = String(maxCooldownSeconds);
  $('customCooldownResponse').maxLength = maxResponseLength;
  $('customCooldownResponse').addEventListener('input', updateCooldownResponseCount);
  updateCooldownResponseCount();
  $('customCommandName').maxLength = maxCommandNameLength;

  return {
    async onVisibilityChange(visible) {
      if (!visible) {
        if (editorEl.classList.contains('open')) closeEditor();
        return;
      }
      if (!loaded) {
        await Promise.all([loadCommands(), loadGlobalCooldown()]);
      }
    },
    loadCommands
  };
}
