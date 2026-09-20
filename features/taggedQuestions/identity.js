'use strict';

const {
  normalizeIdentity,
  identityFromTwitchTags,
  sameIdentity,
  normalizeSharedChatOrigin
} = require('../../services/sourceRecords');

function normalizeViewerIdentityValue(value) {
  return String(value || '').replace(/^@+/, '').trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildViewerIdentity(displayName, tags = {}) {
  return normalizeIdentity(
    identityFromTwitchTags(tags, displayName),
    { displayName: normalizeViewerIdentityValue(displayName) || 'viewer', role: 'viewer' }
  );
}

function viewerIdentityForPrompt(identity = {}) {
  return [
    `Display name: ${identity.displayName || 'viewer'}`,
    identity.login ? `Login: ${identity.login}` : 'Login: (unavailable)',
    identity.userId ? `Twitch user ID: ${identity.userId}` : 'Twitch user ID: (unavailable)',
    identity.aliases?.length ? `Known current-account aliases: ${identity.aliases.join(', ')}` : ''
  ].filter(Boolean).join('\n');
}

function identitySearchTerms(identity = {}) {
  return normalizeIdentity(identity).aliases.filter(Boolean).join('\n');
}

function formatSharedChatRequesterContext(value = {}) {
  const origin = normalizeSharedChatOrigin(value);
  if (!origin.isGuest) return '';
  const sourceCommunity = origin.sourceBroadcasterDisplayName || origin.sourceBroadcasterLogin || origin.sourceBroadcasterUserId || 'another participating broadcaster';
  return [
    'Requester origin: TWITCH SHARED CHAT GUEST',
    `Source community/room: ${sourceCommunity}`,
    origin.sourceBroadcasterLogin ? `Source broadcaster login: ${origin.sourceBroadcasterLogin}` : '',
    origin.sourceBroadcasterUserId ? `Source broadcaster Twitch ID: ${origin.sourceBroadcasterUserId}` : '',
    '- Twitch duplicated this question into GeneralQwert\'s room from another participating broadcaster\'s Shared Chat.',
    '- The requester is a valid participant in the current combined conversation.',
    '- This origin does NOT establish that the requester is a GeneralQwert regular, moderator, broadcaster, profile owner, or subject of GeneralQwert lore.',
    '- Never use source-room badges to grant GeneralQwert moderator/broadcaster identity or permissions.',
    '- Do not transfer the source community\'s relationships, inside jokes, commands, or lore onto GeneralQwert\'s community.'
  ].filter(Boolean).join('\n');
}

const RELAY_PRONOUN_TARGETS = new Set(['me', 'myself', 'us', 'ourselves', 'you', 'yourself', 'him', 'her', 'them', 'themselves', 'everyone', 'everybody', 'chat']);

function sameViewerIdentityName(value, identity = {}) {
  const normalized = normalizeViewerIdentityValue(value).toLowerCase();
  if (!normalized) return false;
  return (Array.isArray(identity.aliases) ? identity.aliases : [])
    .some((alias) => normalizeViewerIdentityValue(alias).toLowerCase() === normalized);
}

function buildRelayRecipientIdentity(target, replyContext = null) {
  const login = normalizeViewerIdentityValue(target).toLowerCase();
  if (!login || !/^[a-z0-9_]{2,25}$/.test(login)) return null;

  const replyParentIdentity = normalizeIdentity({
    userId: replyContext?.parentUserId || '',
    login: replyContext?.parentUserLogin || '',
    displayName: replyContext?.parentDisplayName || replyContext?.parentUserLogin || '',
    role: 'viewer'
  });
  const targetIdentity = normalizeIdentity({ login, displayName: target, role: 'viewer', aliases: [target] });
  if (replyParentIdentity.userId && sameIdentity(targetIdentity, replyParentIdentity)) {
    return normalizeIdentity({
      ...replyParentIdentity,
      aliases: [...replyParentIdentity.aliases, target]
    });
  }
  return targetIdentity;
}

function detectRelayRecipient(question, requesterIdentity = {}, botUsername = '', replyContext = null) {
  const text = String(question || '').trim();
  if (!text) return null;
  const patterns = [
    /\b(?:can\s+you\s+|could\s+you\s+|would\s+you\s+|please\s+)?tell\s+@([A-Za-z0-9_]{2,25})\s+(?:what|that|about|how|why|where|when|who|the|everything|something|this|them|him|her|it)\b/i,
    /\b(?:can\s+you\s+|could\s+you\s+|would\s+you\s+|please\s+)?(?:catch|fill)\s+@([A-Za-z0-9_]{2,25})\s+(?:up|in)\b/i,
    /\b(?:can\s+you\s+|could\s+you\s+|would\s+you\s+|please\s+)?(?:explain|relay|say)\s+(?:this\s+|that\s+|it\s+)?to\s+@([A-Za-z0-9_]{2,25})\b/i,
    /\b(?:can\s+you\s+|could\s+you\s+|would\s+you\s+|please\s+)?let\s+@([A-Za-z0-9_]{2,25})\s+know\b/i,
    /\b(?:can\s+you\s+|could\s+you\s+|would\s+you\s+|please\s+)?give\s+@([A-Za-z0-9_]{2,25})\s+(?:a\s+)?(?:recap|summary|update|rundown|briefing|catch-?up)\b/i,
    /\b(?:can\s+you\s+|could\s+you\s+|would\s+you\s+|please\s+)?brief\s+@([A-Za-z0-9_]{2,25})\b/i,
    /\b(?:can\s+you\s+|could\s+you\s+|would\s+you\s+|please\s+)?bring\s+@([A-Za-z0-9_]{2,25})\s+up\s+to\s+speed\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const target = normalizeViewerIdentityValue(match?.[1] || '');
    if (!target) continue;
    const lower = target.toLowerCase();
    if (RELAY_PRONOUN_TARGETS.has(lower)) continue;
    if (sameViewerIdentityName(target, requesterIdentity)) continue;
    if (lower === String(botUsername || '').replace(/^@+/, '').toLowerCase().trim()) continue;
    return buildRelayRecipientIdentity(target, replyContext);
  }
  return null;
}

function relayRolesForPrompt(requesterIdentity = {}, recipientIdentity = {}, botUsername = '') {
  return [
    `Requester: ${requesterIdentity.displayName || requesterIdentity.login || 'viewer'}`,
    `Intended recipient: ${recipientIdentity.displayName || recipientIdentity.login || 'viewer'}`,
    `Bot/self: ${botUsername || 'the configured Twitch bot'}`,
    'Delivery mode: RELAY (the requester asked the bot to speak to a different viewer)'
  ].join('\n');
}

function selfOtherDirectivePatterns(identity = {}) {
  const aliases = Array.isArray(identity.aliases) ? identity.aliases : [];
  return aliases
    .map((alias) => escapeRegExp(normalizeViewerIdentityValue(alias)))
    .filter(Boolean)
    .flatMap((alias) => {
      const target = `@?${alias}(?=$|[^A-Za-z0-9_])`;
      return [
        new RegExp(`\\b(?:go\\s+)?(?:ask|tell|bother|bug|pester|message|dm|ping|contact)\\s+${target}`, 'i'),
        new RegExp(`\\b(?:go\\s+)?(?:talk\\s+to|check\\s+with|reach\\s+out\\s+to)\\s+${target}`, 'i')
      ];
    });
}

function hasObviousSelfOtherDirective(answer, identity = {}) {
  const text = String(answer || '');
  if (!text.trim()) return false;
  return selfOtherDirectivePatterns(identity).some((pattern) => pattern.test(text));
}

function repairSelfOtherDirectiveLocally(answer, identity = {}) {
  let text = String(answer || '').trim();
  for (const aliasValue of Array.isArray(identity.aliases) ? identity.aliases : []) {
    const alias = escapeRegExp(normalizeViewerIdentityValue(aliasValue));
    if (!alias) continue;
    const target = `@?${alias}(?=$|[^A-Za-z0-9_])`;
    text = text.replace(
      new RegExp(`\\b(go\\s+)?(ask|tell|bother|bug|pester|message|dm|ping|contact)\\s+${target}`, 'gi'),
      (_match, go = '', verb = '') => `${go || ''}${verb} yourself`
    );
    text = text.replace(
      new RegExp(`\\b(go\\s+)?(talk\\s+to|check\\s+with|reach\\s+out\\s+to)\\s+${target}`, 'gi'),
      (_match, go = '', phrase = '') => `${go || ''}${phrase} yourself`
    );
  }
  return text;
}

module.exports = {
  normalizeViewerIdentityValue,
  buildViewerIdentity,
  viewerIdentityForPrompt,
  identitySearchTerms,
  formatSharedChatRequesterContext,
  buildRelayRecipientIdentity,
  detectRelayRecipient,
  relayRolesForPrompt,
  hasObviousSelfOtherDirective,
  repairSelfOtherDirectiveLocally
};
