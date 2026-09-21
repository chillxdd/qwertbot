export function initYoutubeSection({ $, esc, postJson }) {
  let adminState = null;
  let commands = [];
  let timers = [];
  let commandSettings = { globalCooldownSeconds: 5 };
  let activeAutomationView = 'commands';

  const responseLines = (value) => String(value || '').split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
  const fmtTime = (value) => value ? new Date(value).toLocaleString() : '—';
  const setValue = (id, text, state = '') => {
    const el = $(id); if (!el) return;
    el.textContent = text;
    el.classList.remove('good', 'warn', 'bad');
    if (state) el.classList.add(state);
  };

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
    const connected = chats.filter((chat) => chat.state === 'connected').length;
    let liveText = 'SLEEPING'; let liveState = 'warn';
    if (status.twitchLive) {
      if (connected) { liveText = `${connected} CHAT${connected === 1 ? '' : 'S'} CONNECTED`; liveState = 'good'; }
      else if (status.lastDiscoveryError) { liveText = 'DISCOVERY ERROR'; liveState = 'bad'; }
      else { liveText = 'DISCOVERING'; liveState = 'warn'; }
    }
    setValue('youtubeLiveStatus', liveText, liveState);
    const broadcastText = (status.activeBroadcasts || []).map((item) => item.title || item.videoId).filter(Boolean).join(' · ');
    $('youtubeLiveDetail').textContent = status.twitchLive
      ? `${status.activeBroadcasts?.length || 0} active broadcast(s) · ${chats.length} distinct chat(s)${broadcastText ? ` · ${broadcastText}` : ''}${status.lastDiscoveryError ? ` · ${status.lastDiscoveryError}` : ''}`
      : 'Twitch is offline, so YouTube discovery and live-chat workers are asleep.';
    $('youtubeRediscoverBtn').disabled = !status.twitchLive || !oauthReady || !cfg.enabled;

    $('youtubeBotEnabled').checked = cfg.enabled !== false;
    $('youtubeCommandsEnabled').checked = cfg.commandsEnabled !== false;
    $('youtubeTimersEnabled').checked = cfg.timersEnabled !== false;
    $('youtubeTimerQuotaStop').value = Number(cfg.timerSafetyStopUnits ?? 7500);
    $('youtubeHardQuotaStop').value = Number(cfg.hardSafetyStopUnits ?? 9000);
    $('youtubeSearchQuotaStop').value = Number(cfg.searchSafetyStopCalls ?? 90);

    setValue('diagYoutubeChats', status.twitchLive ? (connected ? `${connected} CONNECTED` : 'NO CHAT') : 'SLEEPING', status.twitchLive ? (connected ? 'good' : 'warn') : 'good');
    $('diagYoutubeChatsDetail').textContent = `${status.activeBroadcasts?.length || 0} broadcast(s), ${chats.length} distinct chat worker(s). Last discovery: ${status.lastDiscoveryAt ? fmtTime(status.lastDiscoveryAt) : 'not yet'}.`;
    const main = Number(quota.mainUnits || 0), mainLimit = Number(quota.mainLimit || 10000), searches = Number(quota.searchCalls || 0), searchLimit = Number(quota.searchLimit || 100);
    const quotaState = main >= Number(cfg.hardSafetyStopUnits || 9000) ? 'bad' : main >= Number(cfg.timerSafetyStopUnits || 7500) ? 'warn' : 'good';
    setValue('diagYoutubeQuota', `${main.toLocaleString()} / ${mainLimit.toLocaleString()}`, quotaState);
    $('diagYoutubeQuotaDetail').textContent = `${searches}/${searchLimit} search calls · ${quota.commandMessages || 0} command sends · ${quota.timerMessages || 0} timer sends · day ${quota.dayKey || '—'} (Pacific Time).`;
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
    if (!commands.length) { list.innerHTML = '<div class="youtube-empty">No YouTube custom commands yet.</div>'; return; }
    list.innerHTML = commands.map((command) => `
      <div class="custom-command-card">
        <div class="youtube-card-row"><div><strong>${esc(command.normalizedTrigger || command.trigger)}</strong> <span class="detail">${command.enabled === false ? 'Disabled' : 'Enabled'}</span><div class="detail">${esc(command.name || '')}${command.publicDescription ? ` · ${esc(command.publicDescription)}` : ''}</div><div class="youtube-card-meta"><span>${esc(command.userLevel || 'everyone')}</span><span>${Number(command.cooldownSeconds || 0)}s cooldown</span><span>${Number(command.counter || 0)} uses</span></div></div><div class="youtube-card-actions"><button class="secondary" type="button" data-youtube-command-edit="${esc(command._id)}">Edit</button></div></div>
      </div>`).join('');
    list.querySelectorAll('[data-youtube-command-edit]').forEach((button) => { button.onclick = () => openCommandDialog(button.dataset.youtubeCommandEdit); });
  }

  function openCommandDialog(id = '') {
    const command = commands.find((item) => String(item._id) === String(id));
    $('youtubeCommandId').value = command?._id || '';
    $('youtubeCommandDialogTitle').textContent = command ? `Edit ${command.normalizedTrigger || command.trigger}` : 'Add YouTube Command';
    $('youtubeCommandName').value = command?.name || '';
    $('youtubeCommandTrigger').value = command?.normalizedTrigger || command?.trigger || '!';
    $('youtubeCommandDescription').value = command?.publicDescription || '';
    $('youtubeCommandResponses').value = (command?.responses || ['']).join('\n');
    $('youtubeCommandUserLevel').value = command?.userLevel || 'everyone';
    $('youtubeCommandCooldown').value = Number(command?.cooldownSeconds ?? 5);
    $('youtubeCommandProbability').value = Number(command?.probability ?? 100);
    $('youtubeCommandDelay').value = Number(command?.responseDelaySeconds ?? 0);
    $('youtubeCommandAvoidRepeat').checked = Boolean(command?.avoidImmediateRepeat);
    $('youtubeCommandEnabled').checked = command ? command.enabled !== false : true;
    $('deleteYoutubeCommandBtn').hidden = !command;
    $('youtubeCommandDialogMsg').textContent = '';
    const dialog = $('youtubeCommandDialog');
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  }

  function closeCommandDialog() { const d=$('youtubeCommandDialog'); if(typeof d.close==='function') d.close(); else d.removeAttribute('open'); }

  async function saveCommand() {
    $('youtubeCommandDialogMsg').textContent = 'Saving...';
    const body = {
      id: $('youtubeCommandId').value || undefined,
      name: $('youtubeCommandName').value,
      trigger: $('youtubeCommandTrigger').value,
      publicDescription: $('youtubeCommandDescription').value,
      responses: responseLines($('youtubeCommandResponses').value),
      userLevel: $('youtubeCommandUserLevel').value,
      cooldownSeconds: Number($('youtubeCommandCooldown').value || 0),
      probability: Number($('youtubeCommandProbability').value || 100),
      responseDelaySeconds: Number($('youtubeCommandDelay').value || 0),
      avoidImmediateRepeat: $('youtubeCommandAvoidRepeat').checked,
      enabled: $('youtubeCommandEnabled').checked,
      responseMode: 'equal'
    };
    const d = await postJson('/youtube/custom-commands/save', body);
    if (!d.success) { $('youtubeCommandDialogMsg').textContent = d.error; return; }
    closeCommandDialog(); await loadCommands(); $('youtubeCommandsMsg').textContent = 'Saved.';
  }

  async function deleteCommand() {
    const id = $('youtubeCommandId').value; if (!id || !confirm('Delete this YouTube command?')) return;
    const d = await postJson('/youtube/custom-commands/delete', { id });
    if (!d.success) { $('youtubeCommandDialogMsg').textContent = d.error; return; }
    closeCommandDialog(); await loadCommands(); $('youtubeCommandsMsg').textContent = 'Deleted.';
  }

  async function loadTimers() {
    const d = await postJson('/youtube/timers/list', {});
    if (!d.success) throw new Error(d.error || 'Could not load YouTube timers.');
    timers = d.timers || []; renderTimers();
  }

  function renderTimers() {
    const list = $('youtubeTimerList');
    if (!timers.length) { list.innerHTML = '<div class="youtube-empty">No YouTube timers yet.</div>'; return; }
    list.innerHTML = timers.map((item) => `
      <div class="custom-command-card"><div class="youtube-card-row"><div><strong>${esc(item.name)}</strong> <span class="detail">${item.enabled === false ? 'Disabled' : 'Enabled'}</span><div class="youtube-card-meta"><span>Every ${(Number(item.intervalSeconds || 0)/60).toFixed(Number(item.intervalSeconds||0)%60?1:0)} min</span><span>First delay ${(Number(item.startDelaySeconds || 0)/60).toFixed(1).replace(/\.0$/,'')} min</span><span>${Number(item.timesFired || 0)} fires</span><span>Last ${esc(fmtTime(item.lastFiredAt))}</span></div></div><div class="youtube-card-actions"><button class="secondary" type="button" data-youtube-timer-edit="${esc(item._id)}">Edit</button></div></div></div>`).join('');
    list.querySelectorAll('[data-youtube-timer-edit]').forEach((button) => { button.onclick = () => openTimerDialog(button.dataset.youtubeTimerEdit); });
  }

  function openTimerDialog(id = '') {
    const item = timers.find((timer) => String(timer._id) === String(id));
    $('youtubeTimerId').value = item?._id || '';
    $('youtubeTimerDialogTitle').textContent = item ? `Edit ${item.name}` : 'Add YouTube Timer';
    $('youtubeTimerName').value = item?.name || '';
    $('youtubeTimerResponses').value = (item?.responses || ['']).join('\n');
    $('youtubeTimerIntervalMinutes').value = Number(item?.intervalSeconds ?? 900) / 60;
    $('youtubeTimerStartDelayMinutes').value = Number(item?.startDelaySeconds ?? 900) / 60;
    $('youtubeTimerAvoidRepeat').checked = Boolean(item?.avoidImmediateRepeat);
    $('youtubeTimerEnabled').checked = item ? item.enabled !== false : true;
    $('deleteYoutubeTimerBtn').hidden = !item;
    $('fireYoutubeTimerBtn').hidden = !item;
    $('youtubeTimerDialogMsg').textContent = '';
    const dialog = $('youtubeTimerDialog');
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  }
  function closeTimerDialog(){const d=$('youtubeTimerDialog');if(typeof d.close==='function')d.close();else d.removeAttribute('open');}

  async function saveTimer() {
    $('youtubeTimerDialogMsg').textContent = 'Saving...';
    const body = {
      id: $('youtubeTimerId').value || undefined,
      name: $('youtubeTimerName').value,
      responses: responseLines($('youtubeTimerResponses').value),
      intervalSeconds: Math.round(Number($('youtubeTimerIntervalMinutes').value || 15) * 60),
      startDelaySeconds: Math.round(Number($('youtubeTimerStartDelayMinutes').value || 15) * 60),
      avoidImmediateRepeat: $('youtubeTimerAvoidRepeat').checked,
      enabled: $('youtubeTimerEnabled').checked,
      responseMode: 'equal'
    };
    const d = await postJson('/youtube/timers/save', body);
    if (!d.success) { $('youtubeTimerDialogMsg').textContent = d.error; return; }
    closeTimerDialog(); await loadTimers(); $('youtubeTimersMsg').textContent = 'Saved.';
  }

  async function deleteTimer() {
    const id = $('youtubeTimerId').value; if (!id || !confirm('Delete this YouTube timer?')) return;
    const d = await postJson('/youtube/timers/delete', { id });
    if (!d.success) { $('youtubeTimerDialogMsg').textContent = d.error; return; }
    closeTimerDialog(); await loadTimers(); $('youtubeTimersMsg').textContent = 'Deleted.';
  }

  async function fireTimer() {
    const id = $('youtubeTimerId').value; if (!id) return;
    $('youtubeTimerDialogMsg').textContent = 'Sending to active YouTube chat(s)...';
    const d = await postJson('/youtube/timers/fire', { id });
    if (!d.success) { $('youtubeTimerDialogMsg').textContent = d.error; return; }
    $('youtubeTimerDialogMsg').textContent = `Sent to ${d.result?.sentCount || 0} active chat(s)${d.result?.failedCount ? `; ${d.result.failedCount} failed` : ''}.`;
    await Promise.all([loadTimers(), refreshAdminState().catch(()=>{})]);
  }

  async function loadNative() {
    const d = await postJson('/youtube/native/get', {});
    if (!d.success) throw new Error(d.error || 'Could not load !commands.');
    $('youtubeNativeCommandsEnabled').checked = d.config?.commandsEnabled !== false;
    $('youtubeNativeCommandsResponse').value = d.config?.commandsResponse || '';
  }

  async function saveNative() {
    $('youtubeNativeMsg').textContent = 'Saving...';
    const d = await postJson('/youtube/native/save', { commandsEnabled: $('youtubeNativeCommandsEnabled').checked, commandsResponse: $('youtubeNativeCommandsResponse').value });
    $('youtubeNativeMsg').textContent = d.success ? 'Saved.' : d.error;
  }

  function selectAutomationView(view) {
    activeAutomationView = view;
    for (const [key, tab, panel] of [
      ['commands','youtubeCustomCommandsViewTab','youtubeCustomCommandsView'],
      ['timers','youtubeTimersViewTab','youtubeTimersView'],
      ['native','youtubeNativeCommandsViewTab','youtubeNativeCommandsView']
    ]) {
      $(tab).classList.toggle('active', key === view);
      $(panel).classList.toggle('open', key === view);
    }
    if (view === 'commands') void loadCommands().catch((e)=>{$('youtubeCommandsMsg').textContent=e.message;});
    if (view === 'timers') void loadTimers().catch((e)=>{$('youtubeTimersMsg').textContent=e.message;});
    if (view === 'native') void loadNative().catch((e)=>{$('youtubeNativeMsg').textContent=e.message;});
  }

  async function saveControls() {
    const cfg = adminState?.config || {};
    $('youtubeOauthMsg').textContent = 'Saving...';
    const d = await postJson('/youtube/admin/config', {
      ...cfg,
      enabled: $('youtubeBotEnabled').checked,
      commandsEnabled: $('youtubeCommandsEnabled').checked,
      timersEnabled: $('youtubeTimersEnabled').checked
    });
    $('youtubeOauthMsg').textContent = d.success ? 'Saved.' : d.error;
    if (d.success) await refreshAdminState().catch(()=>{});
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
      const labels = {
        environment: 'Environment',
        oauth: 'SqwertArmyBot OAuth',
        liveChatClient: 'Live chat client',
        broadcaster: 'Qwert channel'
      };
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
    $('youtubeQuotaMsg').textContent = 'Saving...';
    const d = await postJson('/youtube/admin/config', {
      ...cfg,
      timerSafetyStopUnits: Number($('youtubeTimerQuotaStop').value),
      hardSafetyStopUnits: Number($('youtubeHardQuotaStop').value),
      searchSafetyStopCalls: Number($('youtubeSearchQuotaStop').value)
    });
    $('youtubeQuotaMsg').textContent = d.success ? 'Saved.' : d.error;
    if (d.success) await refreshAdminState().catch(()=>{});
  }

  $('youtubeCustomCommandsViewTab').onclick = () => selectAutomationView('commands');
  $('youtubeTimersViewTab').onclick = () => selectAutomationView('timers');
  $('youtubeNativeCommandsViewTab').onclick = () => selectAutomationView('native');
  $('addYoutubeCommandBtn').onclick = () => openCommandDialog();
  $('closeYoutubeCommandDialogBtn').onclick = closeCommandDialog;
  $('saveYoutubeCommandBtn').onclick = () => void saveCommand();
  $('deleteYoutubeCommandBtn').onclick = () => void deleteCommand();
  $('youtubeCommandDialog').addEventListener('click',(e)=>{if(e.target===$('youtubeCommandDialog'))closeCommandDialog();});
  $('saveYoutubeGlobalCooldownBtn').onclick = async () => {
    const d = await postJson('/youtube/custom-commands/settings', { globalCooldownSeconds: Number($('youtubeGlobalCooldown').value || 0) });
    $('youtubeCommandsMsg').textContent = d.success ? 'Global cooldown saved.' : d.error;
  };
  $('addYoutubeTimerBtn').onclick = () => openTimerDialog();
  $('closeYoutubeTimerDialogBtn').onclick = closeTimerDialog;
  $('saveYoutubeTimerBtn').onclick = () => void saveTimer();
  $('deleteYoutubeTimerBtn').onclick = () => void deleteTimer();
  $('fireYoutubeTimerBtn').onclick = () => void fireTimer();
  $('youtubeTimerDialog').addEventListener('click',(e)=>{if(e.target===$('youtubeTimerDialog'))closeTimerDialog();});
  $('saveYoutubeNativeBtn').onclick = () => void saveNative();
  $('youtubeAuthorizeBtn').onclick = () => { location.href = '/auth/youtube/start'; };
  $('youtubeDisconnectBtn').onclick = async () => {
    if (!confirm('Disconnect SqwertArmyBot from YouTube OAuth?')) return;
    const d = await postJson('/youtube/oauth/disconnect', {}); $('youtubeOauthMsg').textContent = d.success ? 'Disconnected.' : d.error; if(d.success)await refreshAdminState().catch(()=>{});
  };
  $('youtubeRediscoverBtn').onclick = async () => {
    $('youtubeOauthMsg').textContent='Discovering active broadcasts...'; const d=await postJson('/youtube/admin/rediscover',{}); $('youtubeOauthMsg').textContent=d.success?`Found ${d.discovery?.broadcasts?.length||0} broadcast(s), ${d.discovery?.chats?.length||0} distinct chat(s).`:d.error; await refreshAdminState().catch(()=>{});
  };
  $('saveYoutubeControlsBtn').onclick = () => void saveControls();
  $('runYoutubePreflightBtn').onclick = () => void runPreflight();
  $('saveYoutubeQuotaBtn').onclick = () => void saveQuotaSafety();
  $('refreshYoutubeDiagnosticsBtn').onclick = () => void refreshAdminState({messageTarget:'youtubeQuotaMsg'});

  return {
    refreshAdminState,
    onAutomationVisibilityChange(open) { if (open) { void refreshAdminState().catch(()=>{}); selectAutomationView(activeAutomationView); } },
    onOauthVisibilityChange(open) { if (open) void refreshAdminState({messageTarget:'youtubeOauthMsg'}).catch(()=>{}); },
    onDiagnosticsVisibilityChange(open) { if (open) void refreshAdminState({messageTarget:'youtubeQuotaMsg'}).catch(()=>{}); },
    selectAutomationView
  };
}
