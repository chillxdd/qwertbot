const StreamLore = require('../models/StreamLore');
const { containsPromptInjectionLanguage } = require('./promptSecurity');
const {
  normalizeConfidence,
  normalizeLearningRelation,
  textsEquivalent,
  textsRelated,
  buildEvidenceSummary,
  addSupportingEvidence,
  addContradictingEvidence,
  mergeRevisionProposal,
  applyPendingRevision,
  acceptRevision,
  dismissRevision,
  serializeRevisionProposal
} = require('./learningRevision');

const MAX_STREAM_LORE_LENGTH = 12000;
const MAX_LEARNED_LORE = 80;
const MAX_LEARNED_LORE_LENGTH = 400;

function normalizeChannelName(channelName) {
  return String(channelName || '').toLowerCase().trim();
}

function normalizeObservationText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEARNED_LORE_LENGTH);
}

function normalizeRevisionReason(value) {
  const reason = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return containsPromptInjectionLanguage(reason) ? '' : reason;
}

function inferApprovalStatus(observation) {
  if (observation?.approvalStatus === 'approved' || observation?.approvalStatus === 'pending') return observation.approvalStatus;
  return observation?.enabled === true ? 'approved' : 'pending';
}

function refreshObservationEvidenceSummary(observation) {
  if (!observation) return;
  observation.evidenceSummary = buildEvidenceSummary(observation);
}

function serializeObservation(observation) {
  const approvalStatus = inferApprovalStatus(observation);
  return {
    id: String(observation?._id || ''),
    text: String(observation?.text || ''),
    confidence: normalizeConfidence(observation?.confidence),
    evidenceCount: Math.max(1, Number(observation?.evidenceCount || 1)),
    supportingWindowCount: Math.max(1, Number(observation?.supportingWindowCount || 1)),
    contradictionCount: Math.max(0, Number(observation?.contradictionCount || 0)),
    revisionCount: Math.max(0, Number(observation?.revisionCount || 0)),
    evidenceSummary: String(observation?.evidenceSummary || buildEvidenceSummary(observation)),
    firstObservedAt: observation?.firstObservedAt || null,
    lastObservedAt: observation?.lastObservedAt || null,
    lastRefinedAt: observation?.lastRefinedAt || null,
    lastContradictedAt: observation?.lastContradictedAt || null,
    revisionProposal: serializeRevisionProposal(observation?.revisionProposal),
    approvalStatus,
    enabled: approvalStatus === 'approved' && observation?.enabled === true
  };
}

function buildEffectiveLore(manualText, learnedObservations = []) {
  const manual = String(manualText || '').trim();
  const approved = learnedObservations
    .filter((observation) => inferApprovalStatus(observation) === 'approved' && observation?.enabled === true && String(observation?.text || '').trim())
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
  return (Array.isArray(observations) ? observations : []).find((observation) => textsRelated(observation?.text, text, 0.58)) || null;
}

function resolveLoreObservationMatch(doc, raw, text) {
  const targetId = String(raw?.existingObservationId || raw?.targetId || '').trim();
  let match = null;
  if (targetId && doc?.learnedObservations?.id) {
    try { match = doc.learnedObservations.id(targetId); } catch (_) { match = null; }
  }
  if (!match && text) match = findSimilarObservation(doc?.learnedObservations, text);
  return match;
}

