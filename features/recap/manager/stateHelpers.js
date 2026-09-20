'use strict';

const {
  normalizeIdentity,
  normalizeChatRecord,
  renderChatRecord,
  normalizeEventRecord
} = require('../../../services/sourceRecords');

const FIRST_RECAP_DELAY = 60 * 60 * 1000;
const RECURRING_RECAP_DELAY = 60 * 60 * 1000;

function sourceTimestamp(value, fallback = Date.now()) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isNaN(parsed) ? fallback : parsed;
}

function toStoredChatRecord(value, defaults = {}) {
  const record = normalizeChatRecord(value, defaults);
  return {
    ...record,
    body: record.text,
    text: renderChatRecord(record, { includeBotMarker: false })
  };
}

function toStoredEventRecord(value, defaults = {}) {
  return normalizeEventRecord(value, defaults);
}

function compactIdentityForPersistence(value = {}) {
  const identity = normalizeIdentity(value);
  const out = {};
  if (identity.userId) out.userId = identity.userId;
  if (identity.login) out.login = identity.login;
  if (identity.displayName) out.displayName = identity.displayName;
  if (identity.role && identity.role !== 'unknown') out.role = identity.role;
  return Object.keys(out).length ? out : null;
}

function nonEmptyObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function toPersistedChatRecord(value, defaults = {}) {
  const record = normalizeChatRecord(value, defaults);
  const out = { id: record.id, timestamp: record.timestamp, body: record.text };
  if (record.twitchMessageId) out.twitchMessageId = record.twitchMessageId;
  if (record.sourceMessageId) out.sourceMessageId = record.sourceMessageId;
  if (record.kind && record.kind !== 'viewer') out.kind = record.kind;
  const author = compactIdentityForPersistence(record.author);
  if (author) out.author = author;
  if (record.replyTo) {
    const reply = {};
    if (record.replyTo.messageId) reply.messageId = record.replyTo.messageId;
    if (record.replyTo.text) reply.text = record.replyTo.text;
    const replyAuthor = compactIdentityForPersistence(record.replyTo.author);
    if (replyAuthor) reply.author = replyAuthor;
    if (Object.keys(reply).length) out.replyTo = reply;
  }
  if (record.sharedChat?.active) out.sharedChat = record.sharedChat;
  if (nonEmptyObject(record.metadata)) out.metadata = record.metadata;
  return out;
}

function toPersistedEventRecord(value, defaults = {}) {
  const record = normalizeEventRecord(value, defaults);
  const out = { id: record.id, timestamp: record.timestamp, type: record.type, text: record.text };
  if (record.sourceEventId) out.sourceEventId = record.sourceEventId;
  const actor = compactIdentityForPersistence(record.actor);
  if (actor) out.actor = actor;
  const target = compactIdentityForPersistence(record.target);
  if (target) out.target = target;
  if (record.anonymous) out.anonymous = true;
  if (record.amount !== null && record.amount !== undefined) out.amount = record.amount;
  if (record.quantity !== null && record.quantity !== undefined) out.quantity = record.quantity;
  if (record.rewardId) out.rewardId = record.rewardId;
  if (nonEmptyObject(record.metadata)) out.metadata = record.metadata;
  return out;
}

function toPersistedPendingLearning(value) {
  if (!value) return null;
  return {
    streamId: String(value.streamId || ''),
    windowId: String(value.windowId || ''),
    dueAt: Number(value.dueAt || 0),
    generationStartedAt: Number(value.generationStartedAt || 0),
    windowThroughAt: Number(value.windowThroughAt || 0),
    recapSummaryBody: String(value.recapSummaryBody || ''),
    streamLore: String(value.streamLore || ''),
    messageSnapshot: Array.isArray(value.messageSnapshot) ? value.messageSnapshot.map((item) => toPersistedChatRecord(item)) : [],
    contextSnapshot: Array.isArray(value.contextSnapshot) ? value.contextSnapshot : [],
    eventSnapshot: Array.isArray(value.eventSnapshot) ? value.eventSnapshot.map((item) => toPersistedEventRecord(item)) : [],
    sessionMemoryDone: value.sessionMemoryDone === true,
    viewerLearningDone: value.viewerLearningDone === true,
    streamLoreDone: value.streamLoreDone === true,
    createdAt: Number(value.createdAt || 0)
  };
}

function replyReferenceFromInput(replyTo = null, tags = {}) {
  if (replyTo && typeof replyTo === 'object') return replyTo;
  const messageId = String(tags?.['reply-parent-msg-id'] || '').trim();
  const text = String(tags?.['reply-parent-msg-body'] || '').trim();
  const author = normalizeIdentity({
    userId: tags?.['reply-parent-user-id'] || '',
    login: tags?.['reply-parent-user-login'] || '',
    displayName: tags?.['reply-parent-display-name'] || tags?.['reply-parent-user-login'] || '',
    role: 'viewer'
  });
  if (!messageId && !text && !author.login && !author.displayName) return null;
  return { messageId, text, author };
}

function formatCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}min ${seconds}s` : `${seconds}s`;
}

function nextAnchoredRecapAt(streamSessionStartedAt, afterMs = Date.now()) {
  const anchor = Number(streamSessionStartedAt || 0);
  if (!anchor) return Number(afterMs || Date.now()) + RECURRING_RECAP_DELAY;
  const after = Number(afterMs || Date.now());
  const firstDue = anchor + FIRST_RECAP_DELAY;
  if (after < firstDue) return firstDue;
  const completedIntervals = Math.floor((after - anchor) / RECURRING_RECAP_DELAY);
  return anchor + ((completedIntervals + 1) * RECURRING_RECAP_DELAY);
}

module.exports = {
  FIRST_RECAP_DELAY,
  RECURRING_RECAP_DELAY,
  sourceTimestamp,
  toStoredChatRecord,
  toStoredEventRecord,
  toPersistedChatRecord,
  toPersistedEventRecord,
  toPersistedPendingLearning,
  replyReferenceFromInput,
  formatCountdown,
  nextAnchoredRecapAt
};
