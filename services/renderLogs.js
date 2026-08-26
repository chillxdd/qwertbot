const RENDER_API_KEY = (process.env.RENDER_API_KEY || '').trim();
const RENDER_SERVICE_ID = (process.env.RENDER_SERVICE_ID || '').trim();
const RENDER_API_BASE = 'https://api.render.com/v1';
const CONTEXT_CACHE_MS = 30 * 60 * 1000;

let cachedContext = null;
let cachedContextAt = 0;

function getRenderLogsConfigStatus() {
  if (!RENDER_API_KEY) {
    return {
      configured: false,
      error: 'Add RENDER_API_KEY in Render Environment to enable this section.'
    };
  }

  if (!RENDER_SERVICE_ID) {
    return {
      configured: false,
      error: 'RENDER_SERVICE_ID is unavailable. Render normally provides this automatically at runtime.'
    };
  }

  return { configured: true, error: null };
}

async function renderApiFetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${RENDER_API_KEY}`
      },
      signal: controller.signal
    });

    let body = null;
    try {
      body = await response.json();
    } catch (_) {
      body = null;
    }

    if (!response.ok) {
      const detail = body?.message || body?.error || `HTTP ${response.status}`;
      const err = new Error(`Render API request failed: ${detail}`);
      err.status = response.status;
      throw err;
    }

    return body;
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeoutErr = new Error('Render API request timed out.');
      timeoutErr.status = 504;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveRenderContext() {
  const config = getRenderLogsConfigStatus();
  if (!config.configured) {
    const err = new Error(config.error);
    err.status = 503;
    throw err;
  }

  if (cachedContext && Date.now() - cachedContextAt < CONTEXT_CACHE_MS) {
    return cachedContext;
  }

  const service = await renderApiFetch(`${RENDER_API_BASE}/services/${encodeURIComponent(RENDER_SERVICE_ID)}`);
  const ownerId = service?.ownerId || service?.owner_id;

  if (!ownerId) {
    const err = new Error('Render returned the service but did not provide its workspace ID.');
    err.status = 502;
    throw err;
  }

  cachedContext = {
    ownerId,
    serviceId: RENDER_SERVICE_ID,
    serviceName: service?.name || process.env.RENDER_SERVICE_NAME || 'SqwertArmyBot'
  };
  cachedContextAt = Date.now();
  return cachedContext;
}

function stripAnsiAndControlCodes(value) {
  return String(value || '')
    .replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\u009B[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function normalizeLogEntry(entry) {
  const labels = Array.isArray(entry?.labels) ? entry.labels : [];
  const labelMap = {};
  for (const item of labels) {
    if (item?.name && item?.value !== undefined) labelMap[item.name] = String(item.value);
  }

  const message = stripAnsiAndControlCodes(entry?.message || '');
  let level = labelMap.level || null;

  // Render can occasionally label a healthy summary line as error even when the
  // application emitted it with console.log. Normalize explicit zero-error
  // summaries so both styling and the visible [level] tag reflect the message.
  if (/\b0\s+error(?:\(s\)|s?)\b/i.test(message) && /error|critical/i.test(String(level || ''))) {
    level = 'info';
  }

  return {
    id: String(entry?.id || ''),
    timestamp: entry?.timestamp || null,
    message,
    level,
    type: labelMap.type || null,
    instance: labelMap.instance || null
  };
}

async function getRecentRenderLogs({ limit = 100 } = {}) {
  const context = await resolveRenderContext();
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 100));
  const params = new URLSearchParams();
  params.set('ownerId', context.ownerId);
  params.append('resource', context.serviceId);
  params.set('direction', 'backward');
  params.append('type', 'app');
  params.set('limit', String(safeLimit));

  const result = await renderApiFetch(`${RENDER_API_BASE}/logs?${params.toString()}`);
  const logs = (Array.isArray(result?.logs) ? result.logs : [])
    .map(normalizeLogEntry)
    .sort((a, b) => {
      const at = a.timestamp ? Date.parse(a.timestamp) : 0;
      const bt = b.timestamp ? Date.parse(b.timestamp) : 0;
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });

  return {
    serviceName: context.serviceName,
    logs,
    hasMore: Boolean(result?.hasMore)
  };
}

module.exports = {
  getRecentRenderLogs,
  getRenderLogsConfigStatus
};
