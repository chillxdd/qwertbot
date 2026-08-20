export function initTimersSection({ $, esc, postJson, config = {} }) {
  const maxTimerNameLength = Number(config.maxTimerNameLength || 80);
  const minIntervalSeconds = Number(config.minIntervalSeconds || 30);
  const maxIntervalSeconds = Number(config.maxIntervalSeconds || 86400);
  const maxResponses = Number(config.maxResponses || 25);
  const maxResponseLength = Number(config.maxResponseLength || 500);
  const maxStartDelaySeconds = Number(config.maxStartDelaySeconds || 86400);
  const maxJitterSeconds = Number(config.maxJitterSeconds || 86400);
  const maxMinimumChatMessages = Number(config.maxMinimumChatMessages || 100000);
  const maxMinimumViewers = Number(config.maxMinimumViewers || 1000000);
  const maxGlobalSpacingSeconds = Number(config.maxGlobalSpacingSeconds || 3600);

  let timers = [];
  let settings = { globalStartDelaySeconds: 0, minimumSpacingSeconds: 60 };
  let editingId = null;
  let loaded = false;

  const SORT_STORAGE_KEY = 'sqwert-timer-sort';
  const VALID_SORTS = new Set(['created_asc', 'created_desc', 'name_asc', 'name_desc', 'interval_asc', 'interval_desc']);

  const listEl = $('timerList');
  const editorEl = $('timerEditor');
  const responsesEl = $('timerResponses');
  const msgEl = $('timersMsg');
  const settingsMsgEl = $('timerSettingsMsg');
  const editorMsgEl = $('timerEditorMsg');
  const scheduleMsgEl = $('timerScheduleMsg');
  const activityMsgEl = $('timerActivityMsg');
  const responseMsgEl = $('timerResponseMsg');

  function setMessage(el, text, isError = false) {
    el.textContent = text || '';
    el.classList.toggle('bad', Boolean(isError));
  }

  const setListMessage = (text, isError = false) => setMessage(msgEl, text, isError);
  const setSettingsMessage = (text, isError = false) => setMessage(settingsMsgEl, text, isError);
  const setEditorMessage = (text, isError = false) => setMessage(editorMsgEl, text, isError);
  const setScheduleMessage = (text, isError = false) => setMessage(scheduleMsgEl, text, isError);
  const setActivityMessage = (text, isError = false) => setMessage(activityMsgEl, text, isError);
  const setResponseMessage = (text, isError = false) => setMessage(responseMsgEl, text, isError);

  function formatInterval(seconds) {
    const total = Math.max(0, Number(seconds || 0));
    if (total >= 3600 && total % 3600 === 0) return `${total / 3600}h`;
    if (total >= 60 && total % 60 === 0) return `${total / 60}m`;
    return `${total}s`;
  }

  function formatDate(value) {
    if (!value) return 'Never';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
  }

  function modeLabel(mode) { return mode === 'weighted' ? 'Specified Weight' : 'Equal Odds'; }
  function priorityLabel(value) { return value === 'high' ? 'High' : value === 'low' ? 'Low' : 'Normal'; }

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

  function renderHistory(timer) {
    const history = Array.isArray(timer.history) ? [...timer.history].reverse() : [];
    if (!history.length) return '<div class="detail">No successful fires recorded yet.</div>';
    return history.slice(0, 10).map((entry) => {
      const responseNumber = Number(entry.responseIndex) >= 0 ? `response #${Number(entry.responseIndex) + 1}` : 'response';
      const reason = entry.reason === 'manual' ? 'manual Fire Now' : 'scheduled';
      return `<div class="detail">${esc(formatDate(entry.firedAt))} — ${esc(responseNumber)} · ${esc(reason)}</div>`;
    }).join('');
  }

  function renderList() {
    listEl.innerHTML = '';
    if (!timers.length) {
      listEl.innerHTML = '<div class="custom-empty-state detail">No timers yet.</div>';
      return;
    }

    for (const timer of sortedTimers()) {
      const card = document.createElement('div');
      card.className = 'custom-command-card timer-card';
      const responseCount = Array.isArray(timer.responses) ? timer.responses.length : 0;
      const jitter = Number(timer.jitterSeconds || 0) > 0 ? ` · ±${esc(formatInterval(timer.jitterSeconds))} jitter` : '';
      const activity = [];
      if (Number(timer.minimumChatMessages || 0) > 0) activity.push(`${timer.messagesSinceLastFire || 0}/${timer.minimumChatMessages} chat messages`);
      if (Number(timer.minimumViewers || 0) > 0) activity.push(`${timer.currentViewerCount || 0}/${timer.minimumViewers} viewers`);
      const activityText = activity.length ? activity.join(' · ') : 'No activity minimums';
      const overrideText = timer.startDelaySeconds === null ? `Global start delay (${formatInterval(timer.effectiveStartDelaySeconds || 0)})` : `Start delay ${formatInterval(timer.startDelaySeconds)}`;
      const nextLabel = timer.nextRetryAt ? 'Next retry' : 'Next eligible time';
      const waiting = timer.waitingFor ? ` · Waiting for: ${timer.waitingFor}` : '';

      card.innerHTML = `
        <div class="custom-command-card-main">
          <div class="custom-command-title-row">
            <strong class="custom-command-name">${esc(timer.name || 'Timer')}</strong>
            <span class="custom-command-state ${timer.enabled ? 'enabled' : 'disabled'}">${timer.enabled ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div class="detail">Every ${esc(formatInterval(timer.intervalSeconds))}${jitter} · ${esc(priorityLabel(timer.priority))} priority · ${responseCount} response${responseCount === 1 ? '' : 's'} · ${esc(modeLabel(timer.responseMode))}</div>
          <div class="detail">${esc(overrideText)} · ${esc(activityText)}</div>
          <div class="detail">Last fired: ${esc(formatDate(timer.lastFiredAt))} · ${esc(nextLabel)}: ${esc(formatDate(timer.nextRetryAt || timer.nextDueAt))}${esc(waiting)}</div>
          <div class="detail">Times fired: ${Number(timer.timesFired || 0)}${timer.lastResponse ? ` · Last response: ${esc(timer.lastResponse)}` : ''}</div>
          <details class="timer-history"><summary>Recent fire history</summary>${renderHistory(timer)}</details>
        </div>
        <div class="custom-command-actions timer-card-actions">
          <button class="secondary timer-preview-btn" type="button">Preview</button>
          <button class="secondary timer-test-btn" type="button">Test</button>
          <button class="secondary timer-fire-btn" type="button">Fire Now</button>
          <button class="secondary timer-edit-btn" type="button">Edit</button>
          <button class="secondary timer-toggle-btn" type="button">${timer.enabled ? 'Disable' : 'Enable'}</button>
          <button class="danger timer-delete-btn" type="button">Delete</button>
        </div>`;

      card.querySelector('.timer-preview-btn').onclick = () => previewTimer(timer);
      card.querySelector('.timer-test-btn').onclick = () => testTimer(timer);
      card.querySelector('.timer-fire-btn').onclick = () => fireNow(timer);
      card.querySelector('.timer-edit-btn').onclick = () => openEditor(timer);
      card.querySelector('.timer-toggle-btn').onclick = () => toggleTimer(timer);
      card.querySelector('.timer-delete-btn').onclick = () => deleteTimer(timer);
      listEl.appendChild(card);
    }
  }

  function applySettingsToUi() {
    $('timerGlobalStartDelay').value = String(Number(settings.globalStartDelaySeconds || 0));
    $('timerGlobalSpacing').value = String(Number(settings.minimumSpacingSeconds ?? 60));
    $('timerStartDelay').min = String(Number(settings.globalStartDelaySeconds || 0));
  }

  async function loadTimers() {
    setListMessage('Loading timers...');
    try {
      const d = await postJson('/timers/list', {});
      if (!d.success) throw new Error(d.error || 'Could not load timers.');
      timers = Array.isArray(d.timers) ? d.timers : [];
      settings = { ...settings, ...(d.settings || {}) };
      loaded = true;
      applySettingsToUi();
      renderList();
      setListMessage(`${timers.length} timer${timers.length === 1 ? '' : 's'} loaded.`);
    } catch (err) {
      setListMessage(err.message || 'Could not load timers.', true);
    }
  }

  async function saveSettings() {
    setSettingsMessage('');
    const globalStartDelaySeconds = Number($('timerGlobalStartDelay').value);
    const minimumSpacingSeconds = Number($('timerGlobalSpacing').value);
    if (!Number.isInteger(globalStartDelaySeconds) || globalStartDelaySeconds < 0 || globalStartDelaySeconds > maxStartDelaySeconds) {
      return setSettingsMessage(`Global stream-start delay must be a whole number between 0 and ${maxStartDelaySeconds} seconds.`, true);
    }
    if (!Number.isInteger(minimumSpacingSeconds) || minimumSpacingSeconds < 0 || minimumSpacingSeconds > maxGlobalSpacingSeconds) {
      return setSettingsMessage(`Minimum timer spacing must be a whole number between 0 and ${maxGlobalSpacingSeconds} seconds.`, true);
    }
    $('saveTimerSettingsBtn').disabled = true;
    try {
      const d = await postJson('/timers/settings', { globalStartDelaySeconds, minimumSpacingSeconds });
      if (!d.success) throw new Error(d.error || 'Could not save timer settings.');
      settings = { ...settings, ...(d.settings || {}) };
      applySettingsToUi();
      setSettingsMessage('Timer settings saved.');
      await loadTimers();
    } catch (err) {
      setSettingsMessage(err.message || 'Could not save timer settings.', true);
    } finally {
      $('saveTimerSettingsBtn').disabled = false;
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
    row.querySelector('.timer-remove-response').onclick = () => { row.remove(); syncResponseMode(); };
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
    $('timerInterval').value = '900';
    $('timerStartDelay').value = '';
    $('timerJitter').value = '0';
    $('timerPriority').value = 'normal';
    $('timerMinimumMessages').value = '0';
    $('timerMinimumViewers').value = '0';
    $('timerResponseMode').value = 'equal';
    $('timerEnabled').checked = true;
    responsesEl.innerHTML = '';
    makeResponseRow();
    setEditorMessage('');
    setScheduleMessage('');
    setActivityMessage('');
    setResponseMessage('');
    syncResponseMode();
    applySettingsToUi();
  }

  function openEditor(timer = null) {
    clearEditor();
    if (timer) {
      editingId = timer.id;
      $('timerEditorTitle').textContent = 'Edit Timer';
      $('timerName').value = timer.name || '';
      $('timerInterval').value = String(timer.intervalSeconds || 900);
      $('timerStartDelay').value = timer.startDelaySeconds === null || timer.startDelaySeconds === undefined ? '' : String(timer.startDelaySeconds);
      $('timerJitter').value = String(timer.jitterSeconds || 0);
      $('timerPriority').value = ['high', 'normal', 'low'].includes(timer.priority) ? timer.priority : 'normal';
      $('timerMinimumMessages').value = String(timer.minimumChatMessages || 0);
      $('timerMinimumViewers').value = String(timer.minimumViewers || 0);
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
    setScheduleMessage('');
    setActivityMessage('');
    setResponseMessage('');

    const name = $('timerName').value.trim();
    if (!name) return setEditorMessage('Timer Name is required.', true);
    if (name.length > maxTimerNameLength) return setEditorMessage(`Timer Name can contain at most ${maxTimerNameLength} characters.`, true);

    const intervalSeconds = Number($('timerInterval').value);
    const startDelayRaw = $('timerStartDelay').value.trim();
    const startDelaySeconds = startDelayRaw === '' ? null : Number(startDelayRaw);
    const jitterSeconds = Number($('timerJitter').value);
    const priority = $('timerPriority').value;

    if (!Number.isFinite(intervalSeconds) || intervalSeconds < minIntervalSeconds || intervalSeconds > maxIntervalSeconds) {
      return setScheduleMessage(`Interval must be between ${minIntervalSeconds} and ${maxIntervalSeconds} seconds.`, true);
    }
    if (startDelaySeconds !== null && (!Number.isInteger(startDelaySeconds) || startDelaySeconds < Number(settings.globalStartDelaySeconds || 0) || startDelaySeconds > maxStartDelaySeconds)) {
      return setScheduleMessage(`Per-timer start delay must be blank or a whole number from the global delay (${settings.globalStartDelaySeconds || 0}s) through ${maxStartDelaySeconds}s.`, true);
    }
    if (!Number.isInteger(jitterSeconds) || jitterSeconds < 0 || jitterSeconds > maxJitterSeconds) {
      return setScheduleMessage(`Random timing variation must be a whole number between 0 and ${maxJitterSeconds} seconds.`, true);
    }

    const minimumChatMessages = Number($('timerMinimumMessages').value);
    const minimumViewers = Number($('timerMinimumViewers').value);
    if (!Number.isInteger(minimumChatMessages) || minimumChatMessages < 0 || minimumChatMessages > maxMinimumChatMessages) {
      return setActivityMessage(`Minimum chat messages must be a whole number between 0 and ${maxMinimumChatMessages}.`, true);
    }
    if (!Number.isInteger(minimumViewers) || minimumViewers < 0 || minimumViewers > maxMinimumViewers) {
      return setActivityMessage(`Minimum viewers must be a whole number between 0 and ${maxMinimumViewers}.`, true);
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
        startDelaySeconds,
        jitterSeconds,
        priority,
        minimumChatMessages,
        minimumViewers,
        responses: nonblank.map((row) => row.response),
        responseMode,
        responseWeights: nonblank.map((row) => responseMode === 'weighted' ? row.weight : 1),
        enabled: $('timerEnabled').checked
      });
      if (!d.success) throw new Error(d.error || 'Could not save timer.');
      closeEditor();
      await loadTimers();
      setListMessage(`Saved ${d.timer?.name || 'timer'}.`);
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
      setListMessage(err.message || 'Could not update timer.', true);
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
      setListMessage(err.message || 'Could not delete timer.', true);
    }
  }

  async function previewTimer(timer) {
    try {
      const d = await postJson('/timers/preview', { id: timer.id });
      if (!d.success) throw new Error(d.error || 'Could not preview timer.');
      $('timerPreviewBody').innerHTML = `<div><strong>${esc(timer.name)}</strong></div><div class="detail">Rendered response #${Number(d.preview?.responseIndex ?? 0) + 1}</div><div class="timer-preview-text">${esc(d.preview?.rendered || '')}</div>`;
      $('timerPreviewDialog').showModal();
    } catch (err) {
      setListMessage(err.message || 'Could not preview timer.', true);
    }
  }

  async function testTimer(timer) {
    if (!confirm(`Send one TEST message for "${timer.name}"? This will not change its schedule or fire history.`)) return;
    try {
      const d = await postJson('/timers/test', { id: timer.id });
      if (!d.success) throw new Error(d.error || 'Could not test timer.');
      setListMessage(`Test sent for ${timer.name}. Schedule and history were unchanged.`);
    } catch (err) {
      setListMessage(err.message || 'Could not test timer.', true);
    }
  }

  async function fireNow(timer) {
    if (!confirm(`Fire "${timer.name}" now? This counts as a real firing and resets its schedule/activity counter.`)) return;
    try {
      const d = await postJson('/timers/fire-now', { id: timer.id });
      if (!d.success) throw new Error(d.error || 'Could not fire timer.');
      await loadTimers();
      setListMessage(`Fired ${timer.name} and reset its schedule.`);
    } catch (err) {
      setListMessage(err.message || 'Could not fire timer.', true);
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

  $('saveTimerSettingsBtn').onclick = saveSettings;
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
  $('closeTimerPreviewBtn').onclick = () => $('timerPreviewDialog').close();
  $('timerPreviewDialog').addEventListener('click', (event) => { if (event.target === $('timerPreviewDialog')) $('timerPreviewDialog').close(); });

  clearEditor();
  editorEl.classList.remove('open');

  return {
    loadTimers,
    onVisibilityChange(visible) {
      if (visible) void loadTimers();
    }
  };
}
