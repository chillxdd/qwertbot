export function initRenderLogsSection({ $, postJson }) {
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
    // Be tolerant of a stale dashboard page during/after a deploy. A missing
    // card must not prevent the rest of the diagnostics from rendering.
    if (!valueEl) return;
    valueEl.textContent = text;
    valueEl.classList.remove('good', 'warn', 'bad');
    if (state) valueEl.classList.add(state);
    if (detailEl) detailEl.textContent = detail || '';
  }

  function markDiagnosticsUnavailable(message) {
    const detail = message || 'Could not load runtime diagnostics.';
    for (const id of [
      'diagMemory', 'diagHeap', 'diagEventLoop', 'diagUptime', 'diagGemini',
      'diagGeminiRequests', 'diagRecapFlash', 'diagTagged', 'diagRecap', 'diagServices'
    ]) {
      setDiagnostic(id, 'Unavailable', detail, 'bad');
    }
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
    const rpmUsed = Number(gemini.requestsStartedLastMinute || 0);
    const rpmCap = Number(gemini.hardMaxRequestsPerMinute || 12);
    setDiagnostic(
      'diagGemini',
      `${queued} queued${gemini.processing ? ' · active' : ''}`,
      `${rpmUsed}/${rpmCap} RPM · ${Number(gemini.requestSpacingMs || 0)}ms spacing · High ${gemini.queueByPriority?.high || 0} · Normal ${gemini.queueByPriority?.normal || 0} · Low ${gemini.queueByPriority?.low || 0} · ${gemini.activeLabel ? `Active: ${gemini.activeLabel}` : 'No active request'} · Recap writer: ${gemini.recapPrimaryModel || gemini.model || 'Gemini'} · Evidence-first recaps: Lite only`,
      geminiState
    );

    const recentGemini = Array.isArray(gemini.recentRequests) ? gemini.recentRequests : [];
    const requestSummary = recentGemini.length
      ? recentGemini.map((entry) => {
          const stamp = entry.startedAt ? new Date(entry.startedAt).toLocaleTimeString() : '--:--:--';
          const result = entry.outcome === 'active' ? 'ACTIVE' : entry.status || String(entry.outcome || '').toUpperCase();
          return `${stamp} ${entry.label || 'gemini'} [${entry.model || gemini.model || 'Gemini'} · ${entry.priority || 'normal'}] ${result}`;
        }).join(' · ')
      : 'No Gemini HTTP requests started in the last 60 seconds.';
    setDiagnostic(
      'diagGeminiRequests',
      recentGemini.length ? `${recentGemini.length} start${recentGemini.length === 1 ? '' : 's'}` : 'None',
      requestSummary,
      recentGemini.some((entry) => Number(entry.status) === 429) ? 'bad' : 'good'
    );

    const quality = recap.quality || null;
    const qualityDetail = quality
      ? `Last recap: ${quality.selectedSentences || 0} sentences / ${quality.characters || 0} chars from ${quality.sourceMessages || 0} viewer messages; ${(Number(quality.durationMs || 0) / 1000).toFixed(1)}s; ${quality.requestCount || 0} Lite requests. ${quality.recoveryAttempted ? 'Coverage recovery used. ' : ''}${quality.sourceExcerpts ? `${quality.sourceExcerpts} direct source excerpt(s) used after model/audit failure. ` : ''}${quality.coverageTargetMet ? 'Coverage target met.' : 'Below coverage target; inspect Recap Evidence logs.'}`
      : 'Source-grounded writer, one batch audit, and at most one coverage recovery. No non-Lite editor.';
    setDiagnostic(
      'diagRecapFlash',
      'Flash-Lite only',
      `${gemini.recapPrimaryModel || 'gemini-3.5-flash-lite'}. ${qualityDetail}`,
      quality && (!quality.coverageTargetMet || quality.sourceExcerpts) ? 'warn' : 'good'
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

  let diagnosticsRefreshing = false;

  async function refreshDiagnostics() {
    if (!sectionOpen || diagnosticsRefreshing) return;
    diagnosticsRefreshing = true;
    const msg = $('runtimeDiagnosticsMsg');
    if (msg) msg.textContent = 'Refreshing local runtime health...';
    try {
      const d = await postJson('/runtime-diagnostics', {});
      if (!d.success) {
        const error = d.error || 'Could not load runtime diagnostics.';
        markDiagnosticsUnavailable(error);
        if (msg) msg.textContent = error;
        return;
      }
      renderDiagnostics(d.diagnostics || {});
      if (msg) msg.textContent = `Runtime health updated ${new Date().toLocaleTimeString()}.`;
    } catch (err) {
      const error = err?.message || 'Could not load runtime diagnostics.';
      markDiagnosticsUnavailable(error);
      if (msg) msg.textContent = error;
    } finally {
      diagnosticsRefreshing = false;
    }
  }

  async function refreshAll() {
    if (!sectionOpen) return;
    const button = $('refreshLogsBtn');
    if (button) button.disabled = true;
    try {
      await refreshDiagnostics();
    } finally {
      if (button) button.disabled = false;
    }
  }

  function syncTimer() {
    if (timer) clearInterval(timer);
    timer = null;
    const autoRefresh = $('autoRefreshLogs');
    if (sectionOpen && (!autoRefresh || autoRefresh.checked)) {
      // Local diagnostics only: no Render API or other external log request.
      timer = setInterval(refreshDiagnostics, 10000);
    }
  }

  function onVisibilityChange(open) {
    sectionOpen = open;
    syncTimer();
    if (open) void refreshAll();
  }

  const refreshButton = $('refreshLogsBtn');
  const autoRefresh = $('autoRefreshLogs');
  if (refreshButton) refreshButton.onclick = refreshAll;
  if (autoRefresh) autoRefresh.onchange = syncTimer;

  return { onVisibilityChange };
}
