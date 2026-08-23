const ViewerProfile = require('../models/ViewerProfile');
const ViewerProfileSettings = require('../models/ViewerProfileSettings');

const MAX_ALIASES = 12;
const MAX_PINNED_NOTES = 4000;
const MAX_FACTS = 60;
const MAX_FACT_LENGTH = 400;
const MAX_COMMAND_USAGE = 30;
const COMMAND_CONTEXT_MIN_COUNT = 3;
const OPT_OUT_RETENTION_DAYS = 30;
const OPT_OUT_RETENTION_MS = OPT_OUT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function normalizeChannelName(value) {
  return String(value || '').replace(/^#/, '').toLowerCase().trim();
}

function normalizeUsername(value) {
  return String(value || '').replace(/^@+/, '').toLowerCase().trim().replace(/[^a-z0-9_]/g, '');
}

function normalizeDisplayName(value) {
  return String(value || '').replace(/^@+/, '').trim().slice(0, 80);
}

function normalizeAliases(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  const seen = new Set();
  const out = [];
  for (const item of source) {
    const alias = String(item || '').replace(/^@+/, '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!alias) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
    if (out.length >= MAX_ALIASES) break;
  }
  return out;
}

function normalizeConfidence(value) {
  return ['low', 'medium', 'high'].includes(value) ? value : 'medium';
}

function normalizeFactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_LENGTH);
}

function serializeProfile(doc) {
  if (!doc) return null;
  const value = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: String(value._id || ''),
    username: String(value.username || ''),
    displayName: String(value.displayName || value.username || ''),
    twitchUserId: String(value.twitchUserId || ''),
    optedOut: value.optedOut === true,
    optedOutAt: value.optedOutAt || null,
    profileDataPurgedAt: value.profileDataPurgedAt || null,
    profileRetainedOnOptOut: value.profileRetainedOnOptOut === true,
    profileRetentionExpiresAt: value.optedOut === true && value.optedOutAt && !value.profileDataPurgedAt ? new Date(new Date(value.optedOutAt).getTime() + OPT_OUT_RETENTION_MS) : null,
    aliases: Array.isArray(value.aliases) ? value.aliases : [],
    pinnedNotes: String(value.pinnedNotes || ''),
    enabled: value.enabled !== false,
    learningEnabled: value.learningEnabled !== false,
    commandUsage: (Array.isArray(value.commandUsage) ? value.commandUsage : []).map((entry) => ({
      command: String(entry.command || ''),
      count: Math.max(1, Number(entry.count || 1)),
      offlineCount: Math.max(0, Number(entry.offlineCount || 0)),
      firstUsedAt: entry.firstUsedAt || null,
      lastUsedAt: entry.lastUsedAt || null
    })),
    facts: (Array.isArray(value.facts) ? value.facts : []).map((fact) => ({
      id: String(fact._id || ''),
      text: String(fact.text || ''),
      confidence: normalizeConfidence(fact.confidence),
      evidenceCount: Math.max(1, Number(fact.evidenceCount || 1)),
      firstObservedAt: fact.firstObservedAt || null,
      lastObservedAt: fact.lastObservedAt || null,
      enabled: fact.enabled !== false
    })),
    firstSeenAt: value.firstSeenAt || null,
    lastSeenAt: value.lastSeenAt || null,
    createdAt: value.createdAt || null,
    updatedAt: value.updatedAt || null
  };
}

async function getViewerProfileSettings(channelName) {
  const channel = normalizeChannelName(channelName);
  const doc = await ViewerProfileSettings.findOne({ channelName: channel }).lean();
  return {
    automaticLearningEnabled: doc?.automaticLearningEnabled !== false,
    useInTaggedQuestions: doc?.useInTaggedQuestions === true,
    updatedAt: doc?.updatedAt || null
  };
}

