const StreamLifecycleState = require('../models/StreamLifecycleState');

function normalizeChannelName(channelName) {
  return String(channelName || '').replace(/^#+/, '').toLowerCase().trim();
}

function toDateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function getStreamLifecycleState(channelName) {
  const normalizedChannel = normalizeChannelName(channelName);
  if (!normalizedChannel || StreamLifecycleState.db.readyState !== 1) return null;
  return StreamLifecycleState.findOne({ channelName: normalizedChannel }).lean();
}

async function saveStreamLifecycleState(channelName, patch = {}) {
  const normalizedChannel = normalizeChannelName(channelName);
  if (!normalizedChannel || StreamLifecycleState.db.readyState !== 1) return null;

  const update = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'lastStreamStartedAt')) {
    update.lastStreamStartedAt = toDateOrNull(patch.lastStreamStartedAt);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'lastStreamEndedAt')) {
    update.lastStreamEndedAt = toDateOrNull(patch.lastStreamEndedAt);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'lastKnownStreamId')) {
    update.lastKnownStreamId = String(patch.lastKnownStreamId || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'lastLifecycleEventType')) {
    const type = String(patch.lastLifecycleEventType || '').toLowerCase().trim();
    update.lastLifecycleEventType = type === 'online' || type === 'offline' ? type : '';
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'lastLifecycleEventAt')) {
    update.lastLifecycleEventAt = toDateOrNull(patch.lastLifecycleEventAt);
  }

  return StreamLifecycleState.findOneAndUpdate(
    { channelName: normalizedChannel },
    { $set: update },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  ).lean();
}

module.exports = {
  getStreamLifecycleState,
  saveStreamLifecycleState
};
