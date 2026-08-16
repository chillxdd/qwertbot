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
    .map((entry) => ({
      sequence: entry.sequence,
      text: String(entry.text || '').trim(),
      createdAt: entry.createdAt || null
    }))
    .filter((entry) => entry.text);
}

async function saveStreamRecap({ streamId, channelName, startedAt, text }) {
  const normalizedStreamId = normalizeStreamId(streamId);
  const normalizedChannelName = normalizeChannelName(channelName);
  const recapText = String(text || '').trim();

  if (!normalizedStreamId || !normalizedChannelName || !recapText) return null;

  const existing = await StreamRecapSession.findOne({ streamId: normalizedStreamId })
    .select({ recaps: 1 })
    .lean();

  const sequence = Array.isArray(existing?.recaps) ? existing.recaps.length + 1 : 1;

  return StreamRecapSession.findOneAndUpdate(
    { streamId: normalizedStreamId },
    {
      $setOnInsert: {
        channelName: normalizedChannelName,
        streamId: normalizedStreamId,
        startedAt: startedAt ? new Date(startedAt) : null
      },
      $push: {
        recaps: {
          sequence,
          text: recapText,
          createdAt: new Date()
        }
      }
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true
    }
  ).lean();
}

async function clearStreamRecapsByChannel(channelName) {
  const normalizedChannelName = normalizeChannelName(channelName);
  if (!normalizedChannelName) return { deletedCount: 0 };

  return StreamRecapSession.deleteMany({ channelName: normalizedChannelName });
}

module.exports = {
  getRecentStreamRecaps,
  saveStreamRecap,
  clearStreamRecapsByChannel
};
