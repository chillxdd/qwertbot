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

function normalizeLogEntry(entry) {
  const labels = Array.isArray(entry?.labels) ? entry.labels : [];
  const labelMap = {};
  for (const item of labels) {
    if (item?.name && item?.value !== undefined) labelMap[item.name] = String(item.value);
  }

  return {
    id: String(entry?.id || ''),
    timestamp: entry?.timestamp || null,
    message: String(entry?.message || ''),
    level: labelMap.level || null,
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
    .reverse();

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
