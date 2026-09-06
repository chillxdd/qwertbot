const { WRITE_OPTIONS } = require('./reliability/store');
const operationContext = require('./reliability/context');
const StreamRecapSession = require('../models/StreamRecapSession');

function normalizeStreamId(streamId) {
  return String(streamId || '').trim();
}

function normalizeChannelName(channelName) {
  return String(channelName || '').trim().toLowerCase();
}

async function getRecentStreamRecaps({ streamId, limit = 5 }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  if (!normalizedStreamId) return [];

  const session = await StreamRecapSession.findOne({ streamId: normalizedStreamId })
    .select({ recaps: 1 })
    .lean();

  if (!session || !Array.isArray(session.recaps)) return [];
  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 5));
  return session.recaps
    .slice(-safeLimit)
    .map((entry) => ({ sequence: entry.sequence, text: String(entry.text || '').trim(), createdAt: entry.createdAt || null }))
    .filter((entry) => entry.text);
}

function liveFencedFilter(streamId) {
  return { streamId, endedAt: null, $or: [
    { writerFence: { $exists: false } }, { writerFence: { $lte: operationContext.fence() } }
  ] };
}

async function saveStreamRecap({ streamId, channelName, startedAt, text, windowId = '' }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  const normalizedChannelName = normalizeChannelName(channelName);
  const recapText = String(text || '').trim();
  if (!normalizedStreamId || !normalizedChannelName || !recapText) return null;
  const counter = await StreamRecapSession.findOneAndUpdate(
    liveFencedFilter(normalizedStreamId),
    { $inc: { recapSequence: 1 }, $set: { writerFence: operationContext.fence() }, $setOnInsert: { channelName: normalizedChannelName,
      streamId: normalizedStreamId, startedAt: startedAt ? new Date(startedAt) : null } },
    { ...WRITE_OPTIONS, upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return StreamRecapSession.updateOne({ ...liveFencedFilter(normalizedStreamId),
    ...(windowId ? { 'recaps.windowId': { $ne: windowId } } : {}) }, {
    $push: { recaps: { $each: [{ windowId, sequence: counter.recapSequence,
      text: recapText.slice(0, 2000), createdAt: new Date() }], $slice: -96 } }
  }, WRITE_OPTIONS);
}


async function getSessionMemoryBlocks({ streamId }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  if (!normalizedStreamId) return [];
  const session = await StreamRecapSession.findOne({ streamId: normalizedStreamId }).select({ sessionMemoryBlocks: 1 }).lean();
  return Array.isArray(session?.sessionMemoryBlocks) ? session.sessionMemoryBlocks : [];
}

async function saveSessionMemoryBlock({ streamId, channelName, startedAt, block, windowId = '' }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  const normalizedChannelName = normalizeChannelName(channelName);
  if (!normalizedStreamId || !normalizedChannelName || !block?.detailedSummary) return null;

  operationContext.throwIfCancelled();
  const counter = await StreamRecapSession.findOneAndUpdate(
    liveFencedFilter(normalizedStreamId),
    { $inc: { memorySequence: 1 }, $set: { writerFence: operationContext.fence() }, $setOnInsert: { channelName: normalizedChannelName,
      streamId: normalizedStreamId, startedAt: startedAt ? new Date(startedAt) : null } },
    { ...WRITE_OPTIONS, new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  const sequence = counter.memorySequence;

  const memoryBlock = {
    windowId, sequence,
    startedAtMs: block.startedAtMs || null,
    endedAtMs: Number(block.endedAtMs || Date.now()),
    detailedSummary: String(block.detailedSummary || '').trim(),
    compactSummary: String(block.compactSummary || block.detailedSummary || '').trim(),
    topics: Array.isArray(block.topics) ? block.topics : [],
    people: Array.isArray(block.people) ? block.people : [],
    sharedChatGuests: Array.isArray(block.sharedChatGuests) ? block.sharedChatGuests.map((guest) => ({
      userId: String(guest?.userId || '').trim(),
      login: String(guest?.login || '').trim(),
      displayName: String(guest?.displayName || guest?.login || '').trim(),
      sourceBroadcasterUserId: String(guest?.sourceBroadcasterUserId || '').trim(),
      sourceBroadcasterLogin: String(guest?.sourceBroadcasterLogin || '').trim(),
      sourceBroadcasterDisplayName: String(guest?.sourceBroadcasterDisplayName || guest?.sourceBroadcasterLogin || '').trim()
    })).filter((guest) => guest.userId || guest.login || guest.displayName) : [],
    claims: Array.isArray(block.claims) ? block.claims.map((claim) => ({
      text: String(claim?.text || '').trim(),
      sourceIds: Array.isArray(claim?.sourceIds) ? claim.sourceIds.map((id) => String(id || '').trim()).filter(Boolean) : [],
      people: Array.isArray(claim?.people) ? claim.people.map((name) => String(name || '').trim()).filter(Boolean) : []
    })).filter((claim) => claim.text) : [],
    sourceMessageIds: Array.isArray(block.sourceMessageIds) ? block.sourceMessageIds.map((id) => String(id || '').trim()).filter(Boolean) : [],
    sourceEventIds: Array.isArray(block.sourceEventIds) ? block.sourceEventIds.map((id) => String(id || '').trim()).filter(Boolean) : [],
    attributionAudited: block.attributionAudited === true,
    createdAt: new Date()
  };

  operationContext.throwIfCancelled();
  if (Buffer.byteLength(JSON.stringify(memoryBlock)) > 128 * 1024) {
    throw new Error('Session-memory block exceeded its 128 KiB storage safety limit.');
  }
  return StreamRecapSession.updateOne({ ...liveFencedFilter(normalizedStreamId),
    ...(windowId ? { 'sessionMemoryBlocks.windowId': { $ne: windowId } } : {}) }, {
    $push: { sessionMemoryBlocks: { $each: [memoryBlock], $slice: -48 } }
  }, WRITE_OPTIONS);

}

async function clearSessionMemory({ streamId }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  if (!normalizedStreamId) return null;
  operationContext.throwIfCancelled();
  return StreamRecapSession.updateOne(liveFencedFilter(normalizedStreamId), { $set: { sessionMemoryBlocks: [] } }, WRITE_OPTIONS);
}

async function getActiveRecapState({ streamId, writerFence = operationContext.fence() }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  if (!normalizedStreamId) return null;
  // Fence out the previous instance BEFORE returning the snapshot we will restore.
  const session = await StreamRecapSession.findOneAndUpdate({ streamId: normalizedStreamId,
    $or: [{ writerFence: { $exists: false } }, { writerFence: { $lte: writerFence } }] }, {
    $set: { writerFence, endedAt: null }, $unset: { purgeAt: 1 }
  }, { ...WRITE_OPTIONS, new: true }).lean();
  if (!session && await StreamRecapSession.exists({ streamId: normalizedStreamId })) {
    throw new Error('A newer instance owns this recap state.');
  }
  return session?.activeState || null;
}

async function saveActiveRecapState({ streamId, channelName, startedAt, state, writerFence = operationContext.fence() }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  const normalizedChannelName = normalizeChannelName(channelName);
  if (!normalizedStreamId || !normalizedChannelName || !state) throw new Error('Invalid active recap checkpoint.');
  try {
    return await StreamRecapSession.findOneAndUpdate({ streamId: normalizedStreamId, endedAt: null,
      $or: [{ writerFence: { $exists: false } }, { writerFence: { $lte: writerFence } }] }, {
      $setOnInsert: { channelName: normalizedChannelName, streamId: normalizedStreamId,
        startedAt: startedAt ? new Date(startedAt) : null },
      $set: { writerFence, activeState: { ...state, savedAt: new Date() } }
    }, { ...WRITE_OPTIONS, new: true, upsert: true, setDefaultsOnInsert: true }).lean();
  } catch (err) {
    if (err.code === 11000) throw new Error('Stale recap checkpoint rejected: a newer instance/session owns the state.');
    throw err;
  }
}

async function clearStreamRecapsForStream({ streamId, channelName, writerFence = operationContext.fence() }) {
  if (!streamId || !channelName) return null;
  // Keep a short-lived tombstone so a late old-session write cannot recreate it.
  return StreamRecapSession.updateOne({ streamId: normalizeStreamId(streamId), channelName: normalizeChannelName(channelName),
    $or: [{ writerFence: { $exists: false } }, { writerFence: { $lte: writerFence } }] }, {
    $set: { writerFence, endedAt: new Date(), purgeAt: new Date(Date.now() + 7 * 86400000),
      activeState: null, recaps: [], sessionMemoryBlocks: [] }
  }, WRITE_OPTIONS);
}

async function clearActiveRecapState({ streamId }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  if (!normalizedStreamId) return null;
  return StreamRecapSession.updateOne({ streamId: normalizedStreamId }, { $unset: { activeState: 1 } });
}

async function clearStreamRecapsByChannel(channelName) {
  const normalizedChannelName = normalizeChannelName(channelName);
  if (!normalizedChannelName) return { deletedCount: 0 };
  return StreamRecapSession.deleteMany({ channelName: normalizedChannelName });
}

module.exports = {
  getRecentStreamRecaps,
  saveStreamRecap,
  getSessionMemoryBlocks,
  saveSessionMemoryBlock,
  clearSessionMemory,
  getActiveRecapState,
  saveActiveRecapState,
  clearActiveRecapState,
  clearStreamRecapsByChannel,
  clearStreamRecapsForStream
};
