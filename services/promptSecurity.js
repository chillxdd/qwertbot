const crypto = require('crypto');

const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
const MAX_SECURITY_REASON_LENGTH = 80;

const DIRECT_INJECTION_PATTERNS = [
  {
    id: 'override_instructions',
    re: /\b(?:ignore|disregard|forget|override|bypass|discard)\b.{0,100}\b(?:previous|prior|all|system|developer|hidden|your|original)\b.{0,60}\b(?:instructions?|rules?|prompt|policy|policies|personality|directives?)\b/i
  },
  {
    id: 'instruction_override_reverse',
    re: /\b(?:instructions?|rules?|prompt|policy|policies|personality|directives?)\b.{0,80}\b(?:ignore|disregard|forget|override|bypass|discard)\b/i
  },
  {
    id: 'prompt_exfiltration',
    re: /\b(?:reveal|show|print|repeat|output|dump|expose|leak|quote|display)\b.{0,80}\b(?:system|developer|hidden|internal|secret|original|full)\b.{0,60}\b(?:prompt|instructions?|message|rules?|configuration|config|directives?)\b/i
  },
  {
    id: 'privileged_role_impersonation',
    re: /\b(?:act|pretend|respond|behave)\s+as\s+(?:the\s+)?(?:system|developer|administrator|admin)\b/i
  },
  {
    id: 'new_privileged_instructions',
    re: /\b(?:new|replacement|updated)\s+(?:(?:system|developer)\s+)?(?:prompt|instructions?|rules?|directives?)\s*[:=-]/i
  },
  {
    id: 'do_not_follow_rules',
    re: /\bdo\s+not\s+(?:follow|obey|use)\b.{0,80}\b(?:previous|prior|system|developer|your|original|hidden)\b.{0,50}\b(?:instructions?|rules?|prompt|policy|directives?)\b/i
  },
  {
    id: 'role_marker_spoofing',
    re: /(?:^|\s)(?:system|developer|assistant)\s*(?:message)?\s*[:=-]\s*.+/i
  }
];

const META_DISCUSSION_PATTERNS = [
  /\bwhat\s+(?:is|are|does)\b.{0,80}\bprompt\s+injection\b/i,
  /\b(?:explain|define|describe)\b.{0,80}\bprompt\s+injection\b/i,
  /\bhow\s+(?:does|do|can|should)\b.{0,100}\b(?:prompt\s+injection|jailbreak)\b/i,
  /\bwhy\s+(?:is|does|would)\b.{0,100}\b(?:prompt\s+injection|jailbreak)\b/i,
  /\b(?:protect|defend|prevent|mitigate|detect)\b.{0,100}\b(?:prompt\s+injection|jailbreak)\b/i
];

const LEAK_MARKERS = [
  'security / instruction hierarchy',
  'bot personality (saved by the broadcaster/mods)',
  'current-stream session memory (temporary same-stream evidence',
  'relevant viewer profiles (persistent community context',
  'stream-specific lore (saved by the broadcaster/mods',
  'output only the answer',
  'highest-priority security rules'
];

function canonicalizeSecurityText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(ZERO_WIDTH_RE, '')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMetaPromptSecurityDiscussion(text) {
  const normalized = canonicalizeSecurityText(text);
  return META_DISCUSSION_PATTERNS.some((re) => re.test(normalized));
}

function detectPromptInjection(text) {
  const normalized = canonicalizeSecurityText(text);
  if (!normalized) return { suspicious: false, block: false, reasons: [] };

  const reasons = DIRECT_INJECTION_PATTERNS
    .filter((entry) => entry.re.test(normalized))
    .map((entry) => entry.id.slice(0, MAX_SECURITY_REASON_LENGTH));

  if (!reasons.length) return { suspicious: false, block: false, reasons: [] };

  const metaDiscussion = isMetaPromptSecurityDiscussion(normalized);
  return {
    suspicious: true,
    // Clear instruction-override/exfiltration language is blocked unless the
    // message is plainly discussing prompt injection as a topic.
    block: !metaDiscussion,
    metaDiscussion,
    reasons
  };
}

function containsPromptInjectionLanguage(text) {
  return detectPromptInjection(text).suspicious;
}

function createUntrustedBlock(label, value) {
  const content = String(value || '').trim();
  if (!content) return `${label}: (none)`;
  const nonce = crypto.randomBytes(8).toString('hex');
  const open = `BEGIN_UNTRUSTED_${label.replace(/[^A-Z0-9]+/gi, '_').toUpperCase()}_${nonce}`;
  const close = `END_UNTRUSTED_${label.replace(/[^A-Z0-9]+/gi, '_').toUpperCase()}_${nonce}`;
  return `${open}\n${content}\n${close}`;
}

function normalizeOverlapText(value) {
  return canonicalizeSecurityText(value).toLowerCase();
}

function hasLongProtectedOverlap(answer, protectedSegments = [], minLength = 90) {
  const normalizedAnswer = normalizeOverlapText(answer);
  if (normalizedAnswer.length < minLength) return false;

  for (const segment of protectedSegments) {
    const protectedText = normalizeOverlapText(segment);
    if (protectedText.length < minLength) continue;

    // Compare chunks from the answer against protected prompt/context text.
    // This catches verbatim prompt dumping without blocking ordinary short facts.
    for (let i = 0; i <= normalizedAnswer.length - minLength; i += Math.max(20, Math.floor(minLength / 3))) {
      const chunk = normalizedAnswer.slice(i, i + minLength);
      if (protectedText.includes(chunk)) return true;
    }
  }
  return false;
}

function inspectModelOutputForLeak(answer, protectedSegments = []) {
  const normalized = normalizeOverlapText(answer);
  const marker = LEAK_MARKERS.find((value) => normalized.includes(value));
  if (marker) return { blocked: true, reason: `internal_marker:${marker}` };

  if (/\b(?:my|the)\s+(?:system|developer|hidden|internal)\s+(?:prompt|instructions?|message|rules?)\s+(?:is|are|says?|contains?)\b/i.test(normalized)) {
    return { blocked: true, reason: 'prompt_leak_claim' };
  }

  if (hasLongProtectedOverlap(answer, protectedSegments)) {
    return { blocked: true, reason: 'protected_text_overlap' };
  }

  return { blocked: false, reason: '' };
}

module.exports = {
  canonicalizeSecurityText,
  detectPromptInjection,
  containsPromptInjectionLanguage,
  createUntrustedBlock,
  inspectModelOutputForLeak
};
