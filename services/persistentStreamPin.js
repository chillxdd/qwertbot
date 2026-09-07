const { createHash } = require('node:crypto');
const context = require('./reliability/context');
const delivery = require('./reliability/delivery');
const { createSerialExecutor } = require('./reliability/serialWriter');
const { WRITE_OPTIONS } = require('./reliability/store');
const PersistentPinConfig = require('../models/PersistentPinConfig');

const MAX_PERSISTENT_PIN_MESSAGE_LENGTH = 500;
const MAX_PERSISTENT_PIN_MESSAGES = 10;
const DEFAULT_PERSISTENT_PIN_ROTATION_SECONDS = 180;
const MIN_PERSISTENT_PIN_ROTATION_SECONDS = 30;
const MAX_PERSISTENT_PIN_ROTATION_SECONDS = 1800;
const DEFAULT_PERSISTENT_PIN_HOLD_SECONDS = 10;
const MAX_PERSISTENT_PIN_HOLD_SECONDS = 3600;
const PERSISTENT_PIN_MONITOR_INTERVAL_MS = 15000;
const OWN_RESPONSE_TTL_MS = 15000;
const MONITOR_ERROR_LOG_INTERVAL_MS = 2 * 60 * 1000;
const MIN_RESTORE_SECONDS = 30; // Twitch's pin API minimum duration.

function sleep(ms) {
  return context.sleep(ms);
}

function normalizeMessage(value) {
  return Array.from(String(value || '').trim()).slice(0, MAX_PERSISTENT_PIN_MESSAGE_LENGTH).join('');
}

function normalizeRotationSeconds(value, fallback = DEFAULT_PERSISTENT_PIN_ROTATION_SECONDS) {
  const raw = value === undefined || value === null || value === '' ? fallback : Number(value);
  const seconds = Math.round(raw);
  if (!Number.isFinite(seconds) || seconds < MIN_PERSISTENT_PIN_ROTATION_SECONDS || seconds > MAX_PERSISTENT_PIN_ROTATION_SECONDS) {
    throw new Error(`Rotating Pinned Banners global duration must be between ${MIN_PERSISTENT_PIN_ROTATION_SECONDS} and ${MAX_PERSISTENT_PIN_ROTATION_SECONDS} seconds.`);
  }
  return seconds;
}

function normalizeBannerOverrideSeconds(value, globalSeconds) {
  if (value === undefined || value === null || value === '') return 0;
  const raw = Number(value);
  if (!Number.isFinite(raw)) throw new Error('Banner-specific duration must be a number or left blank.');
  const seconds = Math.round(raw);
  if (seconds < 0 || seconds > MAX_PERSISTENT_PIN_ROTATION_SECONDS) {
    throw new Error(`Banner-specific duration must be blank or between 0 and ${MAX_PERSISTENT_PIN_ROTATION_SECONDS} seconds.`);
  }
  // An override only exists to make one banner stand out for longer. Values at
  // or below the global duration intentionally collapse back to "use global".
  return seconds > globalSeconds ? seconds : 0;
}

function normalizeHoldSeconds(value, fallback = DEFAULT_PERSISTENT_PIN_HOLD_SECONDS) {
  const raw = value === undefined || value === null || value === '' ? fallback : Number(value);
  const seconds = Math.round(raw);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_PERSISTENT_PIN_HOLD_SECONDS) {
    throw new Error(`Rotating Pinned Banners hold must be between 0 and ${MAX_PERSISTENT_PIN_HOLD_SECONDS} seconds.`);
  }
  return seconds;
}

function normalizeBanners(input = {}, globalSeconds = normalizeRotationSeconds(input.rotationSeconds)) {
  let rawRows;
  if (Array.isArray(input.banners)) {
    rawRows = input.banners;
  } else {
    const messages = Array.isArray(input.messages)
      ? input.messages
      : (String(input.message || '').trim() ? [input.message] : []);
    const enabled = Array.isArray(input.bannerEnabled) ? input.bannerEnabled : [];
    const durations = Array.isArray(input.bannerDurations) ? input.bannerDurations : [];
    rawRows = messages.map((message, index) => ({
      message,
      enabled: enabled[index] !== false,
      durationSeconds: durations[index] ?? 0
    }));
  }

  return rawRows
    .slice(0, MAX_PERSISTENT_PIN_MESSAGES)
    .map((row) => ({
      message: normalizeMessage(row?.message ?? row),
      enabled: row?.enabled !== false,
      durationSeconds: normalizeBannerOverrideSeconds(row?.durationSeconds ?? 0, globalSeconds)
    }))
    .filter((row) => row.message);
}

function normalizeConfig(input = {}) {
  const rotationSeconds = normalizeRotationSeconds(input.rotationSeconds);
  const banners = normalizeBanners(input, rotationSeconds);
  return {
    enabled: input.enabled === true,
    message: banners[0]?.message || '',
    messages: banners.map((row) => row.message),
    bannerEnabled: banners.map((row) => row.enabled !== false),
    bannerDurations: banners.map((row) => row.durationSeconds || 0),
    rotationSeconds,
    startupHoldSeconds: normalizeHoldSeconds(input.startupHoldSeconds)
  };
}

function normalizeMessageIds(value, count) {
  const ids = Array.isArray(value) ? value.map((item) => String(item || '').trim()) : [];
  while (ids.length < count) ids.push('');
  return ids.slice(0, count);
}

function clampIndex(value, count) {
  if (!count) return 0;
  const number = Number.isInteger(Number(value)) ? Number(value) : 0;
  return ((number % count) + count) % count;
}

