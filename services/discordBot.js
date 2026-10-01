'use strict';

const { fetchWithTimeout } = require('./httpClient');
const { deliveryError, httpDeliveryError } = require('./reliability/twitchDelivery');
const context = require('./reliability/context');

const DISCORD_API = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const DEFAULT_TIMEOUT_MS = 15000;
const RETRY_SAFETY_MS = 250;
const DEFAULT_MAX_429_RETRIES = 6;
const DEFAULT_MAX_TOTAL_WAIT_MS = 20 * 60 * 1000;
const EDGE_IP_RESTRICTION_MIN_RETRY_MS = 5 * 60 * 1000;
const FATAL_GATEWAY_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function secondsToMs(value) {
  const number = finiteNumber(value);
  return number != null && number >= 0 ? Math.ceil(number * 1000) : null;
}
function retryAfterHeaderMs(value, now = Date.now()) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const numeric = finiteNumber(raw);
  if (numeric != null && numeric >= 0) return Math.ceil(numeric * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
function parseJson(text) {
  if (!String(text || '').trim()) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}
function cleanChannelId(value) {
  const id = String(value || '').trim();
  if (!id) return '';
  if (!/^\d{16,22}$/.test(id)) throw new Error('Discord Channel ID must be a numeric Discord snowflake.');
  return id;
}
function publicDiagnostics(diag = {}) {
  return {
    status: diag.status ?? null,
    transport: 'bot',
    channelId: String(diag.channelId || ''),
    scope: String(diag.scope || 'unknown'),
    global: diag.global === true,
    probableEdgeIpRestriction: diag.probableEdgeIpRestriction === true,
    bucket: String(diag.bucket || ''),
    limit: diag.limit ?? null,
    remaining: diag.remaining ?? null,
    resetAfterSeconds: Number.isFinite(diag.resetAfterMs) ? Math.round(diag.resetAfterMs) / 1000 : null,
    retryAfterSeconds: Number.isFinite(diag.retryAfterMs) ? Math.round(diag.retryAfterMs) / 1000 : null,
    attempt: Math.max(1, Number(diag.attempt) || 1),
    waitedSeconds: Math.round(Math.max(0, Number(diag.waitedMs) || 0)) / 1000,
    code: diag.code ?? null,
    detail: String(diag.detail || '')
  };
}
function readDiagnostics(response, payload = null, { channelId = '', attempt = 1, waitedMs = 0 } = {}) {
  const headers = response?.headers;
  const scopeHeader = String(headers?.get?.('x-ratelimit-scope') || '').trim();
  const bucket = String(headers?.get?.('x-ratelimit-bucket') || '').trim();
  const bodyRetryMs = secondsToMs(payload?.retry_after);
  const headerRetryMs = retryAfterHeaderMs(headers?.get?.('retry-after'));
  const resetAfterMs = secondsToMs(headers?.get?.('x-ratelimit-reset-after'));
  const retrySources = [bodyRetryMs, headerRetryMs];
  if (Number(response?.status) === 429) retrySources.push(resetAfterMs);
  const retryAfterMs = retrySources.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => b - a)[0] ?? null;
  const global = payload?.global === true || String(headers?.get?.('x-ratelimit-global') || '').toLowerCase() === 'true';
  const probableEdgeIpRestriction = Number(response?.status) === 429
    && !global && !scopeHeader && !bucket
    && (!Number.isFinite(resetAfterMs) || resetAfterMs <= 0)
    && Number.isFinite(retryAfterMs) && retryAfterMs >= EDGE_IP_RESTRICTION_MIN_RETRY_MS;
  return {
    status: Number(response?.status || 0) || null,
    channelId: String(channelId || ''), scope: String(scopeHeader || (global ? 'global' : '') || 'unknown'), global,
    probableEdgeIpRestriction, bucket,
    limit: finiteNumber(headers?.get?.('x-ratelimit-limit')),
    remaining: finiteNumber(headers?.get?.('x-ratelimit-remaining')),
    resetAfterMs, retryAfterMs, attempt: Math.max(1, Number(attempt) || 1), waitedMs: Math.max(0, Number(waitedMs) || 0),
    code: payload?.code ?? null,
    detail: String(payload?.message || payload?.error || '').trim().slice(0, 300)
  };
}
function formatDiagnostics(diag = {}) {
  const d = publicDiagnostics(diag);
  return [
    `channel=${d.channelId || 'unknown'}`, `scope=${d.scope}`, `global=${d.global}`,
    `edgeIp=${d.probableEdgeIpRestriction}`, `bucket=${d.bucket || 'n/a'}`, `remaining=${d.remaining ?? 'n/a'}`,
    `retryAfter=${d.retryAfterSeconds == null ? 'n/a' : `${d.retryAfterSeconds}s`}`,
    `resetAfter=${d.resetAfterSeconds == null ? 'n/a' : `${d.resetAfterSeconds}s`}`, `attempt=${d.attempt}`
  ].join(' ');
}