async function applyStreamLoreObservations(channelName, observations = []) {
  const channel = normalizeChannelName(channelName);
  const stats = { applied: 0, skipped: 0, created: 0, reinforced: 0, refined: 0, revisionsProposed: 0, contradictions: 0 };
  if (!channel) return stats;
  let doc = await StreamLore.findOne({ channelName: channel });
  if (!doc) doc = new StreamLore({ channelName: channel });
  if (!Array.isArray(doc.learnedObservations)) doc.learnedObservations = [];
  const supportTouchedThisWindow = new Set();
  const proposalTouchedThisWindow = new Set();
  const contradictionTouchedThisWindow = new Set();
  const relationPriority = { new: 0, support: 1, refine: 2, contradict: 3 };
  const candidates = (Array.isArray(observations) ? [...observations] : [])
    .sort((a, b) => (relationPriority[normalizeLearningRelation(a?.relation || a?.relationship)] ?? 0) - (relationPriority[normalizeLearningRelation(b?.relation || b?.relationship)] ?? 0));

  for (const raw of candidates) {
    let relation = normalizeLearningRelation(raw?.relation || raw?.relationship);
    const text = normalizeObservationText(raw?.fact || raw?.text || raw?.observation || raw?.proposedText);
    const confidence = normalizeConfidence(raw?.confidence);
    const supportCount = Math.max(1, Math.min(8, Number(raw?.supportCount || 1)));
    const reason = normalizeRevisionReason(raw?.reason);
    if (text && containsPromptInjectionLanguage(text)) { stats.skipped++; continue; }

    const match = resolveLoreObservationMatch(doc, raw, text);
    const now = new Date();
    if (match) {
      if (!['approved', 'pending'].includes(match.approvalStatus)) match.approvalStatus = match.enabled === true ? 'approved' : 'pending';
      const status = inferApprovalStatus(match);
      const key = String(match._id || match.id || match.text);

      if (relation === 'new') relation = text && !textsEquivalent(match.text, text) ? 'refine' : 'support';
      if (relation === 'support' || !text || textsEquivalent(match.text, text)) {
        const incrementWindow = !supportTouchedThisWindow.has(key);
        supportTouchedThisWindow.add(key);
        addSupportingEvidence(match, { supportCount, confidence }, { now, incrementWindow });
        refreshObservationEvidenceSummary(match);
        stats.reinforced++;
        stats.applied++;
        continue;
      }

      if (relation === 'contradict' && supportCount < 2) {
        stats.skipped++;
        continue;
      }

      if (status === 'pending') {
        const incrementWindow = !supportTouchedThisWindow.has(key);
        supportTouchedThisWindow.add(key);
        const result = applyPendingRevision(match, {
          relation,
          text,
          confidence,
          supportCount,
          reason
        }, { now, includeKind: false, incrementWindow });
        refreshObservationEvidenceSummary(match);
        if (result === 'reinforced') stats.reinforced++;
        else stats.refined++;
        if (relation === 'contradict') stats.contradictions++;
        stats.applied++;
        continue;
      }

      if (relation === 'contradict') {
        const demote = !contradictionTouchedThisWindow.has(key);
        contradictionTouchedThisWindow.add(key);
        const incrementProposalWindow = !proposalTouchedThisWindow.has(key);
        proposalTouchedThisWindow.add(key);
        addContradictingEvidence(match, { supportCount, confidence }, { now, demote });
        const proposed = mergeRevisionProposal(match, {
          relation,
          text,
          confidence,
          supportCount,
          reason
        }, { now, includeKind: false, incrementWindow: incrementProposalWindow });
        refreshObservationEvidenceSummary(match);
        stats.contradictions++;
        if (proposed) stats.revisionsProposed++;
        stats.applied++;
        continue;
      }

      const incrementSupportWindow = !supportTouchedThisWindow.has(key);
      supportTouchedThisWindow.add(key);
      const incrementProposalWindow = !proposalTouchedThisWindow.has(key);
      proposalTouchedThisWindow.add(key);
      addSupportingEvidence(match, { supportCount, confidence }, { now, incrementWindow: incrementSupportWindow });
      const proposed = mergeRevisionProposal(match, {
        relation: 'refine',
        text,
        confidence,
        supportCount,
        reason
      }, { now, includeKind: false, incrementWindow: incrementProposalWindow });
      refreshObservationEvidenceSummary(match);
      if (proposed) stats.revisionsProposed++;
      else stats.reinforced++;
      stats.applied++;
      continue;
    }

    if (relation !== 'new' || !text || doc.learnedObservations.length >= MAX_LEARNED_LORE) {
      stats.skipped++;
      continue;
    }
    doc.learnedObservations.push({
      text,
      confidence,
      evidenceCount: supportCount,
      supportingWindowCount: 1,
      contradictionCount: 0,
      revisionCount: 0,
      evidenceSummary: `Supported by ${supportCount} source-chat message${supportCount === 1 ? '' : 's'} across 1 learning window.`,
      firstObservedAt: now,
      lastObservedAt: now,
      approvalStatus: 'pending',
      enabled: false
    });
    const created = doc.learnedObservations[doc.learnedObservations.length - 1];
    supportTouchedThisWindow.add(String(created?._id || created?.id || created?.text || text));
    stats.created++;
    stats.applied++;
  }

  if (stats.applied) await doc.save();
  return stats;
}

