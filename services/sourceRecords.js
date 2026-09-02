'use strict';

const BOT_CONTEXT_PREFIX = '[BOT CONTEXT ONLY]';
const MOD_ANNOUNCEMENT_PREFIX = '[MODERATOR ANNOUNCEMENT';
const IDENTITY_ROLES = new Set(['viewer', 'moderator', 'broadcaster', 'bot', 'system', 'unknown']);
const MESSAGE_KINDS = new Set(['viewer', 'bot_context', 'moderator_announcement']);

function cleanInline(value, max = 5000) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function normalizeLogin(value) {
  return String(value ?? '').replace(/^@+/, '').trim().toLowerCase();
}

function normalizeDisplayName(value) {
  return String(value ?? '').replace(/^@+/, '').trim().slice(0, 80);
}

function normalizeUserId(value) {
  return String(value ?? '').trim().slice(0, 80);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeRole(value) {
  const role = String(value ?? '').trim().toLowerCase();
  return IDENTITY_ROLES.has(role) ? role : 'unknown';
}

const IDENTITY_ROLE_PRIORITY = Object.freeze({
  unknown: 0,
  viewer: 1,
  system: 1,
  bot: 2,
  moderator: 3,
  broadcaster: 4
});

function strongestIdentityRole(left, right) {
  const a = normalizeRole(left);
  const b = normalizeRole(right);
  return (IDENTITY_ROLE_PRIORITY[b] || 0) > (IDENTITY_ROLE_PRIORITY[a] || 0) ? b : a;
}

function uniqueAliases(values = []) {
  const aliases = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : [values]) {
    const value = normalizeDisplayName(raw);
    if (!value) continue;
    const key = value.normalize('NFKC').toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(value);
    if (aliases.length >= 16) break;
  }
  return aliases;
}

function normalizeIdentity(value = {}, fallback = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const base = fallback && typeof fallback === 'object' ? fallback : {};
  const login = normalizeLogin(
    source.login ?? source.username ?? source.userLogin ?? source.authorLogin ??
    base.login ?? base.username ?? base.userLogin ?? base.authorLogin
  );
  const displayName = normalizeDisplayName(
    source.displayName ?? source.name ?? source.userName ?? source.authorDisplayName ??
    base.displayName ?? base.name ?? base.userName ?? base.authorDisplayName ?? login
  ) || login;
  const userId = normalizeUserId(
    source.userId ?? source.twitchUserId ?? source.authorUserId ??
    base.userId ?? base.twitchUserId ?? base.authorUserId
  );
  const role = normalizeRole(source.role ?? source.authorRole ?? base.role ?? base.authorRole);
  const aliases = uniqueAliases([
    ...(Array.isArray(source.aliases) ? source.aliases : []),
    ...(Array.isArray(base.aliases) ? base.aliases : []),
    displayName,
    login
  ]);
  return { userId, login, displayName, role, aliases };
}

function identityKey(identity = {}) {
  const normalized = normalizeIdentity(identity);
  if (normalized.userId) return `uid:${normalized.userId}`;
  if (normalized.login) return `login:${normalized.login}`;
  if (normalized.displayName) return `name:${normalized.displayName.normalize('NFKC').toLocaleLowerCase('en-US')}`;
  return '';
}

function sameIdentity(left = {}, right = {}) {
  const a = normalizeIdentity(left);
  const b = normalizeIdentity(right);
  if (a.userId && b.userId) return a.userId === b.userId;
  if (a.login && b.login) return a.login === b.login;
  const aliasesA = new Set(a.aliases.map((item) => item.normalize('NFKC').toLocaleLowerCase('en-US')));
  return b.aliases.some((item) => aliasesA.has(item.normalize('NFKC').toLocaleLowerCase('en-US')));
}

function roleFromTwitchTags(tags = {}, { isBot = false } = {}) {
  if (isBot) return 'bot';
  const badges = tags?.badges || {};
  if (badges.broadcaster === '1') return 'broadcaster';
  if (tags.mod === true || tags.mod === '1' || tags.mod === 1 || badges.moderator === '1') return 'moderator';
  return 'viewer';
}