async function saveViewerProfileSettings(channelName, value = {}) {
  const channel = normalizeChannelName(channelName);
  const update = {
    automaticLearningEnabled: value.automaticLearningEnabled !== false,
    useInTaggedQuestions: value.useInTaggedQuestions === true
  };
  const doc = await ViewerProfileSettings.findOneAndUpdate(
    { channelName: channel },
    { $set: update },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  ).lean();
  return {
    automaticLearningEnabled: doc.automaticLearningEnabled !== false,
    useInTaggedQuestions: doc.useInTaggedQuestions === true,
    updatedAt: doc.updatedAt || null
  };
}

async function purgeExpiredOptedOutProfiles(channelName, now = new Date()) {
  const channel = normalizeChannelName(channelName);
  if (!channel) return { purged: 0 };
  const cutoff = new Date(new Date(now).getTime() - OPT_OUT_RETENTION_MS);
  const result = await ViewerProfile.updateMany(
    { channelName: channel, optedOut: true, optedOutAt: { $ne: null, $lte: cutoff }, profileDataPurgedAt: null },
    { $set: { aliases: [], pinnedNotes: '', facts: [], commandUsage: [], profileDataPurgedAt: new Date(now), profileRetainedOnOptOut: false } }
  );
  return { purged: Number(result.modifiedCount || 0) };
}

async function listViewerProfiles(channelName) {
  const channel = normalizeChannelName(channelName);
  await purgeExpiredOptedOutProfiles(channel);
  const docs = await ViewerProfile.find({ channelName: channel }).sort({ updatedAt: -1 }).lean();
  return docs.map(serializeProfile);
}

async function getViewerProfile(channelName, idOrUsername) {
  const channel = normalizeChannelName(channelName);
  await purgeExpiredOptedOutProfiles(channel);
  const raw = String(idOrUsername || '').trim();
  let doc = null;
  if (/^[a-f0-9]{24}$/i.test(raw)) doc = await ViewerProfile.findOne({ channelName: channel, _id: raw }).lean();
  if (!doc) doc = await ViewerProfile.findOne({ channelName: channel, username: normalizeUsername(raw) }).lean();
  return serializeProfile(doc);
}

