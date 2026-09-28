'use strict';

// Routing is only a latency/privacy hint. It NEVER makes a viewer's allegation
// true, disables model safety, or approves factual claims in a generated answer.
function classifyTaggedQuestion(question = '') {
  const text = String(question).replace(/\s+/g, ' ').trim();
  const explicitSearch = /\b(?:search|look\s+up|google|find\s+(?:sources|citations)|check\s+(?:online|the\s+web))\b/i.test(text);
  const localReference = /@[a-z0-9_]{2,25}\b|\b(?:qwert|sqwertarmybot|oakbot|this\s+chat|in\s+here|our\s+chat|your\s+boy)\b/i.test(text);
  const factualChallenge = /\b(?:did|does|has|is|was)\b.{0,80}\b(?:actually|really|truly)\b|\b(?:prove|evidence|verify|confirm|who\s+(?:said|did)|what\s+happened)\b/i.test(text);
  const invitation = /\b(?:will|would|can|could|are)\s+you\b.{0,100}\b(?:watch|stand\s+by|sit|defend|backup|back\s+up|help|join|let)\b|\b(?:roast|banter|joke\s+about|give\s+me\s+a\s+comeback)\b/i.test(text);
  // Do not provide a playful outage substitute to requests for real harm,
  // punishment, medical advice or serious accusations. Normal safety remains.
  const sensitive = /\b(?:kill|hurt|attack|harm|punish|dox|doxx|address|threat|suicide|self.harm|abuse|assault|rape|groom|stole|steal|scam|diagnos\w*|medicat\w*|overdose)\b/i.test(text);
  if (localReference && invitation && !factualChallenge && !explicitSearch && !sensitive) {
    return { kind: 'banter', reason: 'local-rhetorical-invitation', allowWebSearch: false };
  }
  if (localReference && !explicitSearch) {
    return { kind: 'channel', reason: 'channel-context-not-public-evidence', allowWebSearch: false };
  }
  return { kind: 'public', reason: explicitSearch ? 'explicit-public-lookup' : 'general-question', allowWebSearch: true };
}

function escapeRegex(text) { return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Only punctuation-delimited direct addresses are removed. A named subject or
// an address followed by a predicate/parenthetical remains an attribution risk.
function stripTaggedVocatives(sentence = '', identities = []) {
  let text = String(sentence).trim();
  const names = new Set(['chat', 'mods', 'everyone']);
  for (const identity of identities) {
    for (const alias of [identity?.login, identity?.displayName, ...(identity?.aliases || [])]) {
      const name = String(alias || '').trim().replace(/^@+/, '');
      if (/^[\p{L}\p{N}_]{2,80}$/u.test(name)) names.add(name);
    }
  }
  for (const mention of text.matchAll(/@([A-Za-z0-9_]{2,25})\b/g)) names.add(mention[1]);
  const alternatives = [...names].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
  const start = new RegExp(`^(?:(?:hey|hi|hello|yo|okay|ok)\\s+)?@?(?:${alternatives}),\\s*`, 'iu');
  const startMatch = start.exec(text);
  if (startMatch) {
    const rest = text.slice(startMatch[0].length);
    if (!/^(?:as\b|for\b|who\b|which\b|apparently\b|always\b|usually\b|is\b|are\b|was\b|were\b|has\b|have\b|had\b)/i.test(rest)) text = rest;
  }
  const end = new RegExp(`,\\s*@?(?:${alternatives})([.!?]*)$`, 'iu');
  // "The culprit was, Coosgoose." is NOT a vocative.
  const endMatch = end.exec(text);
  if (endMatch && !/\b(?:is|are|was|were|has|had|by|called|named|blame|accuse|suspect)\s*$/i.test(text.slice(0, endMatch.index))) {
    text = text.slice(0, endMatch.index) + (endMatch[1] || '');
  }
  return text.trim();
}

function isClearlyNonFactualTaggedSentence(sentence = '', identities = []) {
  const text = stripTaggedVocatives(sentence, identities).replace(/[\u2018\u2019]/g, "'");
  // Intentionally narrow, complete-sentence forms. "It's a joke", an emoji,
  // a conditional, or merely saying "imaginary" cannot whitewash an allegation.
  return [
    /^(?:put|count) me in[.!]?$/i,
    /^(?:i'm|i am) (?:bringing|on) imaginary backup(?: duty)?[.!]?$/i,
    /^blink (?:once|twice) if you need (?:backup|moral support)[.!?]?$/i,
    /^(?:hey|hi|hello|thanks|thank you|congrats|congratulations)[.!]?$/i
  ].some((pattern) => pattern.test(text));
}

function taggedAuditFailureMessage({ question = '', intent = null, rejected = false, timeout = false, relay = false } = {}) {
  // This is an explicitly marked degraded reply, not an invented fact or a
  // purported successful audit. No names or allegations are echoed from input.
  const route = intent || classifyTaggedQuestion(question);
  if (!relay && route.kind === 'banter') {
    return "I'm on imaginary backup duty. Moral support, not a detective report.";
  }
  if (rejected) return "I can't verify that claim from the context I have.";
  return timeout
    ? 'My answer check timed out. Try me again in a moment.'
    : "My answer check is temporarily unavailable. Try me again in a moment.";
}

const TAGGED_DIALOGUE_RULES = `CONVERSATIONAL INTENT AND ATTRIBUTION:
- A rhetorical invitation to join harmless banter is not necessarily a request to investigate a factual accusation. You can answer in character with hypothetical support or a joke about the wording, without accepting the allegation as true.
- A repeated @username is the same account repeated, not multiple people. A claim about what the asker typed can be supported by the question itself; a claim that the accused person really did it cannot.
- Treat third-party accusations and claims about someone's emotions in the question as the asker's framing, NOT independent verification. Do not assert that someone gaslit, harmed, or made another person sad solely because the asker said so.
- A direct address ("Put me in, chat"), clearly imaginary first-person backup, or a rhetorical "blink twice if you need backup" does not assert an observed event. Do not invent missing-context disclaimers for harmless conversational language.
- Keep supported literal observations and safe banter independent of unverified claims. Never invent causes, real actions, punishment, motives, relationships, or personal facts to make the joke work.`;

module.exports = { classifyTaggedQuestion, stripTaggedVocatives,
  isClearlyNonFactualTaggedSentence, taggedAuditFailureMessage, TAGGED_DIALOGUE_RULES };
