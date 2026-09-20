'use strict';

const { normalizeIdentity } = require('../../services/sourceRecords');

const STOP_WORDS = new Set(['the','and','for','that','this','with','what','when','where','which','who','why','how','did','does','was','were','are','is','it','to','of','in','on','at','a','an','qwert','sqwertarmybot','bot','earlier','today','tonight','stream']);

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[\p{L}\p{N}_'-]{2,}/gu)?.filter((word) => !STOP_WORDS.has(word)) || [];
}

function identityRetrievalTerms(identity = {}) {
  const normalized = normalizeIdentity(identity || {});
  return [...new Set([
    normalized.userId,
    normalized.login,
    normalized.displayName,
    ...(normalized.aliases || [])
  ].map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))];
}

function blockSearchText(block = {}) {
  const claims = (Array.isArray(block?.claims) ? block.claims : [])
    .map((claim) => `${claim?.text || ''} ${(claim?.people || []).join(' ')}`)
    .join(' ');
  const sharedGuests = (Array.isArray(block?.sharedChatGuests) ? block.sharedChatGuests : [])
    .map((guest) => `${guest?.userId || ''} ${guest?.login || ''} ${guest?.displayName || ''} ${guest?.sourceBroadcasterLogin || ''} ${guest?.sourceBroadcasterDisplayName || ''}`)
    .join(' ');
  return `${block?.topics?.join(' ') || ''} ${block?.people?.join(' ') || ''} ${block?.compactSummary || ''} ${block?.detailedSummary || ''} ${claims} ${sharedGuests}`.toLowerCase();
}

function scoreBlockForQuestion(block, questionTokens, identityTerms = []) {
  const haystack = blockSearchText(block);
  let score = 0;
  for (const token of questionTokens) {
    if (haystack.includes(token)) score += 1;
    if ((block?.topics || []).some((item) => String(item).toLowerCase().includes(token))) score += 2;
    if ((block?.people || []).some((item) => String(item).toLowerCase().includes(token))) score += 3;
  }
  for (const term of identityTerms) {
    if (!term) continue;
    const sharedGuestMatch = (Array.isArray(block?.sharedChatGuests) ? block.sharedChatGuests : []).some((guest) => [
      guest?.userId,
      guest?.login,
      guest?.displayName
    ].some((value) => String(value || '').trim().toLowerCase() === term));
    if ((block?.people || []).some((item) => String(item).toLowerCase() === term)) score += 8;
    else if (sharedGuestMatch) score += 8;
    else if (haystack.includes(term)) score += 4;
  }
  if (block?.attributionAudited === true) score += 1;
  return score;
}

module.exports = { tokenize, identityRetrievalTerms, blockSearchText, scoreBlockForQuestion };
