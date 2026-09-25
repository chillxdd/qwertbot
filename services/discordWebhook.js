'use strict';

const { createHash } = require('node:crypto');
const context = require('./reliability/context');
const { fetchWithTimeout } = require('./httpClient');
const { deliveryError, httpDeliveryError } = require('./reliability/twitchDelivery');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_429_RETRIES = 6;
const DEFAULT_MAX_TOTAL_WAIT_MS = 20 * 60 * 1000;
const RETRY_SAFETY_MS = 250;
const EDGE_IP_RESTRICTION_MIN_RETRY_MS = 5 * 60 * 1000;

const webhookQueues = new Map();
const webhookBlockedUntil = new Map();
const bucketBlockedUntil = new Map();
let globalBlockedUntil = 0;
let globalBlockKind = '';

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

function safeWebhookIdentity(webhookUrl) {
  try {
    const url = new URL(String(webhookUrl || ''));
    const match = url.pathname.match(/^\/api\/webhooks\/(\d+)\//);
    if (match) return match[1];
  } catch (_) {}
  return `hash:${createHash('sha256').update(String(webhookUrl || '')).digest('hex').slice(0, 12)}`;
}

function parseJson(text) {
  if (!String(text || '').trim()) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

function readDiscordDiagnostics(response, payload = null, { webhookId = '', attempt = 1, waitedMs = 0 } = {}) {
  const headers = response?.headers;
  const scopeHeader = String(headers?.get?.('x-ratelimit-scope') || '').trim();
  const bucket = String(headers?.get?.('x-ratelimit-bucket') || '').trim();
  const bodyRetryMs = secondsToMs(payload?.retry_after);
  const headerRetryMs = retryAfterHeaderMs(headers?.get?.('retry-after'));
  const resetAfterMs = secondsToMs(headers?.get?.('x-ratelimit-reset-after'));
  const retrySources = [bodyRetryMs, headerRetryMs];
  if (Number(response?.status) === 429) retrySources.push(resetAfterMs);
  const retryAfterMs = retrySources
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => b - a)[0] ?? null;
  const global = payload?.global === true || String(headers?.get?.('x-ratelimit-global') || '').toLowerCase() === 'true';
  const probableEdgeIpRestriction = Number(response?.status) === 429
    && !global
    && !scopeHeader
    && !bucket
    && (!Number.isFinite(resetAfterMs) || resetAfterMs <= 0)
    && Number.isFinite(retryAfterMs)
    && retryAfterMs >= EDGE_IP_RESTRICTION_MIN_RETRY_MS;
  return {
    status: Number(response?.status || 0) || null,
    webhookId: String(webhookId || ''),
    transport: 'fetch',
    scope: String(scopeHeader || (global ? 'global' : '') || 'unknown'),
    global,
    probableEdgeIpRestriction,
    bucket,
    limit: finiteNumber(headers?.get?.('x-ratelimit-limit')),
    remaining: finiteNumber(headers?.get?.('x-ratelimit-remaining')),
    resetAfterMs,
    retryAfterMs,
    attempt: Math.max(1, Number(attempt) || 1),
    waitedMs: Math.max(0, Number(waitedMs) || 0),
    code: payload?.code ?? null,
    detail: String(payload?.message || payload?.error || '').trim().slice(0, 300)
  };
}

function publicDiagnostics(diag = {}) {
  return {
    status: diag.status ?? null,
    webhookId: String(diag.webhookId || ''),
    transport: String(diag.transport || 'fetch'),
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

function formatDiagnostics(diag = {}) {
  const d = publicDiagnostics(diag);
  const parts = [
    `webhook=${d.webhookId || 'unknown'}`,
    `scope=${d.scope}`,
    `global=${d.global}`,
    `edgeIp=${d.probableEdgeIpRestriction}`,
    `bucket=${d.bucket || 'n/a'}`,
    `remaining=${d.remaining ?? 'n/a'}`,
    `retryAfter=${d.retryAfterSeconds == null ? 'n/a' : `${d.retryAfterSeconds}s`}`,
    `resetAfter=${d.resetAfterSeconds == null ? 'n/a' : `${d.resetAfterSeconds}s`}`,
    `attempt=${d.attempt}`
  ];
  return parts.join(' ');
}

function rateLimitError(diag, message = '') {
  const details = publicDiagnostics(diag);
  const suffix = details.retryAfterSeconds != null ? `; retry after ${details.retryAfterSeconds}s` : '';
  const prefix = details.probableEdgeIpRestriction
    ? 'Probable Discord edge/IP restriction detected; QwertBot is suppressing all Discord webhook sends for this cooldown'
    : 'Discord webhook failed with HTTP 429';
  const err = deliveryError(
    `${prefix}${message ? `: ${message}` : ''}${suffix} (${formatDiagnostics(diag)})`,
    { status: 429, state: 'NOT_SENT' }
  );
  err.discordDiagnostics = details;
  err.retryAfterMs = Number.isFinite(diag?.retryAfterMs) ? diag.retryAfterMs : null;
  return err;
}

function noteBlock(diag, webhookKey, now = Date.now()) {
  const waitMs = Number(diag?.retryAfterMs);
  if (!Number.isFinite(waitMs) || waitMs <= 0) return;
  const until = now + waitMs + RETRY_SAFETY_MS;
  if (diag.probableEdgeIpRestriction === true) {
    if (until >= globalBlockedUntil) globalBlockKind = 'edge/ip';
    globalBlockedUntil = Math.max(globalBlockedUntil, until);
  } else if (diag.global === true || diag.scope === 'global') {
    if (until >= globalBlockedUntil) globalBlockKind = 'global';
    globalBlockedUntil = Math.max(globalBlockedUntil, until);
  }
  webhookBlockedUntil.set(webhookKey, Math.max(webhookBlockedUntil.get(webhookKey) || 0, until));
  if (diag.bucket) bucketBlockedUntil.set(diag.bucket, Math.max(bucketBlockedUntil.get(diag.bucket) || 0, until));
}

function noteSuccessLimit(diag, webhookKey, now = Date.now()) {
  if (diag.remaining !== 0 || !Number.isFinite(diag.resetAfterMs) || diag.resetAfterMs <= 0) return;
  const until = now + diag.resetAfterMs + RETRY_SAFETY_MS;
  webhookBlockedUntil.set(webhookKey, Math.max(webhookBlockedUntil.get(webhookKey) || 0, until));
  if (diag.bucket) bucketBlockedUntil.set(diag.bucket, Math.max(bucketBlockedUntil.get(diag.bucket) || 0, until));
}

function knownLimitStatus(webhookKey, bucket = '', now = Date.now()) {
  const globalScope = globalBlockKind === 'edge/ip' ? 'edge/ip' : 'global';
  const candidates = [
    { until: globalBlockedUntil, scope: globalScope, global: globalBlockKind !== 'edge/ip', probableEdgeIpRestriction: globalBlockKind === 'edge/ip' },
    { until: webhookBlockedUntil.get(webhookKey) || 0, scope: 'shared', global: false, probableEdgeIpRestriction: false },
    { until: bucket ? (bucketBlockedUntil.get(bucket) || 0) : 0, scope: 'shared', global: false, probableEdgeIpRestriction: false }
  ];
  const active = candidates.sort((a, b) => b.until - a.until)[0];
  return {
    waitMs: Math.max(0, Number(active?.until || 0) - now),
    scope: active?.scope || 'unknown',
    global: active?.global === true,
    probableEdgeIpRestriction: active?.probableEdgeIpRestriction === true
  };
}

function enqueueWebhook(webhookKey, fn) {
  const previous = webhookQueues.get(webhookKey) || Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  webhookQueues.set(webhookKey, current);
  current.finally(() => {
    if (webhookQueues.get(webhookKey) === current) webhookQueues.delete(webhookKey);
  }).catch(() => {});
  return current;
}

async function postDiscordWebhook({
  webhookUrl,
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  max429Retries = DEFAULT_MAX_429_RETRIES,
  maxTotalWaitMs = DEFAULT_MAX_TOTAL_WAIT_MS,
  purpose = 'notification'
} = {}) {
  const target = String(webhookUrl || '');
  const webhookKey = safeWebhookIdentity(target);
  const maxRetries = Math.max(0, Number(max429Retries) || 0);
  const maxWait = Math.max(0, Number(maxTotalWaitMs) || 0);

  return enqueueWebhook(webhookKey, async () => {
    let waitedMs = 0;
    let lastBucket = '';
    let attempt = 0;
    while (true) {
      const known = knownLimitStatus(webhookKey, lastBucket);
      if (known.waitMs > 0) {
        if (waitedMs + known.waitMs > maxWait) {
          throw rateLimitError({
            status: 429,
            webhookId: webhookKey,
            transport: 'fetch',
            scope: known.scope,
            global: known.global,
            probableEdgeIpRestriction: known.probableEdgeIpRestriction === true,
            bucket: lastBucket,
            remaining: 0,
            retryAfterMs: known.waitMs,
            resetAfterMs: known.waitMs,
            attempt: Math.max(1, attempt),
            waitedMs,
            detail: 'A Discord rate limit from a previous response is still active.'
          }, 'A Discord rate limit from a previous response is still active');
        }
        console.warn(`[Discord Webhook] Suppressing ${purpose} for ${Math.round(known.waitMs) / 1000}s due to known ${known.scope} rate-limit window.`);
        await context.sleep(known.waitMs);
        waitedMs += known.waitMs;
      }
      attempt += 1;
      const response = await fetchWithTimeout(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'DiscordBot (https://sqwertarmybot.fyi, 1.0)'
        },
        body: JSON.stringify(body),
        timeoutMs
      });

      const text = await response.text();
      const payload = parseJson(text);
      const diag = readDiscordDiagnostics(response, payload, { webhookId: webhookKey, attempt, waitedMs });
      lastBucket = diag.bucket || lastBucket;

      if (response.ok) {
        noteSuccessLimit(diag, webhookKey);
        if (attempt > 1 || waitedMs > 0) {
          console.log(`[Discord Webhook] Delivered ${purpose} after rate-limit wait: status=${response.status} ${formatDiagnostics(diag)} waited=${Math.round(waitedMs) / 1000}s.`);
        }
        return { status: response.status, diagnostics: publicDiagnostics(diag) };
      }

      if (response.status !== 429) {
        const detail = String(payload?.message || payload?.error || text || '').trim().slice(0, 300);
        const err = httpDeliveryError('Discord webhook', response, detail);
        err.discordDiagnostics = publicDiagnostics(diag);
        throw err;
      }

      noteBlock(diag, webhookKey);
      console.warn(`[Discord Webhook] HTTP 429 for ${purpose}: ${formatDiagnostics(diag)}${diag.detail ? ` detail=${JSON.stringify(diag.detail)}` : ''}.`);
      if (diag.probableEdgeIpRestriction === true) {
        console.warn(`[Discord Webhook] Probable Discord edge/IP restriction detected: no normal bucket/scope/reset metadata and a long retry-after. All Discord webhook sends from this QwertBot instance are suppressed for about ${Math.round((diag.retryAfterMs || 0) / 1000)}s.`);
      }

      const waitMs = Number.isFinite(diag.retryAfterMs) && diag.retryAfterMs > 0 ? diag.retryAfterMs + RETRY_SAFETY_MS : 1000;
      const retriesUsed = attempt - 1;
      if (retriesUsed >= maxRetries || waitedMs + waitMs > maxWait) {
        throw rateLimitError(diag, diag.detail);
      }

      console.warn(`[Discord Webhook] Honoring Discord retry-after; waiting ${Math.round(waitMs) / 1000}s before retry ${attempt + 1}/${maxRetries + 1}.`);
      await context.sleep(waitMs);
      waitedMs += waitMs;
    }
  });
}

function resetDiscordRateLimitStateForTests() {
  webhookQueues.clear();
  webhookBlockedUntil.clear();
  bucketBlockedUntil.clear();
  globalBlockedUntil = 0;
  globalBlockKind = '';
}

module.exports = {
  postDiscordWebhook,
  readDiscordDiagnostics,
  publicDiagnostics,
  formatDiagnostics,
  safeWebhookIdentity,
  retryAfterHeaderMs,
  knownLimitStatus,
  resetDiscordRateLimitStateForTests,
  DEFAULT_MAX_429_RETRIES,
  DEFAULT_MAX_TOTAL_WAIT_MS,
  EDGE_IP_RESTRICTION_MIN_RETRY_MS
};