function identityFromTwitchTags(tags = {}, displayName = '', options = {}) {
  return normalizeIdentity({
    userId: tags?.['user-id'] || tags?.userId || '',
    login: tags?.username || tags?.['user-login'] || tags?.login || '',
    displayName: displayName || tags?.['display-name'] || tags?.username || '',
    role: roleFromTwitchTags(tags, options)
  });
}

function parseLegacyChatLine(line, kindHint = '') {
  let value = cleanInline(line);
  if (!value) return null;
  let kind = MESSAGE_KINDS.has(kindHint) ? kindHint : 'viewer';

  if (value.startsWith(BOT_CONTEXT_PREFIX)) {
    kind = 'bot_context';
    value = value.slice(BOT_CONTEXT_PREFIX.length).trim();
  }

  if (value.startsWith(MOD_ANNOUNCEMENT_PREFIX)) {
    const match = value.match(/^\[MODERATOR ANNOUNCEMENT(?:\s*\(([^)]+)\))?\s+by\s+([^\]]+)\]:\s*([\s\S]*)$/i);
    if (match) {
      return {
        kind: 'moderator_announcement',
        text: cleanInline(match[3]),
        author: normalizeIdentity({ displayName: match[2], role: 'moderator' }),
        metadata: { color: cleanInline(match[1], 40) }
      };
    }
  }

  const match = value.match(/^([^:\n]{1,80}):\s*([\s\S]*)$/);
  if (!match) {
    return {
      kind,
      text: value,
      author: normalizeIdentity({ role: kind === 'bot_context' ? 'bot' : 'unknown' }),
      metadata: {}
    };
  }

  return {
    kind,
    text: cleanInline(match[2]),
    author: normalizeIdentity({
      displayName: match[1],
      login: match[1],
      role: kind === 'bot_context' ? 'bot' : 'viewer'
    }),
    metadata: {}
  };
}

function normalizeReplyReference(value = {}) {
  if (!value || typeof value !== 'object') return null;
  const messageId = cleanInline(value.messageId ?? value.parentMessageId ?? value.twitchMessageId, 160);
  const text = cleanInline(value.text ?? value.parentBody, 1000);
  const author = normalizeIdentity(value.author || {
    userId: value.userId ?? value.parentUserId,
    login: value.login ?? value.parentUserLogin,
    displayName: value.displayName ?? value.parentDisplayName,
    role: value.role
  });
  if (!messageId && !text && !identityKey(author)) return null;
  return { messageId, text, author };
}

function normalizeChatRecord(value, defaults = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  let parsed = null;
  if (!source) parsed = parseLegacyChatLine(value, defaults.kind);
  else if (!source.author && !source.authorLogin && !source.authorDisplayName && typeof source.text === 'string') {
    parsed = parseLegacyChatLine(source.text, source.kind || defaults.kind);
  }

  const kind = MESSAGE_KINDS.has(source?.kind)
    ? source.kind
    : (MESSAGE_KINDS.has(parsed?.kind) ? parsed.kind : (MESSAGE_KINDS.has(defaults.kind) ? defaults.kind : 'viewer'));
  const author = normalizeIdentity(
    source?.author || {
      userId: source?.authorUserId,
      login: source?.authorLogin,
      displayName: source?.authorDisplayName,
      role: source?.authorRole
    },
    parsed?.author || defaults.author || { role: kind === 'bot_context' ? 'bot' : 'viewer' }
  );
  if (kind === 'bot_context' && author.role === 'unknown') author.role = 'bot';
  if (kind === 'moderator_announcement' && !['moderator', 'broadcaster'].includes(author.role)) author.role = 'moderator';

  const textCandidates = [
    source?.body,
    source?.message,
    source?.rawMessage,
    parsed?.text,
    source?.text,
    value
  ];
  const selectedText = textCandidates.find((candidate) => String(candidate ?? '').trim());
  const text = cleanInline(selectedText ?? '');

  return {
    id: Number(source?.id ?? defaults.id ?? 0) || 0,
    twitchMessageId: cleanInline(source?.twitchMessageId ?? source?.messageId ?? defaults.twitchMessageId, 160),
    timestamp: Number(source?.timestamp ?? source?.sentAtMs ?? defaults.timestamp ?? Date.now()) || Date.now(),
    kind,
    author,
    text,
    replyTo: normalizeReplyReference(source?.replyTo || defaults.replyTo),
    metadata: {
      ...(parsed?.metadata || {}),
      ...(defaults.metadata && typeof defaults.metadata === 'object' ? defaults.metadata : {}),
      ...(source?.metadata && typeof source.metadata === 'object' ? source.metadata : {})
    }
  };
}

