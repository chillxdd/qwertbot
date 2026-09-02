const ViewerProfile = require('../models/ViewerProfile');
const ViewerProfileSettings = require('../models/ViewerProfileSettings');
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

const MAX_ALIASES = 12;
const MAX_PINNED_NOTES = 4000;
const MAX_FACTS = 60;
const MAX_FACT_LENGTH = 400;
const MAX_COMMAND_USAGE = 30;
const COMMAND_CONTEXT_MIN_COUNT = 3;
const FAKE_COMMAND_BEHAVIOR_MIN_USES = 5;
const FAKE_COMMAND_BEHAVIOR_MIN_DISTINCT = 2;
const FAKE_COMMAND_BEHAVIOR_FACT = 'Frequently uses fake or unrecognized !commands in chat.';
const OPT_OUT_RETENTION_DAYS = 30;
const OPT_OUT_RETENTION_MS = OPT_OUT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const VIEWER_IDENTITY_POSITIVE_CACHE_MS = 6 * 60 * 60 * 1000;
const VIEWER_IDENTITY_NEGATIVE_CACHE_MS = 5 * 60 * 1000;
const viewerIdentityCache = new Map();

function normalizeChannelName(value) {
  return String(value || '').replace(/^#/, '').toLowerCase().trim();
}


function indexKeyMatches(index, expectedKey) {
  const key = index?.key || {};
  const actualEntries = Object.entries(key);
  const expectedEntries = Object.entries(expectedKey);
  if (actualEntries.length !== expectedEntries.length) return false;
  return expectedEntries.every(([name, value], idx) => {
    const actual = actualEntries[idx];
    return actual?.[0] === name && Number(actual?.[1]) === Number(value);
  });
}

function hasDesiredViewerUserIdPartialIndex(index) {
  if (!indexKeyMatches(index, { channelName: 1, twitchUserId: 1 })) return false;
  if (index?.unique !== true) return false;
  if (index?.sparse === true) return false;
  const filter = index?.partialFilterExpression || {};
  return filter?.twitchUserId?.$type === 'string';
}

async function ensureViewerProfileIndexes() {
  const collection = ViewerProfile.collection;
  let indexes = [];
  try {
    indexes = await collection.indexes();
  } catch (err) {
    // A brand-new collection may not exist until the first index/write. createIndex below is enough.
    if (err?.codeName !== 'NamespaceNotFound' && Number(err?.code) !== 26) throw err;
  }

  const userIdIndex = indexes.find((index) => indexKeyMatches(index, { channelName: 1, twitchUserId: 1 }));
  if (userIdIndex && !hasDesiredViewerUserIdPartialIndex(userIdIndex)) {
    await collection.dropIndex(userIdIndex.name);
    console.log(`[Viewer Profiles] Replaced legacy Twitch user-ID index ${userIdIndex.name}; null/missing IDs will no longer collide.`);
  }

  // Normalize legacy empty/null identity values before the new partial index is created.
  await collection.updateMany(
    { $or: [{ twitchUserId: null }, { twitchUserId: '' }] },
    { $unset: { twitchUserId: '' } }
  );

  await collection.createIndex(
    { channelName: 1, username: 1 },
    { unique: true, name: 'channelName_1_username_1' }
  );
  await collection.createIndex(
    { channelName: 1, twitchUserId: 1 },
    {
      unique: true,
      name: 'channelName_1_twitchUserId_1',
      partialFilterExpression: { twitchUserId: { $type: 'string' } }
    }
  );

  console.log('[Viewer Profiles] Identity indexes ready: username unique, Twitch user ID unique only when present.');
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

function mergeIdentityAliases(existingAliases, previousUsername, previousDisplayName, currentUsername, currentDisplayName) {
  const currentKeys = new Set([
    normalizeUsername(currentUsername),
    normalizeDisplayName(currentDisplayName).toLowerCase()
  ].filter(Boolean));
  const aliases = normalizeAliases(existingAliases).filter((alias) => !currentKeys.has(alias.toLowerCase()));

  for (const candidate of [previousUsername, previousDisplayName]) {
    const alias = String(candidate || '').replace(/^@+/, '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!alias || currentKeys.has(alias.toLowerCase())) continue;
    if (aliases.some((existing) => existing.toLowerCase() === alias.toLowerCase())) continue;
    if (aliases.length >= MAX_ALIASES) aliases.pop();
    aliases.push(alias);
  }
  return aliases;
}

function applyViewerIdentity(profile, { username, displayName, twitchUserId, now = new Date() } = {}) {
  if (!profile) return { changed: false, renamed: false, oldUsername: '', oldDisplayName: '' };
  const normalizedUsername = normalizeUsername(username);
  const normalizedDisplayName = normalizeDisplayName(displayName) || normalizedUsername;
  const normalizedUserId = String(twitchUserId || '').trim();
  if (!normalizedUsername) return { changed: false, renamed: false, oldUsername: '', oldDisplayName: '' };

  const oldUsername = normalizeUsername(profile.username);
  const oldDisplayName = normalizeDisplayName(profile.displayName) || oldUsername;
  const renamed = Boolean(oldUsername && oldUsername !== normalizedUsername);
  const displayChanged = Boolean(normalizedDisplayName && oldDisplayName !== normalizedDisplayName);
  const userIdChanged = Boolean(normalizedUserId && String(profile.twitchUserId || '') !== normalizedUserId);

  if (renamed && !profile.profileDataPurgedAt) {
    profile.aliases = mergeIdentityAliases(
      profile.aliases,
      oldUsername,
      oldDisplayName,
      normalizedUsername,
      normalizedDisplayName
    );
  } else if (Array.isArray(profile.aliases)) {
    const currentKeys = new Set([normalizedUsername, normalizedDisplayName.toLowerCase()].filter(Boolean));
    profile.aliases = normalizeAliases(profile.aliases).filter((alias) => !currentKeys.has(alias.toLowerCase()));
  }

  profile.username = normalizedUsername;
  profile.displayName = normalizedDisplayName;
  if (normalizedUserId) profile.twitchUserId = normalizedUserId;
  profile.lastSeenAt = now;

  return {
    changed: renamed || displayChanged || userIdChanged,
    renamed,
    oldUsername,
    oldDisplayName,
    username: normalizedUsername,
    displayName: normalizedDisplayName,
    twitchUserId: normalizedUserId
  };
}

async function syncViewerIdentity(channelName, { username, displayName, twitchUserId } = {}) {
  const channel = normalizeChannelName(channelName);
  const normalizedUsername = normalizeUsername(username);
  const normalizedDisplayName = normalizeDisplayName(displayName) || normalizedUsername;
  const normalizedUserId = String(twitchUserId || '').trim();
  if (!channel || !normalizedUsername || !normalizedUserId) {
    return { synced: false, profileFound: false, reason: 'missing_identity' };
  }

  const cacheKey = `${channel}:${normalizedUserId}`;
  const nowMs = Date.now();
  const cached = viewerIdentityCache.get(cacheKey) || null;
  const sameCachedIdentity = Boolean(
    cached &&
    cached.username === normalizedUsername &&
    cached.displayName === normalizedDisplayName
  );
  const cacheTtl = cached?.profileFound ? VIEWER_IDENTITY_POSITIVE_CACHE_MS : VIEWER_IDENTITY_NEGATIVE_CACHE_MS;
  if (sameCachedIdentity && (nowMs - Number(cached.checkedAt || 0)) < cacheTtl) {
    return { synced: false, cached: true, profileFound: cached.profileFound === true, renamed: false };
  }

  await purgeExpiredOptedOutProfiles(channel);

  // Twitch user ID is the canonical identity. Username is only the current mutable login.
  let profile = await ViewerProfile.findOne({ channelName: channel, twitchUserId: normalizedUserId });

  // Legacy profiles may predate twitchUserId storage. Bind them on their current username.
  if (!profile) {
    profile = await ViewerProfile.findOne({ channelName: channel, username: normalizedUsername });
  }

  // If this process previously saw the same Twitch user ID under an older login, that old
  // login is safe to use as a bridge for a legacy profile that still lacks twitchUserId.
  if (!profile && cached?.username && cached.username !== normalizedUsername) {
    profile = await ViewerProfile.findOne({
      channelName: channel,
      username: cached.username,
      $or: [
        { twitchUserId: normalizedUserId },
        { twitchUserId: { $exists: false } },
        { twitchUserId: null },
        { twitchUserId: '' }
      ]
    });
  }

  if (!profile) {
    viewerIdentityCache.set(cacheKey, {
      username: normalizedUsername,
      displayName: normalizedDisplayName,
      checkedAt: nowMs,
      profileFound: false
    });
    return { synced: false, profileFound: false, reason: 'no_profile' };
  }

  const storedUserId = String(profile.twitchUserId || '').trim();
  if (storedUserId && storedUserId !== normalizedUserId) {
    console.error(`[Viewer Profiles] Identity conflict for @${normalizedUsername}: profile has Twitch user ID ${storedUserId}, chat message has ${normalizedUserId}.`);
    viewerIdentityCache.set(cacheKey, {
      username: normalizedUsername,
      displayName: normalizedDisplayName,
      checkedAt: nowMs,
      profileFound: false
    });
    return { synced: false, profileFound: false, reason: 'user_id_conflict' };
  }

  const oldUsername = normalizeUsername(profile.username);
  if (oldUsername && oldUsername !== normalizedUsername) {
    const usernameConflict = await ViewerProfile.findOne({
      channelName: channel,
      username: normalizedUsername,
      _id: { $ne: profile._id }
    }).lean();

    if (usernameConflict) {
      const conflictingUserId = String(usernameConflict.twitchUserId || '').trim();
      // Never merge two records automatically when they can represent different Twitch accounts.
      // Keep the canonical user-ID profile intact, but add the current login as an alias so
      // Tagged Questions still resolve it while the conflict is visible in logs for manual review.
      if (!profile.profileDataPurgedAt) {
        profile.aliases = mergeIdentityAliases(
          profile.aliases,
          oldUsername,
          profile.displayName,
          oldUsername,
          profile.displayName
        );
        const currentAlias = normalizeAliases([normalizedUsername])[0];
        if (currentAlias && !profile.aliases.some((alias) => alias.toLowerCase() === currentAlias.toLowerCase())) {
          if (profile.aliases.length >= MAX_ALIASES) profile.aliases.pop();
          profile.aliases.push(currentAlias);
        }
      }
      profile.displayName = normalizedDisplayName;
      profile.twitchUserId = normalizedUserId;
      profile.lastSeenAt = new Date(nowMs);
      await profile.save();
      console.error(`[Viewer Profiles] Could not rename @${oldUsername} to @${normalizedUsername} because another profile already uses that username${conflictingUserId ? ` (Twitch user ID ${conflictingUserId})` : ''}. Current login was retained as an alias instead.`);
      viewerIdentityCache.set(cacheKey, {
        username: normalizedUsername,
        displayName: normalizedDisplayName,
        checkedAt: nowMs,
        profileFound: true
      });
      return { synced: true, profileFound: true, renamed: false, conflict: true };
    }
  }

  const identityResult = applyViewerIdentity(profile, {
    username: normalizedUsername,
    displayName: normalizedDisplayName,
    twitchUserId: normalizedUserId,
    now: new Date(nowMs)
  });
  await profile.save();

  if (identityResult.renamed) {
    console.log(`[Viewer Profiles] Twitch rename detected: @${identityResult.oldUsername} -> @${normalizedUsername} (user ID ${normalizedUserId}). Old username kept as an alias.`);
  }

  viewerIdentityCache.set(cacheKey, {
    username: normalizedUsername,
    displayName: normalizedDisplayName,
    checkedAt: nowMs,
    profileFound: true
  });

  return {
    synced: true,
    profileFound: true,
    renamed: identityResult.renamed,
    oldUsername: identityResult.oldUsername,
    username: normalizedUsername
  };
}

function normalizeFactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_LENGTH);
}

function inferFactApprovalStatus(fact) {
  if (fact?.approvalStatus === 'approved' || fact?.approvalStatus === 'pending') return fact.approvalStatus;
  // Existing AI facts were already active before approvalStatus existed; preserve them as approved.
  // Deterministic observations are code-derived and remain automatically approved.
  return 'approved';
}

const BULK_CONFIDENCE_RANK = Object.freeze({ low: 1, medium: 2, high: 3 });
const BULK_APPROVAL_SCOPES = new Set(['pending', 'approved', 'both']);

function normalizeBulkCleanupOptions(value = {}) {
  const maxConfidence = ['low', 'medium', 'high'].includes(String(value.maxConfidence || '').toLowerCase())
    ? String(value.maxConfidence).toLowerCase()
    : 'medium';
  const approvalScope = BULK_APPROVAL_SCOPES.has(String(value.approvalScope || '').toLowerCase())
    ? String(value.approvalScope).toLowerCase()
    : 'both';
  return { maxConfidence, approvalScope };
}

function factMatchesBulkCleanup(fact, options = {}) {
  const { maxConfidence, approvalScope } = normalizeBulkCleanupOptions(options);
  const status = inferFactApprovalStatus(fact);
  if (approvalScope !== 'both' && status !== approvalScope) return false;
  const rank = BULK_CONFIDENCE_RANK[normalizeConfidence(fact?.confidence)] || BULK_CONFIDENCE_RANK.medium;
  return rank <= BULK_CONFIDENCE_RANK[maxConfidence];
}

function refreshFactEvidenceSummary(fact) {
  if (!fact || fact.source === 'deterministic') return;
  fact.evidenceSummary = buildEvidenceSummary(fact);
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
      recognizedCount: Math.max(0, Number(entry.recognizedCount || 0)) || (Math.max(0, Number(entry.unrecognizedCount || 0)) === 0 ? Math.max(1, Number(entry.count || 1)) : 0),
      unrecognizedCount: Math.max(0, Number(entry.unrecognizedCount || 0)),
      firstUsedAt: entry.firstUsedAt || null,
      lastUsedAt: entry.lastUsedAt || null
    })),
    facts: (Array.isArray(value.facts) ? value.facts : []).map((fact) => ({
      id: String(fact._id || ''),
      text: String(fact.text || ''),
      confidence: normalizeConfidence(fact.confidence),
      evidenceCount: Math.max(1, Number(fact.evidenceCount || 1)),
      supportingWindowCount: Math.max(1, Number(fact.supportingWindowCount || 1)),
      contradictionCount: Math.max(0, Number(fact.contradictionCount || 0)),
      revisionCount: Math.max(0, Number(fact.revisionCount || 0)),
      kind: ['fact', 'preference', 'habit', 'behavior'].includes(fact.kind) ? fact.kind : 'fact',
      source: fact.source === 'deterministic' ? 'deterministic' : 'ai',
      approvalStatus: inferFactApprovalStatus(fact),
      evidenceSummary: String(fact.evidenceSummary || buildEvidenceSummary(fact)),
      firstObservedAt: fact.firstObservedAt || null,
      lastObservedAt: fact.lastObservedAt || null,
      lastRefinedAt: fact.lastRefinedAt || null,
      lastContradictedAt: fact.lastContradictedAt || null,
      revisionProposal: serializeRevisionProposal(fact.revisionProposal, { includeKind: true }),
      enabled: inferFactApprovalStatus(fact) === 'approved' && fact.enabled !== false
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
  let profile = null;
  if (normalizedUserId) {
    profile = await ViewerProfile.findOne({ channelName: channel, twitchUserId: normalizedUserId });
    if (!profile) {
      const usernameProfile = await ViewerProfile.findOne({ channelName: channel, username: normalizedUsername });
      const usernameProfileUserId = String(usernameProfile?.twitchUserId || '').trim();
      if (!usernameProfileUserId || usernameProfileUserId === normalizedUserId) profile = usernameProfile;
    }
  } else {
    profile = await ViewerProfile.findOne({ channelName: channel, username: normalizedUsername });
  }
  const existedBefore = Boolean(profile);
  if (!profile) profile = new ViewerProfile({ channelName: channel, username: normalizedUsername, firstSeenAt: new Date() });

  const now = new Date();
  const previousOptedOutAt = profile.optedOutAt ? new Date(profile.optedOutAt) : null;
  const withinRetention = Boolean(profile.optedOut === true && previousOptedOutAt && !profile.profileDataPurgedAt && (now.getTime() - previousOptedOutAt.getTime()) < OPT_OUT_RETENTION_MS);
  const canReactivate = Boolean(withinRetention && profile.profileRetainedOnOptOut === true);

  applyViewerIdentity(profile, {
    username: normalizedUsername,
    displayName: normalizedDisplayName,
    twitchUserId: normalizedUserId,
    now
  });

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

function getUnrecognizedCommandStats(profile) {
  const entries = Array.isArray(profile?.commandUsage) ? profile.commandUsage : [];
  const unrecognized = entries.map((entry) => ({
    command: String(entry.command || '').toLowerCase(),
    count: Math.max(0, Number(entry.unrecognizedCount || 0))
  })).filter((entry) => entry.command && entry.count > 0);
  return {
    total: unrecognized.reduce((sum, entry) => sum + entry.count, 0),
    distinct: unrecognized.length,
    top: unrecognized.sort((a, b) => b.count - a.count).slice(0, 5)
  };
}

function upsertFakeCommandBehaviorFact(profile, now = new Date()) {
  if (!profile || !Array.isArray(profile.facts)) return;
  const stats = getUnrecognizedCommandStats(profile);
  if (stats.total < FAKE_COMMAND_BEHAVIOR_MIN_USES || stats.distinct < FAKE_COMMAND_BEHAVIOR_MIN_DISTINCT) return;
  const confidence = stats.total >= 15 && stats.distinct >= 5 ? 'high' : 'medium';
  const evidenceSummary = `${stats.total} unrecognized !command uses across ${stats.distinct} distinct commands`;
  let fact = profile.facts.find((item) => item.source === 'deterministic' && String(item.text || '') === FAKE_COMMAND_BEHAVIOR_FACT);
  if (fact) {
    fact.kind = 'behavior';
    fact.source = 'deterministic';
    fact.approvalStatus = 'approved';
    fact.confidence = confidence;
    fact.evidenceCount = Math.max(Math.max(1, Number(fact.evidenceCount || 1)), stats.total);
    fact.evidenceSummary = evidenceSummary;
    fact.lastObservedAt = now;
    return;
  }
  if (profile.facts.length >= MAX_FACTS) return;
  profile.facts.push({
    text: FAKE_COMMAND_BEHAVIOR_FACT,
    kind: 'behavior',
    source: 'deterministic',
    approvalStatus: 'approved',
    confidence,
    evidenceCount: stats.total,
    evidenceSummary,
    firstObservedAt: now,
    lastObservedAt: now,
    enabled: true
  });
}

async function recordViewerCommandUsage(channelName, { username, displayName, twitchUserId = '', command, streamLive = false, recognized = true } = {}) {
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

  let profile = null;
  if (normalizedUserId) {
    profile = await ViewerProfile.findOne({ channelName: channel, twitchUserId: normalizedUserId });
    if (!profile) {
      const usernameProfile = await ViewerProfile.findOne({ channelName: channel, username: normalizedUsername });
      const usernameProfileUserId = String(usernameProfile?.twitchUserId || '').trim();
      if (!usernameProfileUserId || usernameProfileUserId === normalizedUserId) profile = usernameProfile;
    }
  } else {
    profile = await ViewerProfile.findOne({ channelName: channel, username: normalizedUsername });
  }
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
  applyViewerIdentity(profile, {
    username: normalizedUsername,
    displayName: normalizedDisplayName,
    twitchUserId: normalizedUserId,
    now
  });
  if (!Array.isArray(profile.commandUsage)) profile.commandUsage = [];

  let usage = profile.commandUsage.find((entry) => String(entry.command || '').toLowerCase() === normalizedCommand);
  if (usage) {
    const previousCount = Math.max(1, Number(usage.count || 1));
    let recognizedCount = Math.max(0, Number(usage.recognizedCount || 0));
    let unrecognizedCount = Math.max(0, Number(usage.unrecognizedCount || 0));
    if (recognizedCount + unrecognizedCount === 0) recognizedCount = previousCount;
    usage.count = previousCount + 1;
    if (recognized) recognizedCount++;
    else unrecognizedCount++;
    usage.recognizedCount = recognizedCount;
    usage.unrecognizedCount = unrecognizedCount;
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
      recognizedCount: recognized ? 1 : 0,
      unrecognizedCount: recognized ? 0 : 1,
      firstUsedAt: now,
      lastUsedAt: now
    });
  }

  upsertFakeCommandBehaviorFact(profile, now);

  await profile.save();
  return { recorded: true, recognized: Boolean(recognized) };
}

async function approveViewerFact(channelName, profileId, factId) {
  const channel = normalizeChannelName(channelName);
  const doc = await ViewerProfile.findOne({ channelName: channel, _id: profileId });
  if (!doc) throw new Error('Viewer profile not found.');
  if (doc.optedOut === true) throw new Error('This viewer opted out. Their retained profile cannot be edited until they use !optin.');
  const fact = doc.facts.id(factId);
  if (!fact) throw new Error('Viewer fact not found.');
  fact.approvalStatus = 'approved';
  fact.enabled = true;
  await doc.save();
  return serializeProfile(doc);
}

async function rejectViewerFact(channelName, profileId, factId) {
  const channel = normalizeChannelName(channelName);
  const doc = await ViewerProfile.findOne({ channelName: channel, _id: profileId });
  if (!doc) throw new Error('Viewer profile not found.');
  if (doc.optedOut === true) throw new Error('This viewer opted out. Their retained profile cannot be edited until they use !optin.');
  const fact = doc.facts.id(factId);
  if (!fact) throw new Error('Viewer fact not found.');
  if (inferFactApprovalStatus(fact) !== 'pending') throw new Error('Only pending observations can be rejected.');
  fact.deleteOne();
  await doc.save();
  return serializeProfile(doc);
}

async function acceptViewerFactRevision(channelName, profileId, factId) {
  const channel = normalizeChannelName(channelName);
  const doc = await ViewerProfile.findOne({ channelName: channel, _id: profileId });
  if (!doc) throw new Error('Viewer profile not found.');
  if (doc.optedOut === true) throw new Error('This viewer opted out. Their retained profile cannot be edited until they use !optin.');
  const fact = doc.facts.id(factId);
  if (!fact) throw new Error('Viewer fact not found.');
  if (inferFactApprovalStatus(fact) !== 'approved') throw new Error('Only approved observations can accept revisions.');
  if (fact.source === 'deterministic') throw new Error('Deterministic observations cannot be revised by AI.');
  const proposalText = normalizeFactText(fact.revisionProposal?.text);
  if (!proposalText) throw new Error('No AI revision is waiting for review.');
  if (containsPromptInjectionLanguage(proposalText)) throw new Error('The proposed revision failed the safety check.');
  acceptRevision(fact, { now: new Date(), includeKind: true });
  refreshFactEvidenceSummary(fact);
  await doc.save();
  return serializeProfile(doc);
}

async function dismissViewerFactRevision(channelName, profileId, factId) {
  const channel = normalizeChannelName(channelName);
  const doc = await ViewerProfile.findOne({ channelName: channel, _id: profileId });
  if (!doc) throw new Error('Viewer profile not found.');
  if (doc.optedOut === true) throw new Error('This viewer opted out. Their retained profile cannot be edited until they use !optin.');
  const fact = doc.facts.id(factId);
  if (!fact) throw new Error('Viewer fact not found.');
  if (inferFactApprovalStatus(fact) !== 'approved') throw new Error('Only approved observations can dismiss revisions.');
  dismissRevision(fact);
  refreshFactEvidenceSummary(fact);
  await doc.save();
  return serializeProfile(doc);
}

async function setFactEnabled(channelName, profileId, factId, enabled) {
  const channel = normalizeChannelName(channelName);
  const doc = await ViewerProfile.findOne({ channelName: channel, _id: profileId });
  if (!doc) throw new Error('Viewer profile not found.');
  if (doc.optedOut === true) throw new Error('This viewer opted out. Their retained profile cannot be edited until they use !optin.');
  const fact = doc.facts.id(factId);
  if (!fact) throw new Error('Viewer fact not found.');
  if (inferFactApprovalStatus(fact) !== 'approved') throw new Error('Approve this observation before toggling its use.');
  fact.approvalStatus = 'approved';
  fact.enabled = Boolean(enabled);
  await doc.save();
  return serializeProfile(doc);
}

async function deleteViewerFact(channelName, profileId, factId) {
  const channel = normalizeChannelName(channelName);
  const doc = await ViewerProfile.findOne({ channelName: channel, _id: profileId });
  if (!doc) throw new Error('Viewer profile not found.');
  if (doc.optedOut === true) throw new Error('This viewer opted out. Their retained profile cannot be edited until they use !optin.');
  const fact = doc.facts.id(factId);
  if (!fact) throw new Error('Viewer fact not found.');
  fact.deleteOne();
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

async function deleteViewerFactsByConfidence(channelName, options = {}) {
  const channel = normalizeChannelName(channelName);
  if (!channel) throw new Error('TWITCH_CHANNEL is not configured.');
  const normalized = normalizeBulkCleanupOptions(options);
  const docs = await ViewerProfile.find({ channelName: channel }, { facts: 1 }).lean();
  const operations = [];
  let deletedFacts = 0;
  let affectedProfiles = 0;

  for (const doc of docs) {
    const factIds = (Array.isArray(doc.facts) ? doc.facts : [])
      .filter((fact) => factMatchesBulkCleanup(fact, normalized))
      .map((fact) => fact?._id)
      .filter(Boolean);
    if (!factIds.length) continue;
    affectedProfiles += 1;
    deletedFacts += factIds.length;
    operations.push({
      updateOne: {
        filter: { _id: doc._id, channelName: channel },
        update: { $pull: { facts: { _id: { $in: factIds } } } }
      }
    });
  }

  if (operations.length) await ViewerProfile.bulkWrite(operations, { ordered: false });
  return { ...normalized, deletedFacts, affectedProfiles };
}

async function clearAllViewerProfiles(channelName) {
  const channel = normalizeChannelName(channelName);
  if (!channel) throw new Error('TWITCH_CHANNEL is not configured.');
  const now = new Date();

  // Opt-out records are intentionally preserved as minimal privacy tombstones so an
  // opted-out viewer cannot be silently recreated by automatic learning after a test wipe.
  const preserved = await ViewerProfile.updateMany(
    { channelName: channel, optedOut: true },
    { $set: {
      aliases: [],
      pinnedNotes: '',
      facts: [],
      commandUsage: [],
      profileDataPurgedAt: now,
      profileRetainedOnOptOut: false,
      preOptOutEnabled: false,
      preOptOutLearningEnabled: false,
      enabled: false,
      learningEnabled: false
    } }
  );
  const deleted = await ViewerProfile.deleteMany({ channelName: channel, optedOut: { $ne: true } });

  for (const key of viewerIdentityCache.keys()) {
    if (key.startsWith(`${channel}:`)) viewerIdentityCache.delete(key);
  }

  return {
    deletedProfiles: Number(deleted.deletedCount || 0),
    preservedOptOutRecords: Number(preserved.matchedCount || 0)
  };
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

function findSimilarFact(facts, text, kind = '') {
  const candidates = Array.isArray(facts) ? facts : [];
  return candidates.find((fact) => {
    if (!fact || fact.source === 'deterministic') return false;
    if (kind && fact.kind && fact.kind !== kind) return false;
    return textsRelated(fact.text, text, 0.58);
  }) || null;
}

async function getViewerLearningContext(channelName, chatLogs = []) {
  const channel = normalizeChannelName(channelName);
  if (!channel) return {};
  const { counts } = buildParticipantCounts(chatLogs);
  const usernames = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([username]) => username);
  if (!usernames.length) return {};

  const docs = await ViewerProfile.find({
    channelName: channel,
    username: { $in: usernames },
    optedOut: { $ne: true },
    learningEnabled: { $ne: false }
  }).lean();

  const context = {};
  for (const doc of docs) {
    const facts = (Array.isArray(doc?.facts) ? doc.facts : [])
      .filter((fact) => fact?.source !== 'deterministic' && String(fact?.text || '').trim())
      .sort((a, b) => new Date(b.lastObservedAt || b.firstObservedAt || 0).getTime() - new Date(a.lastObservedAt || a.firstObservedAt || 0).getTime())
      .slice(0, 12)
      .map((fact) => ({
        id: String(fact._id || ''),
        text: normalizeFactText(fact.text),
        kind: ['fact', 'preference', 'habit', 'behavior'].includes(fact.kind) ? fact.kind : 'fact',
        confidence: normalizeConfidence(fact.confidence),
        evidenceCount: Math.max(1, Number(fact.evidenceCount || 1)),
        supportingWindowCount: Math.max(1, Number(fact.supportingWindowCount || 1)),
        contradictionCount: Math.max(0, Number(fact.contradictionCount || 0)),
        approvalStatus: inferFactApprovalStatus(fact),
        enabled: inferFactApprovalStatus(fact) === 'approved' && fact.enabled !== false,
        revisionProposal: serializeRevisionProposal(fact.revisionProposal, { includeKind: true }),
        lastObservedAt: fact.lastObservedAt || fact.firstObservedAt || null
      }));
    context[String(doc.username || '').toLowerCase()] = {
      username: String(doc.username || '').toLowerCase(),
      displayName: String(doc.displayName || doc.username || ''),
      facts
    };
  }
  return context;
}

function resolveViewerFactMatch(profile, observation, text, kind) {
  const targetId = String(observation?.existingObservationId || observation?.targetId || '').trim();
  let match = null;
  if (targetId && profile?.facts?.id) {
    try { match = profile.facts.id(targetId); } catch (_) { match = null; }
  }
  if (match?.source === 'deterministic') match = null;
  if (!match && text) match = findSimilarFact(profile?.facts, text, kind);
  return match;
}

function normalizeRevisionReason(value) {
  const reason = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return containsPromptInjectionLanguage(reason) ? '' : reason;
}

async function applyViewerProfileUpdates({ channelName, chatLogs = [], updates = [] }) {
  const settings = await getViewerProfileSettings(channelName);
  if (!settings.automaticLearningEnabled) return { applied: 0, skipped: 0, created: 0, reinforced: 0, refined: 0, revisionsProposed: 0, contradictions: 0 };
  const channel = normalizeChannelName(channelName);
  await purgeExpiredOptedOutProfiles(channel);
  const excludedUsers = new Set([channel, 'sqwertarmybot', 'nightbot', 'streamelements', 'pokemoncommunitygame']);
  const { counts, displayNames } = buildParticipantCounts(chatLogs);
  const stats = { applied: 0, skipped: 0, created: 0, reinforced: 0, refined: 0, revisionsProposed: 0, contradictions: 0 };
  const relationPriority = { new: 0, support: 1, refine: 2, contradict: 3 };

  for (const rawUpdate of Array.isArray(updates) ? updates : []) {
    const username = normalizeUsername(rawUpdate?.username);
    if (!username || excludedUsers.has(username) || !counts.has(username)) { stats.skipped++; continue; }
    const existing = await ViewerProfile.findOne({ channelName: channel, username });
    if (existing?.optedOut === true || existing?.learningEnabled === false) { stats.skipped++; continue; }

    const profile = existing || new ViewerProfile({
      channelName: channel,
      username,
      displayName: normalizeDisplayName(rawUpdate?.displayName) || displayNames.get(username) || username,
      firstSeenAt: new Date()
    });
    const supportTouchedThisWindow = new Set();
    const proposalTouchedThisWindow = new Set();
    const contradictionTouchedThisWindow = new Set();
    let profileChanged = false;
    const observations = (Array.isArray(rawUpdate?.observations) ? [...rawUpdate.observations] : [])
      .sort((a, b) => (relationPriority[normalizeLearningRelation(a?.relation || a?.relationship)] ?? 0) - (relationPriority[normalizeLearningRelation(b?.relation || b?.relationship)] ?? 0));

    for (const observation of observations) {
      let relation = normalizeLearningRelation(observation?.relation || observation?.relationship);
      const text = normalizeFactText(observation?.fact || observation?.text || observation?.proposedText);
      const supportCount = Math.max(1, Math.min(6, Number(observation?.supportCount || 1)));
      const kind = ['fact', 'preference', 'habit', 'behavior'].includes(observation?.kind) ? observation.kind : 'fact';
      const confidence = normalizeConfidence(observation?.confidence);
      const reason = normalizeRevisionReason(observation?.reason);
      if (text && containsPromptInjectionLanguage(text)) { stats.skipped++; continue; }

      const match = resolveViewerFactMatch(profile, observation, text, kind);
      const now = new Date();
      if (match) {
        if (match.source === 'deterministic') { stats.skipped++; continue; }
        match.source = 'ai';
        if (!['approved', 'pending'].includes(match.approvalStatus)) match.approvalStatus = 'approved';
        match.kind = ['fact', 'preference', 'habit', 'behavior'].includes(match.kind) ? match.kind : kind;
        const status = inferFactApprovalStatus(match);
        const matchKey = String(match._id || match.id || match.text);

        if (relation === 'new') relation = text && !textsEquivalent(match.text, text) ? 'refine' : 'support';
        if (relation === 'support' || !text || textsEquivalent(match.text, text)) {
          const incrementWindow = !supportTouchedThisWindow.has(matchKey);
          supportTouchedThisWindow.add(matchKey);
          addSupportingEvidence(match, { supportCount, confidence, kind: match.kind }, { now, incrementWindow });
          refreshFactEvidenceSummary(match);
          stats.reinforced++;
          profileChanged = true;
          continue;
        }

        if (relation === 'contradict' && (match.kind === 'habit' || match.kind === 'behavior') && supportCount < 2) {
          // A recurring behavior should not be overturned by a single ambiguous message.
          stats.skipped++;
          continue;
        }

        if (status === 'pending') {
          const incrementWindow = !supportTouchedThisWindow.has(matchKey);
          supportTouchedThisWindow.add(matchKey);
          const result = applyPendingRevision(match, {
            relation,
            text,
            kind,
            confidence,
            supportCount,
            reason
          }, { now, includeKind: true, incrementWindow });
          refreshFactEvidenceSummary(match);
          if (result === 'reinforced') stats.reinforced++;
          else stats.refined++;
          if (relation === 'contradict') stats.contradictions++;
          profileChanged = true;
          continue;
        }

        if (relation === 'contradict') {
          const demote = !contradictionTouchedThisWindow.has(matchKey);
          contradictionTouchedThisWindow.add(matchKey);
          const incrementProposalWindow = !proposalTouchedThisWindow.has(matchKey);
          proposalTouchedThisWindow.add(matchKey);
          addContradictingEvidence(match, { supportCount, confidence, kind }, { now, demote });
          const proposed = mergeRevisionProposal(match, {
            relation,
            text,
            kind,
            confidence,
            supportCount,
            reason
          }, { now, includeKind: true, incrementWindow: incrementProposalWindow });
          refreshFactEvidenceSummary(match);
          stats.contradictions++;
          if (proposed) stats.revisionsProposed++;
          profileChanged = true;
          continue;
        }

        const incrementSupportWindow = !supportTouchedThisWindow.has(matchKey);
        supportTouchedThisWindow.add(matchKey);
        const incrementProposalWindow = !proposalTouchedThisWindow.has(matchKey);
        proposalTouchedThisWindow.add(matchKey);
        addSupportingEvidence(match, { supportCount, confidence, kind }, { now, incrementWindow: incrementSupportWindow });
        const proposed = mergeRevisionProposal(match, {
          relation: 'refine',
          text,
          kind,
          confidence,
          supportCount,
          reason
        }, { now, includeKind: true, incrementWindow: incrementProposalWindow });
        refreshFactEvidenceSummary(match);
        if (proposed) stats.revisionsProposed++;
        else stats.reinforced++;
        profileChanged = true;
      } else if (relation === 'new' && text && profile.facts.length < MAX_FACTS) {
        profile.facts.push({
          text,
          kind,
          source: 'ai',
          approvalStatus: 'pending',
          confidence,
          evidenceCount: supportCount,
          supportingWindowCount: 1,
          contradictionCount: 0,
          revisionCount: 0,
          evidenceSummary: `Supported by ${supportCount} source-chat message${supportCount === 1 ? '' : 's'} across 1 learning window.`,
          firstObservedAt: now,
          lastObservedAt: now,
          enabled: false
        });
        const created = profile.facts[profile.facts.length - 1];
        supportTouchedThisWindow.add(String(created?._id || created?.id || created?.text || text));
        stats.created++;
        profileChanged = true;
      } else {
        stats.skipped++;
      }
    }

    // Do not persist empty profiles merely because the AI returned an unusable candidate.
    if (!profileChanged) continue;
    profile.displayName = normalizeDisplayName(rawUpdate?.displayName) || profile.displayName || displayNames.get(username) || username;
    profile.lastSeenAt = new Date();
    await profile.save();
    stats.applied++;
  }
  return stats;
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
    const facts = (profile.facts || []).filter((fact) => inferFactApprovalStatus(fact) === 'approved' && fact.enabled !== false).slice(0, 20);
    const commandUsage = (profile.commandUsage || []).map((entry) => {
      const total = Math.max(1, Number(entry.count || 1));
      const unrecognizedCount = Math.max(0, Number(entry.unrecognizedCount || 0));
      const recognizedCount = Math.max(0, Number(entry.recognizedCount || 0)) || (unrecognizedCount === 0 ? total : 0);
      return { ...entry, recognizedCount, unrecognizedCount };
    });
    const recognizedHabits = commandUsage
      .filter((entry) => entry.recognizedCount >= COMMAND_CONTEXT_MIN_COUNT)
      .sort((a, b) => b.recognizedCount - a.recognizedCount)
      .slice(0, 8);
    const fakeEntries = commandUsage.filter((entry) => entry.unrecognizedCount > 0).sort((a, b) => b.unrecognizedCount - a.unrecognizedCount);
    const fakeTotal = fakeEntries.reduce((sum, entry) => sum + entry.unrecognizedCount, 0);
    const fakeDistinct = fakeEntries.length;
    return [
      `VIEWER PROFILE — ${profile.displayName || profile.username} (@${profile.username})`,
      profile.aliases?.length ? `Aliases: ${profile.aliases.join(', ')}` : '',
      profile.pinnedNotes ? `Moderator-pinned notes:\n${profile.pinnedNotes}` : '',
      facts.length ? `Learned observations:\n${facts.map((fact) => `- ${fact.text} [${fact.kind || 'fact'}; ${fact.confidence}; evidence ${fact.evidenceCount}x; ${fact.source || 'ai'}]`).join('\n')}` : '',
      recognizedHabits.length ? `Observed recognized-command habits:\n${recognizedHabits.map((entry) => {
        const offlineCount = Math.max(0, Number(entry.offlineCount || 0));
        const offline = offlineCount ? `; ${offlineCount} total command uses while Qwert was offline` : '';
        return `- ${entry.command}: ${entry.recognizedCount} recognized uses${offline}`;
      }).join('\n')}` : '',
      fakeTotal >= FAKE_COMMAND_BEHAVIOR_MIN_USES && fakeDistinct >= FAKE_COMMAND_BEHAVIOR_MIN_DISTINCT
        ? `Observed fake/unrecognized command behavior:\n- ${fakeTotal} unrecognized !command uses across ${fakeDistinct} distinct commands${fakeEntries.length ? `; examples: ${fakeEntries.slice(0, 5).map((entry) => `${entry.command} (${entry.unrecognizedCount})`).join(', ')}` : ''}`
        : ''
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

module.exports = {
  MAX_ALIASES,
  MAX_PINNED_NOTES,
  MAX_FACTS,
  OPT_OUT_RETENTION_DAYS,
  OPT_OUT_RETENTION_MS,
  ensureViewerProfileIndexes,
  getViewerProfileSettings,
  saveViewerProfileSettings,
  listViewerProfiles,
  getViewerProfile,
  saveViewerProfile,
  approveViewerFact,
  rejectViewerFact,
  acceptViewerFactRevision,
  dismissViewerFactRevision,
  setFactEnabled,
  deleteViewerFact,
  deleteViewerProfile,
  deleteViewerFactsByConfidence,
  clearAllViewerProfiles,
  setViewerProfileOptOut,
  syncViewerIdentity,
  recordViewerCommandUsage,
  purgeExpiredOptedOutProfiles,
  getViewerLearningContext,
  applyViewerProfileUpdates,
  getRelevantViewerProfiles,
  formatViewerProfilesForPrompt
};
