const CONFIDENCE_ORDER = Object.freeze({ low: 1, medium: 2, high: 3 });
const CONFIDENCE_BY_RANK = Object.freeze({ 1: 'low', 2: 'medium', 3: 'high' });
const VALID_RELATIONS = new Set(['new', 'support', 'refine', 'contradict']);

function normalizeConfidence(value) {
  return Object.prototype.hasOwnProperty.call(CONFIDENCE_ORDER, value) ? value : 'medium';
}

function normalizeLearningRelation(value) {
  const relation = String(value || '').toLowerCase().trim();
  return VALID_RELATIONS.has(relation) ? relation : 'new';
}

function confidenceRank(value) {
  return CONFIDENCE_ORDER[normalizeConfidence(value)] || 2;
}

function confidenceAtRank(value) {
  return CONFIDENCE_BY_RANK[Math.max(1, Math.min(3, Number(value) || 2))] || 'medium';
}

function demoteConfidence(value, levels = 1) {
  return confidenceAtRank(confidenceRank(value) - Math.max(1, Number(levels) || 1));
}

function normalizeComparisonText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function meaningfulTokens(value) {
  const stop = new Set([
    'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'at', 'for', 'with',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'this', 'that',
    'their', 'they', 'them', 'often', 'frequently', 'usually', 'regularly',
    'sometimes', 'occasionally', 'viewer', 'chat', 'community', 'qwert'
  ]);
  return normalizeComparisonText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !stop.has(token));
}

function textSimilarity(left, right) {
  const a = normalizeComparisonText(left);
  const b = normalizeComparisonText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.92;
  const aTokens = new Set(meaningfulTokens(a));
  const bTokens = new Set(meaningfulTokens(b));
  if (!aTokens.size || !bTokens.size) return 0;
  let overlap = 0;
  for (const token of aTokens) if (bTokens.has(token)) overlap++;
  return (2 * overlap) / (aTokens.size + bTokens.size);
}

function textsEquivalent(left, right) {
  return normalizeComparisonText(left) === normalizeComparisonText(right);
}

function textsRelated(left, right, threshold = 0.55) {
  return textSimilarity(left, right) >= threshold;
}

function mergeSupportingConfidence(current, incoming, {
  kind = 'fact',
  evidenceCount = 1,
  supportingWindowCount = 1
} = {}) {
  let rank = Math.max(confidenceRank(current), confidenceRank(incoming));
  const evidence = Math.max(1, Number(evidenceCount || 1));
  const windows = Math.max(1, Number(supportingWindowCount || 1));
  if (kind === 'habit' || kind === 'behavior') {
    if (evidence >= 2 && windows >= 2) rank = Math.max(rank, 2);
    if (evidence >= 6 && windows >= 3) rank = Math.max(rank, 3);
  } else {
    if (evidence >= 3 && windows >= 2) rank = Math.max(rank, 3);
  }
  return confidenceAtRank(rank);
}

function buildEvidenceSummary(record, { noun = 'source-chat message' } = {}) {
  const evidenceCount = Math.max(1, Number(record?.evidenceCount || 1));
  const windows = Math.max(1, Number(record?.supportingWindowCount || 1));
  const contradictions = Math.max(0, Number(record?.contradictionCount || 0));
  const pluralNoun = evidenceCount === 1 ? noun : `${noun}s`;
  const pluralWindow = windows === 1 ? 'learning window' : 'learning windows';
  const support = `Supported by ${evidenceCount} ${pluralNoun} across ${windows} ${pluralWindow}.`;
  if (!contradictions) return support;
  return `${support} ${contradictions} conflicting source-chat message${contradictions === 1 ? '' : 's'} recorded since the current wording was established.`;
}

function addSupportingEvidence(record, incoming, { now = new Date(), incrementWindow = true } = {}) {
  const supportCount = Math.max(1, Number(incoming?.supportCount || 1));
  record.evidenceCount = Math.max(1, Number(record.evidenceCount || 1)) + supportCount;
  record.supportingWindowCount = Math.max(1, Number(record.supportingWindowCount || 1)) + (incrementWindow ? 1 : 0);
  record.lastObservedAt = now;
  record.confidence = mergeSupportingConfidence(record.confidence, incoming?.confidence, {
    kind: incoming?.kind || record.kind || 'fact',
    evidenceCount: record.evidenceCount,
    supportingWindowCount: record.supportingWindowCount
  });
}

function addContradictingEvidence(record, incoming, { now = new Date(), demote = true } = {}) {
  const supportCount = Math.max(1, Number(incoming?.supportCount || 1));
  record.contradictionCount = Math.max(0, Number(record.contradictionCount || 0)) + supportCount;
  record.lastContradictedAt = now;
  record.lastObservedAt = now;
  if (demote) record.confidence = demoteConfidence(record.confidence, 1);
}