function renderChatRecord(value, { includeBotMarker = true, includeSourceId = false } = {}) {
  const record = normalizeChatRecord(value);
  const sourceId = includeSourceId ? `[${chatSourceId(record)}] ` : '';
  const name = record.author.displayName || record.author.login || (record.kind === 'bot_context' ? 'SqwertArmyBot' : 'Unknown viewer');
  if (record.kind === 'moderator_announcement') {
    const color = cleanInline(record.metadata?.color, 40);
    return `${sourceId}[MODERATOR ANNOUNCEMENT${color ? ` (${color})` : ''} by ${name}]: ${record.text}`.trim();
  }
  const line = `${name}: ${record.text}`.trim();
  if (record.kind === 'bot_context' && includeBotMarker) return `${sourceId}${BOT_CONTEXT_PREFIX} ${line}`.trim();
  return `${sourceId}${line}`.trim();
}

function chatSourceId(value, fallbackIndex = 0) {
  const record = normalizeChatRecord(value);
  const raw = record.twitchMessageId || (record.id ? `recap-${record.id}` : `index-${fallbackIndex + 1}`);
  return `M${String(raw).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || fallbackIndex + 1}`;
}

function normalizeEventRecord(value, defaults = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const metadata = {
    ...(defaults.metadata && typeof defaults.metadata === 'object' ? defaults.metadata : {}),
    ...(source.metadata && typeof source.metadata === 'object' ? source.metadata : {})
  };
  return {
    id: Number(source.id ?? defaults.id ?? 0) || 0,
    sourceEventId: cleanInline(source.sourceEventId ?? source.eventId ?? source.messageId ?? defaults.sourceEventId, 160),
    timestamp: Number(source.timestamp ?? defaults.timestamp ?? Date.now()) || Date.now(),
    type: cleanInline(source.type ?? defaults.type ?? 'twitch_event', 160),
    text: cleanInline(source.text ?? defaults.text, 1600),
    actor: normalizeIdentity(source.actor || {
      userId: source.actorUserId,
      login: source.actorLogin,
      displayName: source.actorDisplayName,
      role: source.actorRole || 'viewer'
    }),
    target: normalizeIdentity(source.target || {
      userId: source.targetUserId,
      login: source.targetLogin,
      displayName: source.targetDisplayName,
      role: source.targetRole || 'viewer'
    }),
    anonymous: source.anonymous === true,
    amount: numberOrNull(source.amount),
    quantity: numberOrNull(source.quantity),
    rewardId: cleanInline(source.rewardId, 160),
    metadata
  };
}

function eventSourceId(value, fallbackIndex = 0) {
  const record = normalizeEventRecord(value);
  const raw = record.sourceEventId || (record.id ? `recap-${record.id}` : `index-${fallbackIndex + 1}`);
  return `E${String(raw).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || fallbackIndex + 1}`;
}

function renderEventRecord(value, { includeSourceId = false, index = 0 } = {}) {
  const record = normalizeEventRecord(value);
  const sourceId = includeSourceId ? `[${eventSourceId(record, index)}] ` : '';
  return `${sourceId}${record.text}`.trim();
}

function identityAliases(identity = {}) {
  return normalizeIdentity(identity).aliases;
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textMentionsAlias(text, alias) {
  const name = normalizeDisplayName(alias);
  if (!name) return false;
  const escaped = escapeRegExp(name);
  // Unicode-aware boundaries avoid truncating or partially matching names.
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(String(text ?? ''));
}

function textMentionsIdentity(text, identity = {}) {
  return identityAliases(identity).some((alias) => textMentionsAlias(text, alias));
}

const SENTENCE_CONTINUATION_ABBREVIATION = /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|St|Mt|No|vs)\.$/i;
const SENTENCE_CONTINUATION_INITIAL = /(?:^|\s)[A-Z]\.$/;

