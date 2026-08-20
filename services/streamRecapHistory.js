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

async function saveStreamRecap({ streamId, channelName, startedAt, text }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  const normalizedChannelName = normalizeChannelName(channelName);
  const recapText = String(text || '').trim();
  if (!normalizedStreamId || !normalizedChannelName || !recapText) return null;

  const existing = await StreamRecapSession.findOne({ streamId: normalizedStreamId }).select({ recaps: 1 }).lean();
  const sequence = Array.isArray(existing?.recaps) ? existing.recaps.length + 1 : 1;

  return StreamRecapSession.findOneAndUpdate(
    { streamId: normalizedStreamId },
    {
      $setOnInsert: {
        channelName: normalizedChannelName,
        streamId: normalizedStreamId,
        startedAt: startedAt ? new Date(startedAt) : null
      },
      $push: { recaps: { sequence, text: recapText, createdAt: new Date() } }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
}


async function getSessionMemoryBlocks({ streamId }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  if (!normalizedStreamId) return [];
  const session = await StreamRecapSession.findOne({ streamId: normalizedStreamId }).select({ sessionMemoryBlocks: 1 }).lean();
  return Array.isArray(session?.sessionMemoryBlocks) ? session.sessionMemoryBlocks : [];
}

async function saveSessionMemoryBlock({ streamId, channelName, startedAt, block }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  const normalizedChannelName = normalizeChannelName(channelName);
  if (!normalizedStreamId || !normalizedChannelName || !block?.detailedSummary) return null;

  const existing = await StreamRecapSession.findOne({ streamId: normalizedStreamId }).select({ sessionMemoryBlocks: 1 }).lean();
  const sequence = Array.isArray(existing?.sessionMemoryBlocks) ? existing.sessionMemoryBlocks.length + 1 : 1;

  const memoryBlock = {
    sequence,
    startedAtMs: block.startedAtMs || null,
    endedAtMs: Number(block.endedAtMs || Date.now()),
    detailedSummary: String(block.detailedSummary || '').trim(),
    compactSummary: String(block.compactSummary || block.detailedSummary || '').trim(),
    topics: Array.isArray(block.topics) ? block.topics : [],
    people: Array.isArray(block.people) ? block.people : [],
    createdAt: new Date()
  };

  return StreamRecapSession.findOneAndUpdate(
    { streamId: normalizedStreamId },
    {
      $setOnInsert: {
        channelName: normalizedChannelName,
        streamId: normalizedStreamId,
        startedAt: startedAt ? new Date(startedAt) : null
      },
      $push: { sessionMemoryBlocks: memoryBlock }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
}

async function clearSessionMemory({ streamId }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  if (!normalizedStreamId) return null;
  return StreamRecapSession.updateOne({ streamId: normalizedStreamId }, { $set: { sessionMemoryBlocks: [] } });
}

async function getActiveRecapState({ streamId }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  if (!normalizedStreamId) return null;
  const session = await StreamRecapSession.findOne({ streamId: normalizedStreamId }).select({ activeState: 1, startedAt: 1 }).lean();
  return session?.activeState || null;
}

async function saveActiveRecapState({ streamId, channelName, startedAt, state }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  const normalizedChannelName = normalizeChannelName(channelName);
  if (!normalizedStreamId || !normalizedChannelName || !state) return null;

  return StreamRecapSession.findOneAndUpdate(
    { streamId: normalizedStreamId },
    {
      $setOnInsert: {
        channelName: normalizedChannelName,
        streamId: normalizedStreamId,
        startedAt: startedAt ? new Date(startedAt) : null
      },
      $set: { activeState: { ...state, savedAt: new Date() } }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
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
  clearStreamRecapsByChannel
};