async function saveViewerProfile(channelName, value = {}) {
  const channel = normalizeChannelName(channelName);
  const username = normalizeUsername(value.username);
  if (!username) throw new Error('A valid Twitch username is required.');
  const displayName = normalizeDisplayName(value.displayName) || username;
  const aliases = normalizeAliases(value.aliases).filter((alias) => alias.toLowerCase() !== username);
  const pinnedNotes = String(value.pinnedNotes || '').trim();
  if (pinnedNotes.length > MAX_PINNED_NOTES) throw new Error(`Pinned notes cannot exceed ${MAX_PINNED_NOTES} characters.`);

  const existing = await ViewerProfile.findOne({ channelName: channel, username });
  const viewerOptedOut = existing?.optedOut === true;
  if (viewerOptedOut) throw new Error('This viewer opted out. Their retained profile cannot be edited until they use !optin.');
  const doc = await ViewerProfile.findOneAndUpdate(
    { channelName: channel, username },
    { $set: {
      displayName,
      aliases,
      pinnedNotes,
      enabled: value.enabled !== false,
      learningEnabled: value.learningEnabled !== false
    }, $setOnInsert: { firstSeenAt: new Date(), lastSeenAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  );
  return serializeProfile(doc);
}

async function setViewerProfileOptOut(channelName, { username, displayName, twitchUserId, optedOut }) {
  const channel = normalizeChannelName(channelName);
  const normalizedUsername = normalizeUsername(username);
  const normalizedDisplayName = normalizeDisplayName(displayName) || normalizedUsername;
  const normalizedUserId = String(twitchUserId || '').trim();
  if (!channel || !normalizedUsername) throw new Error('A valid channel and Twitch username are required.');

  await purgeExpiredOptedOutProfiles(channel);
  const identityQuery = normalizedUserId
    ? { channelName: channel, $or: [{ twitchUserId: normalizedUserId }, { username: normalizedUsername }] }
    : { channelName: channel, username: normalizedUsername };
  let profile = await ViewerProfile.findOne(identityQuery);
  const existedBefore = Boolean(profile);
  if (!profile) profile = new ViewerProfile({ channelName: channel, username: normalizedUsername, firstSeenAt: new Date() });

  const now = new Date();
  const previousOptedOutAt = profile.optedOutAt ? new Date(profile.optedOutAt) : null;
  const withinRetention = Boolean(profile.optedOut === true && previousOptedOutAt && !profile.profileDataPurgedAt && (now.getTime() - previousOptedOutAt.getTime()) < OPT_OUT_RETENTION_MS);
  const canReactivate = Boolean(withinRetention && profile.profileRetainedOnOptOut === true);

  profile.username = normalizedUsername;
  profile.displayName = normalizedDisplayName;
  if (normalizedUserId) profile.twitchUserId = normalizedUserId;
  profile.lastSeenAt = now;

  if (optedOut) {
    if (profile.optedOut !== true) {
      profile.preOptOutEnabled = profile.enabled !== false;
      profile.preOptOutLearningEnabled = profile.learningEnabled !== false;
      profile.profileRetainedOnOptOut = existedBefore;
      profile.optedOutAt = now;
      profile.profileDataPurgedAt = null;
    }
    profile.optedOut = true;
    profile.enabled = false;
    profile.learningEnabled = false;
  } else {
    profile.optedOut = false;
    profile.optedOutAt = null;
    profile.profileDataPurgedAt = null;
    profile.enabled = canReactivate ? profile.preOptOutEnabled !== false : true;
    profile.learningEnabled = canReactivate ? profile.preOptOutLearningEnabled !== false : true;
    profile.profileRetainedOnOptOut = false;
  }

  await profile.save();
  return { profile: serializeProfile(profile), reactivated: !optedOut && canReactivate };
}

function normalizeCommandName(value) {
  const token = String(value || '').trim().split(/\s+/)[0].toLowerCase();
  if (!/^![a-z0-9_-]{1,79}$/.test(token)) return '';
  return token;
}

async function recordViewerCommandUsage(channelName, { username, displayName, twitchUserId = '', command, streamLive = false } = {}) {
  const channel = normalizeChannelName(channelName);
  const normalizedUsername = normalizeUsername(username);
  const normalizedDisplayName = normalizeDisplayName(displayName) || normalizedUsername;
  const normalizedUserId = String(twitchUserId || '').trim();
  const normalizedCommand = normalizeCommandName(command);
  if (!channel || !normalizedUsername || !normalizedCommand) return { recorded: false };

  const settings = await getViewerProfileSettings(channel);
  if (!settings.automaticLearningEnabled) return { recorded: false };
  await purgeExpiredOptedOutProfiles(channel);

  const excludedUsers = new Set([channel, 'sqwertarmybot', 'nightbot', 'streamelements', 'pokemoncommunitygame']);
  if (excludedUsers.has(normalizedUsername)) return { recorded: false };

  const identityQuery = normalizedUserId
    ? { channelName: channel, $or: [{ twitchUserId: normalizedUserId }, { username: normalizedUsername }] }
    : { channelName: channel, username: normalizedUsername };
  let profile = await ViewerProfile.findOne(identityQuery);
  if (profile?.optedOut === true || profile?.learningEnabled === false) return { recorded: false };

  if (!profile) {
    profile = new ViewerProfile({
      channelName: channel,
      username: normalizedUsername,
      displayName: normalizedDisplayName,
      twitchUserId: normalizedUserId || undefined,
      firstSeenAt: new Date()
    });
  }

  const now = new Date();
  profile.username = normalizedUsername;
  profile.displayName = normalizedDisplayName || profile.displayName || normalizedUsername;
  if (normalizedUserId) profile.twitchUserId = normalizedUserId;
  profile.lastSeenAt = now;
  if (!Array.isArray(profile.commandUsage)) profile.commandUsage = [];

  let usage = profile.commandUsage.find((entry) => String(entry.command || '').toLowerCase() === normalizedCommand);
  if (usage) {
    usage.count = Math.max(1, Number(usage.count || 1)) + 1;
    if (!streamLive) usage.offlineCount = Math.max(0, Number(usage.offlineCount || 0)) + 1;
    usage.lastUsedAt = now;
  } else {
    if (profile.commandUsage.length >= MAX_COMMAND_USAGE) {
      profile.commandUsage.sort((a, b) => Number(a.lastUsedAt || 0) - Number(b.lastUsedAt || 0));
      profile.commandUsage.shift();
    }
    profile.commandUsage.push({
      command: normalizedCommand,
      count: 1,
      offlineCount: streamLive ? 0 : 1,
      firstUsedAt: now,
      lastUsedAt: now
    });
  }

  await profile.save();
  return { recorded: true };
}

async function setFactEnabled(channelName, profileId, factId, enabled) {
  const channel = normalizeChannelName(channelName);
  const doc = await ViewerProfile.findOne({ channelName: channel, _id: profileId });
  if (!doc) throw new Error('Viewer profile not found.');
  if (doc.optedOut === true) throw new Error('This viewer opted out. Their retained profile cannot be edited until they use !optin.');
  const fact = doc.facts.id(factId);
  if (!fact) throw new Error('Viewer fact not found.');
  fact.enabled = Boolean(enabled);
  await doc.save();
  return serializeProfile(doc);
}

async function deleteViewerProfile(channelName, profileId) {
  const channel = normalizeChannelName(channelName);
  const existing = await ViewerProfile.findOne({ channelName: channel, _id: profileId }).lean();
  if (existing?.optedOut === true) {
    throw new Error('This viewer opted out. Their opt-out record must remain until they use !optin.');
  }
  const result = await ViewerProfile.deleteOne({ channelName: channel, _id: profileId });
  return { deleted: result.deletedCount > 0 };
}

function buildParticipantCounts(chatLogs = []) {
  const counts = new Map();
  const displayNames = new Map();
  for (const line of Array.isArray(chatLogs) ? chatLogs : []) {
    const match = String(line || '').match(/^([^:\n]{1,80}):\s+/);
    if (!match) continue;
    const displayName = match[1].trim();
    if (displayName.startsWith('[')) continue;
    const username = normalizeUsername(displayName);
    if (!username) continue;
    counts.set(username, (counts.get(username) || 0) + 1);
    if (!displayNames.has(username)) displayNames.set(username, displayName);
  }
  return { counts, displayNames };
}

function findSimilarFact(facts, text) {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!normalized) return null;
  return facts.find((fact) => {
    const candidate = String(fact.text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate);
  }) || null;
}

async function applyViewerProfileUpdates({ channelName, chatLogs = [], updates = [] }) {
  const settings = await getViewerProfileSettings(channelName);
  if (!settings.automaticLearningEnabled) return { applied: 0, skipped: 0 };
  const channel = normalizeChannelName(channelName);
  await purgeExpiredOptedOutProfiles(channel);
  const excludedUsers = new Set([channel, 'sqwertarmybot', 'nightbot', 'streamelements', 'pokemoncommunitygame']);
  const { counts, displayNames } = buildParticipantCounts(chatLogs);
  let applied = 0;
  let skipped = 0;

  for (const rawUpdate of Array.isArray(updates) ? updates : []) {
    const username = normalizeUsername(rawUpdate?.username);
    if (!username || excludedUsers.has(username) || !counts.has(username)) { skipped++; continue; }
    const existing = await ViewerProfile.findOne({ channelName: channel, username });
    if (!existing && (counts.get(username) || 0) < 2) { skipped++; continue; }
    if (existing?.optedOut === true || existing?.learningEnabled === false) { skipped++; continue; }

    const profile = existing || new ViewerProfile({
      channelName: channel,
      username,
      displayName: normalizeDisplayName(rawUpdate?.displayName) || displayNames.get(username) || username,
      firstSeenAt: new Date()
    });
    profile.displayName = normalizeDisplayName(rawUpdate?.displayName) || profile.displayName || displayNames.get(username) || username;
    profile.lastSeenAt = new Date();

    for (const observation of Array.isArray(rawUpdate?.observations) ? rawUpdate.observations : []) {
      const text = normalizeFactText(observation?.fact || observation?.text);
      if (!text) continue;
      const match = findSimilarFact(profile.facts, text);
      if (match) {
        match.evidenceCount = Math.max(1, Number(match.evidenceCount || 1)) + 1;
        match.lastObservedAt = new Date();
        const incoming = normalizeConfidence(observation?.confidence);
        if (incoming === 'high' || (incoming === 'medium' && match.confidence === 'low')) match.confidence = incoming;
      } else if (profile.facts.length < MAX_FACTS) {
        profile.facts.push({ text, confidence: normalizeConfidence(observation?.confidence), evidenceCount: 1, firstObservedAt: new Date(), lastObservedAt: new Date(), enabled: true });
      }
    }

    await profile.save();
    applied++;
  }
  return { applied, skipped };
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function profileMatchesQuestion(profile, question) {
  const q = String(question || '').toLowerCase();
  const candidates = [profile.username, profile.displayName, ...(profile.aliases || [])].map((v) => String(v || '').trim()).filter(Boolean);
  return candidates.some((candidate) => {
    const escaped = escapeRegExp(candidate.toLowerCase());
    return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(q);
  });
}

async function getRelevantViewerProfiles(channelName, question, limit = 4) {
  await purgeExpiredOptedOutProfiles(channelName);
  const settings = await getViewerProfileSettings(channelName);
  if (!settings.useInTaggedQuestions) return [];
  const channel = normalizeChannelName(channelName);
  const docs = await ViewerProfile.find({ channelName: channel, enabled: { $ne: false }, optedOut: { $ne: true } }).lean();
  return docs.filter((profile) => profileMatchesQuestion(profile, question)).slice(0, Math.max(1, Math.min(8, Number(limit) || 4))).map(serializeProfile);
}

function formatViewerProfilesForPrompt(profiles = []) {
  const active = Array.isArray(profiles) ? profiles : [];
  if (!active.length) return '';
  return active.map((profile) => {
    const facts = (profile.facts || []).filter((fact) => fact.enabled !== false).slice(0, 20);
    const commandUsage = (profile.commandUsage || [])
      .filter((entry) => Number(entry.count || 0) >= COMMAND_CONTEXT_MIN_COUNT)
      .sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
      .slice(0, 8);
    return [
      `VIEWER PROFILE — ${profile.displayName || profile.username} (@${profile.username})`,
      profile.aliases?.length ? `Aliases: ${profile.aliases.join(', ')}` : '',
      profile.pinnedNotes ? `Moderator-pinned notes:
${profile.pinnedNotes}` : '',
      facts.length ? `AI-learned observations:
${facts.map((fact) => `- ${fact.text} [${fact.confidence}; observed ${fact.evidenceCount}x]`).join('\n')}` : '',
      commandUsage.length ? `Observed command habits:
${commandUsage.map((entry) => {
        const count = Math.max(1, Number(entry.count || 1));
        const offlineCount = Math.max(0, Number(entry.offlineCount || 0));
        const offline = offlineCount ? `; ${offlineCount} while Qwert was offline` : '';
        return `- ${entry.command}: ${count} uses${offline}`;
      }).join('\n')}` : ''
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

module.exports = {
  MAX_ALIASES,
  MAX_PINNED_NOTES,
  MAX_FACTS,
  OPT_OUT_RETENTION_DAYS,
  OPT_OUT_RETENTION_MS,
  getViewerProfileSettings,
  saveViewerProfileSettings,
  listViewerProfiles,
  getViewerProfile,
  saveViewerProfile,
  setFactEnabled,
  deleteViewerProfile,
  setViewerProfileOptOut,
  recordViewerCommandUsage,
  purgeExpiredOptedOutProfiles,
  applyViewerProfileUpdates,
  getRelevantViewerProfiles,
  formatViewerProfilesForPrompt
};
