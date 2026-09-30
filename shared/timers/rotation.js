'use strict';

const { randomUUID } = require('node:crypto');
const MAX_RESPONSES = 25;
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 86400;

// No random selection: one eligible response per successful occurrence. Stable
// IDs keep the cursor attached to the last delivered response after reordering.
function responseRows(timer) {
  const messages = Array.isArray(timer?.responses) ? timer.responses : [];
  const hasPerResponseFilters = Array.isArray(timer?.responseFilterIds) && timer.responseFilterIds.length === messages.length;
  return messages.map((text, index) => ({
    id: String(timer.responseIds?.[index] || `legacy-${index}`), index,
    text: String(text || ''), enabled: timer.responseEnabled?.[index] !== false,
    filterId: String(hasPerResponseFilters ? timer.responseFilterIds[index] || '' : timer.advancedFilterId || '').trim(),
    actionType: timer.actionTypes?.[index] || 'chat_message', actionColor: timer.actionColors?.[index] || 'primary'
  }));
}

function evaluateResponses(timer, evaluateFilter = null) {
  return responseRows(timer).map((row) => {
    let filter = { exists: true, matched: true, filterName: '' };
    if (row.filterId) {
      try { filter = evaluateFilter?.(row.filterId) || { exists: false, matched: false }; }
      catch (_) { filter = { exists: false, matched: false }; }
    }
    return { ...row, filterName: filter.filterName || '', filterExists: filter.exists !== false,
      filterMatched: filter.matched === true, eligible: row.enabled && Boolean(row.text.trim()) && filter.exists !== false && filter.matched === true };
  });
}

function chooseResponse(timer, evaluateFilter = null) {
  const rows = evaluateResponses(timer, evaluateFilter);
  let last = timer.lastResponseId ? rows.findIndex((row) => row.id === timer.lastResponseId) : Number(timer.lastResponseIndex ?? -1);
  if (!Number.isInteger(last) || last < -1 || last >= rows.length) last = -1;
  for (let offset = 1; offset <= rows.length; offset += 1) {
    const row = rows[(last + offset) % rows.length];
    if (row.eligible) return { template: row.text, index: row.index, responseId: row.id, filterId: row.filterId, mode: 'sequential' };
  }
  return { template: '', index: -1, responseId: '', filterId: '', mode: 'sequential' };
}

function normalizeResponses(input, { maxLength = 500, allowAnnouncements = true } = {}) {
  const raw = input.responses;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_RESPONSES) throw new Error('A timer needs 1-25 responses.');
  const responses = raw.map((text) => typeof text === 'string' ? text.trim() : '');
  if (responses.some((text) => !text || Array.from(text).length > maxLength)) throw new Error(`Every response needs 1-${maxLength} characters. Remove empty rows before saving.`);
  for (const name of ['responseIds', 'responseEnabled', 'responseFilterIds', 'actionTypes', 'actionColors']) {
    if (input[name] !== undefined && (!Array.isArray(input[name]) || input[name].length !== responses.length)) throw new Error(`${name} must have one entry per response.`);
  }
  const responseIds = responses.map((_, i) => String(input.responseIds?.[i] || randomUUID()));
  if (new Set(responseIds).size !== responseIds.length || responseIds.some((id) => !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) throw new Error('Response IDs must be unique and valid. Refresh the editor.');
  return {
    responses, responseIds,
    responseEnabled: responses.map((_, i) => input.responseEnabled?.[i] !== false),
    responseFilterIds: responses.map((_, i) => String(input.responseFilterIds?.[i] ?? input.advancedFilterId ?? '').trim()),
    actionTypes: responses.map((_, i) => {
      const type = input.actionTypes?.[i] || 'chat_message';
      if (!['chat_message', 'twitch_announcement'].includes(type) || (!allowAnnouncements && type !== 'chat_message')) throw new Error('This platform does not support that response action.');
      return type;
    }),
    actionColors: responses.map((_, i) => ['primary', 'purple', 'blue', 'green', 'orange'].includes(input.actionColors?.[i]) ? input.actionColors[i] : 'primary'),
    advancedFilterId: '', rotationVersion: 1, responseMode: 'sequential', responseWeights: [], avoidImmediateRepeat: false
  };
}

function migrationPatch(timer, options = {}) {
  const rows = responseRows(timer);
  if (timer.rotationVersion === 1 && timer.responseMode === 'sequential' &&
      timer.responseIds?.length === rows.length && timer.responseFilterIds?.length === rows.length && timer.responseEnabled?.length === rows.length) return null;
  const normalized = normalizeResponses({ responses: rows.map((r) => r.text),
    responseIds: rows.map((r) => r.id), responseEnabled: rows.map((r) => r.enabled),
    responseFilterIds: rows.map((r) => r.filterId), actionTypes: rows.map((r) => r.actionType), actionColors: rows.map((r) => r.actionColor) }, options);
  return { ...normalized, lastResponseId: normalized.responseIds[Number(timer.lastResponseIndex)] || '', configurationRevision: timer.configurationRevision || '' };
}

function firstDueAt(timer, { startedAt, now = Date.now(), globalStartDelaySeconds = 0 }) {
  const start = Number(startedAt) || now;
  const delay = Math.max(0, Number(globalStartDelaySeconds) || 0, Number(timer.startDelaySeconds) || 0);
  return Math.max(now, start + delay * 1000);
}
function nextDueAt(timer, now = Date.now(), random = Math.random) {
  const interval = Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, Number(timer.intervalSeconds) || MIN_INTERVAL_SECONDS));
  const jitter = Math.max(0, Math.min(MAX_INTERVAL_SECONDS, Math.round(Number(timer.jitterSeconds) || 0)));
  const delta = jitter ? Math.floor(random() * (2 * jitter + 1)) - jitter : 0;
  return now + Math.max(MIN_INTERVAL_SECONDS, interval + delta) * 1000;
}
module.exports = { responseRows, evaluateResponses, chooseResponse, normalizeResponses, migrationPatch, firstDueAt, nextDueAt };
