export function initAdvancedFiltersSection({ $, esc, postJson }) {
  let filters = [];
  let limits = {
    maxFilters: 50,
    maxNameLength: 80,
    maxGroups: 10,
    maxRulesPerGroup: 12,
    maxRulesTotal: 40,
    maxValueLength: 120
  };
  let currentStream = { live: false, title: '', category: '' };
  let loaded = false;
  let loadingPromise = null;
  let editingId = null;
  const listeners = new Set();

  const listEl = $('advancedFilterList');
  const editorEl = $('advancedFilterEditor');
  const groupsEl = $('advancedFilterGroups');
  const msgEl = $('advancedFiltersMsg');
  const editorMsgEl = $('advancedFilterEditorMsg');

  function setMessage(el, text, bad = false) {
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('bad', Boolean(bad));
  }

  function notify() {
    const snapshot = getFilters();
    listeners.forEach((listener) => {
      try { listener(snapshot); } catch (_) {}
    });
  }

  function getFilters() {
    return filters.map((filter) => ({
      ...filter,
      groups: Array.isArray(filter.groups)
        ? filter.groups.map((group) => ({ ...group, rules: Array.isArray(group.rules) ? group.rules.map((rule) => ({ ...rule })) : [] }))
        : []
    }));
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function operatorValue(value) {
    return String(value || '').toLowerCase() === 'or' ? 'or' : 'and';
  }

  function defaultRule() {
    return { field: 'title', match: 'contains', value: '', operator: 'and' };
  }

  function defaultGroup() {
    return { operator: 'and', rules: [defaultRule()] };
  }

  function filterUsageText(filter) {
    const timerCount = Array.isArray(filter?.usage?.timers) ? filter.usage.timers.length : 0;
    const youtubeTimerCount = Array.isArray(filter?.usage?.youtubeTimers) ? filter.usage.youtubeTimers.length : 0;
    const bannerCount = Array.isArray(filter?.usage?.banners) ? filter.usage.banners.length : 0;
    if (!timerCount && !youtubeTimerCount && !bannerCount) return 'Not currently assigned';
    const parts = [];
    if (timerCount) parts.push(`${timerCount} Twitch timer${timerCount === 1 ? '' : 's'}`);
    if (youtubeTimerCount) parts.push(`${youtubeTimerCount} YouTube timer${youtubeTimerCount === 1 ? '' : 's'}`);
    if (bannerCount) parts.push(`${bannerCount} banner${bannerCount === 1 ? '' : 's'}`);
    return `Used by ${parts.join(' · ')}`;
  }

  function streamSummary() {
    if (!currentStream?.live) return 'Current shared stream context (from Twitch): offline. Filters will be evaluated when the stream is live.';
    const title = currentStream.title || 'Unknown title';
    const category = currentStream.category || 'Unknown category';
    return `Current shared stream context (from Twitch): “${title}” · ${category}`;
  }

  function renderList() {
    if ($('advancedFiltersCurrentStream')) $('advancedFiltersCurrentStream').textContent = streamSummary();
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!filters.length) {
      listEl.innerHTML = '<div class="custom-empty-state detail">No Advanced Filters yet. Create one, then assign it to a Twitch/YouTube timer or pinned banner.</div>';
      return;
    }

    filters.forEach((filter) => {
      const card = document.createElement('div');
      card.className = 'custom-command-card advanced-filter-card';
      const matchText = !currentStream?.live ? 'Not evaluated (offline)' : (filter.currentMatch ? 'MATCH' : 'NO MATCH');
      const matchClass = !currentStream?.live ? 'disabled' : (filter.currentMatch ? 'enabled' : 'disabled');
      card.innerHTML = `
        <div class="custom-command-card-main">
          <div class="custom-command-title-row">
            <strong class="custom-command-name">${esc(filter.name || 'Filter')}</strong>
            <span class="custom-command-state ${matchClass}">${esc(matchText)}</span>
          </div>
          <div class="detail advanced-filter-summary">${esc(filter.summary || 'No rule summary available.')}</div>
          <div class="detail">${esc(filterUsageText(filter))}</div>
        </div>
        <div class="custom-command-actions">
          <button class="secondary advanced-filter-edit" type="button">Edit</button>
          <button class="danger advanced-filter-delete" type="button">Delete</button>
        </div>`;
      card.querySelector('.advanced-filter-edit').onclick = () => openEditor(filter);
      card.querySelector('.advanced-filter-delete').onclick = () => deleteFilter(filter);
      listEl.appendChild(card);
    });
  }

  async function loadFilters({ quiet = false, force = true } = {}) {
    if (loadingPromise) return loadingPromise;
    if (!force && loaded) return filters;
    if (!quiet) setMessage(msgEl, 'Loading Advanced Filters...');
    loadingPromise = (async () => {
      try {
        const d = await postJson('/advanced-filters/list', {});
        if (!d.success) throw new Error(d.error || 'Could not load Advanced Filters.');
        filters = Array.isArray(d.filters) ? d.filters : [];
        limits = { ...limits, ...(d.limits || {}) };
        currentStream = { ...currentStream, ...(d.currentStream || {}) };
        loaded = true;
        renderList();
        if (!quiet) setMessage(msgEl, `${filters.length} filter${filters.length === 1 ? '' : 's'}.`);
        notify();
        return filters;
      } catch (err) {
        setMessage(msgEl, err.message || 'Could not load Advanced Filters.', true);
        throw err;
      } finally {
        loadingPromise = null;
      }
    })();
    return loadingPromise;
  }

  async function ensureLoaded() {
    if (loaded) return filters;
    try { return await loadFilters({ quiet: true, force: true }); }
    catch (_) { return filters; }
  }

  function makeJoin(kind, value = 'and') {
    const wrapper = document.createElement('div');
    wrapper.className = `advanced-filter-join advanced-filter-${kind}-join`;
    wrapper.innerHTML = `
      <select class="advanced-filter-join-select" aria-label="${kind === 'group' ? 'Logic between groups' : 'Logic between rules'}">
        <option value="and">AND</option>
        <option value="or">OR</option>
      </select>`;
    wrapper.querySelector('select').value = operatorValue(value);
    return wrapper;
  }

  function makeRuleRow(rule = defaultRule()) {
    const row = document.createElement('div');
    row.className = 'advanced-filter-rule-row';
    row.innerHTML = `
      <label class="advanced-filter-field-label"><span class="sr-only">Field</span>
        <select class="advanced-filter-field">
          <option value="title">Stream Title</option>
          <option value="category">Stream Category / Game</option>
        </select>
      </label>
      <label><span class="sr-only">Comparison</span>
        <select class="advanced-filter-match">
          <option value="contains">Contains</option>
          <option value="not_contains">Does Not Contain</option>
          <option value="equals">Equals</option>
          <option value="not_equals">Does Not Equal</option>
        </select>
      </label>
      <label><span class="sr-only">Value</span>
        <input class="advanced-filter-value" type="text" maxlength="${Number(limits.maxValueLength || 120)}" placeholder="Keyword or exact value">
      </label>
      <button class="secondary advanced-filter-remove-rule" type="button">Remove</button>`;
    row.querySelector('.advanced-filter-field').value = rule?.field === 'category' ? 'category' : 'title';
    const match = ['contains', 'not_contains', 'equals', 'not_equals'].includes(rule?.match) ? rule.match : 'contains';
    row.querySelector('.advanced-filter-match').value = match;
    row.querySelector('.advanced-filter-value').value = String(rule?.value || '');
    row.querySelector('.advanced-filter-remove-rule').onclick = () => {
      const group = row.closest('.advanced-filter-group-card');
      row.remove();
      rebuildRuleJoins(group);
      updateBuilderState();
    };
    return row;
  }

  function ruleRows(group) {
    return [...group.querySelectorAll(':scope > .advanced-filter-rule-list > .advanced-filter-rule-row')];
  }

  function rebuildRuleJoins(group) {
    if (!group) return;
    const list = group.querySelector('.advanced-filter-rule-list');
    if (!list) return;
    const rows = ruleRows(group);
    // Treat each separator as belonging to the rule that follows it. This keeps
    // the intended operator when a rule in the middle is removed.
    const operatorByRow = new Map(rows.map((row) => {
      const previous = row.previousElementSibling;
      const value = previous?.classList?.contains('advanced-filter-rule-join')
        ? previous.querySelector('.advanced-filter-join-select')?.value
        : 'and';
      return [row, operatorValue(value)];
    }));
    list.querySelectorAll(':scope > .advanced-filter-rule-join').forEach((el) => el.remove());
    rows.forEach((row, index) => {
      if (index === 0) return;
      list.insertBefore(makeJoin('rule', operatorByRow.get(row) || 'and'), row);
    });
  }

  function makeGroup(groupData = defaultGroup()) {
    const group = document.createElement('div');
    group.className = 'advanced-filter-group-card';
    group.dataset.operator = operatorValue(groupData?.operator);
    group.innerHTML = `
      <div class="advanced-filter-group-header">
        <div>
          <strong class="advanced-filter-group-title">Rule Group</strong>
          <div class="detail">Rules inside this group are evaluated together.</div>
        </div>
        <button class="secondary advanced-filter-remove-group" type="button">Remove Group</button>
      </div>
      <div class="advanced-filter-rule-list"></div>
      <div class="advanced-filter-group-actions">
        <button class="secondary advanced-filter-add-rule" type="button">+ Add Rule</button>
      </div>`;
    const list = group.querySelector('.advanced-filter-rule-list');
    const rules = Array.isArray(groupData?.rules) && groupData.rules.length ? groupData.rules : [defaultRule()];
    rules.forEach((rule, index) => {
      if (index > 0) list.appendChild(makeJoin('rule', rule?.operator));
      list.appendChild(makeRuleRow(rule));
    });
    group.querySelector('.advanced-filter-add-rule').onclick = () => {
      if (ruleRows(group).length >= Number(limits.maxRulesPerGroup || 12)) {
        return setMessage(editorMsgEl, `A group can contain at most ${limits.maxRulesPerGroup || 12} rules.`, true);
      }
      if (countAllRules() >= Number(limits.maxRulesTotal || 40)) {
        return setMessage(editorMsgEl, `A filter can contain at most ${limits.maxRulesTotal || 40} rules total.`, true);
      }
      setMessage(editorMsgEl, '');
      if (ruleRows(group).length) list.appendChild(makeJoin('rule', 'and'));
      list.appendChild(makeRuleRow());
      updateBuilderState();
    };
    group.querySelector('.advanced-filter-remove-group').onclick = () => {
      group.remove();
      rebuildGroupJoins();
      updateBuilderState();
    };
    return group;
  }

  function groups() {
    return [...groupsEl.querySelectorAll(':scope > .advanced-filter-group-card')];
  }

  function countAllRules() {
    return groups().reduce((sum, group) => sum + ruleRows(group).length, 0);
  }

  function rebuildGroupJoins() {
    if (!groupsEl) return;
    const groupEls = groups();
    const operatorByGroup = new Map(groupEls.map((group) => {
      const previous = group.previousElementSibling;
      const value = previous?.classList?.contains('advanced-filter-group-join')
        ? previous.querySelector('.advanced-filter-join-select')?.value
        : group.dataset.operator || 'and';
      return [group, operatorValue(value)];
    }));
    groupsEl.querySelectorAll(':scope > .advanced-filter-group-join').forEach((el) => el.remove());
    groupEls.forEach((group, index) => {
      if (index === 0) return;
      groupsEl.insertBefore(makeJoin('group', operatorByGroup.get(group) || 'and'), group);
    });
  }

  function updateBuilderState() {
    const groupEls = groups();
    groupEls.forEach((group, index) => {
      const title = group.querySelector('.advanced-filter-group-title');
      if (title) title.textContent = `Group ${index + 1}`;
      group.querySelector('.advanced-filter-remove-group').disabled = groupEls.length <= 1;
      const rows = ruleRows(group);
      rows.forEach((row) => { row.querySelector('.advanced-filter-remove-rule').disabled = rows.length <= 1; });
      const addRule = group.querySelector('.advanced-filter-add-rule');
      if (addRule) addRule.disabled = rows.length >= Number(limits.maxRulesPerGroup || 12) || countAllRules() >= Number(limits.maxRulesTotal || 40);
    });
    if ($('addAdvancedFilterGroupBtn')) $('addAdvancedFilterGroupBtn').disabled = groupEls.length >= Number(limits.maxGroups || 10) || countAllRules() >= Number(limits.maxRulesTotal || 40);
    if ($('advancedFilterBuilderCount')) $('advancedFilterBuilderCount').textContent = `${groupEls.length}/${limits.maxGroups || 10} groups · ${countAllRules()}/${limits.maxRulesTotal || 40} rules`;
  }

  function populateBuilder(filter = null) {
    groupsEl.replaceChildren();
    const sourceGroups = Array.isArray(filter?.groups) && filter.groups.length ? filter.groups : [defaultGroup()];
    sourceGroups.forEach((group, index) => {
      if (index > 0) groupsEl.appendChild(makeJoin('group', group?.operator));
      groupsEl.appendChild(makeGroup(group));
    });
    updateBuilderState();
  }

  function collectGroups() {
    const groupEls = groups();
    const groupJoinSelects = [...groupsEl.querySelectorAll(':scope > .advanced-filter-group-join .advanced-filter-join-select')];
    return groupEls.map((group, groupIndex) => {
      const rows = ruleRows(group);
      const ruleJoinSelects = [...group.querySelectorAll(':scope > .advanced-filter-rule-list > .advanced-filter-rule-join .advanced-filter-join-select')];
      return {
        operator: groupIndex === 0 ? 'and' : operatorValue(groupJoinSelects[groupIndex - 1]?.value),
        rules: rows.map((row, ruleIndex) => ({
          operator: ruleIndex === 0 ? 'and' : operatorValue(ruleJoinSelects[ruleIndex - 1]?.value),
          field: row.querySelector('.advanced-filter-field').value,
          match: row.querySelector('.advanced-filter-match').value,
          value: row.querySelector('.advanced-filter-value').value.trim()
        }))
      };
    });
  }

  function openEditor(filter = null) {
    editingId = filter?.id || null;
    $('advancedFilterEditorTitle').textContent = filter ? 'Edit Advanced Filter' : 'Add Advanced Filter';
    $('advancedFilterName').value = filter?.name || '';
    $('advancedFilterName').maxLength = Number(limits.maxNameLength || 80);
    setMessage(editorMsgEl, '');
    populateBuilder(filter);
    editorEl.classList.add('open');
    if (typeof editorEl.showModal === 'function' && !editorEl.open) editorEl.showModal();
    else editorEl.setAttribute('open', '');
    $('advancedFilterName').focus();
  }

  function closeEditor() {
    editingId = null;
    editorEl.classList.remove('open');
    if (editorEl.open && typeof editorEl.close === 'function') editorEl.close();
    else editorEl.removeAttribute('open');
    setMessage(editorMsgEl, '');
  }

  async function saveFilter() {
    setMessage(editorMsgEl, '');
    const name = $('advancedFilterName').value.trim();
    if (!name) return setMessage(editorMsgEl, 'Filter Name is required.', true);
    const collected = collectGroups();
    if (!collected.length) return setMessage(editorMsgEl, 'Add at least one rule group.', true);
    for (let g = 0; g < collected.length; g += 1) {
      if (!collected[g].rules.length) return setMessage(editorMsgEl, `Group ${g + 1} needs at least one rule.`, true);
      for (let r = 0; r < collected[g].rules.length; r += 1) {
        if (!collected[g].rules[r].value) return setMessage(editorMsgEl, `Group ${g + 1}, rule ${r + 1} needs a value.`, true);
      }
    }

    $('saveAdvancedFilterBtn').disabled = true;
    try {
      const d = await postJson('/advanced-filters/save', { id: editingId, name, groups: collected });
      if (!d.success) throw new Error(d.error || 'Could not save Advanced Filter.');
      closeEditor();
      await loadFilters({ force: true });
      setMessage(msgEl, `Saved ${d.filter?.name || name}.`);
    } catch (err) {
      setMessage(editorMsgEl, err.message || 'Could not save Advanced Filter.', true);
    } finally {
      $('saveAdvancedFilterBtn').disabled = false;
    }
  }

  async function deleteFilter(filter) {
    if (!confirm(`Delete “${filter.name}”?`)) return;
    setMessage(msgEl, '');
    try {
      const d = await postJson('/advanced-filters/delete', { id: filter.id });
      if (!d.success) throw new Error(d.error || 'Could not delete Advanced Filter.');
      await loadFilters({ force: true });
      setMessage(msgEl, `Deleted ${filter.name}.`);
    } catch (err) {
      setMessage(msgEl, err.message || 'Could not delete Advanced Filter.', true);
    }
  }

  $('addAdvancedFilterBtn').onclick = async () => {
    await ensureLoaded();
    if (filters.length >= Number(limits.maxFilters || 50)) return setMessage(msgEl, `Advanced Filters supports at most ${limits.maxFilters || 50} filters.`, true);
    openEditor();
  };
  $('refreshAdvancedFiltersBtn').onclick = () => void loadFilters({ force: true });
  $('addAdvancedFilterGroupBtn').onclick = () => {
    if (groups().length >= Number(limits.maxGroups || 10)) return setMessage(editorMsgEl, `A filter can contain at most ${limits.maxGroups || 10} groups.`, true);
    if (groups().length) groupsEl.appendChild(makeJoin('group', 'and'));
    groupsEl.appendChild(makeGroup());
    updateBuilderState();
  };
  $('saveAdvancedFilterBtn').onclick = saveFilter;
  $('cancelAdvancedFilterBtn').onclick = closeEditor;
  $('closeAdvancedFilterEditorBtn').onclick = closeEditor;
  editorEl.addEventListener('click', (event) => { if (event.target === editorEl) closeEditor(); });
  editorEl.addEventListener('cancel', (event) => { event.preventDefault(); closeEditor(); });

  populateBuilder();
  editorEl.classList.remove('open');

  return {
    ensureLoaded,
    loadFilters,
    getFilters,
    subscribe,
    onVisibilityChange(visible) {
      if (!visible) {
        if (editorEl.classList.contains('open')) closeEditor();
        return;
      }
      void loadFilters({ force: true });
    }
  };
}
