'use strict';

const COMMAND_PREFIX = '!';

function normalizeCommandTrigger(value) {
  let trigger = String(value || '').trim().toLowerCase();
  if (!trigger) return '';
  if (!trigger.startsWith(COMMAND_PREFIX)) trigger = `${COMMAND_PREFIX}${trigger}`;
  return trigger.replace(/\s+/g, ' ');
}

function parseCommandMessage(message) {
  const raw = String(message || '').trim();
  if (!raw.startsWith(COMMAND_PREFIX)) return null;
  const firstSpace = raw.search(/\s/);
  const trigger = normalizeCommandTrigger(firstSpace < 0 ? raw : raw.slice(0, firstSpace));
  if (!trigger) return null;
  const query = firstSpace < 0 ? '' : raw.slice(firstSpace).trim();
  return { raw, trigger, query };
}

function dedupeBroadcastChats(broadcasts) {
  const byChat = new Map();
  for (const item of Array.isArray(broadcasts) ? broadcasts : []) {
    const liveChatId = String(item?.liveChatId || '').trim();
    if (!liveChatId) continue;
    if (!byChat.has(liveChatId)) byChat.set(liveChatId, { liveChatId, broadcasts: [] });
    byChat.get(liveChatId).broadcasts.push({
      videoId: String(item?.videoId || '').trim(),
      title: String(item?.title || '').trim(),
      orientation: String(item?.orientation || '').trim() || null
    });
  }
  return [...byChat.values()];
}

function classifyYouTubeUser(author = {}) {
  if (author.isChatOwner) return 'owner';
  if (author.isChatModerator) return 'moderator';
  if (author.isChatSponsor) return 'member';
  return 'everyone';
}

const USER_LEVEL_RANK = Object.freeze({ everyone: 0, member: 1, moderator: 2, owner: 3 });
function userMeetsLevel(actual, required) {
  return (USER_LEVEL_RANK[actual] ?? 0) >= (USER_LEVEL_RANK[required] ?? 0);
}

function isFreshMessage(publishedAt, connectedAtMs, allowanceMs = 3000) {
  const published = Date.parse(String(publishedAt || ''));
  if (!Number.isFinite(published)) return false;
  return published >= Number(connectedAtMs || 0) - Math.max(0, Number(allowanceMs || 0));
}

function selectResponseIndex({ responses, mode = 'equal', weights = [], lastIndex = -1, avoidImmediateRepeat = false, random = Math.random }) {
  const list = Array.isArray(responses) ? responses : [];
  if (!list.length) return -1;
  if (list.length === 1) return 0;
  const all = list.map((_, i) => i);
  const available = all.filter((i) => !(avoidImmediateRepeat && i === lastIndex));
  const pool = available.length ? available : all;

  if (mode === 'weighted') {
    const normalized = pool.map((i) => Math.max(0, Number(weights?.[i] ?? 1)));
    const total = normalized.reduce((sum, value) => sum + value, 0);
    if (total > 0) {
      let cursor = random() * total;
      for (let p = 0; p < pool.length; p += 1) {
        cursor -= normalized[p];
        if (cursor <= 0) return pool[p];
      }
      return pool[pool.length - 1];
    }
  }
  return pool[Math.floor(random() * pool.length) % pool.length];
}

function renderUniversalResponse(template, context = {}) {
  const user = String(context.displayName || context.user || 'viewer');
  const query = String(context.query || '');
  const queryParts = query.split(/\s+/).filter(Boolean);
  const toUser = queryParts[0] || user;
  const randomUser = String(context.randomUser || user);
  const counter = Math.max(0, Number(context.counter || 0));

  return String(template || '')
    .replace(/\$\(user\)/gi, user)
    .replace(/\$\(touser\)/gi, toUser)
    .replace(/\$\(query\)/gi, query)
    .replace(/\$\((?:count|counter)\)/gi, String(counter))
    .replace(/\$\(randomuser\)/gi, randomUser)
    .replace(/\$\(random\s+(\d+)\s+(\d+)\)/gi, (_, a, b) => {
      const min = Math.min(Number(a), Number(b));
      const max = Math.max(Number(a), Number(b));
      return String(Math.floor(Math.random() * (max - min + 1)) + min);
    });
}


function createInitialHistoryGate({ hasContinuation = false } = {}) {
  let primed = Boolean(hasContinuation);
  return {
    accept(items) {
      const batch = Array.isArray(items) ? items : [];
      if (!primed) { primed = true; return []; }
      return batch;
    },
    isPrimed() { return primed; }
  };
}

function youtubeCooldownKey(liveChatId, commandId) {
  return `${String(liveChatId || '')}:${String(commandId || '')}`;
}

function estimateTimerCycleUnits(chatCount, insertCost = 50) {
  return Math.max(0, Number(chatCount || 0)) * Math.max(0, Number(insertCost || 0));
}

module.exports = {
  COMMAND_PREFIX,
  normalizeCommandTrigger,
  parseCommandMessage,
  dedupeBroadcastChats,
  classifyYouTubeUser,
  userMeetsLevel,
  isFreshMessage,
  selectResponseIndex,
  renderUniversalResponse,
  estimateTimerCycleUnits,
  createInitialHistoryGate,
  youtubeCooldownKey
};
