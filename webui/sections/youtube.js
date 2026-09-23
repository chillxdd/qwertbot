export function initYoutubeSection({ $, esc, postJson }) {
  let adminState = null;
  let commands = [];
  let timers = [];
  let commandSettings = { globalCooldownSeconds: 5 };
  let activeAutomationView = 'commands';
  let commandFilters = { search: '', userLevel: 'all', sort: 'created_asc' };
  let timerFilters = { search: '', sort: 'created_asc' };
  let commandPage = 1;
  let timerPage = 1;
  let nativeConfig = { commandsEnabled: true, commandsResponse: '' };
  let nativeDefaults = { commandsEnabled: true, commandsResponse: '' };

  const PAGE_SIZES = new Set([10, 25, 50]);
  const MAX_RESPONSES = 25;
  const MAX_TRIGGERS = 25;
  const MAX_RESPONSE_LENGTH = 200;
  const USER_LEVEL_LABELS = { everyone: 'Everyone', member: 'Member', moderator: 'Moderator', owner: 'Owner' };

  const fmtTime = (value) => value ? new Date(value).toLocaleString() : '—';
  const formatInterval = (seconds) => {
    const total = Math.max(0, Number(seconds || 0));
    if (total >= 3600 && total % 3600 === 0) return `${total / 3600}h`;
    if (total >= 60 && total % 60 === 0) return `${total / 60}m`;
    return `${total}s`;
  };
  const priorityLabel = (value) => value === 'high' ? 'High' : value === 'low' ? 'Low' : 'Normal';
  const normalize = (value) => String(value || '').toLowerCase();
  const escAttr = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sortCompare = (a, b, direction = 'asc') => {
    if (a === b) return 0;
    return direction === 'desc' ? (a < b ? 1 : -1) : (a < b ? -1 : 1);
  };

  const setValue = (id, text, state = '') => {
    const el = $(id); if (!el) return;
    el.textContent = text;
    el.classList.remove('good', 'warn', 'bad');
    if (state) el.classList.add(state);
  };

  function setMessage(id, text = '', isError = false) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('bad', Boolean(isError));
  }

  function openDialog(id) {
    const dialog = $(id);
    if (!dialog) return;
    dialog.classList.add('open');
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function closeDialog(id) {
    const dialog = $(id);
    if (!dialog) return;
    dialog.classList.remove('open');
    if (typeof dialog.close === 'function') {
      if (dialog.open) dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
  }

  function pageSize(id) {
    const value = Number($(id)?.value || 10);
    return PAGE_SIZES.has(value) ? value : 10;
  }

  function updatePagination({ totalItems, page, setPage, pageSizeId, labelId, prevId, nextId, paginationId, sourceCount }) {
    const size = pageSize(pageSizeId);
    const totalPages = Math.max(1, Math.ceil(totalItems / size));
    const safePage = Math.min(Math.max(1, page), totalPages);
    if (safePage !== page) setPage(safePage);
    $(labelId).textContent = `Page ${safePage} of ${totalPages}`;
    $(prevId).disabled = safePage <= 1;
    $(nextId).disabled = safePage >= totalPages;
    $(paginationId).hidden = sourceCount === 0;
    return { page: safePage, pageSize: size };
  }

  function userLevelBadgeHtml(value) {
    const level = Object.prototype.hasOwnProperty.call(USER_LEVEL_LABELS, value) ? value : 'everyone';
    return `<span class="user-level-badge user-level-${esc(level)}">${esc(USER_LEVEL_LABELS[level])}</span>`;
  }

  function responseModeLabel(mode) {
    return mode === 'weighted' ? 'Specified Weight' : 'Equal Odds';
  }

  function renderAdminState(state) {
    adminState = state;
    const auth = state?.auth || {};
    const status = state?.status || {};
    const quota = state?.quota || {};
    const cfg = state?.config || {};

    const oauthReady = Boolean(auth.connected);
    setValue('youtubeOauthStatus', !auth.configured ? 'NOT CONFIGURED' : oauthReady ? 'CONNECTED' : 'NOT AUTHORIZED', !auth.configured ? 'bad' : oauthReady ? 'good' : 'warn');
    $('youtubeOauthDetail').textContent = !auth.configured
      ? 'Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and CONFIG_ENCRYPTION_KEY on Render.'
      : oauthReady
        ? `${auth.displayName || 'YouTube bot'} · ${auth.channelId || 'unknown channel'} · token refresh stored securely`
        : 'Authorize the SqwertArmyBot YouTube channel.';
    $('youtubeAuthorizeBtn').disabled = !auth.configured;
    $('youtubeDisconnectBtn').disabled = !oauthReady;

    const chats = Array.isArray(status.distinctChats) ? status.distinctChats : [];
    const listeningEnabled = status.chatListeningEnabled !== false && cfg.commandsEnabled !== false;
    const timerSendTargets = Math.max(0, Number(status.timerSendTargetCount || 0));
    const connected = chats.filter((chat) => chat.state === 'connected').length;
    const reconnecting = chats.filter((chat) => chat.state === 'reconnecting').length;
    const connecting = chats.filter((chat) => chat.state === 'connecting' || chat.state === 'priming').length;
    const errors = chats.filter((chat) => chat.state === 'error').length;
    const activeChats = connected + reconnecting + connecting;
    const pending = status.pendingDeliveries || {};
    let liveText = 'SLEEPING'; let liveState = 'warn';
    if (status.twitchLive) {
      if (!listeningEnabled) {
        liveText = timerSendTargets ? `${timerSendTargets} SEND TARGET${timerSendTargets === 1 ? '' : 'S'}` : 'LISTENING OFF';
        liveState = timerSendTargets ? 'good' : status.lastDiscoveryError ? 'bad' : 'warn';
      } else if (activeChats) {
        liveText = `${activeChats} CHAT${activeChats === 1 ? '' : 'S'} ACTIVE`;
        liveState = connected === activeChats && !errors ? 'good' : errors ? 'bad' : 'warn';
      } else if (errors) { liveText = 'CHAT ERROR'; liveState = 'bad'; }
      else if (status.lastDiscoveryError) { liveText = 'DISCOVERY ERROR'; liveState = 'bad'; }
      else { liveText = 'DISCOVERING'; liveState = 'warn'; }
    }
    setValue('youtubeLiveStatus', liveText, liveState);
    const broadcastText = (status.activeBroadcasts || []).map((item) => item.title || item.videoId).filter(Boolean).join(' · ');
    const stateParts = [];
    if (!listeningEnabled && status.twitchLive) stateParts.push('commands engine OFF / StreamList listeners stopped');
    if (connected) stateParts.push(`${connected} connected`);
    if (reconnecting) stateParts.push(`${reconnecting} reconnecting`);
    if (connecting) stateParts.push(`${connecting} connecting`);
    if (errors) stateParts.push(`${errors} error`);
    if (timerSendTargets) stateParts.push(`${timerSendTargets} timer send target${timerSendTargets === 1 ? '' : 's'}`);
    if (Number(pending.total || 0)) stateParts.push(`${pending.total} pending send${Number(pending.total) === 1 ? '' : 's'}`);
    const reconnectTotal = chats.reduce((sum, chat) => sum + Number(chat.reconnectCount || 0), 0);
    const streamConnectionsThisProcess = chats.reduce((sum, chat) => sum + Number(chat.connectionCount || 0), 0);
    if (streamConnectionsThisProcess) stateParts.push(`${streamConnectionsThisProcess} StreamList connection${streamConnectionsThisProcess === 1 ? '' : 's'} this process`);
    const oldestActiveConnectionMs = chats.reduce((max, chat) => Math.max(max, Number(chat.currentConnectionAgeMs || 0)), 0);
    const longestCompletedConnectionMs = chats.reduce((max, chat) => Math.max(max, Number(chat.longestConnectionDurationMs || 0)), 0);
    if (oldestActiveConnectionMs >= 1000) stateParts.push(`oldest active StreamList ${formatInterval(Math.floor(oldestActiveConnectionMs / 1000))}`);
    if (longestCompletedConnectionMs >= 1000) stateParts.push(`longest completed StreamList ${formatInterval(Math.floor(longestCompletedConnectionMs / 1000))}`);
    if (reconnectTotal) stateParts.push(`${reconnectTotal} reconnect${reconnectTotal === 1 ? '' : 's'} this process`);
    const nextReconnect = chats.map((chat) => chat.nextReconnectAt).filter(Boolean).sort()[0];
    if (nextReconnect) stateParts.push(`next retry ${fmtTime(nextReconnect)}`);
    $('youtubeLiveDetail').textContent = status.twitchLive
      ? `${status.activeBroadcasts?.length || 0} active broadcast(s) · ${listeningEnabled ? `${chats.length} distinct chat worker(s)` : `${timerSendTargets} one-way timer target(s)`}${stateParts.length ? ` · ${stateParts.join(' · ')}` : ''}${broadcastText ? ` · ${broadcastText}` : ''}${status.lastDiscoveryError ? ` · ${status.lastDiscoveryError}` : ''}`
      : 'Twitch is offline, so YouTube discovery, StreamList listeners, and timers are asleep.';
    $('youtubeRediscoverBtn').disabled = !status.twitchLive || !oauthReady || !cfg.enabled;

    $('youtubeBotEnabled').checked = cfg.enabled !== false;
    $('youtubeCommandsEnabled').checked = cfg.commandsEnabled !== false;
    $('youtubeTimersEnabled').checked = cfg.timersEnabled !== false;
    if ($('youtubeGlobalTimerStartDelay')) $('youtubeGlobalTimerStartDelay').value = Number(cfg.globalTimerStartDelaySeconds ?? 0);
    $('youtubeMainQuotaLimit').value = Number(cfg.mainDailyLimitUnits ?? 10000);
    $('youtubeTimerQuotaStop').value = Number(cfg.timerSafetyStopUnits ?? 7500);
    $('youtubeHardQuotaStop').value = Number(cfg.hardSafetyStopUnits ?? 9000);
    $('youtubeSearchQuotaStop').value = Number(cfg.searchSafetyStopCalls ?? 90);

    const diagChatText = !status.twitchLive
      ? 'SLEEPING'
      : !listeningEnabled
        ? (timerSendTargets ? 'LISTENING OFF · SEND-ONLY' : 'LISTENING OFF')
        : activeChats
          ? `${activeChats} ACTIVE`
          : errors ? 'CHAT ERROR' : 'NO CHAT';
    const diagChatState = !status.twitchLive
      ? 'good'
      : !listeningEnabled
        ? (timerSendTargets ? 'good' : status.lastDiscoveryError ? 'bad' : 'warn')
        : activeChats && connected === activeChats && !errors ? 'good' : errors ? 'bad' : 'warn';
    setValue('diagYoutubeChats', diagChatText, diagChatState);
    $('diagYoutubeChatsDetail').textContent = `${status.activeBroadcasts?.length || 0} broadcast(s) · ${timerSendTargets} timer send target(s) · ${chats.length} StreamList worker(s) · channel mode ${status.streamListChannelMode || 'unknown'}${stateParts.length ? ` · ${stateParts.join(' · ')}` : ''}. Last discovery: ${status.lastDiscoveryAt ? fmtTime(status.lastDiscoveryAt) : 'not yet'}.`;

    const workerDetail = $('diagYoutubeWorkersDetail');
    if (workerDetail) {
      if (!status.twitchLive) {
        workerDetail.innerHTML = '<div>StreamList diagnostics will appear while Twitch is live.</div>';
      } else if (!listeningEnabled) {
        workerDetail.innerHTML = `<div><strong>Commands engine OFF:</strong> no YouTube chat is being read and no StreamList workers should be running. Timers remain send-only to ${timerSendTargets} discovered target${timerSendTargets === 1 ? '' : 's'}. Timers with Min Messages &gt; 0 will wait until listening is re-enabled.</div>`;
      } else if (!chats.length) {
        workerDetail.innerHTML = '<div>No StreamList worker diagnostics are available yet.</div>';
      } else {
        workerDetail.innerHTML = chats.map((chat, index) => {
          const title = (chat.broadcasts || []).map((item) => item.title || item.videoId).filter(Boolean).join(' / ') || `Chat ${index + 1}`;
          const grpcCode = chat.lastGrpcStatusCode === null || chat.lastGrpcStatusCode === undefined ? 'not observed' : `${chat.lastGrpcStatusCode} ${chat.lastGrpcStatusName || ''}`.trim();
          const grpcDetails = chat.lastGrpcStatusDetails ? ` · ${chat.lastGrpcStatusDetails}` : '';
          const lastDuration = Number(chat.lastConnectionDurationMs || 0) >= 1000 ? formatInterval(Math.floor(Number(chat.lastConnectionDurationMs) / 1000)) : `${Number(chat.lastConnectionDurationMs || 0)}ms`;
          const longestDuration = Number(chat.longestConnectionDurationMs || 0) >= 1000 ? formatInterval(Math.floor(Number(chat.longestConnectionDurationMs) / 1000)) : `${Number(chat.longestConnectionDurationMs || 0)}ms`;
          const terminal = chat.lastTerminalEvent ? `${chat.lastTerminalEvent}${chat.lastTerminalAt ? ` @ ${fmtTime(chat.lastTerminalAt)}` : ''}` : 'none';
          const error = chat.lastError || 'none';
          return `<div style="margin-top:8px"><strong>${esc(title)}</strong> · ${esc(chat.state || 'unknown')} · dedicated gRPC channel<br>`
            + `connections ${Number(chat.connectionCount || 0)} · reconnects ${Number(chat.reconnectCount || 0)} · last duration ${esc(lastDuration)} · longest ${esc(longestDuration)} · responses last/current/total ${Number(chat.lastResponseCount || 0)}/${Number(chat.currentResponseCount || 0)}/${Number(chat.totalResponseCount || 0)}<br>`
            + `final gRPC status ${esc(grpcCode + grpcDetails)} · terminal event ${esc(terminal)} · last error ${esc(error)}</div>`;
        }).join('');
      }
    }
    const main = Number(quota.mainUnits || 0), mainLimit = Number(quota.mainLimit || cfg.mainDailyLimitUnits || 10000), searches = Number(quota.searchCalls || 0), searchLimit = Number(quota.searchLimit || 100);
    const googleExhausted = Boolean(quota.googleQuotaExhaustedAt);
    const quotaState = googleExhausted || main >= Number(cfg.hardSafetyStopUnits || 9000) ? 'bad' : main >= Number(cfg.timerSafetyStopUnits || 7500) ? 'warn' : 'good';
    setValue('diagYoutubeQuota', googleExhausted ? 'GOOGLE QUOTA EXHAUSTED' : `~${main.toLocaleString()} / ${mainLimit.toLocaleString()} EST.`, quotaState);
    const googleDetail = googleExhausted ? ` · Google returned quotaExceeded at ${fmtTime(quota.googleQuotaExhaustedAt)}` : '';
    const streamSafetyCap = Number(status.streamListDailySafetyCap || 200);
    $('diagYoutubeQuotaDetail').textContent = `${searches}/${searchLimit} search calls · ${quota.commandMessages || 0} command send attempts · ${quota.timerMessages || 0} timer send attempts · ${quota.streamConnections || 0}/${streamSafetyCap} StreamList connections (runaway fuse) · ${quota.discoveryCalls || 0} discovery call(s) · ${quota.viewerCountCalls || 0} viewer-count call(s) · configured main allocation ${mainLimit.toLocaleString()} · timer stop ${Number(cfg.timerSafetyStopUnits || 7500).toLocaleString()} · send stop ${Number(cfg.hardSafetyStopUnits || 9000).toLocaleString()} · day ${quota.dayKey || '—'} (Pacific Time)${googleDetail}. Internal usage is an estimate; Google Cloud is authoritative.`;
  }

  async function refreshAdminState({ messageTarget = null } = {}) {
    const target = messageTarget ? $(messageTarget) : null;
    try {
      const d = await postJson('/youtube/admin/state', {});
      if (!d.success) throw new Error(d.error || 'Could not load YouTube state.');
      renderAdminState(d);
      if (target) target.textContent = '';
      return d;
    } catch (err) {
      if (target) target.textContent = err.message;
      setValue('youtubeOauthStatus', 'UNAVAILABLE', 'bad');
      setValue('diagYoutubeQuota', 'UNAVAILABLE', 'bad');
      throw err;
    }
  }

  function filteredCommands() {
    const search = normalize(commandFilters.search);
    const userLevel = commandFilters.userLevel || 'all';
    const list = commands.filter((command) => {
      if (userLevel !== 'all' && (command.userLevel || 'everyone') !== userLevel) return false;
      if (!search) return true;
      const triggerValues = commandTriggerValues(command);
      const haystack = [command.name, ...triggerValues, command.publicDescription, command.userLevel, ...(command.responses || [])].map(normalize).join(' ');
      return haystack.includes(search);
    });
    return [...list].sort((a, b) => {
      const sort = commandFilters.sort || 'created_asc';
      if (sort === 'created_desc') return sortCompare(new Date(a.createdAt || 0).getTime(), new Date(b.createdAt || 0).getTime(), 'desc');
      if (sort === 'name_asc') return sortCompare(normalize(a.name || a.normalizedTrigger || a.trigger), normalize(b.name || b.normalizedTrigger || b.trigger), 'asc');
      if (sort === 'name_desc') return sortCompare(normalize(a.name || a.normalizedTrigger || a.trigger), normalize(b.name || b.normalizedTrigger || b.trigger), 'desc');
      if (sort === 'counter_desc') return sortCompare(Number(a.counter || 0), Number(b.counter || 0), 'desc');
      if (sort === 'counter_asc') return sortCompare(Number(a.counter || 0), Number(b.counter || 0), 'asc');
      return sortCompare(new Date(a.createdAt || 0).getTime(), new Date(b.createdAt || 0).getTime(), 'asc');
    });
  }

  function filteredTimers() {
    const search = normalize(timerFilters.search);
    const list = timers.filter((timer) => {
      if (!search) return true;
      const haystack = [timer.name, timer.priority, timer.waitingFor, ...(timer.responses || [])].map(normalize).join(' ');
      return haystack.includes(search);
    });
    return [...list].sort((a, b) => {
      const sort = timerFilters.sort || 'created_asc';
      if (sort === 'created_desc') return sortCompare(new Date(a.createdAt || 0).getTime(), new Date(b.createdAt || 0).getTime(), 'desc');
      if (sort === 'name_asc') return sortCompare(normalize(a.name), normalize(b.name), 'asc');
      if (sort === 'name_desc') return sortCompare(normalize(a.name), normalize(b.name), 'desc');
      if (sort === 'interval_asc') return sortCompare(Number(a.intervalSeconds || 0), Number(b.intervalSeconds || 0), 'asc');
      if (sort === 'interval_desc') return sortCompare(Number(a.intervalSeconds || 0), Number(b.intervalSeconds || 0), 'desc');
      return sortCompare(new Date(a.createdAt || 0).getTime(), new Date(b.createdAt || 0).getTime(), 'asc');
    });
  }

  async function loadCommands() {
    const d = await postJson('/youtube/custom-commands/list', {});
    if (!d.success) throw new Error(d.error || 'Could not load YouTube custom commands.');
    commands = d.commands || [];
    commandSettings = d.settings || { globalCooldownSeconds: 5 };
    $('youtubeGlobalCooldown').value = Number(commandSettings.globalCooldownSeconds || 0);
    renderCommands();
  }

  function renderCommands() {
    const list = $('youtubeCommandList');
    const filtered = filteredCommands();
    const { page, pageSize: size } = updatePagination({
      totalItems: filtered.length,
      page: commandPage,
      setPage: (value) => { commandPage = value; },
      pageSizeId: 'youtubeCommandPageSize',
      labelId: 'youtubeCommandPageLabel',
      prevId: 'youtubeCommandPrevPage',
      nextId: 'youtubeCommandNextPage',
      paginationId: 'youtubeCommandPagination',
      sourceCount: commands.length
    });
    const items = filtered.slice((page - 1) * size, page * size);
    if (!commands.length) {
      list.innerHTML = '<div class="coming-soon custom-empty-state">No custom commands yet. Add one to get started.</div>';
      return;
    }
    if (!items.length) {
      list.innerHTML = '<div class="coming-soon custom-empty-state">No custom commands match the current filters.</div>';
      return;
    }
    list.innerHTML = items.map((command) => {
      const triggers = commandTriggerValues(command);
      const primaryTrigger = triggers[0] || command.normalizedTrigger || command.trigger || '!command';
      const enabled = command.enabled !== false;
      const responseCount = Array.isArray(command.responses) ? command.responses.length : 0;
      const triggerChips = triggers.map((trigger) => `<span class="custom-trigger-chip"><strong>${esc(trigger)}</strong><small>!Command</small></span>`).join('');
      return `
        <div class="custom-command-card" data-youtube-command-id="${esc(command._id)}">
          <div class="custom-command-card-main">
            <div class="custom-command-title-row">
              <strong class="custom-command-name">${esc(command.name || primaryTrigger)}</strong>
              <span class="custom-command-state ${enabled ? 'enabled' : 'disabled'}">${enabled ? 'Enabled' : 'Disabled'}</span>
              ${userLevelBadgeHtml(command.userLevel)}
            </div>
            ${command.publicDescription ? `<div class="readonly-command-description">${esc(command.publicDescription)}</div>` : ''}
            <div class="custom-trigger-chip-list">${triggerChips}</div>
            <div class="detail">${triggers.length} trigger${triggers.length === 1 ? '' : 's'} · ${Number(command.probability ?? 100)}% chance · ${Number(command.cooldownSeconds || 0)}s cooldown · ${Number(command.responseDelaySeconds || 0)}s delay · ${responseCount} response${responseCount === 1 ? '' : 's'} · ${esc(responseModeLabel(command.responseMode))} · Counter: ${Number(command.counter || 0)}</div>
          </div>
          <div class="custom-command-actions">
            <button class="secondary youtube-command-edit-btn" type="button">Edit</button>
            <button class="secondary youtube-command-toggle-btn" type="button">${enabled ? 'Disable' : 'Enable'}</button>
            <button class="danger youtube-command-delete-btn" type="button">Delete</button>
          </div>
        </div>`;
    }).join('');
    list.querySelectorAll('[data-youtube-command-id]').forEach((card) => {
      const command = commands.find((item) => String(item._id) === String(card.dataset.youtubeCommandId));
      card.querySelector('.youtube-command-edit-btn').onclick = () => openCommandDialog(command?._id);
      card.querySelector('.youtube-command-toggle-btn').onclick = () => void toggleCommand(command);
      card.querySelector('.youtube-command-delete-btn').onclick = () => void deleteCommand(command?._id);
    });
  }

  function commandTriggerValues(command) {
    const raw = Array.isArray(command?.triggers) && command.triggers.length
      ? command.triggers
      : [command?.normalizedTrigger || command?.trigger];
    const seen = new Set();
    const result = [];
    for (const value of raw) {
      let trigger = String(value || '').trim().toLowerCase();
      if (!trigger) continue;
      if (!trigger.startsWith('!')) trigger = `!${trigger}`;
      if (seen.has(trigger)) continue;
      seen.add(trigger);
      result.push(trigger);
    }
    return result;
  }

  function updateYoutubeTriggerUi() {
    const container = $('youtubeCommandTriggers');
    if (!container) return;
    const count = container.children.length;
    $('youtubeCommandTriggerHelp').textContent = `${count}/${MAX_TRIGGERS} triggers`;
    $('addYoutubeCommandTriggerBtn').disabled = count >= MAX_TRIGGERS;
    container.querySelectorAll('.youtube-command-trigger-remove').forEach((button) => { button.disabled = count <= 1; });
  }

  function youtubeTriggerRow(value = '!') {
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-trigger-row';
    wrapper.innerHTML = `
      <select aria-label="Trigger type" disabled><option>!Command</option></select>
      <input class="youtube-command-trigger-input" type="text" maxlength="50" placeholder="Example: !discord" aria-label="YouTube command trigger">
      <button class="secondary youtube-command-trigger-remove" type="button">Remove</button>`;
    wrapper.querySelector('.youtube-command-trigger-input').value = value || '!';
    wrapper.querySelector('.youtube-command-trigger-remove').onclick = () => {
      const container = $('youtubeCommandTriggers');
      if (container.children.length <= 1) {
        setMessage('youtubeCommandTriggerMsg', 'A custom command needs at least one trigger.', true);
        return;
      }
      wrapper.remove();
      setMessage('youtubeCommandTriggerMsg', '');
      updateYoutubeTriggerUi();
    };
    return wrapper;
  }

  function addYoutubeTrigger(value = '!') {
    const container = $('youtubeCommandTriggers');
    if (!container || container.children.length >= MAX_TRIGGERS) return;
    container.appendChild(youtubeTriggerRow(value));
    updateYoutubeTriggerUi();
  }

  function youtubeTriggerPayload() {
    const inputs = [...$('youtubeCommandTriggers').querySelectorAll('.youtube-command-trigger-input')];
    const seen = new Set();
    const values = [];
    for (const input of inputs) {
      let trigger = String(input.value || '').trim().toLowerCase();
      if (!trigger) continue;
      if (!trigger.startsWith('!')) trigger = `!${trigger}`;
      if (seen.has(trigger)) continue;
      seen.add(trigger);
      values.push(trigger);
    }
    return values;
  }

  function commandResponseMode() {
    return $('youtubeCommandResponseMode').value || 'equal';
  }

  function youtubeResponseRow(value = '', weight = 1, kind = 'command') {
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-response-row';
    wrapper.innerHTML = `
      <div class="custom-response-rule-row">
        <label class="custom-response-weight-wrap">Weight
          <input class="custom-response-weight" type="number" min="0" step="0.01" value="${escAttr(weight ?? 1)}">
        </label>
      </div>
      <textarea class="custom-response-input" maxlength="${MAX_RESPONSE_LENGTH}" placeholder="${kind === 'timer' ? 'Action text...' : 'Response text...'}"></textarea>
      <div class="custom-response-footer">
        <span class="detail custom-response-count">0/${MAX_RESPONSE_LENGTH}</span>
        <button class="secondary custom-response-remove" type="button">Remove</button>
      </div>`;
    const input = wrapper.querySelector('.custom-response-input');
    const count = wrapper.querySelector('.custom-response-count');
    input.value = value || '';
    const updateCount = () => { count.textContent = `${input.value.length}/${MAX_RESPONSE_LENGTH}`; updateYoutubeResponseUi(kind); };
    input.addEventListener('input', updateCount);
    wrapper.querySelector('.custom-response-remove').onclick = () => {
      const container = kind === 'timer' ? $('youtubeTimerResponses') : $('youtubeCommandResponses');
      if (container.children.length <= 1) {
        setMessage(kind === 'timer' ? 'youtubeTimerResponsesMsg' : 'youtubeCommandResponsesMsg', `A ${kind === 'timer' ? 'timer' : 'command'} needs at least one ${kind === 'timer' ? 'action' : 'response'}.`, true);
        return;
      }
      wrapper.remove();
      setMessage(kind === 'timer' ? 'youtubeTimerResponsesMsg' : 'youtubeCommandResponsesMsg', '');
      updateYoutubeResponseUi(kind);
    };
    updateCount();
    return wrapper;
  }

  function addYoutubeResponse(kind, value = '', weight = 1) {
    const container = kind === 'timer' ? $('youtubeTimerResponses') : $('youtubeCommandResponses');
    if (container.children.length >= MAX_RESPONSES) return;
    container.appendChild(youtubeResponseRow(value, weight, kind));
    updateYoutubeResponseUi(kind);
  }

  function updateYoutubeResponseUi(kind) {
    const isTimer = kind === 'timer';
    const container = $(isTimer ? 'youtubeTimerResponses' : 'youtubeCommandResponses');
    const modeEl = $(isTimer ? 'youtubeTimerResponseMode' : 'youtubeCommandResponseMode');
    const mode = modeEl?.value || 'equal';
    container?.querySelectorAll('.custom-response-weight-wrap').forEach((el) => { el.hidden = mode !== 'weighted'; });
    const nonblank = container ? [...container.querySelectorAll('.custom-response-input')].filter((input) => input.value.trim()).length : 0;
    const avoidWrap = $(isTimer ? 'youtubeTimerAvoidRepeatWrap' : 'youtubeCommandAvoidRepeatWrap');
    if (avoidWrap) avoidWrap.hidden = !(mode === 'equal' && nonblank >= 2);
    const help = $(isTimer ? 'youtubeTimerResponseModeHelp' : 'youtubeCommandResponseModeHelp');
    if (help) help.textContent = mode === 'weighted' ? 'Chosen proportionally by weight.' : '';
    const addButton = $(isTimer ? 'addYoutubeTimerResponseBtn' : 'addYoutubeCommandResponseBtn');
    if (addButton && container) addButton.disabled = container.children.length >= MAX_RESPONSES;
  }

  function responsePayload(kind) {
    const isTimer = kind === 'timer';
    const container = $(isTimer ? 'youtubeTimerResponses' : 'youtubeCommandResponses');
    const rows = [...container.querySelectorAll('.custom-response-row')];
    const pairs = rows.map((row) => ({
      response: row.querySelector('.custom-response-input').value.trim(),
      weight: Number(row.querySelector('.custom-response-weight').value || 1)
    })).filter((item) => item.response);
    return { responses: pairs.map((item) => item.response), weights: pairs.map((item) => item.weight) };
  }

  function syncCommandDescriptionCount() {
    const value = $('youtubeCommandDescription').value || '';
    $('youtubeCommandDescriptionCount').textContent = `${value.length}/300 characters`;
  }

  function openCommandDialog(id = '') {
    const command = commands.find((item) => String(item._id) === String(id));
    $('youtubeCommandId').value = command?._id || '';
    const triggers = commandTriggerValues(command);
    $('youtubeCommandDialogTitle').textContent = command ? `Edit ${command.name || triggers[0] || command.normalizedTrigger || command.trigger}` : 'Add Custom Command';
    $('youtubeCommandName').value = command?.name || '';
    $('youtubeCommandTriggers').innerHTML = '';
    (triggers.length ? triggers : ['!']).forEach(addYoutubeTrigger);
    $('youtubeCommandDescription').value = command?.publicDescription || '';
    $('youtubeCommandUserLevel').value = command?.userLevel || 'everyone';
    $('youtubeCommandCooldown').value = Number(command?.cooldownSeconds ?? 5);
    $('youtubeCommandProbability').value = Number(command?.probability ?? 100);
    $('youtubeCommandDelay').value = Number(command?.responseDelaySeconds ?? 0);
    $('youtubeCommandResponseMode').value = command?.responseMode === 'weighted' ? 'weighted' : 'equal';
    $('youtubeCommandAvoidRepeat').checked = Boolean(command?.avoidImmediateRepeat);
    $('youtubeCommandEnabled').checked = command ? command.enabled !== false : true;
    $('youtubeCommandResponses').innerHTML = '';
    const values = Array.isArray(command?.responses) && command.responses.length ? command.responses : [''];
    values.forEach((value, index) => addYoutubeResponse('command', value, command?.responseWeights?.[index] ?? 1));
    setMessage('youtubeCommandDialogMsg', '');
    setMessage('youtubeCommandTriggerMsg', '');
    setMessage('youtubeCommandResponsesMsg', '');
    syncCommandDescriptionCount();
    updateYoutubeTriggerUi();
    updateYoutubeResponseUi('command');
    openDialog('youtubeCommandDialog');
  }

  function closeCommandDialog() { closeDialog('youtubeCommandDialog'); }

  async function saveCommand() {
    setMessage('youtubeCommandDialogMsg', 'Saving...');
    const payload = responsePayload('command');
    const triggers = youtubeTriggerPayload();
    if (!triggers.length) {
      setMessage('youtubeCommandDialogMsg', '');
      setMessage('youtubeCommandTriggerMsg', 'Add at least one trigger.', true);
      return;
    }
    setMessage('youtubeCommandTriggerMsg', '');
    const body = {
      id: $('youtubeCommandId').value || undefined,
      name: $('youtubeCommandName').value,
      triggers,
      publicDescription: $('youtubeCommandDescription').value,
      responses: payload.responses,
      responseWeights: payload.weights,
      responseMode: commandResponseMode(),
      userLevel: $('youtubeCommandUserLevel').value,
      cooldownSeconds: Number($('youtubeCommandCooldown').value || 0),
      probability: Number($('youtubeCommandProbability').value || 100),
      responseDelaySeconds: Number($('youtubeCommandDelay').value || 0),
      avoidImmediateRepeat: $('youtubeCommandAvoidRepeat').checked,
      enabled: $('youtubeCommandEnabled').checked
    };
    const d = await postJson('/youtube/custom-commands/save', body);
    if (!d.success) { setMessage('youtubeCommandDialogMsg', d.error, true); return; }
    closeCommandDialog();
    await loadCommands();
    setMessage('youtubeCommandsMsg', 'Saved.');
  }

  async function toggleCommand(command) {
    if (!command) return;
    const d = await postJson('/youtube/custom-commands/save', {
      id: command._id,
      name: command.name,
      triggers: commandTriggerValues(command),
      publicDescription: command.publicDescription || '',
      responses: command.responses || [],
      responseMode: command.responseMode || 'equal',
      responseWeights: command.responseWeights || [],
      userLevel: command.userLevel || 'everyone',
      cooldownSeconds: Number(command.cooldownSeconds || 0),
      probability: Number(command.probability ?? 100),
      responseDelaySeconds: Number(command.responseDelaySeconds || 0),
      avoidImmediateRepeat: Boolean(command.avoidImmediateRepeat),
      enabled: command.enabled === false
    });
    if (!d.success) { setMessage('youtubeCommandsMsg', d.error, true); return; }
    await loadCommands();
  }

  async function deleteCommand(id) {
    if (!id || !confirm('Delete this custom command?')) return;
    const d = await postJson('/youtube/custom-commands/delete', { id });
    if (!d.success) { setMessage('youtubeCommandsMsg', d.error, true); return; }
    await loadCommands();
    setMessage('youtubeCommandsMsg', 'Deleted.');
  }

  async function loadTimers() {
    const d = await postJson('/youtube/timers/list', {});
    if (!d.success) throw new Error(d.error || 'Could not load YouTube timers.');
    timers = d.timers || [];
    renderTimers();
  }

  function renderTimers() {
    const list = $('youtubeTimerList');
    const filtered = filteredTimers();
    const { page, pageSize: size } = updatePagination({
      totalItems: filtered.length,
      page: timerPage,
      setPage: (value) => { timerPage = value; },
      pageSizeId: 'youtubeTimerPageSize',
      labelId: 'youtubeTimerPageLabel',
      prevId: 'youtubeTimerPrevPage',
      nextId: 'youtubeTimerNextPage',
      paginationId: 'youtubeTimerPagination',
      sourceCount: timers.length
    });
    const items = filtered.slice((page - 1) * size, page * size);
    if (!timers.length) {
      list.innerHTML = '<div class="custom-empty-state detail">No timers yet.</div>';
      return;
    }
    if (!items.length) {
      list.innerHTML = '<div class="custom-empty-state detail">No timers match your search.</div>';
      return;
    }
    list.innerHTML = items.map((item) => {
      const enabled = item.enabled !== false;
      const responseCount = Array.isArray(item.responses) ? item.responses.length : 0;
      const jitter = Number(item.jitterSeconds || 0) > 0 ? ` · ±${formatInterval(item.jitterSeconds)} jitter` : '';
      const activity = [];
      if (Number(item.minimumChatMessages || 0) > 0) activity.push(`${Number(item.messagesSinceLastFire || 0)}/${Number(item.minimumChatMessages || 0)} chat messages`);
      if (Number(item.minimumViewers || 0) > 0) activity.push(`${item.currentViewerCount === null || item.currentViewerCount === undefined ? '—' : Number(item.currentViewerCount)}/${Number(item.minimumViewers || 0)} viewers`);
      const activityText = activity.length ? activity.join(' · ') : 'No activity minimums';
      const startDelayText = item.startDelaySeconds === null || item.startDelaySeconds === undefined
        ? `Global start delay (${formatInterval(item.effectiveStartDelaySeconds || 0)})`
        : `Start delay ${formatInterval(item.startDelaySeconds)}`;
      const waiting = item.waitingFor ? ` · Waiting for: ${item.waitingFor}` : '';
      return `
        <div class="custom-command-card timer-card" data-youtube-timer-id="${esc(item._id)}">
          <div class="custom-command-card-main">
            <div class="custom-command-title-row">
              <strong class="custom-command-name">${esc(item.name || 'Timer')}</strong>
              <span class="custom-command-state ${enabled ? 'enabled' : 'disabled'}">${enabled ? 'Enabled' : 'Disabled'}</span>
            </div>
            <div class="detail">Every ${esc(formatInterval(item.intervalSeconds))}${esc(jitter)} · ${esc(priorityLabel(item.priority))} priority · ${responseCount} action${responseCount === 1 ? '' : 's'} · ${esc(responseModeLabel(item.responseMode))}</div>
            <div class="detail">${esc(startDelayText)} · ${esc(activityText)}</div>
            <div class="detail">Last fired: ${esc(fmtTime(item.lastFiredAt))} · Next eligible time: ${esc(fmtTime(item.nextDueAt))}${esc(waiting)}</div>
            <div class="detail">Times fired: ${Number(item.timesFired || 0)}${item.lastResponse ? ` · Last action: ${esc(item.lastResponse)}` : ''}</div>
          </div>
          <div class="custom-command-actions timer-card-actions">
            <button class="secondary youtube-timer-fire-btn" type="button">Fire Now</button>
            <button class="secondary youtube-timer-edit-btn" type="button">Edit</button>
            <button class="secondary youtube-timer-toggle-btn" type="button">${enabled ? 'Disable' : 'Enable'}</button>
            <button class="danger youtube-timer-delete-btn" type="button">Delete</button>
          </div>
        </div>`;
    }).join('');
    list.querySelectorAll('[data-youtube-timer-id]').forEach((card) => {
      const timer = timers.find((item) => String(item._id) === String(card.dataset.youtubeTimerId));
      card.querySelector('.youtube-timer-fire-btn').onclick = () => void fireTimer(timer?._id);
      card.querySelector('.youtube-timer-edit-btn').onclick = () => openTimerDialog(timer?._id);
      card.querySelector('.youtube-timer-toggle-btn').onclick = () => void toggleTimer(timer);
      card.querySelector('.youtube-timer-delete-btn').onclick = () => void deleteTimer(timer?._id);
    });
  }

  function openTimerDialog(id = '') {
    const item = timers.find((timer) => String(timer._id) === String(id));
    $('youtubeTimerId').value = item?._id || '';
    $('youtubeTimerDialogTitle').textContent = item ? `Edit ${item.name}` : 'Add Timer';
    $('youtubeTimerName').value = item?.name || '';
    $('youtubeTimerInterval').value = String(Number(item?.intervalSeconds ?? 900));
    $('youtubeTimerStartDelay').value = item?.startDelaySeconds === null || item?.startDelaySeconds === undefined ? '' : String(Number(item.startDelaySeconds));
    $('youtubeTimerStartDelay').min = String(Number(adminState?.config?.globalTimerStartDelaySeconds || 0));
    $('youtubeTimerJitter').value = String(Number(item?.jitterSeconds || 0));
    $('youtubeTimerPriority').value = ['high', 'normal', 'low'].includes(item?.priority) ? item.priority : 'normal';
    $('youtubeTimerMinimumMessages').value = String(Number(item?.minimumChatMessages || 0));
    $('youtubeTimerMinimumViewers').value = String(Number(item?.minimumViewers || 0));
    $('youtubeTimerResponseMode').value = item?.responseMode === 'weighted' ? 'weighted' : 'equal';
    $('youtubeTimerAvoidRepeat').checked = Boolean(item?.avoidImmediateRepeat);
    $('youtubeTimerEnabled').checked = item ? item.enabled !== false : true;
    $('youtubeTimerResponses').innerHTML = '';
    const values = Array.isArray(item?.responses) && item.responses.length ? item.responses : [''];
    values.forEach((value, index) => addYoutubeResponse('timer', value, item?.responseWeights?.[index] ?? 1));
    setMessage('youtubeTimerDialogMsg', '');
    setMessage('youtubeTimerScheduleMsg', '');
    setMessage('youtubeTimerActivityMsg', '');
    setMessage('youtubeTimerResponsesMsg', '');
    updateYoutubeResponseUi('timer');
    openDialog('youtubeTimerDialog');
  }

  function closeTimerDialog() { closeDialog('youtubeTimerDialog'); }

  async function saveTimer() {
    setMessage('youtubeTimerDialogMsg', 'Saving...');
    setMessage('youtubeTimerScheduleMsg', '');
    setMessage('youtubeTimerActivityMsg', '');
    const name = $('youtubeTimerName').value.trim();
    if (!name) {
      setMessage('youtubeTimerDialogMsg', 'Name is required.', true);
      return;
    }
    if (name.length > 80) {
      setMessage('youtubeTimerDialogMsg', 'Name can contain at most 80 characters.', true);
      return;
    }
    const payload = responsePayload('timer');
    const intervalSeconds = Number($('youtubeTimerInterval').value);
    const startDelayRaw = $('youtubeTimerStartDelay').value.trim();
    const startDelaySeconds = startDelayRaw === '' ? null : Number(startDelayRaw);
    const jitterSeconds = Number($('youtubeTimerJitter').value);
    const minimumChatMessages = Number($('youtubeTimerMinimumMessages').value);
    const minimumViewers = Number($('youtubeTimerMinimumViewers').value);
    const globalDelay = Number(adminState?.config?.globalTimerStartDelaySeconds || 0);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 86400) {
      setMessage('youtubeTimerDialogMsg', '');
      return setMessage('youtubeTimerScheduleMsg', 'Interval must be between 30 and 86400 seconds.', true);
    }
    if (startDelaySeconds !== null && (!Number.isInteger(startDelaySeconds) || startDelaySeconds < globalDelay || startDelaySeconds > 86400)) {
      setMessage('youtubeTimerDialogMsg', '');
      return setMessage('youtubeTimerScheduleMsg', `Start Delay must be blank or a whole number from the global delay (${globalDelay}s) through 86400s.`, true);
    }
    if (!Number.isInteger(jitterSeconds) || jitterSeconds < 0 || jitterSeconds > 86400) {
      setMessage('youtubeTimerDialogMsg', '');
      return setMessage('youtubeTimerScheduleMsg', 'Jitter must be a whole number between 0 and 86400 seconds.', true);
    }
    if (!Number.isInteger(minimumChatMessages) || minimumChatMessages < 0 || minimumChatMessages > 100000) {
      setMessage('youtubeTimerDialogMsg', '');
      return setMessage('youtubeTimerActivityMsg', 'Min Messages must be a whole number between 0 and 100000.', true);
    }
    if (!Number.isInteger(minimumViewers) || minimumViewers < 0 || minimumViewers > 1000000) {
      setMessage('youtubeTimerDialogMsg', '');
      return setMessage('youtubeTimerActivityMsg', 'Min Viewers must be a whole number between 0 and 1000000.', true);
    }
    const body = {
      id: $('youtubeTimerId').value || undefined,
      name,
      responses: payload.responses,
      responseWeights: payload.weights,
      responseMode: $('youtubeTimerResponseMode').value || 'equal',
      intervalSeconds,
      startDelaySeconds,
      jitterSeconds,
      priority: $('youtubeTimerPriority').value || 'normal',
      minimumChatMessages,
      minimumViewers,
      avoidImmediateRepeat: $('youtubeTimerAvoidRepeat').checked,
      enabled: $('youtubeTimerEnabled').checked
    };
    const d = await postJson('/youtube/timers/save', body);
    if (!d.success) { setMessage('youtubeTimerDialogMsg', d.error, true); return; }
    closeTimerDialog();
    await loadTimers();
    setMessage('youtubeTimersMsg', 'Saved.');
  }

  async function toggleTimer(timer) {
    if (!timer) return;
    const d = await postJson('/youtube/timers/save', {
      id: timer._id,
      name: timer.name,
      responses: timer.responses || [],
      responseMode: timer.responseMode || 'equal',
      responseWeights: timer.responseWeights || [],
      intervalSeconds: Number(timer.intervalSeconds || 900),
      startDelaySeconds: timer.startDelaySeconds === null || timer.startDelaySeconds === undefined ? null : Number(timer.startDelaySeconds),
      jitterSeconds: Number(timer.jitterSeconds || 0),
      priority: timer.priority || 'normal',
      minimumChatMessages: Number(timer.minimumChatMessages || 0),
      minimumViewers: Number(timer.minimumViewers || 0),
      avoidImmediateRepeat: Boolean(timer.avoidImmediateRepeat),
      enabled: timer.enabled === false
    });
    if (!d.success) { setMessage('youtubeTimersMsg', d.error, true); return; }
    await loadTimers();
  }

  async function deleteTimer(id) {
    if (!id || !confirm('Delete this timer?')) return;
    const d = await postJson('/youtube/timers/delete', { id });
    if (!d.success) { setMessage('youtubeTimersMsg', d.error, true); return; }
    await loadTimers();
    setMessage('youtubeTimersMsg', 'Deleted.');
  }

  async function fireTimer(id) {
    if (!id) return;
    setMessage('youtubeTimersMsg', 'Sending to active YouTube chat(s)...');
    const d = await postJson('/youtube/timers/fire', { id });
    if (!d.success) { setMessage('youtubeTimersMsg', d.error, true); return; }
    setMessage('youtubeTimersMsg', `Sent to ${d.result?.sentCount || 0} active chat(s)${d.result?.failedCount ? `; ${d.result.failedCount} failed` : ''}.`);
    await Promise.all([loadTimers(), refreshAdminState().catch(() => {})]);
  }

  function renderNativeCard() {
    const enabled = nativeConfig?.commandsEnabled !== false;
    const status = $('youtubeNativeCommandStatus');
    if (status) {
      status.textContent = enabled ? 'Enabled' : 'Disabled';
      status.classList.toggle('enabled', enabled);
    }
  }

  function populateNativeDialog(config = nativeConfig) {
    $('youtubeNativeCommandsEnabled').checked = config?.commandsEnabled !== false;
    $('youtubeNativeCommandsResponse').value = config?.commandsResponse || nativeDefaults.commandsResponse || '';
  }

  async function loadNative({ populateDialog = false } = {}) {
    const d = await postJson('/youtube/native/get', {});
    if (!d.success) throw new Error(d.error || 'Could not load !commands.');
    nativeConfig = {
      commandsEnabled: d.config?.commandsEnabled !== false,
      commandsResponse: d.config?.commandsResponse || ''
    };
    nativeDefaults = {
      commandsEnabled: d.defaults?.commandsEnabled !== false,
      commandsResponse: d.defaults?.commandsResponse || nativeConfig.commandsResponse || ''
    };
    renderNativeCard();
    if (populateDialog) populateNativeDialog(nativeConfig);
    return nativeConfig;
  }

  async function openNativeDialog() {
    setMessage('youtubeNativeListMsg', '');
    setMessage('youtubeNativeMsg', 'Loading...');
    try {
      await loadNative({ populateDialog: true });
      setMessage('youtubeNativeMsg', '');
      openDialog('youtubeNativeResponseDialog');
    } catch (err) {
      setMessage('youtubeNativeListMsg', err.message || 'Could not load !commands.', true);
    }
  }

  function closeNativeDialog() {
    closeDialog('youtubeNativeResponseDialog');
  }

  async function saveNative() {
    setMessage('youtubeNativeMsg', 'Saving...');
    const d = await postJson('/youtube/native/save', {
      commandsEnabled: $('youtubeNativeCommandsEnabled').checked,
      commandsResponse: $('youtubeNativeCommandsResponse').value
    });
    if (!d.success) {
      setMessage('youtubeNativeMsg', d.error || 'Could not save !commands.', true);
      return;
    }
    nativeConfig = {
      commandsEnabled: d.config?.commandsEnabled !== false,
      commandsResponse: d.config?.commandsResponse || ''
    };
    populateNativeDialog(nativeConfig);
    renderNativeCard();
    setMessage('youtubeNativeMsg', 'Saved.');
    setMessage('youtubeNativeListMsg', '');
  }

  function resetNative() {
    populateNativeDialog(nativeDefaults);
    setMessage('youtubeNativeMsg', 'Defaults loaded. Save to apply them.');
  }

  function selectAutomationView(view) {
    activeAutomationView = view;
    for (const [key, tab, panel] of [
      ['commands', 'youtubeCustomCommandsViewTab', 'youtubeCustomCommandsView'],
      ['timers', 'youtubeTimersViewTab', 'youtubeTimersView'],
      ['native', 'youtubeNativeCommandsViewTab', 'youtubeNativeCommandsView']
    ]) {
      $(tab).classList.toggle('active', key === view);
      $(panel).classList.toggle('open', key === view);
    }
    if (view === 'commands') void loadCommands().catch((e) => setMessage('youtubeCommandsMsg', e.message, true));
    if (view === 'timers') void loadTimers().catch((e) => setMessage('youtubeTimersMsg', e.message, true));
    if (view === 'native') void loadNative().catch((e) => setMessage('youtubeNativeListMsg', e.message, true));
  }

  async function saveGlobalTimerSettings() {
    const value = Number($('youtubeGlobalTimerStartDelay').value);
    if (!Number.isInteger(value) || value < 0 || value > 86400) {
      return setMessage('youtubeTimerSettingsMsg', 'Global Start Delay must be a whole number between 0 and 86400 seconds.', true);
    }
    const button = $('saveYoutubeTimerSettingsBtn');
    const cfg = adminState?.config || {};
    button.disabled = true;
    setMessage('youtubeTimerSettingsMsg', 'Saving...');
    try {
      const d = await postJson('/youtube/admin/config', { ...cfg, globalTimerStartDelaySeconds: value });
      if (!d.success) throw new Error(d.error || 'Could not save YouTube timer settings.');
      if (adminState) adminState.config = { ...(adminState.config || {}), ...(d.config || {}) };
      setMessage('youtubeTimerSettingsMsg', 'Timer settings saved.');
      await refreshAdminState().catch(() => {});
    } catch (err) {
      setMessage('youtubeTimerSettingsMsg', err.message || 'Could not save YouTube timer settings.', true);
    } finally {
      button.disabled = false;
    }
  }

  async function saveControls() {
    const cfg = adminState?.config || {};
    setMessage('youtubeOauthMsg', 'Saving...');
    const d = await postJson('/youtube/admin/config', {
      ...cfg,
      enabled: $('youtubeBotEnabled').checked,
      commandsEnabled: $('youtubeCommandsEnabled').checked,
      timersEnabled: $('youtubeTimersEnabled').checked
    });
    setMessage('youtubeOauthMsg', d.success ? 'Saved.' : d.error, !d.success);
    if (d.success) await refreshAdminState().catch(() => {});
  }

  async function runPreflight() {
    const button = $('runYoutubePreflightBtn');
    const result = $('youtubePreflightResult');
    button.disabled = true;
    result.textContent = 'Running YouTube preflight...';
    try {
      const d = await postJson('/youtube/admin/preflight', {});
      if (!d.success) throw new Error(d.error || 'YouTube preflight failed.');
      const preflight = d.preflight || {};
      const labels = { environment: 'Environment', oauth: 'SqwertArmyBot OAuth', liveChatClient: 'Live chat client', broadcaster: 'Qwert channel' };
      result.innerHTML = Object.entries(preflight.checks || {}).map(([key, check]) => {
        const state = check?.ok ? 'PASS' : check?.skipped ? 'SKIPPED' : 'FAIL';
        return `<div><strong>${esc(labels[key] || key)}: ${state}</strong> — ${esc(check?.detail || '')}</div>`;
      }).join('') || 'No preflight results returned.';
      result.classList.remove('good', 'warn', 'bad');
      result.classList.add(preflight.ok ? 'good' : 'bad');
      await refreshAdminState().catch(() => {});
    } catch (err) {
      result.textContent = err.message;
      result.classList.remove('good', 'warn');
      result.classList.add('bad');
    } finally {
      button.disabled = false;
    }
  }

  async function saveQuotaSafety() {
    const cfg = adminState?.config || {};
    const mainDailyLimitUnits = Number($('youtubeMainQuotaLimit').value);
    const timerSafetyStopUnits = Number($('youtubeTimerQuotaStop').value);
    const hardSafetyStopUnits = Number($('youtubeHardQuotaStop').value);
    const searchSafetyStopCalls = Number($('youtubeSearchQuotaStop').value);
    if (!Number.isSafeInteger(mainDailyLimitUnits) || mainDailyLimitUnits < 550) return setMessage('youtubeQuotaMsg', 'Daily main quota limit must be a whole number of at least 550.', true);
    if (!Number.isSafeInteger(timerSafetyStopUnits) || timerSafetyStopUnits < 500 || timerSafetyStopUnits > mainDailyLimitUnits - 50) return setMessage('youtubeQuotaMsg', `Pause timers must be between 500 and ${Math.max(500, mainDailyLimitUnits - 50)}.`, true);
    if (!Number.isSafeInteger(hardSafetyStopUnits) || hardSafetyStopUnits < timerSafetyStopUnits + 50 || hardSafetyStopUnits > mainDailyLimitUnits) return setMessage('youtubeQuotaMsg', `Stop all bot sends must be at least 50 above the timer stop and no higher than ${mainDailyLimitUnits}.`, true);
    if (!Number.isSafeInteger(searchSafetyStopCalls) || searchSafetyStopCalls < 1 || searchSafetyStopCalls > 100) return setMessage('youtubeQuotaMsg', 'Discovery search safety limit must be between 1 and 100.', true);
    setMessage('youtubeQuotaMsg', 'Saving...');
    const d = await postJson('/youtube/admin/config', {
      ...cfg,
      mainDailyLimitUnits,
      timerSafetyStopUnits,
      hardSafetyStopUnits,
      searchSafetyStopCalls
    });
    setMessage('youtubeQuotaMsg', d.success ? 'Saved.' : d.error, !d.success);
    if (d.success) await refreshAdminState().catch(() => {});
  }

  $('youtubeCustomCommandsViewTab').onclick = () => selectAutomationView('commands');
  $('youtubeTimersViewTab').onclick = () => selectAutomationView('timers');
  $('youtubeNativeCommandsViewTab').onclick = () => selectAutomationView('native');

  $('youtubeCommandSearch').addEventListener('input', (e) => { commandFilters.search = e.target.value || ''; commandPage = 1; renderCommands(); });
  $('youtubeCommandUserLevelFilter').addEventListener('change', (e) => { commandFilters.userLevel = e.target.value || 'all'; commandPage = 1; renderCommands(); });
  $('youtubeCommandSort').addEventListener('change', (e) => { commandFilters.sort = e.target.value || 'created_asc'; commandPage = 1; renderCommands(); });
  $('youtubeCommandPageSize').addEventListener('change', () => { commandPage = 1; renderCommands(); });
  $('youtubeCommandPrevPage').onclick = () => { if (commandPage > 1) { commandPage -= 1; renderCommands(); } };
  $('youtubeCommandNextPage').onclick = () => { commandPage += 1; renderCommands(); };
  $('refreshYoutubeCommandsBtn').onclick = () => void loadCommands().then(() => setMessage('youtubeCommandsMsg', 'Refreshed.')).catch((e) => setMessage('youtubeCommandsMsg', e.message, true));

  $('youtubeTimerSearch').addEventListener('input', (e) => { timerFilters.search = e.target.value || ''; timerPage = 1; renderTimers(); });
  $('youtubeTimerSort').addEventListener('change', (e) => { timerFilters.sort = e.target.value || 'created_asc'; timerPage = 1; renderTimers(); });
  $('youtubeTimerPageSize').addEventListener('change', () => { timerPage = 1; renderTimers(); });
  $('youtubeTimerPrevPage').onclick = () => { if (timerPage > 1) { timerPage -= 1; renderTimers(); } };
  $('youtubeTimerNextPage').onclick = () => { timerPage += 1; renderTimers(); };
  $('refreshYoutubeTimersBtn').onclick = () => void loadTimers().then(() => setMessage('youtubeTimersMsg', 'Refreshed.')).catch((e) => setMessage('youtubeTimersMsg', e.message, true));
  $('saveYoutubeTimerSettingsBtn').onclick = () => void saveGlobalTimerSettings();

  $('addYoutubeCommandBtn').onclick = () => openCommandDialog();
  $('closeYoutubeCommandDialogBtn').onclick = closeCommandDialog;
  $('cancelYoutubeCommandDialogBtn').onclick = closeCommandDialog;
  $('saveYoutubeCommandBtn').onclick = () => void saveCommand();
  $('youtubeCommandDialog').addEventListener('click', (e) => { if (e.target === $('youtubeCommandDialog')) closeCommandDialog(); });
  $('youtubeCommandDialog').addEventListener('close', () => $('youtubeCommandDialog').classList.remove('open'));
  $('youtubeCommandDescription').addEventListener('input', syncCommandDescriptionCount);
  $('addYoutubeCommandTriggerBtn').onclick = () => addYoutubeTrigger('!');
  $('youtubeCommandResponseMode').addEventListener('change', () => updateYoutubeResponseUi('command'));
  $('addYoutubeCommandResponseBtn').onclick = () => addYoutubeResponse('command');
  $('showYoutubeCommandVariablesBtn').onclick = () => openDialog('youtubeCommandVariablesDialog');
  $('closeYoutubeCommandVariablesBtn').onclick = () => closeDialog('youtubeCommandVariablesDialog');
  $('youtubeCommandVariablesDialog').addEventListener('click', (e) => { if (e.target === $('youtubeCommandVariablesDialog')) closeDialog('youtubeCommandVariablesDialog'); });

  $('saveYoutubeGlobalCooldownBtn').onclick = async () => {
    const d = await postJson('/youtube/custom-commands/settings', { globalCooldownSeconds: Number($('youtubeGlobalCooldown').value || 0) });
    setMessage('youtubeCommandsMsg', d.success ? 'Global cooldown saved.' : d.error, !d.success);
  };

  $('addYoutubeTimerBtn').onclick = () => openTimerDialog();
  $('closeYoutubeTimerDialogBtn').onclick = closeTimerDialog;
  $('cancelYoutubeTimerDialogBtn').onclick = closeTimerDialog;
  $('saveYoutubeTimerBtn').onclick = () => void saveTimer();
  $('youtubeTimerDialog').addEventListener('click', (e) => { if (e.target === $('youtubeTimerDialog')) closeTimerDialog(); });
  $('youtubeTimerDialog').addEventListener('close', () => $('youtubeTimerDialog').classList.remove('open'));
  $('youtubeTimerResponseMode').addEventListener('change', () => updateYoutubeResponseUi('timer'));
  $('addYoutubeTimerResponseBtn').onclick = () => addYoutubeResponse('timer');

  $('youtubeNativeResponseEditBtn').onclick = () => void openNativeDialog();
  $('closeYoutubeNativeResponseDialogBtn').onclick = closeNativeDialog;
  $('saveYoutubeNativeBtn').onclick = () => void saveNative();
  $('resetYoutubeNativeBtn').onclick = resetNative;
  $('youtubeNativeResponseDialog').addEventListener('click', (e) => { if (e.target === $('youtubeNativeResponseDialog')) closeNativeDialog(); });
  $('youtubeNativeResponseDialog').addEventListener('close', () => $('youtubeNativeResponseDialog').classList.remove('open'));
  $('youtubeAuthorizeBtn').onclick = () => { location.href = '/auth/youtube/start'; };
  $('youtubeDisconnectBtn').onclick = async () => {
    if (!confirm('Disconnect SqwertArmyBot from YouTube OAuth?')) return;
    const d = await postJson('/youtube/oauth/disconnect', {});
    setMessage('youtubeOauthMsg', d.success ? 'Disconnected.' : d.error, !d.success);
    if (d.success) await refreshAdminState().catch(() => {});
  };
  $('youtubeRediscoverBtn').onclick = async () => {
    setMessage('youtubeOauthMsg', 'Discovering active broadcasts...');
    const d = await postJson('/youtube/admin/rediscover', {});
    setMessage('youtubeOauthMsg', d.success ? `Found ${d.discovery?.broadcasts?.length || 0} broadcast(s), ${d.discovery?.chats?.length || 0} distinct chat(s).` : d.error, !d.success);
    await refreshAdminState().catch(() => {});
  };
  $('saveYoutubeControlsBtn').onclick = () => void saveControls();
  $('runYoutubePreflightBtn').onclick = () => void runPreflight();
  $('saveYoutubeQuotaBtn').onclick = () => void saveQuotaSafety();
  $('refreshYoutubeDiagnosticsBtn').onclick = () => void refreshAdminState({ messageTarget: 'youtubeQuotaMsg' });

  return {
    refreshAdminState,
    onAutomationVisibilityChange(open) { if (open) { void refreshAdminState().catch(() => {}); selectAutomationView(activeAutomationView); } },
    onOauthVisibilityChange(open) { if (open) void refreshAdminState({ messageTarget: 'youtubeOauthMsg' }).catch(() => {}); },
    onDiagnosticsVisibilityChange(open) { if (open) void refreshAdminState({ messageTarget: 'youtubeQuotaMsg' }).catch(() => {}); },
    selectAutomationView
  };
}