function createDiscordBotService({
  token = process.env.DISCORD_BOT_TOKEN,
  defaultChannelId = process.env.DISCORD_CHANNEL_ID,
  fetchImpl = fetchWithTimeout,
  WebSocketImpl = globalThis.WebSocket,
  random = Math.random,
  now = Date.now,
  sleep = context.sleep
} = {}) {
  const botToken = String(token || '').trim();
  let configuredDefaultChannelId = '';
  try { configuredDefaultChannelId = cleanChannelId(defaultChannelId); } catch (_) {}

  const channelQueues = new Map();
  const channelBlockedUntil = new Map();
  const bucketBlockedUntil = new Map();
  let globalBlockedUntil = 0;
  let globalBlockKind = '';

  let desiredPresence = false;
  let ws = null;
  let gatewayState = botToken ? 'OFFLINE' : 'DISABLED';
  let lastGatewayError = '';
  let heartbeatTimer = null;
  let firstHeartbeatTimer = null;
  let heartbeatAcked = true;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let sequence = null;
  let sessionId = '';
  let resumeGatewayUrl = '';
  let botUser = null;
  let lastReadyAt = null;
  let lastDisconnectAt = null;
  let lastCloseCode = null;
  let lastRestDelivery = null;
  let presenceConfig = { status: 'online', activityType: 'watching', activityText: 'GeneralQwert' };

  const activityTypeCodes = { playing: 0, listening: 2, watching: 3, custom: 4, competing: 5 };
  function normalizePresenceConfig(input = {}) {
    const allowedStatuses = new Set(['online', 'idle', 'dnd', 'invisible']);
    const allowedActivityTypes = new Set(['playing', 'watching', 'listening', 'competing', 'custom', 'none']);
    const status = String(input.status ?? presenceConfig.status ?? 'online').trim().toLowerCase();
    const activityType = String(input.activityType ?? presenceConfig.activityType ?? 'watching').trim().toLowerCase();
    let activityText = String(input.activityText ?? presenceConfig.activityText ?? 'GeneralQwert').trim().slice(0, 128);
    if (!allowedStatuses.has(status)) throw new Error('Unsupported Discord presence status.');
    if (!allowedActivityTypes.has(activityType)) throw new Error('Unsupported Discord activity type.');
    if (activityType === 'none') activityText = '';
    if (activityType !== 'none' && !activityText) throw new Error('Discord activity text is required unless activity is None.');
    return { status, activityType, activityText };
  }
  function gatewayPresencePayload() {
    let activities = [];
    if (presenceConfig.activityType !== 'none') {
      activities = presenceConfig.activityType === 'custom'
        ? [{ name: 'Custom Status', state: presenceConfig.activityText, type: activityTypeCodes.custom }]
        : [{ name: presenceConfig.activityText, type: activityTypeCodes[presenceConfig.activityType] }];
    }
    return { since: presenceConfig.status === 'idle' ? now() : null, activities, status: presenceConfig.status, afk: false };
  }

  function enqueue(channelId, fn) {
    const previous = channelQueues.get(channelId) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    channelQueues.set(channelId, current);
    current.finally(() => { if (channelQueues.get(channelId) === current) channelQueues.delete(channelId); }).catch(() => {});
    return current;
  }

  function noteBlock(diag, channelId) {
    const waitMs = Number(diag?.retryAfterMs);
    if (!Number.isFinite(waitMs) || waitMs <= 0) return;
    const until = now() + waitMs + RETRY_SAFETY_MS;
    if (diag.probableEdgeIpRestriction === true) {
      if (until >= globalBlockedUntil) globalBlockKind = 'edge/ip';
      globalBlockedUntil = Math.max(globalBlockedUntil, until);
    } else if (diag.global === true || diag.scope === 'global') {
      if (until >= globalBlockedUntil) globalBlockKind = 'global';
      globalBlockedUntil = Math.max(globalBlockedUntil, until);
    }
    channelBlockedUntil.set(channelId, Math.max(channelBlockedUntil.get(channelId) || 0, until));
    if (diag.bucket) bucketBlockedUntil.set(diag.bucket, Math.max(bucketBlockedUntil.get(diag.bucket) || 0, until));
  }
  function noteSuccessLimit(diag, channelId) {
    if (diag.remaining !== 0 || !Number.isFinite(diag.resetAfterMs) || diag.resetAfterMs <= 0) return;
    const until = now() + diag.resetAfterMs + RETRY_SAFETY_MS;
    channelBlockedUntil.set(channelId, Math.max(channelBlockedUntil.get(channelId) || 0, until));
    if (diag.bucket) bucketBlockedUntil.set(diag.bucket, Math.max(bucketBlockedUntil.get(diag.bucket) || 0, until));
  }
  function knownLimitStatus(channelId, bucket = '') {
    const current = now();
    const candidates = [
      { until: globalBlockedUntil, scope: globalBlockKind === 'edge/ip' ? 'edge/ip' : 'global', global: globalBlockKind !== 'edge/ip', probableEdgeIpRestriction: globalBlockKind === 'edge/ip' },
      { until: channelBlockedUntil.get(channelId) || 0, scope: 'shared', global: false, probableEdgeIpRestriction: false },
      { until: bucket ? (bucketBlockedUntil.get(bucket) || 0) : 0, scope: 'shared', global: false, probableEdgeIpRestriction: false }
    ];
    const active = candidates.sort((a, b) => b.until - a.until)[0];
    return { waitMs: Math.max(0, Number(active?.until || 0) - current), scope: active?.scope || 'unknown', global: active?.global === true, probableEdgeIpRestriction: active?.probableEdgeIpRestriction === true };
  }
  function rateLimitError(diag, message = '') {
    const details = publicDiagnostics(diag);
    const suffix = details.retryAfterSeconds != null ? `; retry after ${details.retryAfterSeconds}s` : '';
    const err = deliveryError(`Discord bot API failed with HTTP 429${message ? `: ${message}` : ''}${suffix} (${formatDiagnostics(diag)})`, { status: 429, state: 'NOT_SENT' });
    err.discordDiagnostics = details;
    err.retryAfterMs = Number.isFinite(diag?.retryAfterMs) ? diag.retryAfterMs : null;
    return err;
  }

  async function postMessage({
    channelId = configuredDefaultChannelId,
    body,
    purpose = 'notification',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    max429Retries = DEFAULT_MAX_429_RETRIES,
    maxTotalWaitMs = DEFAULT_MAX_TOTAL_WAIT_MS
  } = {}) {
    if (!botToken) throw deliveryError('DISCORD_BOT_TOKEN is not configured.', { state: 'NOT_SENT' });
    const targetChannelId = cleanChannelId(channelId || configuredDefaultChannelId);
    if (!targetChannelId) throw deliveryError('Discord bot delivery needs a Channel ID.', { state: 'NOT_SENT' });
    const maxRetries = Math.max(0, Number(max429Retries) || 0);
    const maxWait = Math.max(0, Number(maxTotalWaitMs) || 0);
    return enqueue(targetChannelId, async () => {
      let waitedMs = 0;
      let lastBucket = '';
      let attempt = 0;
      while (true) {
        const known = knownLimitStatus(targetChannelId, lastBucket);
        if (known.waitMs > 0) {
          if (waitedMs + known.waitMs > maxWait) {
            throw rateLimitError({ status: 429, channelId: targetChannelId, scope: known.scope, global: known.global,
              probableEdgeIpRestriction: known.probableEdgeIpRestriction, bucket: lastBucket, remaining: 0,
              retryAfterMs: known.waitMs, resetAfterMs: known.waitMs, attempt: Math.max(1, attempt), waitedMs,
              detail: 'A Discord bot API rate limit from a previous response is still active.' }, 'A previous bot API rate limit is still active');
          }
          console.warn(`[Discord Bot] Suppressing ${purpose} for ${Math.round(known.waitMs) / 1000}s due to known ${known.scope} rate-limit window.`);
          await sleep(known.waitMs); waitedMs += known.waitMs;
        }
        attempt += 1;
        const response = await fetchImpl(`${DISCORD_API}/channels/${encodeURIComponent(targetChannelId)}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bot ${botToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'DiscordBot (https://sqwertarmybot.fyi, 1.0)'
          },
          body: JSON.stringify(body || {}), timeoutMs
        });
        const text = await response.text();
        const payload = parseJson(text);
        const diag = readDiagnostics(response, payload, { channelId: targetChannelId, attempt, waitedMs });
        lastBucket = diag.bucket || lastBucket;
        if (response.ok) {
          noteSuccessLimit(diag, targetChannelId);
          lastRestDelivery = { at: new Date(now()).toISOString(), ok: true, transport: 'bot', status: response.status, channelId: targetChannelId };
          if (attempt > 1 || waitedMs > 0) console.log(`[Discord Bot] Delivered ${purpose} after rate-limit wait: status=${response.status} ${formatDiagnostics(diag)} waited=${Math.round(waitedMs) / 1000}s.`);
          return { status: response.status, messageId: String(payload?.id || ''), channelId: targetChannelId, diagnostics: publicDiagnostics(diag) };
        }
        if (response.status !== 429) {
          const detail = String(payload?.message || payload?.error || text || '').trim().slice(0, 300);
          const err = httpDeliveryError('Discord bot API', response, detail);
          err.discordDiagnostics = publicDiagnostics(diag);
          lastRestDelivery = { at: new Date(now()).toISOString(), ok: false, transport: 'bot', status: response.status, channelId: targetChannelId, error: err.message };
          throw err;
        }
        noteBlock(diag, targetChannelId);
        console.warn(`[Discord Bot] HTTP 429 for ${purpose}: ${formatDiagnostics(diag)}${diag.detail ? ` detail=${JSON.stringify(diag.detail)}` : ''}.`);
        const waitMs = Number.isFinite(diag.retryAfterMs) && diag.retryAfterMs > 0 ? diag.retryAfterMs + RETRY_SAFETY_MS : 1000;
        const retriesUsed = attempt - 1;
        if (retriesUsed >= maxRetries || waitedMs + waitMs > maxWait) throw rateLimitError(diag, diag.detail);
        await sleep(waitMs); waitedMs += waitMs;
      }
    });
  }

  function clearHeartbeatTimers() {
    if (heartbeatTimer) clearInterval(heartbeatTimer); heartbeatTimer = null;
    if (firstHeartbeatTimer) clearTimeout(firstHeartbeatTimer); firstHeartbeatTimer = null;
  }
  function clearReconnectTimer() {
    if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null;
  }
  function sendGateway(payload) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(payload)); return true; } catch (err) { lastGatewayError = String(err?.message || err); return false; }
  }
  function heartbeat() {
    if (!heartbeatAcked) {
      lastGatewayError = 'Discord Gateway heartbeat ACK was not received; reconnecting.';
      try { ws?.close?.(4000, 'heartbeat timeout'); } catch (_) {}
      return;
    }
    heartbeatAcked = false;
    sendGateway({ op: 1, d: sequence == null ? null : sequence });
  }
  function identify() {
    sendGateway({ op: 2, d: {
      token: botToken,
      intents: 0,
      properties: { os: process.platform || 'linux', browser: 'SqwertArmyBot', device: 'SqwertArmyBot' },
      presence: gatewayPresencePayload()
    } });
  }
  function resume() {
    sendGateway({ op: 6, d: { token: botToken, session_id: sessionId, seq: sequence } });
  }
  function scheduleReconnect({ preserveSession = true } = {}) {
    if (!desiredPresence || !botToken || reconnectTimer) return;
    if (!preserveSession) { sessionId = ''; resumeGatewayUrl = ''; sequence = null; }
    // Keep IDENTIFY churn safely below Discord's 1000/day ceiling if the
    // connection repeatedly fails before a resumable session exists.
    const steps = [1000, 2000, 4000, 8000, 16000, 30000, 60000, 120000, 300000];
    const delay = steps[Math.min(reconnectAttempt, steps.length - 1)];
    reconnectAttempt += 1;
    gatewayState = 'RECONNECTING';
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connectGateway(); }, delay);
  }
  function connectGateway() {
    if (!desiredPresence || !botToken || ws) return;
    if (typeof WebSocketImpl !== 'function') {
      gatewayState = 'UNAVAILABLE';
      lastGatewayError = 'This Node runtime does not provide a WebSocket client for Discord presence.';
      return;
    }
    clearReconnectTimer();
    gatewayState = sessionId && resumeGatewayUrl ? 'RESUMING' : 'CONNECTING';
    const base = sessionId && resumeGatewayUrl ? resumeGatewayUrl : GATEWAY_URL;
    const url = base.includes('?') ? base : `${base.replace(/\/$/, '')}/?v=10&encoding=json`;
    let socket;
    try { socket = new WebSocketImpl(url); }
    catch (err) {
      gatewayState = 'ERROR';
      lastGatewayError = `Could not open Discord Gateway WebSocket: ${err?.message || err}`;
      console.warn(`[Discord Bot] ${lastGatewayError}`);
      scheduleReconnect({ preserveSession: Boolean(sessionId) });
      return;
    }
    ws = socket;
    socket.addEventListener('open', () => { gatewayState = 'HANDSHAKING'; lastGatewayError = ''; });
    socket.addEventListener('message', (event) => {
      let packet;
      try { packet = JSON.parse(String(event.data || '')); } catch (_) { return; }
      if (packet.s != null) sequence = packet.s;
      if (packet.op === 10) {
        const interval = Math.max(1000, Number(packet.d?.heartbeat_interval) || 45000);
        clearHeartbeatTimers(); heartbeatAcked = true;
        firstHeartbeatTimer = setTimeout(() => { firstHeartbeatTimer = null; heartbeat(); heartbeatTimer = setInterval(heartbeat, interval); }, Math.floor(interval * random()));
        if (sessionId) resume(); else identify();
        return;
      }
      if (packet.op === 11) { heartbeatAcked = true; return; }
      if (packet.op === 1) { heartbeat(); return; }
      if (packet.op === 7) { try { socket.close(4000, 'server reconnect'); } catch (_) {} return; }
      if (packet.op === 9) {
        const canResume = packet.d === true && Boolean(sessionId);
        if (!canResume) { sessionId = ''; resumeGatewayUrl = ''; sequence = null; }
        setTimeout(() => { try { socket.close(4000, 'invalid session'); } catch (_) {} }, 1000 + Math.floor(random() * 4000));
        return;
      }
      if (packet.op === 0 && packet.t === 'READY') {
        sessionId = String(packet.d?.session_id || '');
        resumeGatewayUrl = String(packet.d?.resume_gateway_url || '');
        botUser = packet.d?.user ? { id: String(packet.d.user.id || ''), username: String(packet.d.user.username || ''), discriminator: String(packet.d.user.discriminator || '') } : botUser;
        gatewayState = 'ONLINE'; reconnectAttempt = 0; lastReadyAt = new Date(now()).toISOString(); lastGatewayError = '';
        sendGateway({ op: 3, d: gatewayPresencePayload() });
        console.log(`[Discord Bot] Gateway READY${botUser?.username ? ` as ${botUser.username}` : ''}; presence ${presenceConfig.status}.`);
        return;
      }
      if (packet.op === 0 && packet.t === 'RESUMED') {
        gatewayState = 'ONLINE'; reconnectAttempt = 0; lastReadyAt = new Date(now()).toISOString(); lastGatewayError = '';
        sendGateway({ op: 3, d: gatewayPresencePayload() });
        console.log(`[Discord Bot] Gateway session resumed; presence ${presenceConfig.status}.`);
      }
    });
    socket.addEventListener('error', (event) => {
      lastGatewayError = String(event?.message || 'Discord Gateway WebSocket error.');
    });
    socket.addEventListener('close', (event) => {
      if (ws === socket) ws = null;
      clearHeartbeatTimers(); heartbeatAcked = true;
      lastDisconnectAt = new Date(now()).toISOString(); lastCloseCode = Number(event.code || 0) || null;
      const reason = String(event.reason || '').trim();
      if (!desiredPresence) { gatewayState = botToken ? 'OFFLINE' : 'DISABLED'; return; }
      if (FATAL_GATEWAY_CLOSE_CODES.has(Number(event.code))) {
        gatewayState = 'ERROR';
        lastGatewayError = `Discord Gateway closed with ${event.code}${reason ? `: ${reason}` : ''}.`;
        console.error(`[Discord Bot] ${lastGatewayError}`);
        return;
      }
      if (event.code === 1000 || event.code === 1001) { sessionId = ''; resumeGatewayUrl = ''; sequence = null; }
      lastGatewayError = reason ? `Gateway disconnected: ${reason}` : `Gateway disconnected (code ${event.code || 'unknown'}).`;
      scheduleReconnect({ preserveSession: Boolean(sessionId) });
    });
  }

  function setPresenceConfig(input = {}) {
    presenceConfig = normalizePresenceConfig(input);
    if (desiredPresence && ws?.readyState === 1 && gatewayState === 'ONLINE') {
      sendGateway({ op: 3, d: gatewayPresencePayload() });
    }
    return { ...presenceConfig };
  }
  function startPresence(input = null) {
    if (!botToken) { gatewayState = 'DISABLED'; return false; }
    if (input && typeof input === 'object') {
      if (Object.prototype.hasOwnProperty.call(input, 'activity') && !Object.prototype.hasOwnProperty.call(input, 'activityText')) {
        setPresenceConfig({ ...presenceConfig, activityType: 'watching', activityText: input.activity });
      } else {
        setPresenceConfig(input);
      }
    }
    desiredPresence = true;
    try { connectGateway(); }
    catch (err) {
      gatewayState = 'ERROR';
      lastGatewayError = String(err?.message || err);
      console.warn(`[Discord Bot] Presence startup failed; REST delivery remains available: ${lastGatewayError}`);
      scheduleReconnect({ preserveSession: Boolean(sessionId) });
    }
    return true;
  }
  function stopPresence() {
    desiredPresence = false; clearReconnectTimer(); clearHeartbeatTimers();
    const socket = ws; ws = null;
    if (socket) { try { socket.close(1000, 'QwertBot stopping'); } catch (_) {} }
    gatewayState = botToken ? 'OFFLINE' : 'DISABLED';
  }
  function status() {
    return {
      tokenConfigured: Boolean(botToken),
      defaultChannelIdConfigured: Boolean(configuredDefaultChannelId),
      defaultChannelId: configuredDefaultChannelId,
      gatewayState, presenceDesired: desiredPresence,
      online: gatewayState === 'ONLINE',
      botUser,
      lastReadyAt, lastDisconnectAt, lastCloseCode, lastError: lastGatewayError,
      presenceConfig: { ...presenceConfig },
      lastRestDelivery
    };
  }
  function resetRateLimitStateForTests() {
    channelQueues.clear(); channelBlockedUntil.clear(); bucketBlockedUntil.clear(); globalBlockedUntil = 0; globalBlockKind = '';
  }

  return { postMessage, startPresence, stopPresence, setPresenceConfig, status, cleanChannelId, resetRateLimitStateForTests };
}

module.exports = { createDiscordBotService, cleanChannelId, publicDiagnostics, readDiagnostics, DEFAULT_MAX_429_RETRIES, DEFAULT_MAX_TOTAL_WAIT_MS };
