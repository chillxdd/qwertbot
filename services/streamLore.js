const StreamLore = require('../models/StreamLore');
const { containsPromptInjectionLanguage } = require('./promptSecurity');

const MAX_STREAM_LORE_LENGTH = 12000;
const MAX_LEARNED_LORE = 80;
const MAX_LEARNED_LORE_LENGTH = 400;

function normalizeChannelName(channelName) {
  return String(channelName || '').toLowerCase().trim();
}

function normalizeConfidence(value) {
  return ['low', 'medium', 'high'].includes(value) ? value : 'medium';
}

function normalizeObservationText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEARNED_LORE_LENGTH);
}

function serializeObservation(observation) {
  return {
    id: String(observation?._id || ''),
    text: String(observation?.text || ''),
    confidence: normalizeConfidence(observation?.confidence),
    evidenceCount: Math.max(1, Number(observation?.evidenceCount || 1)),
    firstObservedAt: observation?.firstObservedAt || null,
    lastObservedAt: observation?.lastObservedAt || null,
    enabled: observation?.enabled === true
  };
}

function buildEffectiveLore(manualText, learnedObservations = []) {
  const manual = String(manualText || '').trim();
  const approved = learnedObservations
    .filter((observation) => observation?.enabled === true && String(observation?.text || '').trim())
    .map((observation) => `- ${String(observation.text).trim()}`);
  return [manual, approved.length ? `AI-learned lore approved by a moderator:\n${approved.join('\n')}` : ''].filter(Boolean).join('\n\n');
}

async function getStreamLore(channelName) {
  const normalizedChannelName = normalizeChannelName(channelName);
  if (!normalizedChannelName) return { text: '', learnedObservations: [], effectiveText: '', updatedAt: null };

  const doc = await StreamLore.findOne({ channelName: normalizedChannelName }).lean();
  const learnedObservations = (Array.isArray(doc?.learnedObservations) ? doc.learnedObservations : []).map(serializeObservation);
  const text = String(doc?.text || '');

  return {
    text,
    learnedObservations,
    effectiveText: buildEffectiveLore(text, learnedObservations),
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

  const learnedObservations = (Array.isArray(doc?.learnedObservations) ? doc.learnedObservations : []).map(serializeObservation);
  return {
    text: String(doc?.text || ''),
    learnedObservations,
    effectiveText: buildEffectiveLore(doc?.text || '', learnedObservations),
    updatedAt: doc?.updatedAt || null
  };
}

function findSimilarObservation(observations, text) {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!normalized) return null;
  return observations.find((observation) => {
    const candidate = String(observation.text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate);
  }) || null;
}

async function applyStreamLoreObservations(channelName, observations = []) {
  const channel = normalizeChannelName(channelName);
  if (!channel) return { applied: 0, skipped: 0 };
  let doc = await StreamLore.findOne({ channelName: channel });
  if (!doc) doc = new StreamLore({ channelName: channel });
  if (!Array.isArray(doc.learnedObservations)) doc.learnedObservations = [];
  let applied = 0;
  let skipped = 0;

  for (const raw of Array.isArray(observations) ? observations : []) {
    const text = normalizeObservationText(raw?.fact || raw?.text || raw?.observation);
    if (!text || containsPromptInjectionLanguage(text)) { skipped++; continue; }
    const match = findSimilarObservation(doc.learnedObservations, text);
    const now = new Date();
    const supportCount = Math.max(1, Math.min(6, Number(raw?.supportCount || 1)));
    if (match) {
      match.evidenceCount = Math.max(1, Number(match.evidenceCount || 1)) + supportCount;
      match.lastObservedAt = now;
      const incoming = normalizeConfidence(raw?.confidence);
      if (incoming === 'high' || (incoming === 'medium' && match.confidence === 'low')) match.confidence = incoming;
      applied++;
      continue;
    }
    if (doc.learnedObservations.length >= MAX_LEARNED_LORE) { skipped++; continue; }
    doc.learnedObservations.push({
      text,
      confidence: normalizeConfidence(raw?.confidence),
      evidenceCount: supportCount,
      firstObservedAt: now,
      lastObservedAt: now,
      enabled: false
    });
    applied++;
  }

  if (applied) await doc.save();
  return { applied, skipped };
}

async function setLearnedObservationEnabled(channelName, observationId, enabled) {
  const channel = normalizeChannelName(channelName);
  const doc = await StreamLore.findOne({ channelName: channel });
  if (!doc) throw new Error('Stream lore not found.');
  const observation = doc.learnedObservations.id(observationId);
  if (!observation) throw new Error('Learned lore observation not found.');
  observation.enabled = Boolean(enabled);
  await doc.save();
  return getStreamLore(channel);
}

async function deleteLearnedObservation(channelName, observationId) {
  const channel = normalizeChannelName(channelName);
  const doc = await StreamLore.findOne({ channelName: channel });
  if (!doc) throw new Error('Stream lore not found.');
  const observation = doc.learnedObservations.id(observationId);
  if (!observation) throw new Error('Learned lore observation not found.');
  observation.deleteOne();
  await doc.save();
  return getStreamLore(channel);
}

module.exports = {
  MAX_STREAM_LORE_LENGTH,
  MAX_LEARNED_LORE,
  getStreamLore,
  saveStreamLore,
  applyStreamLoreObservations,
  setLearnedObservationEnabled,
  deleteLearnedObservation
};
