const GeminiRecapQuota = require('../models/GeminiRecapQuota');
const { isDatabaseConnected } = require('./database');

const PACIFIC_TIME_ZONE = 'America/Los_Angeles';
const memoryUsage = new Map();
const statusCache = new Map();

function clampLimit(value, fallback = 20) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(1000, Math.floor(parsed)));
}

function getPacificDayKey(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(timestamp));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function quotaKey(model, pacificDay) {
  return `${String(model || '').trim()}:${pacificDay}`;
}

function normalizeStatus({ model, limit, pacificDay, used, source }) {
  const normalizedLimit = clampLimit(limit);
  const normalizedUsed = Math.max(0, Number(used) || 0);
  return {
    model: String(model || '').trim(),
    pacificDay,
    used: normalizedUsed,
    limit: normalizedLimit,
    remaining: Math.max(0, normalizedLimit - normalizedUsed),
    exhausted: normalizedUsed >= normalizedLimit,
    resetTimezone: PACIFIC_TIME_ZONE,
    source
  };
}

function getMemoryStatus(model, limit, pacificDay) {
  const key = quotaKey(model, pacificDay);
  const used = Math.max(0, Number(memoryUsage.get(key) || 0));
  return normalizeStatus({ model, limit, pacificDay, used, source: 'memory' });
}

function syncMemory(model, pacificDay, used) {
  const key = quotaKey(model, pacificDay);
  const normalizedUsed = Math.max(0, Number(used) || 0);
  memoryUsage.set(key, normalizedUsed);
  for (const existingKey of memoryUsage.keys()) {
    if (existingKey !== key && existingKey.startsWith(`${String(model || '').trim()}:`)) memoryUsage.delete(existingKey);
  }
}

async function getRecapPrimaryQuotaStatus({ model, limit = 20 } = {}) {
  const normalizedModel = String(model || '').trim();
  const normalizedLimit = clampLimit(limit);
  const pacificDay = getPacificDayKey();
  const key = quotaKey(normalizedModel, pacificDay);
  const cached = statusCache.get(key);
  if (cached) return { ...cached };

  if (!normalizedModel || !isDatabaseConnected()) {
    const status = getMemoryStatus(normalizedModel, normalizedLimit, pacificDay);
    // Do not pin a pre-connection memory value in the cache. Once MongoDB
    // becomes available, the next diagnostics refresh should load the
    // persisted counter from the previous process/redeploy.
    return { ...status };
  }

  try {
    const doc = await GeminiRecapQuota.findOne({ key }).lean();
    const status = normalizeStatus({
      model: normalizedModel,
      limit: normalizedLimit,
      pacificDay,
      used: doc?.used || 0,
      source: 'mongodb'
    });
    syncMemory(normalizedModel, pacificDay, status.used);
    statusCache.set(key, status);
    return { ...status };
  } catch (err) {
    console.warn(`[Gemini Recap Quota] Could not load persistent quota usage; using in-memory guard: ${err?.message || err}`);
    const status = getMemoryStatus(normalizedModel, normalizedLimit, pacificDay);
    return { ...status, source: 'memory-fallback' };
  }
}

async function claimRecapPrimaryQuota({ model, limit = 20 } = {}) {
  const normalizedModel = String(model || '').trim();
  const normalizedLimit = clampLimit(limit);
  const pacificDay = getPacificDayKey();
  const key = quotaKey(normalizedModel, pacificDay);

  if (!normalizedModel) {
    return { allowed: false, ...normalizeStatus({ model: '', limit: normalizedLimit, pacificDay, used: 0, source: 'disabled' }) };
  }

  if (!isDatabaseConnected()) {
    const before = getMemoryStatus(normalizedModel, normalizedLimit, pacificDay);
    if (before.exhausted) return { allowed: false, ...before };
    const used = before.used + 1;
    syncMemory(normalizedModel, pacificDay, used);
    const status = normalizeStatus({ model: normalizedModel, limit: normalizedLimit, pacificDay, used, source: 'memory' });
    statusCache.set(key, status);
    return { allowed: true, ...status };
  }

  try {
    let doc = await GeminiRecapQuota.findOneAndUpdate(
      { key, used: { $lt: normalizedLimit } },
      {
        $inc: { used: 1 },
        $set: { model: normalizedModel, pacificDay, limit: normalizedLimit, lastStartedAt: new Date() }
      },
      { new: true }
    ).lean();

    if (!doc) {
      const existing = await GeminiRecapQuota.findOne({ key }).lean();
      if (!existing) {
        try {
          doc = (await GeminiRecapQuota.create({
            key,
            model: normalizedModel,
            pacificDay,
            used: 1,
            limit: normalizedLimit,
            lastStartedAt: new Date()
          })).toObject();
        } catch (createErr) {
          if (Number(createErr?.code) !== 11000) throw createErr;
          doc = await GeminiRecapQuota.findOneAndUpdate(
            { key, used: { $lt: normalizedLimit } },
            {
              $inc: { used: 1 },
              $set: { model: normalizedModel, pacificDay, limit: normalizedLimit, lastStartedAt: new Date() }
            },
            { new: true }
          ).lean();
        }
      }
    }

    if (!doc) {
      const current = await GeminiRecapQuota.findOne({ key }).lean();
      const status = normalizeStatus({
        model: normalizedModel,
        limit: normalizedLimit,
        pacificDay,
        used: current?.used || normalizedLimit,
        source: 'mongodb'
      });
      syncMemory(normalizedModel, pacificDay, status.used);
      statusCache.set(key, status);
      return { allowed: false, ...status };
    }

    const status = normalizeStatus({
      model: normalizedModel,
      limit: normalizedLimit,
      pacificDay,
      used: doc.used,
      source: 'mongodb'
    });
    syncMemory(normalizedModel, pacificDay, status.used);
    statusCache.set(key, status);
    return { allowed: true, ...status };
  } catch (err) {
    console.warn(`[Gemini Recap Quota] Persistent quota claim failed; using in-memory guard: ${err?.message || err}`);
    const before = getMemoryStatus(normalizedModel, normalizedLimit, pacificDay);
    if (before.exhausted) return { allowed: false, ...before, source: 'memory-fallback' };
    const used = before.used + 1;
    syncMemory(normalizedModel, pacificDay, used);
    const status = normalizeStatus({ model: normalizedModel, limit: normalizedLimit, pacificDay, used, source: 'memory-fallback' });
    statusCache.set(key, status);
    return { allowed: true, ...status };
  }
}

module.exports = {
  PACIFIC_TIME_ZONE,
  getPacificDayKey,
  getRecapPrimaryQuotaStatus,
  claimRecapPrimaryQuota
};
