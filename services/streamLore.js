const StreamLore = require('../models/StreamLore');

const MAX_STREAM_LORE_LENGTH = 12000;

function normalizeChannelName(channelName) {
  return String(channelName || '').toLowerCase().trim();
}

async function getStreamLore(channelName) {
  const normalizedChannelName = normalizeChannelName(channelName);
  if (!normalizedChannelName) return { text: '', updatedAt: null };

  const doc = await StreamLore.findOne({ channelName: normalizedChannelName }).lean();

  return {
    text: String(doc?.text || ''),
    updatedAt: doc?.updatedAt || null
  };
}

async function saveStreamLore(channelName, text) {
  const normalizedChannelName = normalizeChannelName(channelName);
  if (!normalizedChannelName) throw new Error('TWITCH_CHANNEL is not configured.');

  const normalizedText = String(text || '').trim();
  if (normalizedText.length > MAX_STREAM_LORE_LENGTH) {
    throw new Error(`Stream-specific lore cannot exceed ${MAX_STREAM_LORE_LENGTH} characters.`);
  }

  const doc = await StreamLore.findOneAndUpdate(
    { channelName: normalizedChannelName },
    { $set: { text: normalizedText } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  return {
    text: String(doc?.text || ''),
    updatedAt: doc?.updatedAt || null
  };
}

module.exports = {
  MAX_STREAM_LORE_LENGTH,
  getStreamLore,
  saveStreamLore
};
