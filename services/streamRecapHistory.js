const { WRITE_OPTIONS } = require('./reliability/store');
const operationContext = require('./reliability/context');
const StreamRecapSession = require('../models/StreamRecapSession');
const StreamEndLearningJob = require('../models/StreamEndLearningJob');

function normalizeStreamId(streamId) {
  return String(streamId || '').trim();
}

function normalizeChannelName(channelName) {
  return String(channelName || '').trim().toLowerCase();
}

async function getRecentStreamRecaps({ streamId, limit = 5 }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  if (!normalizedStreamId) return [];
  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 5));

  // Slice in MongoDB so Atlas returns only the recap rows the caller can use.
  const session = await StreamRecapSession.findOne({ streamId: normalizedStreamId })
    .select({ recaps: { $slice: -safeLimit } })
    .lean();

  if (!session || !Array.isArray(session.recaps)) return [];
  return session.recaps
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
    // updateOne avoids sending the just-written multi-megabyte document back to
    // Render. Callers only need durable acknowledgement, not the saved document.
    const now = new Date();
    // Use the native collection for active-state persistence so MongoDB receives
    // the compact recovery records exactly as built. Mongoose subdocument
    // defaults would otherwise re-expand omitted empty/default fields before the
    // command is sent across Render -> Atlas.
    return await StreamRecapSession.collection.updateOne({ streamId: normalizedStreamId, endedAt: null,
      $or: [{ writerFence: { $exists: false } }, { writerFence: { $lte: writerFence } }] }, {
      $setOnInsert: { channelName: normalizedChannelName, streamId: normalizedStreamId,
        startedAt: startedAt ? new Date(startedAt) : null, endedAt: null, createdAt: now },
      $set: { writerFence, activeState: { ...state, savedAt: now }, updatedAt: now }
    }, { ...WRITE_OPTIONS, upsert: true });
  } catch (err) {
    if (err.code === 11000) throw new Error('Stale recap checkpoint rejected: a newer instance/session owns the state.');
    throw err;
  }
}

async function saveActiveRecapDelta({ streamId, expected = {}, set = {}, push = {}, writerFence = operationContext.fence() }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  if (!normalizedStreamId) throw new Error('Invalid active recap delta checkpoint.');

  const filter = {
    streamId: normalizedStreamId,
    endedAt: null,
    $or: [{ writerFence: { $exists: false } }, { writerFence: { $lte: writerFence } }],
    'activeState.windowId': String(expected.windowId || ''),
    'activeState.messageSequence': Number(expected.messageSequence || 0),
    'activeState.contextSequence': Number(expected.contextSequence || 0),
    'activeState.eventSequence': Number(expected.eventSequence || 0)
  };

  if (expected.pendingLearningWindowId) {
    filter['activeState.pendingLearning.windowId'] = String(expected.pendingLearningWindowId);
  } else if (expected.pendingLearningIsNull === true) {
    // MongoDB's null match also accepts a missing field, which keeps this
    // compatible with active-state documents created before pendingLearning.
    filter['activeState.pendingLearning'] = null;
  }

  const $set = {
    writerFence,
    'activeState.savedAt': new Date()
  };
  for (const [key, value] of Object.entries(set || {})) {
    if (!key || key.startsWith('$')) continue;
    $set[`activeState.${key}`] = value;
  }

  const $push = {};
  for (const [key, values] of Object.entries(push || {})) {
    if (!key || key.startsWith('$') || !Array.isArray(values) || values.length === 0) continue;
    $push[`activeState.${key}`] = { $each: values };
  }

  const update = { $set };
  if (Object.keys($push).length) update.$push = $push;

  update.$set.updatedAt = new Date();
  const result = await StreamRecapSession.collection.updateOne(filter, update, WRITE_OPTIONS);
  return {
    matched: Number(result?.matchedCount || 0) > 0,
    matchedCount: Number(result?.matchedCount || 0),
    modifiedCount: Number(result?.modifiedCount || 0)
  };
}

