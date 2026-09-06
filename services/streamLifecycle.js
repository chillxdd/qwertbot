const { WRITE_OPTIONS } = require('./reliability/store');
const context = require('./reliability/context');
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
  if (!normalizedChannel) throw new Error('A channel is required for lifecycle state.');
  if (StreamLifecycleState.db.readyState !== 1) throw new Error('MongoDB is not connected; lifecycle state is not durable.');
  const fence = context.fence();
  const row = await StreamLifecycleState.findOneAndUpdate({ channelName: normalizedChannel,
    $or: [{ writerFence: { $exists: false } }, { writerFence: { $lte: fence } }]
  }, { $set: { writerFence: fence } }, { ...WRITE_OPTIONS, new: true }).lean();
  if (!row && await StreamLifecycleState.exists({ channelName: normalizedChannel })) {
    throw new Error('A newer instance owns the stream lifecycle state.');
  }
  return row;
}

async function saveStreamLifecycleState(channelName, patch = {}) {
  const normalizedChannel = normalizeChannelName(channelName);
  if (!normalizedChannel) throw new Error('A channel is required for lifecycle state.');
  if (StreamLifecycleState.db.readyState !== 1) throw new Error('MongoDB is not connected; lifecycle state is not durable.');

  const update = { writerFence: context.fence() };
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
    { channelName: normalizedChannel, $or: [
      { writerFence: { $exists: false } }, { writerFence: { $lte: update.writerFence } }
    ] },
    { $set: update },
    { ...WRITE_OPTIONS, upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  ).lean();
}

module.exports = {
  getStreamLifecycleState,
  saveStreamLifecycleState
};