function mergeRevisionProposal(record, incoming, {
  now = new Date(),
  includeKind = false,
  incrementWindow = true
} = {}) {
  const relation = normalizeLearningRelation(incoming?.relation);
  if (relation !== 'refine' && relation !== 'contradict') return false;
  const text = String(incoming?.text || '').replace(/\s+/g, ' ').trim();
  if (!text || textsEquivalent(record?.text, text)) return false;
  const supportCount = Math.max(1, Number(incoming?.supportCount || 1));
  const current = record?.revisionProposal && record.revisionProposal.text ? record.revisionProposal : null;
  const sameProposal = current
    && current.relation === relation
    && textsRelated(current.text, text, 0.38);

  const next = sameProposal ? current : {
    text,
    relation,
    confidence: normalizeConfidence(incoming?.confidence),
    evidenceCount: 0,
    // A newly created proposal is necessarily supported by the current learning window.
    supportingWindowCount: 1,
    evidenceSummary: '',
    reason: '',
    firstProposedAt: now,
    lastProposedAt: now
  };

  if (includeKind) next.kind = incoming?.kind || record?.kind || 'fact';
  // Approved wording remains frozen, but the unapproved proposal itself may evolve as
  // later evidence sharpens the same suggested direction.
  next.text = text;

  next.relation = relation;
  next.evidenceCount = Math.max(0, Number(next.evidenceCount || 0)) + supportCount;
  next.supportingWindowCount = sameProposal
    ? Math.max(1, Number(next.supportingWindowCount || 1)) + (incrementWindow ? 1 : 0)
    : 1;
  next.confidence = mergeSupportingConfidence(next.confidence, incoming?.confidence, {
    kind: includeKind ? next.kind : 'fact',
    evidenceCount: next.evidenceCount,
    supportingWindowCount: Math.max(1, next.supportingWindowCount)
  });
  next.reason = String(incoming?.reason || next.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  next.lastProposedAt = now;
  next.evidenceSummary = `Supported by ${next.evidenceCount} new source-chat message${next.evidenceCount === 1 ? '' : 's'} across ${Math.max(1, next.supportingWindowCount)} learning window${Math.max(1, next.supportingWindowCount) === 1 ? '' : 's'}.`;
  record.revisionProposal = next;
  return true;
}

function applyPendingRevision(record, incoming, {
  now = new Date(),
  includeKind = false,
  incrementWindow = true
} = {}) {
  const relation = normalizeLearningRelation(incoming?.relation);
  const text = String(incoming?.text || '').replace(/\s+/g, ' ').trim();
  if (!text || textsEquivalent(record?.text, text)) {
    addSupportingEvidence(record, incoming, { now, incrementWindow });
    return 'reinforced';
  }

  if (relation === 'contradict') {
    record.text = text;
    if (includeKind) record.kind = incoming?.kind || record.kind || 'fact';
    record.confidence = normalizeConfidence(incoming?.confidence);
    record.evidenceCount = Math.max(1, Number(incoming?.supportCount || 1));
    record.supportingWindowCount = 1;
    record.contradictionCount = 0;
    record.lastContradictedAt = now;
  } else {
    addSupportingEvidence(record, incoming, { now, incrementWindow });
    record.text = text;
    if (includeKind) record.kind = incoming?.kind || record.kind || 'fact';
    record.confidence = mergeSupportingConfidence(record.confidence, incoming?.confidence, {
      kind: includeKind ? record.kind : 'fact',
      evidenceCount: record.evidenceCount,
      supportingWindowCount: record.supportingWindowCount
    });
  }

  record.revisionCount = Math.max(0, Number(record.revisionCount || 0)) + 1;
  record.lastRefinedAt = now;
  record.lastObservedAt = now;
  record.revisionProposal = null;
  return relation === 'contradict' ? 'corrected' : 'refined';
}

function acceptRevision(record, { now = new Date(), includeKind = false } = {}) {
  const proposal = record?.revisionProposal;
  if (!proposal?.text) throw new Error('No AI revision is waiting for review.');
  const relation = normalizeLearningRelation(proposal.relation);
  record.text = String(proposal.text).replace(/\s+/g, ' ').trim();
  if (includeKind && proposal.kind) record.kind = proposal.kind;

  if (relation === 'contradict') {
    record.evidenceCount = Math.max(1, Number(proposal.evidenceCount || 1));
    record.supportingWindowCount = Math.max(1, Number(proposal.supportingWindowCount || 1));
    record.confidence = normalizeConfidence(proposal.confidence);
  } else {
    record.confidence = mergeSupportingConfidence(record.confidence, proposal.confidence, {
      kind: includeKind ? record.kind : 'fact',
      evidenceCount: record.evidenceCount,
      supportingWindowCount: record.supportingWindowCount
    });
  }

  record.contradictionCount = 0;
  record.revisionCount = Math.max(0, Number(record.revisionCount || 0)) + 1;
  record.lastRefinedAt = now;
  record.lastObservedAt = now;
  record.revisionProposal = null;
  return relation;
}

function dismissRevision(record) {
  if (!record?.revisionProposal?.text) throw new Error('No AI revision is waiting for review.');
  record.revisionProposal = null;
}

function serializeRevisionProposal(value, { includeKind = false } = {}) {
  if (!value?.text) return null;
  const out = {
    text: String(value.text || ''),
    relation: value.relation === 'contradict' ? 'contradict' : 'refine',
    confidence: normalizeConfidence(value.confidence),
    evidenceCount: Math.max(1, Number(value.evidenceCount || 1)),
    supportingWindowCount: Math.max(1, Number(value.supportingWindowCount || 1)),
    evidenceSummary: String(value.evidenceSummary || ''),
    reason: String(value.reason || ''),
    firstProposedAt: value.firstProposedAt || null,
    lastProposedAt: value.lastProposedAt || null
  };
  if (includeKind) out.kind = ['fact', 'preference', 'habit', 'behavior'].includes(value.kind) ? value.kind : 'fact';
  return out;
}

module.exports = {
  normalizeConfidence,
  normalizeLearningRelation,
  demoteConfidence,
  normalizeComparisonText,
  meaningfulTokens,
  textSimilarity,
  textsEquivalent,
  textsRelated,
  mergeSupportingConfidence,
  buildEvidenceSummary,
  addSupportingEvidence,
  addContradictingEvidence,
  mergeRevisionProposal,
  applyPendingRevision,
  acceptRevision,
  dismissRevision,
  serializeRevisionProposal
};
