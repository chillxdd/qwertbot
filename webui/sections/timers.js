// One editor and one API contract for both platforms. Only native provider
// capabilities (message limit / Twitch announcements) differ.
export function initTimersSection({ $: find, esc, postJson, config = {}, advancedFilters = null, platform = 'twitch' }) {
  const youtube = platform === 'youtube';
  const maxLength = youtube ? 200 : Number(config.maxResponseLength || 500);
  const prefix = youtube ? '/youtube/timers' : '/timers';
  const id = (name) => youtube ? `youtube${name[0].toUpperCase()}${name.slice(1)}` : name;
  const $ = (name) => find(id(name));
  const root = find(youtube ? 'youtubeTimersView' : 'timersView');
  const numberField = (name, label, value, min, max, placeholder = '') => `<label>${label}<div class="duration-field"><input id="${id(name)}" type="number" min="${min}" max="${max}" step="1" value="${value}" placeholder="${placeholder}"><span class="duration-unit">seconds</span></div></label>`;
  root.innerHTML = `
    <div class="custom-command-header"><h3>Timers</h3><div class="custom-command-list-controls">
      <input id="${id('timerSearch')}" class="list-search-input" type="search" placeholder="Search timers or responses..." aria-label="Search timers">
      <select id="${id('timerSort')}" aria-label="Sort timers"><option value="created_asc">Oldest first</option><option value="created_desc">Newest first</option><option value="name_asc">Name A-Z</option><option value="name_desc">Name Z-A</option><option value="interval_asc">Shortest interval</option><option value="interval_desc">Longest interval</option></select>
      <button id="${id('refreshTimersBtn')}" class="secondary" type="button">Refresh</button></div></div>
    <div class="detail timer-rotation-intro">Each timer rotates through its own responses, one message per interval. Separate timers keep independent clocks; combine routine reminders in one timer for a smoother cadence.</div>
    <div class="custom-editor-block timer-global-settings"><div class="custom-response-heading"><strong>Global Timer Settings</strong><button id="${id('saveTimerSettingsBtn')}" class="secondary" type="button">Save Settings</button></div>
      <div class="timer-settings-grid">${numberField('timerGlobalStartDelay', 'Global Start Delay', 0, 0, 86400)}${numberField('timerMinimumSpacing', 'Minimum timer-message spacing', 60, 0, 3600)}</div>
      <div class="detail">Applies only to ${youtube ? 'YouTube' : 'Twitch'}. Start Delay gates the first response. Spacing is an additional minimum gap between any timer messages on this platform (0 = off). It can delay a response when greater than its interval.</div>
      <div id="${id('timerSettingsMsg')}" class="detail" aria-live="polite"></div></div>
    ${youtube ? '<div class="detail">YouTube responses use the existing shared stream title/category context. With chat listening off, set Min Messages to 0. No chat listener is enabled by a timer.</div>' : ''}
    <div id="${id('timersMsg')}" class="detail" aria-live="polite"></div><div id="${id('timerList')}" class="custom-command-list"></div>
    <div id="${id('timerPagination')}" class="list-pagination"><label>Show <select id="${id('timerPageSize')}" aria-label="Timers per page"><option>10</option><option>25</option><option>50</option></select></label><span id="${id('timerPageLabel')}"></span><div class="list-page-buttons"><button id="${id('timerPrevPage')}" class="secondary" type="button" aria-label="Previous page">&larr;</button><button id="${id('timerNextPage')}" class="secondary" type="button" aria-label="Next page">&rarr;</button></div></div>
    <div class="custom-command-add-row"><button id="${id('addTimerBtn')}" type="button">Add Timer</button></div>
    <dialog id="${id('timerEditor')}" class="custom-command-editor entity-editor-dialog">
      <div class="custom-editor-header"><h3 id="${id('timerEditorTitle')}">Add Timer</h3><div class="custom-editor-header-actions"><label class="inline-check"><input id="${id('timerEnabled')}" type="checkbox" checked> Enabled</label><button id="${id('closeTimerEditorBtn')}" class="secondary" type="button">Close</button></div></div>
      <div class="custom-editor-block"><label class="prompt-label" for="${id('timerName')}">Timer Name</label><input id="${id('timerName')}" maxlength="80" placeholder="Example: Stream reminders"></div>
      <div class="custom-editor-block"><strong class="custom-block-title">Schedule</strong><div class="timer-settings-grid">
        ${numberField('timerInterval', 'Wait between responses', 600, 30, 86400)}${numberField('timerStartDelay', 'Start Delay (optional override)', '', 0, 86400, 'Use global')}${numberField('timerJitter', 'Optional jitter (+/-)', 0, 0, 86400)}
        <label>Priority<select id="${id('timerPriority')}"><option value="high">High</option><option value="normal" selected>Normal</option><option value="low">Low</option></select></label>
      </div><div class="detail">First eligible response: after Start Delay, with no jitter. Then one response per interval after successful delivery. Jitter 0 keeps an exact interval; optional jitter only varies recurring waits. Per-timer Start Delay cannot be below global.</div></div>
      <div class="custom-editor-block"><strong class="custom-block-title">Activity</strong><div class="timer-settings-grid">
        <label>Min Messages (0 = off)<input id="${id('timerMinimumMessages')}" type="number" min="0" max="100000" value="0"></label><label>Min Viewers (0 = off)<input id="${id('timerMinimumViewers')}" type="number" min="0" max="1000000" value="0"></label>
      </div><div class="detail">Activity is checked before every response, not just the first. Chat messages count since this timer's previous send.</div></div>
      <div class="custom-editor-block"><div class="custom-response-heading"><strong>Responses - in order</strong><span id="${id('timerResponseTotal')}" class="detail"></span></div>
        <div class="detail">Use the arrows to reorder. Disabled or nonmatching responses are skipped. One eligible response repeats each interval; zero eligible responses means silence. Filters are managed in General Settings &rarr; Advanced Filters.</div>
        <div id="${id('timerResponses')}"></div><div class="custom-response-bottom-actions"><button id="${id('showTimerVariablesBtn')}" class="secondary" type="button">Variables</button><button id="${id('addTimerResponseBtn')}" class="secondary" type="button">Add Response</button></div>
      </div>
      <div class="custom-editor-actions"><button id="${id('saveTimerBtn')}" type="button">Save Timer</button><button id="${id('cancelTimerBtn')}" class="secondary" type="button">Cancel</button></div><div id="${id('timerEditorMsg')}" class="detail" aria-live="polite"></div>
    </dialog>
    <dialog id="${id('timerPreviewDialog')}" class="custom-variables-dialog"><div class="custom-dialog-header"><h3>Next Response Preview</h3><button id="${id('closeTimerPreviewBtn')}" class="secondary" type="button">Close</button></div><div id="${id('timerPreviewBody')}" class="timer-preview-text"></div></dialog>
    <dialog id="${id('timerVariablesDialog')}" class="custom-variables-dialog"><div class="custom-dialog-header"><h3>Timer Variables</h3><button id="${id('closeTimerVariablesBtn')}" class="secondary" type="button">Close</button></div><p><code>$(random MIN MAX [DEC])</code> generates a random number. Optional DEC is 0-5 decimal places.</p>${youtube ? '' : '<p><code>$(randomuser)</code> uses an eligible current Twitch chatter.</p>'}<p>Timer responses have no triggering viewer, query or counter. ${maxLength} characters maximum per response.</p></dialog>`;

  const editor = $('timerEditor');
  const rowsEl = $('timerResponses');
  let timers = [], settings = { globalStartDelaySeconds: 0, minimumSpacingSeconds: 60 }, editingId = null, page = 1, loading = false, visible = false, poll = null;
  const storage = `qwertbot.${platform}.rotation-timers`;
  const filters = () => advancedFilters?.getFilters?.() || [];
  const msg = (name, text = '', bad = false) => { $(name).textContent = text; $(name).classList.toggle('bad', bad); };
  const fmt = (seconds) => Number(seconds) % 60 === 0 ? `${Number(seconds) / 60}m` : `${Number(seconds)}s`;
  const date = (value) => value ? new Date(value).toLocaleString() : 'Not scheduled';
  const open = (dialog) => { dialog.classList.add('open'); if (!dialog.open) dialog.showModal(); };
  const close = (dialog) => { dialog.classList.remove('open'); if (dialog.open) dialog.close(); };
  const integer = (name, min, max) => {
    const n = Number($(name).value);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${$(name).closest('label')?.childNodes[0]?.textContent?.trim() || name} must be a whole number from ${min} to ${max}.`);
    return n;
  };
  async function call(action, body = {}) { const d = await postJson(`${prefix}/${action}`, body); if (!d.success) throw new Error(d.error || 'Timer request failed.'); return d; }

  function fillFilterOptions(select, value) {
    select.replaceChildren(new Option('Choose filter...', ''));
    for (const f of filters()) select.appendChild(new Option(f.name, f.id));
    if (value && !filters().some((f) => f.id === value)) select.appendChild(new Option('Missing filter - select another', value));
    select.value = value || '';
  }
  function updateRows() {
    const rows = [...rowsEl.children];
    rows.forEach((row, index) => {
      row.querySelector('.timer-response-label').textContent = `Response ${index + 1}`;
      row.querySelector('.timer-response-up').disabled = index === 0;
      row.querySelector('.timer-response-down').disabled = index === rows.length - 1;
      const input = row.querySelector('textarea');
      row.querySelector('.timer-response-count').textContent = `${Array.from(input.value).length}/${maxLength}`;
      row.querySelector('.timer-filter-select-wrap').hidden = !row.querySelector('.timer-response-use-filter').checked;
      const chosen = filters().find((f) => f.id === row.querySelector('.timer-response-filter').value);
      const use = row.querySelector('.timer-response-use-filter').checked;
      row.querySelector('.timer-response-filter-detail').textContent = !use ? 'No filter' : chosen ? `${chosen.name}: ${chosen.currentMatch ? 'MATCH' : 'WAITING'} - ${chosen.summary || ''}` : 'Select a saved Advanced Filter.';
      row.querySelector('.timer-action-color-wrap').hidden = row.querySelector('.timer-action-type').value !== 'twitch_announcement';
    });
    $('timerResponseTotal').textContent = `${rows.length}/25`;
    $('addTimerResponseBtn').disabled = rows.length >= 25;
  }
  function addRow(response = {}) {
    if (rowsEl.children.length >= 25) return;
    const row = document.createElement('div'); row.className = 'custom-response-row timer-response-row';
    row.dataset.responseId = response.id || globalThis.crypto?.randomUUID?.() || `r-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    row.innerHTML = `<div class="custom-response-heading"><strong class="timer-response-label"></strong><label class="inline-check"><input class="timer-response-enabled" type="checkbox" checked> Enabled</label></div>
      <div class="timer-settings-grid"><label>Action<select class="timer-action-type"><option value="chat_message">Chat Message</option>${youtube ? '' : '<option value="twitch_announcement">Twitch Announcement</option>'}</select></label><label class="timer-action-color-wrap" hidden>Announcement Color<select class="timer-action-color"><option>primary</option><option>purple</option><option>blue</option><option>green</option><option>orange</option></select></label></div>
      <label class="prompt-label">Message<textarea class="custom-response-input timer-response-input" maxlength="${maxLength}" placeholder="Message to send at this step"></textarea></label>
      <label class="inline-check timer-use-filter-check"><input class="timer-response-use-filter" type="checkbox"> Use filter</label><div class="timer-filter-select-wrap" hidden><select class="timer-response-filter" aria-label="Response Advanced Filter"></select></div><div class="detail timer-response-filter-detail"></div>
      <div class="custom-response-footer"><span class="detail timer-response-count"></span><div class="timer-response-order"><button class="secondary timer-response-up" type="button" aria-label="Move response up">&uarr;</button><button class="secondary timer-response-down" type="button" aria-label="Move response down">&darr;</button><button class="secondary timer-response-remove" type="button">Remove</button></div></div>`;
    row.querySelector('textarea').value = response.text || '';
    row.querySelector('.timer-response-enabled').checked = response.enabled !== false;
    row.querySelector('.timer-response-use-filter').checked = Boolean(response.filterId);
    fillFilterOptions(row.querySelector('.timer-response-filter'), response.filterId);
    row.querySelector('.timer-action-type').value = response.actionType || 'chat_message';
    row.querySelector('.timer-action-color').value = response.actionColor || 'primary';
    row.addEventListener('input', updateRows); row.addEventListener('change', updateRows);
    row.querySelector('.timer-response-remove').onclick = () => { row.remove(); updateRows(); };
    row.querySelector('.timer-response-up').onclick = () => { if (row.previousElementSibling) rowsEl.insertBefore(row, row.previousElementSibling); updateRows(); };
    row.querySelector('.timer-response-down').onclick = () => { if (row.nextElementSibling) rowsEl.insertBefore(row.nextElementSibling, row); updateRows(); };
    rowsEl.appendChild(row); updateRows();
  }
  async function openEditor(item = null) {
    try {
      await advancedFilters?.ensureLoaded?.();
      editingId = item?.id || item?._id || null;
      $('timerEditorTitle').textContent = item ? 'Edit Timer' : 'Add Timer';
      $('timerName').value = item?.name || '';
      $('timerEnabled').checked = item?.enabled !== false;
      $('timerInterval').value = item?.intervalSeconds ?? 600;
      $('timerStartDelay').value = item?.startDelaySeconds ?? '';
      $('timerStartDelay').min = settings.globalStartDelaySeconds;
      $('timerJitter').value = item?.jitterSeconds ?? 0;
      $('timerPriority').value = item?.priority || 'normal';
      $('timerMinimumMessages').value = item?.minimumChatMessages ?? 0;
      $('timerMinimumViewers').value = item?.minimumViewers ?? 0;
      rowsEl.replaceChildren();
      (item?.responses?.length ? item.responses : ['']).forEach((text, index) => addRow({ text,
        id: item?.responseIds?.[index], enabled: item?.responseEnabled?.[index] !== false,
        filterId: item?.responseFilterIds?.[index] ?? item?.advancedFilterId ?? '',
        actionType: item?.actionTypes?.[index] || 'chat_message', actionColor: item?.actionColors?.[index] || 'primary' }));
      msg('timerEditorMsg'); open(editor); $('timerName').focus();
    } catch (err) { msg('timersMsg', err.message, true); }
  }
  async function saveTimer() {
    msg('timerEditorMsg');
    try {
      const name = $('timerName').value.trim();
      if (!name || name.length > 80) throw new Error('Timer Name needs 1-80 characters.');
      const responses = [...rowsEl.children].map((row) => {
        const text = row.querySelector('textarea').value.trim();
        if (!text || Array.from(text).length > maxLength) throw new Error(`Every response needs 1-${maxLength} characters. Remove blank rows.`);
        const use = row.querySelector('.timer-response-use-filter').checked;
        const filterId = use ? row.querySelector('.timer-response-filter').value : '';
        if (use && !filters().some((f) => f.id === filterId)) throw new Error('Each enabled Use filter setting needs an existing filter.');
        return { text, filterId, id: row.dataset.responseId, enabled: row.querySelector('.timer-response-enabled').checked,
          actionType: row.querySelector('.timer-action-type').value, actionColor: row.querySelector('.timer-action-color').value };
      });
      if (!responses.length) throw new Error('Add at least one response.');
      const payload = { id: editingId, name, enabled: $('timerEnabled').checked,
        intervalSeconds: integer('timerInterval', 30, 86400), startDelaySeconds: $('timerStartDelay').value.trim() === '' ? null : integer('timerStartDelay', settings.globalStartDelaySeconds, 86400),
        jitterSeconds: integer('timerJitter', 0, 86400), priority: $('timerPriority').value,
        minimumChatMessages: integer('timerMinimumMessages', 0, 100000), minimumViewers: integer('timerMinimumViewers', 0, 1000000),
        responseMode: 'sequential', advancedFilterId: '', responses: responses.map((r) => r.text),
        responseIds: responses.map((r) => r.id), responseEnabled: responses.map((r) => r.enabled), responseFilterIds: responses.map((r) => r.filterId),
        actionTypes: responses.map((r) => r.actionType), actionColors: responses.map((r) => r.actionColor) };
      $('saveTimerBtn').disabled = true; await call('save', payload); close(editor); await loadTimers(); msg('timersMsg', `Saved ${name}.`);
    } catch (err) { msg('timerEditorMsg', err.message, true); }
    finally { $('saveTimerBtn').disabled = false; }
  }
  function renderList() {
    const search = $('timerSearch').value.toLowerCase();
    const items = timers.filter((t) => [t.name, ...(t.responses || []), ...(t.responseStates || []).map((r) => r.filterName)].join(' ').toLowerCase().includes(search));
    const sort = $('timerSort').value;
    items.sort((a, b) => { const field = sort.startsWith('name') ? 'name' : sort.startsWith('interval') ? 'intervalSeconds' : 'createdAt';
      const diff = field === 'name' ? a.name.localeCompare(b.name) : field === 'createdAt' ? new Date(a[field] || 0) - new Date(b[field] || 0) : a[field] - b[field];
      return sort.endsWith('desc') ? -diff : diff; });
    const size = Number($('timerPageSize').value); const pages = Math.max(1, Math.ceil(items.length / size)); page = Math.min(page, pages);
    $('timerPageLabel').textContent = `Page ${page} of ${pages}`; $('timerPrevPage').disabled = page <= 1; $('timerNextPage').disabled = page >= pages;
    $('timerPagination').hidden = !timers.length;
    $('timerList').replaceChildren();
    if (!items.length) $('timerList').innerHTML = '<div class="detail custom-empty-state">No matching timers.</div>';
    for (const item of items.slice((page - 1) * size, page * size)) {
      const card = document.createElement('div'); card.className = 'custom-command-card timer-card';
      const next = Number(item.nextResponseIndex ?? -1);
      const filterRows = (item.responseStates || []).map((r) => `<div class="detail">${r.index + 1}. ${esc(r.text)} &mdash; ${!r.enabled ? 'DISABLED' : !r.filterId ? 'No filter' : !r.filterExists ? 'Missing filter' : `${esc(r.filterName || 'Filter')}: ${r.filterMatched ? 'MATCH' : 'WAITING'}`}</div>`).join('');
      const history = [...(item.history || [])].reverse().slice(0, 10).map((h) => `<div class="detail">${esc(date(h.firedAt))} &middot; Response ${Number(h.responseIndex) + 1} &middot; ${esc(h.reason)}</div>`).join('');
      card.innerHTML = `<div class="custom-command-card-main"><div class="custom-command-title-row"><strong class="custom-command-name">${esc(item.name)}</strong><span class="custom-command-state ${item.enabled ? 'enabled' : 'disabled'}">${item.enabled ? 'Enabled' : 'Disabled'}</span></div>
        <div class="detail">One response every ${fmt(item.intervalSeconds)}${item.jitterSeconds ? ` +/- ${fmt(item.jitterSeconds)}` : ''} &middot; In order &middot; ${esc(item.priority || 'normal')} priority</div>
        <div class="detail">${Number(item.eligibleResponseCount || 0)}/${item.responses.length} responses eligible &middot; Next: ${next >= 0 ? `#${next + 1}` : 'None'} &middot; Start delay ${fmt(item.effectiveStartDelaySeconds || 0)}</div>
        <div class="detail">Next eligible time: ${esc(date(item.nextRetryAt || item.nextDueAt))}${item.waitingFor ? ` &middot; Waiting: ${esc(item.waitingFor)}` : ''}</div>
        <div class="detail">Messages: ${Number(item.messagesSinceLastFire || 0)}/${Number(item.minimumChatMessages || 0)} &middot; Viewers: ${item.currentViewerCount ?? '?'} / ${Number(item.minimumViewers || 0)} &middot; Sent: ${Number(item.timesFired || 0)}</div>
        <details class="timer-history"><summary>Responses and filters</summary>${filterRows}</details><details class="timer-history"><summary>Recent fire history</summary>${history || '<div class="detail">No sends yet.</div>'}</details></div>
        <div class="custom-command-actions timer-card-actions">${['Preview', 'Test', 'Fire Now', 'Edit', item.enabled ? 'Disable' : 'Enable', 'Delete'].map((label, index) => `<button class="${index === 5 ? 'danger' : 'secondary'}" type="button" data-action="${index}">${label}</button>`).join('')}</div>`;
      for (const button of card.querySelectorAll('[data-action]')) button.onclick = async () => {
        const action = Number(button.dataset.action); if (action === 3) return openEditor(item);
        if (action === 1 && !confirm(`Send one TEST response from "${item.name}"? Uses current response filters, but does not advance its rotation or interval.`)) return;
        if (action === 2 && !confirm(`Fire one eligible response from "${item.name}" now? Bypasses timing/activity waits, advances rotation and resets its interval.`)) return;
        if (action === 5 && !confirm(`Delete timer "${item.name}" and its responses?`)) return;
        card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try {
          const d = await call(['preview', 'test', 'fire-now', '', 'toggle', 'delete'][action], { id: item.id || item._id, enabled: !item.enabled });
          if (action === 0) { $('timerPreviewBody').textContent = `Response ${Number(d.preview.responseIndex) + 1}: ${d.preview.rendered}`; open($('timerPreviewDialog')); }
          else { await loadTimers(); msg('timersMsg', action === 1 ? 'Test sent. Rotation, counters and schedule unchanged.' : 'Timer updated.'); }
        } catch (err) { msg('timersMsg', err.message, true); }
        finally { card.querySelectorAll('button').forEach((b) => { b.disabled = false; }); }
      };
      $('timerList').appendChild(card);
    }
  }
  async function loadTimers({ quiet = false } = {}) {
    if (loading) return;
    loading = true;
    try {
      const d = await call('list'); timers = d.timers || []; settings = { ...settings, ...d.settings };
      if (!quiet) { $('timerGlobalStartDelay').value = settings.globalStartDelaySeconds; $('timerMinimumSpacing').value = settings.minimumSpacingSeconds; }
      renderList(); if (!quiet) msg('timersMsg', `${timers.length} timer(s).`);
    } catch (err) { msg('timersMsg', err.message, true); } finally { loading = false; }
  }
  $('saveTimerSettingsBtn').onclick = async () => {
    $('saveTimerSettingsBtn').disabled = true;
    try { await call('settings', { globalStartDelaySeconds: integer('timerGlobalStartDelay', 0, 86400), minimumSpacingSeconds: integer('timerMinimumSpacing', 0, 3600) }); await loadTimers(); msg('timerSettingsMsg', 'Settings saved.'); }
    catch (err) { msg('timerSettingsMsg', err.message, true); } finally { $('saveTimerSettingsBtn').disabled = false; }
  };
  $('saveTimerBtn').onclick = saveTimer;
  $('addTimerBtn').onclick = () => openEditor(); $('addTimerResponseBtn').onclick = () => addRow();
  $('closeTimerEditorBtn').onclick = $('cancelTimerBtn').onclick = () => close(editor);
  $('refreshTimersBtn').onclick = () => loadTimers();
  $('showTimerVariablesBtn').onclick = () => open($('timerVariablesDialog'));
  for (const name of ['Preview', 'Variables']) $('closeTimer' + name + 'Btn').onclick = () => close($('timer' + name + 'Dialog'));
  for (const dialog of root.querySelectorAll('dialog')) {
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(dialog); });
    dialog.addEventListener('click', (event) => { if (event.target === dialog) close(dialog); });
  }
  $('timerSearch').oninput = () => { page = 1; renderList(); };
  for (const name of ['timerSort', 'timerPageSize']) {
    try { const stored = localStorage.getItem(storage + name); if ([...$(name).options].some((o) => o.value === stored)) $(name).value = stored; } catch (_) {}
    $(name).onchange = () => { page = 1; try { localStorage.setItem(storage + name, $(name).value); } catch (_) {} renderList(); };
  }
  $('timerPrevPage').onclick = () => { page = Math.max(1, page - 1); renderList(); }; $('timerNextPage').onclick = () => { page++; renderList(); };
  advancedFilters?.subscribe?.(() => { for (const select of rowsEl.querySelectorAll('select.timer-response-filter')) fillFilterOptions(select, select.value); updateRows(); if (visible) void loadTimers({ quiet: true }); });
  return { loadTimers, onVisibilityChange(show) {
    visible = Boolean(show); if (poll) clearInterval(poll); poll = null;
    if (!visible) { for (const dialog of root.querySelectorAll('dialog')) close(dialog); return; }
    void loadTimers(); void advancedFilters?.ensureLoaded?.();
    poll = setInterval(() => { if (!editor.open) void loadTimers({ quiet: true }); }, 15000);
  } };
}
