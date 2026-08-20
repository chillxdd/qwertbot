export function initTimersSection({ $, esc, postJson, config = {} }) {
  const maxTimerNameLength = Number(config.maxTimerNameLength || 80);
  const minIntervalSeconds = Number(config.minIntervalSeconds || 30);
  const maxIntervalSeconds = Number(config.maxIntervalSeconds || 86400);
  const maxResponses = Number(config.maxResponses || 25);
  const maxResponseLength = Number(config.maxResponseLength || 500);

  let timers = [];
  let editingId = null;
  let loaded = false;

  const SORT_STORAGE_KEY = 'sqwert-timer-sort';
  const VALID_SORTS = new Set(['created_asc', 'created_desc', 'name_asc', 'name_desc', 'interval_asc', 'interval_desc']);

  const listEl = $('timerList');
  const editorEl = $('timerEditor');
  const responsesEl = $('timerResponses');
  const msgEl = $('timersMsg');
  const editorMsgEl = $('timerEditorMsg');
  const responseMsgEl = $('timerResponseMsg');

  function setMessage(text, isError = false) {
    msgEl.textContent = text || '';
    msgEl.classList.toggle('bad', Boolean(isError));
  }

  function setEditorMessage(text, isError = false) {
    editorMsgEl.textContent = text || '';
    editorMsgEl.classList.toggle('bad', Boolean(isError));
  }

  function setResponseMessage(text, isError = false) {
    responseMsgEl.textContent = text || '';
    responseMsgEl.classList.toggle('bad', Boolean(isError));
  }

  function formatInterval(seconds) {
    const total = Number(seconds || 0);
    if (total >= 3600 && total % 3600 === 0) return `${total / 3600}h`;
    if (total >= 60 && total % 60 === 0) return `${total / 60}m`;
    return `${total}s`;
  }

  function modeLabel(mode) {
    return mode === 'weighted' ? 'Specified Weight' : 'Equal Odds';
  }

  function selectedSort() {
    const value = $('timerSort')?.value || 'created_asc';
    return VALID_SORTS.has(value) ? value : 'created_asc';
  }

  function timerCreatedMs(timer) {
    const value = Date.parse(timer?.createdAt || '');
    return Number.isFinite(value) ? value : 0;
  }

  function compareTimerNames(a, b) {
    return String(a?.name || 'Timer').localeCompare(String(b?.name || 'Timer'), undefined, { sensitivity: 'base', numeric: true });
  }

  function sortedTimers() {
    const sort = selectedSort();
    return [...timers].sort((a, b) => {
      let result = 0;
      if (sort === 'name_asc') result = compareTimerNames(a, b);
      else if (sort === 'name_desc') result = compareTimerNames(b, a);
      else if (sort === 'interval_asc') result = Number(a?.intervalSeconds || 0) - Number(b?.intervalSeconds || 0);
      else if (sort === 'interval_desc') result = Number(b?.intervalSeconds || 0) - Number(a?.intervalSeconds || 0);
      else if (sort === 'created_desc') result = timerCreatedMs(b) - timerCreatedMs(a);
      else result = timerCreatedMs(a) - timerCreatedMs(b);

      if (result === 0) result = compareTimerNames(a, b);
      if (result === 0) result = String(a?.id || '').localeCompare(String(b?.id || ''));
      return result;
    });
  }

  function renderList() {
    listEl.innerHTML = '';
    if (!timers.length) {
      listEl.innerHTML = '<div class="custom-empty-state detail">No timers yet.</div>';
      return;
    }

    for (const timer of sortedTimers()) {
      const card = document.createElement('div');
      card.className = 'custom-command-card';
      const responseCount = Array.isArray(timer.responses) ? timer.responses.length : 0;
      card.innerHTML = `
        <div class="custom-command-card-main">
          <div class="custom-command-title-row">
            <strong class="custom-command-name">${esc(timer.name || 'Timer')}</strong>
            <span class="custom-command-state ${timer.enabled ? 'enabled' : 'disabled'}">${timer.enabled ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div class="detail">Every ${esc(formatInterval(timer.intervalSeconds))} while live · ${responseCount} response${responseCount === 1 ? '' : 's'} · ${esc(modeLabel(timer.responseMode))}</div>
        </div>
        <div class="custom-command-actions">
          <button class="secondary timer-edit-btn" type="button">Edit</button>
          <button class="secondary timer-toggle-btn" type="button">${timer.enabled ? 'Disable' : 'Enable'}</button>
          <button class="danger timer-delete-btn" type="button">Delete</button>
        </div>`;
      card.querySelector('.timer-edit-btn').onclick = () => openEditor(timer);
      card.querySelector('.timer-toggle-btn').onclick = () => toggleTimer(timer);
      card.querySelector('.timer-delete-btn').onclick = () => deleteTimer(timer);
      listEl.appendChild(card);
    }
  }

  async function loadTimers() {
    setMessage('Loading timers...');
    try {
      const d = await postJson('/timers/list', {});
      if (!d.success) throw new Error(d.error || 'Could not load timers.');
      timers = Array.isArray(d.timers) ? d.timers : [];
      loaded = true;
      renderList();
      setMessage(`${timers.length} timer${timers.length === 1 ? '' : 's'} loaded.`);
    } catch (err) {
      setMessage(err.message || 'Could not load timers.', true);
    }
  }

  function makeResponseRow(value = '', weight = 1) {
    const row = document.createElement('div');
    row.className = 'custom-response-row timer-response-row';
    row.innerHTML = `
      <textarea class="custom-response-input timer-response-input" maxlength="${maxResponseLength}" placeholder="Timer response"></textarea>
      <div class="custom-response-rule-row timer-weight-row">
        <label>Weight
          <input class="timer-response-weight" type="number" min="0.001" step="0.001" value="1">
        </label>
      </div>
      <div class="custom-response-footer">
        <span class="detail timer-response-count">0/${maxResponseLength}</span>
        <button class="secondary timer-remove-response" type="button">Remove</button>
      </div>`;
    const input = row.querySelector('.timer-response-input');
    const weightInput = row.querySelector('.timer-response-weight');
    const count = row.querySelector('.timer-response-count');
    input.value = value;
    weightInput.value = Number(weight) > 0 ? Number(weight) : 1;
    const updateCount = () => { count.textContent = `${Array.from(input.value).length}/${maxResponseLength}`; };
    input.oninput = updateCount;
    row.querySelector('.timer-remove-response').onclick = () => {
      row.remove();
      syncResponseMode();
    };
    updateCount();
    responsesEl.appendChild(row);
    syncResponseMode();
  }

  function syncResponseMode() {
    const weighted = $('timerResponseMode').value === 'weighted';
    $('timerResponseModeHelp').textContent = weighted
      ? 'Specified Weight chooses responses proportionally. Example: weights 1, 2, and 7 are approximately 10%, 20%, and 70%.'
      : 'Equal Odds randomly chooses between all responses.';
    responsesEl.querySelectorAll('.timer-weight-row').forEach((el) => { el.hidden = !weighted; });
  }

  function clearEditor() {
    editingId = null;
    $('timerEditorTitle').textContent = 'Add Timer';
    $('timerName').value = '';
    $('timerInterval').value = '300';
    $('timerResponseMode').value = 'equal';
    $('timerEnabled').checked = true;
    responsesEl.innerHTML = '';
    makeResponseRow();
    setEditorMessage('');
    setResponseMessage('');
    syncResponseMode();
  }

  function openEditor(timer = null) {
    clearEditor();
    if (timer) {
      editingId = timer.id;
      $('timerEditorTitle').textContent = 'Edit Timer';
      $('timerName').value = timer.name || '';
      $('timerInterval').value = String(timer.intervalSeconds || 300);
      $('timerResponseMode').value = timer.responseMode === 'weighted' ? 'weighted' : 'equal';
      $('timerEnabled').checked = timer.enabled !== false;
      responsesEl.innerHTML = '';
      const responses = Array.isArray(timer.responses) && timer.responses.length ? timer.responses : [''];
      responses.forEach((response, index) => makeResponseRow(response, timer.responseWeights?.[index] ?? 1));
      syncResponseMode();
    }
    editorEl.classList.add('open');
    editorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeEditor() {
    editorEl.classList.remove('open');
    clearEditor();
  }

  function collectResponses() {
    return [...responsesEl.querySelectorAll('.timer-response-row')].map((row) => ({
      response: row.querySelector('.timer-response-input').value.trim(),
      weight: Number(row.querySelector('.timer-response-weight').value)
    }));
  }

  async function saveTimer() {
    setEditorMessage('');
    setResponseMessage('');

    const name = $('timerName').value.trim();
    if (!name) return setEditorMessage('Timer Name is required.', true);
    if (name.length > maxTimerNameLength) return setEditorMessage(`Timer Name can contain at most ${maxTimerNameLength} characters.`, true);

    const intervalSeconds = Number($('timerInterval').value);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds < minIntervalSeconds || intervalSeconds > maxIntervalSeconds) {
      return setEditorMessage(`Interval must be between ${minIntervalSeconds} and ${maxIntervalSeconds} seconds.`, true);
    }

    const rows = collectResponses();
    const nonblank = rows.filter((row) => row.response);
    if (!nonblank.length) return setResponseMessage('Add at least one response.', true);
    if (nonblank.length > maxResponses) return setResponseMessage(`A timer can have at most ${maxResponses} responses.`, true);
    if (nonblank.some((row) => Array.from(row.response).length > maxResponseLength)) return setResponseMessage(`Each response can contain at most ${maxResponseLength} characters.`, true);

    const responseMode = $('timerResponseMode').value === 'weighted' ? 'weighted' : 'equal';
    if (responseMode === 'weighted' && nonblank.some((row) => !Number.isFinite(row.weight) || row.weight <= 0)) {
      return setResponseMessage('Every Specified Weight value must be greater than 0.', true);
    }

    $('saveTimerBtn').disabled = true;
    try {
      const d = await postJson('/timers/save', {
        id: editingId,
        name,
        intervalSeconds,
        responses: nonblank.map((row) => row.response),
        responseMode,
        responseWeights: nonblank.map((row) => responseMode === 'weighted' ? row.weight : 1),
        enabled: $('timerEnabled').checked
      });
      if (!d.success) throw new Error(d.error || 'Could not save timer.');
      closeEditor();
      await loadTimers();
      setMessage(`Saved ${d.timer?.name || 'timer'}.`);
    } catch (err) {
      setEditorMessage(err.message || 'Could not save timer.', true);
    } finally {
      $('saveTimerBtn').disabled = false;
    }
  }

  async function toggleTimer(timer) {
    try {
      const d = await postJson('/timers/toggle', { id: timer.id, enabled: !timer.enabled });
      if (!d.success) throw new Error(d.error || 'Could not update timer.');
      await loadTimers();
    } catch (err) {
      setMessage(err.message || 'Could not update timer.', true);
    }
  }

  async function deleteTimer(timer) {
    if (!confirm(`Delete timer "${timer.name}"?`)) return;
    try {
      const d = await postJson('/timers/delete', { id: timer.id });
      if (!d.success) throw new Error(d.error || 'Could not delete timer.');
      if (editingId === timer.id) closeEditor();
      await loadTimers();
    } catch (err) {
      setMessage(err.message || 'Could not delete timer.', true);
    }
  }

  const sortSelect = $('timerSort');
  if (sortSelect) {
    try {
      const savedSort = localStorage.getItem(SORT_STORAGE_KEY);
      if (VALID_SORTS.has(savedSort)) sortSelect.value = savedSort;
    } catch {}
    sortSelect.onchange = () => {
      try { localStorage.setItem(SORT_STORAGE_KEY, selectedSort()); } catch {}
      renderList();
    };
  }

  $('addTimerBtn').onclick = () => openEditor();
  $('refreshTimersBtn').onclick = loadTimers;
  $('addTimerResponseBtn').onclick = () => {
    if (responsesEl.querySelectorAll('.timer-response-row').length >= maxResponses) return setResponseMessage(`A timer can have at most ${maxResponses} responses.`, true);
    setResponseMessage('');
    makeResponseRow();
  };
  $('timerResponseMode').onchange = syncResponseMode;
  $('saveTimerBtn').onclick = saveTimer;
  $('cancelTimerBtn').onclick = closeEditor;
  $('showTimerVariablesBtn').onclick = () => $('timerVariablesDialog').showModal();
  $('closeTimerVariablesBtn').onclick = () => $('timerVariablesDialog').close();
  $('timerVariablesDialog').addEventListener('click', (event) => { if (event.target === $('timerVariablesDialog')) $('timerVariablesDialog').close(); });

  clearEditor();
  editorEl.classList.remove('open');

  return {
    loadTimers,
    onVisibilityChange(visible) {
      if (visible && !loaded) void loadTimers();
    }
  };
}
