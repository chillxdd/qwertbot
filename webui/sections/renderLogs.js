export function initRenderLogsSection({ $, postJson, getPassword }) {
  let logs = [];
  let timer = null;
  let sectionOpen = false;

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
      row.className = `log-line ${level.includes('error') || level.includes('critical') ? 'log-error' : level.includes('warn') ? 'log-warning' : 'log-info'}`;
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
    $('renderLogsMsg').textContent = 'Loading recent Render logs...';
    try {
      const d = await postJson('/render-logs', { password: getPassword() });
      if (!d.success) {
        $('renderLogsMsg').textContent = d.error || 'Could not load Render logs.';
        return;
      }
      logs = Array.isArray(d.logs) ? d.logs : [];
      $('renderLogsMsg').textContent = `${d.serviceName || 'Render service'} — ${logs.length} recent log line(s)${d.hasMore ? ' (more available in Render)' : ''}.`;
      renderLogs();
    } catch (_) {
      $('renderLogsMsg').textContent = 'Could not load Render logs.';
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
