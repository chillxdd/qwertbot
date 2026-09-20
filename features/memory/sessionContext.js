'use strict';

const {
  normalizeChatRecords,
  renderChatRecord,
  normalizeIdentity,
  identityKey
} = require('../../services/sourceRecords');
const { normalizeSessionMemoryConfig } = require('./sessionConfig');
const { tokenize, identityRetrievalTerms, scoreBlockForQuestion } = require('./sessionRetrieval');

function formatSharedChatGuestMemoryProvenance(block = {}) {
  const guests = Array.isArray(block?.sharedChatGuests) ? block.sharedChatGuests : [];
  if (!guests.length) return '';
  const lines = guests.slice(0, 100).map((guest) => {
    const viewer = String(guest?.displayName || guest?.login || 'Guest viewer').trim();
    const login = String(guest?.login || '').trim();
    const source = String(
      guest?.sourceBroadcasterDisplayName || guest?.sourceBroadcasterLogin ||
      (guest?.sourceBroadcasterUserId ? `source room ${guest.sourceBroadcasterUserId}` : 'another participating channel')
    ).trim();
    return `- ${viewer}${login && login.toLowerCase() !== viewer.toLowerCase() ? ` (@${login})` : ''} originated from ${source} through Twitch Shared Chat.`;
  });
  return [
    'SHARED CHAT GUEST PROVENANCE (temporary current-stream context only; this does not establish GeneralQwert community membership):',
    ...lines
  ].join('\n');
}

function formatBlockTime(block) {
  const start = Number(block?.startedAtMs || 0);
  const end = Number(block?.endedAtMs || 0);
  if (!start && !end) return 'time unavailable';
  const fmt = (value) => value ? new Date(value).toISOString() : '?';
  return `${fmt(start)} to ${fmt(end)}`;
}

function formatMemoryClaims(block = {}) {
  const claims = Array.isArray(block?.claims) ? block.claims.filter((claim) => String(claim?.text || '').trim()) : [];
  if (!claims.length) return '';
  return [
    'AUDITED ATOMIC CLAIMS:',
    ...claims.slice(0, 24).map((claim) => `- ${String(claim.text).trim()}${claim.sourceIds?.length ? ` [sources: ${claim.sourceIds.join(', ')}]` : ''}`)
  ].join('\n');
}

function formatDetailedMemoryBlock(block = {}) {
  const audited = block?.attributionAudited === true;
  const header = `${audited ? 'AUDITED DETAILED MEMORY' : 'LEGACY UNAUDITED MEMORY'} [${formatBlockTime(block)}]:`;
  const warning = audited
    ? ''
    : 'CAUTION: This block predates attribution auditing. Use it only for broad topic orientation; do not rely on its named-person, possession, relationship, or pronoun claims without current structured evidence.';
  const claims = audited ? formatMemoryClaims(block) : '';
  const sharedChatProvenance = formatSharedChatGuestMemoryProvenance(block);
  return [header, warning, sharedChatProvenance, String(block?.detailedSummary || '').trim(), claims].filter(Boolean).join('\n');
}

