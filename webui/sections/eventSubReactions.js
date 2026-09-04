export function initEventSubReactionsSection({ $, esc, postJson, config = {} }) {
  let reactions = [];
  let eventTypes = [];
  let limits = { maxActions: 12, maxHoldSeconds: 3600, maxActionDelaySeconds: 300 };
  let automationSpacingSeconds = 0;
  const maxPersistentPinMessageLength = Number(config.maxPersistentPinMessageLength || 500);
  const defaultPersistentPinHoldSeconds = Number(config.defaultPersistentPinHoldSeconds ?? 10);
  const maxPersistentPinHoldSeconds = Number(config.maxPersistentPinHoldSeconds || 3600);
  let persistentPin = { enabled: false, message: '', startupHoldSeconds: defaultPersistentPinHoldSeconds };
  let editingId = null;
  let page = 1;
  let loaded = false;
  const editor = $('eventReactionEditor');
  const persistentPinEditor = $('persistentPinEditor');
  const variablesDialog = $('eventReactionVariablesDialog');
  const actionsEl = $('eventReactionActions');
  const PAGE_SIZE_STORAGE_KEY = 'qwertbot.eventSubReactions.pageSize';
  const SORT_STORAGE_KEY = 'qwertbot.eventSubReactions.sort';
  const VALID_PAGE_SIZES = new Set([10, 25, 50]);

  function typeMeta(type) { return eventTypes.find((item) => item.type === type) || { type, label: type, threshold: null }; }
  function setMsg(text, bad = false) { const el=$('eventReactionsMsg'); el.textContent=text||''; el.classList.toggle('bad', bad); }
  function setEditorMsg(text, bad = false) { const el=$('eventReactionEditorMsg'); el.textContent=text||''; el.classList.toggle('bad', bad); }
  function updateHoldUi() {
    const holdEl = $('eventReactionHold');
    holdEl.max = String(limits.maxHoldSeconds);
    holdEl.placeholder = 'Use global Automation Spacing';
  }

  function validateHold() {
    const raw = $('eventReactionHold').value.trim();
    if (!raw) return '';
    const hold = Number(raw);
    const spacing = Math.max(0, Number(automationSpacingSeconds) || 0);
    if (!Number.isFinite(hold) || hold < 0 || hold > limits.maxHoldSeconds) {
      return `Post-Reaction Hold must be blank or between 0 and ${limits.maxHoldSeconds} seconds.`;
    }
    if (hold < spacing) {
      return `Automation Spacing is currently ${spacing} seconds. Leave Post-Reaction Hold blank to use global spacing, or enter ${spacing} seconds or more.`;
    }
    return '';
  }

  function setPersistentPinMsg(text, bad = false) {
    const el = $('persistentPinMsg');
    el.textContent = text || '';
    el.classList.toggle('bad', bad);
  }

  function applyPersistentPinToUi() {
    $('persistentPinEnabled').checked = persistentPin.enabled === true;
    $('persistentPinMessageInput').value = String(persistentPin.message || '');
    $('persistentPinMessageInput').maxLength = maxPersistentPinMessageLength;
    $('persistentPinStartupHold').value = String(Number(persistentPin.startupHoldSeconds ?? defaultPersistentPinHoldSeconds));
    $('persistentPinStartupHold').max = String(maxPersistentPinHoldSeconds);
  }

  function openPersistentPinEditor() {
    applyPersistentPinToUi();
    setPersistentPinMsg('');
    persistentPinEditor.classList.add('open');
    if (typeof persistentPinEditor.showModal === 'function' && !persistentPinEditor.open) persistentPinEditor.showModal();
    else persistentPinEditor.setAttribute('open', '');
    $('persistentPinMessageInput').focus();
  }

  function closePersistentPinEditor() {
    persistentPinEditor.classList.remove('open');
    if (persistentPinEditor.open && typeof persistentPinEditor.close === 'function') persistentPinEditor.close();
    else persistentPinEditor.removeAttribute('open');
    setPersistentPinMsg('');
  }

  async function savePersistentPinConfig(overrides = {}, { closeAfter = false } = {}) {
    const enabled = overrides.enabled ?? $('persistentPinEnabled').checked;
    const message = overrides.message ?? String($('persistentPinMessageInput').value || '').trim();
    const startupHoldSeconds = overrides.startupHoldSeconds ?? Number($('persistentPinStartupHold').value);
    if (Array.from(message).length > maxPersistentPinMessageLength) {
      const error = `Pinned message can contain at most ${maxPersistentPinMessageLength} characters.`;
      if (persistentPinEditor.open) setPersistentPinMsg(error, true); else setMsg(error, true);
      return false;
    }
    if (enabled && !message) {
      const error = 'Enter a pinned message before enabling Persistent Stream Pin.';
      if (persistentPinEditor.open) setPersistentPinMsg(error, true); else setMsg(error, true);
      return false;
    }
    if (!Number.isInteger(Number(startupHoldSeconds)) || Number(startupHoldSeconds) < 0 || Number(startupHoldSeconds) > maxPersistentPinHoldSeconds) {
      const error = `Post-Pin Hold must be a whole number between 0 and ${maxPersistentPinHoldSeconds} seconds.`;
      if (persistentPinEditor.open) setPersistentPinMsg(error, true); else setMsg(error, true);
      return false;
    }
    const saveButton = $('savePersistentPinBtn');
    if (saveButton) saveButton.disabled = true;
    try {
      const d = await postJson('/eventsub-reactions/persistent-pin', { enabled: Boolean(enabled), message, startupHoldSeconds: Number(startupHoldSeconds) });
      if (!d.success) throw new Error(d.error || 'Could not save Persistent Stream Pin.');
      persistentPin = { ...persistentPin, ...(d.persistentPin || {}) };
      if (closeAfter) closePersistentPinEditor();
      await load();
      return true;
    } catch (err) {
      const error = err.message || 'Could not save Persistent Stream Pin.';
      if (persistentPinEditor.open) setPersistentPinMsg(error, true); else setMsg(error, true);
      return false;
    } finally {
      if (saveButton) saveButton.disabled = false;
    }
  }

  function renderTypeOptions() {
    $('eventReactionType').innerHTML = eventTypes.map((item) => `<option value="${esc(item.type)}">${esc(item.label)}</option>`).join('');
  }

  function updateThresholdUi() {
    const meta = typeMeta($('eventReactionType').value);
    const wrap = $('eventReactionMinimumWrap');
    wrap.hidden = !meta.threshold;
    $('eventReactionMinimumLabel').textContent = meta.threshold ? `Minimum ${meta.threshold}` : 'Minimum';
    $('eventReactionMinimum').placeholder = meta.threshold ? `0 = any ${meta.threshold.toLowerCase()}` : '0';
  }

  function actionLabel(type) {
    if (type === 'chat_message') return 'Chat Message';
    if (type === 'custom_command') return 'Run Custom Command';
    if (type === 'twitch_announcement') return 'Twitch Announcement';
    if (type === 'twitch_shoutout') return 'Twitch Shoutout';
    return type;
  }

  function actionRow(action = { type: 'chat_message', value: '', delaySeconds: 0, enabled: true }) {
    const row = document.createElement('div');
    row.className = 'event-reaction-action-row';
    row.innerHTML = `
      <label class="inline-check event-action-enabled"><input class="event-action-enabled-input" type="checkbox" ${action.enabled === false ? '' : 'checked'}> Use</label>
      <label>Action
        <select class="event-action-type">
          <option value="chat_message">Chat Message</option>
          <option value="custom_command">Run Custom Command</option>
          <option value="twitch_announcement">Twitch Announcement</option>
          <option value="twitch_shoutout">Twitch Shoutout</option>
        </select>
      </label>
      <label>Delay
        <div class="duration-field"><input class="event-action-delay" type="number" min="0" max="${limits.maxActionDelaySeconds}" step="0.1" value="${Number(action.delaySeconds || 0)}"><span class="duration-unit">seconds</span></div>
      </label>
      <label class="event-action-value-wrap">Value
        <input class="event-action-value" maxlength="500" value="${esc(action.value || '')}">
        <select class="event-action-color" aria-label="Announcement color">
          <option value="primary">Primary</option>
          <option value="purple">Purple</option>
          <option value="blue">Blue</option>
          <option value="green">Green</option>
          <option value="orange">Orange</option>
        </select>
      </label>
      <div class="event-action-order-buttons">
        <button class="secondary event-action-up" type="button" title="Move up">↑</button>
        <button class="secondary event-action-down" type="button" title="Move down">↓</button>
        <button class="secondary event-action-remove" type="button">Remove</button>
      </div>`;
    const typeEl = row.querySelector('.event-action-type');
    const valueWrap = row.querySelector('.event-action-value-wrap');
    const valueEl = row.querySelector('.event-action-value');
    const colorEl = row.querySelector('.event-action-color');
    typeEl.value = action.type || 'chat_message';
    colorEl.value = action.color || 'primary';
    const update = () => {
      const type = typeEl.value;
      valueWrap.hidden = type === 'twitch_shoutout';
      colorEl.hidden = type !== 'twitch_announcement';
      if (type === 'chat_message') valueEl.placeholder = 'Example: Thanks for the raid, $(raider)!';
      else if (type === 'twitch_announcement') valueEl.placeholder = 'Example: Welcome in, $(raider)!';
      else if (type === 'custom_command') valueEl.placeholder = 'Example: !so $(raider)';
    };
    typeEl.addEventListener('change', update);
    row.querySelector('.event-action-up').onclick = () => { const prev=row.previousElementSibling; if (prev) actionsEl.insertBefore(row, prev); };
    row.querySelector('.event-action-down').onclick = () => { const next=row.nextElementSibling; if (next) actionsEl.insertBefore(next, row); };
    row.querySelector('.event-action-remove').onclick = () => { row.remove(); updateAddActionState(); };
    update();
    return row;
  }

  function updateAddActionState() {
    $('addEventReactionActionBtn').disabled = actionsEl.children.length >= limits.maxActions;
    $('eventReactionActionHelp').textContent = `${actionsEl.children.length}/${limits.maxActions} actions`;
  }

  function addAction(action) { if (actionsEl.children.length >= limits.maxActions) return; actionsEl.appendChild(actionRow(action)); updateAddActionState(); }

  function readActions() {
    return [...actionsEl.querySelectorAll('.event-reaction-action-row')].map((row) => ({
      type: row.querySelector('.event-action-type').value,
      value: row.querySelector('.event-action-value').value.trim(),
      color: row.querySelector('.event-action-color').value || 'primary',
      delaySeconds: Number(row.querySelector('.event-action-delay').value || 0),
      enabled: row.querySelector('.event-action-enabled-input').checked
    }));
  }

  function openEditor(reaction = null) {
    editingId = reaction?.id || null;
    $('eventReactionEditorTitle').textContent = reaction ? 'Edit EventSub Reaction' : 'Add EventSub Reaction';
    $('eventReactionName').value = reaction?.name || '';
    $('eventReactionEnabled').checked = reaction?.enabled !== false;
    $('eventReactionType').value = reaction?.eventType || (eventTypes.some((item)=>item.type==='channel.raid') ? 'channel.raid' : eventTypes[0]?.type || '');
    $('eventReactionMinimum').value = reaction?.minimumValue ?? 0;
    $('eventReactionHold').value = Number(reaction?.holdSeconds) > 0 ? String(reaction.holdSeconds) : '';
    updateHoldUi();
    actionsEl.replaceChildren();
    const actionValues = reaction?.actions?.length ? reaction.actions : [{ type:'chat_message', value:'', delaySeconds:0, enabled:true }];
    actionValues.forEach(addAction);
    updateThresholdUi();
    updateAddActionState();
    setEditorMsg('');
    editor.classList.add('open');
    if (typeof editor.showModal === 'function' && !editor.open) editor.showModal(); else editor.setAttribute('open','');
    $('eventReactionName').focus();
  }

  function closeEditor() {
    editingId = null;
    editor.classList.remove('open');
    if (editor.open && typeof editor.close === 'function') editor.close(); else editor.removeAttribute('open');
    setEditorMsg('');
  }

  function filteredSorted() {
    const q = $('eventReactionSearch').value.trim().toLowerCase();
    const sort = $('eventReactionSort').value;
    let items = reactions.filter((r) => {
      if (!q) return true;
      const blob = [r.name, typeMeta(r.eventType).label, r.eventType, ...(r.actions||[]).map((a)=>`${actionLabel(a.type)} ${a.value}`)].join(' ').toLowerCase();
      return blob.includes(q);
    });
    items = [...items].sort((a,b) => {
      if (sort === 'name_asc') return a.name.localeCompare(b.name);
      if (sort === 'name_desc') return b.name.localeCompare(a.name);
      if (sort === 'updated_desc') return new Date(b.updatedAt||0)-new Date(a.updatedAt||0);
      if (sort === 'event_asc') return typeMeta(a.eventType).label.localeCompare(typeMeta(b.eventType).label);
      return new Date(a.createdAt||0)-new Date(b.createdAt||0);
    });
    return items;
  }

  function render() {
    const items = filteredSorted();
    const pageSize = Number($('eventReactionPageSize').value || 10);
    const pages = Math.max(1, Math.ceil(items.length / pageSize));
    page = Math.max(1, Math.min(page, pages));
    const visible = items.slice((page-1)*pageSize, page*pageSize);

    const persistentPinCard = `<div class="custom-command-card event-reaction-card persistent-pin-reaction-card" data-system="persistent-pin">
      <div class="custom-command-card-main">
        <div class="custom-command-title-row"><strong class="custom-command-name">Persistent Stream Pin</strong><span class="custom-command-state ${persistentPin.enabled?'enabled':'disabled'}">${persistentPin.enabled?'Enabled':'Disabled'}</span></div>
        <div class="detail">Stream Online · 1 action · bypasses global post-hold</div>
      </div>
      <div class="custom-command-actions">
        <button class="secondary persistent-pin-edit" type="button">Edit</button>
        <button class="secondary persistent-pin-toggle" type="button">${persistentPin.enabled?'Disable':'Enable'}</button>
        <button class="danger persistent-pin-delete" type="button" disabled title="Built-in reaction">Delete</button>
      </div>
    </div>`;

    const regularCards = visible.map((r) => {
      const enabledActions = (r.actions||[]).filter((a)=>a.enabled!==false).length;
      const threshold = r.minimumValue > 0 && typeMeta(r.eventType).threshold ? ` · min ${r.minimumValue} ${typeMeta(r.eventType).threshold.toLowerCase()}` : '';
      const holdLabel = Number(r.holdSeconds) > 0 ? `${Number(r.holdSeconds)}s post-hold` : 'global post-hold';
      return `<div class="custom-command-card event-reaction-card" data-id="${esc(r.id)}">
        <div class="custom-command-card-main">
          <div class="custom-command-title-row"><strong class="custom-command-name">${esc(r.name)}</strong><span class="custom-command-state ${r.enabled?'enabled':'disabled'}">${r.enabled?'Enabled':'Disabled'}</span></div>
          <div class="detail">${esc(typeMeta(r.eventType).label)}${esc(threshold)} · ${enabledActions} action${enabledActions===1?'':'s'} · ${esc(holdLabel)}</div>
        </div>
        <div class="custom-command-actions">
          <button class="secondary event-reaction-edit" type="button">Edit</button>
          <button class="secondary event-reaction-toggle" type="button">${r.enabled?'Disable':'Enable'}</button>
          <button class="danger event-reaction-delete" type="button">Delete</button>
        </div>
      </div>`;
    }).join('');

    $('eventReactionList').innerHTML = persistentPinCard + regularCards;
    $('eventReactionPageLabel').textContent = `Page ${page} of ${pages}`;
    $('eventReactionPrevPage').disabled = page <= 1;
    $('eventReactionNextPage').disabled = page >= pages;
    $('eventReactionPagination').hidden = items.length === 0;

    const pinCard = $('eventReactionList').querySelector('.persistent-pin-reaction-card');
    pinCard.querySelector('.persistent-pin-edit').onclick = openPersistentPinEditor;
    pinCard.querySelector('.persistent-pin-toggle').onclick = async () => {
      setMsg('');
      await savePersistentPinConfig({
        enabled: !persistentPin.enabled,
        message: String(persistentPin.message || '').trim(),
        startupHoldSeconds: Number(persistentPin.startupHoldSeconds ?? defaultPersistentPinHoldSeconds)
      });
    };

    $('eventReactionList').querySelectorAll('.event-reaction-card[data-id]').forEach((card) => {
      const reaction = reactions.find((r)=>r.id===card.dataset.id); if (!reaction) return;
      card.querySelector('.event-reaction-edit').onclick = () => openEditor(reaction);
      card.querySelector('.event-reaction-toggle').onclick = async () => {
        const d = await postJson('/eventsub-reactions/toggle', { id: reaction.id, enabled: !reaction.enabled });
        if (!d.success) return setMsg(d.error || 'Could not update reaction.', true);
        await load();
      };
      card.querySelector('.event-reaction-delete').onclick = async () => {
        if (!confirm(`Delete “${reaction.name}”?`)) return;
        const d = await postJson('/eventsub-reactions/delete', { id: reaction.id });
        if (!d.success) return setMsg(d.error || 'Could not delete reaction.', true);
        await load();
      };
    });
  }

  async function load() {
    const d = await postJson('/eventsub-reactions/list', {});
    if (!d.success) { setMsg(d.error || 'Could not load EventSub reactions.', true); return; }
    reactions = d.reactions || [];
    persistentPin = { ...persistentPin, ...(d.persistentPin || {}) };
    eventTypes = d.eventTypes || [];
    limits = { ...limits, ...(d.limits||{}) };
    automationSpacingSeconds = Math.max(0, Number(d.automationSpacingSeconds) || 0);
    renderTypeOptions();
    updateHoldUi();
    loaded = true;
    render();
    setMsg('');
  }

  window.addEventListener('qwertbot:automation-spacing-changed', (event) => {
    automationSpacingSeconds = Math.max(0, Number(event.detail?.minimumSpacingSeconds) || 0);
    updateHoldUi();
    if (editor.open) {
      const error = validateHold();
      setEditorMsg(error, Boolean(error));
    }
  });
  $('savePersistentPinBtn').onclick = () => savePersistentPinConfig({}, { closeAfter: true });
  $('closePersistentPinEditorBtn').onclick = closePersistentPinEditor;
  $('cancelPersistentPinBtn').onclick = closePersistentPinEditor;
  persistentPinEditor.addEventListener('click', (event) => { if (event.target === persistentPinEditor) closePersistentPinEditor(); });
  persistentPinEditor.addEventListener('cancel', (event) => { event.preventDefault(); closePersistentPinEditor(); });
  $('eventReactionType').addEventListener('change', updateThresholdUi);
  $('eventReactionHold').addEventListener('input', () => {
    const raw = $('eventReactionHold').value.trim();
    if (!raw) return setEditorMsg('');
    const error = validateHold();
    setEditorMsg(error, Boolean(error));
  });
  $('addEventReactionActionBtn').onclick = () => addAction({ type:'chat_message', value:'', delaySeconds:0, enabled:true });
  $('showEventReactionVariablesBtn').onclick = () => { if (typeof variablesDialog.showModal === 'function') variablesDialog.showModal(); else variablesDialog.setAttribute('open', ''); };
  $('closeEventReactionVariablesBtn').onclick = () => { if (typeof variablesDialog.close === 'function') variablesDialog.close(); else variablesDialog.removeAttribute('open'); };
  variablesDialog.addEventListener('click', (event) => { if (event.target === variablesDialog && typeof variablesDialog.close === 'function') variablesDialog.close(); });
  $('addEventReactionBtn').onclick = () => openEditor();
  $('closeEventReactionEditorBtn').onclick = closeEditor;
  $('cancelEventReactionBtn').onclick = closeEditor;
  editor.addEventListener('click', (e)=>{ if (e.target===editor && !variablesDialog.open) closeEditor(); });
  editor.addEventListener('cancel', (event)=>{ event.preventDefault(); if (!variablesDialog.open) closeEditor(); });
  $('refreshEventReactionsBtn').onclick = load;
  $('eventReactionSearch').addEventListener('input', ()=>{ page=1; render(); });
  try {
    const savedSort = localStorage.getItem(SORT_STORAGE_KEY);
    if (savedSort && [...$('eventReactionSort').options].some((opt)=>opt.value===savedSort)) $('eventReactionSort').value = savedSort;
    const savedPageSize = Number(localStorage.getItem(PAGE_SIZE_STORAGE_KEY));
    if (VALID_PAGE_SIZES.has(savedPageSize)) $('eventReactionPageSize').value = String(savedPageSize);
  } catch {}
  $('eventReactionSort').addEventListener('change', ()=>{ page=1; try { localStorage.setItem(SORT_STORAGE_KEY, $('eventReactionSort').value); } catch {} render(); });
  $('eventReactionPageSize').addEventListener('change', ()=>{ page=1; try { localStorage.setItem(PAGE_SIZE_STORAGE_KEY, $('eventReactionPageSize').value); } catch {} render(); });
  $('eventReactionPrevPage').onclick = ()=>{ page=Math.max(1,page-1); render(); };
  $('eventReactionNextPage').onclick = ()=>{ page+=1; render(); };

  $('saveEventReactionBtn').onclick = async () => {
    setEditorMsg('');
    const holdError = validateHold();
    if (holdError) return setEditorMsg(holdError, true);
    const payload = {
      id: editingId,
      name: $('eventReactionName').value.trim(),
      enabled: $('eventReactionEnabled').checked,
      eventType: $('eventReactionType').value,
      minimumValue: Number($('eventReactionMinimum').value || 0),
      holdSeconds: $('eventReactionHold').value.trim() === '' ? null : Number($('eventReactionHold').value),
      actions: readActions()
    };
    const d = await postJson('/eventsub-reactions/save', payload);
    if (!d.success) return setEditorMsg(d.error || 'Could not save reaction.', true);
    closeEditor();
    await load();
  };

  return {
    onVisibilityChange(visible) {
      if (!visible) { if (variablesDialog.open && typeof variablesDialog.close === 'function') variablesDialog.close(); if (editor.open) closeEditor(); if (persistentPinEditor.open) closePersistentPinEditor(); return; }
      if (!loaded) void load();
    },
    load
  };
}
