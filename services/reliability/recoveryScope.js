'use strict';

// Stream state comes from the existing lifecycle manager, never another API poll.
function timeMs(value) {
  if (value == null || value === '') return 0;
  const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) && time > 0 ? time : 0;
}
function streamState(status = {}) {
  return {
    known: status.streamStateInitialized === true,
    live: status.streamLive === true,
    id: String(status.currentStreamId || '').trim(),
    startedAt: timeMs(status.twitchStreamStartedAt || status.lastStreamStartedAt),
    endedAt: timeMs(status.lastStreamEndedAt),
    endedId: String(status.lastEndedStreamId || '').trim(),
    endConfirmed: status.lastStreamLifecycleEventType === 'offline'
  };
}
function eventTime(job) { return timeMs(job.payload?.timestamp) || timeMs(job.createdAt); }
function sessionBinding(job, status) {
  const state = streamState(status);
  const at = eventTime(job);
  if (job.sessionStreamId) return {};
  if (job.payload?.type === 'stream.online' && job.payload?.event?.id) {
    return { sessionStreamId: String(job.payload.event.id), sessionStartedAt: timeMs(job.payload.event.started_at) || at };
  }
  if (state.known && state.live && state.id && at && at >= state.startedAt) {
    return { sessionStreamId: state.id, sessionStartedAt: state.startedAt };
  }
  return {};
}
function staleEventReason(job, status, { now = Date.now(), maxAgeMs = 15 * 60000, checkAge = true } = {}) {
  const state = streamState(status);
  const type = String(job.payload?.type || '');
  const at = eventTime(job);
  const offline = type === 'stream.offline';
  const matchesCurrent = state.known && state.live && state.id &&
    (job.sessionStreamId ? job.sessionStreamId === state.id : at && at >= state.startedAt);
  const newerOnline = type === 'stream.online' && !job.steps?.lifecycle?.done &&
    job.sessionStreamId && job.sessionStreamId !== state.endedId &&
    (!state.startedAt || timeMs(job.sessionStartedAt) > state.startedAt);
  // Lifecycle cleanup itself must run, even when its webhook was delayed. Once
  // checkpointed, its optional public reaction has the usual finite lifetime.
  if (offline && !job.steps?.lifecycle?.done) {
    return state.known && state.live && state.startedAt && at && at < state.startedAt
      ? 'Event belongs to an earlier stream; its remaining actions were expired.' : '';
  }
  if (!newerOnline && state.known && state.live && state.id && job.sessionStreamId && state.id !== job.sessionStreamId) {
    return 'The event\'s stream has been replaced by a new session; remaining actions were expired.';
  }
  if (state.known && state.live && state.startedAt && at && at < state.startedAt) {
    return 'Event predates the current stream; its remaining actions were expired.';
  }
  if (!offline && !newerOnline && state.endConfirmed && state.endedId &&
      (job.sessionStreamId === state.endedId || (!job.sessionStreamId && at && at <= state.endedAt))) {
    return 'The stream has a confirmed end; remaining event actions were expired.';
  }
  // stream.offline is deliberately exempt from its OWN end boundary. Otherwise
  // an intentional stream-ended notification would never be allowed to run.
  if (!offline && !matchesCurrent && !newerOnline && at && state.endedAt && at <= state.endedAt) {
    return 'The stream ended; queued and unfinished event actions were expired.';
  }
  if (!offline && type !== 'stream.online' && state.known && !state.live && job.sessionStreamId && state.endedAt) {
    return 'There is no active stream for this session-only event; remaining actions were expired.';
  }
  if (checkAge && timeMs(job.createdAt) && now - timeMs(job.createdAt) > maxAgeMs) {
    return 'Event is too old to retry safely; stale notification actions were expired.';
  }
  return '';
}
function staleDeliveryReason(row, status) {
  const state = streamState(status);
  const id = String(row.sessionStreamId || row.payload?.streamId || '').trim();
  if (id && state.endConfirmed && state.endedId === id) return 'The delivery has a confirmed stream end.';
  if (id && state.known && state.live && state.id && id !== state.id) return 'Delivery belongs to an earlier stream.';
  if (id && state.known && state.live && id === state.id) return ''; // A confirmed replacement stream can overlap the old end timestamp.
  if (id && state.known && !state.live && state.endedAt) return 'The delivery\'s stream ended.';
  const at = timeMs(row.occurredAt || row.createdAt);
  // Legacy EventSub receipts used this stable key prefix before parentEventId
  // was stored. Do not apply this rule to unrelated standalone/moderator sends.
  if ((id || String(row.key || '').startsWith('event:')) && at && state.endedAt && at <= state.endedAt) {
    return 'The delivery\'s stream ended.';
  }
  return '';
}
module.exports = { timeMs, streamState, eventTime, sessionBinding, staleEventReason, staleDeliveryReason };