function joinSentenceSegments(parts = []) {
  const sentences = [];
  let pending = '';

  for (const rawPart of Array.isArray(parts) ? parts : []) {
    const part = String(rawPart ?? '').trim();
    if (!part) continue;
    pending = pending ? `${pending} ${part}` : part;

    // Intl.Segmenter splits titles and initials such as "Mr. Mime" and
    // "A. J. Cook" into separate sentences. Keep buffering while the
    // current text ends with an abbreviation that requires a continuation.
    if (SENTENCE_CONTINUATION_ABBREVIATION.test(pending) || SENTENCE_CONTINUATION_INITIAL.test(pending)) {
      continue;
    }

    sentences.push(pending);
    pending = '';
  }

  if (pending) sentences.push(pending);
  return sentences;
}

function splitSentences(text) {
  const value = String(text ?? '').trim();
  if (!value) return [];
  if (typeof Intl?.Segmenter === 'function') {
    try {
      const parts = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(value)]
        .map((entry) => String(entry.segment || '').trim())
        .filter(Boolean);
      return joinSentenceSegments(parts);
    } catch (_) {
      // Fall through to the conservative fallback below.
    }
  }
  return joinSentenceSegments(value.match(/[^.!?]+(?:[.!?]+|$)/g) || [value]);
}

function buildBroadcasterIdentity(channelName = '') {
  const channel = normalizeLogin(channelName);
  const displayName = channel === 'generalqwert' ? 'GeneralQwert' : (normalizeDisplayName(channelName) || channel);
  const aliases = [displayName, channel];
  if (channel === 'generalqwert') aliases.push('Qwert');
  return normalizeIdentity({ login: channel, displayName, role: 'broadcaster', aliases });
}

function collectIdentityRegistry({ chatRecords = [], eventRecords = [], extraIdentities = [], channelName = '' } = {}) {
  const registry = [];
  const add = (identity) => {
    const normalized = normalizeIdentity(identity);
    if (!identityKey(normalized)) return;
    const index = registry.findIndex((prior) => {
      if (prior.userId && normalized.userId) return prior.userId === normalized.userId;
      if (prior.login && normalized.login) return prior.login === normalized.login;
      return sameIdentity(prior, normalized);
    });
    if (index < 0) {
      registry.push(normalized);
      return;
    }
    const prior = registry[index];
    registry[index] = normalizeIdentity({
      userId: prior.userId || normalized.userId,
      login: prior.login || normalized.login,
      displayName: normalized.displayName || prior.displayName,
      // Identity evidence can arrive in any order. Preserve the strongest
      // verified role rather than letting an earlier viewer record prevent a
      // later moderator/broadcaster upgrade.
      role: strongestIdentityRole(prior.role, normalized.role),
      aliases: [...prior.aliases, ...normalized.aliases]
    });
  };

  if (channelName) add(buildBroadcasterIdentity(channelName));
  for (const value of Array.isArray(chatRecords) ? chatRecords : []) add(normalizeChatRecord(value).author);
  for (const value of Array.isArray(eventRecords) ? eventRecords : []) {
    const event = normalizeEventRecord(value);
    add(event.actor);
    add(event.target);
  }
  for (const identity of Array.isArray(extraIdentities) ? extraIdentities : []) add(identity);
  return registry;
}

function normalizeChatRecords(values = []) {
  return (Array.isArray(values) ? values : []).map((value) => normalizeChatRecord(value)).filter((record) => record.text);
}

function normalizeEventRecords(values = []) {
  return (Array.isArray(values) ? values : []).map((value) => normalizeEventRecord(value)).filter((record) => record.text);
}

module.exports = {
  BOT_CONTEXT_PREFIX,
  MOD_ANNOUNCEMENT_PREFIX,
  cleanInline,
  normalizeLogin,
  normalizeDisplayName,
  normalizeUserId,
  numberOrNull,
  normalizeRole,
  strongestIdentityRole,
  normalizeIdentity,
  identityKey,
  sameIdentity,
  uniqueAliases,
  roleFromTwitchTags,
  identityFromTwitchTags,
  normalizeReplyReference,
  normalizeChatRecord,
  normalizeChatRecords,
  renderChatRecord,
  chatSourceId,
  normalizeEventRecord,
  normalizeEventRecords,
  renderEventRecord,
  eventSourceId,
  identityAliases,
  textMentionsAlias,
  textMentionsIdentity,
  splitSentences,
  buildBroadcasterIdentity,
  collectIdentityRegistry
};
