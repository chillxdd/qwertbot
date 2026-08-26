export function initRenderLogsSection({ $, postJson }) {
  let logs = [];
  let timer = null;
  let sectionOpen = false;

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value < 1024) return `${Math.round(value)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let n = value / 1024;
    let unit = units[0];
    for (let i = 1; i < units.length && n >= 1024; i += 1) {
      n /= 1024;
      unit = units[i];
    }
    return `${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${unit}`;
  }

  function formatDuration(seconds) {
    let remaining = Math.max(0, Math.floor(Number(seconds) || 0));
    const days = Math.floor(remaining / 86400); remaining %= 86400;
    const hours = Math.floor(remaining / 3600); remaining %= 3600;
    const minutes = Math.floor(remaining / 60);
    if (days) return `${days}d ${hours}h ${minutes}m`;
    if (hours) return `${hours}h ${minutes}m`;
    return `${minutes}m ${remaining % 60}s`;
  }

  function setDiagnostic(id, text, detail, state = '') {
    const valueEl = $(id);
    const detailEl = $(`${id}Detail`);
    valueEl.textContent = text;
    valueEl.classList.remove('good', 'warn', 'bad');
    if (state) valueEl.classList.add(state);
    if (detailEl) detailEl.textContent = detail || '';
  }

  function renderDiagnostics(diag) {
    const runtime = diag?.runtime || {};
    const memory = runtime.memory || {};
    const eventLoop = runtime.eventLoop || {};
    const processInfo = runtime.process || {};
    const gemini = diag?.gemini || {};
    const tagged = diag?.taggedQuestions || {};
    const recap = diag?.recap || {};
    const services = diag?.services || {};

    const rssPercent = Number(memory.rssPercent);
    const memoryState = Number.isFinite(rssPercent) ? (rssPercent >= 85 ? 'bad' : rssPercent >= 70 ? 'warn' : 'good') : 'good';
    const memoryMain = memory.limitBytes
      ? `${formatBytes(memory.rssBytes)} / ${formatBytes(memory.limitBytes)}`
      : formatBytes(memory.rssBytes);
    const memoryDetail = memory.limitBytes
      ? `${Number.isFinite(rssPercent) ? rssPercent.toFixed(1) : '?'}% of detected container limit (${memory.limitSource || 'cgroup'})`
      : 'Container memory limit not exposed; showing process RSS only.';
    setDiagnostic('diagMemory', memoryMain, memoryDetail, memoryState);

    const heapPercent = memory.heapTotalBytes ? (Number(memory.heapUsedBytes || 0) / Number(memory.heapTotalBytes)) * 100 : null;
    setDiagnostic(
      'diagHeap',
      `${formatBytes(memory.heapUsedBytes)} / ${formatBytes(memory.heapTotalBytes)}`,
      `${Number.isFinite(heapPercent) ? heapPercent.toFixed(1) : '?'}% of currently allocated V8 heap; external ${formatBytes(memory.externalBytes)}.`,
      Number.isFinite(heapPercent) && heapPercent >= 90 ? 'warn' : 'good'
    );

    const p95 = Number(eventLoop.p95LagMs);
    const lagState = Number.isFinite(p95) ? (p95 >= 200 ? 'bad' : p95 >= 75 ? 'warn' : 'good') : 'warn';
    setDiagnostic(
      'diagEventLoop',
      Number.isFinite(p95) ? `${p95.toFixed(1)} ms p95` : '—',
      `Mean ${Number(eventLoop.meanLagMs || 0).toFixed(1)} ms · Max ${Number(eventLoop.maxLagMs || 0).toFixed(1)} ms since last sample.`,
      lagState
    );

    setDiagnostic(
      'diagUptime',
      formatDuration(processInfo.uptimeSeconds),
      `${processInfo.nodeVersion || 'Node'} · PID ${processInfo.pid || '—'} · ${processInfo.platform || 'unknown platform'}`,
      'good'
    );

    const queued = Number(gemini.queued || 0);
    const geminiState = queued >= 10 ? 'bad' : queued >= 4 ? 'warn' : 'good';
    setDiagnostic(
      'diagGemini',
      `${queued} queued${gemini.processing ? ' · active' : ''}`,
      `High ${gemini.queueByPriority?.high || 0} · Normal ${gemini.queueByPriority?.normal || 0} · Low ${gemini.queueByPriority?.low || 0} · ${gemini.model || 'Gemini'}`,
      geminiState
    );

    const taggedInFlight = Number(tagged.inFlight || 0);
    setDiagnostic(
      'diagTagged',
      taggedInFlight ? `${taggedInFlight} active` : 'Idle',
      taggedInFlight ? 'Tagged Question response generation currently in progress.' : 'No Tagged Questions currently in flight.',
      taggedInFlight >= 3 ? 'warn' : 'good'
    );

    setDiagnostic(
      'diagRecap',
      recap.inProgress ? 'Generating' : recap.paused ? 'Paused' : 'Idle',
      `${recap.messagesInWindow || 0} chat messages · ${recap.twitchEventsInWindow || 0} Twitch events in current recap window.`,
      recap.paused ? 'warn' : 'good'
    );

    const serviceProblems = [];
    if (!services.databaseConnected) serviceProblems.push('MongoDB');
    if (!services.botConnected) serviceProblems.push('Twitch bot');
    const servicesState = serviceProblems.length ? 'bad' : 'good';
    const streamText = services.streamStateKnown ? (services.streamLive ? 'Stream LIVE' : 'Stream offline') : 'Stream state unknown';
    setDiagnostic(
      'diagServices',
      serviceProblems.length ? `Issue: ${serviceProblems.join(', ')}` : 'Healthy',
      `MongoDB ${services.databaseConnected ? 'connected' : 'disconnected'} · Twitch bot ${services.botConnected ? 'connected' : 'disconnected'} · ${streamText}.`,
      servicesState
    );
  }

  function renderLogs() {
    const filter = $('logFilter').value.trim().toLowerCase();
    const visible = filter
      ? logs.filter((line) => `${line.timestamp || ''} ${line.level || ''} ${line.type || ''} ${line.message || ''}`.toLowerCase().includes(filter))
      : logs;

    const consoleEl = $('renderLogConsole');
    consoleEl.replaceChildren();
    for (const entry of visible) {
      const row = document.createElement('div');
      const level = String(entry.level || 'info').toLowerCase();
      const message = String(entry.message || '');
      const explicitlyZeroErrors = /\b0\s+error(?:\(s\)|s?)\b/i.test(message);
      const isError = (level.includes('error') || level.includes('critical')) && !explicitlyZeroErrors;
      row.className = `log-line ${isError ? 'log-error' : level.includes('warn') ? 'log-warning' : 'log-info'}`;
      const stamp = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '--:--:--';
      const levelText = entry.level ? ` [${entry.level}]` : '';
      row.textContent = `${stamp}${levelText} ${entry.message || ''}`;
      consoleEl.appendChild(row);
    }
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  async function refresh() {
    if (!sectionOpen) return;
    $('refreshLogsBtn').disabled = true;
    $('renderLogsMsg').textContent = 'Loading Render diagnostics...';
    try {
      const d = await postJson('/render-logs', {});
      if (!d.success) {
        $('renderLogsMsg').textContent = d.error || 'Could not load Render diagnostics.';
        return;
      }
      renderDiagnostics(d.diagnostics || {});
      logs = Array.isArray(d.logs) ? d.logs : [];
      if (d.logsError) {
        $('renderLogsMsg').textContent = `Runtime diagnostics are live. Recent Render logs unavailable: ${d.logsError}`;
      } else {
        $('renderLogsMsg').textContent = `${d.serviceName || 'Render service'} — ${logs.length} recent log line(s)${d.hasMore ? ' (more available in Render)' : ''}. Diagnostics refresh with this panel.`;
      }
      renderLogs();
    } catch (_) {
      $('renderLogsMsg').textContent = 'Could not load Render diagnostics.';
    } finally {
      $('refreshLogsBtn').disabled = false;
    }
  }

  function syncTimer() {
    if (timer) clearInterval(timer);
    timer = null;
    if (sectionOpen && $('autoRefreshLogs').checked) {
      timer = setInterval(refresh, 10000);
    }
  }

  function onVisibilityChange(open) {
    sectionOpen = open;
    syncTimer();
    if (open) refresh();
  }

  $('refreshLogsBtn').onclick = refresh;
  $('autoRefreshLogs').onchange = syncTimer;
  $('logFilter').oninput = renderLogs;

  return { onVisibilityChange };
}
