'use strict';

// Natural-language intent is handled by the main generation's semantic
// reply/lookup protocol. No phrase classifier or stock playback/banter route.
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

function taggedAuditFailureMessage({ rejected = false, timeout = false } = {}) {
  // An actual failure remains an operational notice, not fabricated banter or
  // a false explanation that identities/context were missing.
  if (rejected) return "I can't verify that claim from the context I have.";
  return timeout
    ? 'My answer check timed out. Try me again in a moment.'
    : "My answer check is temporarily unavailable. Try me again in a moment.";
}

const TAGGED_DIALOGUE_RULES = `CONVERSATIONAL INTENT AND ATTRIBUTION:
- Understand intent from context and meaning, not a fixed vocabulary or the presence of a question mark/link. The same request can be serious, playful, rhetorical, mixed, or ambiguous.
- A mention/direct address, rhetorical question, fictional self-deprecation, or hypothetical is not automatically a factual claim. Judge the actual proposition being asserted. A user's claim about what someone did is not verified merely because it appears in the question.
- Requests to play media may be jokes about asking the bot instead of the streamer. Preserve personality and respond naturally, while honoring application capabilities. Do not force a stock limitation response or assume an unobserved streamer refusal.
- Keep the judgment about conversational tone separate from the judgment about factual truth. A reply can join a joke without endorsing its alleged real-world setup.
- A rhetorical invitation to join harmless banter is not necessarily a request to investigate a factual accusation. You can answer in character with hypothetical support or a joke about the wording, without accepting the allegation as true.
- A repeated @username is the same account repeated, not multiple people. A claim about what the asker typed can be supported by the question itself; a claim that the accused person really did it cannot.
- Treat third-party accusations and claims about someone's emotions in the question as the asker's framing, NOT independent verification. Do not assert that someone gaslit, harmed, or made another person sad solely because the asker said so.
- A direct address ("Put me in, chat"), clearly imaginary first-person backup, or a rhetorical "blink twice if you need backup" does not assert an observed event. Do not invent missing-context disclaimers for harmless conversational language.
- Keep supported literal observations and safe banter independent of unverified claims. Never invent causes, real actions, punishment, motives, relationships, or personal facts to make the joke work.`;

module.exports = { stripTaggedVocatives, taggedAuditFailureMessage, TAGGED_DIALOGUE_RULES };
