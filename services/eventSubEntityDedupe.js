'use strict';

const { createHash } = require('node:crypto');
const { collection, WRITE_OPTIONS, isDuplicate } = require('./reliability/store');

// Twitch's message ID protects against ordinary delivery retries, but a single
// poll/prediction can produce multiple webhook messages for the same lifecycle
// milestone (for example, a poll can later move from completed to archived).
// Duplicate EventSub subscriptions can also produce distinct message IDs for
// the same underlying event. These one-shot milestones are additionally keyed
// by the stable poll/prediction ID so they execute only once.
const ONE_SHOT_EVENT_TYPES = new Map([
  ['channel.poll.begin', 'poll'],
  ['channel.poll.end', 'poll'],
  ['channel.prediction.begin', 'prediction'],
  ['channel.prediction.lock', 'prediction'],
  ['channel.prediction.end', 'prediction']
]);

const ONE_SHOT_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function cleanStatus(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function eventEntityId(event = {}) {
  const direct = String(event?.id || '').trim();
  if (direct) return direct;

  // Twitch documents `id` for these payloads. Keep a deterministic fallback
  // so malformed/legacy payloads still cannot fan out duplicate reactions.
  const fallback = [
    event?.broadcaster_user_id,
    event?.started_at,
    event?.title
  ].map((value) => String(value || '').trim()).join('|');
  if (!fallback.replace(/\|/g, '')) return '';
  return `fallback:${createHash('sha256').update(fallback).digest('hex')}`;
}

function oneShotEventMarkerId(namespace, type, event = {}) {
  if (!ONE_SHOT_EVENT_TYPES.has(type)) return '';
  const entityId = eventEntityId(event);
  if (!entityId) return '';
  const digest = createHash('sha256').update(`${namespace}:${type}:${entityId}`).digest('hex');
  return `event-one-shot:${digest}`;
}

async function claimOneShotEvent(namespace, type, event = {}, messageId = '', getCollection = collection) {
  const markerId = oneShotEventMarkerId(namespace, type, event);
  if (!markerId) {
    if (ONE_SHOT_EVENT_TYPES.has(type)) {
      console.warn(`[EventSub] ${type} arrived without a stable poll/prediction ID; entity-level dedupe was unavailable.`);
    }
    return { accepted: true, applicable: ONE_SHOT_EVENT_TYPES.has(type), entityId: '' };
  }

  const entityKind = ONE_SHOT_EVENT_TYPES.get(type);
  const entityId = eventEntityId(event);
  const now = new Date();
  let row;
  try {
    row = await getCollection().findOneAndUpdate(
      { _id: markerId },
      { $setOnInsert: {
        kind: 'event_one_shot_dedupe',
        namespace,
        eventType: type,
        entityKind,
        entityId: String(entityId).slice(0, 256),
        ownerMessageId: String(messageId || '').slice(0, 256),
        firstStatus: cleanStatus(event?.status),
        createdAt: now,
        purgeAt: new Date(now.getTime() + ONE_SHOT_EVENT_RETENTION_MS)
      } },
      { ...WRITE_OPTIONS, upsert: true, returnDocument: 'after', includeResultMetadata: false }
    );
  } catch (err) {
    // Two different EventSub messages for the same entity can race on separate
    // inbox workers. The _id is the lock; if both try to upsert at once, one
    // may observe E11000 before it can re-run as a normal match. Read the
    // winning marker and treat the other message as the duplicate.
    if (!isDuplicate(err)) throw err;
    row = await getCollection().findOne(
      { _id: markerId },
      { projection: { ownerMessageId: 1, firstStatus: 1 }, maxTimeMS: WRITE_OPTIONS.maxTimeMS }
    );
    if (!row) throw err;
  }

  // If the same durable inbox job retries after a crash between claiming the
  // marker and checkpointing the step, it remains the owner and may continue.
  // Any different Twitch message for the same milestone is suppressed.
  const accepted = String(row?.ownerMessageId || '') === String(messageId || '');
  return {
    accepted,
    applicable: true,
    entityKind,
    entityId: String(entityId),
    ownerMessageId: String(row?.ownerMessageId || ''),
    firstStatus: String(row?.firstStatus || '')
  };
}

module.exports = {
  ONE_SHOT_EVENT_TYPES,
  eventEntityId,
  oneShotEventMarkerId,
  claimOneShotEvent
};