async function saveFinalLearningJob({ streamId, channelName, segments = [], writerFence = operationContext.fence() }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  const normalizedChannelName = normalizeChannelName(channelName);
  const safeSegments = Array.isArray(segments)
    ? segments.filter((segment) => segment?.segmentId && Array.isArray(segment?.messageSnapshot) && segment.messageSnapshot.length)
    : [];
  if (!normalizedStreamId || !normalizedChannelName || !safeSegments.length) return null;
  const now = Date.now();
  try {
    return await StreamEndLearningJob.findOneAndUpdate({ streamId: normalizedStreamId,
      $or: [{ writerFence: { $exists: false } }, { writerFence: { $lte: writerFence } }] }, {
      $setOnInsert: { streamId: normalizedStreamId },
      $set: { writerFence, channelName: normalizedChannelName, segments: safeSegments,
        attempts: 0, nextAttemptAt: now, lastError: '' }
    }, { ...WRITE_OPTIONS, upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  } catch (err) {
    if (err?.code === 11000) throw new Error('Stale final-learning snapshot rejected: a newer instance owns this stream job.');
    throw err;
  }
}

async function getFinalLearningJob({ streamId }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  if (!normalizedStreamId) return null;
  return StreamEndLearningJob.findOne({ streamId: normalizedStreamId }).lean();
}

async function getPendingFinalLearningJobs({ channelName, limit = 10 } = {}) {
  const normalizedChannelName = normalizeChannelName(channelName);
  if (!normalizedChannelName) return [];
  const safeLimit = Math.max(1, Math.min(25, Number(limit) || 10));
  return StreamEndLearningJob.find({ channelName: normalizedChannelName })
    .sort({ updatedAt: 1 })
    .limit(safeLimit)
    .lean();
}

async function updateFinalLearningSegment({ streamId, segmentId, patch = {}, writerFence = operationContext.fence() }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  const normalizedSegmentId = String(segmentId || '').trim();
  if (!normalizedStreamId || !normalizedSegmentId) return null;
  const allowed = ['viewerLearningDone', 'streamLoreDone'];
  const set = { writerFence, lastError: '' };
  for (const field of allowed) if (field in patch) set[`segments.$.${field}`] = patch[field] === true;
  return StreamEndLearningJob.updateOne({ streamId: normalizedStreamId, 'segments.segmentId': normalizedSegmentId,
    $or: [{ writerFence: { $exists: false } }, { writerFence: { $lte: writerFence } }] }, { $set: set }, WRITE_OPTIONS);
}

async function markFinalLearningRetry({ streamId, error = '', retryAt = Date.now() + 60000, writerFence = operationContext.fence() }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  if (!normalizedStreamId) return null;
  return StreamEndLearningJob.updateOne({ streamId: normalizedStreamId,
    $or: [{ writerFence: { $exists: false } }, { writerFence: { $lte: writerFence } }] }, {
    $inc: { attempts: 1 },
    $set: { writerFence, nextAttemptAt: Number(retryAt) || Date.now() + 60000,
      lastError: String(error || '').slice(0, 1000) }
  }, WRITE_OPTIONS);
}

async function clearFinalLearningJob({ streamId, writerFence = operationContext.fence() }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  if (!normalizedStreamId) return null;
  return StreamEndLearningJob.deleteOne({ streamId: normalizedStreamId,
    $or: [{ writerFence: { $exists: false } }, { writerFence: { $lte: writerFence } }] }, WRITE_OPTIONS);
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
  saveActiveRecapDelta,
  clearActiveRecapState,
  clearStreamRecapsByChannel,
  clearStreamRecapsForStream,
  saveFinalLearningJob,
  getFinalLearningJob,
  getPendingFinalLearningJobs,
  updateFinalLearningSegment,
  markFinalLearningRetry,
  clearFinalLearningJob
};