async function approveLearnedObservation(channelName, observationId) {
  const channel = normalizeChannelName(channelName);
  const doc = await StreamLore.findOne({ channelName: channel });
  if (!doc) throw new Error('Stream lore not found.');
  const observation = doc.learnedObservations.id(observationId);
  if (!observation) throw new Error('Learned lore observation not found.');
  observation.approvalStatus = 'approved';
  observation.enabled = true;
  await doc.save();
  return getStreamLore(channel);
}

async function rejectLearnedObservation(channelName, observationId) {
  const channel = normalizeChannelName(channelName);
  const doc = await StreamLore.findOne({ channelName: channel });
  if (!doc) throw new Error('Stream lore not found.');
  const observation = doc.learnedObservations.id(observationId);
  if (!observation) throw new Error('Learned lore observation not found.');
  if (inferApprovalStatus(observation) !== 'pending') throw new Error('Only pending lore can be rejected.');
  observation.deleteOne();
  await doc.save();
  return getStreamLore(channel);
}

async function acceptLearnedObservationRevision(channelName, observationId) {
  const channel = normalizeChannelName(channelName);
  const doc = await StreamLore.findOne({ channelName: channel });
  if (!doc) throw new Error('Stream lore not found.');
  const observation = doc.learnedObservations.id(observationId);
  if (!observation) throw new Error('Learned lore observation not found.');
  if (inferApprovalStatus(observation) !== 'approved') throw new Error('Only approved lore can accept revisions.');
  const proposalText = normalizeObservationText(observation.revisionProposal?.text);
  if (!proposalText) throw new Error('No AI revision is waiting for review.');
  if (containsPromptInjectionLanguage(proposalText)) throw new Error('The proposed revision failed the safety check.');
  acceptRevision(observation, { now: new Date(), includeKind: false });
  refreshObservationEvidenceSummary(observation);
  await doc.save();
  return getStreamLore(channel);
}

async function dismissLearnedObservationRevision(channelName, observationId) {
  const channel = normalizeChannelName(channelName);
  const doc = await StreamLore.findOne({ channelName: channel });
  if (!doc) throw new Error('Stream lore not found.');
  const observation = doc.learnedObservations.id(observationId);
  if (!observation) throw new Error('Learned lore observation not found.');
  if (inferApprovalStatus(observation) !== 'approved') throw new Error('Only approved lore can dismiss revisions.');
  dismissRevision(observation);
  refreshObservationEvidenceSummary(observation);
  await doc.save();
  return getStreamLore(channel);
}

async function setLearnedObservationEnabled(channelName, observationId, enabled) {
  const channel = normalizeChannelName(channelName);
  const doc = await StreamLore.findOne({ channelName: channel });
  if (!doc) throw new Error('Stream lore not found.');
  const observation = doc.learnedObservations.id(observationId);
  if (!observation) throw new Error('Learned lore observation not found.');
  const status = inferApprovalStatus(observation);
  if (status !== 'approved') throw new Error('Approve this lore observation before toggling its use.');
  observation.approvalStatus = 'approved';
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
  approveLearnedObservation,
  rejectLearnedObservation,
  acceptLearnedObservationRevision,
  dismissLearnedObservationRevision,
  setLearnedObservationEnabled,
  deleteLearnedObservation
};
