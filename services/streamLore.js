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

const MAX_STREAM_LORE_LENGTH = 12000; // Legacy blob limit; retained only for backwards compatibility.
const MAX_MANUAL_LORE_ENTRIES = 100;
const MAX_MANUAL_LORE_TEXT_LENGTH = 2400;
const MAX_MANUAL_LORE_SUBJECT_LENGTH = 80;
const MAX_MANUAL_LORE_ALIASES = 12;
const MAX_MANUAL_LORE_ALIAS_LENGTH = 80;
const MAX_LEARNED_LORE = 80;
const MAX_LEARNED_LORE_LENGTH = 400;
const MAX_LORE_DIRECTIVE_RESPONSE_LENGTH = 500;
const DEFAULT_LORE_DIRECTIVE_CONFIG = Object.freeze({
  enabled: true,
  sendResponses: true,
  successResponse: '@$(user), got it — I queued that in Pending Stream Lore for review.',
  alreadyKnownResponse: '@$(user), that already matches existing Stream Lore.',
  failureResponse: '@$(user), I couldn\'t turn that into a lore proposal. Give me a little more context.'
});

function normalizeChannelName(channelName) {
  return String(channelName || '').replace(/^#/, '').toLowerCase().trim();
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

function isObservationOwnershipVerified(observation) {
  if (observation?.ownershipVerified === true) return true;
  if (observation?.ownershipVerified === false) return false;

  // Records created before ownershipVerified existed can still be considered
  // safe when they already have an explicit subject owner or came from a
  // trusted moderator/broadcaster directive. Legacy unscoped AI observations
  // remain visible in the dashboard but are quarantined from AI context.
  return normalizeManualLoreScope(observation?.scope) === 'subject'
    || observation?.origin === 'moderator_directive';
}

function serializeObservation(observation) {
  const approvalStatus = inferApprovalStatus(observation);
  const ownershipVerified = isObservationOwnershipVerified(observation);
  return {
    id: String(observation?._id || ''),
    origin: observation?.origin === 'moderator_directive' ? 'moderator_directive' : 'hourly_ai',
    text: String(observation?.text || ''),
    scope: normalizeManualLoreScope(observation?.scope),
    subject: normalizeManualLoreSubject(observation?.subject),
    aliases: normalizeManualLoreAliases(observation?.aliases),
    ownershipVerified,
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
    revisionProposal: observation?.revisionProposal?.text ? {
      ...serializeRevisionProposal(observation.revisionProposal),
      scope: normalizeManualLoreScope(observation.revisionProposal.scope ?? observation.scope),
      subject: normalizeManualLoreSubject(observation.revisionProposal.subject ?? observation.subject),
      aliases: normalizeManualLoreAliases(observation.revisionProposal.aliases ?? observation.aliases),
      ownershipVerified: observation.revisionProposal.ownershipVerified === true
    } : null,
    approvalStatus,
    enabled: approvalStatus === 'approved' && observation?.enabled === true && ownershipVerified
  };
}


function normalizeLoreDirectiveResponse(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return String(value).replace(/\r\n/g, '\n').trim().slice(0, MAX_LORE_DIRECTIVE_RESPONSE_LENGTH);
}

function normalizeLoreDirectiveConfig(value = {}) {
  return {
    enabled: value?.enabled !== false,
    sendResponses: value?.sendResponses !== false,
    successResponse: normalizeLoreDirectiveResponse(value?.successResponse, DEFAULT_LORE_DIRECTIVE_CONFIG.successResponse),
    alreadyKnownResponse: normalizeLoreDirectiveResponse(value?.alreadyKnownResponse, DEFAULT_LORE_DIRECTIVE_CONFIG.alreadyKnownResponse),
    failureResponse: normalizeLoreDirectiveResponse(value?.failureResponse, DEFAULT_LORE_DIRECTIVE_CONFIG.failureResponse)
  };
}

function normalizeManualLoreScope(value) {
  return String(value || '').toLowerCase().trim() === 'subject' ? 'subject' : 'global';
}

function normalizeManualLoreSubject(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_MANUAL_LORE_SUBJECT_LENGTH);
}

function normalizeManualLoreText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_MANUAL_LORE_TEXT_LENGTH);
}