function resolveEnabledIndex(rows, value) {
  if (!rows.length) return 0;
  const start = clampIndex(value, rows.length);
  if (rows[start]?.enabled !== false) return start;
  for (let offset = 1; offset <= rows.length; offset += 1) {
    const index = (start + offset) % rows.length;
    if (rows[index]?.enabled !== false) return index;
  }
  return start;
}

function nextEnabledIndex(rows, value) {
  if (!rows.length) return 0;
  const start = clampIndex(value, rows.length);
  for (let offset = 1; offset <= rows.length; offset += 1) {
    const index = (start + offset) % rows.length;
    if (rows[index]?.enabled !== false) return index;
  }
  return start;
}

function createPersistentPinManager({
  channelName,
  sendMessageViaApi,
  getPinnedChatMessage,
  pinChatMessage,
  unpinChatMessage,
  beginPriorityAutomationHold = null,
  endPriorityAutomationHold = null,
  getStreamStatus = null
}) {
  const normalizedChannel = String(channelName || '').toLowerCase().trim();
  let config = {
    channelName: normalizedChannel,
    enabled: false,
    message: '',
    messages: [],
    bannerEnabled: [],
    bannerDurations: [],
    rotationSeconds: DEFAULT_PERSISTENT_PIN_ROTATION_SECONDS,
    startupHoldSeconds: DEFAULT_PERSISTENT_PIN_HOLD_SECONDS,
    activeStreamId: '',
    activeMessageId: '',
    activeMessageIds: [],
    activeBannerIndex: 0,
    bannerEndsAt: null,
    lastPinnedAt: null
  };
  const serializeControls = createSerialExecutor();
  let configChanging = false;
  let operationBusy = false;
  let stopping = false;
  let activeController = null;
  const fenceFilter = () => ({ $or: [{ schedulerFence: { $exists: false } }, { schedulerFence: { $lte: context.fence() } }] });
  let monitorTimer = null;
  let rotationTimer = null;
  let monitorBusy = false;
  let monitorStreamId = '';
  let displacedByMessageId = '';
  let lastMonitorErrorLogAt = 0;
  const ownResponses = [];

  function configuredBanners() {
    const globalSeconds = normalizeRotationSeconds(config.rotationSeconds);
    return normalizeBanners(config, globalSeconds);
  }

  function configuredMessages() {
    return configuredBanners().map((row) => row.message);
  }

  function enabledBanners() {
    return configuredBanners().filter((row) => row.enabled !== false);
  }

  function hasSingleEnabledBanner() {
    return enabledBanners().length === 1;
  }

  function configuredMessageIds() {
    return normalizeMessageIds(config.activeMessageIds, configuredBanners().length);
  }

  function currentIndex() {
    const rows = configuredBanners();
    return resolveEnabledIndex(rows, config.activeBannerIndex);
  }

  function nextIndex(index = currentIndex()) {
    return nextEnabledIndex(configuredBanners(), index);
  }

  function effectiveDuration(index = currentIndex()) {
    const rows = configuredBanners();
    const banner = rows[clampIndex(index, rows.length)] || null;
    const globalSeconds = normalizeRotationSeconds(config.rotationSeconds);
    return banner?.durationSeconds > globalSeconds ? banner.durationSeconds : globalSeconds;
  }

  function currentMessageId() {
    const ids = configuredMessageIds();
    return ids[currentIndex()] || String(config.activeMessageId || '').trim();
  }

  function cleanupOwnResponses() {
    const cutoff = Date.now() - OWN_RESPONSE_TTL_MS;
    while (ownResponses.length && ownResponses[0].createdAt < cutoff) ownResponses.shift();
  }

  function noteOwnResponse(message) {
    cleanupOwnResponses();
    ownResponses.push({ message: String(message || '').trim(), createdAt: Date.now() });
  }

  function consumeOwnResponse(message) {
    cleanupOwnResponses();
    const normalized = String(message || '').trim();
    const index = ownResponses.findIndex((entry) => entry.message === normalized);
    if (index === -1) return false;
    ownResponses.splice(index, 1);
    return true;
  }

  function toClient() {
    const banners = configuredBanners();
    const globalSeconds = normalizeRotationSeconds(config.rotationSeconds);
    return {
      recoveryRequired: config.recoveryRequired === true,
      recoveryReason: config.recoveryReason || '',
      deliveryKey: config.deliveryKey || '',
      skippedForStream: Boolean(config.skipStreamId && config.skipStreamId === config.activeStreamId),
      enabled: config.enabled === true,
      message: banners[0]?.message || '',
      messages: banners.map((row) => row.message),
      bannerEnabled: banners.map((row) => row.enabled !== false),
      bannerDurations: banners.map((row) => row.durationSeconds || 0),
      banners: banners.map((row) => ({
        message: row.message,
        enabled: row.enabled !== false,
        durationSeconds: row.durationSeconds > globalSeconds ? row.durationSeconds : null,
        effectiveDurationSeconds: row.durationSeconds > globalSeconds ? row.durationSeconds : globalSeconds
      })),
      rotationSeconds: globalSeconds,
      startupHoldSeconds: normalizeHoldSeconds(config.startupHoldSeconds),
      activeStreamId: String(config.activeStreamId || ''),
      activeMessageId: String(config.activeMessageId || ''),
      activeMessageIds: configuredMessageIds(),
      activeBannerIndex: currentIndex(),
      bannerEndsAt: config.bannerEndsAt || null,
      lastPinnedAt: config.lastPinnedAt || null,
      monitorActive: Boolean(monitorTimer)
    };
  }

  function streamStatus() {
    try {
      const status = typeof getStreamStatus === 'function' ? (getStreamStatus() || {}) : {};
      return {
        live: status.streamLive !== undefined ? Boolean(status.streamLive) : Boolean(status.live),
        streamId: String(status.currentStreamId || status.streamId || '').trim()
      };
    } catch (_) {
      return { live: false, streamId: '' };
    }
  }

  function normalizeStored(stored = {}) {
    const normalized = normalizeConfig(stored);
    const rows = normalizeBanners(normalized, normalized.rotationSeconds);
    const index = resolveEnabledIndex(rows, stored.activeBannerIndex);
    const ids = normalizeMessageIds(stored.activeMessageIds, rows.length);
    if (stored.activeMessageId && rows.length && !ids[index]) ids[index] = String(stored.activeMessageId || '').trim();
    return {
      ...stored,
      ...normalized,
      activeMessageIds: ids,
      activeBannerIndex: index,
      activeMessageId: ids[index] || String(stored.activeMessageId || '').trim(),
      bannerEndsAt: stored.bannerEndsAt || null
    };
  }

  async function initialize() {
    stopping = false;
    await context.assertOperation();
    await PersistentPinConfig.updateOne({ channelName: normalizedChannel, ...fenceFilter() },
      { $set: { schedulerFence: context.fence() } }, WRITE_OPTIONS);
    const stored = await PersistentPinConfig.findOne({ channelName: normalizedChannel }).lean();
    if (stored) {
      config = { ...config, ...normalizeStored(stored) };
      const needsMigration = ((!Array.isArray(stored.messages) || !stored.messages.length) && String(stored.message || '').trim())
        || !Array.isArray(stored.bannerEnabled) || stored.bannerEnabled.length !== config.messages.length
        || !Array.isArray(stored.bannerDurations) || stored.bannerDurations.length !== config.messages.length;
      if (needsMigration) {
        await PersistentPinConfig.updateOne({ channelName: normalizedChannel, ...fenceFilter() }, {
          $set: {
            messages: config.messages,
            bannerEnabled: config.bannerEnabled,
            bannerDurations: config.bannerDurations,
            rotationSeconds: config.rotationSeconds,
            activeMessageIds: config.activeMessageIds,
            activeBannerIndex: config.activeBannerIndex,
            schedulerFence: context.fence()
          }
        }, WRITE_OPTIONS);
      }
    } else {
      const created = await PersistentPinConfig.findOneAndUpdate(
        { channelName: normalizedChannel },
        {
          $setOnInsert: {
            channelName: normalizedChannel,
            enabled: false,
            message: '',
            messages: [],
            bannerEnabled: [],
            bannerDurations: [],
            rotationSeconds: DEFAULT_PERSISTENT_PIN_ROTATION_SECONDS,
            startupHoldSeconds: DEFAULT_PERSISTENT_PIN_HOLD_SECONDS
          }
        },
        { ...WRITE_OPTIONS, new: true, upsert: true, setDefaultsOnInsert: true }
      ).lean();
      config = { ...config, ...normalizeStored(created || {}) };
    }
    console.log(`[Persistent Pin] ${config.enabled ? 'Enabled' : 'Disabled'}; ${enabledBanners().length}/${configuredBanners().length} banner(s) active, ${config.rotationSeconds}s global duration; post-pin automation hold ${config.startupHoldSeconds}s.`);
    return toClient();
  }

  async function persistRuntime(patch = {}) {
    await context.assertOperation();
    const result = await PersistentPinConfig.updateOne({ channelName: normalizedChannel, ...fenceFilter() },
      { $set: { ...patch, schedulerFence: context.fence() } }, WRITE_OPTIONS);
    if (result.matchedCount !== 1) throw context.cancelledError('Rotating pinned banner settings changed on another deployment.');
    config = { ...config, ...patch };
  }

  async function persistEnabled(enabled) {
    await persistRuntime({ enabled: enabled === true });
    if (!enabled) stopMonitor();
  }

  function stopRotationTimer() {
    if (rotationTimer) clearTimeout(rotationTimer);
    rotationTimer = null;
  }

  function scheduleRotationTimer() {
    stopRotationTimer();
    if (stopping || !context.isActive() || !config.enabled || config.recoveryRequired || !enabledBanners().length || !config.bannerEndsAt) return;
    const endsAtMs = Date.parse(config.bannerEndsAt);
    if (!Number.isFinite(endsAtMs)) return;
    const delay = Math.max(100, endsAtMs - Date.now() + 50);
    rotationTimer = context.detached(() => setTimeout(() => {
      rotationTimer = null;
      void reconcileNow('rotation_timer').catch((err) => console.warn('[Persistent Pin] Banner rotation failed:', err?.message || err));
    }, delay));
  }

  function stopMonitor() {
    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = null;
    monitorStreamId = '';
    displacedByMessageId = '';
    stopRotationTimer();
  }

  function startMonitor(streamId = '') {
    monitorStreamId = String(streamId || monitorStreamId || config.activeStreamId || '').trim();
    if (stopping || !context.isActive() || config.recoveryRequired || (config.skipStreamId && config.skipStreamId === monitorStreamId) || monitorTimer || !config.enabled || !enabledBanners().length) return;
    monitorTimer = context.detached(() => setInterval(() => {
      void monitorTick().catch((err) => console.warn('[Persistent Pin] Monitor failed:', err.message));
    }, PERSISTENT_PIN_MONITOR_INTERVAL_MS));
    scheduleRotationTimer();
    console.log(`[Persistent Pin] Banner monitor active (checks every ${Math.round(PERSISTENT_PIN_MONITOR_INTERVAL_MS / 1000)}s).`);
  }

  async function saveConfig(input = {}) {
    await context.assertOperation();
    stopMonitor();
    activeController?.abort();
    while (operationBusy) await sleep(50);

    const candidateRows = Array.isArray(input.banners)
      ? input.banners
      : (Array.isArray(input.messages)
        ? input.messages.map((message, index) => ({
          message,
          enabled: Array.isArray(input.bannerEnabled) ? input.bannerEnabled[index] !== false : true,
          durationSeconds: Array.isArray(input.bannerDurations) ? input.bannerDurations[index] : 0
        }))
        : (String(input.message || '').trim() ? [{ message: input.message, enabled: true, durationSeconds: 0 }] : []));
    // When the whole feature is disabled, an empty editor row is just a UI
    // placeholder and is not persisted as a banner.
    const rawRows = input.enabled === true
      ? candidateRows
      : candidateRows.filter((row) => String(row?.message ?? row ?? '').trim());

    if (rawRows.length > MAX_PERSISTENT_PIN_MESSAGES) {
      throw new Error(`Rotating Pinned Banners supports at most ${MAX_PERSISTENT_PIN_MESSAGES} banners.`);
    }
    rawRows.forEach((row, index) => {
      const rawMessage = String(row?.message ?? row ?? '').trim();
      if (!rawMessage) throw new Error(`Banner ${index + 1} needs a message, or remove that banner.`);
      if (Array.from(rawMessage).length > MAX_PERSISTENT_PIN_MESSAGE_LENGTH) {
        throw new Error(`Banner ${index + 1} exceeds ${MAX_PERSISTENT_PIN_MESSAGE_LENGTH} characters.`);
      }
    });

    const next = normalizeConfig({ ...input, banners: rawRows });
    const nextRows = normalizeBanners(next, next.rotationSeconds);
    if (next.enabled && !nextRows.some((row) => row.enabled !== false)) {
      throw new Error('Enable at least one banner before enabling Rotating Pinned Banners.');
    }

    const previousEnabled = config.enabled === true;
    const previousRows = configuredBanners();
    const previousIdsArray = configuredMessageIds();
    const previousIds = new Set(previousIdsArray.filter(Boolean));
    const previousCurrentIndex = currentIndex();
    const previousCurrentDuration = effectiveDuration(previousCurrentIndex);
    const previousEnabledCount = previousRows.filter((row) => row.enabled !== false).length;
    const nextEnabledCount = nextRows.filter((row) => row.enabled !== false).length;
    const singleBannerModeChanged = (previousEnabledCount === 1) !== (nextEnabledCount === 1);
    const messagesChanged = JSON.stringify(next.messages) !== JSON.stringify(previousRows.map((row) => row.message));
    const enabledChanged = JSON.stringify(next.bannerEnabled) !== JSON.stringify(previousRows.map((row) => row.enabled !== false));
    const bannerDurationsChanged = JSON.stringify(next.bannerDurations) !== JSON.stringify(previousRows.map((row) => row.durationSeconds || 0));
    const globalDurationChanged = next.rotationSeconds !== normalizeRotationSeconds(config.rotationSeconds);
    const settingsChanged = messagesChanged || enabledChanged || bannerDurationsChanged || globalDurationChanged;

    const update = { ...next };
    if (messagesChanged) {
      if (config.recoveryRequired) throw new Error('Resolve the pending pinned-banner delivery before replacing its text.');
      update.activeMessageId = '';
      update.activeMessageIds = Array(nextRows.length).fill('');
      update.activeBannerIndex = resolveEnabledIndex(nextRows, 0);
      update.bannerEndsAt = null;
      update.postGeneration = 0;
      update.skipStreamId = '';
    } else {
      update.activeMessageIds = normalizeMessageIds(config.activeMessageIds, nextRows.length);
      update.activeBannerIndex = resolveEnabledIndex(nextRows, config.activeBannerIndex);
      update.activeMessageId = update.activeMessageIds[update.activeBannerIndex] || '';
      const nextGlobal = next.rotationSeconds;
      const nextBanner = nextRows[update.activeBannerIndex] || null;
      const nextCurrentDuration = nextBanner?.durationSeconds > nextGlobal ? nextBanner.durationSeconds : nextGlobal;
      if (singleBannerModeChanged || update.activeBannerIndex !== previousCurrentIndex || nextCurrentDuration !== previousCurrentDuration) update.bannerEndsAt = null;
    }
    update.schedulerFence = context.fence();

    configChanging = true;
    try {
      const saved = await PersistentPinConfig.findOneAndUpdate(
        { channelName: normalizedChannel, ...fenceFilter() },
        { $set: update, $setOnInsert: { channelName: normalizedChannel } },
        { ...WRITE_OPTIONS, new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
      ).lean();
      config = { ...config, ...normalizeStored(saved || {}) };
    } finally {
      configChanging = false;
    }

    if (!config.enabled) {
      stopMonitor();
      if (previousEnabled && previousIds.size && typeof getPinnedChatMessage === 'function' && typeof unpinChatMessage === 'function') {
        try {
          const current = await getPinnedChatMessage();
          const currentId = String(current?.message_id || '').trim();
          if (previousIds.has(currentId)) await unpinChatMessage(currentId);
        } catch (err) {
          console.warn('[Persistent Pin] Settings disabled, but the current banner could not be checked/removed:', err?.message || err);
        }
      }
    } else {
      const status = streamStatus();
      if (status.live) {
        if (status.streamId && status.streamId !== String(config.activeStreamId || '')) {
          await resetForStream(status.streamId);
        }
        startMonitor(status.streamId || config.activeStreamId || '');
        if (settingsChanged || !previousEnabled) {
          try {
            const current = typeof getPinnedChatMessage === 'function' ? await getPinnedChatMessage() : null;
            const currentId = String(current?.message_id || '').trim();
            if (messagesChanged && previousIds.has(currentId) && typeof unpinChatMessage === 'function') {
              await unpinChatMessage(currentId);
            }
            await reconcileNow('settings_update');
          } catch (err) {
            console.warn('[Persistent Pin] Saved settings, but the live banner could not be refreshed yet:', err?.message || err);
          }
        }
      }
    }

    console.log(`[Persistent Pin] Settings saved (${config.enabled ? 'enabled' : 'disabled'}; ${enabledBanners().length}/${configuredBanners().length} banner(s) active; ${config.rotationSeconds}s global duration; hold ${config.startupHoldSeconds}s).`);
    return toClient();
  }

  async function postFreshConfiguredMessage(streamId = '', bannerIndex = currentIndex()) {
    await context.assertOperation();
    if (typeof sendMessageViaApi !== 'function') throw new Error('Twitch Chat API sender is unavailable.');
    const messages = configuredMessages();
    const index = clampIndex(bannerIndex, messages.length);
    const message = messages[index] || '';
    if (!message) throw new Error('Rotating pinned banner message is not configured.');
    if (config.recoveryRequired) throw new Error('Rotating pinned banner delivery needs operator review.');
    const stream = String(streamId || config.activeStreamId || 'offline');
    const hash = createHash('sha256').update(message).digest('hex').slice(0, 24);
    const key = `pin:${normalizedChannel}:${stream}:banner:${index}:${hash}:${Number(config.postGeneration) || 0}`;
    await persistRuntime({ deliveryKey: key });
    let receipt;
    try {
      receipt = await delivery.deliver({
        key,
        kind: 'persistent-pin',
        payload: { message, streamId: stream, bannerIndex: index },
        send: async (saved) => { noteOwnResponse(saved.message); return sendMessageViaApi(saved.message); }
      });
    } catch (err) {
      if (err.reviewRequired || err.deliveryState === 'UNKNOWN') {
        const patch = { recoveryRequired: true, recoveryReason: String(err.message).slice(0, 600), deliveryKey: key };
        config = { ...config, ...patch };
        await persistRuntime(patch).catch(() => {});
        stopMonitor();
      }
      consumeOwnResponse(message);
      throw err;
    }
    const messageId = String(receipt.result?.message_id || '').trim();
    if (!messageId) {
      const err = delivery.unknownError(key, new Error('Rotating pinned banner has no usable message ID.'));
      const patch = { recoveryRequired: true, recoveryReason: String(err.message).slice(0, 600), deliveryKey: key };
      config = { ...config, ...patch };
      await persistRuntime(patch).catch(() => {});
      stopMonitor();
      throw err;
    }
    const ids = configuredMessageIds();
    ids[index] = messageId;
    await persistRuntime({
      activeStreamId: stream,
      activeMessageIds: ids,
      activeMessageId: index === currentIndex() ? messageId : String(config.activeMessageId || ''),
      deliveryKey: '',
      recoveryRequired: false,
      recoveryReason: ''
    });
    return messageId;
  }

  async function allowReplacementAfterMissingMessage(err, bannerIndex = currentIndex()) {
    if (Number(err?.status) !== 404) throw err;
    const ids = configuredMessageIds();
    const index = clampIndex(bannerIndex, ids.length || 1);
    if (ids.length) ids[index] = '';
    await persistRuntime({
      activeMessageIds: ids,
      activeMessageId: index === currentIndex() ? '' : String(config.activeMessageId || ''),
      postGeneration: (Number(config.postGeneration) || 0) + 1
    });
  }

  async function ensureBannerMessageId(index, streamId = '') {
    const ids = configuredMessageIds();
    const bannerIndex = clampIndex(index, ids.length || configuredMessages().length);
    let messageId = ids[bannerIndex] || '';
    if (messageId) return { messageId, reposted: false };
    messageId = await postFreshConfiguredMessage(streamId, bannerIndex);
    return { messageId, reposted: true };
  }

  async function pinBanner(index, durationSeconds, { streamId = '', allowPost = true } = {}) {
    const rows = configuredBanners();
    if (!rows.some((row) => row.enabled !== false)) throw new Error('Rotating Pinned Banners has no enabled banners.');
    const bannerIndex = resolveEnabledIndex(rows, index);
    let ids = configuredMessageIds();
    let messageId = ids[bannerIndex] || '';
    let reposted = false;

    if (!messageId) {
      if (!allowPost) return { handled: false, reason: 'message_missing' };
      const ensured = await ensureBannerMessageId(bannerIndex, streamId);
      messageId = ensured.messageId;
      reposted = ensured.reposted;
    }

    // With exactly one enabled banner there is nothing to rotate to. Pin it
    // without duration_seconds so Twitch keeps it pinned indefinitely. Duration
    // settings remain saved for whenever a second banner is enabled later.
    const indefinite = hasSingleEnabledBanner();
    const requestedDuration = durationSeconds === undefined || durationSeconds === null || durationSeconds === '' ? effectiveDuration(bannerIndex) : Number(durationSeconds);
    const seconds = indefinite
      ? null
      : Math.max(MIN_RESTORE_SECONDS, Math.min(MAX_PERSISTENT_PIN_ROTATION_SECONDS, Math.round(requestedDuration || effectiveDuration(bannerIndex))));
    try {
      await pinChatMessage(messageId, indefinite ? {} : { durationSeconds: seconds });
    } catch (err) {
      await allowReplacementAfterMissingMessage(err, bannerIndex);
      if (!allowPost) throw err;
      const ensured = await ensureBannerMessageId(bannerIndex, streamId);
      messageId = ensured.messageId;
      reposted = true;
      await pinChatMessage(messageId, indefinite ? {} : { durationSeconds: seconds });
    }

    ids = configuredMessageIds();
    ids[bannerIndex] = messageId;
    const endsAt = indefinite ? null : new Date(Date.now() + seconds * 1000);
    displacedByMessageId = '';
    await persistRuntime({
      activeBannerIndex: bannerIndex,
      activeMessageIds: ids,
      activeMessageId: messageId,
      bannerEndsAt: endsAt,
      lastPinnedAt: new Date()
    });
    scheduleRotationTimer();
    return { handled: true, messageId, bannerIndex, reposted, durationSeconds: seconds, indefinite };
  }

  async function runExclusive(task) {
    if (stopping || configChanging || !context.isActive()) throw context.cancelledError();
    while (operationBusy) await sleep(100);
    if (stopping || configChanging || !context.isActive()) throw context.cancelledError();
    operationBusy = true;
    const controller = new AbortController();
    activeController = controller;
    const parentSignal = context.current().signal;
    const abortFromParent = () => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    try {
      return await context.runOperation(task, { signal: controller.signal });
    } finally {
      parentSignal?.removeEventListener('abort', abortFromParent);
      if (activeController === controller) activeController = null;
      operationBusy = false;
    }
  }

  async function holdOtherAutomations() {
    const seconds = normalizeHoldSeconds(config.startupHoldSeconds);
    if (seconds > 0) await sleep(seconds * 1000);
  }

  function beginPinPriorityHold() {
    if (typeof beginPriorityAutomationHold !== 'function') return false;
    return beginPriorityAutomationHold('stream_pin') !== false;
  }

  function endPinPriorityHold() {
    if (typeof endPriorityAutomationHold === 'function') endPriorityAutomationHold('stream_pin');
  }

  async function resetForStream(streamId) {
    const messages = configuredMessages();
    stopRotationTimer();
    await persistRuntime({
      activeStreamId: String(streamId || ''),
      activeMessageId: '',
      activeMessageIds: Array(messages.length).fill(''),
      activeBannerIndex: resolveEnabledIndex(configuredBanners(), 0),
      bannerEndsAt: null,
      postGeneration: 0,
      skipStreamId: ''
    });
  }

  async function reconcileInternal(source = 'monitor') {
    const rows = configuredBanners();
    const enabledRows = rows.filter((row) => row.enabled !== false);
    if (stopping || config.recoveryRequired || !config.enabled || !enabledRows.length) {
      return { handled: false, reason: 'disabled_or_review' };
    }
    if (typeof getPinnedChatMessage !== 'function' || typeof pinChatMessage !== 'function') {
      return { handled: false, reason: 'pin_api_unavailable' };
    }

    const status = streamStatus();
    if (typeof getStreamStatus === 'function' && !status.live) return { handled: false, reason: 'offline' };
    const streamId = status.streamId || monitorStreamId || config.activeStreamId || '';
    if (streamId && streamId !== String(config.activeStreamId || '')) await resetForStream(streamId);
    if (config.skipStreamId && config.skipStreamId === streamId) return { handled: false, reason: 'skipped_for_stream' };

    const current = await getPinnedChatMessage();
    const currentId = String(current?.message_id || '').trim();
    const banners = configuredBanners();
    let ids = configuredMessageIds();
    let index = currentIndex();
    let targetMessageId = ids[index] || String(config.activeMessageId || '').trim();

    const currentOwnedIndex = currentId ? ids.findIndex((id) => id && id === currentId) : -1;
    if (currentId && currentOwnedIndex >= 0 && banners[currentOwnedIndex]?.enabled === false) {
      // The currently pinned message is ours but that banner was just disabled.
      // It is safe to replace our own pin with the next enabled banner.
      const result = await pinBanner(index, effectiveDuration(index), { streamId });
      console.log(`[Persistent Pin] Disabled active banner ${currentOwnedIndex + 1}; moved to banner ${index + 1} (${source}).`);
      return result;
    }

    if (currentId && currentOwnedIndex >= 0 && currentOwnedIndex !== index) {
      // Adopt our own enabled banner if Twitch still has a different banner from
      // this stream pinned (for example after a restart during a handoff).
      index = currentOwnedIndex;
      targetMessageId = currentId;
      const twitchEndsAt = current?.ends_at ? new Date(current.ends_at) : null;
      await persistRuntime({
        activeBannerIndex: index,
        activeMessageId: currentId,
        ...(twitchEndsAt && Number.isFinite(twitchEndsAt.getTime()) ? { bannerEndsAt: twitchEndsAt } : {})
      });
    }

    if (currentId && currentOwnedIndex === -1) {
      stopRotationTimer();
      if (displacedByMessageId !== currentId) {
        displacedByMessageId = currentId;
        console.log('[Persistent Pin] Another message is pinned; banner rotation is waiting and will not replace it.');
      }
      return { handled: false, reason: 'displaced', messageId: currentId };
    }

    displacedByMessageId = '';

    // A single enabled banner is a true persistent pin, not a one-item
    // rotation. Ignore all configured durations until 2+ banners are enabled.
    if (enabledRows.length === 1) {
      const twitchHasTimedExpiry = Boolean(current?.ends_at && Number.isFinite(Date.parse(current.ends_at)));
      if (currentId && currentId === targetMessageId && !config.bannerEndsAt && !twitchHasTimedExpiry && source !== 'settings_update') {
        stopRotationTimer();
        return { handled: false, reason: 'already_pinned_indefinitely', messageId: currentId, bannerIndex: index };
      }
      const result = await pinBanner(index, null, { streamId });
      console.log(`[Persistent Pin] Pinned sole active banner ${index + 1}/${banners.length} indefinitely (${source}).`);
      return result;
    }

    const endsAtMs = config.bannerEndsAt ? Date.parse(config.bannerEndsAt) : NaN;
    const slotStarted = Number.isFinite(endsAtMs);
    const remainingSeconds = slotStarted ? Math.floor((endsAtMs - Date.now()) / 1000) : null;
    const due = slotStarted && remainingSeconds < MIN_RESTORE_SECONDS;

    if (currentId && currentId === targetMessageId) {
      if (!slotStarted) {
        const duration = effectiveDuration(index);
        const result = await pinBanner(index, duration, { streamId });
        console.log(`[Persistent Pin] Started banner ${index + 1}/${banners.length} for ${duration}s (${source}).`);
        return result;
      }
      if (!due) {
        scheduleRotationTimer();
        return { handled: false, reason: 'already_pinned', messageId: currentId, bannerIndex: index };
      }
      const nextBannerIndex = nextIndex(index);
      const duration = effectiveDuration(nextBannerIndex);
      const result = await pinBanner(nextBannerIndex, duration, { streamId });
      console.log(`[Persistent Pin] Rotated to banner ${nextBannerIndex + 1}/${banners.length} for ${duration}s (${source}).`);
      return result;
    }

    // There is no active pin. If the interrupted banner still has at least the
    // Twitch minimum duration left, resume only that remaining budget. Otherwise
    // its slot is considered consumed and the next enabled banner gets a fresh slot.
    if (!slotStarted) {
      const duration = effectiveDuration(index);
      const result = await pinBanner(index, duration, { streamId });
      console.log(`[Persistent Pin] Started banner ${index + 1}/${banners.length} for ${duration}s (${source}).`);
      return result;
    }

    if (remainingSeconds >= MIN_RESTORE_SECONDS) {
      const result = await pinBanner(index, remainingSeconds, { streamId });
      console.log(`[Persistent Pin] Resumed banner ${index + 1}/${banners.length} with ${remainingSeconds}s remaining (${source}).`);
      return result;
    }

    const nextBannerIndex = nextIndex(index);
    const duration = effectiveDuration(nextBannerIndex);
    const result = await pinBanner(nextBannerIndex, duration, { streamId });
    console.log(`[Persistent Pin] Interrupted banner ${index + 1}/${banners.length} expired; advanced to banner ${nextBannerIndex + 1}/${banners.length} for ${duration}s (${source}).`);
    return result;
  }

  async function reconcileNow(source = 'manual_reconcile') {
    if (stopping || configChanging || !context.isActive()) return { handled: false, reason: 'stopping' };
    return runExclusive(() => reconcileInternal(source));
  }

  async function monitorTick() {
    if (stopping || !context.isActive() || config.recoveryRequired || monitorBusy || operationBusy || !monitorTimer || !config.enabled) return;
    monitorBusy = true;
    try {
      const status = streamStatus();
      if (typeof getStreamStatus === 'function' && !status.live) {
        stopMonitor();
        return;
      }
      if (status.streamId) monitorStreamId = status.streamId;
      await reconcileNow('monitor');
    } catch (err) {
      const now = Date.now();
      if (now - lastMonitorErrorLogAt >= MONITOR_ERROR_LOG_INTERVAL_MS) {
        lastMonitorErrorLogAt = now;
        console.warn('[Persistent Pin] Banner monitor check failed; will retry:', err?.message || err);
      }
    } finally {
      monitorBusy = false;
    }
  }

  async function handleStreamOnline({ event = {} } = {}) {
    if (!config.enabled || !enabledBanners().length) return { handled: false, reason: 'not_configured' };

    const streamId = String(event?.id || event?.stream_id || '').trim();
    const live = streamStatus();
    if (live.streamId && streamId && live.streamId !== streamId) return { handled: false, reason: 'stale_stream' };
    if (config.recoveryRequired || (config.skipStreamId && config.skipStreamId === streamId)) return { handled: false, reason: 'delivery_review_or_skipped' };

    if (streamId && streamId !== String(config.activeStreamId || '')) await resetForStream(streamId);
    startMonitor(streamId || config.activeStreamId || '');

    beginPinPriorityHold();
    try {
      const result = await reconcileNow('stream_start');
      if (result?.handled) await holdOtherAutomations();
      return result;
    } finally {
      endPinPriorityHold();
    }
  }

  async function handleStreamOffline() {
    activeController?.abort();
    stopMonitor();
    if (!config.activeStreamId && !config.activeMessageId && !configuredMessageIds().some(Boolean)) return { handled: false };
    try {
      if (!config.recoveryRequired) {
        await persistRuntime({
          activeStreamId: '',
          activeMessageId: '',
          activeMessageIds: Array(configuredMessages().length).fill(''),
          activeBannerIndex: resolveEnabledIndex(configuredBanners(), 0),
          bannerEndsAt: null,
          postGeneration: 0,
          skipStreamId: ''
        });
      }
      return { handled: true };
    } catch (err) {
      console.warn('[Persistent Pin] Could not clear per-stream runtime state:', err?.message || err);
      throw err;
    }
  }

  async function syncLiveState() {
    const status = streamStatus();
    if (!status.live) {
      stopMonitor();
      return { live: false };
    }
    if (!config.enabled || !enabledBanners().length) {
      stopMonitor();
      return { live: true, enabled: false };
    }

    if (status.streamId && status.streamId !== String(config.activeStreamId || '')) await resetForStream(status.streamId);
    startMonitor(status.streamId || config.activeStreamId || '');
    try {
      await reconcileNow('startup_sync');
    } catch (err) {
      console.warn('[Persistent Pin] Startup live-state sync could not restore the banner yet:', err?.message || err);
    }
    return { live: true, enabled: true, streamId: status.streamId || config.activeStreamId || '' };
  }

  async function repin() {
    if (!enabledBanners().length) return { handled: false, reason: 'not_configured' };
    if (!config.enabled) await persistEnabled(true);

    const status = streamStatus();
    if (status.live && status.streamId && status.streamId !== String(config.activeStreamId || '')) await resetForStream(status.streamId);
    if (status.live) startMonitor(status.streamId || config.activeStreamId || '');

    beginPinPriorityHold();
    try {
      const result = await reconcileNow('repin_command');
      if (result?.handled) {
        console.log(`[Persistent Pin] !repin enabled rotation and restored banner ${Number(result.bannerIndex) + 1}/${configuredBanners().length}.`);
        await holdOtherAutomations();
      } else if (result?.reason === 'displaced') {
        console.log('[Persistent Pin] !repin enabled rotation; another pin is active, so banners are waiting for the slot.');
      } else {
        console.log(`[Persistent Pin] !repin enabled rotation (${result?.reason || 'no immediate pin needed'}).`);
      }
      return result;
    } catch (err) {
      console.error('[Persistent Pin] !repin failed:', err?.message || err);
      return { handled: false, reason: 'error' };
    } finally {
      endPinPriorityHold();
    }
  }

  async function unpin() {
    stopMonitor();
    activeController?.abort();
    while (operationBusy) await sleep(50);
    if (config.enabled) await persistEnabled(false);
    else stopMonitor();

    return runExclusive(async () => {
      try {
        const current = typeof getPinnedChatMessage === 'function' ? await getPinnedChatMessage() : null;
        const currentId = String(current?.message_id || '').trim();
        if (!currentId) {
          console.log('[Persistent Pin] !unpin disabled rotation; nothing was currently pinned.');
          return { handled: true, reason: 'nothing_pinned' };
        }
        const ownIds = new Set(configuredMessageIds().filter(Boolean));
        if (!ownIds.has(currentId)) {
          console.log('[Persistent Pin] !unpin disabled rotation; the current manual/temporary pin was left untouched.');
          return { handled: true, reason: 'other_pin_preserved', messageId: currentId };
        }
        if (typeof unpinChatMessage !== 'function') throw new Error('Twitch pinned-chat API is unavailable.');
        await unpinChatMessage(currentId);
        console.log('[Persistent Pin] !unpin removed the active rotating banner and disabled rotation.');
        return { handled: true, messageId: currentId };
      } catch (err) {
        console.error('[Persistent Pin] !unpin disabled rotation, but removing the active banner failed:', err?.message || err);
        return { handled: false, reason: 'error' };
      }
    });
  }

  function quiesce() {
    stopping = true;
    activeController?.abort();
    stopMonitor();
  }

  async function resolveReview(outcome, expectedDeliveryKey = config.deliveryKey) {
    if (config.deliveryKey !== expectedDeliveryKey) throw new Error('This persistent pin changed. Refresh before reviewing it.');
    if (!config.deliveryKey) throw new Error('No persistent pin delivery is awaiting review.');
    const reviewedStreamId = config.activeStreamId;
    const record = await delivery.resolve(expectedDeliveryKey, outcome);
    if (!record) throw new Error('Delivery was already resolved; refresh the page.');
    if (config.deliveryKey !== expectedDeliveryKey || config.activeStreamId !== reviewedStreamId) throw new Error('The old pin receipt was reviewed, but the stream changed. Refresh its status.');
    await persistRuntime({
      recoveryRequired: false,
      recoveryReason: '',
      deliveryKey: '',
      ...(outcome === 'sent' ? {
        skipStreamId: config.activeStreamId || 'offline',
        activeMessageId: '',
        activeMessageIds: Array(configuredMessages().length).fill(''),
        bannerEndsAt: null
      } : {})
    });
    if (outcome === 'not_sent') await syncLiveState();
    return toClient();
  }

  return {
    quiesce,
    resolveReview: (...args) => serializeControls(() => resolveReview(...args)),
    initialize,
    getConfig: toClient,
    saveConfig: (...args) => serializeControls(() => saveConfig(...args)),
    handleStreamOnline,
    handleStreamOffline,
    syncLiveState,
    reconcileNow,
    repin,
    unpin: (...args) => serializeControls(() => unpin(...args)),
    consumeOwnResponse,
    _monitorTick: monitorTick
  };
}

module.exports = {
  MAX_PERSISTENT_PIN_MESSAGE_LENGTH,
  MAX_PERSISTENT_PIN_MESSAGES,
  DEFAULT_PERSISTENT_PIN_ROTATION_SECONDS,
  MIN_PERSISTENT_PIN_ROTATION_SECONDS,
  MAX_PERSISTENT_PIN_ROTATION_SECONDS,
  DEFAULT_PERSISTENT_PIN_HOLD_SECONDS,
  MAX_PERSISTENT_PIN_HOLD_SECONDS,
  PERSISTENT_PIN_MONITOR_INTERVAL_MS,
  createPersistentPinManager,
  normalizeConfig,
  normalizeBannerOverrideSeconds
};
