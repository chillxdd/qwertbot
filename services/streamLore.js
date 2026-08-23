const StreamLore = require('../models/StreamLore');

const MAX_STREAM_LORE_LENGTH = 12000;
const MAX_AI_STREAM_LORE_LENGTH = 12000;
const MAX_AI_LORE_OBSERVATIONS = 80;
const MAX_AI_LORE_OBSERVATION_LENGTH = 400;

function normalizeChannelName(channelName) {
  return String(channelName || '').toLowerCase().trim();
}

function normalizeObservationText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_AI_LORE_OBSERVATION_LENGTH);
}

function observationKey(value) {
  return normalizeObservationText(value).toLowerCase().replace(/[.!?]+$/g, '').trim();
}

function normalizeConfidence(value) {
  return ['low', 'medium', 'high'].includes(value) ? value : 'medium';
}

function serializeObservation(item) {
  return {
    id: String(item?._id || ''),
    text: String(item?.text || ''),
    confidence: normalizeConfidence(item?.confidence),
    evidenceCount: Math.max(1, Number(item?.evidenceCount || 1)),
    firstObservedAt: item?.firstObservedAt || null,
    lastObservedAt: item?.lastObservedAt || null,
    status: ['pending', 'approved', 'rejected'].includes(item?.status) ? item.status : 'pending',
    reviewedAt: item?.reviewedAt || null
  };
}

function buildEffectiveLore(text, aiText) {
  const manual = String(text || '').trim();
  const approvedAi = String(aiText || '').trim();
  if (!manual && !approvedAi) return '';
  if (!approvedAi) return `MANUAL LORE:
${manual}`;
  if (!manual) return `APPROVED AI LORE:
${approvedAi}`;
  return `MANUAL LORE:
${manual}

APPROVED AI LORE:
${approvedAi}`;
}

function serializeLore(doc) {
  const value = doc && typeof doc.toObject === 'function' ? doc.toObject() : (doc || {});
  const text = String(value.text || '');
  const aiText = String(value.aiText || '');
  const observations = (Array.isArray(value.aiObservations) ? value.aiObservations : []).map(serializeObservation);
  return {
    text,
    aiText,
    effectiveText: buildEffectiveLore(text, aiText),
    observations,
    pendingObservations: observations.filter((item) => item.status === 'pending'),
    updatedAt: value.updatedAt || null
  };
}

async function getStreamLore(channelName) {
  const normalizedChannelName = normalizeChannelName(channelName);
  if (!normalizedChannelName) return serializeLore(null);

  const doc = await StreamLore.findOne({ channelName: normalizedChannelName }).lean();
  return serializeLore(doc);
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
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  ).lean();

  return serializeLore(doc);
}

async function saveAiStreamLore(channelName, text) {
  const normalizedChannelName = normalizeChannelName(channelName);
  if (!normalizedChannelName) throw new Error('TWITCH_CHANNEL is not configured.');

  const normalizedText = String(text || '').trim();
  if (normalizedText.length > MAX_AI_STREAM_LORE_LENGTH) {
    throw new Error(`Approved AI lore cannot exceed ${MAX_AI_STREAM_LORE_LENGTH} characters.`);
  }

  const doc = await StreamLore.findOneAndUpdate(
    { channelName: normalizedChannelName },
    { $set: { aiText: normalizedText } },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  ).lean();

  return serializeLore(doc);
}

async function applyStreamLoreObservations({ channelName, observations = [] }) {
  const normalizedChannelName = normalizeChannelName(channelName);
  if (!normalizedChannelName || !Array.isArray(observations) || observations.length === 0) {
    return { applied: 0, skipped: Array.isArray(observations) ? observations.length : 0 };
  }

  let doc = await StreamLore.findOne({ channelName: normalizedChannelName });
  if (!doc) doc = new StreamLore({ channelName: normalizedChannelName });

  const manualText = String(doc.text || '').toLowerCase();
  const aiText = String(doc.aiText || '').toLowerCase();
  const now = new Date();
  let applied = 0;
  let skipped = 0;

  for (const observation of observations.slice(0, 20)) {
    const text = normalizeObservationText(observation?.text || observation?.fact);
    if (!text) { skipped++; continue; }
    const key = observationKey(text);
    if (!key || manualText.includes(key) || aiText.includes(key)) { skipped++; continue; }

    const existing = doc.aiObservations.find((item) => observationKey(item.text) === key);
    if (existing) {
      existing.evidenceCount = Math.max(1, Number(existing.evidenceCount || 1)) + 1;
      existing.lastObservedAt = now;
      if (existing.status === 'pending') existing.confidence = normalizeConfidence(observation?.confidence || existing.confidence);
      applied++;
      continue;
    }

    if (doc.aiObservations.length >= MAX_AI_LORE_OBSERVATIONS) {
      const removableIndex = doc.aiObservations.findIndex((item) => item.status === 'rejected');
      if (removableIndex >= 0) doc.aiObservations.splice(removableIndex, 1);
      else { skipped++; continue; }
    }

    doc.aiObservations.push({
      text,
      confidence: normalizeConfidence(observation?.confidence),
      evidenceCount: 1,
      firstObservedAt: now,
      lastObservedAt: now,
      status: 'pending',
      reviewedAt: null
    });
    applied++;
  }

  if (applied > 0) await doc.save();
  return { applied, skipped };
}

async function reviewStreamLoreObservation(channelName, observationId, action) {
  const normalizedChannelName = normalizeChannelName(channelName);
  const normalizedAction = String(action || '').toLowerCase().trim();
  if (!normalizedChannelName) throw new Error('TWITCH_CHANNEL is not configured.');
  if (!['approve', 'reject'].includes(normalizedAction)) throw new Error('Invalid lore observation action.');

  const doc = await StreamLore.findOne({ channelName: normalizedChannelName });
  if (!doc) throw new Error('Stream lore was not found.');
  const observation = doc.aiObservations.id(observationId);
  if (!observation) throw new Error('Lore observation was not found.');
  if (observation.status !== 'pending') throw new Error('This lore observation has already been reviewed.');

  if (normalizedAction === 'approve') {
    const candidate = normalizeObservationText(observation.text);
    const current = String(doc.aiText || '').trim();
    const candidateKey = observationKey(candidate);
    if (candidate && !String(current).toLowerCase().includes(candidateKey)) {
      const next = current ? `${current}\n${candidate}` : candidate;
      if (next.length > MAX_AI_STREAM_LORE_LENGTH) {
        throw new Error(`Approved AI lore cannot exceed ${MAX_AI_STREAM_LORE_LENGTH} characters.`);
      }
      doc.aiText = next;
    }
    observation.status = 'approved';
  } else {
    observation.status = 'rejected';
  }
  observation.reviewedAt = new Date();
  await doc.save();
  return serializeLore(doc);
}

module.exports = {
  MAX_STREAM_LORE_LENGTH,
  MAX_AI_STREAM_LORE_LENGTH,
  MAX_AI_LORE_OBSERVATIONS,
  MAX_AI_LORE_OBSERVATION_LENGTH,
  getStreamLore,
  saveStreamLore,
  saveAiStreamLore,
  applyStreamLoreObservations,
  reviewStreamLoreObservation
};