function normalizeManualLoreAliases(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const seen = new Set();
  const aliases = [];
  for (const item of raw) {
    const alias = String(item || '').replace(/^@+/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_MANUAL_LORE_ALIAS_LENGTH);
    if (!alias) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
    if (aliases.length >= MAX_MANUAL_LORE_ALIASES) break;
  }
  return aliases;
}

function serializeManualLoreEntry(entry) {
  return {
    id: String(entry?._id || entry?.id || ''),
    scope: normalizeManualLoreScope(entry?.scope),
    subject: normalizeManualLoreSubject(entry?.subject),
    aliases: normalizeManualLoreAliases(entry?.aliases),
    text: String(entry?.text || ''),
    enabled: entry?.enabled !== false,
    createdAt: entry?.createdAt || null,
    updatedAt: entry?.updatedAt || null
  };
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function manualLoreCandidateMatchesText(candidate, sourceText) {
  const value = String(candidate || '').replace(/^@+/, '').trim().toLowerCase();
  const source = String(sourceText || '').toLowerCase();
  if (!value || !source) return false;
  const escaped = escapeRegExp(value);
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(source);
}

function manualLoreEntryMatchesText(entry, sourceText) {
  if (normalizeManualLoreScope(entry?.scope) !== 'subject') return false;
  const candidates = [entry?.subject, ...(Array.isArray(entry?.aliases) ? entry.aliases : [])];
  return candidates.some((candidate) => manualLoreCandidateMatchesText(candidate, sourceText));
}

function formatManualLoreEntries(entries = []) {
  const active = (Array.isArray(entries) ? entries : [])
    .map(serializeManualLoreEntry)
    .filter((entry) => entry.enabled && entry.text.trim());
  if (!active.length) return '';

  const globalEntries = active.filter((entry) => entry.scope === 'global');
  const subjectEntries = active.filter((entry) => entry.scope === 'subject');
  const blocks = [];

  if (globalEntries.length) {
    blocks.push([
      'GLOBAL MANUAL LORE:',
      ...globalEntries.map((entry) => `- ${entry.subject ? `[${entry.subject}] ` : ''}${entry.text.trim()}`)
    ].join('\n'));
  }

  for (const entry of subjectEntries) {
    const aliases = entry.aliases.length ? ` (aliases: ${entry.aliases.join(', ')})` : '';
    blocks.push(`MANUAL LORE ABOUT ${entry.subject || 'UNLABELED SUBJECT'}${aliases}:\n- ${entry.text.trim()}`);
  }

  return blocks.join('\n\n');
}

function buildManualLoreContext(manualEntries = [], sourceText = '', options = {}) {
  const includeGlobal = options.includeGlobal !== false;
  const includeAllSubjects = options.includeAllSubjects === true;
  const active = (Array.isArray(manualEntries) ? manualEntries : [])
    .map(serializeManualLoreEntry)
    .filter((entry) => entry.enabled && entry.text.trim());

  const selected = active.filter((entry) => {
    if (entry.scope === 'global') return includeGlobal;
    if (includeAllSubjects) return true;
    return manualLoreEntryMatchesText(entry, sourceText);
  });

  return formatManualLoreEntries(selected);
}

function buildLearnedLoreText(learnedObservations = [], sourceText = '', options = {}) {
  const includeGlobal = options.includeGlobal !== false;
  const includeAllSubjects = options.includeAllSubjects === true;
  const approved = (Array.isArray(learnedObservations) ? learnedObservations : [])
    .map(serializeObservation)
    .filter((observation) => observation.approvalStatus === 'approved'
      && observation.enabled === true
      && observation.ownershipVerified === true
      && observation.text.trim())
    .filter((observation) => {
      if (observation.scope === 'global') return includeGlobal;
      if (includeAllSubjects) return true;
      return manualLoreEntryMatchesText(observation, sourceText);
    });
  if (!approved.length) return '';

  const blocks = [];
  const globalEntries = approved.filter((entry) => entry.scope === 'global');
  if (globalEntries.length) {
    blocks.push(`AI-LEARNED STREAM LORE (GLOBAL):\n${globalEntries.map((entry) => `- ${entry.text.trim()}`).join('\n')}`);
  }
  for (const entry of approved.filter((item) => item.scope === 'subject')) {
    const aliases = entry.aliases.length ? ` (aliases: ${entry.aliases.join(', ')})` : '';
    blocks.push(`AI-LEARNED LORE ABOUT ${entry.subject || 'UNLABELED SUBJECT'}${aliases}:\n- ${entry.text.trim()}`);
  }
  return blocks.join('\n\n');
}

function buildEffectiveLore(manualEntries = [], learnedObservations = [], sourceText = '', options = {}) {
  const manual = buildManualLoreContext(manualEntries, sourceText, options);
  const learned = buildLearnedLoreText(learnedObservations, sourceText, options);
  return [manual, learned].filter(Boolean).join('\n\n');
}

async function getStreamLore(channelName) {
  const normalizedChannelName = normalizeChannelName(channelName);
  if (!normalizedChannelName) return { text: '', manualEntries: [], learnedObservations: [], directiveConfig: normalizeLoreDirectiveConfig(), manualText: '', learnedText: '', effectiveText: '', updatedAt: null };

  const doc = await StreamLore.findOne({ channelName: normalizedChannelName }).lean();
  const manualEntries = (Array.isArray(doc?.manualEntries) ? doc.manualEntries : []).map(serializeManualLoreEntry);
  const learnedObservations = (Array.isArray(doc?.learnedObservations) ? doc.learnedObservations : []).map(serializeObservation);
  const text = String(doc?.text || ''); // Legacy blob; intentionally excluded from active AI context.

  return {
    text,
    manualEntries,
    learnedObservations,
    directiveConfig: normalizeLoreDirectiveConfig(doc?.loreDirectives || {}),
    manualText: buildManualLoreContext(manualEntries, '', { includeAllSubjects: true }),
    learnedText: buildLearnedLoreText(learnedObservations, '', { includeAllSubjects: true }),
    effectiveText: buildEffectiveLore(manualEntries, learnedObservations, '', { includeAllSubjects: true }),
    updatedAt: doc?.updatedAt || null
  };
}

// Legacy blob save endpoint retained so older deployments/UI requests fail gracefully.
// The legacy text is no longer included in Tagged Question or recap AI context.
async function saveLoreDirectiveConfig(channelName, input = {}) {
  const channel = normalizeChannelName(channelName);
  if (!channel) throw new Error('TWITCH_CHANNEL is not configured.');
  const config = normalizeLoreDirectiveConfig(input);
  await StreamLore.findOneAndUpdate(
    { channelName: channel },
    { $set: { loreDirectives: config } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return config;
}

async function saveStreamLore(channelName, text) {
  const normalizedChannelName = normalizeChannelName(channelName);
  if (!normalizedChannelName) throw new Error('TWITCH_CHANNEL is not configured.');

  const normalizedText = String(text || '').trim();
  if (normalizedText.length > MAX_STREAM_LORE_LENGTH) {
    throw new Error(`Stream-specific lore cannot exceed ${MAX_STREAM_LORE_LENGTH} characters.`);
  }

  await StreamLore.findOneAndUpdate(
    { channelName: normalizedChannelName },
    { $set: { text: normalizedText } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return getStreamLore(normalizedChannelName);
}

async function saveManualLoreEntry(channelName, input = {}) {
  const channel = normalizeChannelName(channelName);
  if (!channel) throw new Error('TWITCH_CHANNEL is not configured.');

  const scope = normalizeManualLoreScope(input.scope);
  const subject = normalizeManualLoreSubject(input.subject);
  const aliases = normalizeManualLoreAliases(input.aliases);
  const text = normalizeManualLoreText(input.text);
  const enabled = input.enabled !== false;
  if (!text) throw new Error('Lore text is required.');
  if (scope === 'subject' && !subject) throw new Error('Subject-specific lore requires a subject.');

  let doc = await StreamLore.findOne({ channelName: channel });
  if (!doc) doc = new StreamLore({ channelName: channel });
  if (!Array.isArray(doc.manualEntries)) doc.manualEntries = [];

  const entryId = String(input.id || input.entryId || '').trim();
  let entry = null;
  if (entryId && doc.manualEntries.id) {
    try { entry = doc.manualEntries.id(entryId); } catch (_) { entry = null; }
    if (!entry) throw new Error('Manual lore entry not found.');
  }

  if (!entry) {
    if (doc.manualEntries.length >= MAX_MANUAL_LORE_ENTRIES) {
      throw new Error(`Manual lore is limited to ${MAX_MANUAL_LORE_ENTRIES} entries.`);
    }
    doc.manualEntries.push({ scope, subject, aliases, text, enabled, createdAt: new Date(), updatedAt: new Date() });
  } else {
    entry.scope = scope;
    entry.subject = subject;
    entry.aliases = aliases;
    entry.text = text;
    entry.enabled = enabled;
    entry.updatedAt = new Date();
  }

  await doc.save();
  return getStreamLore(channel);
}

async function setManualLoreEntryEnabled(channelName, entryId, enabled) {
  const channel = normalizeChannelName(channelName);
  const doc = await StreamLore.findOne({ channelName: channel });
  if (!doc) throw new Error('Stream lore not found.');
  const entry = doc.manualEntries.id(entryId);
  if (!entry) throw new Error('Manual lore entry not found.');
  entry.enabled = Boolean(enabled);
  entry.updatedAt = new Date();
  await doc.save();
  return getStreamLore(channel);
}

async function deleteManualLoreEntry(channelName, entryId) {
  const channel = normalizeChannelName(channelName);
  const doc = await StreamLore.findOne({ channelName: channel });
  if (!doc) throw new Error('Stream lore not found.');
  const entry = doc.manualEntries.id(entryId);
  if (!entry) throw new Error('Manual lore entry not found.');
  entry.deleteOne();
  await doc.save();
  return getStreamLore(channel);
}

function sameLoreScope(left = {}, right = {}) {
  const leftScope = normalizeManualLoreScope(left?.scope);
  const rightScope = normalizeManualLoreScope(right?.scope);
  if (leftScope !== rightScope) return false;
  if (leftScope === 'global') return true;
  const leftSubject = normalizeManualLoreSubject(left?.subject).toLowerCase();
  const rightSubject = normalizeManualLoreSubject(right?.subject).toLowerCase();
  if (leftSubject && rightSubject && leftSubject === rightSubject) return true;
  const leftAliases = normalizeManualLoreAliases([left?.subject, ...(left?.aliases || [])]).map((item) => item.toLowerCase());
  const rightAliases = new Set(normalizeManualLoreAliases([right?.subject, ...(right?.aliases || [])]).map((item) => item.toLowerCase()));
  return leftAliases.some((alias) => rightAliases.has(alias));
}

function findSimilarObservation(observations, text, scopeInput = {}) {
  const scoped = { scope: normalizeManualLoreScope(scopeInput?.scope), subject: scopeInput?.subject, aliases: scopeInput?.aliases };
  return (Array.isArray(observations) ? observations : [])
    .find((observation) => sameLoreScope(observation, scoped) && textsRelated(observation?.text, text, 0.58)) || null;
}

function resolveLoreObservationMatch(doc, raw, text) {
  const targetId = String(raw?.existingObservationId || raw?.targetId || '').trim();
  let match = null;
  if (targetId && doc?.learnedObservations?.id) {
    try { match = doc.learnedObservations.id(targetId); } catch (_) { match = null; }
  }
  if (!match && text) match = findSimilarObservation(doc?.learnedObservations, text, raw);
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
    const origin = raw?.origin === 'moderator_directive' ? 'moderator_directive' : 'hourly_ai';
    const ownershipVerified = raw?.ownershipVerified === true || origin === 'moderator_directive';
    let scope = normalizeManualLoreScope(raw?.scope);
    let subject = normalizeManualLoreSubject(raw?.subject);
    let aliases = normalizeManualLoreAliases(raw?.aliases);
    if (text && containsPromptInjectionLanguage(text)) { stats.skipped++; continue; }
    if (scope === 'subject' && !subject) { stats.skipped++; continue; }

    const match = resolveLoreObservationMatch(doc, raw, text);
    const now = new Date();
    if (match) {
      // Older learning responses and ID-targeted support/refinement updates may
      // omit the new scope fields. Inherit the existing owner/scope instead of
      // silently converting subject-specific lore into global channel lore.
      if (raw?.scope == null || String(raw.scope).trim() === '') {
        scope = normalizeManualLoreScope(match.scope);
      }
      if (scope === 'subject') {
        if (!subject) subject = normalizeManualLoreSubject(match.subject);
        if (!aliases.length) aliases = normalizeManualLoreAliases(match.aliases);
      } else {
        subject = '';
        aliases = [];
      }
      if (!['approved', 'pending'].includes(match.approvalStatus)) match.approvalStatus = match.enabled === true ? 'approved' : 'pending';
      const status = inferApprovalStatus(match);
      if (origin === 'moderator_directive' && status === 'pending') match.origin = 'moderator_directive';
      const key = String(match._id || match.id || match.text);

      if (relation === 'new') relation = text && !textsEquivalent(match.text, text) ? 'refine' : 'support';
      if (relation === 'support' || !text || textsEquivalent(match.text, text)) {
        const incrementWindow = !supportTouchedThisWindow.has(key);
        supportTouchedThisWindow.add(key);
        addSupportingEvidence(match, { supportCount, confidence }, { now, incrementWindow });
        if (ownershipVerified) match.ownershipVerified = true;
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
        if (result !== 'reinforced') {
          match.scope = scope;
          match.subject = scope === 'subject' ? subject : '';
          match.aliases = scope === 'subject' ? aliases : [];
        }
        if (ownershipVerified) match.ownershipVerified = true;
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
        if (proposed && match.revisionProposal) {
          match.revisionProposal.scope = scope;
          match.revisionProposal.subject = scope === 'subject' ? subject : '';
          match.revisionProposal.aliases = scope === 'subject' ? aliases : [];
          match.revisionProposal.ownershipVerified = ownershipVerified;
        }
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
      if (proposed && match.revisionProposal) {
        match.revisionProposal.scope = scope;
        match.revisionProposal.subject = scope === 'subject' ? subject : '';
        match.revisionProposal.aliases = scope === 'subject' ? aliases : [];
        match.revisionProposal.ownershipVerified = ownershipVerified;
      }
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
      origin,
      text,
      scope,
      subject: scope === 'subject' ? subject : '',
      aliases: scope === 'subject' ? aliases : [],
      ownershipVerified,
      confidence,
      evidenceCount: supportCount,
      supportingWindowCount: 1,
      contradictionCount: 0,
      revisionCount: 0,
      evidenceSummary: origin === 'moderator_directive'
        ? 'Proposed from an explicit moderator/broadcaster lore directive; awaiting review.'
        : `Supported by ${supportCount} source-chat message${supportCount === 1 ? '' : 's'} across 1 learning window.`,
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
  // Explicit moderator approval is an ownership review for legacy pending
  // records as well as a content approval.
  observation.ownershipVerified = true;
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
  const proposalScope = normalizeManualLoreScope(observation.revisionProposal?.scope ?? observation.scope);
  const proposalSubject = normalizeManualLoreSubject(observation.revisionProposal?.subject ?? observation.subject);
  const proposalAliases = normalizeManualLoreAliases(observation.revisionProposal?.aliases ?? observation.aliases);
  const proposalOwnershipVerified = observation.revisionProposal?.ownershipVerified === true;
  if (proposalScope === 'subject' && !proposalSubject) throw new Error('The proposed revision is missing its lore subject.');
  acceptRevision(observation, { now: new Date(), includeKind: false });
  observation.scope = proposalScope;
  observation.subject = proposalScope === 'subject' ? proposalSubject : '';
  observation.aliases = proposalScope === 'subject' ? proposalAliases : [];
  observation.ownershipVerified = proposalOwnershipVerified || isObservationOwnershipVerified(observation);
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
  if (enabled) observation.ownershipVerified = true;
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
  MAX_MANUAL_LORE_ENTRIES,
  MAX_MANUAL_LORE_TEXT_LENGTH,
  MAX_MANUAL_LORE_SUBJECT_LENGTH,
  MAX_MANUAL_LORE_ALIASES,
  MAX_MANUAL_LORE_ALIAS_LENGTH,
  MAX_LEARNED_LORE,
  MAX_LORE_DIRECTIVE_RESPONSE_LENGTH,
  DEFAULT_LORE_DIRECTIVE_CONFIG,
  getStreamLore,
  normalizeLoreDirectiveConfig,
  saveLoreDirectiveConfig,
  saveStreamLore,
  saveManualLoreEntry,
  setManualLoreEntryEnabled,
  deleteManualLoreEntry,
  buildManualLoreContext,
  buildLearnedLoreText,
  normalizeManualLoreScope,
  normalizeManualLoreSubject,
  normalizeManualLoreAliases,
  manualLoreEntryMatchesText,
  sameLoreScope,
  buildEffectiveLore,
  applyStreamLoreObservations,
  approveLearnedObservation,
  rejectLearnedObservation,
  acceptLearnedObservationRevision,
  dismissLearnedObservationRevision,
  setLearnedObservationEnabled,
  deleteLearnedObservation
};