function buildSessionMemoryContext({
  blocks = [],
  question = '',
  requesterIdentity = null,
  recipientIdentity = null,
  recentChatLogs = [],
  config = {},
  streamLive = false
}) {
  const normalizedConfig = normalizeSessionMemoryConfig(config);
  if (!normalizedConfig.enabled || !streamLive) {
    return { text: '', stats: { enabled: normalizedConfig.enabled, blockCount: Array.isArray(blocks) ? blocks.length : 0, includedDetailedBlocks: 0, compactCharacters: 0, contextCharacters: 0 } };
  }

  const validBlocks = (Array.isArray(blocks) ? blocks : []).filter((block) => block?.detailedSummary || block?.compactSummary);
  const now = Date.now();
  const recentCutoff = now - normalizedConfig.recentDetailedHours * 60 * 60 * 1000;
  const recent = validBlocks.filter((block) => Number(block?.endedAtMs || 0) >= recentCutoff);
  const older = validBlocks.filter((block) => Number(block?.endedAtMs || 0) < recentCutoff);
  const requester = normalizeIdentity(requesterIdentity || {});
  const recipient = normalizeIdentity(recipientIdentity || {});
  const identityTerms = [...new Set([...identityRetrievalTerms(requester), ...identityRetrievalTerms(recipient)])];
  const questionTokens = tokenize([question, ...identityTerms].join(' '));
  const relevantOlder = older
    .map((block, index) => ({ block, index, score: scoreBlockForQuestion(block, questionTokens, identityTerms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, normalizedConfig.relevantOlderBlocks)
    .map((item) => item.block);

  const compactLines = validBlocks.map((block, index) => {
    const labels = [...(block?.topics || []), ...(block?.people || [])].slice(0, 8).join(', ');
    const auditLabel = block?.attributionAudited === true ? 'audited' : 'legacy-unaudited';
    const sharedGuests = (Array.isArray(block?.sharedChatGuests) ? block.sharedChatGuests : [])
      .map((guest) => guest?.displayName || guest?.login)
      .filter(Boolean)
      .slice(0, 12);
    const sharedLabel = sharedGuests.length ? ` | Shared Chat guests (not GeneralQwert membership): ${sharedGuests.join(', ')}` : '';
    return `- Block ${index + 1} [${formatBlockTime(block)}; ${auditLabel}]: ${String(block?.compactSummary || block?.detailedSummary || '').trim()}${labels ? ` | Index: ${labels}` : ''}${sharedLabel}`;
  });

  const selectedDetailed = [];
  const seen = new Set();
  for (const block of [...recent, ...relevantOlder]) {
    const key = `${block?.sequence || ''}:${block?.endedAtMs || ''}:${block?.detailedSummary || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selectedDetailed.push(block);
  }

  const detailSections = selectedDetailed.map(formatDetailedMemoryBlock);
  const chatSlice = normalizedConfig.recentChatMessages > 0
    ? normalizeChatRecords(recentChatLogs).slice(-normalizedConfig.recentChatMessages)
    : [];
  const renderedRecentChat = chatSlice.map((record) => renderChatRecord(record, { includeBotMarker: true, includeSourceId: true }));
  const roleLines = [
    identityKey(requester) ? `Requester identity for retrieval: ${requester.displayName || requester.login}${requester.login ? ` (@${requester.login})` : ''}${requester.userId ? ` [userId=${requester.userId}]` : ''}` : '',
    identityKey(recipient) && identityKey(recipient) !== identityKey(requester) ? `Response recipient identity for retrieval: ${recipient.displayName || recipient.login}${recipient.login ? ` (@${recipient.login})` : ''}${recipient.userId ? ` [userId=${recipient.userId}]` : ''}` : ''
  ].filter(Boolean);

  let text = 'CURRENT-STREAM SESSION MEMORY (temporary; clears when this Twitch stream ends):';
  if (roleLines.length) text += `\n${roleLines.join('\n')}`;
  text += '\n[BOT CONTEXT ONLY] lines may explain what chat was responding to, but they are not independent viewer testimony and must not be attributed to a viewer.';
  text += '\n[SHARED CHAT GUEST] lines are valid temporary context for this joint stream, but do not establish GeneralQwert community membership, Qwert-channel roles, or ownership of GeneralQwert lore.';
  if (detailSections.length) text += `\n\nSELECTED DETAILED MEMORY:\n${detailSections.join('\n\n')}`;
  if (renderedRecentChat.length) text += `\n\nRECENT STRUCTURED CHAT SINCE THE LAST COMPLETED MEMORY BLOCK:\n${renderedRecentChat.join('\n')}`;
  text += `\n\nCOMPACT HISTORY INDEX (whole-stream orientation; lower priority than audited detail and current structured chat):\n${compactLines.join('\n') || '(no completed memory blocks yet)'}`;

  if (text.length > normalizedConfig.maxContextCharacters) {
    text = text.slice(0, normalizedConfig.maxContextCharacters).trimEnd();
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak > Math.floor(normalizedConfig.maxContextCharacters * 0.8)) text = text.slice(0, lastBreak).trimEnd();
    text += '\n[Session memory context truncated to configured limit.]';
  }

  return {
    text,
    stats: {
      enabled: true,
      blockCount: validBlocks.length,
      auditedBlockCount: validBlocks.filter((block) => block?.attributionAudited === true).length,
      includedDetailedBlocks: selectedDetailed.length,
      compactCharacters: compactLines.join('\n').length,
      contextCharacters: text.length
    }
  };
}

module.exports = { buildSessionMemoryContext, formatSharedChatGuestMemoryProvenance };
